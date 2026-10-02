// Line diff (LCS over the lines that differ after trimming the common head and
// tail) plus an intra-line highlight for changed line pairs.

export function diffLines(a, b) {
  const A = a.split('\n');
  const B = b.split('\n');
  let pre = 0;
  while (pre < A.length && pre < B.length && A[pre] === B[pre]) pre++;
  let suf = 0;
  while (suf < A.length - pre && suf < B.length - pre && A[A.length - 1 - suf] === B[B.length - 1 - suf]) suf++;
  const a2 = A.slice(pre, A.length - suf);
  const b2 = B.slice(pre, B.length - suf);

  const ops = [];
  for (let i = 0; i < pre; i++) ops.push({ t: 'same', a: i, b: i, text: A[i] });

  const n = a2.length;
  const m = b2.length;
  if (n * m > 4e6) {
    // Too big for LCS: treat the middle as fully replaced.
    a2.forEach((text, i) => ops.push({ t: 'del', a: pre + i, text }));
    b2.forEach((text, j) => ops.push({ t: 'add', b: pre + j, text }));
  } else {
    // L[i][j] = LCS length of a2[i..] and b2[j..]
    const L = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        L[i][j] = a2[i] === b2[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && a2[i] === b2[j]) { ops.push({ t: 'same', a: pre + i, b: pre + j, text: a2[i] }); i++; j++; }
      // On ties, removals come before additions so edited lines pair up as del → add.
      else if (i < n && (j >= m || L[i + 1][j] >= L[i][j + 1])) { ops.push({ t: 'del', a: pre + i, text: a2[i] }); i++; }
      else { ops.push({ t: 'add', b: pre + j, text: b2[j] }); j++; }
    }
  }
  for (let k = 0; k < suf; k++) {
    const ai = A.length - suf + k;
    const bi = B.length - suf + k;
    ops.push({ t: 'same', a: ai, b: bi, text: A[ai] });
  }
  pairChanges(ops);
  return ops;
}

// Within each run of deletions followed by additions, pair lines up and mark
// the span that differs (common prefix / suffix removed).
function pairChanges(ops) {
  let k = 0;
  while (k < ops.length) {
    if (ops[k].t !== 'del') { k++; continue; }
    const ds = k;
    while (k < ops.length && ops[k].t === 'del') k++;
    const as = k;
    while (k < ops.length && ops[k].t === 'add') k++;
    const dels = ops.slice(ds, as);
    const adds = ops.slice(as, k);
    for (let p = 0; p < Math.min(dels.length, adds.length); p++) {
      const x = dels[p].text;
      const y = adds[p].text;
      let s = 0;
      while (s < x.length && s < y.length && x[s] === y[s]) s++;
      let e = 0;
      while (e < x.length - s && e < y.length - s && x[x.length - 1 - e] === y[y.length - 1 - e]) e++;
      // Only highlight when the lines are clearly the same line edited.
      if (s + e >= Math.min(x.length, y.length) * 0.4) {
        dels[p].hl = [s, x.length - e];
        adds[p].hl = [s, y.length - e];
      }
    }
  }
}

export function diffStats(ops) {
  let add = 0;
  let del = 0;
  for (const o of ops) {
    if (o.t === 'add') add++;
    else if (o.t === 'del') del++;
  }
  return { add, del, changed: add + del > 0 };
}

// Group into hunks with `ctx` lines of context; long unchanged stretches fold.
export function toHunks(ops, ctx = 3) {
  const keep = new Uint8Array(ops.length);
  ops.forEach((o, i) => {
    if (o.t === 'same') return;
    for (let d = Math.max(0, i - ctx); d <= Math.min(ops.length - 1, i + ctx); d++) keep[d] = 1;
  });
  const out = [];
  let skipped = 0;
  ops.forEach((o, i) => {
    if (keep[i]) {
      if (skipped) out.push({ t: 'fold', count: skipped });
      skipped = 0;
      out.push(o);
    } else {
      skipped++;
    }
  });
  if (skipped) out.push({ t: 'fold', count: skipped });
  return out;
}

// Side-by-side rows from diff ops (or toHunks output): unchanged lines sit on
// both sides, and each run of deletions pairs up with the additions that follow
// it, so an edited line shows old on the left and new on the right.
export function toSplitRows(items) {
  const rows = [];
  let k = 0;
  while (k < items.length) {
    const o = items[k];
    if (o.t === 'fold') { rows.push(o); k++; continue; }
    if (o.t === 'same') { rows.push({ t: 'same', l: o, r: o }); k++; continue; }
    const dels = [];
    const adds = [];
    while (k < items.length && items[k].t === 'del') dels.push(items[k++]);
    while (k < items.length && items[k].t === 'add') adds.push(items[k++]);
    for (let p = 0; p < Math.max(dels.length, adds.length); p++) {
      rows.push({ t: 'change', l: dels[p] || null, r: adds[p] || null });
    }
  }
  return rows;
}
