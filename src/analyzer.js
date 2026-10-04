// Heuristic, error-tolerant analysis of a SQL script (BigQuery, PostgreSQL,
// MySQL or SQL Server; see dialect.js). It does not build a
// full AST — it walks tokens with paren depth, which survives the messy,
// half-broken queries people paste far better than a strict parser.
//
// Output feeds every panel: variables, literal filters, the join graph,
// lint diagnostics and editor decorations.

import { tokenize, stringInner, unquoteIdent } from './tokenizer.js';
import { dialectOf, currentDialect, bareName } from './dialect.js';

export const RESERVED = new Set(`ALL AND ANY ARRAY AS ASC ASSERT_ROWS_MODIFIED AT BETWEEN BY CASE CAST
COLLATE CONTAINS CREATE CROSS CUBE CURRENT DEFAULT DEFINE DESC DISTINCT ELSE END ENUM ESCAPE
EXCEPT EXCLUDE EXISTS EXTRACT FALSE FETCH FOLLOWING FOR FROM FULL GROUP GROUPING GROUPS HASH
HAVING IF IGNORE IN INNER INTERSECT INTERVAL INTO IS JOIN LATERAL LEFT LIKE LIMIT LOOKUP MERGE
NATURAL NEW NO NOT NULL NULLS OF ON OR ORDER OUTER OVER PARTITION PRECEDING PROTO QUALIFY RANGE
RECURSIVE RESPECT RIGHT ROLLUP ROWS SELECT SET SOME STRUCT TABLESAMPLE THEN TO TREAT TRUE
UNBOUNDED UNION UNNEST USING WHEN WHERE WINDOW WITH WITHIN`.split(/\s+/));

const JOIN_WORDS = new Set(['JOIN', 'INNER', 'LEFT', 'RIGHT', 'FULL', 'CROSS', 'NATURAL', 'OUTER', 'STRAIGHT_JOIN', 'APPLY']);
// SQL Server table hints: FROM t WITH (NOLOCK), or the older FROM t (NOLOCK)
const TABLE_HINTS = new Set(['NOLOCK', 'READUNCOMMITTED', 'READCOMMITTED', 'READPAST', 'HOLDLOCK', 'UPDLOCK', 'ROWLOCK',
  'PAGLOCK', 'TABLOCK', 'TABLOCKX', 'XLOCK', 'NOWAIT', 'SERIALIZABLE', 'REPEATABLEREAD', 'SNAPSHOT', 'INDEX', 'FORCESEEK', 'FORCESCAN', 'NOEXPAND']);
const FROM_END = new Set(['WHERE', 'GROUP', 'HAVING', 'QUALIFY', 'WINDOW', 'ORDER', 'LIMIT',
  'UNION', 'INTERSECT', 'EXCEPT', 'SELECT']);
const COMPARE = new Set(['=', '!=', '<>', '<', '>', '<=', '>=']);
const TYPED_LITERAL = new Set(['DATE', 'DATETIME', 'TIMESTAMP', 'TIME', 'NUMERIC', 'BIGNUMERIC', 'JSON']);

const cache = new WeakMap();
const reservedSets = new Map();
const reservedFor = (D) => {
  if (!reservedSets.has(D.id)) reservedSets.set(D.id, new Set([...RESERVED, ...D.reserved]));
  return reservedSets.get(D.id);
};

// Memoised per CodeMirror Text instance (or any object with toString()) and dialect.
export function analyzeDoc(doc, dialect = currentDialect()) {
  let r = cache.get(doc);
  if (!r || r.dialect !== dialect) {
    r = analyze(doc.toString(), dialect);
    cache.set(doc, r);
  }
  return r;
}

export function analyze(src, dialect) {
  const D = dialectOf(dialect);
  const BQ = D.id === 'bigquery';
  const TSQL = D.id === 'sqlserver';
  const RES = reservedFor(D);
  const all = tokenize(src, D.id);
  const T = all.filter((t) => t.t !== 'ws' && t.t !== 'comment');
  const N = T.length;
  const diags = [];
  const marks = []; // editor decorations {from,to,cls}

  for (const t of all) {
    if (t.err) diags.push({ from: t.a, to: t.b, severity: 'error', message: t.err });
  }

  // ---- paren structure --------------------------------------------------
  const depth = new Int32Array(N);
  const match = new Int32Array(N).fill(-1);
  const parent = new Int32Array(N).fill(-1); // innermost enclosing '('
  {
    const stack = [];
    for (let i = 0; i < N; i++) {
      const s = T[i].s;
      parent[i] = stack.length ? stack[stack.length - 1] : -1;
      if (s === '(' && T[i].t === 'punct') {
        depth[i] = stack.length;
        stack.push(i);
      } else if (s === ')' && T[i].t === 'punct') {
        if (stack.length) {
          const o = stack.pop();
          match[o] = i;
          match[i] = o;
          depth[i] = stack.length;
          parent[i] = stack.length ? stack[stack.length - 1] : -1;
        } else {
          depth[i] = 0;
          diags.push({ from: T[i].a, to: T[i].b, severity: 'error', message: 'Unmatched closing parenthesis' });
        }
      } else {
        depth[i] = stack.length;
      }
    }
    for (const o of stack) {
      diags.push({ from: T[o].a, to: T[o].b, severity: 'error', message: 'Parenthesis is never closed' });
    }
  }

  const up = (i) => (i >= 0 && i < N && T[i].t === 'ident' ? T[i].u : null);
  const is = (i, w) => up(i) === w;
  const txt = (i) => (i >= 0 && i < N ? T[i].s : null);
  const closeOf = (i, b) => (match[i] >= 0 ? match[i] : b);
  const slice = (i, j) => (i <= j && i < N ? src.slice(T[i].a, T[Math.min(j, N - 1)].b) : '');
  const squash = (s, max = 80) => {
    const one = s.replace(/\s+/g, ' ').trim();
    return one.length > max ? one.slice(0, max - 1) + '…' : one;
  };
  const isName = (i) => i < N && (T[i].t === 'qident' || (T[i].t === 'ident' && !RES.has(T[i].u)));
  const lineStartAt = (pos) => src.lastIndexOf('\n', pos - 1) + 1;

  // SQL Server: does token i (depth 0, inside the statement that starts at s)
  // begin a new statement although no `;` came before it?
  function startsStatement(i, s, selects) {
    const w = up(i);
    const first = up(s);
    if (!w) return false;
    if (w === 'DECLARE') return true;
    // after DECLARE / SET, a query or control-flow keyword starts the next statement
    if ((first === 'DECLARE' || first === 'SET') && ['SELECT', 'WITH', 'IF', 'WHILE', 'BEGIN', 'RETURN'].includes(w)) return true;
    if (w === 'SET') return T[i + 1]?.t === 'param' && first !== 'UPDATE' && first !== 'MERGE';
    // A second SELECT is a new statement unless a set operator joins them.
    if (w === 'SELECT') return selects > 0 && !['UNION', 'ALL', 'DISTINCT', 'INTERSECT', 'EXCEPT'].includes(up(i - 1)) && txt(i - 1) !== '(';
    if (w === 'WITH') return (T[i + 1]?.t === 'ident' || T[i + 1]?.t === 'qident') && (is(i + 2, 'AS') || txt(i + 2) === '(');
    if (['CREATE', 'DROP', 'TRUNCATE', 'EXEC', 'EXECUTE', 'PRINT'].includes(w)) return first !== 'ALTER';
    if (['INSERT', 'UPDATE', 'DELETE', 'MERGE'].includes(w)) return first !== 'MERGE' && !is(i - 1, 'THEN') && !is(i - 1, 'FOR');
    return false;
  }

  function isSubqueryStart(i) {
    while (i < N && txt(i) === '(' && T[i].t === 'punct') i++;
    return is(i, 'SELECT') || is(i, 'WITH');
  }

  // Reads a dotted path: a.b.c, `p.d.t`, my-project.ds.t (dashes only when adjacent)
  function readPath(k) {
    const parts = [];
    const from = k;
    let prevEnd = -1;
    while (k < N) {
      const t = T[k];
      if (t.t === 'ident' || t.t === 'qident') {
        let chunk = t.t === 'qident' ? unquoteIdent(t.s) : t.s;
        let j = k + 1;
        // project ids with dashes: my-project-123
        while (t.t === 'ident' && j + 1 < N && T[j].s === '-' && T[j].a === T[j - 1].b &&
               (T[j + 1].t === 'ident' || T[j + 1].t === 'number') && T[j + 1].a === T[j].b) {
          chunk += '-' + T[j + 1].s;
          j += 2;
        }
        // `proj.ds.t` is one quoted path; a dot inside "…" or […] is part of the name
        parts.push(...(t.s[0] === '"' || t.s[0] === '[' ? [chunk] : chunk.split('.')));
        prevEnd = j - 1;
        k = j;
        if (txt(k) === '.' && k + 1 < N && (T[k + 1].t === 'ident' || T[k + 1].t === 'qident')) {
          k++;
          continue;
        }
        break;
      }
      break;
    }
    if (!parts.length) return null;
    return { parts, end: k, fromTok: from, toTok: prevEnd, from: T[from].a, to: T[prevEnd].b, text: src.slice(T[from].a, T[prevEnd].b) };
  }

  // A table name: a path, or in SQL Server also a table variable (@t)
  function readTarget(k) {
    if (TSQL && T[k]?.t === 'param') return { parts: [T[k].s], end: k + 1, fromTok: k, toTok: k, from: T[k].a, to: T[k].b, text: T[k].s };
    return readPath(k);
  }

  // Walk back from token j over a path (a.b.c) — returns start index or -1
  function pathStartBefore(j) {
    if (j < 0 || !(T[j].t === 'ident' || T[j].t === 'qident')) return -1;
    let i = j;
    while (i - 2 >= 0 && txt(i - 1) === '.' && (T[i - 2].t === 'ident' || T[i - 2].t === 'qident')) i -= 2;
    return i;
  }

  // Expression operand ending at token j: a path, or a function call f(...)
  function operandBefore(j) {
    if (j < 0) return null;
    // Postgres cast: expr::type
    if (j >= 2 && T[j].t === 'ident' && txt(j - 1) === '::') {
      const o = operandBefore(j - 2);
      return o ? { i: o.i, j } : null;
    }
    if (txt(j) === ')' && match[j] >= 0) {
      let i = match[j];
      const p = pathStartBefore(i - 1);
      if (p >= 0) i = p;
      return { i, j };
    }
    const p = pathStartBefore(j);
    return p >= 0 ? { i: p, j } : null;
  }

  function operandAfter(i) {
    if (i >= N) return null;
    const p = readPath(i);
    if (p) {
      if (txt(p.end) === '(' && match[p.end] >= 0) return { i, j: match[p.end] };
      return { i, j: p.end - 1 };
    }
    return null;
  }

  // ---- graph state ------------------------------------------------------
  const nodes = new Map();
  const edges = new Map();
  const blocks = new Map(); // ownerId -> [[item,...], ...] (one array per FROM clause)
  const pendingOwners = new Map();
  const cteStack = [];
  const created = new Map(); // temp/created table name (lower) -> node id
  const cteDefs = [];
  let sqCount = 0;
  let resultCount = 0;
  const inlineStack = []; // contexts of the IN / EXISTS / scalar subqueries we are inside

  function ensureNode(id, props) {
    let n = nodes.get(id);
    if (!n) {
      n = { id, refs: [], ...props };
      nodes.set(id, n);
    }
    return n;
  }

  function ensureOwner(id) {
    if (!nodes.has(id) && pendingOwners.has(id)) ensureNode(id, pendingOwners.get(id));
  }

  function addEdge(from, to, item) {
    ensureOwner(to);
    const key = from + '→' + to;
    let e = edges.get(key);
    if (!e) {
      e = { id: key, from, to, joins: [] };
      edges.set(key, e);
    }
    e.joins.push(item);
  }

  function lookupCte(name) {
    const key = name.toLowerCase();
    for (let s = cteStack.length - 1; s >= 0; s--) {
      if (cteStack[s].has(key)) return cteStack[s].get(key);
    }
    return null;
  }

  function tableNode(p) {
    const full = p.parts.join('.');
    if (p.parts.length === 1) {
      const cte = lookupCte(full);
      if (cte) return cte;
      const c = created.get(full.toLowerCase());
      if (c) return c;
    }
    const id = 'tbl:' + full.toLowerCase();
    const c = created.get(full.toLowerCase());
    if (c) return c;
    ensureNode(id, {
      kind: 'table',
      label: p.parts[p.parts.length - 1],
      sub: p.parts.slice(0, -1).join('.'),
      full,
    });
    return id;
  }

  function readJoin(k, sd) {
    let j = k;
    let type = null;
    let natural = false;
    let outer = false;
    while (j < N && depth[j] === sd && T[j].t === 'ident' && JOIN_WORDS.has(T[j].u)) {
      const w = T[j].u;
      if (w === 'JOIN' || w === 'STRAIGHT_JOIN') {
        return { type: type || 'INNER', end: j + 1, natural, explicit: !!type };
      }
      // SQL Server: CROSS APPLY is an inner lateral join, OUTER APPLY a left one; neither has ON.
      if (w === 'APPLY') return type === 'CROSS' || outer ? { type: outer ? 'LEFT' : 'CROSS', end: j + 1, natural, explicit: true, apply: true } : null;
      if (w === 'OUTER') outer = true;
      if (w === 'NATURAL') natural = true;
      else if (w !== 'OUTER' && !type) type = w;
      j++;
    }
    return null;
  }

  // What an inline subquery at '(' (token k) is doing for the enclosing query.
  function inlineContext(k) {
    const j = k - 1;
    if (is(j, 'IN')) {
      const neg = is(j - 1, 'NOT');
      const o = operandBefore(neg ? j - 2 : j - 1);
      let col = '';
      if (o) {
        const p = readPath(o.i);
        col = p && p.end === o.j + 1 ? p.parts[p.parts.length - 1] : squash(slice(o.i, o.j), 30);
      }
      return { kind: neg ? 'NOT IN' : 'IN', col };
    }
    if (is(j, 'EXISTS')) return { kind: is(j - 1, 'NOT') ? 'NOT EXISTS' : 'EXISTS', col: '' };
    if (is(j, 'ARRAY')) return { kind: 'ARRAY', col: '' };
    return { kind: 'SCALAR', col: '' };
  }

  function parseInline(k, close, owner) {
    inlineStack.push(inlineContext(k));
    parseQuery(k + 1, close, owner, { nested: true, kind: 'subquery', inline: true });
    inlineStack.pop();
  }

  // Scan a range only for nested subqueries (e.g. inside function args)
  function scanSubqueries(a, b, owner) {
    for (let k = a; k < b; k++) {
      if (txt(k) === '(' && T[k].t === 'punct' && isSubqueryStart(k + 1)) {
        const close = closeOf(k, b);
        parseInline(k, close, owner);
        k = close;
      }
    }
  }

  function skipCondition(k, b, sd, owner) {
    while (k < b) {
      const t = T[k];
      if (depth[k] < sd) break;
      if (t.s === '(' && t.t === 'punct') {
        const close = closeOf(k, b);
        if (isSubqueryStart(k + 1)) {
          parseInline(k, close, owner);
        }
        k = close + 1;
        continue;
      }
      if (depth[k] === sd) {
        if (t.s === ',' || t.s === ';' || t.s === '|>') break;
        if (t.t === 'ident') {
          if (FROM_END.has(t.u)) break;
          if (JOIN_WORDS.has(t.u) && readJoin(k, sd)) break;
        }
      }
      k++;
    }
    return k;
  }

  function extractKeys(a, b) {
    const keys = [];
    let extra = false;
    for (let i = a; i < b; i++) {
      if (T[i].t !== 'op' || !COMPARE.has(T[i].s)) continue;
      const l = operandBefore(i - 1);
      const r = operandAfter(i + 1);
      const lIsPath = l && txt(l.j) !== ')';
      const rIsPath = r && txt(r.j) !== ')';
      if (T[i].s === '=' && lIsPath && rIsPath) {
        keys.push({ left: slice(l.i, l.j), right: slice(r.i, r.j) });
      } else {
        extra = true;
      }
    }
    return { keys, extra };
  }

  function parseFrom(k, b, owner, sd) {
    const aliases = new Map();
    const items = [];
    let joinType = 'FROM';
    let joinTok = k - 1;
    let natural = false;
    let apply = false;
    while (k < b) {
      // Postgres: JOIN LATERAL (subquery), FROM ONLY parent_table
      if ((is(k, 'LATERAL') || is(k, 'ONLY')) && T[k + 1] && (txt(k + 1) === '(' || T[k + 1].t === 'ident' || T[k + 1].t === 'qident')) k++;
      const t = T[k];
      if (!t) break;
      const item = { joinType, alias: null, nodeId: null, name: null, kind: 'table', keys: [], onText: null, natural, from: T[joinTok]?.a ?? t.a };
      if (apply) item.apply = true;
      natural = false;
      apply = false;
      if (t.s === '(' && t.t === 'punct') {
        const close = closeOf(k, b);
        if (isSubqueryStart(k + 1)) {
          const id = `sq:${++sqCount}`;
          ensureNode(id, { kind: 'subquery', label: 'subquery', def: { from: t.a, to: T[close].b } });
          nodes.get(id).spans = [{ from: t.a, to: T[close].b }];
          nodes.get(id).refs.push({ from: t.a, to: t.a + 1 });
          parseQuery(k + 1, close, id, { nested: true, kind: 'subquery' });
          item.nodeId = id;
          item.name = '(subquery)';
          item.kind = 'subquery';
        } else {
          parseFrom(k + 1, close, owner, sd + 1);
          item.name = '(nested join)';
          item.kind = 'group';
        }
        k = close + 1;
      } else if (is(k, 'UNNEST') && txt(k + 1) === '(') {
        const close = closeOf(k + 1, b);
        scanSubqueries(k + 2, close, owner);
        item.name = squash(slice(k, close), 40);
        item.kind = 'unnest';
        k = close + 1;
      } else if (t.s === '[' && BQ) {
        let j = k;
        while (j < b && txt(j) !== ']') j++;
        diags.push({ from: t.a, to: T[Math.min(j, N - 1)].b, severity: 'error',
          message: 'Legacy SQL table reference [project:dataset.table] — use `project.dataset.table` in GoogleSQL' });
        item.name = slice(k, j);
        item.kind = 'legacy';
        k = j + 1;
      } else if (t.t === 'ident' || t.t === 'qident' || (TSQL && t.t === 'param')) {
        const p = readTarget(k);
        k = p.end;
        if (TSQL && txt(k) === '(' && TABLE_HINTS.has(up(k + 1))) k = closeOf(k, b) + 1; // FROM t (NOLOCK)
        if (txt(k) === '(' && T[k].t === 'punct') {
          // table-valued function
          const close = closeOf(k, b);
          scanSubqueries(k + 1, close, owner);
          const id = 'fn:' + p.text.toLowerCase();
          ensureNode(id, { kind: 'table', label: p.parts[p.parts.length - 1] + '()', sub: p.parts.slice(0, -1).join('.'), full: p.text });
          nodes.get(id).refs.push({ from: p.from, to: p.to });
          item.nodeId = id;
          item.name = p.text + '(…)';
          k = close + 1;
        } else if (p.parts.length > 1 && aliases.has(p.parts[0].toLowerCase()) && T[p.fromTok].t === 'ident') {
          // correlated array path: FROM t, t.items  /  JOIN o.lines AS l
          item.name = p.text;
          item.kind = 'unnest';
        } else {
          const id = tableNode(p);
          const n = nodes.get(id);
          n.refs.push({ from: p.from, to: p.to });
          marks.push({ from: p.from, to: p.to, cls: n.kind === 'cte' ? 'cm-lens-cte' : 'cm-lens-table' });
          item.nodeId = id;
          item.name = p.text;
          item.kind = n.kind;
        }
      } else {
        break;
      }

      // FOR SYSTEM_TIME AS OF <expr>
      if (is(k, 'FOR') && is(k + 1, 'SYSTEM_TIME')) {
        k += 2;
        if (is(k, 'AS') && is(k + 1, 'OF')) k += 2;
        while (k < b && depth[k] >= sd && !(depth[k] === sd && (txt(k) === ',' || is(k, 'AS') || (T[k].t === 'ident' && (RES.has(T[k].u) && !['INTERVAL', 'CURRENT'].includes(T[k].u)))))) {
          if (txt(k) === '(' && match[k] >= 0) k = match[k];
          k++;
        }
      }

      // alias
      let aliasTok = null;
      if (is(k, 'AS') && isName(k + 1)) {
        aliasTok = T[k + 1];
        k += 2;
      } else if (depth[k] === sd && isName(k) && !is(k, 'WITH')) {
        aliasTok = T[k];
        k++;
      }
      // WITH OFFSET [AS] name
      if (is(k, 'WITH') && is(k + 1, 'OFFSET')) {
        k += 2;
        if (is(k, 'AS')) k++;
        if (isName(k)) k++;
      }
      if (TSQL && is(k, 'WITH') && txt(k + 1) === '(') k = closeOf(k + 1, b) + 1; // WITH (NOLOCK)
      if (is(k, 'TABLESAMPLE')) {
        k++;
        if (is(k, 'SYSTEM')) k++;
        if (txt(k) === '(') k = closeOf(k, b) + 1;
      }

      if (aliasTok) {
        item.alias = unquoteIdent(aliasTok.s);
        item.aliasAt = { from: aliasTok.a, to: aliasTok.b };
        if (item.kind === 'subquery') {
          nodes.get(item.nodeId).label = item.alias;
          nodes.get(item.nodeId).sub = 'subquery';
        }
        marks.push({ from: aliasTok.a, to: aliasTok.b, cls: 'cm-lens-alias' });
      }
      const aliasKey = (item.alias || bareName((item.name || '').split('.').pop())).toLowerCase();
      if (item.alias && aliases.has(aliasKey)) {
        diags.push({ from: aliasTok.a, to: aliasTok.b, severity: 'error', message: `Alias "${item.alias}" is used twice in the same FROM clause` });
      }
      if (aliasKey) aliases.set(aliasKey, item);

      // join condition
      if (is(k, 'ON')) {
        const a = k + 1;
        k = skipCondition(a, b, sd, owner);
        condRanges.push({ owner, a, b: k });
        item.onRange = [a, k];
        if (k > a) {
          item.onText = squash(slice(a, k - 1), 160);
          const { keys, extra } = extractKeys(a, k);
          item.keys = keys;
          item.extraCond = extra;
        }
      } else if (is(k, 'USING') && txt(k + 1) === '(') {
        const close = closeOf(k + 1, b);
        const cols = [];
        for (let j = k + 2; j < close; j++) if (T[j].t === 'ident' || T[j].t === 'qident') cols.push(unquoteIdent(T[j].s));
        item.keys = cols.map((c) => ({ left: c, right: c }));
        item.onText = `USING (${cols.join(', ')})`;
        k = close + 1;
      } else if (!['FROM', 'COMMA', 'CROSS'].includes(item.joinType) && !item.natural && !item.apply &&
                 !['unnest', 'group'].includes(item.kind) && item.joinType !== 'FROM') {
        diags.push({ from: item.from, to: T[Math.max(0, k - 1)].b, severity: 'error',
          message: `${item.joinType} JOIN without ON or USING — add a join condition` });
      }
      if (item.joinType === 'COMMA' && item.nodeId && !isParamsCte(item.nodeId) && !isParamsCte(items[0]?.nodeId)) {
        diags.push({ from: item.from, to: T[Math.max(0, k - 1)].b, severity: 'warning',
          message: 'Comma join is a CROSS JOIN (every row × every row). Use JOIN … ON if that is not intended.' });
      }
      item.to = T[Math.max(0, k - 1)].b;
      items.push(item);
      if (item.nodeId) addEdge(item.nodeId, owner, item);

      // separator to the next item
      if (txt(k) === ',' && depth[k] === sd) {
        joinTok = k;
        joinType = 'COMMA';
        k++;
        continue;
      }
      const jt = readJoin(k, sd);
      if (jt) {
        joinTok = k;
        joinType = jt.type;
        k = jt.end;
        natural = jt.natural;
        apply = !!jt.apply;
        continue;
      }
      break;
    }
    if (items.length) {
      if (!blocks.has(owner)) blocks.set(owner, []);
      if (inlineStack.length) {
        // FROM of an IN / EXISTS / scalar subquery: these rows filter or look up, they are not joined in
        items.inline = inlineStack[0];
        for (const it of items) it.inline = inlineStack[0];
      }
      blocks.get(owner).push(items);
    }
    lastFromItems = items;
    return k;
  }
  let lastFromItems = null;

  function parseWith(k, b) {
    if (is(k, 'RECURSIVE')) k++;
    const scope = new Map();
    cteStack.push(scope);
    while (k < b) {
      const nameTok = T[k];
      if (!nameTok || !(nameTok.t === 'ident' || nameTok.t === 'qident')) break;
      if (!is(k + 1, 'AS') || txt(k + 2) !== '(') break;
      const name = unquoteIdent(nameTok.s);
      const key = name.toLowerCase();
      const open = k + 2;
      const close = closeOf(open, b);
      if (scope.has(key)) {
        diags.push({ from: nameTok.a, to: nameTok.b, severity: 'error', message: `CTE "${name}" is defined twice` });
      }
      let id = 'cte:' + key;
      let n = 2;
      while (nodes.has(id)) id = 'cte:' + key + '#' + n++;
      ensureNode(id, { kind: 'cte', label: name, def: { from: nameTok.a, to: nameTok.b }, body: { from: T[open].a, to: T[close]?.b ?? src.length } });
      nodes.get(id).spans = [nodes.get(id).body];
      marks.push({ from: nameTok.a, to: nameTok.b, cls: 'cm-lens-cte cm-lens-def' });
      scope.set(key, id);
      cteDefs.push({ id, tok: nameTok });
      parseQuery(open + 1, close, id, { nested: true, kind: 'cte' });
      k = close + 1;
      if (txt(k) === ',') {
        k++;
        continue;
      }
      break;
    }
    return k;
  }

  // ---- per-scope "shape": what a CTE / subquery does to its inputs --------
  const shapes = new Map(); // owner id -> shape
  const condRanges = []; // token ranges of WHERE / ON / HAVING / QUALIFY conditions

  // A CTE with no FROM is one row of constants: params AS (SELECT DATE '2024-01-01' AS start_date, …)
  function isParamsCte(id) {
    const n = id && nodes.get(id);
    const sh = id && shapes.get(id);
    return !!(n && n.kind === 'cte' && sh && !sh.hasFrom && sh.branches === 1 && sh.columns > 0);
  }

  // Split [a, b) on `sep` tokens at depth sd.
  function splitTop(a, b, sd, sep) {
    const parts = [];
    let st = a;
    let br = 0; // [ ] nesting: ARRAY literals and OFFSET() subscripts contain commas too
    for (let i = a; i < b; i++) {
      if (T[i].t === 'punct' && depth[i] === sd) {
        if (T[i].s === '[') br++;
        else if (T[i].s === ']') br = Math.max(0, br - 1);
      }
      if (depth[i] === sd && br === 0 && T[i].s === sep && T[i].t === 'punct') {
        if (i > st) parts.push([st, i]);
        st = i + 1;
      }
    }
    if (b > st) parts.push([st, b]);
    return parts;
  }

  // Split a condition on top-level AND (not the AND of BETWEEN). If the top
  // level mixes in OR, splitting would change meaning, so keep it whole.
  function splitAnd(a, b, sd) {
    const parts = [];
    let st = a;
    let between = false;
    for (let i = a; i < b; i++) {
      if (depth[i] !== sd || T[i].t !== 'ident') continue;
      if (T[i].u === 'OR') return a < b ? [[a, b]] : [];
      if (T[i].u === 'BETWEEN') between = true;
      else if (T[i].u === 'AND') {
        if (between) { between = false; continue; }
        if (i > st) parts.push([st, i]);
        st = i + 1;
      }
    }
    if (b > st) parts.push([st, b]);
    return parts;
  }

  const AGGREGATES = new Set(['COUNT', 'SUM', 'AVG', 'MIN', 'MAX', 'COUNTIF', 'ANY_VALUE', 'ARRAY_AGG',
    'STRING_AGG', 'LOGICAL_AND', 'LOGICAL_OR', 'APPROX_COUNT_DISTINCT', 'APPROX_QUANTILES', 'APPROX_TOP_COUNT',
    'APPROX_TOP_SUM', 'HLL_COUNT', 'STDDEV', 'STDDEV_POP', 'STDDEV_SAMP', 'VARIANCE', 'VAR_POP', 'VAR_SAMP',
    'CORR', 'COVAR_POP', 'COVAR_SAMP', 'BIT_AND', 'BIT_OR', 'BIT_XOR', 'MAX_BY', 'MIN_BY', 'ARRAY_CONCAT_AGG',
    'PERCENTILE_CONT', 'PERCENTILE_DISC',
    // Postgres / MySQL
    'BOOL_AND', 'BOOL_OR', 'EVERY', 'JSON_AGG', 'JSONB_AGG', 'JSON_OBJECT_AGG', 'JSONB_OBJECT_AGG', 'MODE',
    'GROUP_CONCAT', 'JSON_ARRAYAGG', 'JSON_OBJECTAGG', 'STD']);
  const TRIVIAL = /^(1\s*=\s*1|TRUE)$/i;

  function selectItemAlias(a, b) {
    for (let i = b - 1; i > a; i--) {
      if (is(i - 1, 'AS') && depth[i] === depth[a]) return unquoteIdent(T[i].s);
    }
    const last = T[b - 1];
    if (b - 1 > a && (last.t === 'ident' || last.t === 'qident') && txt(b - 2) !== '.' && !RES.has(last.u)) {
      return unquoteIdent(last.s);
    }
    // bare column: a.b.col -> col
    const p = readPath(a);
    if (p && p.end === b) return p.parts[p.parts.length - 1];
    return null;
  }

  // Text of [a, b) with any nested `OVER (…)` written as "per x" (window functions
  // used as ORDER BY keys, like DENSE_RANK() OVER (ORDER BY SUM(v) OVER (PARTITION BY c))).
  function keyText(a, b, max) {
    let out = '';
    let pos = a;
    for (let k = a; k < b; k++) {
      if (!is(k, 'OVER') || txt(k + 1) !== '(') continue;
      const inner = readOver(k + 1);
      out += slice(pos, k - 1) + (inner.partition ? ` per ${inner.partition}` : ' over all rows');
      k = inner.close;
      pos = k + 1;
    }
    return squash(out + slice(pos, b - 1), max);
  }

  // ORDER BY keys of a window: [{ text, desc }], NULLS FIRST / LAST dropped.
  function orderKeys(a, b) {
    return splitTop(a, b, depth[a], ',').map(([x, y]) => {
      if (is(y - 2, 'NULLS')) y -= 2;
      const desc = is(y - 1, 'DESC');
      if (desc || is(y - 1, 'ASC')) y--;
      return { text: keyText(x, y, 60), desc };
    });
  }

  // WINDOW w AS (…), w2 AS (w ORDER BY …) of one SELECT: name → spec.
  function readNamedWindows(a, b, sd) {
    const named = new Map();
    for (const [x, y] of splitTop(a, b, sd, ',')) {
      if (is(x + 1, 'AS') && txt(x + 2) === '(' && closeOf(x + 2, y) < y) named.set(T[x].u, readOver(x + 2, named));
    }
    return named;
  }

  // Parse the window spec OVER ( [name] PARTITION BY … ORDER BY … [ROWS | RANGE …] ).
  // A spec that starts with a named window inherits its parts.
  function readOver(open, named) {
    const close = closeOf(open, N);
    const d = depth[open] + 1;
    let pb = -1;
    let ob = -1;
    let fr = -1;
    for (let i = open + 1; i < close; i++) {
      if (depth[i] !== d) continue;
      if (is(i, 'PARTITION') && is(i + 1, 'BY')) pb = i + 2;
      else if (is(i, 'ORDER') && is(i + 1, 'BY')) ob = i + 2;
      else if ((is(i, 'ROWS') || is(i, 'RANGE')) && fr < 0) fr = i;
    }
    const base = (named && T[open + 1]?.t === 'ident' && named.get(T[open + 1].u)) || {};
    const pEnd = ob > pb ? ob - 2 : fr > pb ? fr : close;
    const oEnd = fr > ob ? fr : close;
    return {
      partition: pb >= 0 ? keyText(pb, pEnd, 60) : base.partition || '',
      order: ob >= 0 ? squash(slice(ob, oEnd - 1), 60) : base.order || '',
      orderKeys: ob >= 0 ? orderKeys(ob, oEnd) : base.orderKeys || [],
      frame: fr >= 0 ? squash(slice(fr, close - 1), 70) : base.frame || '',
      close,
    };
  }

  function recordShape(owner, clauses, b, sd) {
    let sh = shapes.get(owner);
    if (!sh) {
      sh = { branches: 1, columns: 0, star: false, distinct: false, filters: [], groupBy: [], aggregates: [],
        aggArgs: [], windows: [], having: [], qualify: [], limit: null, orderBy: null };
      shapes.set(owner, sh);
    }
    let firstItems = null;
    if (clauses.some((c) => c.kw === 'FROM')) sh.hasFrom = true;
    // The WINDOW clause comes after SELECT, so named windows are read on first use.
    const namedByBranch = new Map();
    const namedWindows = (branch) => {
      if (!namedByBranch.has(branch)) {
        const ci = clauses.findIndex((c) => c.kw === 'WINDOW' && c.branch === branch);
        namedByBranch.set(branch, ci < 0 ? new Map() : readNamedWindows(clauses[ci].body, ci + 1 < clauses.length ? clauses[ci + 1].i : b, sd));
      }
      return namedByBranch.get(branch);
    };
    clauses.forEach((c, ci) => {
      const end = ci + 1 < clauses.length ? clauses[ci + 1].i : b;
      const body = c.body;
      if (c.kw === 'SETOP') { sh.branches++; return; }
      if (c.kw === 'SELECT') {
        let j = body;
        if (is(j, 'DISTINCT')) {
          sh.distinct = true;
          j++;
          // Postgres DISTINCT ON (keys): one row per key, the first in ORDER BY order
          if (is(j, 'ON') && txt(j + 1) === '(' && match[j + 1] > j) {
            if (c.branch === 0) sh.distinctOn = keyText(j + 2, match[j + 1], 60);
            j = match[j + 1] + 1;
          }
        }
        if (is(j, 'ALL')) j++;
        // SQL Server: TOP n / TOP (n) [PERCENT] [WITH TIES]
        if (TSQL && is(j, 'TOP')) {
          const paren = txt(j + 1) === '(' && match[j + 1] > j;
          if (c.branch === 0) sh.limit = squash(paren ? slice(j + 2, match[j + 1] - 1) : slice(j + 1, j + 1), 20);
          j = paren ? match[j + 1] + 1 : j + 2;
          if (is(j, 'PERCENT')) j++;
          if (is(j, 'WITH') && is(j + 1, 'TIES')) j += 2;
        }
        if (is(j, 'AS') && (is(j + 1, 'STRUCT') || is(j + 1, 'VALUE'))) j += 2;
        const items = splitTop(j, end, sd, ',').map(([x, y]) => ({ x, y, alias: selectItemAlias(x, y) }));
        if (c.branch === 0 && !firstItems) {
          firstItems = items;
          sh.columns = items.length;
          sh.items = items;
        }
        for (const it of items) {
          if (txt(it.x) === '*' || (txt(it.y - 1) === '*' && txt(it.y - 2) === '.') ||
              items.some(() => false)) sh.star = true;
          for (let i = it.x; i < it.y; i++) {
            // Aggregates inside a scalar / ARRAY subquery belong to that subquery, not this step.
            if (txt(i) === '(' && T[i].t === 'punct' && isSubqueryStart(i + 1)) { i = closeOf(i, it.y); continue; }
            if (txt(i) === '*' && (i === it.x || txt(i - 1) === '.') && depth[i] === sd) sh.star = true;
            if (T[i].t !== 'ident' || txt(i + 1) !== '(' || txt(i - 1) === '.') continue;
            const close = closeOf(i + 1, it.y);
            if (is(close + 1, 'OVER') && (txt(close + 2) === '(' || T[close + 2]?.t === 'ident')) {
              const named = namedWindows(c.branch);
              const w = txt(close + 2) === '('
                ? readOver(close + 2, named)
                : { ...(named.get(T[close + 2].u) || { partition: '', order: '', orderKeys: [], frame: '' }), close: close + 2 };
              const args = keyText(i + 2, close, 50);
              sh.windows.push({ fn: T[i].u, args, alias: it.alias, partition: w.partition, order: w.order,
                orderKeys: w.orderKeys, frame: w.frame, text: squash(slice(i, w.close), 200), from: T[i].a, to: T[w.close].b });
              if (T[i].u === 'LAST_VALUE' && w.orderKeys.length && !w.frame) {
                diags.push({ from: T[i].a, to: T[close + 1].b, severity: 'warning',
                  message: 'LAST_VALUE with ORDER BY and no frame returns the current row\'s value (the default frame ends at the current row). Add ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING.' });
              }
              i = w.close;
            } else if (AGGREGATES.has(T[i].u)) {
              const fn = T[i].u + (is(i + 2, 'DISTINCT') ? ' DISTINCT' : '');
              if (!sh.aggregates.includes(fn)) sh.aggregates.push(fn);
              // Which FROM items it adds up: the `x.` of each `x.col` inside it.
              const aliases = new Set();
              for (let k = i + 2; k < close; k++) {
                if ((T[k].t === 'ident' || T[k].t === 'qident') && txt(k + 1) === '.' && txt(k - 1) !== '.') aliases.add(unquoteIdent(T[k].s).toLowerCase());
              }
              sh.aggArgs.push({ fn, text: squash(slice(i, close), 50), aliases, from: T[i].a, to: T[close].b });
            }
          }
        }
      } else if (c.kw === 'WHERE' || c.kw === 'HAVING' || c.kw === 'QUALIFY') {
        condRanges.push({ owner, a: body, b: end });
        const list = c.kw === 'WHERE' ? sh.filters : c.kw === 'HAVING' ? sh.having : sh.qualify;
        for (const [x, y] of splitAnd(body, end, sd)) {
          const text = squash(slice(x, y - 1), 90);
          if (!TRIVIAL.test(text)) list.push(text);
        }
      } else if (c.kw === 'GROUP BY') {
        if (is(body, 'ALL')) { sh.groupBy.push('ALL'); sh.grain = null; return; }
        const grain = [];
        for (const [x, y] of splitTop(body, end, sd, ',')) {
          grain.push(groupKeyColumn(x, y, firstItems));
          let key = squash(slice(x, y - 1), 40);
          if (y === x + 1 && T[x].t === 'number' && firstItems) {
            const item = firstItems[Number(T[x].s) - 1];
            if (item) key = item.alias || squash(slice(item.x, item.y - 1), 40);
          } else if (y > x) {
            const p = readPath(x);
            if (p && p.end === y) key = p.parts[p.parts.length - 1];
          }
          sh.groupBy.push(key);
        }
        if (sh.grain === undefined) sh.grain = grain.every(Boolean) ? grain : null;
      } else if (c.kw === 'LIMIT') {
        sh.limit = squash(slice(body, end - 1), 20);
      } else if (c.kw === 'ORDER BY') {
        sh.orderBy = squash(slice(body, end - 1), 40);
      }
    });
    // The grain: the output columns that are unique per row ([] = a single row).
    if (sh.branches > 1) sh.grain = null;
    else if (sh.grain === undefined && sh.aggregates.length && !sh.groupBy.length) sh.grain = [];
  }

  // The output column a GROUP BY key is: `GROUP BY 2`, an output alias, or an
  // expression that is also a SELECT item. null when it isn't one.
  function groupKeyColumn(x, y, items) {
    if (!items) return null;
    if (y === x + 1 && T[x].t === 'number') return items[Number(T[x].s) - 1]?.alias || null;
    const norm = (s) => s.replace(/[\s`"]+/g, '').toLowerCase();
    const key = norm(slice(x, y - 1));
    for (const it of items) {
      if (!it.alias) continue;
      let e = it.y - 1;
      for (let i = it.x + 1; i < it.y; i++) if (is(i, 'AS') && depth[i] === depth[it.x]) { e = i - 1; break; }
      if (norm(slice(it.x, e)) === key || norm(it.alias) === key) return it.alias;
    }
    return null;
  }

  // ---- outer joins undone later -------------------------------------------
  // A LEFT JOIN keeps rows with no match, with NULL in the joined columns. A
  // WHERE condition (or a later INNER JOIN's ON) on those columns is false for
  // NULL, so it drops exactly those rows and the LEFT JOIN acts as an INNER JOIN.
  const itemKey = (it) => (it.alias || bareName((it.name || '').split('.').pop())).toLowerCase();
  // Conditions that say what NULL should do: IS [NOT] NULL, OR, COALESCE, …
  function nullAware(x, y) {
    for (let i = x; i < y; i++) {
      if (T[i].t !== 'ident') continue;
      const u = T[i].u;
      if (u === 'IS' || u === 'OR' || u === 'CASE' || (['COALESCE', 'IFNULL', 'IF'].includes(u) && txt(i + 1) === '(')) return true;
    }
    return false;
  }
  // The first `alias.col` in [x, y) whose alias is a key of `aliases`, outside subqueries.
  function refTo(x, y, aliases) {
    const word = (i) => T[i] && (T[i].t === 'ident' || T[i].t === 'qident');
    for (let i = x; i < y; i++) {
      if (txt(i) === '(' && T[i].t === 'punct' && isSubqueryStart(i + 1)) { i = closeOf(i, y); continue; }
      if (word(i) && txt(i - 1) !== '.' && txt(i + 1) === '.' && word(i + 2) && aliases.has(unquoteIdent(T[i].s).toLowerCase())) {
        return { alias: unquoteIdent(T[i].s), col: unquoteIdent(T[i + 2].s), by: aliases.get(unquoteIdent(T[i].s).toLowerCase()) };
      }
    }
    return null;
  }
  function checkOuterJoins(clauses, b, sd) {
    clauses.forEach((c, ci) => {
      if (c.kw !== 'FROM' || !c.items?.length) return;
      const nullable = new Map(); // alias -> the outer join that can leave it NULL
      const flag = (x, y, inner) => {
        if (nullAware(x, y)) return;
        const hit = refTo(x, y, nullable);
        if (!hit) return;
        const jt = hit.by.joinType;
        const ref = `${hit.alias}.${hit.col}`;
        diags.push({ from: T[x].a, to: T[y - 1].b, severity: 'warning', message: inner
          ? `The ${jt} JOIN keeps rows with no match in ${hit.alias}, but this INNER JOIN needs ${ref}, so it drops them again. Make this join ${jt} too if those rows should stay.`
          : `The ${jt} JOIN keeps rows with no match in ${hit.alias}, but this condition drops them (${ref} is NULL there), so it works as an INNER JOIN. To keep them, move the condition into the join's ON, or add OR ${ref} IS NULL.` });
      };
      c.items.forEach((it, k) => {
        if (it.joinType === 'INNER' && nullable.size && it.onRange) {
          for (const [x, y] of splitAnd(it.onRange[0], it.onRange[1], sd)) flag(x, y, true);
        }
        const outer = (p) => { const key = itemKey(p); if (key) nullable.set(key, it); };
        if (it.joinType === 'LEFT' || it.joinType === 'FULL') outer(it);
        if (it.joinType === 'RIGHT' || it.joinType === 'FULL') c.items.slice(0, k).forEach(outer);
      });
      if (!nullable.size) return;
      const wi = clauses.findIndex((w, i) => i > ci && w.branch === c.branch && w.kw === 'WHERE');
      if (wi < 0) return;
      const end = wi + 1 < clauses.length ? clauses[wi + 1].i : b;
      for (const [x, y] of splitAnd(clauses[wi].body, end, sd)) flag(x, y, false);
    });
  }

  function parseQuery(a, b, owner, opts = {}) {
    if (a >= b) return;
    const sd = depth[a];
    let k = a;
    let pushed = false;
    if (is(k, 'WITH')) {
      k = parseWith(k + 1, b);
      pushed = true;
    }
    let orderTok = -1;
    let hasLimit = false;
    const clauses = []; // { kw, i: keyword token, body: first body token, branch }
    let branch = 0;
    while (k < b) {
      const t = T[k];
      if (t.s === '(' && t.t === 'punct') {
        if (isSubqueryStart(k + 1)) {
          const close = closeOf(k, b);
          parseInline(k, close, owner);
          k = close + 1;
          continue;
        }
        k++;
        continue;
      }
      if (depth[k] === sd && t.t === 'ident') {
        const w = t.u;
        if (w === 'FROM') {
          const c = { kw: 'FROM', i: k, body: k + 1, branch };
          clauses.push(c);
          k = parseFrom(k + 1, b, owner, sd);
          c.items = lastFromItems;
          continue;
        }
        if (w === 'SELECT' || w === 'WHERE' || w === 'HAVING' || w === 'QUALIFY' || w === 'LIMIT' || w === 'WINDOW' ||
            (w === 'INTO' && clauses[clauses.length - 1]?.kw === 'SELECT')) {
          clauses.push({ kw: w, i: k, body: k + 1, branch });
        } else if ((w === 'GROUP' || w === 'ORDER') && is(k + 1, 'BY')) {
          clauses.push({ kw: w + ' BY', i: k, body: k + 2, branch });
        }
        if (w === 'ORDER' && is(k + 1, 'BY')) orderTok = k;
        else if (w === 'LIMIT' || (!BQ && (w === 'OFFSET' || w === 'FETCH')) || (w === 'TOP' && ['SELECT', 'DISTINCT', 'ALL'].includes(up(k - 1)))) hasLimit = true;
        else if (w === 'UNION' || w === 'INTERSECT' || (w === 'EXCEPT' && (txt(k + 1) !== '(' || isSubqueryStart(k + 1)))) {
          clauses.push({ kw: 'SETOP', i: k, body: k + 1, branch });
          branch++;
          const nx = up(k + 1);
          if (BQ && nx !== 'ALL' && nx !== 'DISTINCT') {
            diags.push({ from: t.a, to: t.b, severity: 'error', message: `BigQuery requires ${w} ALL or ${w} DISTINCT` });
          }
          orderTok = -1;
          hasLimit = false;
        }
      }
      k++;
    }
    if (!opts.inline && clauses.length) recordShape(owner, clauses, b, sd);
    checkOuterJoins(clauses, b, sd);
    if (opts.nested && !opts.inline && orderTok >= 0 && !hasLimit && !shapes.get(owner)?.distinctOn) {
      const where = opts.kind === 'cte' ? 'CTE' : 'subquery';
      diags.push(TSQL
        ? { from: T[orderTok].a, to: T[orderTok + 1].b, severity: 'error', message: `SQL Server does not allow ORDER BY in a ${where} without TOP or OFFSET … FETCH` }
        : { from: T[orderTok].a, to: T[orderTok + 1].b, severity: 'info', message: `ORDER BY inside a ${where} without LIMIT does not affect the final result` });
    }
    if (pushed) cteStack.pop();
  }

  // ---- statements -------------------------------------------------------
  const stmts = [];
  {
    let s = 0;
    let selects = 0; // depth-0 SELECTs in the current statement
    for (let i = 0; i < N; i++) {
      if (T[i].s === ';' && depth[i] === 0) {
        stmts.push([s, i]);
        s = i + 1;
        selects = 0;
        continue;
      }
      if (!TSQL || depth[i] !== 0) continue;
      // SQL Server scripts often leave out the semicolons, and GO ends a batch.
      if (is(i, 'GO') && T[i].a === lineStartAt(T[i].a)) {
        if (i > s) stmts.push([s, i]);
        s = i + 1;
        selects = 0;
        continue;
      }
      if (i > s && startsStatement(i, s, selects)) {
        stmts.push([s, i]);
        s = i;
        selects = 0;
      }
      if (is(i, 'SELECT')) selects++;
    }
    if (s < N) stmts.push([s, N]);
  }
  // The table of `SELECT … INTO t FROM …` in statement [s, e), or null.
  function selectInto(s, e) {
    if (!TSQL && D.id !== 'postgres') return null;
    let j = s;
    while (j < e && !(depth[j] === 0 && is(j, 'SELECT'))) j++;
    for (; j < e && !(depth[j] === 0 && is(j, 'FROM')); j++) {
      if (depth[j] === 0 && is(j, 'INTO') && (T[j + 1]?.t === 'ident' || T[j + 1]?.t === 'qident')) return readPath(j + 1);
    }
    return null;
  }

  // A statement's end: after its `;`, or its last token when GO or the next statement ends it.
  function stmtEndAt(e) { return txt(e) === ';' ? T[e].b : T[e - 1].b; }
  const resultStmts = stmts.filter(([s, e]) => (['SELECT', 'WITH'].includes(up(s)) || txt(s) === '(') && !selectInto(s, e)).length;

  const variables = [];
  const assignTargets = new Set(); // SQL Server: where SET @x = … writes a variable (not a use)
  const inDeclare = new Uint8Array(N); // tokens of variable-defining statements
  let lastDeclareEnd = -1; // char offset after the last leading DECLARE / SET @var statement
  let seenOther = false;

  // The editable part of a variable's value [vs, ve]: a string, typed string, number or expression.
  const valueEdit = (vs, ve) => {
    if (vs === ve && T[vs].t === 'string') return { ...stringInner(T[vs]), kind: 'string' };
    if (ve === vs + 1 && TYPED_LITERAL.has(up(vs)) && T[ve].t === 'string') return { ...stringInner(T[ve]), kind: 'string', wrap: T[vs].u };
    if (vs === ve && T[vs].t === 'number') return { from: T[vs].a, to: T[vs].b, kind: 'number' };
    return { from: T[vs].a, to: T[ve].b, kind: 'expr' };
  };
  const setValue = (v, vs, ve) => {
    if (vs > ve) return;
    v.valueText = slice(vs, ve);
    v.edit = valueEdit(vs, ve);
    v.value = src.slice(v.edit.from, v.edit.to);
  };

  for (let si = 0; si < stmts.length; si++) {
    const [s, e] = stmts[si];
    if (s >= e) continue;
    const first = up(s);
    const stmtEnd = stmtEndAt(e);

    if (first === 'DECLARE' && D.vars === 'declare') {
      for (let i = s; i < e; i++) inDeclare[i] = 1;
      if (seenOther) {
        diags.push({ from: T[s].a, to: T[s].b, severity: 'error', message: 'DECLARE must come before all other statements in a BigQuery script' });
      }
      let k = s + 1;
      const names = [];
      while (k < e && (T[k].t === 'ident' || T[k].t === 'qident')) {
        names.push(T[k]);
        k++;
        if (txt(k) === ',') k++;
        else break;
      }
      let def = -1;
      for (let j = k; j < e; j++) if (is(j, 'DEFAULT') && depth[j] === 0) { def = j; break; }
      const typeEnd = def >= 0 ? def : e;
      const type = typeEnd > k ? slice(k, typeEnd - 1) : '';
      const v = {
        kind: 'declare',
        names: names.map((n) => unquoteIdent(n.s)),
        nameToks: names.map((n) => ({ from: n.a, to: n.b })),
        type,
        stmt: { from: T[s].a, to: stmtEnd },
        refs: [],
      };
      if (def >= 0) setValue(v, def + 1, e - 1);
      variables.push(v);
      for (const nt of names) marks.push({ from: nt.a, to: nt.b, cls: 'cm-lens-var cm-lens-def' });
      lastDeclareEnd = stmtEnd;
      continue;
    }

    // SQL Server: DECLARE @a INT = 1, @b DATE;  The names keep their @.
    if (first === 'DECLARE' && D.vars === 'tsql') {
      for (let i = s; i < e; i++) inDeclare[i] = 1;
      for (const [x, y] of splitTop(s + 1, e, 0, ',')) {
        if (T[x].t !== 'param') continue;
        let eq = -1;
        for (let j = x + 1; j < y; j++) if (txt(j) === '=' && depth[j] === 0) { eq = j; break; }
        const k = is(x + 1, 'AS') ? x + 2 : x + 1;
        const typeEnd = eq >= 0 ? eq : y;
        const v = { kind: 'declare', names: [T[x].s], nameToks: [{ from: T[x].a, to: T[x].b }], type: typeEnd > k ? slice(k, typeEnd - 1) : '', stmt: { from: T[s].a, to: stmtEnd }, refs: [] };
        if (eq >= 0) setValue(v, eq + 1, y - 1);
        variables.push(v);
        marks.push({ from: T[x].a, to: T[x].b, cls: 'cm-lens-var cm-lens-def' });
      }
      if (!seenOther) lastDeclareEnd = stmtEnd;
      continue;
    }
    // … and SET @b = '2024-01-01': the value of a variable declared without one.
    if (first === 'SET' && D.vars === 'tsql' && T[s + 1]?.t === 'param' && txt(s + 2) === '=') {
      for (let i = s; i < e; i++) inDeclare[i] = 1;
      assignTargets.add(T[s + 1].a);
      const v = variables.find((x) => x.names[0].toLowerCase() === T[s + 1].s.toLowerCase());
      if (v && !v.edit) { setValue(v, s + 3, e - 1); v.stmt = { from: v.stmt.from, to: stmtEnd }; }
      if (!seenOther) lastDeclareEnd = stmtEnd;
      continue;
    }

    // MySQL user variables: SET @a = 1, @b := 'x';  The names keep their @.
    if (first === 'SET' && D.vars === 'set' && T[s + 1]?.t === 'param') {
      for (let i = s; i < e; i++) inDeclare[i] = 1;
      for (const [x, y] of splitTop(s + 1, e, 0, ',')) {
        if (T[x].t !== 'param' || !(txt(x + 1) === '=' || txt(x + 1) === ':=')) continue;
        const v = { kind: 'set', names: [T[x].s], nameToks: [{ from: T[x].a, to: T[x].b }], type: '', stmt: { from: T[s].a, to: stmtEnd }, refs: [] };
        setValue(v, x + 2, y - 1);
        variables.push(v);
        marks.push({ from: T[x].a, to: T[x].b, cls: 'cm-lens-var cm-lens-def' });
      }
      if (!seenOther) lastDeclareEnd = stmtEnd;
      continue;
    }

    seenOther = true;
    if (first === 'SET') continue;

    let k = s;
    let owner;
    let into;
    if (first === 'CREATE') {
      let temp = false;
      let j = s + 1;
      while (j < e && T[j].t === 'ident' && !['TABLE', 'VIEW', 'FUNCTION', 'PROCEDURE', 'SCHEMA'].includes(T[j].u)) {
        if (T[j].u === 'TEMP' || T[j].u === 'TEMPORARY') temp = true;
        j++;
      }
      if (!['TABLE', 'VIEW'].includes(up(j))) continue;
      j++;
      if (is(j, 'IF') && is(j + 1, 'NOT') && is(j + 2, 'EXISTS')) j += 3;
      const p = readPath(j);
      if (!p) continue;
      const full = p.parts.join('.');
      if (full.startsWith('#')) temp = true; // SQL Server #temp tables
      owner = (temp ? 'tmp:' : 'tbl:') + full.toLowerCase();
      ensureNode(owner, { kind: 'created', label: p.parts[p.parts.length - 1], sub: temp ? 'temp table' : p.parts.slice(0, -1).join('.'), full, def: { from: p.from, to: p.to } });
      nodes.get(owner).kind = 'created';
      nodes.get(owner).refs.push({ from: p.from, to: p.to });
      marks.push({ from: p.from, to: p.to, cls: 'cm-lens-table cm-lens-def' });
      created.set(full.toLowerCase(), owner);
      if (temp) created.set(p.parts[p.parts.length - 1].toLowerCase(), owner);
      k = p.end;
      // … AS SELECT, or MySQL's CREATE TABLE t SELECT … (no AS)
      while (k < e && !(depth[k] === 0 && (is(k, 'AS') || is(k, 'SELECT') || (is(k, 'WITH') && txt(k + 1) !== '(')))) k++;
      if (is(k, 'AS')) k++;
    } else if (first === 'INSERT' || first === 'MERGE' || first === 'UPDATE' || first === 'DELETE') {
      let j = s + 1;
      if (is(j, 'INTO') || is(j, 'FROM')) j++;
      const p = readTarget(j);
      if (!p) continue;
      const full = p.parts.join('.');
      owner = created.get(full.toLowerCase()) || 'tbl:' + full.toLowerCase();
      ensureNode(owner, { kind: 'created', label: p.parts[p.parts.length - 1], sub: p.parts.slice(0, -1).join('.'), full, def: { from: p.from, to: p.to } });
      nodes.get(owner).kind = 'created';
      nodes.get(owner).refs.push({ from: p.from, to: p.to });
      marks.push({ from: p.from, to: p.to, cls: 'cm-lens-table cm-lens-def' });
      k = p.end;
    } else if ((into = selectInto(s, e))) {
      // SELECT … INTO new_table FROM … (SQL Server, Postgres) creates the table
      const p = into;
      const full = p.parts.join('.');
      const temp = full.startsWith('#');
      owner = (temp ? 'tmp:' : 'tbl:') + full.toLowerCase();
      ensureNode(owner, { kind: 'created', label: p.parts[p.parts.length - 1], sub: temp ? 'temp table' : p.parts.slice(0, -1).join('.'), full, def: { from: p.from, to: p.to } });
      nodes.get(owner).kind = 'created';
      nodes.get(owner).refs.push({ from: p.from, to: p.to });
      marks.push({ from: p.from, to: p.to, cls: 'cm-lens-table cm-lens-def' });
      created.set(full.toLowerCase(), owner);
    } else {
      resultCount++;
      owner = 'result:' + resultCount;
      pendingOwners.set(owner, {
        kind: 'result',
        label: resultStmts > 1 ? `Result ${resultCount}` : 'Result',
        def: { from: T[s].a, to: T[s].b },
        order: T[e - 1].b,
        spans: [{ from: T[s].a, to: T[e - 1].b }],
      });
    }
    if (nodes.has(owner)) {
      const on = nodes.get(owner);
      on.order = T[e - 1].b;
      (on.spans ||= []).push({ from: T[s].a, to: T[e - 1].b });
    }
    parseQuery(k, e, owner);
  }

  // ---- variables: references & shadowing ---------------------------------
  // BigQuery variables are bare names; MySQL and SQL Server ones are @name (param tokens).
  const varByName = new Map();
  for (const v of variables) for (const n of v.names) varByName.set(n.toLowerCase(), v);
  const varTok = D.vars === 'set' || D.vars === 'tsql' ? 'param' : 'ident';
  const isVarDef = (t) => variables.some((v) => v.nameToks.some((nt) => nt.from === t.a));
  const qualifiedNames = new Set();
  for (let i = 1; i < N; i++) {
    if (txt(i - 1) === '.' && T[i].t === 'ident') qualifiedNames.add(T[i].s.toLowerCase());
  }
  for (let i = 0; i < N; i++) {
    const t = T[i];
    if (t.t !== varTok || inDeclare[i] && isVarDef(t)) continue;
    const v = varByName.get(t.s.toLowerCase());
    if (!v) continue;
    if (txt(i - 1) === '.' || txt(i + 1) === '.' || (txt(i + 1) === '(' && T[i + 1].a === t.b)) continue;
    v.refs.push({ from: t.a, to: t.b });
    marks.push({ from: t.a, to: t.b, cls: 'cm-lens-var' });
  }
  for (const v of variables) {
    v.names.forEach((name, idx) => {
      const nt = v.nameToks[idx];
      if (!v.refs.some((r) => !assignTargets.has(r.from))) {
        diags.push({ from: nt.from, to: nt.to, severity: 'warning', message: `Variable "${name}" is ${v.kind === 'set' ? 'set' : 'declared'} but never used` });
      }
      if (BQ && qualifiedNames.has(name.toLowerCase())) {
        diags.push({ from: nt.from, to: nt.to, severity: 'warning',
          message: `A column is also named "${name}" — in BigQuery the column wins over the variable. Consider renaming (e.g. v_${name}).` });
      }
    });
  }

  // ---- query parameters -------------------------------------------------
  // @x in BigQuery, $1 / :x in Postgres, and in MySQL any @x that no SET defines.
  const paramMap = new Map();
  for (let i = 0; i < N; i++) {
    const t = T[i];
    if (t.t !== 'param' || !t.name || (varTok === 'param' && varByName.has(t.s.toLowerCase()))) continue;
    const key = t.sigil + t.name.toLowerCase();
    if (!paramMap.has(key)) paramMap.set(key, { name: t.name, sigil: t.sigil, text: t.sigil + t.name, refs: [] });
    const p = paramMap.get(key);
    p.refs.push({ from: t.a, to: t.b });
    if (txt(i + 1) === ':=') p.assigned = true; // MySQL: SELECT @rn := @rn + 1
    marks.push({ from: t.a, to: t.b, cls: 'cm-lens-var cm-lens-param' });
  }
  const params = [...paramMap.values()];
  for (const p of params) {
    if (p.assigned) continue;
    const r = p.refs[0];
    diags.push({ from: r.from, to: r.to, severity: 'info', message: D.paramLint(p.text) });
  }

  // ---- hardcoded literal filters ----------------------------------------
  const groups = new Map();
  const inParens = new Map(); // '(' token of an IN list -> label
  // For `x BETWEEN <lo> AND <hi>`: given the token ending <lo>, return the
  // BETWEEN token index (or -1). <lo> may be a literal, variable, param or call.
  const betweenStartBefore = (j) => {
    let st;
    if (j < 0) return -1;
    if (T[j].t === 'string' || T[j].t === 'number' || T[j].t === 'param') {
      st = j;
      if (T[j].t === 'string' && TYPED_LITERAL.has(up(j - 1))) st = j - 1;
      if (T[j].t === 'number' && txt(j - 1) === '-') st = j - 1;
    } else {
      const o = operandBefore(j);
      if (!o) return -1;
      st = o.i;
    }
    return is(st - 1, 'BETWEEN') ? st - 1 : -1;
  };
  for (let i = 0; i < N; i++) {
    if (inDeclare[i]) continue;
    let lit = null;
    const t = T[i];
    if (t.t === 'ident' && TYPED_LITERAL.has(t.u) && i + 1 < N && T[i + 1].t === 'string') {
      lit = { i, j: i + 1, kind: 'string', strTok: T[i + 1], typed: t.u };
    } else if (t.t === 'string' && !(i > 0 && T[i - 1].t === 'ident' && TYPED_LITERAL.has(T[i - 1].u))) {
      lit = { i, j: i, kind: 'string', strTok: t };
    } else if (t.t === 'number') {
      const neg = i > 0 && txt(i - 1) === '-' && T[i - 1].b === t.a && (i < 2 || T[i - 2].t === 'op' || ['(', ','].includes(txt(i - 2)) || RES.has(up(i - 2)));
      lit = { i: neg ? i - 1 : i, j: i, kind: 'number' };
    }
    if (!lit) continue;
    const pi = lit.i - 1;
    const nj = lit.j + 1;
    // A window frame size (ROWS BETWEEN 6 PRECEDING …) is not a filter value.
    if (is(nj, 'PRECEDING') || is(nj, 'FOLLOWING')) continue;
    const prev = txt(pi);
    const next = txt(nj);
    let label = null;
    let op = null;

    if (pi >= 0 && T[pi].t === 'op' && COMPARE.has(prev)) {
      const o = operandBefore(pi - 1);
      op = prev;
      label = o ? `${squash(slice(o.i, o.j), 36)} ${prev}` : prev;
    } else if (up(pi) === 'LIKE') {
      const o = operandBefore(is(pi - 1, 'NOT') ? pi - 2 : pi - 1);
      label = o ? `${squash(slice(o.i, o.j), 36)} LIKE` : 'LIKE';
    } else if (up(pi) === 'BETWEEN') {
      const o = operandBefore(is(pi - 1, 'NOT') ? pi - 2 : pi - 1);
      label = o ? `${squash(slice(o.i, o.j), 36)} BETWEEN` : 'BETWEEN';
    } else if (up(pi) === 'AND' && betweenStartBefore(pi - 1) >= 0) {
      const bt = betweenStartBefore(pi - 1);
      const o = operandBefore(is(bt - 1, 'NOT') ? bt - 2 : bt - 1);
      label = (o ? `${squash(slice(o.i, o.j), 36)} BETWEEN` : 'BETWEEN') + ' (end)';
    } else if ((prev === '(' || prev === ',') && parent[lit.i] >= 0 && up(parent[lit.i] - 1) === 'IN') {
      const inTok = parent[lit.i] - 1;
      const o = operandBefore(is(inTok - 1, 'NOT') ? inTok - 2 : inTok - 1);
      label = o ? `${squash(slice(o.i, o.j), 36)} IN (…)` : 'IN (…)';
      if (!inParens.has(parent[lit.i])) inParens.set(parent[lit.i], label);
    } else if (up(pi) === 'INTERVAL' && lit.kind === 'number') {
      label = `INTERVAL · ${up(nj) || ''}`.trim();
    } else if (up(pi) === 'INTERVAL' && lit.kind === 'string') {
      label = 'INTERVAL';
    } else if (nj < N && T[nj].t === 'op' && COMPARE.has(next)) {
      const o = operandAfter(nj + 1);
      label = o ? `${next} ${squash(slice(o.i, o.j), 36)}` : next;
    }
    if (!label) continue;

    let edit;
    let value;
    if (lit.kind === 'string') {
      edit = stringInner(lit.strTok);
      value = src.slice(edit.from, edit.to);
    } else {
      edit = { from: T[lit.i].a, to: T[lit.j].b };
      value = src.slice(edit.from, edit.to);
    }
    const key = lit.kind === 'string' ? 's:' + value : 'n:' + value + '|' + label.replace(/\s*\(end\)$/, '');
    if (!groups.has(key)) groups.set(key, { key, kind: lit.kind, value, occ: [], labels: [] });
    const g = groups.get(key);
    g.occ.push({ from: T[lit.i].a, to: T[lit.j].b, edit, label, typed: lit.typed || null, text: src.slice(T[lit.i].a, T[lit.j].b) });
    if (!g.labels.includes(label)) g.labels.push(label);
  }
  const literals = [...groups.values()];

  // IN lists made only of literals: IN ('SG', 'MY', 'PH'). These can become a
  // single ARRAY variable used as IN UNNEST(v).
  const inLists = [];
  for (const [p, label] of D.arrays ? inParens : []) {
    const close = match[p];
    if (close < 0) continue;
    const items = [];
    let kind = null;
    let typed = null;
    let ok = true;
    let k = p + 1;
    while (k < close) {
      let a = k;
      let b;
      let kk;
      if (T[k].t === 'ident' && TYPED_LITERAL.has(T[k].u) && T[k + 1]?.t === 'string') { b = k + 1; kk = 'string'; typed = T[k].u; }
      else if (T[k].t === 'string') { b = k; kk = 'string'; }
      else if (T[k].t === 'number') { b = k; kk = 'number'; }
      else if (T[k].s === '-' && T[k + 1]?.t === 'number') { b = k + 1; kk = 'number'; }
      else { ok = false; break; }
      if (kind && kind !== kk) { ok = false; break; }
      kind = kk;
      items.push(src.slice(T[a].a, T[b].b));
      k = b + 1;
      if (k < close) {
        if (T[k].s !== ',') { ok = false; break; }
        k++;
      }
    }
    if (ok && items.length) {
      const first = T[p + 1].t === 'string' ? stringInner(T[p + 1]).from : null;
      inLists.push({
        from: T[p].a, to: T[close].b, items, kind, typed, label,
        sample: first !== null ? src.slice(first, stringInner(T[p + 1]).to) : items[0],
      });
    }
  }
  for (const g of literals) {
    if (g.occ.some((o) => o.label.endsWith('IN (…)'))) continue;
    const v = variables.find((v) => v.value !== undefined && v.value === g.value && v.edit?.kind !== 'expr');
    if (v) g.sameAsVar = v.names[0];
  }

  // ---- unused CTEs ------------------------------------------------------
  const hasOut = new Set([...edges.values()].map((e) => e.from));
  for (const c of cteDefs) {
    if (!hasOut.has(c.id)) {
      diags.push({ from: c.tok.a, to: c.tok.b, severity: 'warning', message: `CTE "${unquoteIdent(c.tok.s)}" is defined but never used` });
      nodes.get(c.id).unused = true;
    }
  }

  // ---- misc lint --------------------------------------------------------
  for (let i = 0; i < N; i++) {
    const t = T[i];
    if (t.t === 'op' && COMPARE.has(t.s) && is(i + 1, 'NULL')) {
      diags.push({ from: t.a, to: T[i + 1].b, severity: 'error',
        message: `"${t.s} NULL" is never true — use IS ${t.s === '=' ? '' : 'NOT '}NULL` });
    }
    if (is(i, 'SELECT')) {
      let j = i + 1;
      while (is(j, 'DISTINCT') || is(j, 'ALL') || (is(j, 'AS') && (is(j + 1, 'STRUCT') || is(j + 1, 'VALUE')))) j += is(j, 'AS') ? 2 : 1;
      if (BQ && txt(j) === '*') {
        diags.push({ from: T[j].a, to: T[j].b, severity: 'info', message: 'SELECT * reads every column — BigQuery bills by columns scanned' });
      }
    }
    if (is(i, 'NOT') && is(i + 1, 'IN') && txt(i + 2) === '(' && isSubqueryStart(i + 3)) {
      diags.push({ from: t.a, to: T[i + 1].b, severity: 'info',
        message: 'NOT IN (subquery) returns no rows if the subquery yields any NULL — NOT EXISTS is safer' });
    }
  }

  // ---- graph output -----------------------------------------------------
  const nodeList = [...nodes.values()];
  const edgeList = [...edges.values()].filter((e) => nodes.has(e.from) && nodes.has(e.to));
  for (const n of nodeList) {
    n.in = edgeList.filter((e) => e.to === n.id).map((e) => e.from);
    n.out = edgeList.filter((e) => e.from === n.id).map((e) => e.to);
    n.blocks = blocks.get(n.id) || [];
    n.shape = shapes.get(n.id) || null;
  }
  detectDedupe(nodeList, edgeList);

  // ---- join partners ------------------------------------------------------
  // The earlier FROM items each join's ON names (`e.dept_id = d.dept_id` ties d to e),
  // so the graph can say which table a join attaches to, not only on which columns.
  // A second item whose condition names no alias (USING, bare columns) joins the first.
  for (const n of nodeList) {
    for (const items of n.blocks) {
      items.forEach((it, j) => {
        if (!j || it.joinType === 'CROSS' || it.joinType === 'COMMA') return;
        const named = new Set();
        if (it.onRange) {
          for (let i = it.onRange[0]; i + 1 < it.onRange[1]; i++) {
            if ((T[i].t === 'ident' || T[i].t === 'qident') && txt(i + 1) === '.' && txt(i - 1) !== '.') named.add(unquoteIdent(T[i].s).toLowerCase());
          }
        }
        named.delete(itemKey(it));
        const earlier = items.slice(0, j);
        const partners = earlier.filter((p) => named.has(itemKey(p)));
        it.partners = partners.length ? partners : j === 1 && !named.size ? [earlier[0]] : [];
      });
    }
  }

  // ---- joins that repeat rows (fan-out) -----------------------------------
  // A join whose key repeats on one side returns each row of the other side once
  // per match. That is how one-to-many joins work and is usually intended. It
  // is a bug when a SUM / AVG / COUNT then adds up columns of the repeated side.
  // n.joinSides lists each join's key on each side and which FROM items a
  // repeated key would repeat, and a CTE's grain (GROUP BY, dedupe) answers it
  // statically.
  const OUTER_OR_INNER = new Set(['INNER', 'LEFT', 'RIGHT', 'FULL']);
  const INFLATING = new Set(['SUM', 'AVG', 'COUNT', 'COUNTIF']); // COUNT DISTINCT, MIN, MAX are safe
  const grainOf = (n) => {
    const sh = n?.shape;
    if (!sh || !['cte', 'subquery'].includes(n.kind)) return null;
    if (sh.dedupe?.where === 'QUALIFY' || sh.dedupe?.where === 'DISTINCT ON') {
      const per = sh.dedupe.per.split(',').map((s) => s.trim().split('.').pop().replace(/[`"[\]]/g, ''));
      return per.every((c) => /^\w+$/.test(c)) ? per : null;
    }
    return sh.grain || null;
  };
  // Columns of `alias` that a join's equality keys use (`alias.col = other.col`, or USING).
  const pathAlias = (p) => { const x = p.replace(/[`"[\]]/g, '').split('.'); return x.length === 2 && /^\w+$/.test(x[1]) ? [x[0].toLowerCase(), x[1]] : null; };
  function sideCols(it, alias, other) {
    const cols = [];
    for (const k of it.keys || []) {
      if (!k.left.includes('.') && !k.right.includes('.')) { cols.push(k.left.replace(/[`"[\]]/g, '')); continue; } // USING
      const l = pathAlias(k.left);
      const r = pathAlias(k.right);
      if (!l || !r) continue;
      if (l[0] === alias && r[0] === other) cols.push(l[1]);
      else if (r[0] === alias && l[0] === other) cols.push(r[1]);
    }
    return [...new Set(cols)];
  }
  // Every column of `alias` the ON mentions, keys or not (`d.day = DATE '…'` pins day too).
  function onMentions(it, alias) {
    const out = new Set();
    if (!it.onRange) return out;
    for (let i = it.onRange[0]; i + 2 < it.onRange[1]; i++) {
      if ((T[i].t === 'ident' || T[i].t === 'qident') && unquoteIdent(T[i].s).toLowerCase() === alias && txt(i + 1) === '.' && txt(i - 1) !== '.') out.add(unquoteIdent(T[i + 2].s).toLowerCase());
    }
    return out;
  }
  for (const n of nodeList) {
    n.joinSides = [];
    const blocks = n.blocks.filter((b) => !b.inline);
    if (blocks.length !== 1) continue;
    const items = blocks[0];
    items.forEach((it, j) => {
      if (j === 0 || !OUTER_OR_INNER.has(it.joinType)) return;
      const me = itemKey(it);
      const earlier = items.slice(0, j).map(itemKey).filter(Boolean);
      const using = (it.keys || []).length && it.keys.every((k) => !k.left.includes('.'));
      // This item's key: if it repeats, every earlier row comes back once per copy.
      const own = using ? it.keys.map((k) => k.left.replace(/[`"[\]]/g, '')) : [...new Set(earlier.flatMap((p) => sideCols(it, me, p)))];
      if (me && own.length) n.joinSides.push({ item: it, nodeId: it.nodeId, alias: me, cols: own, repeats: earlier });
      // The earlier side's key: if it repeats, each row of this item comes back once per copy.
      const others = using ? (j === 1 ? [earlier[0]] : []) : earlier;
      for (const p of others) {
        const cols = using ? own : sideCols(it, p, me);
        const src = items.find((x) => itemKey(x) === p);
        if (cols.length && src) n.joinSides.push({ item: it, nodeId: src.nodeId, alias: p, cols, repeats: [me] });
      }
    });
    // Aggregates that add up rows a join may repeat.
    const aggs = (n.shape?.aggArgs || []).filter((g) => INFLATING.has(g.fn));
    for (const side of n.joinSides) side.inflates = aggs.filter((g) => side.repeats.some((r) => g.aliases.has(r)));

    // Static answer: joined on part of a CTE's grain.
    const where = (n.shape?.filters || []).join(' ').toLowerCase();
    for (const side of n.joinSides) {
      if (!side.inflates.length || !side.nodeId || isParamsCte(side.nodeId)) continue;
      const src = nodes.get(side.nodeId);
      const grain = grainOf(src);
      if (!grain?.length) continue;
      const seen = onMentions(side.item, side.alias);
      const covered = (c) => seen.has(c.toLowerCase()) || side.cols.some((k) => k.toLowerCase() === c.toLowerCase()) || where.includes(`${side.alias}.${c.toLowerCase()}`);
      const missing = grain.filter((c) => !covered(c));
      if (!missing.length || missing.length === grain.length) continue;
      const matched = grain.filter(covered);
      const cols = (l) => (l.length > 1 ? `(${l.join(', ')})` : l[0]);
      const g = side.inflates[0];
      diags.push({ from: side.item.from, to: side.item.to, severity: 'warning',
        message: `${src.label} has one row per ${cols(grain)}, but this join matches it on ${matched.join(', ')} only, so each ${side.repeats.join(' / ')} row is joined to several ${src.label} rows and ${g.text} adds it up more than once. Join on ${missing.join(', ')} too, or aggregate ${src.label} to one row per ${cols(matched)} first.` });
    }
  }

  // ---- params CTEs: one row of constants, used like variables -------------
  const cteParams = [];
  for (const n of nodeList) {
    if (!isParamsCte(n.id)) continue;
    n.isParams = true;
    for (const it of n.shape.items || []) {
      if (!it.alias) continue;
      let ve = it.y - 1; // value expression [it.x, ve]
      for (let i = it.x + 1; i < it.y; i++) if (is(i, 'AS') && depth[i] === depth[it.x]) { ve = i - 1; break; }
      if (ve === it.y - 1 && it.y - it.x > 1 && T[it.y - 1].t === 'ident' && !is(it.y - 2, 'AS') && txt(it.y - 2) !== '.') ve = it.y - 2;
      const x = it.x;
      let edit;
      if (x === ve && T[x].t === 'string') edit = { ...stringInner(T[x]), kind: 'string' };
      else if (x === ve && T[x].t === 'number') edit = { from: T[x].a, to: T[x].b, kind: 'number' };
      else if (ve === x + 1 && txt(x) === '-' && T[ve].t === 'number') edit = { from: T[x].a, to: T[ve].b, kind: 'number' };
      else if (ve === x + 1 && TYPED_LITERAL.has(up(x)) && T[ve].t === 'string') edit = { ...stringInner(T[ve]), kind: 'string', wrap: T[x].u };
      else if (ve === x + 3 && T[x].t === 'ident' && txt(x + 1) === '(' && txt(x + 3) === ')' && T[x + 2].t === 'string') {
        edit = { ...stringInner(T[x + 2]), kind: 'string', fn: T[x].s };
      } else if (x === ve && (is(x, 'TRUE') || is(x, 'FALSE'))) edit = { from: T[x].a, to: T[x].b, kind: 'expr' };
      else edit = { from: T[x].a, to: T[ve].b, kind: 'expr' };
      const lower = it.alias.toLowerCase();
      const refs = [];
      for (let i = 0; i < N; i++) {
        if (T[i].t !== 'ident' || T[i].s.toLowerCase() !== lower) continue;
        if (n.body && T[i].a >= n.body.from && T[i].b <= n.body.to) continue;
        refs.push({ from: T[i].a, to: T[i].b });
      }
      // A comment on the same line (`… AS partition_start, -- window_start - 1`) is shown as a hint.
      const lineEnd = src.indexOf('\n', T[it.y - 1].b);
      const tail = src.slice(T[it.y - 1].b, lineEnd < 0 ? src.length : lineEnd);
      const cm = /^\s*,?\s*(?:--|#)\s*(.+)$/.exec(tail);
      const last = T[it.y - 1];
      const nameAt = last.t === 'ident' && last.s.toLowerCase() === lower ? { from: last.a, to: last.b } : null;
      cteParams.push({ cte: n.id, cteLabel: n.label, name: it.alias, edit, value: src.slice(edit.from, edit.to),
        def: { from: T[x].a, to: T[it.y - 1].b }, nameAt, refs, note: cm ? cm[1].trim() : '' });
    }
  }

  // Edge role: 'data' (FROM / JOIN), 'filter' (only used by IN / EXISTS to keep or drop rows),
  // 'lookup' (scalar or ARRAY subquery), 'params' (reads a one-row constants CTE).
  const SEMI = new Set(['IN', 'NOT IN', 'EXISTS', 'NOT EXISTS']);
  for (const e of edgeList) {
    if (nodes.get(e.from)?.isParams) {
      e.role = 'params';
      for (const j of e.joins) j.params = true;
      const to = nodes.get(e.to);
      if (to.shape) (to.shape.usesParams ||= []).includes(nodes.get(e.from).label) || to.shape.usesParams.push(nodes.get(e.from).label);
      continue;
    }
    if (e.joins.some((j) => !j.inline)) e.role = 'data';
    else if (e.joins.every((j) => SEMI.has(j.inline.kind))) e.role = 'filter';
    else e.role = 'lookup';
    if (e.role === 'filter') {
      const to = nodes.get(e.to);
      const from = nodes.get(e.from);
      to.shape ||= { branches: 1, columns: 0, star: false, distinct: false, filters: [], groupBy: [], aggregates: [], windows: [], having: [], qualify: [], limit: null, orderBy: null };
      (to.shape.semi ||= []);
      for (const j of e.joins) {
        if (!to.shape.semi.some((x) => x.from === e.from && x.kind === j.inline.kind && x.col === j.inline.col)) {
          to.shape.semi.push({ from: e.from, label: from.label, kind: j.inline.kind, col: j.inline.col });
        }
      }
    }
  }

  // Which step (innermost CTE / subquery / statement) each filter value sits in.
  const scoped = nodeList.flatMap((n) => (n.spans || []).map((sp) => ({ id: n.id, ...sp, size: sp.to - sp.from })));
  const ownerAt = (pos) => {
    let best = null;
    for (const sp of scoped) if (sp.from <= pos && pos < sp.to && (!best || sp.size < best.size)) best = sp;
    return best?.id || null;
  };
  for (const g of literals) {
    for (const o of g.occ) o.owner = ownerAt(o.from);
    g.owners = [...new Set(g.occ.map((o) => o.owner).filter(Boolean))];
  }
  for (const v of variables) v.owners = [...new Set(v.refs.map((r) => ownerAt(r.from)).filter(Boolean))];
  for (const p of params) p.owners = [...new Set(p.refs.map((r) => ownerAt(r.from)).filter(Boolean))];
  for (const l of inLists) l.owner = ownerAt(l.from);
  for (const cp of cteParams) cp.owners = [cp.cte, ...(nodes.get(cp.cte).out || [])];

  const dates = analyzeDates();
  for (const st of dates.steps) {
    const n = nodes.get(st.id);
    if (n) (n.shape ||= { branches: 1, columns: 0, star: false, distinct: false, filters: [], groupBy: [], aggregates: [], windows: [], having: [], qualify: [], limit: null, orderBy: null }).dates = st;
  }
  diags.push(...dates.issues.map((x) => ({ from: x.from, to: x.to, severity: x.severity, message: x.message })));

  // ---- date windows: what date range each step reads, and whether steps agree --------
  function analyzeDates() {
    const DAY = 86400000;
    const toDay = (y, m, d) => Math.floor(Date.UTC(y, m - 1, d) / DAY);
    const parseDay = (s) => {
      let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
      if (m) return { day: toDay(+m[1], +m[2], +m[3]), fmt: 'iso' };
      m = /^(\d{4})(\d{2})(\d{2})$/.exec(s);
      if (m && +m[2] >= 1 && +m[2] <= 12) return { day: toDay(+m[1], +m[2], +m[3]), fmt: 'compact' };
      return null;
    };
    const varDate = new Map();
    for (const v of variables) {
      if (v.value === undefined || v.edit?.kind !== 'string') continue;
      const d = parseDay(v.value);
      if (d) for (const nm of v.names) varDate.set(nm.toLowerCase(), { ...d, src: { kind: 'variable', name: nm, edit: v.edit } });
    }
    const paramDate = new Map();
    for (const cp of cteParams) {
      if (cp.edit.kind !== 'string') continue;
      const d = parseDay(cp.value);
      if (d) paramDate.set(cp.name.toLowerCase(), { ...d, src: { kind: 'param', name: `${cp.cteLabel}.${cp.name}`, edit: cp.edit } });
    }
    const today = Math.floor(Date.now() / DAY);
    const UNIT_DAYS = { DAY: 1, WEEK: 7, ISOWEEK: 7, MONTH: 30, QUARTER: 91, YEAR: 365 };
    const TODAY = /^(CURRENT_(DATE|TIMESTAMP|DATETIME)|CURDATE|NOW|SYSDATE|UTC_DATE|UTC_TIMESTAMP|LOCALTIMESTAMP|TRANSACTION_TIMESTAMP|STATEMENT_TIMESTAMP)$/;

    // Days in an interval starting at token x: INTERVAL 7 DAY (BigQuery, MySQL),
    // INTERVAL '7 days' / INTERVAL '7' DAY (Postgres), or a bare number of days
    // (Postgres date - 7). Returns { days, end } or null.
    const intervalAt = (x) => {
      if (T[x]?.t === 'number') return { days: Number(T[x].s), end: x };
      if (!is(x, 'INTERVAL')) return null;
      const v = T[x + 1];
      if (v?.t === 'number' && UNIT_DAYS[up(x + 2)] !== undefined) return { days: UNIT_DAYS[up(x + 2)] * Number(v.s), end: x + 2 };
      if (v?.t !== 'string') return null;
      const m = /^\s*(-?\d+)\s*([a-z]*)\s*$/i.exec(src.slice(stringInner(v).from, stringInner(v).to));
      if (!m) return null;
      const named = m[2].toUpperCase().replace(/S$/, '');
      if (named) return UNIT_DAYS[named] === undefined ? null : { days: UNIT_DAYS[named] * Number(m[1]), end: x + 1 };
      return UNIT_DAYS[up(x + 2)] === undefined ? null : { days: UNIT_DAYS[up(x + 2)] * Number(m[1]), end: x + 2 };
    };

    // End index (inclusive) of a value expression starting at k, or -1. Takes in a
    // trailing `+ / - INTERVAL …` and a Postgres `::type` cast.
    const valueEnd = (k) => {
      let e = baseEnd(k);
      while (e >= 0) {
        if (txt(e + 1) === '::' && T[e + 2]?.t === 'ident') { e += 2; continue; }
        if ((txt(e + 1) === '+' || txt(e + 1) === '-') && intervalAt(e + 2)) { e = intervalAt(e + 2).end; continue; }
        break;
      }
      return e;
    };
    const baseEnd = (k) => {
      if (k >= N) return -1;
      const t = T[k];
      if (t.t === 'string' || t.t === 'number' || t.t === 'param') return k;
      if (t.t === 'ident' && TYPED_LITERAL.has(t.u) && T[k + 1]?.t === 'string') return k + 1;
      if (t.s === '(' && match[k] > k) return match[k];
      if (t.t === 'ident' || t.t === 'qident') {
        const p = readPath(k);
        if (!p) return -1;
        if (txt(p.end) === '(' && match[p.end] > 0) return match[p.end];
        return p.end - 1;
      }
      return -1;
    };

    // Resolve tokens [i, j] to a calendar day, or null.
    const resolve = (i, j, hop = 0) => {
      if (i > j || hop > 6) return null;
      const t = T[i];
      // <date> + / - <interval>: the last top-level + or - whose right side is an interval
      for (let q = j - 1; q > i; q--) {
        if (depth[q] !== depth[i] || !(txt(q) === '+' || txt(q) === '-') || T[q].t !== 'op') continue;
        const iv = intervalAt(q + 1);
        if (!iv || iv.end !== j) continue;
        const base = resolve(i, q - 1, hop + 1);
        if (!base) return null;
        return { ...base, day: base.day + iv.days * (txt(q) === '-' ? -1 : 1), src: { kind: 'expr', name: squash(slice(i, j), 50), base: base.src } };
      }
      // Postgres cast: '2024-01-01'::date
      if (j >= i + 2 && txt(j - 1) === '::' && T[j].t === 'ident') return resolve(i, j - 2, hop + 1);
      if (i === j && t.t === 'ident' && TODAY.test(t.u)) return { day: today, fmt: 'iso', relative: true, src: { kind: 'expr', name: t.u } };
      if (i === j && t.t === 'param' && (D.vars === 'set' || D.vars === 'tsql')) return varDate.get(t.s.toLowerCase()) || null;
      if (i === j && t.t === 'string') {
        const d = parseDay(src.slice(stringInner(t).from, stringInner(t).to));
        return d && { ...d, src: { kind: 'literal', edit: { ...stringInner(t), kind: 'string' } } };
      }
      if (j === i + 1 && t.t === 'ident' && TYPED_LITERAL.has(t.u) && T[j].t === 'string') return resolve(j, j, hop + 1);
      if (i === j && (t.t === 'ident' || t.t === 'qident')) {
        const nm = unquoteIdent(t.s).toLowerCase();
        return varDate.get(nm) || paramDate.get(nm) || null;
      }
      if (t.s === '(' && match[i] === j) return resolve(i + 1, j - 1, hop + 1);
      const p = (t.t === 'ident' || t.t === 'qident') ? readPath(i) : null;
      if (!p) return null;
      if (p.end === j + 1) {
        // alias.column -> params value
        return paramDate.get(p.parts[p.parts.length - 1].toLowerCase()) || null;
      }
      if (txt(p.end) !== '(' || match[p.end] !== j) return null;
      const fn = p.parts[p.parts.length - 1].toUpperCase();
      const args = splitTop(p.end + 1, j, depth[p.end] + 1, ',');
      if (TODAY.test(fn)) return { day: today, fmt: 'iso', relative: true, src: { kind: 'expr', name: fn + '()' } };
      if (['DATE', 'TIMESTAMP', 'DATETIME', 'SAFE_CAST', 'CAST'].includes(fn) && args.length) {
        let [x, y] = args[0];
        for (let q = x; q < y; q++) if (is(q, 'AS') && depth[q] === depth[x]) { y = q; break; }
        return resolve(x, y - 1, hop + 1);
      }
      if (/^PARSE_(DATE|TIMESTAMP|DATETIME)$/.test(fn) && args.length === 2) return resolve(args[1][0], args[1][1] - 1, hop + 1);
      if (/^(DATE|TIMESTAMP|DATETIME|ADD|SUB)_?(ADD|SUB|DATE)$/.test(fn) && args.length === 2) {
        // DATE_SUB(d, INTERVAL 7 DAY), MySQL ADDDATE / SUBDATE(d, INTERVAL … | days)
        const base = resolve(args[0][0], args[0][1] - 1, hop + 1);
        const iv = intervalAt(args[1][0]);
        if (!base || !iv || iv.end !== args[1][1] - 1) return null;
        const days = iv.days * (/SUB/.test(fn) ? -1 : 1);
        return { ...base, day: base.day + days, src: { kind: 'expr', name: squash(slice(i, j), 50), base: base.src } };
      }
      return null;
    };

    const colOf = (i, j) => {
      for (let q = i; q <= j; q++) {
        if ((T[q].t === 'ident' || T[q].t === 'qident') && !RES.has(T[q].u) && txt(q + 1) !== '(') {
          const p = readPath(q);
          if (p) return p.parts[p.parts.length - 1];
        }
      }
      return squash(slice(i, j), 30);
    };
    const isPartition = (col) => /^_(PARTITIONDATE|PARTITIONTIME|TABLE_SUFFIX)$/i.test(col);

    const bounds = [];
    const seen = new Set();
    const addBound = (owner, colI, colJ, op, v, condFrom, condTo) => {
      const col = colOf(colI, colJ);
      const key = `${condFrom}:${op}`;
      if (seen.has(key)) return;
      seen.add(key);
      const b = { owner, col, colText: squash(slice(colI, colJ), 40), partition: isPartition(col), op, day: v.day, fmt: v.fmt,
        relative: !!v.relative, src: v.src, from: T[condFrom].a, to: T[condTo].b };
      if (op === '>=' || op === '>') { b.side = 'start'; if (op === '>') b.day += 1; }
      else if (op === '<=' || op === '<') { b.side = 'end'; if (op === '<') b.day -= 1; }
      else if (op === '=') b.side = 'point';
      else return;
      bounds.push(b);
    };
    const FLIP = { '>=': '<=', '>': '<', '<=': '>=', '<': '>', '=': '=' };

    for (const r of condRanges) {
      for (let i = r.a; i < r.b; i++) {
        const t = T[i];
        if (is(i, 'BETWEEN') && !is(i - 1, 'NOT')) {
          const col = operandBefore(i - 1);
          const loEnd = valueEnd(i + 1);
          if (!col || loEnd < 0 || !is(loEnd + 1, 'AND')) continue;
          const hiEnd = valueEnd(loEnd + 2);
          if (hiEnd < 0) continue;
          const lo = resolve(i + 1, loEnd);
          const hi = resolve(loEnd + 2, hiEnd);
          if (lo) addBound(r.owner, col.i, col.j, '>=', lo, col.i, hiEnd);
          if (hi) addBound(r.owner, col.i, col.j, '<=', { ...hi }, col.i, hiEnd);
          continue;
        }
        if (t.t !== 'op' || !FLIP[t.s] || (t.s === '=' && false)) continue;
        const rEnd = valueEnd(i + 1);
        const right = rEnd >= 0 ? resolve(i + 1, rEnd) : null;
        let left = null;
        let lStart = -1;
        if (T[i - 1]?.t === 'string') { lStart = TYPED_LITERAL.has(up(i - 2)) ? i - 2 : i - 1; left = resolve(lStart, i - 1); }
        const lop = operandBefore(i - 1);
        if (!left && lop) { left = resolve(lop.i, lop.j); lStart = lop.i; }
        if (right && !left && lop) addBound(r.owner, lop.i, lop.j, t.s, right, lop.i, rEnd);
        else if (left && !right && rEnd >= 0) addBound(r.owner, i + 1, rEnd, FLIP[t.s], left, lStart, rEnd);
      }
    }

    // Per step: window = [latest start, earliest end], event columns and partition columns apart.
    const steps = new Map();
    for (const b of bounds) {
      if (!b.owner) continue;
      if (!steps.has(b.owner)) steps.set(b.owner, { id: b.owner, label: nodes.get(b.owner)?.label || b.owner, event: {}, partition: {}, bounds: [] });
      const st = steps.get(b.owner);
      st.bounds.push(b);
      const w = b.partition ? st.partition : st.event;
      if (b.side === 'start' || b.side === 'point') if (!w.start || b.day > w.start.day) w.start = b;
      if (b.side === 'end' || b.side === 'point') if (!w.end || b.day < w.end.day) w.end = b;
    }
    const list = [...steps.values()].sort((x, y) => (nodes.get(x.id)?.order ?? nodes.get(x.id)?.def?.from ?? 0) - (nodes.get(y.id)?.order ?? nodes.get(y.id)?.def?.from ?? 0));

    // Reference window = the start / end most steps agree on. With no clear majority
    // (a tie), there is no reference and every differing step is flagged.
    const fmtDay = (day) => new Date(day * DAY).toISOString().slice(0, 10);
    const eventSteps = list.filter((st) => st.event.start || st.event.end);
    const groupsFor = (side) => {
      const g = new Map();
      for (const st of eventSteps) if (st.event[side]) {
        const d = st.event[side].day;
        if (!g.has(d)) g.set(d, []);
        g.get(d).push(st.label);
      }
      return g;
    };
    const refFor = (g) => {
      let best = null;
      let tie = false;
      for (const [d, labels] of g) {
        if (best === null || labels.length > g.get(best).length) { best = d; tie = false; }
        else if (labels.length === g.get(best).length) tie = true;
      }
      return tie ? null : best;
    };
    const gStart = groupsFor('start');
    const gEnd = groupsFor('end');
    const ref = { start: refFor(gStart), end: refFor(gEnd) };
    const describe = (g) => [...g].map(([d, labels]) => `${fmtDay(d)} (${labels.join(', ')})`).join(' vs ');
    const issues = [];
    for (const st of list) {
      const e = st.event;
      st.mismatch = {};
      for (const side of ['start', 'end']) {
        const g = side === 'start' ? gStart : gEnd;
        const b = e[side];
        if (g.size < 2 || !b || b.day === ref[side]) continue;
        st.mismatch[side] = true;
        const verb = side === 'start' ? 'start' : 'end';
        const message = ref[side] === null
          ? `Steps ${verb} on different dates: ${describe(g)}`
          : `Date window mismatch: ${st.label} ${verb}s ${fmtDay(b.day)}, but ${g.get(ref[side]).join(', ')} ${verb}${g.get(ref[side]).length === 1 ? 's' : ''} ${fmtDay(ref[side])}`;
        issues.push({ owner: st.id, from: b.from, to: b.to, severity: 'warning', side, bound: b, message });
      }
      // Partition filter vs the date window the query is after.
      const p = st.partition;
      const want = { start: e.start?.day ?? ref.start, end: e.end?.day ?? ref.end };
      if (p.start && want.start !== null && want.start !== undefined && p.start.day > want.start) {
        st.mismatch.partition = true;
        issues.push({ owner: st.id, from: p.start.from, to: p.start.to, severity: 'warning', side: 'partition',
          message: `Partition filter on ${p.start.col} starts ${fmtDay(p.start.day)}, after the window start ${fmtDay(want.start)}: rows before that are skipped` });
      }
      if (p.end && want.end !== null && want.end !== undefined && p.end.day < want.end) {
        st.mismatch.partition = true;
        issues.push({ owner: st.id, from: p.end.from, to: p.end.to, severity: 'warning', side: 'partition',
          message: `Partition filter on ${p.end.col} ends ${fmtDay(p.end.day)}, before the window end ${fmtDay(want.end)}: rows after that are skipped` });
      }
      if (p.start && want.start !== null && want.start !== undefined && want.start - p.start.day > 31) {
        issues.push({ owner: st.id, from: p.start.from, to: p.start.to, severity: 'info', side: 'partition',
          message: `Partition filter starts ${want.start - p.start.day} days before the window it feeds (${fmtDay(want.start)}): extra bytes scanned` });
      }
    }
    return { steps: list, ref, issues, startsDiffer: gStart.size > 1, endsDiffer: gEnd.size > 1 };
  }

  diags.sort((x, y) => x.from - y.from);
  marks.sort((x, y) => x.from - y.from || x.to - y.to);

  return {
    dialect: D.id,
    src,
    tokens: T,
    match,
    variables,
    params,
    literals,
    inLists,
    cteParams,
    dates,
    insertDeclareAt: lastDeclareEnd,
    // Script statements, ';' included. kind: declare | set | function (CREATE TEMP FUNCTION) | other
    statements: stmts.filter(([s, e]) => s < e).map(([s, e]) => ({
      from: T[s].a,
      to: stmtEndAt(e),
      kind: up(s) === 'DECLARE' && (BQ || TSQL) ? 'declare' : up(s) === 'SET' ? 'set'
        : up(s) === 'CREATE' && T.slice(s + 1, Math.min(e, s + 6)).some((t) => t.u === 'FUNCTION') ? 'function' : 'other',
    })),
    graph: { nodes: nodeList, edges: edgeList },
    diags,
    marks,
    stats: {
      tables: nodeList.filter((n) => n.kind === 'table').length,
      ctes: nodeList.filter((n) => n.kind === 'cte').length,
      statements: stmts.length,
    },
  };
}

const RANKERS = new Set(['ROW_NUMBER', 'RANK', 'DENSE_RANK']);

// "Latest row per key" pattern: ROW_NUMBER() OVER (PARTITION BY k ORDER BY t DESC) AS rn,
// then `rn = 1` in QUALIFY, in the consumer's WHERE, or in the join's ON.
function detectDedupe(nodes, edges) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const isFirst = (text, col) => new RegExp(`(^|[^\\w])${col}\\s*(=\\s*1|<=\\s*1|<\\s*2)(?![\\w.])`, 'i').test(text);
  const mark = (n, w, where) => {
    n.shape.dedupe = {
      per: w.partition || '(all rows)',
      order: w.order,
      latest: /\bDESC\b/i.test(w.order),
      where,
    };
  };
  for (const n of nodes) {
    const sh = n.shape;
    if (!sh) continue;
    // Postgres SELECT DISTINCT ON (k) … ORDER BY k, t DESC
    if (sh.distinctOn) { mark(n, { partition: sh.distinctOn, order: sh.orderBy || '' }, 'DISTINCT ON'); continue; }
    // QUALIFY ROW_NUMBER() OVER (...) = 1  or  QUALIFY rn = 1
    for (const q of sh.qualify) {
      const w = sh.windows.find((w) => RANKERS.has(w.fn) && w.alias && isFirst(q, w.alias));
      if (w) { mark(n, w, 'QUALIFY'); break; }
      const m = q.match(/(ROW_NUMBER|RANK|DENSE_RANK)\s*\(\s*\)\s*OVER\s*\(\s*(?:PARTITION BY\s+(.+?))?\s*(?:ORDER BY\s+(.+?))?\)\s*(=\s*1|<=\s*1|<\s*2)/i);
      if (m) { mark(n, { partition: m[2] || '', order: m[3] || '' }, 'QUALIFY'); break; }
    }
    if (sh.dedupe) continue;
    const ranks = sh.windows.filter((w) => RANKERS.has(w.fn) && w.alias);
    if (!ranks.length) continue;
    for (const e of edges.filter((e) => e.from === n.id)) {
      const consumer = byId.get(e.to);
      for (const w of ranks) {
        // A join without AS is referred to by its own name (`LEFT JOIN tx ON … tx.rn = 1`).
        const aliasOf = (j) => j.alias || (j.name || '').split('.').pop().replace(/[`"[\]]/g, '');
        const onHit = e.joins.find((j) => j.onText && aliasOf(j) && isFirst(j.onText, `${aliasOf(j)}\\.${w.alias}`));
        const whereHit = consumer?.shape?.filters.some((f) =>
          e.joins.some((j) => aliasOf(j) && isFirst(f, `${aliasOf(j)}\\.${w.alias}`)) || (n.out.length === 1 && isFirst(f, w.alias)));
        if (onHit || whereHit) { mark(n, w, onHit ? 'join' : 'WHERE'); break; }
      }
      if (sh.dedupe) break;
    }
  }
}

// Short edge label for a join: "LEFT · user_id" / "user_id = id"
export function joinLabel(item) {
  const keys = (item.keys || []).map((k) => {
    const l = k.left.split('.').pop();
    const r = k.right.split('.').pop();
    return l.toLowerCase() === r.toLowerCase() ? l : `${l} = ${r}`;
  });
  const type = item.joinType === 'FROM' ? '' : item.joinType === 'COMMA' ? 'CROSS (comma)' : item.joinType;
  return [type, keys.join(', ')].filter(Boolean).join(' · ');
}
