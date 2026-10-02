// Shared helpers describing what a CTE / subquery does ("shape" from the analyzer).

const SUBQUERY_COND = /\b(IN|EXISTS)\s*\(\s*(WITH|SELECT)\b/i;

// "in ProductBase" style phrase for an IN / EXISTS semi-join.
export function semiPhrase(x) {
  const col = x.col ? `${x.col} ` : '';
  switch (x.kind) {
    case 'IN': return { short: `in ${x.label}`, long: `keeps only rows whose ${col}is in ${x.label}` };
    case 'NOT IN': return { short: `not in ${x.label}`, long: `drops rows whose ${col}is in ${x.label}` };
    case 'EXISTS': return { short: `exists ${x.label}`, long: `keeps only rows with a match in ${x.label}` };
    default: return { short: `not exists ${x.label}`, long: `drops rows that have a match in ${x.label}` };
  }
}

const DAY_MS = 86400000;
export const fmtDay = (day) => new Date(day * DAY_MS).toISOString().slice(0, 10);

// "2024-01-01 → 03-31" (the end drops the year when it matches the start).
export function windowText(w) {
  const s = w.start ? fmtDay(w.start.day) : null;
  const e = w.end ? fmtDay(w.end.day) : null;
  if (s && e) return `${s} → ${e.slice(0, 4) === s.slice(0, 4) ? e.slice(5) : e}`;
  if (s) return `from ${s}`;
  if (e) return `until ${e}`;
  return '';
}

function srcText(b) {
  const src = b.src || {};
  const by = src.kind === 'literal' ? 'hardcoded' : src.kind === 'variable' ? `from ${src.name}` : src.kind === 'param' ? `from ${src.name}` : src.name || '';
  return `${b.colText} ${b.op} ${fmtDay(b.day)}${b.relative ? ' (relative to today)' : ''} · ${by}`;
}

export function dateTitle(d) {
  const lines = [];
  if (d.event.start || d.event.end) lines.push(`Date window: ${windowText(d.event)}`);
  if (d.partition.start || d.partition.end) lines.push(`Partition filter: ${windowText(d.partition)}`);
  for (const b of d.bounds) lines.push('  ' + srcText(b));
  if (d.mismatch.start || d.mismatch.end) lines.push('⚠ Differs from the other steps');
  if (d.mismatch.partition) lines.push('⚠ Partition filter is narrower than the date window');
  return lines.join('\n');
}

export const RANKERS = new Set(['ROW_NUMBER', 'RANK', 'DENSE_RANK']);
export const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

// A CTE/subquery reading exactly one input with no joins is a "sub table" of it.
export function soleSource(n) {
  const blocks = (n.blocks || []).filter((b) => !b.inline);
  if (blocks.length !== 1) return null;
  // A params CTE cross-joined in for its constants does not count as an input.
  const items = blocks[0].filter((it) => !it.params);
  return items.length === 1 && items[0].nodeId && items[0].joinType === 'FROM' ? items[0].nodeId : null;
}

// Windows that are not just the ROW_NUMBER behind a detected dedupe.
export function extraWindows(sh) {
  return sh.windows.filter((w) => !(sh.dedupe && RANKERS.has(w.fn) && w.partition === sh.dedupe.per));
}

const RANK_WHAT = {
  ROW_NUMBER: 'numbers rows 1, 2, 3…',
  RANK: 'ranks rows (ties share a rank, then skip)',
  DENSE_RANK: 'ranks rows (ties share a rank, no gaps)',
  PERCENT_RANK: 'percentile rank, 0 to 1',
  CUME_DIST: 'share of rows at or before this one',
};
const firstArg = (args) => args.split(',')[0].trim();
const nthArg = (args, n, dflt) => args.split(',')[n]?.trim() || dflt;
const ordinal = (n) => {
  if (!/^\d+$/.test(n)) return `${n}th`;
  const t = n % 100;
  const u = n % 10;
  return n + (t > 10 && t < 14 ? 'th' : u === 1 ? 'st' : u === 2 ? 'nd' : u === 3 ? 'rd' : 'th');
};

// What one window function computes, in plain words:
// { kind: 'rank' | 'running' | 'rolling' | 'total' | 'offset' | 'pick' | 'window',
//   label: short name ("running sum"), what: one line, notes: [gotchas] }
export function describeWindow(w) {
  const fn = w.fn;
  const f = fn.toLowerCase();
  const ordered = !!(w.orderKeys?.length || w.order);
  const frame = (w.frame || '').toUpperCase();
  const notes = [];
  if (RANK_WHAT[fn] || fn === 'NTILE') {
    if (!ordered) notes.push('No ORDER BY: which row gets which number is arbitrary.');
    const what = fn === 'NTILE' ? `splits rows into ${w.args || 'n'} equal buckets` : RANK_WHAT[fn];
    return { kind: 'rank', label: fn === 'ROW_NUMBER' ? 'row number' : fn === 'NTILE' ? `ntile ${w.args}` : f.replace('_', ' '), what, notes };
  }
  if (fn === 'LAG' || fn === 'LEAD') {
    const n = nthArg(w.args, 1, '1');
    const where = n === '1' ? (fn === 'LAG' ? 'the previous row' : 'the next row') : `${n} rows ${fn === 'LAG' ? 'back' : 'ahead'}`;
    if (!ordered) notes.push('No ORDER BY: "previous" and "next" are arbitrary.');
    return { kind: 'offset', label: fn === 'LAG' ? 'previous value' : 'next value', what: `${firstArg(w.args)} from ${where}`, notes };
  }
  if (fn === 'FIRST_VALUE' || fn === 'LAST_VALUE' || fn === 'NTH_VALUE') {
    const which = fn === 'FIRST_VALUE' ? 'first' : fn === 'LAST_VALUE' ? 'last' : ordinal(nthArg(w.args, 1, 'n'));
    if (fn === 'LAST_VALUE' && ordered && !frame) notes.push('Default frame ends at the current row, so this is the current row\'s value. Add ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING.');
    return { kind: 'pick', label: `${which} value`, what: `${which} ${firstArg(w.args)}`, notes };
  }
  const of = `${fn}(${w.args})`;
  const rows = frame.match(/^ROWS\s+(?:BETWEEN\s+)?(\d+)\s+PRECEDING(?:\s+AND\s+CURRENT\s+ROW)?$/);
  if (rows) return { kind: 'rolling', label: `rolling ${f}`, what: `${of} over this row and the ${rows[1]} before it`, notes };
  const whole = /UNBOUNDED\s+PRECEDING\s+AND\s+UNBOUNDED\s+FOLLOWING/.test(frame);
  if (!ordered || whole) {
    return w.partition
      ? { kind: 'total', label: `${f} per group`, what: `${of} of the whole group, on every row`, notes }
      : { kind: 'total', label: `${f} of all rows`, what: `${of} of all rows, on every row`, notes };
  }
  if (!frame || /^(ROWS|RANGE)\s+(BETWEEN\s+)?UNBOUNDED\s+PRECEDING(\s+AND\s+CURRENT\s+ROW)?$/.test(frame)) {
    return { kind: 'running', label: `running ${f}`, what: `${of} of all rows up to this one`, notes };
  }
  return { kind: 'window', label: `${f} over frame`, what: `${of} over ${w.frame}`, notes };
}

// One window function as a small card: kind + output column, what it computes,
// then the PARTITION BY ("per") and ORDER BY ("order", ↑ asc / ↓ desc) keys.
// Clicking it (data-from / data-to) selects the expression in the editor.
export function windowCard(w, esc) {
  const d = describeWindow(w);
  const code = (t) => `<code>${esc(t)}</code>`;
  const keys = (w.orderKeys || []).map((k) => code(k.text) + `<span class="win-dir" title="${k.desc ? 'descending: largest first' : 'ascending: smallest first'}">${k.desc ? '↓' : '↑'}</span>`);
  const spec = [
    ['per', w.partition ? code(w.partition) : '<span class="muted">all rows</span>'],
    keys.length ? ['order', keys.join(' ')] : null,
    w.frame && d.kind !== 'window' ? ['frame', code(w.frame)] : null,
  ].filter(Boolean);
  return `<div class="win k-${d.kind}" data-from="${w.from}" data-to="${w.to}" title="${esc(w.text || '')}\n\nClick to select it in the editor">
    <div class="win-head"><span class="win-kind">${esc(d.label)}</span>${w.alias ? `<span class="win-alias">→ ${esc(w.alias)}</span>` : ''}</div>
    <div class="win-what">${esc(d.what)}</div>
    ${spec.map(([k, v]) => `<div class="win-spec"><span class="wk">${k}</span><span>${v}</span></div>`).join('')}
    ${d.notes.map((t) => `<div class="win-note">⚠ ${esc(t)}</div>`).join('')}
  </div>`;
}

// What a scope does, as short chips: dedupe, filter, Σ group-by, window, ∪, distinct, limit.
// The title (hover) spells out the actual SQL.
export function shapeChips(sh) {
  const out = [];
  if (!sh) return out;
  if (sh.dedupe) {
    out.push({ cls: 'dedupe', text: `${sh.dedupe.latest ? 'latest' : 'first'} per ${clip(sh.dedupe.per, 20)}`,
      title: `Dedupe: keeps one row per ${sh.dedupe.per}${sh.dedupe.order ? ` (ROW_NUMBER ordered by ${sh.dedupe.order}, rn = 1)` : ''}` });
  }
  if (sh.dates) {
    const d = sh.dates;
    const warn = d.mismatch.start || d.mismatch.end || d.mismatch.partition;
    const text = d.event.start || d.event.end ? windowText(d.event) : `partition ${windowText(d.partition)}`;
    out.push({ cls: warn ? 'date warn' : 'date', text: (warn ? '⚠ ' : '') + text, title: dateTitle(d) });
  }
  for (const label of sh.usesParams || []) {
    out.push({ cls: 'semi', text: `uses ${label}`, title: `Reads constants from ${label} (a one-row CTE, cross-joined in). Its values are editable in the Variables panel.` });
  }
  for (const x of sh.semi || []) {
    const p = semiPhrase(x);
    out.push({ cls: 'semi', text: p.short, title: `Subquery filter: ${p.long}\n(WHERE ${x.col || '…'} ${x.kind} (SELECT … FROM ${x.label}))` });
  }
  // Conditions already shown as "in X" chips are not counted again.
  const plain = sh.filters.filter((f) => !(sh.semi?.length && SUBQUERY_COND.test(f)));
  if (plain.length) {
    out.push({ cls: 'filter', text: `filter ${plain.length}`,
      title: 'Rows are filtered by:\nWHERE ' + plain.join('\n  AND ') });
  }
  if (sh.groupBy.length) {
    out.push({ cls: 'agg', text: `Σ by ${clip(sh.groupBy.join(', '), 24)}`,
      title: `Aggregated: one row per ${sh.groupBy.join(', ')}${sh.aggregates.length ? '\nusing ' + sh.aggregates.join(', ') : ''}` });
  } else if (sh.aggregates.length) {
    out.push({ cls: 'agg', text: 'Σ total', title: `No GROUP BY: ${sh.aggregates.join(', ')} over all rows` });
  }
  if (sh.having.length) out.push({ cls: 'filter', text: `having ${sh.having.length}`, title: 'Groups are filtered by:\nHAVING ' + sh.having.join('\n  AND ') });
  const wins = extraWindows(sh);
  if (wins.length) {
    const ds = wins.map(describeWindow);
    const warn = ds.some((d) => d.notes.length);
    out.push({ cls: warn ? 'window warn' : 'window', text: (warn ? '⚠ ' : '') + (wins.length > 1 ? `window ${wins.length}` : ds[0].label),
      title: wins.map((w, i) => `${w.alias ? w.alias + ': ' : ''}${ds[i].label}, ${ds[i].what}${w.partition ? ` per ${w.partition}` : ''}${w.order ? `, ordered by ${w.order}` : ''}${ds[i].notes.map((t) => `\n  ⚠ ${t}`).join('')}`).join('\n') });
  }
  if (sh.qualify.length && !(sh.dedupe && sh.dedupe.where === 'QUALIFY')) out.push({ cls: 'filter', text: 'qualify', title: 'Rows are filtered after window functions:\nQUALIFY ' + sh.qualify.join(' AND ') });
  if (sh.branches > 1) out.push({ cls: 'union', text: `∪ ${sh.branches}`, title: `${sh.branches} SELECTs stacked with UNION / INTERSECT / EXCEPT` });
  if (sh.distinct) out.push({ cls: 'distinct', text: 'distinct', title: 'SELECT DISTINCT: duplicate rows removed' });
  if (sh.limit) out.push({ cls: 'limit', text: `limit ${clip(sh.limit, 8)}`, title: `LIMIT ${sh.limit}` });
  return out;
}
