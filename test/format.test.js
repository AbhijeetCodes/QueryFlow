import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatSql } from '../src/format.js';

const SQL = `with a as (select u.id, count(*) n from \`p.d.users\` u where u.x = 1 group by 1), b as (select * from a)
select a.id from a join b on b.id = a.id left join c on c.id = a.id where a.n > 1 and a.id is not null`;

test('format: sqlfluff-style CTE and FROM layout', () => {
  const out = formatSql(SQL);
  assert.match(out, /^WITH a AS \($/m);
  assert.match(out, /^\),\n\nb AS \($/m);
  assert.match(out, /^\)\n\nSELECT a\.id$/m);
  assert.match(out, /^ {2}FROM `p\.d\.users` AS u$/m);
  assert.match(out, /^ {2}WHERE u\.x = 1$/m);
  assert.match(out, /^FROM a$/m);
  assert.match(out, /^INNER JOIN b ON b\.id = a\.id$/m);
  assert.match(out, /^LEFT JOIN c ON c\.id = a\.id$/m);
  assert.match(out, /^WHERE a\.n > 1 AND a\.id IS NOT NULL$/m);
});

test('format: explicit AS for table and column aliases', () => {
  const out = formatSql(`select count(*) n, x is null flag, case when a then 1 end c, interval 7 day, sum(x) over w s
from t tt, (select 1 k) q window w as (partition by a)`);
  for (const s of ['COUNT(*) AS n', 'x IS NULL AS flag', 'END AS c', 'SUM(x) OVER w AS s', 't AS tt', ') AS q']) assert.ok(out.includes(s), `${s}\n${out}`);
  assert.ok(out.includes('INTERVAL 7 DAY,'), out);
  assert.doesNotMatch(out, /AS AS|OVER AS|DAY AS/);
});

test('format: leaves multi-line strings alone and is idempotent', () => {
  const src = `with a as (select '''one\n  two''' s from t) select s from a`;
  const out = formatSql(src);
  assert.ok(out.includes(`'''one\n  two'''`), out);
  assert.equal(formatSql(out), out);
  assert.equal(formatSql(formatSql(SQL)), formatSql(SQL));
});

test('format: long WHERE stays one condition per line', () => {
  const out = formatSql(`select a from t where a.some_long_column_name = 1 and b.another_long_column_name = 2 and c.third_column = 3`);
  assert.match(out, /^WHERE\n {2}a\.some_long_column_name = 1\n {2}AND b\./m);
});

test('format options: leading commas, keyword case, indent, expanded lists', () => {
  const lead = formatSql(SQL, 'bigquery', { commas: 'leading' });
  assert.match(lead, /^\)\n\n, b AS \($/m);
  assert.match(lead, /^ {4}u\.id\n {4}, COUNT\(\*\) AS n$/m);
  assert.doesNotMatch(lead, /,$/m);
  assert.equal(formatSql(lead, 'bigquery', { commas: 'leading' }), lead);
  const commented = formatSql('select a, -- note\n b from t', 'bigquery', { commas: 'leading' });
  assert.match(commented, /^ {2}a -- note\n {2}, b$/m);

  const lower = formatSql(SQL, 'bigquery', { keywordCase: 'lower', indent: '4' });
  assert.match(lower, /^with a as \($/m);
  assert.match(lower, /^ {8}u\.id,\n {8}count\(\*\) as n$/m);
  assert.match(lower, /^inner join b on b\.id = a\.id$/m);

  const tab = formatSql(SQL, 'bigquery', { indent: 'tab', compact: false });
  assert.match(tab, /^\twhere\n\t\tu\.x = 1$/im);
  assert.match(tab, /^\tGROUP BY\n\t\t1$/m);

  const typed = formatSql('select x n from t', 'bigquery', { keywordCase: 'preserve' });
  assert.equal(typed, 'select x as n\nfrom t\n');
});
