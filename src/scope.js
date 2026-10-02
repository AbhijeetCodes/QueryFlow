// What the names in the query refer to: which CTE or table an alias like `u.`
// means at a position, and the columns a CTE selects (for autocomplete).

const sig = (t) => t.t !== 'ws' && t.t !== 'comment';

/** Output column names of a SELECT, in order ("" for *, or expressions we can't name). */
function selectColumns(toks) {
  const s = toks.filter(sig);
  let depth = 0;
  let sel = -1;
  for (let i = 0; i < s.length; i++) {
    const t = s[i];
    if (t.s === '(' && t.t === 'punct') depth++;
    else if (t.s === ')' && t.t === 'punct') depth--;
    else if (depth === 0 && t.u === 'SELECT') sel = i;
  }
  if (sel === -1) return [];
  const cols = [];
  let item = [];
  depth = 0;
  const flush = () => {
    if (!item.length) return;
    const last = item[item.length - 1];
    const prev = item[item.length - 2];
    const word = last.t === 'ident' || last.t === 'qident';
    // `expr AS name`, a bare or dotted column, or an implicit alias (`SUM(x) total`).
    let name = '';
    if (word && (!prev || prev.u === 'AS' || prev.s === '.' || (prev.t !== 'op' && prev.s !== ','))) name = last.s;
    cols.push(name.replace(/[`"]/g, ''));
    item = [];
  };
  for (let i = sel + 1; i < s.length; i++) {
    const t = s[i];
    if (depth === 0 && (t.u === 'DISTINCT' || t.u === 'ALL') && !item.length) continue;
    if (t.s === '(' && t.t === 'punct') depth++;
    else if (t.s === ')' && t.t === 'punct') depth--;
    if (depth === 0 && ['FROM', 'WHERE', 'GROUP', 'HAVING', 'QUALIFY', 'WINDOW', 'ORDER', 'LIMIT', 'UNION', 'EXCEPT', 'INTERSECT'].includes(t.u)) break;
    if (depth === 0 && t.s === ',') { flush(); continue; }
    item.push(t);
  }
  flush();
  return cols;
}

// The innermost step (CTE body or final query) around `pos`.
function stepAt(analysis, pos) {
  let best = null;
  let bestLen = Infinity;
  for (const n of analysis.graph.nodes) {
    for (const sp of n.body ? [n.body] : n.spans || []) {
      if (pos >= sp.from && pos <= sp.to && sp.to - sp.from < bestLen) { best = n; bestLen = sp.to - sp.from; }
    }
  }
  return best;
}

/** alias (lower case) -> FROM item, for the step around `pos`. Unaliased items answer to their last name part. */
export function scopeAt(analysis, pos) {
  const scope = new Map();
  const step = stepAt(analysis, pos);
  for (const block of step?.blocks || []) {
    for (const item of block) {
      const key = (item.alias || (item.name || '').replace(/[`"]/g, '').split('.').pop() || '').toLowerCase();
      if (key && !scope.has(key)) scope.set(key, item);
    }
  }
  return scope;
}

const cteColumns = new WeakMap(); // analysis -> Map(nodeId -> columns)

/** Columns of a FROM item: the names a CTE selects. null for tables (no schemas in the browser). */
export function columnsOf(analysis, item) {
  const node = analysis.graph.nodes.find((n) => n.id === item.nodeId);
  if (!node) return null;
  if (node.kind === 'cte' && node.body) {
    let m = cteColumns.get(analysis);
    if (!m) cteColumns.set(analysis, (m = new Map()));
    if (!m.has(node.id)) {
      const toks = analysis.tokens.filter((t) => t.a >= node.body.from && t.b <= node.body.to);
      // Strip the CTE's own parentheses so the SELECT is at depth 0.
      const inner = toks[0]?.s === '(' ? toks.slice(1, -1) : toks;
      m.set(node.id, selectColumns(inner).filter(Boolean).map((name) => ({ name, type: '', description: `from CTE ${node.label}` })));
    }
    return m.get(node.id);
  }
  return null;
}
