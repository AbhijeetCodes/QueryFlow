// The name under the cursor: what it is (CTE, table, alias, variable, parameter),
// where it is defined and every place it is used. Go to definition, find
// references, rename, hover and "preview this CTE" are all built on symbolAt().

import { RESERVED } from './analyzer.js';
import { dialectOf } from './dialect.js';

const same = (r, t) => r.from === t.a && r.to === t.b;
const within = (r, t) => r.from <= t.a && t.b <= r.to;
const keyOf = (s) => s.replace(/[`"[\]]/g, '').toLowerCase();

// The identifier / parameter token at `pos` (either edge counts, so `u|.id` finds `u`).
function tokenAt(T, pos) {
  let lo = 0;
  let hi = T.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (T[mid].a <= pos) lo = mid + 1; else hi = mid;
  }
  for (const i of [lo - 1, lo - 2]) {
    const t = T[i];
    if (t && t.a <= pos && pos <= t.b && (t.t === 'ident' || t.t === 'qident' || t.t === 'param')) return i;
  }
  return -1;
}

// Steps (CTE bodies, subqueries, statements) around `pos`, innermost first.
function stepsAround(a, pos) {
  const out = [];
  for (const n of a.graph.nodes) {
    for (const sp of n.body ? [n.body] : n.spans || []) {
      if (pos >= sp.from && pos <= sp.to) out.push({ n, size: sp.to - sp.from });
    }
  }
  return out.sort((x, y) => x.size - y.size).map((x) => x.n);
}

/** The FROM item a qualifier like `u` in `u.id` means at `pos`, looking outwards (correlated subqueries). */
export function resolveQualifier(a, pos, key) {
  for (const step of stepsAround(a, pos)) {
    for (const block of step.blocks || []) {
      for (const item of block) {
        const k = (item.alias || (item.name || '').replace(/[`"[\]]/g, '').split('.').pop() || '').toLowerCase();
        if (k === key) return { item, step };
      }
    }
  }
  return null;
}

// `x.` qualifiers anywhere in the query that resolve to `pred(item)`.
function qualifierUses(a, key, pred) {
  const T = a.tokens;
  const out = [];
  for (let i = 0; i < T.length - 1; i++) {
    const t = T[i];
    if ((t.t !== 'ident' && t.t !== 'qident') || keyOf(t.s) !== key || T[i + 1].s !== '.' || T[i - 1]?.s === '.') continue;
    const hit = resolveQualifier(a, t.a, key);
    if (hit && pred(hit.item)) out.push({ from: t.a, to: t.b });
  }
  return out;
}

function nodeSymbol(a, n) {
  const kind = n.kind === 'cte' ? 'cte' : 'table';
  // Unaliased `FROM orders … orders.id` uses the name itself as the qualifier.
  const key = keyOf(n.kind === 'cte' ? n.label : (n.full || n.label).split('.').pop());
  const quals = qualifierUses(a, key, (it) => !it.alias && it.nodeId === n.id);
  return { kind, name: n.label, node: n, def: n.kind === 'table' ? null : n.def, refs: uniq([...n.refs, ...quals]) };
}

function aliasSymbol(a, item, step) {
  const key = item.alias.toLowerCase();
  const refs = qualifierUses(a, key, (it) => it === item);
  return { kind: 'alias', name: item.alias, item, step, def: item.aliasAt, refs };
}

function uniq(ranges) {
  const m = new Map();
  for (const r of ranges) if (!m.has(r.from)) m.set(r.from, r);
  return [...m.values()].sort((x, y) => x.from - y.from);
}

/** What the name at `pos` is, or null. { kind, name, def, refs, node?, item?, variable?, param?, cteParam? } */
export function symbolAt(a, pos) {
  const T = a.tokens;
  const i = tokenAt(T, pos);
  if (i < 0) return null;
  const t = T[i];

  if (t.t === 'param') {
    const p = a.params.find((p) => p.sigil === t.sigil && p.name.toLowerCase() === (t.name || '').toLowerCase());
    if (p) return { kind: 'param', name: p.name, def: null, refs: p.refs, param: p };
    // otherwise a MySQL @variable, below
  }

  for (const n of a.graph.nodes) {
    if (n.kind !== 'cte' && n.kind !== 'table' && n.kind !== 'created') continue;
    if ((n.def && same(n.def, t) && n.kind === 'cte') || n.refs.some((r) => within(r, t))) return nodeSymbol(a, n);
  }

  const key = keyOf(t.s);
  for (const v of a.variables) {
    const idx = v.names.findIndex((nm) => nm.toLowerCase() === key);
    if (idx < 0) continue;
    if (same(v.nameToks[idx], t) || v.refs.some((r) => same(r, t))) {
      const refs = v.refs.filter((r) => keyOf(a.src.slice(r.from, r.to)) === key);
      return { kind: 'variable', name: v.names[idx], def: v.nameToks[idx], refs, variable: v };
    }
  }

  for (const cp of a.cteParams) {
    if ((cp.nameAt && same(cp.nameAt, t)) || cp.refs.some((r) => same(r, t))) {
      return { kind: 'cteParam', name: cp.name, def: cp.nameAt || cp.def, refs: cp.refs, cteParam: cp };
    }
  }

  for (const n of a.graph.nodes) {
    for (const block of n.blocks || []) {
      for (const item of block) if (item.aliasAt && same(item.aliasAt, t)) return aliasSymbol(a, item, n);
    }
  }

  // A qualifier: `u` in `u.id`.
  if (T[i + 1]?.s === '.' && T[i - 1]?.s !== '.') {
    const hit = resolveQualifier(a, t.a, key);
    if (hit?.item.alias) return aliasSymbol(a, hit.item, hit.step);
    const n = hit?.item.nodeId && a.graph.nodes.find((x) => x.id === hit.item.nodeId);
    if (n && n.kind !== 'subquery') return nodeSymbol(a, n);
  }
  return null;
}

/** Definition first (when there is one), then uses, in document order. */
export function occurrences(sym) {
  return uniq([...(sym.def ? [sym.def] : []), ...sym.refs]);
}

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
export const RENAMABLE = new Set(['cte', 'alias', 'variable', 'param', 'cteParam']);
/** Whether F2 can rename it (a positional $1 has no name to change). */
export const canRename = (sym) => RENAMABLE.has(sym.kind) && !(sym.kind === 'param' && sym.param.sigil === '$');

/** Edits that rename `sym` to `name`, or { error }. */
export function renameEdits(a, sym, name) {
  if (!canRename(sym)) return { error: 'Only CTEs, aliases, variables and named parameters can be renamed' };
  // A MySQL variable keeps its @; a parameter keeps its @ or :.
  const sigil = sym.kind === 'param' ? sym.param.sigil : sym.kind === 'variable' && sym.name.startsWith('@') ? '@' : '';
  name = name.trim().replace(/^[@:]/, '');
  if (!IDENT.test(name)) return { error: 'Use letters, digits and _ (not starting with a digit)' };
  name = sigil + name;
  const key = name.toLowerCase();
  const cur = sym.kind === 'param' ? sym.param.text : sym.name;
  if (key === cur.toLowerCase() && name === cur) return { changes: [] };
  const reserved = (w) => RESERVED.has(w) || dialectOf(a.dialect).reserved.has(w);
  if (!sigil && reserved(name.toUpperCase())) return { error: `${name.toUpperCase()} is a reserved word` };
  if (key !== cur.toLowerCase()) {
    const clash =
      sym.kind === 'cte' ? a.graph.nodes.some((n) => n.kind === 'cte' && n.label.toLowerCase() === key)
      : sym.kind === 'variable' ? a.variables.some((v) => v.names.some((n) => n.toLowerCase() === key)) || a.params.some((p) => p.text.toLowerCase() === key)
      : sym.kind === 'param' ? a.params.some((p) => p.text.toLowerCase() === key)
      : sym.kind === 'cteParam' ? a.cteParams.some((p) => p.name.toLowerCase() === key)
      : sym.step.blocks.some((b) => b.some((it) => (it.alias || '').toLowerCase() === key));
    if (clash) return { error: `"${name}" is already used${sym.kind === 'alias' ? ' in this FROM' : ''}` };
  }
  const changes = occurrences(sym).map((r) => {
    const old = a.src.slice(r.from, r.to);
    const q = old[0] === '`' || old[0] === '"' ? old[0] + old[0] : old[0] === '[' ? '[]' : '';
    const insert = sym.kind === 'param' ? name : q ? q[0] + name + q[1] : name;
    return { from: r.from, to: r.to, insert };
  });
  return { changes };
}

// ---- preview a CTE ------------------------------------------------------------

/** The CTE to preview at `pos`: one named under the cursor, else the innermost one around it. */
export function cteAt(a, pos) {
  const sym = symbolAt(a, pos);
  if (sym?.kind === 'cte') return sym.node;
  let best = null;
  for (const n of a.graph.nodes) {
    if (n.kind !== 'cte' || !n.body) continue;
    const inside = (pos >= n.body.from && pos <= n.body.to) || (pos >= n.def.from && pos <= n.def.to);
    if (inside && (!best || n.body.from > best.body.from)) best = n;
  }
  return best;
}

// Shift every line after the first left by `indent` (a nested CTE's depth).
function reindent(text, indent) {
  return text.split('\n').map((ln, i) => {
    if (i === 0) return ln;
    const lead = /^ */.exec(ln)[0].length;
    return ln.trim() ? ln.slice(Math.min(lead, indent)) : '';
  }).join('\n');
}

/**
 * A runnable query showing one CTE's rows: the DECLARE / SET / temp function
 * statements it may rely on, the CTEs it reads (transitively), then
 * SELECT * FROM it LIMIT n.
 */
export function previewSql(a, nodeId, { limit = 100 } = {}) {
  const byId = new Map(a.graph.nodes.map((n) => [n.id, n]));
  const target = byId.get(nodeId);
  if (!target || target.kind !== 'cte') return null;
  const need = new Set();
  const seen = new Set();
  const walk = (id) => {
    if (seen.has(id)) return;
    seen.add(id);
    const n = byId.get(id);
    if (!n) return;
    if (n.kind === 'cte') need.add(n);
    for (const up of n.in || []) walk(up);
  };
  walk(nodeId);
  const ctes = [...need].sort((x, y) => x.def.from - y.def.from);
  const src = a.src;
  const parts = ctes.map((n) => {
    const lineStart = src.lastIndexOf('\n', n.def.from - 1) + 1;
    const indent = /^ */.exec(src.slice(lineStart, n.def.from))[0].length;
    return reindent(src.slice(n.def.from, n.body.to), indent);
  });
  const stmt = a.statements.find((s) => s.from <= target.def.from && target.def.from <= s.to);
  const recursive = stmt && /\bWITH\s+RECURSIVE\b/i.test(src.slice(stmt.from, target.def.from)) ? ' RECURSIVE' : '';
  const prelude = a.statements
    .filter((s) => s.kind !== 'other' && (!stmt || s.to <= stmt.from))
    .map((s) => src.slice(s.from, s.to).trim() + (src.slice(s.from, s.to).trim().endsWith(';') ? '' : ';'));
  const sql = [
    ...(prelude.length ? [prelude.join('\n'), ''] : []),
    `WITH${recursive} ` + parts.join(',\n\n'),
    '',
    ...(a.dialect === 'sqlserver'
      ? [`SELECT TOP ${limit} *`, `FROM ${src.slice(target.def.from, target.def.to)};`]
      : ['SELECT *', `FROM ${src.slice(target.def.from, target.def.to)}`, `LIMIT ${limit};`]),
    '',
  ].join('\n');
  return { sql, label: target.label, ctes: ctes.length };
}
