// Test tables for "Run on test data": small CSV / TSV text per source table,
// the size limits, the columns a query reads from each table, and starter rows
// that line up with the query's joins and filters.

import { RESERVED } from './analyzer.js';
import { resolveQualifier } from './symbols.js';
import { tableKey } from './bq2duck.js';

export const LIMITS = {
  tables: 20, // test tables per query
  rows: 1000, // data rows per table
  cols: 60, // columns per table
  chars: 200_000, // characters per table
  total: 1_500_000, // characters across all saved tables (they live in localStorage)
  resultRows: 1000, // rows shown in the results grid
};

// ---- CSV / TSV --------------------------------------------------------------------

/** Parse CSV or TSV (picked from the first line). Quotes may wrap commas, quotes ("") and new lines. */
export function parseDelimited(text) {
  const src = String(text ?? '').replace(/\r\n?/g, '\n');
  const firstLine = src.split('\n', 1)[0];
  const delim = firstLine.includes('\t') ? '\t' : ',';
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (quoted) {
      if (c === '"' && src[i + 1] === '"') { cell += '"'; i += 2; continue; }
      if (c === '"') { quoted = false; i++; continue; }
      cell += c;
      i++;
      continue;
    }
    if (c === '"' && cell === '') { quoted = true; i++; continue; }
    if (c === delim) { row.push(cell); cell = ''; i++; continue; }
    if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; i++; continue; }
    cell += c;
    i++;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  const nonEmpty = rows.filter((r) => r.some((c) => c.trim() !== ''));
  return { delim, rows: nonEmpty };
}

const HINT = /^\s*([^:]+?)\s*:\s*(.+?)\s*$/;

/**
 * Check one table's text against the limits. The header may carry types:
 * `id:INT64, created_at:TIMESTAMP, tags:ARRAY<STRING>`.
 * Returns { names, types: {name: bqType}, rows, cols, delim, error? }.
 */
export function inspectTable(text) {
  const t = String(text ?? '');
  if (!t.trim()) return { names: [], types: {}, rows: 0, cols: 0, delim: ',', empty: true };
  if (t.length > LIMITS.chars) return { names: [], types: {}, rows: 0, cols: 0, delim: ',', error: `Over ${Math.round(LIMITS.chars / 1000)}k characters: keep test tables small` };
  const { delim, rows } = parseDelimited(t);
  const header = rows[0] || [];
  const names = [];
  const types = {};
  for (const h of header) {
    const m = HINT.exec(h);
    // `a:b` with a type-looking right side is a hint; anything else is the name as written.
    if (m && /^[A-Za-z][A-Za-z0-9_<>, ()]*$/.test(m[2])) { names.push(m[1]); types[m[1]] = m[2]; } else names.push(h.trim());
  }
  const res = { names, types, rows: rows.length - 1, cols: names.length, delim };
  if (names.length > LIMITS.cols) res.error = `${names.length} columns: the limit is ${LIMITS.cols}`;
  else if (res.rows > LIMITS.rows) res.error = `${res.rows} rows: the limit is ${LIMITS.rows}`;
  else if (names.some((n) => !n)) res.error = 'A column in the header row has no name';
  else {
    const seen = new Set();
    const dup = names.find((n) => { const k = n.toLowerCase(); if (seen.has(k)) return true; seen.add(k); return false; });
    if (dup) res.error = `Column "${dup}" appears twice in the header`;
  }
  return res;
}

const csvCell = (v) => (/[",\n\t]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
export const csvLine = (cells, delim = ',') => cells.map(csvCell).join(delim);

/** The header line plus data lines with text appended (a new header if there was none). */
export function withColumns(text, cols) {
  const t = String(text ?? '');
  if (!t.trim()) return csvLine(cols) + '\n';
  const { delim } = parseDelimited(t);
  const lines = t.replace(/\r\n?/g, '\n').split('\n');
  const have = new Set(inspectTable(t).names.map((n) => n.toLowerCase()));
  const extra = cols.filter((c) => !have.has(c.toLowerCase()));
  if (!extra.length) return t;
  lines[0] = lines[0] + delim + extra.map(csvCell).join(delim);
  return lines.join('\n');
}

// ---- which columns does the query read from each table? ------------------------------

const NOT_COLUMNS = new Set(`DAY WEEK MONTH QUARTER YEAR HOUR MINUTE SECOND MILLISECOND MICROSECOND DAYOFWEEK
DAYOFYEAR ISOWEEK ISOYEAR DATE DATETIME TIMESTAMP TIME STRING INT64 FLOAT64 NUMERIC BIGNUMERIC DECIMAL BOOL BOOLEAN
BYTES JSON INTEGER FLOAT OFFSET ORDINAL SAFE_OFFSET SAFE_ORDINAL ZONE FIRST LAST VALUE KEY MONDAY TUESDAY WEDNESDAY
THURSDAY FRIDAY SATURDAY SUNDAY CURRENT_DATE CURRENT_TIMESTAMP CURRENT_DATETIME CURRENT_TIME ROW TYPE`.split(/\s+/));

const bare = (s) => String(s).replace(/[`"]/g, '');

/** Map tableKey -> [column names] that the query reads, in first-use order. */
export function queryColumns(a) {
  const T = a.tokens;
  const nodes = a.graph.nodes;
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const cols = new Map(); // nodeId -> Set
  const add = (id, c) => {
    if (!id || !c || c === '*') return;
    if (!cols.has(id)) cols.set(id, new Set());
    cols.get(id).add(c);
  };
  const isWord = (t) => t && (t.t === 'ident' || t.t === 'qident');

  // Qualified: u.country -> whatever `u` means at that spot.
  for (let i = 0; i < T.length - 2; i++) {
    const t = T[i];
    if (!isWord(t) || T[i + 1].s !== '.' || T[i - 1]?.s === '.' || !isWord(T[i + 2]) || T[i + 3]?.s === '(') continue;
    const hit = resolveQualifier(a, t.a, bare(t.s).toLowerCase());
    if (hit?.item.nodeId) add(hit.item.nodeId, bare(T[i + 2].s));
  }

  // Unqualified names in a step that reads a single table or CTE.
  const spansOf = (n) => (n.body ? [n.body] : n.spans || []);
  // index of the first token starting at or after pos
  const firstAt = (pos) => {
    let lo = 0;
    let hi = T.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (T[mid].a < pos) lo = mid + 1; else hi = mid; }
    return lo;
  };
  const tableTok = new Set();
  for (const n of nodes) {
    if (n.kind !== 'table' && n.kind !== 'created') continue;
    for (const r of n.refs) for (let i = firstAt(r.from); i < T.length && T[i].b <= r.to; i++) tableTok.add(T[i].a);
  }
  const cteNames = new Set(nodes.filter((n) => n.kind === 'cte').map((n) => n.label.toLowerCase()));
  const varNames = new Set(a.variables.flatMap((v) => v.names.map((x) => x.toLowerCase())));
  // The parenthesised span around an IN / EXISTS subquery's FROM item.
  const enclosing = (pos) => {
    let depth = 0;
    for (let i = firstAt(pos) - 1; i >= 0; i--) {
      const s = T[i].s;
      if (T[i].t !== 'punct') continue;
      if (s === ')') depth++;
      else if (s === '(' && depth-- === 0) {
        let d = 0;
        for (let j = i; j < T.length; j++) {
          if (T[j].t !== 'punct') continue;
          if (T[j].s === '(') d++;
          else if (T[j].s === ')' && --d === 0) return { from: T[i].a, to: T[j].b };
        }
        return null;
      }
    }
    return null;
  };
  const steps = [];
  for (const n of nodes) {
    const inlineSpans = [];
    for (const b of n.blocks || []) {
      if (!b.inline) continue;
      const sp = b[0] && enclosing(b[0].from);
      if (sp) { inlineSpans.push(sp); steps.push({ n, items: b, spans: [sp] }); }
    }
    steps.push({ n, items: (n.blocks || []).filter((b) => !b.inline).flat(), spans: spansOf(n), extra: inlineSpans });
  }
  for (const { n, items, spans, extra = [] } of steps) {
    const sources = items.filter((it) => it.nodeId);
    if (sources.length !== 1) continue;
    const src = byId.get(sources[0].nodeId);
    if (!src || (src.kind !== 'table' && src.kind !== 'cte' && src.kind !== 'created')) continue;
    const skip = new Set([...items.map((it) => (it.alias || '').toLowerCase()), ...items.map((it) => bare(it.name || '').split('.').pop().toLowerCase())]);
    // output names a step computes (SUM(x) AS total) are not input columns
    for (const it of n.shape?.items || []) {
      const single = it.y - it.x === 1 || (it.y - it.x === 3 && T[it.x + 1]?.s === '.');
      if (!single && it.alias) skip.add(it.alias.toLowerCase());
    }
    const others = [...nodes.filter((m) => m !== n).flatMap(spansOf), ...extra];
    for (const sp of spans) {
      // nested steps (subqueries, CTEs inside, IN subqueries) are read on their own
      const inner = others.filter((c) => c.from >= sp.from && c.to <= sp.to && (c.from !== sp.from || c.to !== sp.to));
      for (let i = firstAt(sp.from); i < T.length && T[i].b <= sp.to; i++) {
        const t = T[i];
        if (!isWord(t)) continue;
        if (inner.some((c) => t.a >= c.from && t.b <= c.to)) continue;
        const prev = T[i - 1];
        const next = T[i + 1];
        if (prev?.s === '.' || next?.s === '.' || next?.s === '(' || tableTok.has(t.a)) continue;
        if (prev && (prev.u === 'AS' || prev.s === ')' || (prev.t === 'ident' && !RESERVED.has(prev.u) && !NOT_COLUMNS.has(prev.u)))) continue;
        const name = bare(t.s);
        const k = name.toLowerCase();
        if (t.t === 'ident' && (RESERVED.has(t.u) || NOT_COLUMNS.has(t.u))) continue;
        if (skip.has(k) || cteNames.has(k) || varNames.has(k)) continue;
        add(src.id, name);
      }
    }
  }

  // SELECT * CTEs pass their columns through to the table they read.
  for (let pass = 0; pass < 4; pass++) {
    for (const n of nodes) {
      if (n.kind !== 'cte' || !n.shape?.star || !cols.has(n.id)) continue;
      const sources = (n.blocks || []).filter((b) => !b.inline).flat().filter((it) => it.nodeId);
      if (sources.length !== 1) continue;
      const computed = new Set((n.shape.items || []).filter((it) => it.alias && it.y - it.x > 1).map((it) => it.alias.toLowerCase()));
      for (const c of cols.get(n.id)) if (!computed.has(c.toLowerCase())) add(sources[0].nodeId, c);
    }
  }

  const outMap = new Map();
  for (const n of nodes) {
    if (n.kind !== 'table' || !cols.has(n.id)) continue;
    const seen = new Set();
    const list = [...cols.get(n.id)].filter((c) => { const k = c.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; });
    outMap.set(tableKey(n.full || n.label), list);
  }
  return outMap;
}

// ---- starter rows -------------------------------------------------------------------

const dayToIso = (day) => new Date(day * 86400000).toISOString().slice(0, 10);

/** Values the query compares columns with: { col -> { values: [], avoid: Set, day } }. */
export function columnHints(a) {
  const hints = new Map();
  const h = (col) => {
    const k = col.toLowerCase();
    if (!hints.has(k)) hints.set(k, { values: [], avoid: new Set(), day: null });
    return hints.get(k);
  };
  for (const lit of a.literals || []) {
    for (const o of lit.occ || []) {
      const m = /^(?:[\w`"]+\.)?([\w`"]+)\s*(NOT IN|IN|=|!=|<>|>=|>|<=|<|LIKE)/i.exec(o.label || '');
      if (!m) continue;
      const col = bare(m[1]);
      const op = m[2].toUpperCase();
      if (op === '=' || op === 'IN') { if (!h(col).values.includes(lit.value)) h(col).values.push(lit.value); }
      else if (op === '!=' || op === '<>' || op === 'NOT IN') h(col).avoid.add(lit.value);
    }
  }
  let firstDay = null;
  for (const st of a.dates?.steps || []) {
    for (const b of st.bounds || []) {
      if (b.day == null || !b.col) continue;
      const hint = h(b.col);
      const d = b.side === 'end' ? b.day - 2 : b.day;
      if (hint.day == null || (b.side !== 'end' && d > hint.day)) hint.day = d;
      if (firstDay == null || b.day < firstDay) firstDay = b.day;
    }
  }
  return { hints, firstDay };
}

function guess(col, r, { hints, firstDay }, idBase = 0) {
  const k = col.toLowerCase();
  const hint = hints.get(k);
  const baseDay = hint?.day ?? firstDay ?? Date.UTC(2024, 0, 15) / 86400000;
  const isTs = /(_at|_time|_ts|timestamp|datetime)$/.test(k) || k === 'ts';
  let v;
  if (hint?.values.length) v = hint.values[r % hint.values.length];
  else if (hint?.day != null || /(date|_dt|_day)$/.test(k) || k === 'dt' || k === 'day' || isTs) {
    const iso = dayToIso(baseDay + r);
    v = isTs ? `${iso} ${String(9 + r * 3).padStart(2, '0')}:00:00` : iso;
  } else if (/(^|_)id$|^id_/.test(k)) v = idBase + r + 1;
  else if (/^(is|has|was|can|should)_|_flag$|^flag/.test(k)) v = r < 2;
  else if (/amount|price|gmv|revenue|usd|cost|total|value|score|rate|pct|fee|sales|spend|balance|margin/.test(k)) v = [120.5, 80, 45.25][r];
  else if (/count|qty|quantity|^num_|^n_|orders$|items$|clicks|views/.test(k)) v = r + 1;
  else if (/country/.test(k)) v = ['SG', 'MY', 'PH'][r];
  else if (/email/.test(k)) v = `user${r + 1}@example.com`;
  else if (/(^|_)(status|state)$/.test(k)) v = 'active';
  else v = `${col}_${r + 1}`;
  if (hint?.avoid.has(String(v))) v = `${v}_other`;
  return v;
}

/**
 * `n` CSV lines of starter rows for these columns. Ids run 1, 2, 3 so joins line
 * up; a table the query only reads to exclude rows (NOT IN / NOT EXISTS) gets ids
 * from 101, so it doesn't filter every row out.
 */
export function starterRows(cols, a, n = 3, key = null) {
  const ctx = columnHints(a);
  const idBase = key && excludeOnly(a).has(key) ? 100 : 0;
  return Array.from({ length: n }, (_, r) => csvLine(cols.map((c) => guess(c, r, ctx, idBase))));
}

/** Tables the query reads only inside NOT IN / NOT EXISTS subqueries. */
export function excludeOnly(a) {
  const uses = new Map(); // tableKey -> { neg, other }
  const byId = new Map(a.graph.nodes.map((n) => [n.id, n]));
  for (const n of a.graph.nodes) {
    for (const b of n.blocks || []) {
      for (const it of b) {
        const t = it.nodeId && byId.get(it.nodeId);
        if (!t || t.kind !== 'table') continue;
        const key = tableKey(t.full || t.label);
        const u = uses.get(key) || { neg: 0, other: 0 };
        if (b.inline && /^NOT /.test(b.inline.kind)) u.neg++; else u.other++;
        uses.set(key, u);
      }
    }
  }
  return new Set([...uses].filter(([, u]) => u.neg && !u.other).map(([k]) => k));
}
