import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyze } from '../src/analyzer.js';
import { SAMPLE_SQL } from '../src/sample.js';
import { formatSql } from '../src/format.js';
import { describeWindow } from '../src/shape.js';

test('sample: graph, variables, literals, lint', () => {
  const r = analyze(SAMPLE_SQL);
  const ids = r.graph.nodes.map((n) => n.id).sort();
  assert.deepEqual(ids, [
    'cte:legendaries', 'cte:ranked', 'cte:stats', 'cte:team', 'result:1',
    'tbl:pokedex.pokemon', 'tbl:pokedex.teams', 'tbl:pokedex.trainers',
  ]);
  const e = r.graph.edges.find((e) => e.from === 'cte:stats' && e.to === 'cte:ranked');
  assert.equal(e.joins[0].joinType, 'INNER');
  assert.deepEqual(e.joins[0].keys, [{ left: 's.pokemon_id', right: 't.pokemon_id' }]);
  assert.deepEqual(r.variables.map((v) => [v.names[0], v.value, v.refs.length]), [
    ['caught_since', '2024-01-01', 1], ['min_level', '20', 1],
  ]);
  const lit = Object.fromEntries(r.literals.map((g) => [g.key, g]));
  assert.ok(lit['s:Kanto'] && lit['s:Johto']);
  const msgs = r.diags.map((d) => d.message);
  assert.ok(msgs.some((m) => m.includes('legendaries') && m.includes('never used')));
  assert.ok(msgs.some((m) => m.startsWith('SELECT *')));
});

test('lint rules', () => {
  const m = (sql) => analyze(sql).diags.map((d) => d.message).join('\n');
  assert.match(m('select a from t union select a from u'), /UNION ALL or UNION DISTINCT/);
  assert.doesNotMatch(m('select * except (a) from t'), /EXCEPT ALL/);
  assert.match(m('select a from t join u'), /JOIN without ON/);
  assert.doesNotMatch(m('select a from t join unnest(t.arr) x'), /JOIN without ON/);
  assert.doesNotMatch(m('select a from t cross join u'), /JOIN without ON/);
  assert.match(m('select a from t, u'), /Comma join/);
  assert.doesNotMatch(m('select a from t, t.items it'), /Comma join/);
  assert.match(m('select a from t where b = null'), /IS NULL/);
  assert.match(m('select a from [proj:ds.t]'), /Legacy SQL/);
  assert.match(m('select (a from t'), /never closed/);
  assert.match(m("select 'abc from t"), /Unterminated string/);
  assert.match(m('select 1; declare x int64;'), /DECLARE must come before/);
  assert.match(m('declare country string; select t.country from t'), /column is also named/);
  assert.match(m('select a from t t1 join u t1 on t1.a = t1.b'), /used twice/);
});

test('extract(... from ...) is not a table; temp tables chain', () => {
  const r = analyze(`create temp table base as select id, extract(year from ts) y from proj.ds.events;
select * from base b join \`proj.ds.users\` u using (id)`);
  const ids = r.graph.nodes.map((n) => n.id).sort();
  assert.deepEqual(ids, ['result:1', 'tbl:proj.ds.events', 'tbl:proj.ds.users', 'tmp:base']);
  const e = r.graph.edges.find((e) => e.from === 'tbl:proj.ds.users');
  assert.equal(e.joins[0].joinType, 'INNER');
  assert.deepEqual(e.joins[0].keys, [{ left: 'id', right: 'id' }]);
});

test('unquoted project with dashes, subquery in FROM, nested WITH', () => {
  const r = analyze(`select * from my-proj-1.ds.t a left join (with z as (select 1 k from ds.z) select k from z) s on s.k = a.k`);
  const ids = r.graph.nodes.map((n) => n.id).sort();
  assert.deepEqual(ids, ['cte:z', 'result:1', 'sq:1', 'tbl:ds.z', 'tbl:my-proj-1.ds.t']);
});

test('BETWEEN end literal is found when the start is a variable', () => {
  const r = analyze(`declare d date default '2024-01-01'; select 1 from t where x between d and '2024-02-01' and y between date '2024-01-01' and date '2024-03-01'`);
  const labels = r.literals.flatMap((g) => g.labels);
  assert.ok(labels.includes('x BETWEEN (end)'));
  assert.ok(labels.includes('y BETWEEN (end)'));
  assert.ok(labels.includes('y BETWEEN'));
});

test('format keeps commas attached when items have trailing comments', () => {
  const out = formatSql(`select a as x -- first\n, b -- second\n, c from t`);
  assert.doesNotMatch(out, /^\s*,\s*$/m);
  assert.match(out, /a AS x, -- first/);
  assert.match(out, /b, -- second/);
});

test('shape: filters, group by ordinal, dedupe via join', () => {
  const r = analyze(`with c as (select p.id as pid, count(distinct u) n from p where p.t >= '2025-05-01' and 1 = 1 group by 1)
select * from m left join (select id, row_number() over (partition by id order by ts desc) rn from tx) lt on lt.id = m.id and lt.rn = 1 join c on c.pid = m.id`);
  const c = r.graph.nodes.find((n) => n.id === 'cte:c').shape;
  assert.deepEqual(c.filters, ["p.t >= '2025-05-01'"]);
  assert.deepEqual(c.groupBy, ['pid']);
  assert.deepEqual(c.aggregates, ['COUNT DISTINCT']);
  const sq = r.graph.nodes.find((n) => n.id === 'sq:1').shape;
  assert.equal(sq.dedupe.per, 'id');
  assert.equal(sq.dedupe.latest, true);
});

test('filter values know which step they belong to', () => {
  const r = analyze(`declare d date default '2024-01-01';
with a as (select * from t where dt >= '2025-04-01'), b as (select * from a where x = 'L' and y in (select id from u where z = 5))
select * from b where b.k = 'Q' and b.day >= d`);
  const own = Object.fromEntries(r.literals.map((g) => [g.value, g.owners.join(',')]));
  assert.equal(own['2025-04-01'], 'cte:a');
  assert.equal(own['L'], 'cte:b');
  assert.equal(own['5'], 'cte:b');
  assert.equal(own['Q'], 'result:1');
  assert.deepEqual(r.variables[0].owners, ['result:1']);
});

test('IN / EXISTS subqueries are filter links, scalar subqueries are lookups', () => {
  const r = analyze(`with pb as (select product_id from p), bm as (select product_id, count(*) n from b
    where product_id in (select product_id from pb) and not exists (select 1 from z where z.id = b.id) group by 1)
    select (select max(v) from s) mx, pb.product_id from pb left join bm on pb.product_id = bm.product_id`);
  const role = Object.fromEntries(r.graph.edges.map((e) => [`${e.from}>${e.to}`, e.role]));
  assert.equal(role['cte:pb>cte:bm'], 'filter');
  assert.equal(role['tbl:z>cte:bm'], 'filter');
  assert.equal(role['tbl:s>result:1'], 'lookup');
  assert.equal(role['cte:pb>result:1'], 'data');
  const semi = r.graph.nodes.find((n) => n.id === 'cte:bm').shape.semi;
  assert.deepEqual(semi.map((x) => [x.label, x.kind, x.col]), [['pb', 'IN', 'product_id'], ['z', 'NOT EXISTS', '']]);
});

test('a CTE with no FROM is a params CTE: values editable, no cross-join warning', () => {
  const r = analyze(`with params as (select DATE('2024-01-01') as start_date, 30 as days), a as (select * from t, params where t.d >= params.start_date)
select * from a`);
  assert.deepEqual(r.cteParams.map((p) => [p.name, p.value, p.edit.kind]), [['start_date', '2024-01-01', 'string'], ['days', '30', 'number']]);
  assert.equal(r.graph.edges.find((e) => e.from === 'cte:params').role, 'params');
  assert.ok(!r.diags.some((d) => /Comma join/.test(d.message)));
});

test('aggregates inside scalar subqueries do not make the step aggregated; ARRAY literals stay whole', () => {
  const r = analyze(`with params as (select ['A', 'B'] as srcs, 'x' as k), req as (select r.id, (select count(*) from unnest(r.s) s) as n, array(select distinct x from unnest(r.t) x) xs from t r, params p)
select * from req`);
  assert.deepEqual(r.graph.nodes.find((n) => n.id === 'cte:req').shape.aggregates, []);
  assert.deepEqual(r.cteParams.map((p) => [p.name, p.value]), [['srcs', "['A', 'B']"], ['k', 'x']]);
});

test('date windows: mismatches across steps, partition narrower than window', () => {
  const r = analyze(`DECLARE s DATE DEFAULT '2024-01-01';
WITH a AS (SELECT * FROM t WHERE DATE(t.ts) BETWEEN s AND '2024-03-31'),
b AS (SELECT * FROM u WHERE u.d >= DATE '2024-01-01' AND u.d < '2024-04-01'),
c AS (SELECT * FROM v WHERE v._PARTITIONDATE >= '2024-02-01' AND v.dt >= '2024-01-01' AND v.dt <= '2024-02-29')
SELECT * FROM a, b, c`);
  const f = (d) => new Date(d * 86400000).toISOString().slice(0, 10);
  const byLabel = Object.fromEntries(r.dates.steps.map((st) => [st.label, st]));
  assert.equal(f(byLabel.b.event.end.day), '2024-03-31'); // "< 2024-04-01" is an inclusive end of 03-31
  assert.equal(f(r.dates.ref.start), '2024-01-01');
  assert.equal(f(r.dates.ref.end), '2024-03-31');
  assert.ok(byLabel.c.mismatch.end);
  assert.ok(byLabel.c.mismatch.partition);
  assert.ok(!byLabel.a.mismatch.start && !byLabel.b.mismatch.end);
  const msgs = r.diags.map((d) => d.message).join('\n');
  assert.match(msgs, /c ends 2024-02-29, but a, b end 2024-03-31/);
  assert.match(msgs, /Partition filter on _PARTITIONDATE starts 2024-02-01/);
});

test('date windows: a params CTE with a one-day partition buffer is consistent', () => {
  const r = analyze(`WITH params AS (SELECT DATE '2026-06-21' AS ws, DATE '2026-09-19' AS we, DATE_SUB(DATE '2026-06-21', INTERVAL 1 DAY) AS ps),
req AS (SELECT * FROM t, params p WHERE t._PARTITIONDATE BETWEEN DATE_SUB(p.ws, INTERVAL 1 DAY) AND DATE_ADD(p.we, INTERVAL 1 DAY)),
d AS (SELECT * FROM req r, params p WHERE r.d BETWEEN p.ws AND p.we)
SELECT * FROM d`);
  assert.equal(r.dates.issues.length, 0);
  const req = r.dates.steps.find((s) => s.label === 'req');
  assert.equal(new Date(req.partition.start.day * 86400000).toISOString().slice(0, 10), '2026-06-20');
});

test('format keeps a comment after a semicolon on its statement', () => {
  const out = formatSql(`DECLARE a DATE DEFAULT DATE_SUB(CURRENT_DATE(), INTERVAL 1 DAY);  -- yesterday\nDECLARE b INT64 DEFAULT 3; # three\nSELECT a, b -- cols\nFROM t;`);
  const lines = out.split('\n');
  assert.ok(lines.some((l) => /^\);?\s+-- yesterday$/.test(l) || /DAY\);\s+-- yesterday$/.test(l)), out);
  assert.ok(lines.some((l) => /^DECLARE b INT64 DEFAULT 3;\s+# three$/.test(l)), out);
  assert.ok(!lines.some((l) => /^-- yesterday/.test(l.trim()) && !l.includes(';')), out);
  assert.ok(out.includes('-- cols'), out);
});

test('outer join undone by WHERE or a later INNER JOIN', () => {
  const m = (sql) => analyze(sql).diags.filter((d) => /keeps rows with no match/.test(d.message)).map((d) => sql.slice(d.from, d.to));
  assert.deepEqual(m(`select a.x from a left join b on a.id = b.id where b.status = 'x'`), [`b.status = 'x'`]);
  assert.deepEqual(m(`select a.x from a left join b on a.id = b.id where a.s = 1 and b.n != 2`), ['b.n != 2']);
  assert.deepEqual(m(`select a.x from a left join b on a.id = b.id join c on c.k = b.k`), ['c.k = b.k']);
  assert.deepEqual(m(`select a.x from a right join b on a.id = b.id where a.s = 'z'`), [`a.s = 'z'`]);
  assert.deepEqual(m(`select a.x from a full join b using (id) where a.s = 1 and b.t = 2`), ['a.s = 1', 'b.t = 2']);
  // NULL handled on purpose, or the condition is on the kept side
  assert.deepEqual(m(`select a.x from a left join b on a.id = b.id where b.status = 'x' or b.status is null`), []);
  assert.deepEqual(m(`select a.x from a left join b on a.id = b.id where b.id is null`), []);
  assert.deepEqual(m(`select a.x from a left join b on a.id = b.id where coalesce(b.s, 0) = 0`), []);
  assert.deepEqual(m(`select a.x from a left join b on a.id = b.id join c on c.k = a.k where a.s = 1`), []);
  assert.deepEqual(m(`select a.x from a left join b on a.id = b.id where a.id in (select id from z where z.q = b.q)`), []);
});

test('fan-out: a join on part of a CTE grain, added up by a SUM', () => {
  const m = (sql) => analyze(sql).diags.filter((d) => /one row per/.test(d.message)).map((d) => d.message);
  const daily = 'with d as (select user_id, day, sum(v) v from t group by user_id, day) ';
  assert.match(m(daily + 'select sum(o.amount) from o join d on o.user_id = d.user_id')[0],
    /^d has one row per \(user_id, day\), but this join matches it on user_id only, so each o row .* sum\(o\.amount\) adds it up more than once\. Join on day too/);
  assert.equal(m(daily + 'select sum(o.amount) from d join o on o.user_id = d.user_id').length, 1); // d first: o repeats
  assert.equal(m(daily + 'select sum(o.amount) from o join d using (user_id)').length, 1);
  assert.equal(m('with d as (select * from t qualify row_number() over (partition by user_id, day order by ts desc) = 1) select sum(o.x) from o join d using (user_id)').length, 1);
  // d's own rows aren't repeated; DISTINCT / MAX don't add up; the join covers the grain; WHERE pins the rest
  assert.deepEqual(m(daily + 'select sum(d.v) from o join d on o.user_id = d.user_id'), []);
  assert.deepEqual(m(daily + 'select count(distinct o.id), max(o.x) from o join d on o.user_id = d.user_id'), []);
  assert.deepEqual(m(daily + 'select sum(o.amount) from o join d on o.user_id = d.user_id and o.day = d.day'), []);
  assert.deepEqual(m(daily + "select sum(o.amount) from o join d on o.user_id = d.user_id and d.day = date '2024-01-01'"), []);
  assert.deepEqual(m(daily + 'select o.* from o join d on o.user_id = d.user_id'), []); // one-to-many on purpose
});

test('window functions: args, keys, frames, named windows, plain-words kind', () => {
  const r = analyze(`SELECT
  SUM(oi.price) OVER (PARTITION BY c.id ORDER BY o.day, o.id) AS running_spend,
  DENSE_RANK() OVER (ORDER BY SUM(oi.price) OVER (PARTITION BY c.id) DESC NULLS LAST) AS spend_rank,
  LAG(o.day, 2) OVER w AS prev_day,
  AVG(oi.price) OVER (w ROWS BETWEEN 6 PRECEDING AND CURRENT ROW) AS avg_7,
  LAST_VALUE(o.id) OVER (PARTITION BY c.id ORDER BY o.day) AS last_id,
  COUNT(*) OVER (PARTITION BY c.id) AS n
FROM customers c JOIN orders o ON c.id = o.cid JOIN order_items oi ON o.id = oi.oid
WINDOW w AS (PARTITION BY c.id ORDER BY o.day)`);
  const ws = r.graph.nodes.find((n) => n.kind === 'result').shape.windows;
  const by = Object.fromEntries(ws.map((w) => [w.alias, w]));
  assert.equal(by.running_spend.args, 'oi.price');
  assert.deepEqual(by.running_spend.orderKeys, [{ text: 'o.day', desc: false }, { text: 'o.id', desc: false }]);
  assert.deepEqual(by.spend_rank.orderKeys, [{ text: 'SUM(oi.price) per c.id', desc: true }]);
  assert.equal(by.prev_day.partition, 'c.id');
  assert.equal(by.avg_7.partition, 'c.id');
  assert.equal(by.avg_7.frame, 'ROWS BETWEEN 6 PRECEDING AND CURRENT ROW');
  const kind = (a) => describeWindow(by[a]);
  assert.deepEqual(ws.map((w) => describeWindow(w).kind), ['running', 'rank', 'offset', 'rolling', 'pick', 'total']);
  assert.equal(kind('prev_day').what, 'o.day from 2 rows back');
  assert.equal(kind('avg_7').label, 'rolling avg');
  assert.equal(kind('last_id').notes.length, 1);
  assert.ok(r.diags.some((d) => d.message.startsWith('LAST_VALUE with ORDER BY')));
  // A frame size is not a hardcoded filter value.
  assert.ok(!r.literals.some((g) => g.value === '6'));
});
