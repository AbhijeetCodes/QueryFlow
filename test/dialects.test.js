import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tokenize, unquoteIdent } from '../src/tokenizer.js';
import { analyze } from '../src/analyzer.js';
import { formatSql } from '../src/format.js';
import { symbolAt, renameEdits, canRename } from '../src/symbols.js';
import { quoteTable, detectDialect } from '../src/dialect.js';
import { SAMPLES } from '../src/sample.js';

const toks = (src, d) => tokenize(src, d).filter((t) => t.t !== 'ws').map((t) => `${t.t}:${t.s}`);
const msgs = (a) => a.diags.map((d) => d.message).join('\n');
const DAY = 86400000;
const today = Math.floor(Date.now() / DAY);

test('tokenizer: Postgres quotes, dollar strings, casts, parameters and operators', () => {
  assert.deepEqual(toks(`SELECT "Order ""Id""", E'a\\'b', 'it''s', $$x;'y$$, $tag$ $$ $tag$, x::date, $1, :name, a @> b, c ->> 'k', 5 # 3`, 'postgres'), [
    'ident:SELECT', 'qident:"Order ""Id"""', 'punct:,', "string:E'a\\'b'", 'punct:,', "string:'it''s'", 'punct:,',
    "string:$$x;'y$$", 'punct:,', 'string:$tag$ $$ $tag$', 'punct:,', 'ident:x', 'op:::', 'ident:date', 'punct:,',
    'param:$1', 'punct:,', 'param::name', 'punct:,', 'ident:a', 'op:@>', 'ident:b', 'punct:,', 'ident:c', 'op:->>',
    "string:'k'", 'punct:,', 'number:5', 'op:#', 'number:3',
  ]);
  assert.equal(unquoteIdent('"Order ""Id"""'), 'Order "Id"');
  // nested block comments, multi-line strings
  assert.deepEqual(toks("/* a /* b */ c */ 'x\ny'", 'postgres'), ['comment:/* a /* b */ c */', "string:'x\ny'"]);
});

test('tokenizer: MySQL comments, variables and quotes; BigQuery unchanged', () => {
  assert.deepEqual(toks("SET @a := 1; SELECT @@session.sql_mode, `t``x`, \"str\" # note", 'mysql'), [
    'ident:SET', 'param:@a', 'op::=', 'number:1', 'punct:;', 'ident:SELECT', 'sysvar:@@session.sql_mode', 'punct:,',
    'qident:`t``x`', 'punct:,', 'string:"str"', 'comment:# note',
  ]);
  assert.deepEqual(toks('SELECT "x", `p.d.t`, @p # c', 'bigquery'), [
    'ident:SELECT', 'string:"x"', 'punct:,', 'qident:`p.d.t`', 'punct:,', 'param:@p', 'comment:# c',
  ]);
  assert.deepEqual(toks('SELECT "x"'), toks('SELECT "x"', 'bigquery'));
});

test('Postgres: quoted names, LATERAL, DISTINCT ON dedupe, no BigQuery-only lint', () => {
  const a = analyze(`WITH latest AS (
  SELECT DISTINCT ON (o.user_id) o.user_id, o.amount
  FROM public."Orders" o
  ORDER BY o.user_id, o.created_at DESC
)
SELECT * FROM latest l
CROSS JOIN LATERAL (SELECT 1 AS one) x
UNION
SELECT * FROM latest`, 'postgres');
  const orders = a.graph.nodes.find((n) => n.kind === 'table');
  assert.equal(orders.full, 'public.Orders');
  assert.equal(orders.label, 'Orders');
  const latest = a.graph.nodes.find((n) => n.label === 'latest');
  assert.equal(latest.shape.dedupe.where, 'DISTINCT ON');
  assert.equal(latest.shape.dedupe.per, 'o.user_id');
  assert.ok(latest.shape.dedupe.latest);
  assert.equal(latest.shape.columns, 2);
  assert.equal(latest.blocks[0][0].alias, 'o');
  assert.ok(a.graph.nodes.some((n) => n.kind === 'subquery' && n.label === 'x'));
  const m = msgs(a);
  assert.doesNotMatch(m, /requires UNION|bills by columns|ORDER BY inside/);
});

test('Postgres: casts, CURRENT_DATE - INTERVAL date windows, params CTE, $1', () => {
  const a = analyze(`WITH params AS (SELECT DATE '2024-01-01' AS start_date),
a AS (SELECT * FROM t, params p WHERE t.created_at::date >= p.start_date AND t.day <= '2024-01-31'::date),
b AS (SELECT * FROM u WHERE u.ts >= CURRENT_DATE - INTERVAL '7 days' AND u.id = $1)
SELECT * FROM a JOIN b USING (id)`, 'postgres');
  const st = (label) => a.dates.steps.find((s) => s.label === label);
  assert.equal(st('a').event.start.day, Math.floor(Date.UTC(2024, 0, 1) / DAY));
  assert.equal(st('a').event.end.day, Math.floor(Date.UTC(2024, 0, 31) / DAY));
  assert.equal(st('a').event.start.col, 'created_at');
  assert.equal(st('b').event.start.day, today - 7);
  assert.equal(a.cteParams[0].name, 'start_date');
  assert.deepEqual(a.params.map((p) => p.text), ['$1']);
  assert.match(msgs(a), /\$1 is a bind parameter/);
  assert.ok(a.literals.some((g) => g.value === '7 days' && g.labels.includes('INTERVAL')));
});

test('MySQL: SET @variables, unset @vars, := assignments, CREATE TABLE … SELECT', () => {
  const a = analyze(`SET @start = '2024-01-01', @n := 3;
SET @unused = 1;
CREATE TEMPORARY TABLE recent SELECT * FROM orders o WHERE o.d >= @start AND o.d < DATE_SUB(CURDATE(), INTERVAL 7 DAY);
SELECT r.id, @rn := @rn + 1 AS rn FROM recent r WHERE r.n > @n AND r.country = @country`, 'mysql');
  assert.deepEqual(a.variables.map((v) => [v.names[0], v.value, v.refs.length, v.kind]),
    [['@start', '2024-01-01', 1, 'set'], ['@n', '3', 1, 'set'], ['@unused', '1', 0, 'set']]);
  assert.deepEqual(a.params.map((p) => [p.text, !!p.assigned]), [['@rn', true], ['@country', false]]);
  const m = msgs(a);
  assert.match(m, /Variable "@unused" is set but never used/);
  assert.match(m, /@country is never SET/);
  assert.doesNotMatch(m, /@rn is never SET/);
  const recent = a.graph.nodes.find((n) => n.label === 'recent');
  assert.equal(recent.kind, 'created');
  assert.deepEqual(recent.in, ['tbl:orders']);
  assert.ok(recent.out.includes('result:1'));
  const w = a.dates.steps.find((s) => s.id === recent.id).event;
  assert.equal(w.start.src.name, '@start');
  assert.equal(w.end.day, today - 7 - 1);
  // SET statements are kept in CTE previews like DECLAREs
  assert.deepEqual(a.statements.map((s) => s.kind), ['set', 'set', 'other', 'other']);
  // hardcoded values in SET are not filter values
  assert.ok(!a.literals.some((g) => g.value === '2024-01-01'));
});

test('rename keeps each dialect’s sigils and quotes', () => {
  const my = 'SET @x = 1; SELECT @x + @x AS y';
  const a = analyze(my, 'mysql');
  const sym = symbolAt(a, my.lastIndexOf('@x') + 1);
  assert.equal(sym.kind, 'variable');
  assert.deepEqual(renameEdits(a, sym, 'total').changes.map((c) => c.insert), ['@total', '@total', '@total']);

  const pg = 'WITH "Daily" AS (SELECT 1 AS n) SELECT * FROM "Daily" WHERE n = $1 OR n = :k';
  const b = analyze(pg, 'postgres');
  const cte = symbolAt(b, pg.lastIndexOf('"Daily"') + 2);
  assert.deepEqual(renameEdits(b, cte, 'Days').changes.map((c) => c.insert), ['"Days"', '"Days"']);
  assert.equal(canRename(symbolAt(b, pg.indexOf('$1') + 1)), false);
  const k = symbolAt(b, pg.indexOf(':k') + 1);
  assert.deepEqual(renameEdits(b, k, 'kind').changes.map((c) => c.insert), [':kind']);
});

test('samples: each dialect formats idempotently and reads the same shape', () => {
  for (const d of ['bigquery', 'postgres', 'mysql']) {
    const out = formatSql(SAMPLES[d], d);
    assert.equal(formatSql(out, d), out, d);
    const a = analyze(out, d);
    assert.equal(a.stats.ctes, d === 'postgres' ? 6 : 5, d);
    assert.equal(a.stats.tables, 5, d);
    assert.ok(!a.diags.some((x) => x.severity === 'error'), `${d}: ${msgs(a)}`);
  }
  const pg = formatSql(SAMPLES.postgres, 'postgres');
  assert.match(pg, /SELECT DISTINCT ON \(o\.listing_id\)\n {4}o\.order_id,/);
  assert.match(pg, /CURRENT_DATE - INTERVAL '90 days'/);
  assert.match(formatSql(SAMPLES.mysql, 'mysql'), /^SET @start_date = '2024-01-01';\nSET @end_date/m);
});

test('table names are quoted the way each dialect writes them', () => {
  assert.equal(quoteTable('proj.ds.t', 'bigquery'), '`proj.ds.t`');
  assert.equal(quoteTable('public.Orders', 'postgres'), 'public."Orders"');
  assert.equal(quoteTable('shop.order items', 'mysql'), 'shop.`order items`');
});

test('detectDialect: clear clues pick a dialect, weak or mixed ones pick none', () => {
  const id = (sql) => detectDialect(sql)?.id ?? null;
  for (const d of ['bigquery', 'postgres', 'mysql']) assert.equal(id(SAMPLES[d]), d);
  assert.equal(id("SELECT * FROM `proj.ds.events` WHERE _PARTITIONDATE >= '2024-01-01'"), 'bigquery');
  assert.equal(id('SELECT * EXCEPT (secret) FROM t QUALIFY ROW_NUMBER() OVER (PARTITION BY id) = 1'), 'bigquery');
  assert.equal(id("SELECT id::text FROM t WHERE name ILIKE '%x%'"), 'postgres');
  assert.equal(id("SELECT date_trunc('month', created_at) FROM t WHERE created_at > now() - interval '7 days'"), 'postgres');
  assert.equal(id('SELECT * FROM orders LIMIT 10, 20'), 'mysql');
  assert.equal(id('SELECT `shop`.`orders`.id FROM `shop`.`orders`'), 'mysql');
  assert.deepEqual(detectDialect("SELECT DATE_FORMAT(d, '%Y') FROM t WHERE d > CURDATE()"), { id: 'mysql', reasons: ['MySQL date functions', 'CURDATE()'] });
  assert.equal(id("SELECT DATE_FORMAT(d, '%Y') FROM t"), null); // one weak clue is not enough
  // Plain SQL that runs anywhere, or too little to go on
  assert.equal(id('SELECT 1'), null);
  assert.equal(id('SELECT a FROM t WHERE d >= DATE_SUB(CURRENT_DATE, INTERVAL 7 DAY) AND x IN (SELECT y FROM u)'), null);
  assert.equal(id('SELECT a FROM t UNION SELECT a FROM u EXCEPT (SELECT a FROM v)'), null);
  // Clues inside comments and strings don't count
  assert.equal(id("-- try ::casts, QUALIFY, LIMIT 1, 2\nSELECT 'a::b', '#1 GROUP_CONCAT(' FROM t /* DISTINCT ON ( */"), null);
  // Clues for two dialects at once: no switch
  assert.equal(id('SELECT x::date FROM `proj.ds.t`'), null);
});
