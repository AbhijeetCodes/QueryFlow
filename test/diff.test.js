import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diffLines, diffStats, toHunks, toSplitRows } from '../src/diff.js';

test('diff: edited value is a paired del/add with the changed span marked', () => {
  const a = "SELECT *\nFROM t\nWHERE d >= '2024-01-01'\nAND x = 1";
  const b = "SELECT *\nFROM t\nWHERE d >= '2024-06-01'\nAND x = 1";
  const ops = diffLines(a, b);
  assert.deepEqual(diffStats(ops), { add: 1, del: 1, changed: true });
  const del = ops.find((o) => o.t === 'del');
  const add = ops.find((o) => o.t === 'add');
  assert.equal(del.text.slice(...del.hl), '1');
  assert.equal(add.text.slice(...add.hl), '6');
});

test('diff: inserted lines, no changes, folding', () => {
  const a = Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n');
  const b = a.replace('line 15', 'DECLARE v INT64 DEFAULT 1;\nline 15');
  const ops = diffLines(a, b);
  assert.deepEqual(diffStats(ops), { add: 1, del: 0, changed: true });
  const h = toHunks(ops, 2);
  assert.equal(h[0].t, 'fold');
  assert.equal(h[0].count, 13);
  assert.equal(diffStats(diffLines(a, a)).changed, false);
});

test('split rows: edited line pairs old/new, extra adds and dels leave the other side empty', () => {
  const a = 'a\nold1\nold2\nz';
  const b = 'a\nnew1\nz\nextra';
  const rows = toSplitRows(diffLines(a, b));
  assert.deepEqual(rows.map((r) => [r.t, r.l?.text ?? null, r.r?.text ?? null]), [
    ['same', 'a', 'a'],
    ['change', 'old1', 'new1'],
    ['change', 'old2', null],
    ['same', 'z', 'z'],
    ['change', null, 'extra'],
  ]);
});

test('split rows: folds pass through', () => {
  const a = Array.from({ length: 30 }, (_, i) => `l${i}`).join('\n');
  const rows = toSplitRows(toHunks(diffLines(a, a.replace('l15', 'X')), 3));
  assert.equal(rows.filter((r) => r.t === 'fold').length, 2);
});
