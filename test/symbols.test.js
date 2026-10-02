import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyze } from '../src/analyzer.js';
import { symbolAt, occurrences, renameEdits, cteAt, previewSql } from '../src/symbols.js';
import { encodeShare, decodeShare } from '../src/share.js';

const SQL = `DECLARE start_date DATE DEFAULT '2024-01-01';
CREATE TEMP FUNCTION clean(s STRING) AS (TRIM(s));
WITH base AS (
  SELECT u.user_id, u.country FROM \`proj.core.users\` AS u WHERE u.signup >= start_date
),

orders AS (
  SELECT o.user_id, o.gmv FROM \`proj.core.orders\` o
  WHERE o.user_id IN (SELECT user_id FROM base)
),

unused AS (SELECT 1 AS x)
SELECT base.country, SUM(o.gmv) AS gmv
FROM base
LEFT JOIN orders AS o ON o.user_id = base.user_id
WHERE base.country = @country
GROUP BY 1;
`;
const a = analyze(SQL);
const at = (needle, off = 0, nth = 0) => {
  let i = -1;
  for (let k = 0; k <= nth; k++) i = SQL.indexOf(needle, i + 1);
  assert.ok(i >= 0, needle);
  return i + off;
};
const texts = (sym) => occurrences(sym).map((r) => SQL.slice(r.from, r.to));

test('symbolAt: CTE from its definition, a FROM reference and an unaliased qualifier', () => {
  for (const pos of [at('base AS'), at('FROM base', 5, 1), at('base.country', 1)]) {
    const s = symbolAt(a, pos);
    assert.equal(s.kind, 'cte');
    assert.equal(s.name, 'base');
  }
  const s = symbolAt(a, at('base AS'));
  assert.equal(s.def.from, at('base AS'));
  // definition, FROM inside the IN subquery, final FROM, and three `base.` qualifiers
  assert.equal(occurrences(s).length, 6);
});

test('symbolAt: aliases resolve per step', () => {
  const u = symbolAt(a, at('u.user_id'));
  assert.equal(u.kind, 'alias');
  assert.deepEqual(texts(u), ['u', 'u', 'u', 'u']);
  const inner = symbolAt(a, at('o.user_id'));
  const outer = symbolAt(a, at('o.gmv', 0, 1));
  assert.notEqual(inner.item, outer.item);
  assert.equal(occurrences(outer).length, 3); // AS o, o.gmv, o.user_id in ON
});

test('symbolAt: variables, parameters, tables', () => {
  const v = symbolAt(a, at('start_date', 2, 1));
  assert.equal(v.kind, 'variable');
  assert.equal(occurrences(v).length, 2);
  const p = symbolAt(a, at('@country', 3));
  assert.equal(p.kind, 'param');
  assert.equal(p.def, null);
  const t = symbolAt(a, at('core.users', 2));
  assert.equal(t.kind, 'table');
  assert.equal(symbolAt(a, at('SUM')), null);
  assert.equal(symbolAt(a, at('gmv) AS gmv', 9)), null);
});

test('renameEdits: renames every occurrence, keeps backticks and @, refuses clashes', () => {
  const s = symbolAt(a, at('base AS'));
  const r = renameEdits(a, s, 'users_base');
  assert.equal(r.changes.length, 6);
  assert.ok(r.changes.every((c) => c.insert === 'users_base'));
  assert.match(renameEdits(a, s, 'orders').error, /already used/);
  assert.match(renameEdits(a, s, 'select').error, /reserved/);
  assert.match(renameEdits(a, s, '1x').error, /letters/);
  const p = renameEdits(a, symbolAt(a, at('@country')), 'market');
  assert.deepEqual(p.changes.map((c) => c.insert), ['@market']);
  assert.match(renameEdits(a, symbolAt(a, at('core.users')), 'x').error, /Only CTEs/);

  const q = analyze('WITH `my cte` AS (SELECT 1 AS a) SELECT * FROM `my cte`');
  const qs = symbolAt(q, 6);
  assert.deepEqual(renameEdits(q, qs, 'b').changes.map((c) => c.insert), ['`b`', '`b`']);
});

test('previewSql: keeps declarations, includes upstream CTEs only, in order', () => {
  const p = previewSql(a, cteAt(a, at('o.gmv')).id);
  assert.equal(p.label, 'orders');
  assert.equal(p.ctes, 2);
  assert.ok(p.sql.startsWith("DECLARE start_date DATE DEFAULT '2024-01-01';\nCREATE TEMP FUNCTION clean"));
  assert.ok(p.sql.indexOf('WITH base AS (') < p.sql.indexOf('orders AS ('));
  assert.ok(!p.sql.includes('unused'));
  assert.ok(p.sql.trimEnd().endsWith('SELECT *\nFROM orders\nLIMIT 100;'));
  // The preview itself is a clean query: both CTEs used, nothing defined twice.
  const pa = analyze(p.sql);
  assert.deepEqual(pa.diags.filter((d) => d.severity === 'error'), []);
  assert.equal(pa.stats.ctes, 2);
  assert.equal(cteAt(a, at('GROUP BY')), null);
});

test('previewSql: a CTE nested in another is lifted out and re-indented', () => {
  const sql = `WITH outer_cte AS (
  WITH inner_cte AS (
    SELECT
      1 AS a
  )
  SELECT * FROM inner_cte
)
SELECT * FROM outer_cte`;
  const q = analyze(sql);
  const p = previewSql(q, cteAt(q, sql.indexOf('1 AS a')).id);
  assert.equal(p.sql, 'WITH inner_cte AS (\n  SELECT\n    1 AS a\n)\n\nSELECT *\nFROM inner_cte\nLIMIT 100;\n');
});

test('share links round-trip unicode and long queries', async () => {
  const sql = SQL.repeat(40) + "-- ünïcødé ✓ 'quotes' \\ backslash\n";
  const hash = await encodeShare(sql);
  assert.match(hash, /^#sql=[A-Za-z0-9_-]+$/);
  assert.ok(hash.length < sql.length / 4);
  // Links without a dialect (made before there were others) are BigQuery.
  assert.deepEqual(await decodeShare(hash), { text: sql, dialect: 'bigquery' });
  const pg = await encodeShare(sql, 'postgres');
  assert.match(pg, /&dialect=postgres$/);
  assert.deepEqual(await decodeShare(pg), { text: sql, dialect: 'postgres' });
  assert.equal(await decodeShare('#other'), null);
  await assert.rejects(decodeShare('#sql=AAAA'));
});
