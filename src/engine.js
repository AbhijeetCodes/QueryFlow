// DuckDB-WASM in a worker, loaded on the first test run (about 8 MB compressed,
// then cached by the browser). The engine files are served from this site, so a
// run makes no request to anywhere else.

import * as duckdb from '@duckdb/duckdb-wasm';
import wasmUrl from '@duckdb/duckdb-wasm/dist/duckdb-eh.wasm?url';
import workerUrl from '@duckdb/duckdb-wasm/dist/duckdb-browser-eh.worker.js?url';

let dbPromise = null;
let worker = null;
// Files kept in memory that this DuckDB has loaded (runner.js loadFiles): id -> Promise.
let loaded = new Map();
// A terminated worker never answers, so whatever awaits it also waits for stop().
let onStop;
let stopped = new Promise((r) => { onStop = r; });

async function boot() {
  if (typeof WebAssembly !== 'object') throw new Error('This browser has no WebAssembly, so test runs are not available');
  worker = new Worker(workerUrl);
  const db = new duckdb.AsyncDuckDB(new duckdb.VoidLogger(), worker);
  await db.instantiate(wasmUrl);
  // Decimals and HUGEINT sums come back as plain numbers.
  await db.open({ query: { castDecimalToDouble: true } });
  return db;
}

export const isLoaded = () => !!dbPromise;

export function getDb() {
  if (!dbPromise) {
    dbPromise = boot().catch((err) => {
      dbPromise = null;
      worker?.terminate();
      throw err;
    });
  }
  return dbPromise;
}

/** Stop a run that takes too long: the worker is thrown away and reloads on the next run. */
export function stop() {
  worker?.terminate();
  worker = null;
  dbPromise = null;
  loaded = new Map(); // the next DuckDB loads them again from the File objects
  onStop();
  stopped = new Promise((r) => { onStop = r; });
}

/** Resolves when stop() is next called: race it against work on the current worker. */
export const whenStopped = () => stopped;

/** A driver for runner.js's executePlan(). */
export async function createDriver() {
  const db = await getDb();
  let conn = null;
  return {
    open: async () => { conn = await db.connect(); },
    close: async () => { await conn?.close(); conn = null; },
    registerFile: (name, text) => db.registerFileText(name, text),
    // DuckDB reads a picked or dropped file in place, in its worker: no copy, no upload.
    registerBlob: (name, file) => db.registerFileHandle(name, file, duckdb.DuckDBDataProtocol.BROWSER_FILEREADER, true),
    loaded,
    dropFile: (name) => db.dropFile(name),
    query: (sql) => conn.query(sql),
    async stream(sql, maxRows) {
      const reader = await conn.send(sql, true);
      let fields = reader.schema?.fields || [];
      const rows = [];
      let truncated = false;
      for await (const batch of reader) {
        fields = batch.schema.fields;
        const cols = fields.map((_, j) => batch.getChildAt(j));
        for (let i = 0; i < batch.numRows; i++) {
          if (rows.length >= maxRows) { truncated = true; break; }
          rows.push(cols.map((c) => c?.get(i) ?? null));
        }
        if (truncated) break;
      }
      if (truncated) { try { await conn.cancelSent(); } catch { /* finished anyway */ } }
      return { fields: fields.map((f) => ({ name: f.name, type: f.type })), rows, truncated };
    },
  };
}
