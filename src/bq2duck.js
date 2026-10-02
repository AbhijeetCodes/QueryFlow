// BigQuery (GoogleSQL) -> DuckDB, so a query can run on small test tables in
// the browser. A token-level rewrite on top of the analyzer, not a parser: it
// keeps the layout (so line numbers in DuckDB errors match the editor), points
// table names at the test tables, and rewrites the syntax and functions DuckDB
// spells differently. Anything it doesn't know passes through unchanged, and
// DuckDB's own error explains what's left.

import { analyze, RESERVED } from './analyzer.js';
import { tokenize } from './tokenizer.js';

const sig = (t) => t.t !== 'ws' && t.t !== 'comment';
const sqlStr = (s) => `'${String(s).replace(/'/g, "''")}'`;
const quoteId = (s) => `"${String(s).replace(/"/g, '""')}"`;
const SIMPLE = /^[A-Za-z_][A-Za-z0-9_]*$/;

// Words DuckDB reserves that BigQuery lets you use as a plain column name.
const DUCK_RESERVED = new Set(`ANALYSE ANALYZE ASYMMETRIC BOTH CHECK COLUMN CONSTRAINT DEFERRABLE DESCRIBE DO
FOREIGN GRANT INITIALLY LEADING ONLY PLACING PRIMARY REFERENCES RETURNING SHOW SUMMARIZE SYMMETRIC TRAILING
UNIQUE VARIADIC`.split(/\s+/));

const PARTS = new Set(['MICROSECOND', 'MILLISECOND', 'SECOND', 'MINUTE', 'HOUR', 'DAY', 'WEEK', 'ISOWEEK',
  'MONTH', 'QUARTER', 'YEAR', 'ISOYEAR', 'DAYOFWEEK', 'DAYOFYEAR', 'DATE', 'TIME', 'DATETIME']);
const WEEKDAYS = ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY', 'SUNDAY'];
const CONTROL = new Set(['BEGIN', 'END', 'IF', 'ELSEIF', 'LOOP', 'WHILE', 'REPEAT', 'FOR', 'CALL', 'EXECUTE',
  'RETURN', 'BREAK', 'LEAVE', 'CONTINUE', 'ITERATE', 'RAISE', 'EXCEPTION', 'DO']);

// ---- types ------------------------------------------------------------------------

const SCALAR_TYPES = {
  INT64: 'BIGINT', INT: 'BIGINT', INTEGER: 'BIGINT', SMALLINT: 'BIGINT', BIGINT: 'BIGINT', TINYINT: 'BIGINT', BYTEINT: 'BIGINT',
  FLOAT64: 'DOUBLE', FLOAT: 'DOUBLE', NUMERIC: 'DECIMAL(38,9)', DECIMAL: 'DECIMAL(38,9)',
  BIGNUMERIC: 'DECIMAL(38,9)', BIGDECIMAL: 'DECIMAL(38,9)', STRING: 'VARCHAR', BYTES: 'BLOB', BOOL: 'BOOLEAN',
  BOOLEAN: 'BOOLEAN', DATE: 'DATE', DATETIME: 'TIMESTAMP', TIMESTAMP: 'TIMESTAMP', TIME: 'TIME', JSON: 'JSON',
  INTERVAL: 'INTERVAL', GEOGRAPHY: 'VARCHAR',
};

// Parse a BigQuery type from sig tokens S starting at k. Returns { text, k } (k = next index).
function parseType(S, k, warn) {
  const t = S[k];
  if (!t) return { text: '', k };
  const u = t.u || '';
  const isOpen = (x) => S[x] && S[x].s === '<';
  if ((u === 'ARRAY' || u === 'STRUCT' || u === 'RANGE') && isOpen(k + 1)) {
    k += 2;
    const fields = [];
    while (S[k] && S[k].s !== '>') {
      let name = null;
      // `name TYPE` (a struct field) or just `TYPE`
      if (u === 'STRUCT' && S[k + 1] && (S[k + 1].t === 'ident' || S[k + 1].t === 'qident') && S[k + 1].s !== ',' && S[k + 1].s !== '>') {
        name = S[k].t === 'qident' ? S[k].s.slice(1, -1) : S[k].s;
        k++;
      }
      const inner = parseType(S, k, warn);
      if (inner.k === k) k++; // garbage: don't loop forever
      else k = inner.k;
      fields.push({ name, type: inner.text });
      if (S[k] && S[k].s === ',') k++;
    }
    k++; // '>'
    if (u === 'ARRAY') return { text: `${fields[0]?.type || 'VARCHAR'}[]`, k };
    if (u === 'RANGE') { warn('RANGE types are read as text'); return { text: 'VARCHAR', k }; }
    return { text: `STRUCT(${fields.map((f, i) => `${quoteId(f.name || `_field_${i + 1}`)} ${f.type}`).join(', ')})`, k };
  }
  let text = SCALAR_TYPES[u] || t.s;
  if (u === 'GEOGRAPHY') warn('GEOGRAPHY values are read as text');
  k++;
  // NUMERIC(10, 2), STRING(20): keep a decimal's precision, drop lengths.
  if (S[k] && S[k].s === '(') {
    const args = [];
    k++;
    while (S[k] && S[k].s !== ')') { if (S[k].s !== ',') args.push(S[k].s); k++; }
    k++;
    if ((u === 'NUMERIC' || u === 'DECIMAL' || u === 'BIGNUMERIC' || u === 'BIGDECIMAL') && args.length) {
      text = `DECIMAL(${Math.min(38, +args[0] || 38)},${Math.min(+args[1] || 0, 38)})`;
    }
  }
  return { text, k };
}

/** A BigQuery type name ("INT64", "ARRAY<STRING>") as DuckDB spells it. */
export function duckType(bqType) {
  const S = splitAngles(tokenize(String(bqType), 'bigquery').filter(sig));
  return parseType(S, 0, () => {}).text || 'VARCHAR';
}

// `>>` closes two type brackets at once: split it so the type parser sees both.
function splitAngles(S) {
  const out = [];
  for (const t of S) {
    if (t.s === '>>') out.push({ ...t, s: '>', b: t.a + 1 }, { ...t, s: '>', a: t.a + 1 });
    else out.push(t);
  }
  return out;
}

// ---- strings ----------------------------------------------------------------------

/** The value of a BigQuery string literal token (escapes decoded unless it is raw). */
export function stringValue(t) {
  const pre = t.pre || 0;
  const q = t.q || 1;
  const raw = /r/i.test(t.s.slice(0, pre));
  const body = t.s.slice(pre + q, t.err ? undefined : t.s.length - q);
  if (raw) return body;
  return body.replace(/\\(x[0-9a-fA-F]{2}|u[0-9a-fA-F]{4}|U[0-9a-fA-F]{8}|[0-7]{3}|[\s\S])/g, (m, e) => {
    if (e[0] === 'x' || e[0] === 'u' || e[0] === 'U') return String.fromCodePoint(parseInt(e.slice(1), 16));
    if (/^[0-7]{3}$/.test(e)) return String.fromCharCode(parseInt(e, 8));
    return { n: '\n', t: '\t', r: '\r', a: '\x07', b: '\b', f: '\f', v: '\v', 0: '\0' }[e] ?? e;
  });
}

// ---- the token walker ---------------------------------------------------------------

function makeCtx(T, src, extra = {}) {
  const n = T.length;
  const next = new Int32Array(n + 1).fill(n);
  const prev = new Int32Array(n + 1).fill(-1);
  for (let i = n - 1, nx = n; i >= 0; i--) { next[i] = nx; if (sig(T[i])) nx = i; }
  for (let i = 0, pv = -1; i < n; i++) { prev[i] = pv; if (sig(T[i])) pv = i; }
  const match = new Int32Array(n).fill(-1);
  const stack = [];
  for (let i = 0; i < n; i++) {
    const t = T[i];
    if (t.t !== 'punct') continue;
    if (t.s === '(' || t.s === '[') stack.push(i);
    else if (t.s === ')' || t.s === ']') {
      const o = stack.pop();
      if (o !== undefined) { match[o] = i; match[i] = o; }
    }
  }
  return {
    T, src, next, prev, match,
    replace: new Map(), // token start -> { to, text }
    rename: new Map(), // token index -> text
    vars: new Map(), // lower name -> name
    varRefs: new Set(), // token starts that read a variable
    params: {},
    warnings: new Set(),
    unnest: 0,
    ...extra,
    warn(msg) { this.warnings.add(msg); },
  };
}

const at = (ctx, i) => ctx.T[i];
const nx = (ctx, i) => ctx.next[i];
const pv = (ctx, i) => (i >= 0 ? ctx.prev[i] : -1);
const isP = (ctx, i, s) => ctx.T[i] && ctx.T[i].s === s && (ctx.T[i].t === 'punct' || ctx.T[i].t === 'op');
const isW = (ctx, i, u) => ctx.T[i] && ctx.T[i].t === 'ident' && ctx.T[i].u === u;

// The `>` that closes the `<` at i (ARRAY<…>, STRUCT<…>); counts `>>` as two.
function angleEnd(ctx, i) {
  let depth = 0;
  for (let k = i; k < ctx.T.length; k++) {
    const s = ctx.T[k].s;
    if (ctx.T[k].t !== 'op') continue;
    if (s === '<') depth++;
    else if (s === '>') depth--;
    else if (s === '>>') {
      depth -= 2;
      if (depth < 0) return k; // `STRUCT<a ARRAY<INT64>>` ends in the middle of `>>`
    }
    if (depth <= 0) return k;
  }
  return ctx.T.length - 1;
}

// Top-level comma-separated ranges [lo, hi) between open and close.
function argsOf(ctx, open, close) {
  const out = [];
  let lo = open + 1;
  for (let k = open + 1; k < close; k++) {
    const t = ctx.T[k];
    if (t.t === 'punct' && (t.s === '(' || t.s === '[') && ctx.match[k] > k) { k = ctx.match[k]; continue; }
    if (t.t === 'ident' && (t.u === 'ARRAY' || t.u === 'STRUCT') && isP(ctx, nx(ctx, k), '<')) { k = angleEnd(ctx, nx(ctx, k)); continue; }
    if (t.t === 'punct' && t.s === ',') { out.push([lo, k]); lo = k + 1; }
  }
  out.push([lo, close]);
  return out.filter(([a, b]) => sigIn(ctx, a, b).length || out.length > 1);
}

function sigIn(ctx, lo, hi) {
  const out = [];
  for (let k = lo; k < hi; k++) if (sig(ctx.T[k])) out.push(k);
  return out;
}

// Index of the first top-level sig token in [lo, hi) that is the word u.
function findWord(ctx, lo, hi, u) {
  for (let k = lo; k < hi; k++) {
    const t = ctx.T[k];
    if (t.t === 'punct' && (t.s === '(' || t.s === '[') && ctx.match[k] > k) { k = ctx.match[k]; continue; }
    if (t.t === 'ident' && t.u === u) return k;
  }
  return -1;
}

const out = (ctx, lo, hi) => emit(ctx, lo, hi).trim();

function emit(ctx, lo, hi) {
  const { T } = ctx;
  let s = '';
  for (let i = lo; i < hi; i++) {
    const t = T[i];
    const rep = ctx.replace.get(t.a);
    if (rep) {
      s += rep.text;
      while (i + 1 < hi && T[i + 1].a < rep.to) i++;
      continue;
    }
    if (ctx.rename.has(i)) { s += ctx.rename.get(i); continue; }
    if (t.t === 'ws') { s += t.s; continue; }
    if (t.t === 'comment') { s += t.s.startsWith('#') ? '--' + t.s.slice(1) : t.s; continue; }
    if (t.t === 'string') {
      if (/b/i.test(t.s.slice(0, t.pre || 0))) ctx.warn('Bytes literals (b\'…\') are read as text');
      s += sqlStr(stringValue(t));
      continue;
    }
    if (t.t === 'qident') { s += t.s.slice(1, -1).split('.').map(quoteId).join('.'); continue; }
    if (t.t === 'param') { s += paramValue(ctx, t); continue; }
    if (t.t === 'sysvar') { ctx.warn(`${t.s} isn't available in a test run; it reads as NULL`); s += 'NULL'; continue; }
    if (t.t === 'punct' && t.s === '[') {
      const r = subscript(ctx, i, hi);
      if (r) { s += r.text; i = r.end; continue; }
    }
    if (t.t === 'op' && t.s === '*' && isW(ctx, nx(ctx, i), 'EXCEPT') && isP(ctx, nx(ctx, nx(ctx, i)), '(')) {
      ctx.rename.set(nx(ctx, i), 'EXCLUDE');
    }
    if (t.t === 'op' && t.s === '^') ctx.warn('^ is XOR in BigQuery but power in DuckDB; use xor(a, b) if you meant XOR');
    if (t.t === 'ident') {
      const r = word(ctx, i, hi);
      if (r) { s += r.text; i = r.end; continue; }
    }
    s += t.s;
  }
  return s;
}

function paramValue(ctx, t) {
  const name = (t.name || t.s.slice(1)).toLowerCase();
  const v = ctx.params[name];
  if (v == null || !String(v).trim()) {
    ctx.warn(`@${t.name || t.s.slice(1)} has no test value, so it reads as NULL`);
    return 'NULL';
  }
  return `(${translateExpr(String(v), ctx)})`;
}

/** Translate a standalone BigQuery expression (a parameter value). */
export function translateExpr(text, parent) {
  const T = tokenize(text, 'bigquery');
  const ctx = makeCtx(T, text, parent ? { warnings: parent.warnings } : {});
  return out(ctx, 0, T.length);
}

// arr[OFFSET(i)], arr[ORDINAL(i)], arr[i] -> DuckDB's 1-based arr[k]
function subscript(ctx, i, hi) {
  const p = pv(ctx, i);
  const pt = at(ctx, p);
  if (!pt) return null;
  const isTarget = (pt.t === 'ident' && !RESERVED.has(pt.u)) || pt.t === 'qident' || (pt.t === 'punct' && (pt.s === ')' || pt.s === ']'));
  const close = ctx.match[i];
  if (!isTarget || close < 0 || close >= hi) return null;
  const inner = sigIn(ctx, i + 1, close);
  const f = at(ctx, inner[0]);
  if (f && f.t === 'ident' && /^(SAFE_)?(OFFSET|ORDINAL)$/.test(f.u) && isP(ctx, inner[1], '(') && ctx.match[inner[1]] === inner[inner.length - 1]) {
    const e = out(ctx, inner[1] + 1, ctx.match[inner[1]]);
    return { text: f.u.endsWith('ORDINAL') ? `[${e}]` : `[(${e}) + 1]`, end: close };
  }
  if (inner.length === 1 && f.t === 'string') return null; // json['key']
  return { text: `[(${out(ctx, i + 1, close)}) + 1]`, end: close };
}

// ---- words: functions, keywords, variables --------------------------------------------

function word(ctx, i, hi) {
  const t = at(ctx, i);
  const u = t.u;
  const n1 = nx(ctx, i);
  const p = pv(ctx, i);
  const afterDot = isP(ctx, p, '.');

  // SAFE.FN(...): DuckDB has no SAFE prefix; run the plain function.
  if (u === 'SAFE' && isP(ctx, n1, '.') && at(ctx, nx(ctx, n1))?.t === 'ident' && isP(ctx, nx(ctx, nx(ctx, n1)), '(')) {
    const f = nx(ctx, n1);
    const r = call(ctx, f, hi) || { text: emit(ctx, f, ctx.match[nx(ctx, f)] + 1), end: ctx.match[nx(ctx, f)] };
    return { text: r.text, end: r.end };
  }
  if (afterDot) {
    if (DUCK_RESERVED.has(u) || RESERVED.has(u)) return { text: quoteId(t.s), end: i };
    return null;
  }
  if (ctx.varRefs.has(t.a)) return { text: `getvariable(${sqlStr(ctx.vars.get(u.toLowerCase()) ?? t.s)})`, end: i };

  if (isP(ctx, n1, '(') && ctx.match[n1] > n1 && ctx.match[n1] < hi) {
    const r = call(ctx, i, hi);
    if (r) return r;
    return null;
  }
  if (u === 'INTERVAL') return interval(ctx, i, hi);
  if (u === 'CURRENT_DATE') return { text: 'current_date', end: i };
  if (u === 'CURRENT_TIMESTAMP' || u === 'CURRENT_DATETIME') return { text: 'CAST(current_timestamp AS TIMESTAMP)', end: i };
  if (u === 'CURRENT_TIME') return { text: 'CAST(current_timestamp AS TIME)', end: i };
  // NUMERIC '1.5', JSON '{}' -> casts (DATE / TIMESTAMP / DATETIME literals work as they are)
  if ((u === 'NUMERIC' || u === 'BIGNUMERIC' || u === 'BIGDECIMAL' || u === 'DECIMAL' || u === 'JSON') && at(ctx, n1)?.t === 'string') {
    return { text: `CAST(${sqlStr(stringValue(at(ctx, n1)))} AS ${SCALAR_TYPES[u]})`, end: n1 };
  }
  if (u === 'ARRAY' && isP(ctx, n1, '<')) {
    const end = angleEnd(ctx, n1);
    const type = typeText(ctx, i, end + 1);
    const n2 = nx(ctx, end);
    if (isP(ctx, n2, '[') && ctx.match[n2] > 0 && ctx.match[n2] < hi) {
      return { text: `CAST([${out(ctx, n2 + 1, ctx.match[n2])}] AS ${type})`, end: ctx.match[n2] };
    }
    return { text: type, end };
  }
  if (u === 'ARRAY' && isP(ctx, n1, '[') && ctx.match[n1] > 0 && ctx.match[n1] < hi) {
    return { text: `[${out(ctx, n1 + 1, ctx.match[n1])}]`, end: ctx.match[n1] };
  }
  if (u === 'STRUCT' && isP(ctx, n1, '<')) {
    const end = angleEnd(ctx, n1);
    const n2 = nx(ctx, end);
    if (isP(ctx, n2, '(') && ctx.match[n2] > 0 && ctx.match[n2] < hi) {
      // STRUCT<a INT64, b STRING>(1, 'x'): field names come from the type
      const S = splitAngles(sigIn(ctx, n1 + 1, end).map((k) => at(ctx, k)));
      const names = [];
      let depth = 0;
      let expectName = true;
      for (let k = 0; k < S.length; k++) {
        const s = S[k].s;
        if (s === '<') depth++;
        else if (s === '>') depth--;
        else if (s === ',' && depth === 0) expectName = true;
        else if (expectName && depth === 0) {
          names.push(S[k + 1] && S[k + 1].t === 'ident' && S[k + 1].s !== ',' ? S[k].s.replace(/`/g, '') : null);
          expectName = false;
        }
      }
      return { text: structPack(ctx, n2, names), end: ctx.match[n2] };
    }
    return { text: typeText(ctx, i, end + 1), end };
  }
  if (SCALAR_TYPES[u] && /^(INT64|FLOAT64|BIGNUMERIC|BIGDECIMAL)$/.test(u)) return { text: SCALAR_TYPES[u], end: i };
  if (u === 'UNNEST') return null;
  if (DUCK_RESERVED.has(u) && !isW(ctx, n1, 'KEY')) return { text: quoteId(t.s), end: i };
  if (u === 'AS' && (isW(ctx, n1, 'STRUCT') || isW(ctx, n1, 'VALUE')) && isW(ctx, p, 'SELECT')) {
    ctx.warn(`SELECT AS ${at(ctx, n1).u} isn't supported in test runs`);
  }
  return null;
}

function typeText(ctx, lo, hi) {
  const S = splitAngles(sigIn(ctx, lo, hi).map((k) => at(ctx, k)));
  return parseType(S, 0, (m) => ctx.warn(m)).text;
}

// INTERVAL n DAY -> INTERVAL (n) DAY (DuckDB wants an expression in parentheses)
function interval(ctx, i, hi) {
  const t1 = nx(ctx, i);
  if (at(ctx, t1)?.t === 'string') return null; // INTERVAL '1' DAY, INTERVAL '1-2' YEAR TO MONTH
  for (let k = t1; k < hi; k++) {
    const t = at(ctx, k);
    if (t.t === 'punct' && (t.s === '(' || t.s === '[') && ctx.match[k] > k) { k = ctx.match[k]; continue; }
    if (t.t === 'ident' && PARTS.has(t.u) && k > t1) {
      return { text: `INTERVAL (${out(ctx, t1, k)}) ${t.u}`, end: k };
    }
    if (t.t === 'punct' && (t.s === ',' || t.s === ')')) break;
  }
  return null;
}

// STRUCT(1 AS a, x) -> struct_pack(a := 1, x := x)
function structPack(ctx, open, names = []) {
  const args = argsOf(ctx, open, ctx.match[open]);
  const fields = args.map(([lo, hi], k) => {
    const S = sigIn(ctx, lo, hi);
    const asK = S.length > 2 && isW(ctx, S[S.length - 2], 'AS') ? S[S.length - 2] : -1;
    let name = names[k];
    let expr;
    if (asK >= 0) {
      name ??= at(ctx, S[S.length - 1]).s.replace(/`/g, '');
      expr = out(ctx, lo, asK);
    } else {
      expr = out(ctx, lo, hi);
      const last = at(ctx, S[S.length - 1]);
      if (!name && last && (last.t === 'ident' || last.t === 'qident') && S.every((x, j) => (j % 2 ? isP(ctx, x, '.') : at(ctx, x).t === 'ident' || at(ctx, x).t === 'qident'))) {
        name = last.s.replace(/`/g, '');
      }
    }
    return `${quoteId(name || `_field_${k + 1}`)} := ${expr}`;
  });
  return `struct_pack(${fields.join(', ')})`;
}

// A date part argument: DAY, WEEK(MONDAY), ISOWEEK...
function partOf(ctx, [lo, hi]) {
  const S = sigIn(ctx, lo, hi);
  const u = at(ctx, S[0])?.u || '';
  const day = S.length >= 3 && isP(ctx, S[1], '(') ? at(ctx, S[2])?.u : null;
  return { u, day };
}

function datePartName(ctx, u) {
  if (u === 'ISOWEEK') return 'week';
  if (u === 'WEEK') { ctx.warn('Weeks start on Monday in DuckDB, Sunday in BigQuery: WEEK results can differ by a day'); return 'week'; }
  if (u === 'DAYOFWEEK') return 'dow';
  if (u === 'DAYOFYEAR') return 'doy';
  return u.toLowerCase();
}

// date_trunc that respects BigQuery's WEEK (Sunday) / WEEK(<day>) starts.
function truncExpr(ctx, x, part) {
  if (part.u === 'WEEK' || part.u === 'ISOWEEK') {
    const k = part.u === 'ISOWEEK' ? 0 : WEEKDAYS.indexOf(part.day || 'SUNDAY');
    if (k <= 0) return `date_trunc('week', ${x})`;
    return `(date_trunc('week', ${x} - INTERVAL ${k} DAY) + INTERVAL ${k} DAY)`;
  }
  if (part.u === 'ISOYEAR') ctx.warn('ISOYEAR truncation is approximated with YEAR');
  return `date_trunc(${sqlStr(part.u === 'ISOYEAR' ? 'year' : part.u.toLowerCase())}, ${x})`;
}

// A format string for strftime / strptime, with the BigQuery-only elements expanded.
function fmtArg(ctx, [lo, hi]) {
  const S = sigIn(ctx, lo, hi);
  if (S.length !== 1 || at(ctx, S[0]).t !== 'string') return out(ctx, lo, hi);
  let f = stringValue(at(ctx, S[0]));
  f = f.replace(/%F/g, '%Y-%m-%d').replace(/%T/g, '%H:%M:%S').replace(/%R/g, '%H:%M').replace(/%D/g, '%m/%d/%y')
    .replace(/%E4Y/g, '%Y').replace(/%E(\d)S/g, '%S').replace(/%E\*S/g, '%S.%f').replace(/%e/g, '%-d').replace(/%k/g, '%-H')
    .replace(/%P/g, '%p').replace(/%h/g, '%b');
  if (/%[QJCGgUVWuNnty]/.test(f.replace(/%[ymdy]/g, ''))) ctx.warn(`Some format elements in ${sqlStr(f)} may not be supported by DuckDB`);
  return sqlStr(f);
}

function regexGroup(ctx, [lo, hi]) {
  const S = sigIn(ctx, lo, hi);
  if (S.length !== 1 || at(ctx, S[0]).t !== 'string') return 0;
  return /(^|[^\\])\((?!\?)/.test(stringValue(at(ctx, S[0]))) ? 1 : 0;
}

const tzWarn = (ctx) => ctx.warn('Time zone arguments are ignored: test runs treat every timestamp as UTC');

// Aggregate modifiers BigQuery allows inside the parentheses.
function aggParts(ctx, open, close) {
  const ignore = findWord(ctx, open + 1, close, 'IGNORE');
  const respect = findWord(ctx, open + 1, close, 'RESPECT');
  const limit = findWord(ctx, open + 1, close, 'LIMIT');
  const cut = [ignore, respect, limit].filter((k) => k >= 0).sort((a, b) => a - b);
  const order = findWord(ctx, open + 1, close, 'ORDER');
  const args = argsOf(ctx, open, Math.min(close, ...[order, ...cut].filter((k) => k >= 0)));
  const segs = [];
  let lo = open + 1;
  for (const k of cut) {
    segs.push(emit(ctx, lo, k));
    lo = nx(ctx, k) + 1; // skip IGNORE NULLS / RESPECT NULLS
    if (k === limit) { lo = nx(ctx, nx(ctx, k)) + 1; }
  }
  segs.push(emit(ctx, lo, close));
  const limitN = limit >= 0 ? at(ctx, nx(ctx, limit))?.s : null;
  return { inner: segs.join(' ').replace(/\s+\)/g, ')').trim(), ignoreNulls: ignore >= 0, first: args[0] ? out(ctx, ...args[0]) : '', limitN };
}

// Function calls BigQuery and DuckDB spell differently. Each returns the DuckDB text
// for name(...) or null to leave the call as it is (arguments still get translated).
const RENAME = {
  COUNTIF: 'count_if', LOGICAL_AND: 'bool_and', LOGICAL_OR: 'bool_or', ARRAY_LENGTH: 'len', ARRAY_REVERSE: 'list_reverse',
  REGEXP_CONTAINS: 'regexp_matches', RAND: 'random', IS_NAN: 'isnan', IS_INF: 'isinf', BYTE_LENGTH: 'strlen',
  FORMAT: 'printf', TO_JSON: 'to_json', CHAR_LENGTH: 'length', CHARACTER_LENGTH: 'length', ARRAY_TO_STRING: 'array_to_string',
};

function call(ctx, i, hi) {
  const u = at(ctx, i).u;
  const open = nx(ctx, i);
  const close = ctx.match[open];
  if (close < 0 || close >= hi) return null;
  const args = argsOf(ctx, open, close);
  const A = (k) => (args[k] ? out(ctx, ...args[k]) : '');
  const done = (text) => ({ text, end: close });

  if (RENAME[u]) return done(`${RENAME[u]}(${out(ctx, open + 1, close)})`);
  switch (u) {
    case 'CAST':
    case 'SAFE_CAST': {
      const as = findWord(ctx, open + 1, close, 'AS');
      if (as < 0) return null;
      const fmt = findWord(ctx, as + 1, close, 'FORMAT');
      if (fmt >= 0) ctx.warn('CAST … FORMAT is ignored in test runs');
      return done(`${u === 'CAST' ? 'CAST' : 'TRY_CAST'}(${out(ctx, open + 1, as)} AS ${typeText(ctx, as + 1, fmt >= 0 ? fmt : close)})`);
    }
    case 'EXTRACT': {
      const from = findWord(ctx, open + 1, close, 'FROM');
      if (from < 0) return null;
      const part = partOf(ctx, [open + 1, from]);
      const atTz = findWord(ctx, from + 1, close, 'AT');
      if (atTz >= 0) tzWarn(ctx);
      const x = out(ctx, from + 1, atTz >= 0 ? atTz : close);
      if (part.u === 'DATE') return done(`CAST(${x} AS DATE)`);
      if (part.u === 'TIME') return done(`CAST(${x} AS TIME)`);
      if (part.u === 'DATETIME') return done(`CAST(${x} AS TIMESTAMP)`);
      if (part.u === 'DAYOFWEEK') return done(`(extract(dow FROM ${x}) + 1)`);
      if (part.u === 'ISOYEAR') return done(`extract(isoyear FROM ${x})`);
      return done(`extract(${datePartName(ctx, part.u)} FROM ${x})`);
    }
    case 'DATE':
      if (args.length === 3) return done(`make_date(${A(0)}, ${A(1)}, ${A(2)})`);
      if (args.length === 2) tzWarn(ctx);
      return args.length ? done(`CAST(${A(0)} AS DATE)`) : null;
    case 'DATETIME':
      if (args.length === 6) return done(`make_timestamp(${[0, 1, 2, 3, 4, 5].map(A).join(', ')})`);
      if (args.length === 2) {
        const S = sigIn(ctx, ...args[1]);
        if (S.length === 1 && at(ctx, S[0]).t === 'string') { tzWarn(ctx); return done(`CAST(${A(0)} AS TIMESTAMP)`); }
        return done(`(CAST(${A(0)} AS DATE) + CAST(${A(1)} AS TIME))`);
      }
      return args.length ? done(`CAST(${A(0)} AS TIMESTAMP)`) : null;
    case 'TIMESTAMP':
      if (args.length === 2) tzWarn(ctx);
      return args.length ? done(`CAST(${A(0)} AS TIMESTAMP)`) : null;
    case 'TIME':
      if (args.length === 3) return done(`make_time(${A(0)}, ${A(1)}, ${A(2)})`);
      return args.length ? done(`CAST(${A(0)} AS TIME)`) : null;
    case 'CURRENT_DATE':
      if (args.length) tzWarn(ctx);
      return done('current_date');
    case 'CURRENT_TIMESTAMP':
    case 'CURRENT_DATETIME':
      if (args.length) tzWarn(ctx);
      return done('CAST(current_timestamp AS TIMESTAMP)');
    case 'CURRENT_TIME':
      return done('CAST(current_timestamp AS TIME)');
    case 'DATE_ADD':
    case 'DATE_SUB':
      return done(`CAST(CAST(${A(0)} AS DATE) ${u === 'DATE_ADD' ? '+' : '-'} ${A(1)} AS DATE)`);
    case 'DATETIME_ADD':
    case 'DATETIME_SUB':
    case 'TIMESTAMP_ADD':
    case 'TIMESTAMP_SUB':
      return done(`(CAST(${A(0)} AS TIMESTAMP) ${u.endsWith('ADD') ? '+' : '-'} ${A(1)})`);
    case 'TIME_ADD':
    case 'TIME_SUB':
      return done(`(CAST(${A(0)} AS TIME) ${u.endsWith('ADD') ? '+' : '-'} ${A(1)})`);
    case 'DATE_DIFF':
    case 'DATETIME_DIFF':
    case 'TIMESTAMP_DIFF':
    case 'TIME_DIFF': {
      const part = partOf(ctx, args[2] || [close, close]);
      const fn = u === 'DATE_DIFF' || u === 'DATETIME_DIFF' ? 'date_diff' : 'date_sub';
      const cast = u === 'DATE_DIFF' ? 'DATE' : u === 'TIME_DIFF' ? 'TIME' : 'TIMESTAMP';
      return done(`${fn}(${sqlStr(datePartName(ctx, part.u || 'DAY'))}, CAST(${A(1)} AS ${cast}), CAST(${A(0)} AS ${cast}))`);
    }
    case 'DATE_TRUNC':
      return done(`CAST(${truncExpr(ctx, `CAST(${A(0)} AS DATE)`, partOf(ctx, args[1] || [close, close]))} AS DATE)`);
    case 'DATETIME_TRUNC':
    case 'TIMESTAMP_TRUNC':
      if (args.length > 2) tzWarn(ctx);
      return done(`CAST(${truncExpr(ctx, `CAST(${A(0)} AS TIMESTAMP)`, partOf(ctx, args[1] || [close, close]))} AS TIMESTAMP)`);
    case 'TIME_TRUNC':
      return done(`CAST(${truncExpr(ctx, `(DATE '1970-01-01' + CAST(${A(0)} AS TIME))`, partOf(ctx, args[1] || [close, close]))} AS TIME)`);
    case 'LAST_DAY': {
      const part = args[1] ? partOf(ctx, args[1]) : { u: 'MONTH' };
      if (part.u === 'MONTH') return done(`last_day(CAST(${A(0)} AS DATE))`);
      const unit = part.u === 'WEEK' || part.u === 'ISOWEEK' ? 'WEEK' : part.u;
      return done(`CAST(${truncExpr(ctx, `CAST(${A(0)} AS DATE)`, part)} + INTERVAL 1 ${unit} - INTERVAL 1 DAY AS DATE)`);
    }
    case 'FORMAT_DATE':
      return done(`strftime(CAST(${A(1)} AS DATE), ${fmtArg(ctx, args[0])})`);
    case 'FORMAT_DATETIME':
    case 'FORMAT_TIMESTAMP':
      if (args.length > 2) tzWarn(ctx);
      return done(`strftime(CAST(${A(1)} AS TIMESTAMP), ${fmtArg(ctx, args[0])})`);
    case 'FORMAT_TIME':
      return done(`strftime(DATE '1970-01-01' + CAST(${A(1)} AS TIME), ${fmtArg(ctx, args[0])})`);
    case 'PARSE_DATE':
      return done(`CAST(strptime(${A(1)}, ${fmtArg(ctx, args[0])}) AS DATE)`);
    case 'PARSE_DATETIME':
    case 'PARSE_TIMESTAMP':
      if (args.length > 2) tzWarn(ctx);
      return done(`CAST(strptime(${A(1)}, ${fmtArg(ctx, args[0])}) AS TIMESTAMP)`);
    case 'UNIX_SECONDS': return done(`CAST(epoch(CAST(${A(0)} AS TIMESTAMP)) AS BIGINT)`);
    case 'UNIX_MILLIS': return done(`epoch_ms(CAST(${A(0)} AS TIMESTAMP))`);
    case 'UNIX_MICROS': return done(`epoch_us(CAST(${A(0)} AS TIMESTAMP))`);
    case 'UNIX_DATE': return done(`date_diff('day', DATE '1970-01-01', CAST(${A(0)} AS DATE))`);
    case 'TIMESTAMP_SECONDS': return done(`make_timestamp(CAST(${A(0)} AS BIGINT) * 1000000)`);
    case 'TIMESTAMP_MILLIS': return done(`make_timestamp(CAST(${A(0)} AS BIGINT) * 1000)`);
    case 'TIMESTAMP_MICROS': return done(`make_timestamp(CAST(${A(0)} AS BIGINT))`);
    case 'DATE_FROM_UNIX_DATE': return done(`CAST(DATE '1970-01-01' + INTERVAL (${A(0)}) DAY AS DATE)`);
    case 'GENERATE_ARRAY': return done(`generate_series(${args.map((_, k) => A(k)).join(', ')})`);
    case 'GENERATE_DATE_ARRAY':
      return done(`CAST(generate_series(CAST(${A(0)} AS DATE), CAST(${A(1)} AS DATE), ${args[2] ? A(2) : 'INTERVAL 1 DAY'}) AS DATE[])`);
    case 'GENERATE_TIMESTAMP_ARRAY':
      return done(`generate_series(CAST(${A(0)} AS TIMESTAMP), CAST(${A(1)} AS TIMESTAMP), ${A(2)})`);
    case 'SAFE_DIVIDE': return done(`(CASE WHEN (${A(1)}) = 0 THEN NULL ELSE (${A(0)}) / (${A(1)}) END)`);
    case 'IEEE_DIVIDE': return done(`((${A(0)}) / (${A(1)}))`);
    case 'DIV': return done(`((${A(0)}) // (${A(1)}))`);
    case 'SAFE_ADD': return done(`((${A(0)}) + (${A(1)}))`);
    case 'SAFE_SUBTRACT': return done(`((${A(0)}) - (${A(1)}))`);
    case 'SAFE_MULTIPLY': return done(`((${A(0)}) * (${A(1)}))`);
    case 'SAFE_NEGATE': return done(`(-(${A(0)}))`);
    case 'LOG': return done(args.length > 1 ? `log(${A(1)}, ${A(0)})` : `ln(${A(0)})`);
    case 'GENERATE_UUID': return done('CAST(uuid() AS VARCHAR)');
    case 'FARM_FINGERPRINT':
      ctx.warn('FARM_FINGERPRINT gives different numbers in test runs (DuckDB hash)');
      return done(`CAST(hash(${A(0)}) >> 1 AS BIGINT)`);
    case 'SESSION_USER': return done("'test-user@example.com'");
    case 'SPLIT': return done(`string_split(${A(0)}, ${args[1] ? A(1) : "','"})`);
    case 'CONCAT': return done(`(${args.map((_, k) => A(k)).join(' || ')})`);
    case 'CONTAINS_SUBSTR': return done(`contains(lower(CAST(${A(0)} AS VARCHAR)), lower(${A(1)}))`);
    case 'REGEXP_EXTRACT':
    case 'REGEXP_SUBSTR': {
      if (args.length > 2) ctx.warn(`${u} position / occurrence arguments are ignored in test runs`);
      const g = regexGroup(ctx, args[1] || [close, close]);
      return done(`(CASE WHEN regexp_matches(${A(0)}, ${A(1)}) THEN regexp_extract(${A(0)}, ${A(1)}, ${g}) END)`);
    }
    case 'REGEXP_EXTRACT_ALL': return done(`regexp_extract_all(${A(0)}, ${A(1)}, ${regexGroup(ctx, args[1] || [close, close])})`);
    case 'REGEXP_REPLACE': return done(`regexp_replace(${A(0)}, ${A(1)}, ${A(2)}, 'g')`);
    case 'TO_JSON_STRING': return done(`CAST(to_json(${A(0)}) AS VARCHAR)`);
    case 'PARSE_JSON': return done(`CAST(${A(0)} AS JSON)`);
    case 'JSON_EXTRACT_SCALAR':
    case 'JSON_VALUE': return done(`json_extract_string(${A(0)}, ${args[1] ? A(1) : "'$'"})`);
    case 'JSON_EXTRACT':
    case 'JSON_QUERY': return done(`json_extract(${A(0)}, ${args[1] ? A(1) : "'$'"})`);
    case 'JSON_EXTRACT_ARRAY':
    case 'JSON_QUERY_ARRAY': return done(`CAST(json_extract(${A(0)}, ${args[1] ? A(1) : "'$'"}) AS JSON[])`);
    case 'JSON_EXTRACT_STRING_ARRAY':
    case 'JSON_VALUE_ARRAY': return done(`CAST(json_extract(${A(0)}, ${args[1] ? A(1) : "'$'"}) AS VARCHAR[])`);
    case 'ARRAY_CONCAT': {
      let s = A(0);
      for (let k = 1; k < args.length; k++) s = `list_concat(${s}, ${A(k)})`;
      return done(s);
    }
    case 'ARRAY_AGG':
    case 'STRING_AGG': {
      const ag = aggParts(ctx, open, close);
      let s = `${u.toLowerCase()}(${ag.inner})`;
      if (ag.ignoreNulls) s += ` FILTER (WHERE (${ag.first}) IS NOT NULL)`;
      if (ag.limitN && u === 'ARRAY_AGG') s = `list_slice(${s}, 1, ${ag.limitN})`;
      return done(s);
    }
    case 'APPROX_QUANTILES': {
      const S = sigIn(ctx, ...(args[1] || [close, close]));
      const n = S.length === 1 && at(ctx, S[0]).t === 'number' ? Math.min(1000, Math.max(1, parseInt(at(ctx, S[0]).s, 10))) : 0;
      if (!n) return null;
      const qs = Array.from({ length: n + 1 }, (_, k) => +(k / n).toFixed(6));
      return done(`quantile_disc(${A(0)}, [${qs.join(', ')}])`);
    }
    case 'PERCENTILE_CONT':
    case 'PERCENTILE_DISC': {
      const ag = aggParts(ctx, open, close);
      return done(`${u === 'PERCENTILE_CONT' ? 'quantile_cont' : 'quantile_disc'}(${ag.inner})`);
    }
    case 'STRUCT': return done(structPack(ctx, open));
    case 'UNNEST': return unnest(ctx, i, open, close, hi);
    case 'STRING':
      return args.length ? done(`CAST(${A(0)} AS VARCHAR)`) : null;
    case 'INT64': return done(`CAST(${A(0)} AS BIGINT)`);
    case 'FLOAT64': return done(`CAST(${A(0)} AS DOUBLE)`);
    case 'BOOL': return done(`CAST(${A(0)} AS BOOLEAN)`);
    default:
      return null;
  }
}

// UNNEST(arr) [AS] x [WITH OFFSET [AS] i]  and  x IN UNNEST(arr)
function unnest(ctx, i, open, close, hi) {
  const arr = out(ctx, open + 1, close);
  const p = pv(ctx, i);
  if (isW(ctx, p, 'IN')) return { text: `(SELECT unnest(${arr}))`, end: close };
  let k = nx(ctx, close);
  let alias = null;
  let end = close;
  const aliasTok = (x) => at(ctx, x) && (at(ctx, x).t === 'qident' || (at(ctx, x).t === 'ident' && !RESERVED.has(at(ctx, x).u) && !CONTROL.has(at(ctx, x).u)));
  if (isW(ctx, k, 'AS') && aliasTok(nx(ctx, k))) { alias = at(ctx, nx(ctx, k)).s.replace(/`/g, ''); end = nx(ctx, k); }
  else if (aliasTok(k) && !isW(ctx, k, 'WITH')) { alias = at(ctx, k).s.replace(/`/g, ''); end = k; }
  let offset = null;
  k = nx(ctx, end);
  if (isW(ctx, k, 'WITH') && isW(ctx, nx(ctx, k), 'OFFSET')) {
    end = nx(ctx, k);
    offset = 'offset';
    const a1 = nx(ctx, end);
    if (isW(ctx, a1, 'AS') && aliasTok(nx(ctx, a1))) { offset = at(ctx, nx(ctx, a1)).s.replace(/`/g, ''); end = nx(ctx, a1); }
    else if (aliasTok(a1)) { offset = at(ctx, a1).s.replace(/`/g, ''); end = a1; }
  }
  if (end >= hi) return null;
  const n = ++ctx.unnest;
  const lateral = isP(ctx, p, ',') || isW(ctx, p, 'JOIN') ? 'LATERAL ' : '';
  if (offset) {
    const v = quoteId(alias || '_value');
    return { text: `${lateral}(SELECT unnest(${arr}) AS ${v}, generate_subscripts(${arr}, 1) - 1 AS ${quoteId(offset)}) AS _u${n}`, end };
  }
  if (alias) return { text: `unnest(${arr}) AS _u${n}(${quoteId(alias)})`, end };
  // No alias: BigQuery exposes a struct's fields as columns.
  return { text: `${lateral}(SELECT unnest(${arr}, recursive := true)) AS _u${n}`, end };
}

// ---- statements ---------------------------------------------------------------------

function stmtRange(ctx, st) {
  const { T } = ctx;
  let lo = 0;
  while (lo < T.length && T[lo].a < st.from) lo++;
  let hi = lo;
  while (hi < T.length && T[hi].b <= st.to) hi++;
  // drop a trailing `;`
  let last = pv(ctx, hi);
  if (last >= lo && isP(ctx, last, ';')) hi = last;
  return [lo, hi];
}

const lineOf = (src, pos) => src.slice(0, pos).split('\n').length;

function translateStatement(ctx, st) {
  const [lo, hi] = stmtRange(ctx, st);
  const S = sigIn(ctx, lo, hi);
  const first = at(ctx, S[0]);
  const base = { from: st.from, to: st.to, line: lineOf(ctx.src, st.from) };
  if (!first) return [];
  const u = first.u || first.s;

  if (u === 'DECLARE') {
    const names = [];
    let k = 1;
    while (S[k] !== undefined && at(ctx, S[k]).t === 'ident') {
      names.push(at(ctx, S[k]).s);
      if (isP(ctx, S[k + 1], ',')) k += 2;
      else { k++; break; }
    }
    const def = findWord(ctx, lo, hi, 'DEFAULT');
    const typeEnd = def >= 0 ? def : hi;
    const typeLo = S[k] !== undefined && S[k] < typeEnd ? S[k] : typeEnd;
    const type = typeLo < typeEnd ? typeText(ctx, typeLo, typeEnd) : '';
    const value = def >= 0 ? out(ctx, def + 1, hi) : 'NULL';
    const expr = type ? `CAST((${value}) AS ${type})` : `(${value})`;
    return names.map((nm) => ({ ...base, kind: 'exec', sql: `SET VARIABLE ${quoteId(nm.toLowerCase())} = ${expr}` }));
  }
  if (u === 'SET' && at(ctx, S[1])?.t === 'ident' && isP(ctx, S[2], '=')) {
    return [{ ...base, kind: 'exec', sql: `SET VARIABLE ${quoteId(at(ctx, S[1]).s.toLowerCase())} = (${out(ctx, S[2] + 1, hi)})` }];
  }
  if (u === 'SET') return [{ ...base, kind: 'error', error: 'SET (a, b) = … isn\'t supported in test runs: set each variable on its own' }];

  const fn = findWord(ctx, lo, hi, 'FUNCTION');
  if (u === 'CREATE' && fn >= 0 && fn <= (S[4] ?? hi)) {
    if (findWord(ctx, lo, hi, 'LANGUAGE') >= 0) return [{ ...base, kind: 'error', error: 'JavaScript functions (LANGUAGE js) can\'t run in test runs' }];
    const nameK = nx(ctx, fn);
    let k = nameK;
    let name = at(ctx, k).s;
    while (isP(ctx, nx(ctx, k), '.')) { k = nx(ctx, nx(ctx, k)); name = at(ctx, k).s; }
    const open = nx(ctx, k);
    if (!isP(ctx, open, '(')) return [{ ...base, kind: 'error', error: 'Couldn\'t read this function definition' }];
    const close = ctx.match[open];
    const params = argsOf(ctx, open, close).map(([a, b]) => at(ctx, sigIn(ctx, a, b)[0])?.s).filter(Boolean);
    const as = findWord(ctx, close + 1, hi, 'AS');
    if (as < 0) return [{ ...base, kind: 'error', error: 'Couldn\'t read this function definition' }];
    const body = out(ctx, as + 1, hi);
    return [{ ...base, kind: 'exec', sql: `CREATE OR REPLACE TEMP MACRO ${quoteId(name.replace(/`/g, ''))}(${params.map((p) => quoteId(p.replace(/`/g, ''))).join(', ')}) AS ${body}` }];
  }

  if (CONTROL.has(u) && !(u === 'BEGIN' && isW(ctx, S[1], 'TRANSACTION'))) {
    return [{ ...base, kind: 'error', error: `Scripting (${u} …) isn't supported in test runs: run the plain statements` }];
  }
  if (u === 'BEGIN' || u === 'COMMIT' || u === 'ROLLBACK' || u === 'ASSERT' || u === 'EXPORT') {
    if (u === 'ASSERT') ctx.warn('ASSERT statements are skipped in test runs');
    return [{ ...base, kind: 'skip', sql: '' }];
  }

  // CREATE TABLE … PARTITION BY / CLUSTER BY / OPTIONS(…) AS: DuckDB has no such clauses.
  if (u === 'CREATE') {
    const as = findWord(ctx, lo, hi, 'AS');
    const stop = as >= 0 ? as : hi;
    for (const w of ['PARTITION', 'CLUSTER', 'OPTIONS']) {
      const k = findWord(ctx, lo, stop, w);
      if (k < 0) continue;
      let end = k;
      if (w === 'OPTIONS') end = ctx.match[nx(ctx, k)] ?? k;
      else {
        end = nx(ctx, nx(ctx, k)); // PARTITION BY <expr>
        while (end < stop) {
          const nn = nx(ctx, end);
          if (nn >= stop || ['PARTITION', 'CLUSTER', 'OPTIONS', 'AS'].includes(at(ctx, nn)?.u)) break;
          end = nn;
        }
        if (isP(ctx, end, '(') && ctx.match[end] > end) end = ctx.match[end];
      }
      for (let x = k; x <= end && x < stop; x++) if (sig(at(ctx, x))) ctx.rename.set(x, '');
    }
  }

  const query = u === 'SELECT' || u === 'WITH' || u === '(' || u === 'VALUES' || u === 'FROM';
  return [{ ...base, kind: query ? 'query' : 'exec', sql: out(ctx, lo, hi) }];
}

// ---- the whole script -------------------------------------------------------------------

/**
 * Translate a BigQuery script for DuckDB.
 * Returns { statements: [{ kind: 'exec'|'query'|'skip'|'error', sql, line, from, to, error? }],
 *           tables: [{ key, full, label, local }], created: [...], warnings: [...], result: index | -1 }
 * `tables` are the source tables the script reads; their test data has to be loaded
 * under `local` before the statements run.
 */
export function translate(src, { params = {} } = {}) {
  const a = analyze(src, 'bigquery');
  const T = tokenize(src, 'bigquery'); // a.tokens leaves out whitespace and comments
  const ctx = makeCtx(T, src, { params: Object.fromEntries(Object.entries(params).map(([k, v]) => [k.toLowerCase(), v])) });

  // Local names: the table's own last name part, unless that clashes with a CTE or another table.
  const taken = new Set(a.graph.nodes.filter((n) => n.kind === 'cte').map((n) => n.label.toLowerCase()));
  const tables = [];
  const created = [];
  const byKey = new Map();
  for (const n of a.graph.nodes) {
    if (n.kind !== 'table' && n.kind !== 'created') continue;
    const full = (n.full || n.label).replace(/`/g, '');
    const key = tableKey(full);
    if (n.kind === 'table' && n.label.endsWith('()')) ctx.warn(`${full} is a table function; test runs can only read plain tables`);
    let entry = byKey.get(key);
    if (!entry) {
      const label = n.label.replace(/\(\)$/, '');
      let local = label;
      for (let k = 2; taken.has(local.toLowerCase()); k++) local = `${label}_${k}`;
      taken.add(local.toLowerCase());
      entry = { key, full, label, local, kind: n.kind };
      byKey.set(key, entry);
      (n.kind === 'table' ? tables : created).push(entry);
    }
    const ranges = [...n.refs, ...(n.kind === 'created' && n.def ? [n.def] : [])];
    for (const r of ranges) {
      const startTok = T.findIndex((t) => t.a === r.from);
      const p = startTok >= 0 ? pv(ctx, startTok) : -1;
      const inFrom = isW(ctx, p, 'FROM') || isW(ctx, p, 'JOIN') || isP(ctx, p, ',');
      let after = startTok;
      while (after + 1 < T.length && T[after + 1].a < r.to) after++;
      const nn = nx(ctx, after);
      const aliased = isW(ctx, nn, 'AS') || (at(ctx, nn) && (at(ctx, nn).t === 'qident' || (at(ctx, nn).t === 'ident' && !RESERVED.has(at(ctx, nn).u) && at(ctx, nn).u !== 'FOR')));
      const needAlias = inFrom && !aliased && entry.local.toLowerCase() !== entry.label.toLowerCase();
      ctx.replace.set(r.from, { to: r.to, text: quoteId(entry.local) + (needAlias ? ` AS ${quoteId(entry.label)}` : '') });
    }
  }

  for (const v of a.variables) {
    for (const nm of v.names) ctx.vars.set(nm.toLowerCase(), nm.toLowerCase());
    for (const r of v.refs) ctx.varRefs.add(r.from);
  }

  const statements = a.statements.flatMap((st) => translateStatement(ctx, st));
  let result = -1;
  for (let k = statements.length - 1; k >= 0; k--) if (statements[k].kind === 'query') { result = k; break; }
  if (result < 0 && created.length) {
    // A script that ends by writing a table: show what it wrote.
    const last = [...statements].reverse().find((s) => s.kind === 'exec' && /^\s*(CREATE|INSERT|MERGE|UPDATE|DELETE)/i.test(s.sql));
    const target = last && created.find((c) => last.sql.includes(quoteId(c.local))) || created[created.length - 1];
    statements.push({ kind: 'query', sql: `SELECT * FROM ${quoteId(target.local)}`, line: last?.line ?? 1, from: src.length, to: src.length, synthetic: true });
    result = statements.length - 1;
  }
  return { statements, tables, created, warnings: [...ctx.warnings], result };
}

/** The key test data is stored under: the table path without quotes, lower case. */
export const tableKey = (full) => String(full).replace(/`/g, '').toLowerCase();
