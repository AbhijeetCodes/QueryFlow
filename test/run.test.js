// Runs BigQuery SQL on test tables through the real DuckDB engine (its Node build),
// so every translation rule is checked against what DuckDB actually returns.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { planRun, executePlan } from '../src/runner.js';
import { translate } from '../src/bq2duck.js';
import { analyze } from '../src/analyzer.js';
import { inspectTable, queryColumns, starterRows, parseDelimited, importText, resolveTableData } from '../src/testdata.js';

const require = createRequire(import.meta.url);
const duckdb = require('@duckdb/duckdb-wasm/dist/duckdb-node-blocking.cjs');

let db;
let conn;
async function driver() {
  if (!db) {
    const wasm = require.resolve('@duckdb/duckdb-wasm/dist/duckdb-eh.wasm');
    db = await duckdb.createDuckDB({ mvp: { mainModule: wasm, mainWorker: '' }, eh: { mainModule: wasm, mainWorker: '' } }, new duckdb.VoidLogger(), duckdb.NODE_RUNTIME);
    await db.instantiate();
    db.open({ query: { castDecimalToDouble: true } });
  }
  const plain = (v) => (typeof v === 'bigint' ? Number(v) : v && typeof v === 'object' && typeof v.toJSON === 'function' ? v.toJSON() : v);
  return {
    open: async () => { conn = db.connect(); },
    close: async () => { conn.close(); },
    registerFile: async (name, text) => db.registerFileText(name, text),
    dropFile: async (name) => db.dropFile(name),
    query: async (sql) => conn.query(sql),
    stream: async (sql, maxRows) => {
      const t = conn.query(sql);
      const fields = t.schema.fields.map((f) => ({ name: f.name, type: String(f.type) }));
      const rows = t.toArray().slice(0, maxRows).map((r) => fields.map((f) => JSON.parse(JSON.stringify(plain(r[f.name]), (k, v) => (typeof v === 'bigint' ? Number(v) : v)))));
      return { fields, rows, truncated: t.numRows > maxRows };
    },
  };
}

async function run(sql, data = {}, params = {}) {
  const { plan, problems } = planRun(sql, { data, params });
  if (problems.length) return { problems };
  const r = await executePlan(plan, await driver());
  if (r.error) throw new Error(`${r.error.text}\n${r.error.detail}\n--- sql ---\n${r.error.sql ?? ''}`);
  return r;
}
// rows as objects, for readable assertions
const objs = (r) => r.rows.map((row) => Object.fromEntries(r.fields.map((f, i) => [f.name, row[i]])));
const day = (iso) => Date.parse(iso + 'T00:00:00Z');

const ORDERS = `order_id,user_id,amount,created_at,status
1,1,10.5,2024-01-03 10:00:00,done
2,1,20,2024-01-20 11:00:00,done
3,2,5,2024-02-01 09:30:00,cancelled
4,3,7.25,2024-02-10 08:00:00,done`;
const USERS = `user_id,name,country,tags:ARRAY<STRING>
1,Ana,SG,"[a,b]"
2,Ben,MY,[]
3,Cy,SG,[c]`;
const DATA = { 'proj.shop.orders': ORDERS, 'proj.shop.users': USERS };

test('joins, filters, aggregates and variables', async () => {
  const r = await run(`
    DECLARE min_amount FLOAT64 DEFAULT 6;
    DECLARE since DATE DEFAULT '2024-01-01';
    WITH o AS (
      SELECT * FROM \`proj.shop.orders\` WHERE status = "done" AND DATE(created_at) >= since
    )
    SELECT u.country, COUNT(*) AS n, SUM(o.amount) AS total
    FROM o JOIN \`proj.shop.users\` u USING (user_id)
    WHERE o.amount >= min_amount
    GROUP BY u.country
    ORDER BY total DESC`, DATA);
  assert.deepEqual(objs(r), [{ country: 'SG', n: 3, total: 37.75 }]);
});

test('a CTE named like the table it reads still reads the table', async () => {
  const r = await run('WITH orders AS (SELECT * FROM proj.shop.orders WHERE status = \'done\') SELECT COUNT(*) AS n FROM orders', DATA);
  assert.deepEqual(objs(r), [{ n: 3 }]);
});

test('query parameters take their test values; missing ones read as NULL', async () => {
  const r = await run('SELECT COUNT(*) AS n FROM `proj.shop.users` WHERE country = @country', DATA, { country: "'SG'" });
  assert.deepEqual(objs(r), [{ n: 2 }]);
  const t = translate('SELECT @nope AS x');
  assert.match(t.warnings.join(), /@nope has no test value/);
});

test('QUALIFY dedupe and window functions', async () => {
  const r = await run(`SELECT user_id, order_id FROM \`proj.shop.orders\`
    QUALIFY ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY created_at DESC) = 1 ORDER BY user_id`, DATA);
  assert.deepEqual(objs(r), [{ user_id: 1, order_id: 2 }, { user_id: 2, order_id: 3 }, { user_id: 3, order_id: 4 }]);
});

test('date functions keep BigQuery types and argument order', async () => {
  const r = await run(`SELECT
      DATE_TRUNC(DATE '2024-03-15', MONTH) AS m,
      DATE_TRUNC(DATE '2024-03-15', WEEK) AS w_sun,
      DATE_TRUNC(DATE '2024-03-15', WEEK(MONDAY)) AS w_mon,
      DATE_TRUNC(DATE '2024-03-15', ISOWEEK) AS w_iso,
      DATE_ADD(DATE '2024-01-31', INTERVAL 1 MONTH) AS plus,
      DATE_SUB('2024-03-01', INTERVAL 1 DAY) AS minus,
      DATE_DIFF(DATE '2024-03-01', DATE '2024-01-15', DAY) AS dd,
      DATE_DIFF(DATE '2024-02-01', DATE '2024-01-31', MONTH) AS dm,
      TIMESTAMP_DIFF(TIMESTAMP '2024-01-01 05:59:00', TIMESTAMP '2024-01-01 00:00:00', HOUR) AS th,
      EXTRACT(DAYOFWEEK FROM DATE '2024-03-17') AS dow,
      EXTRACT(YEAR FROM DATE '2024-03-17') AS y,
      FORMAT_DATE('%F', DATE '2024-03-17') AS f,
      FORMAT_DATE('%Y%m', DATE '2024-03-17') AS ym,
      PARSE_DATE('%Y%m%d', '20240317') AS p,
      LAST_DAY(DATE '2024-02-10') AS ld,
      DATE(2024, 3, 17) AS mk,
      UNIX_DATE(DATE '1970-01-11') AS ud`);
  const o = objs(r)[0];
  assert.equal(o.m, day('2024-03-01'));
  assert.equal(o.w_sun, day('2024-03-10')); // Sunday
  assert.equal(o.w_mon, day('2024-03-11'));
  assert.equal(o.w_iso, day('2024-03-11'));
  assert.equal(o.plus, day('2024-02-29'));
  assert.equal(o.minus, day('2024-02-29'));
  assert.equal(o.dd, 46);
  assert.equal(o.dm, 1);
  assert.equal(o.th, 5);
  assert.equal(o.dow, 1); // Sunday is 1 in BigQuery
  assert.equal(o.y, 2024);
  assert.equal(o.f, '2024-03-17');
  assert.equal(o.ym, '202403');
  assert.equal(o.p, day('2024-03-17'));
  assert.equal(o.ld, day('2024-02-29'));
  assert.equal(o.mk, day('2024-03-17'));
  assert.equal(o.ud, 10);
  assert.match(r.fields.find((f) => f.name === 'm').type, /Date/);
  assert.match(r.fields.find((f) => f.name === 'plus').type, /Date/);
});

test('arrays: UNNEST with and without OFFSET, IN UNNEST, OFFSET / ORDINAL, ARRAY_AGG', async () => {
  const r = await run(`SELECT u.name, tag, pos
    FROM \`proj.shop.users\` u, UNNEST(u.tags) AS tag WITH OFFSET AS pos
    ORDER BY u.name, pos`, DATA);
  assert.deepEqual(objs(r), [{ name: 'Ana', tag: 'a', pos: 0 }, { name: 'Ana', tag: 'b', pos: 1 }, { name: 'Cy', tag: 'c', pos: 0 }]);

  const r2 = await run(`SELECT
      (SELECT COUNT(*) FROM UNNEST([1, 2, 3]) AS x WHERE x > 1) AS n,
      2 IN UNNEST([1, 2]) AS has2,
      [10, 20, 30][OFFSET(1)] AS o1,
      [10, 20, 30][ORDINAL(1)] AS r1,
      [10, 20, 30][SAFE_OFFSET(5)] AS missing,
      ARRAY_LENGTH(GENERATE_ARRAY(1, 5)) AS len,
      SPLIT('a,b,c')[OFFSET(2)] AS third,
      ARRAY_TO_STRING(['x', 'y'], '-') AS joined`);
  assert.deepEqual(objs(r2), [{ n: 2, has2: true, o1: 20, r1: 10, missing: null, len: 5, third: 'c', joined: 'x-y' }]);

  const r3 = await run(`SELECT user_id, ARRAY_AGG(order_id IGNORE NULLS ORDER BY order_id DESC LIMIT 1) AS last_order
    FROM proj.shop.orders GROUP BY user_id ORDER BY user_id`, DATA);
  assert.deepEqual(objs(r3).map((o) => o.last_order), [[2], [3], [4]]);
});

test('structs, SELECT * EXCEPT / REPLACE, SAFE_DIVIDE, strings and regex', async () => {
  const r = await run(`SELECT
      STRUCT(1 AS a, 'x' AS b).b AS sb,
      SAFE_DIVIDE(1, 0) AS z,
      SAFE_CAST('nope' AS INT64) AS bad,
      CAST('42' AS INT64) AS good,
      REGEXP_CONTAINS('abc123', r'\\d+') AS has_digits,
      REGEXP_EXTRACT('order-77', r'order-(\\d+)') AS grp,
      REGEXP_EXTRACT('none', r'\\d+') AS nomatch,
      REGEXP_REPLACE('a-b-c', '-', '+') AS rep,
      CONCAT('a', NULL) AS cnull,
      IFNULL(NULL, 'd') AS ifn,
      COUNTIF(TRUE) AS ci,
      LOG(8, 2) AS lg,
      LOG(1) AS ln1,
      FORMAT('%d items', 3) AS fmt,
      'it\\'s' AS esc,
      """triple""" AS tq`);
  assert.deepEqual(objs(r), [{
    sb: 'x', z: null, bad: null, good: 42, has_digits: true, grp: '77', nomatch: null, rep: 'a+b+c',
    cnull: null, ifn: 'd', ci: 1, lg: 3, ln1: 0, fmt: '3 items', esc: "it's", tq: 'triple',
  }]);
  const r2 = await run('SELECT * EXCEPT (created_at, status) REPLACE (amount * 2 AS amount) FROM `proj.shop.orders` WHERE order_id = 1', DATA);
  assert.deepEqual(objs(r2), [{ order_id: 1, user_id: 1, amount: 21 }]);
});

test('temp tables and temp functions in a script; the last query is the result', async () => {
  const r = await run(`
    CREATE TEMP FUNCTION double_it(x FLOAT64) RETURNS FLOAT64 AS (x * 2);
    CREATE TEMP TABLE big AS SELECT * FROM proj.shop.orders WHERE amount > 6;
    SELECT order_id, double_it(amount) AS d FROM big ORDER BY order_id;`, DATA);
  assert.deepEqual(objs(r), [{ order_id: 1, d: 21 }, { order_id: 2, d: 40 }, { order_id: 4, d: 14.5 }]);
});

test('a script that ends by writing a table shows that table', async () => {
  const r = await run(`CREATE OR REPLACE TABLE \`proj.out.summary\` PARTITION BY d CLUSTER BY user_id OPTIONS (description = 'x') AS
    SELECT user_id, DATE(MIN(created_at)) AS d FROM proj.shop.orders GROUP BY user_id`, DATA);
  assert.equal(r.rows.length, 3);
});

test('NULLs sort first ascending and last descending, like BigQuery', async () => {
  const r = await run('SELECT x FROM UNNEST([2, NULL, 1]) AS x ORDER BY x');
  assert.deepEqual(r.rows.map((x) => x[0]), [null, 1, 2]);
  const r2 = await run('SELECT x FROM UNNEST([2, NULL, 1]) AS x ORDER BY x DESC');
  assert.deepEqual(r2.rows.map((x) => x[0]), [2, 1, null]);
});

test('results are capped and flagged as truncated', async () => {
  const { plan } = planRun('SELECT x FROM UNNEST(GENERATE_ARRAY(1, 50)) AS x');
  const r = await executePlan(plan, await driver(), { maxRows: 10 });
  assert.equal(r.rows.length, 10);
  assert.equal(r.truncated, true);
});

test('runs are isolated: tables from one run are gone in the next', async () => {
  await run('CREATE TEMP TABLE leftover AS SELECT 1 AS x; SELECT * FROM leftover');
  const { plan } = planRun('SELECT * FROM leftover');
  const r = await executePlan(plan, await driver());
  assert.ok(r.error);
});

test('problems are reported before running', () => {
  assert.match(planRun('SELECT * FROM proj.shop.missing').problems[0].message, /No test data for proj\.shop\.missing/);
  assert.match(planRun("CREATE TEMP FUNCTION f(x STRING) RETURNS STRING LANGUAGE js AS 'return x'; SELECT 1").problems[0].message, /JavaScript/);
  const tooMany = 'id\n' + Array.from({ length: 1001 }, (_, i) => i).join('\n');
  assert.match(planRun('SELECT * FROM t.x', { data: { 't.x': tooMany } }).problems[0].message, /1001 rows/);
});

test('errors point at the editor line', async () => {
  const { plan } = planRun('DECLARE x INT64 DEFAULT 1;\n\nSELECT\n  nope_column\nFROM `proj.shop.orders`', { data: DATA });
  const r = await executePlan(plan, await driver());
  assert.ok(r.error);
  assert.equal(r.error.line, 4);
});

test('CSV / TSV parsing, type hints and limits', () => {
  assert.deepEqual(parseDelimited('a\tb\n1\t"x\ty"\n').rows, [['a', 'b'], ['1', 'x\ty']]);
  assert.deepEqual(parseDelimited('a,b\n"he said ""hi""",2\n').rows[1], ['he said "hi"', '2']);
  const info = inspectTable('id:INT64,name\n1,a\n2,b\n');
  assert.deepEqual(info.names, ['id', 'name']);
  assert.deepEqual(info.types, { id: 'INT64' });
  assert.equal(info.rows, 2);
  assert.match(inspectTable('a,a\n1,2').error, /twice/);
});

test('columns from the query and starter rows that pass its filters', () => {
  const a = analyze(`SELECT u.user_id, u.country FROM \`p.d.users\` u
    WHERE u.country IN ('SG', 'MY') AND u.status != 'deleted' AND signup_date >= '2024-02-01'`, 'bigquery');
  const cols = queryColumns(a).get('p.d.users');
  assert.deepEqual(cols, ['user_id', 'country', 'status', 'signup_date']);
  const rows = starterRows(cols, a).map((l) => l.split(','));
  assert.deepEqual(rows.map((r) => r[1]), ['SG', 'MY', 'SG']);
  assert.ok(rows.every((r) => r[2] !== 'deleted'));
  assert.ok(rows.every((r) => r[3] >= '2024-02-01'));
});

test('starter ids for a NOT IN table don\'t match the main table', () => {
  const a = analyze('SELECT * FROM `p.d.users` u WHERE u.user_id NOT IN (SELECT user_id FROM `p.d.banned`)', 'bigquery');
  assert.equal(starterRows(['user_id'], a, 1, 'p.d.users')[0], '1');
  assert.equal(starterRows(['user_id'], a, 1, 'p.d.banned')[0], '101');
});

test('a saved table named by its short name serves the full table name', async () => {
  const r = await run('SELECT COUNT(*) AS n FROM `proj.shop.orders`', { orders: ORDERS });
  assert.deepEqual(objs(r), [{ n: 4 }]);
  assert.equal(resolveTableData({ 'shop.orders': 'a\n1', orders: 'a\n1' }, 'proj.shop.orders').key, 'shop.orders');
  assert.deepEqual(resolveTableData({ 'a.orders': 'x\n1', 'b.orders': 'x\n1' }, 'p.c.orders'), null);
  assert.equal(resolveTableData({ 'a.orders': 'x\n1', 'b.orders': 'x\n1' }, 'p.a.orders').key, 'a.orders');
  assert.equal(resolveTableData({ 'proj.shop.orders': 'x\n1', orders: 'y\n2' }, 'proj.shop.orders').exact, true);
});

test('CSV saved by Excel: byte-order mark, semicolons, CRLF', async () => {
  const excel = '\uFEFFid;name;amount\r\n1;Ana;"1,5"\r\n2;Ben;2\r\n';
  assert.equal(parseDelimited(excel).delim, ';');
  assert.deepEqual(inspectTable(excel).names, ['id', 'name', 'amount']);
  const r = await run('SELECT id, name FROM `p.d.people` ORDER BY id', { 'p.d.people': excel });
  assert.deepEqual(objs(r), [{ id: 1, name: 'Ana' }, { id: 2, name: 'Ben' }]);
});

test('importing a big file keeps the header and the first rows', () => {
  const big = 'id,note\n' + Array.from({ length: 1500 }, (_, i) => `${i},"line\nbreak"`).join('\n');
  const r = importText(big);
  assert.equal(r.truncated, true);
  assert.equal(r.total, 1500);
  assert.equal(inspectTable(r.text).rows, 1000);
  assert.equal(importText('a\r\n1\r\n').text, 'a\n1\n');
});

test('an Excel sheet runs with real dates, timestamps and booleans', async () => {
  const { readXlsx } = await import('../src/xlsx.js');
  const { readFileSync } = await import('node:fs');
  const [orders, users] = await readXlsx(readFileSync(new URL('./fixtures/sample.xlsx', import.meta.url)));
  const r = await run(`SELECT o.order_id, u.name, DATE_TRUNC(o.order_date, MONTH) AS m, EXTRACT(HOUR FROM o.created_at) AS h
    FROM \`p.d.orders\` o JOIN \`p.d.users\` u USING (user_id) WHERE o.paid ORDER BY o.order_id`, { 'p.d.orders': orders.text, 'p.d.users': users.text });
  assert.deepEqual(objs(r), [
    { order_id: 1, name: 'Ana', m: day('2024-01-01'), h: 10 },
    { order_id: 3, name: 'Ben', m: day('2024-02-01'), h: 9 },
  ]);
});
