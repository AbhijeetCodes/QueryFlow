// One test run: load the test tables, run the translated statements in order and
// keep the rows of the last query. Engine-agnostic: `driver` is the browser's
// DuckDB-WASM (engine.js) or the Node build in the tests.
//
// driver: { open(), close(), registerFile(name, text), dropFile(name), query(sql),
//           stream(sql, maxRows) -> { fields, rows, truncated } }
// open() / close() give each run its own connection, so temp tables, temp
// functions and variables never leak into the next run.

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

/**
 * Build a run from BigQuery SQL and the saved test tables ({ tableKey: text }).
 * Returns { plan, translation, problems } — problems stop the run before it starts.
 */
export function planRun(src, { data = {}, params = {} } = {}) {
  const translation = translate(src, { params });
  const problems = [];
  const files = [];
  const setup = [];
  if (translation.tables.length > LIMITS.tables) problems.push({ message: `This query reads ${translation.tables.length} tables: test runs take up to ${LIMITS.tables}` });
  translation.tables.forEach((t, i) => {
    const found = resolveTableData(data, t.key);
    const text = (found?.text ?? '').replace(/^\uFEFF/, '');
    t.dataFrom = found?.key ?? null;
    const info = inspectTable(text);
    if (info.empty) { problems.push({ message: `No test data for ${t.full} yet`, table: t.key }); return; }
    if (info.error) { problems.push({ message: `${t.full}: ${info.error}`, table: t.key }); return; }
    const name = `qf_${i}.csv`;
    files.push({ name, text });
    const types = Object.entries(info.types).map(([k, v]) => `${sqlStr(k)}: ${sqlStr(duckType(v))}`);
    const opts = [
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
    setup.push({ sql: `CREATE TABLE ${quoteId(t.local)} AS SELECT * FROM read_csv(${sqlStr(name)}, ${opts.join(', ')})`, table: t });
  });
  for (const st of translation.statements) {
    if (st.kind === 'error') problems.push({ message: st.error, line: st.line });
  }
  return { plan: { files, setup, statements: translation.statements, result: translation.result }, translation, problems };
}

// Keep a DuckDB error short: the first line, plus the LINE n: pointer when it has one.
export function cleanError(err) {
  const msg = String(err?.message ?? err).trim();
  const lines = msg.split('\n');
  const head = lines[0].replace(/^(\w+ Error): /, '$1 · ');
  const lineInfo = /LINE (\d+):/.exec(msg);
  return { text: head, rel: lineInfo ? +lineInfo[1] : null, detail: lines.slice(1).join('\n').trim() };
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
        if (k === plan.result) result = await driver.stream(st.sql, maxRows);
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
