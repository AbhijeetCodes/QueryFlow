// One test run: load the test tables, run the translated statements in order and
// keep the rows of the last query. Engine-agnostic: `driver` is the browser's
// DuckDB-WASM (engine.js) or the Node build in the tests.
//
// driver: { open(), close(), registerFile(name, text), registerBlob(name, file),
//           dropFile(name), query(sql), stream(sql, maxRows) -> { fields, rows, truncated },
//           loaded: Map }
// open() / close() give each run its own connection, so temp tables, temp
// functions and variables never leak into the next run.
//
// Saved test tables are small CSV text, loaded again for every run. A file too big
// for one stays in the tab's memory instead: DuckDB loads it once into
// memory.qf_files (driver.loaded remembers it for that DuckDB) and each run reads
// it through a view. Neither is ever sent anywhere.

import { translate, duckType, tableKey } from './bq2duck.js';
import { inspectTable, resolveTableData, LIMITS } from './testdata.js';

const quoteId = (s) => `"${String(s).replace(/"/g, '""')}"`;
const sqlStr = (s) => `'${String(s).replace(/'/g, "''")}'`;

const SETTINGS = [
  // BigQuery puts NULLs first when sorting ascending, last when descending.
  "SET default_null_order = 'nulls_first_on_asc_last_on_desc'",
  // Never fetch extensions from the network.
  'SET autoinstall_known_extensions = false',
  'SET autoload_known_extensions = false',
];

let runSeq = 0;

// read_csv options for a table's text or file, from inspectTable() of its first lines.
function csvOptions(info) {
  const types = Object.entries(info.types).map(([k, v]) => `${sqlStr(k)}: ${sqlStr(duckType(v))}`);
  return [
    'header = true',
    `delim = ${sqlStr(info.delim)}`,
    `quote = '"'`,
    `escape = '"'`,
    'sample_size = -1',
    'null_padding = true',
    "nullstr = ['', 'NULL']",
    `names = [${info.names.map(sqlStr).join(', ')}]`,
    ...(types.length ? [`types = {${types.join(', ')}}`] : []),
  ];
}

const fileTable = (id) => `memory.qf_files.${quoteId(id)}`;

/**
 * Build a run from BigQuery SQL and the saved test tables ({ tableKey: text }).
 * Returns { plan, translation, problems } — problems stop the run before it starts.
 */
export function planRun(src, { data = {}, params = {} } = {}) {
  const translation = translate(src, { params });
  const problems = [];
  const files = [];
  const loads = [];
  const setup = [];
  if (translation.tables.length > LIMITS.tables) problems.push({ message: `This query reads ${translation.tables.length} tables: test runs take up to ${LIMITS.tables}` });
  translation.tables.forEach((t, i) => {
    const found = resolveTableData(data, t.key);
    t.dataFrom = found?.key ?? null;
    const f = found?.file;
    if (f) {
      if (f.status === 'gone') { problems.push({ message: `${f.name} was kept in this tab's memory only, so it's gone since the page reloaded: add it again`, table: t.key, file: f.name }); return; }
      if (f.status === 'error') { problems.push({ message: `${f.name}: ${f.error}`, table: t.key }); return; }
      if (!loads.some((l) => l.id === f.id)) loads.push({ id: f.id, name: `qf_file_${f.id}.csv`, file: f.file, info: f.info, label: f.name, table: t });
      setup.push({ sql: `CREATE VIEW ${quoteId(t.local)} AS SELECT * FROM ${fileTable(f.id)}`, table: t });
      return;
    }
    const text = (found?.text ?? '').replace(/^\uFEFF/, '');
    const info = inspectTable(text);
    if (info.empty) { problems.push({ message: `No test data for ${t.full} yet`, table: t.key }); return; }
    if (info.error) { problems.push({ message: `${t.full}: ${info.error}`, table: t.key }); return; }
    const name = `qf_${i}.csv`;
    files.push({ name, text });
    setup.push({ sql: `CREATE TABLE ${quoteId(t.local)} AS SELECT * FROM read_csv(${sqlStr(name)}, ${csvOptions(info).join(', ')})`, table: t });
  });
  for (const st of translation.statements) {
    if (st.kind === 'error') problems.push({ message: st.error, line: st.line });
  }
  return { plan: { files, loads, setup, statements: translation.statements, result: translation.result }, translation, problems };
}

/**
 * Load files kept in memory into DuckDB, once per DuckDB: a second run (or a
 * load already under way) reuses it. loads: [{ id, name, file, info }].
 * Returns [{ rows }] in the same order.
 */
export async function loadFiles(driver, loads) {
  const out = [];
  for (const f of loads) {
    let p = driver.loaded.get(f.id);
    if (!p) {
      p = (async () => {
        await driver.registerBlob(f.name, f.file);
        await driver.query('CREATE SCHEMA IF NOT EXISTS memory.qf_files');
        await driver.query(`CREATE TABLE ${fileTable(f.id)} AS SELECT * FROM read_csv(${sqlStr(f.name)}, ${csvOptions(f.info).join(', ')})`);
        const [r] = (await driver.query(`SELECT count(*) AS n FROM ${fileTable(f.id)}`)).toArray();
        return { rows: Number(r.n) };
      })();
      driver.loaded.set(f.id, p);
      p.catch(() => driver.loaded.delete(f.id));
    }
    out.push(await p);
  }
  return out;
}

/** Free a file kept in memory: its table and DuckDB's handle on it. */
export async function forgetFile(driver, id) {
  const p = driver.loaded.get(id);
  driver.loaded.delete(id);
  try { await p; } catch { return; } // never loaded
  try { await driver.query(`DROP TABLE IF EXISTS ${fileTable(id)}`); } catch { /* the engine may be gone */ }
  try { await driver.dropFile(`qf_file_${id}.csv`); } catch { /* ignore */ }
}

// Keep a DuckDB error short: the first line, plus the LINE n: pointer when it has one.
export function cleanError(err) {
  let msg = String(err?.message ?? err).trim();
  // DuckDB-WASM in the browser can report an error as JSON: { exception_type, exception_message }.
  if (msg.startsWith('{')) {
    try {
      const j = JSON.parse(msg);
      if (j.exception_message) msg = `${j.exception_type ? `${j.exception_type} Error: ` : ''}${j.exception_message}`;
    } catch { /* not JSON after all */ }
  }
  const lines = msg.split('\n');
  const head = lines[0].replace(/^(\w+ Error): /, '$1 · ');
  const lineInfo = /LINE (\d+):/.exec(msg);
  return { text: head, rel: lineInfo ? +lineInfo[1] : null, detail: lines.slice(1).join('\n').trim() };
}

// BigQuery's SUM of INT64 is INT64; DuckDB's is a 128-bit HUGEINT, which comes
// back as a float. Cast such result columns to BIGINT, from DuckDB's own column types.
async function int64Sums(driver, sql) {
  let cols;
  try {
    cols = (await driver.query(`DESCRIBE ${sql}`)).toArray().map((r) => [String(r.column_name), String(r.column_type)]);
  } catch { return sql; } // not a plain query: run it as written
  const huge = cols.filter(([, t]) => t === 'HUGEINT').map(([n]) => n);
  const names = new Set(cols.map(([n]) => n.toLowerCase()));
  if (!huge.length || names.size < cols.length) return sql;
  const q = (n) => `"${n.replace(/"/g, '""')}"`;
  return `SELECT * REPLACE (${huge.map((n) => `CAST(${q(n)} AS BIGINT) AS ${q(n)}`).join(', ')})\nFROM (\n${sql.replace(/;\s*$/, '')}\n) AS qf_result`;
}

/** Run a plan. Returns { fields, rows, truncated, ms, error? }. */
export async function executePlan(plan, driver, { maxRows = LIMITS.resultRows } = {}) {
  const t0 = performance.now();
  const db = `qf_run_${++runSeq}`;
  const done = [];
  const finish = (extra) => ({ ms: Math.round(performance.now() - t0), ...extra });
  await driver.open();
  try {
    for (const s of SETTINGS) await driver.query(s);
    await driver.query(`ATTACH ':memory:' AS ${db}`);
    await driver.query(`USE ${db}`);
    for (const f of plan.files) { await driver.registerFile(f.name, f.text); done.push(f.name); }
    for (const f of plan.loads || []) {
      try { await loadFiles(driver, [f]); } catch (err) {
        return finish({ error: { ...cleanError(err), where: `loading ${f.label} for ${f.table.full}`, table: f.table.key } });
      }
    }
    for (const s of plan.setup) {
      try { await driver.query(s.sql); } catch (err) {
        return finish({ error: { ...cleanError(err), where: `loading the test data for ${s.table.full}`, table: s.table.key } });
      }
    }
    let result = { fields: [], rows: [], truncated: false };
    for (let k = 0; k < plan.statements.length; k++) {
      const st = plan.statements[k];
      if (st.kind === 'skip' || !st.sql) continue;
      try {
        if (k === plan.result) result = await driver.stream(await int64Sums(driver, st.sql), maxRows);
        else await driver.query(st.sql);
      } catch (err) {
        const e = cleanError(err);
        return finish({ error: { ...e, line: e.rel != null && !st.synthetic ? st.line + e.rel - 1 : st.line, statement: k, sql: st.sql } });
      }
    }
    return finish(result);
  } finally {
    try { await driver.query('USE memory'); await driver.query(`DETACH ${db}`); } catch { /* the engine may be gone (stopped) */ }
    for (const f of done) { try { await driver.dropFile(f); } catch { /* ignore */ } }
    try { await driver.close(); } catch { /* ignore */ }
  }
}

/** The SQL a run sends, for "show the DuckDB SQL". */
export function planText(plan) {
  const parts = [...plan.setup.map((s) => s.sql), ...plan.statements.filter((s) => s.sql).map((s) => s.sql)];
  return parts.map((s) => s.trim() + ';').join('\n\n');
}

export { tableKey };
