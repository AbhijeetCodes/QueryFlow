import { formatDialect, bigquery, postgresql, mysql, transactsql } from 'sql-formatter';
import { tokenize } from './tokenizer.js';

const TYPES = new Set(['DATE', 'DATETIME', 'TIMESTAMP', 'TIME', 'INT64', 'INTEGER', 'INT', 'STRING',
  'BOOL', 'BOOLEAN', 'FLOAT64', 'NUMERIC', 'BIGNUMERIC', 'DECIMAL', 'BIGDECIMAL', 'BYTES', 'JSON',
  'GEOGRAPHY', 'INTERVAL', 'ARRAY', 'STRUCT', 'RANGE']);
const UNITS = new Set(['MICROSECOND', 'MILLISECOND', 'SECOND', 'MINUTE', 'HOUR', 'DAY', 'WEEK',
  'ISOWEEK', 'MONTH', 'QUARTER', 'YEAR', 'ISOYEAR', 'DAYOFWEEK', 'DAYOFYEAR']);

const FORMATTER = {
  bigquery: { dialect: bigquery },
  postgres: { dialect: postgresql, paramTypes: { numbered: ['$'], named: [':'] } },
  mysql: { dialect: mysql },
  sqlserver: { dialect: tsqlColumnsSafe() },
};

// sql-formatter's T-SQL lists object words (TYPE, USER, TABLE, ROLE, INDEX, …) as one-word
// clauses, so a column called `type` starts a new line. Keep only real clause starters.
function tsqlColumnsSafe() {
  const keep = new Set(['WITH', 'INTO', 'FROM', 'WHERE', 'HAVING', 'WINDOW', 'OFFSET', 'OPTION', 'INSERT', 'VALUES',
    'SET', 'MERGE', 'UPDATE', 'DELETE', 'ADD', 'GO', 'USE', 'GRANT', 'DENY', 'REVOKE', 'BACKUP', 'RESTORE']);
  const t = transactsql.tokenizerOptions;
  return { ...transactsql, tokenizerOptions: { ...t, reservedClauses: t.reservedClauses.filter((c) => c.includes(' ') || keep.has(c)) } };
}

// The choices in the ⋯ menu's Formatting group (issue #1, after Poor SQL's options).
export const FORMAT_DEFAULTS = {
  keywordCase: 'upper', // 'upper' | 'lower' | 'preserve'
  indent: '2', // '2' | '4' | 'tab'
  commas: 'trailing', // 'trailing' | 'leading' (`, b` at the start of the line, CTEs too)
  compact: true, // short lists and conditions on one line
};

export function formatSql(src, dialect = 'bigquery', options = {}) {
  const o = { ...FORMAT_DEFAULTS, ...options };
  const fmt = FORMATTER[dialect] || FORMATTER.bigquery;
  const tok = (text) => tokenize(text, dialect);
  // Words the formatter adds (AS, INNER) follow the keyword case; "as typed" follows the query's.
  const lower = o.keywordCase === 'lower' || (o.keywordCase === 'preserve' && /\b(select|from)\b/.test(src) && !/\b(SELECT|FROM)\b/.test(src));
  const kw = (s) => (lower ? s.toLowerCase() : s);
  const { text, trailing } = liftTrailingComments(src, tok);
  // The steps below work on 2-space indents; other indents are applied at the end.
  let out = formatDialect(text, {
    ...fmt,
    keywordCase: o.keywordCase,
    dataTypeCase: o.keywordCase,
    functionCase: o.keywordCase,
    tabWidth: 2,
    linesBetweenQueries: 1,
    logicalOperatorNewline: 'before',
    expressionWidth: 60,
  });
  out = distinctOnLine(out);
  if (o.keywordCase === 'upper') out = upperTypesAndUnits(out, tok);
  // Does `#` start a comment? Not in SQL Server (#temp tables) or Postgres.
  const hash = dialect === 'bigquery' || dialect === 'mysql';
  out = explicitAliasesAndJoins(out, tok, kw);
  out = reattachCommas(out, tok, hash);
  if (o.compact) out = collapseShortLists(out);
  if (dialect === 'sqlserver') out = tsqlLayout(out);
  out = hoistClauseBodies(out, tok, hash);
  if (o.compact) out = collapseShortConditions(out, hash);
  out = restoreTrailingComments(out, trailing, tok);
  // `SET\n  @x = 1;` and `LIMIT\n  10` on one line
  out = out.replace(/^(SET)\n {2}([^\n]*;|@[^\n]*)$/gim, '$1 $2');
  // SQL Server session options (SET NOCOUNT ON) are plain words to sql-formatter
  if (dialect === 'sqlserver' && o.keywordCase === 'upper') out = out.replace(/^(SET )([A-Za-z_]+)( (?:ON|OFF)\b)/gm, (m, a, w, b) => a + w.toUpperCase() + b);
  out = out.replace(/^(\s*)(LIMIT|TOP)\n\s+([^\n]+)$/gim, '$1$2 $3');
  // keep consecutive DECLAREs (SET @vars) together
  out = out.replace(/^(DECLARE[^\n]*;)\n\n(?=DECLARE)/gim, '$1\n');
  out = out.replace(/^(SET @[^\n]*;)\n\n(?=SET @)/gim, '$1\n');
  if (dialect === 'sqlserver') out = out.replace(/^(GO)\n(?=\S)/gim, '$1\n\n');
  if (o.commas === 'leading') out = leadingCommas(out, tok);
  if (o.indent !== '2') out = reindent(out, o.indent === 'tab' ? '\t' : '    ', tok);
  return out.endsWith('\n') ? out : out + '\n';
}

// A comma that ends a line moves to the start of the next code line:
//     SELECT                 SELECT
//       a,                     a
//       b             ->       , b
//     ),                     )
//
//     b AS (                 , b AS (
function leadingCommas(text, tokenize) {
  const toks = tokenize(text);
  const edits = []; // { a, b, s }, applied back to front
  for (let i = 0; i < toks.length; i++) {
    if (toks[i].t !== 'punct' || toks[i].s !== ',') continue;
    // only whitespace / comments until the end of the line, then the next code token
    let j = i + 1;
    let endsLine = false;
    while (j < toks.length && (toks[j].t === 'ws' || toks[j].t === 'comment')) {
      if (toks[j].s.includes('\n') || (toks[j].t === 'comment' && !toks[j].s.startsWith('/*'))) endsLine = true;
      j++;
    }
    const next = toks[j];
    if (!endsLine || !next) continue;
    const lineStart = text.lastIndexOf('\n', next.a - 1) + 1;
    if (text.slice(lineStart, next.a).trim()) continue; // not first on its line
    edits.push({ a: toks[i].a, b: toks[i].b, s: '' }, { a: next.a, b: next.a, s: ', ' });
  }
  let res = text;
  for (const e of edits.sort((x, y) => y.a - x.a)) res = res.slice(0, e.a) + e.s + res.slice(e.b);
  return res;
}

// Each 2-space step of indentation becomes `unit` (4 spaces or a tab), except on
// lines inside multi-line strings and block comments.
function reindent(text, unit, tokenize) {
  const frozen = frozenLines(text, tokenize);
  return text.split('\n').map((l, k) => {
    if (frozen.has(k)) return l;
    const n = indentOf(l);
    return unit.repeat(Math.floor(n / 2)) + ' '.repeat(n % 2) + l.slice(n);
  }).join('\n');
}

// A comment after a statement's semicolon (`DECLARE … ;  -- note`) is taken by
// sql-formatter as the start of the next statement. Lift such comments out,
// keyed by which top-level semicolon they follow, and put them back after it.
function topLevelSemis(toks) {
  const out = [];
  let depth = 0;
  toks.forEach((t, i) => {
    if (t.t !== 'punct') return;
    if (t.s === '(' || t.s === '[') depth++;
    else if (t.s === ')' || t.s === ']') depth = Math.max(0, depth - 1);
    else if (t.s === ';' && depth === 0) out.push(i);
  });
  return out;
}

function liftTrailingComments(src, tokenize) {
  const toks = tokenize(src);
  const trailing = new Map(); // semicolon number -> comment text
  const cuts = [];
  topLevelSemis(toks).forEach((i, k) => {
    let j = i + 1;
    if (toks[j]?.t === 'ws' && !toks[j].s.includes('\n')) j++;
    const c = toks[j];
    if (c?.t === 'comment' && !c.s.startsWith('/*')) {
      trailing.set(k, c.s);
      cuts.push({ a: toks[i].b, b: c.b });
    }
  });
  let text = src;
  for (const c of cuts.reverse()) text = text.slice(0, c.a) + text.slice(c.b);
  return { text, trailing };
}

function restoreTrailingComments(text, trailing, tokenize) {
  if (!trailing.size) return text;
  const toks = tokenize(text);
  let res = text;
  const semis = topLevelSemis(toks);
  for (let k = semis.length - 1; k >= 0; k--) {
    if (!trailing.has(k)) continue;
    const at = toks[semis[k]].b;
    res = `${res.slice(0, at)}  ${trailing.get(k)}${res.slice(at)}`;
  }
  return res;
}

// sql-formatter writes Postgres' DISTINCT ON across two lines:
//     SELECT DISTINCT                SELECT DISTINCT ON (user_id)
//       ON (user_id) user_id,   ->     user_id,
function distinctOnLine(text) {
  return text.replace(/^(\s*)(SELECT DISTINCT)\n\s+(ON) (\([^()\n]*\)) ?([^\n]*)$/gim,
    (m, ind, sd, on, keys, rest) => `${ind}${sd} ${on} ${keys}` + (rest ? `\n${ind}  ${rest}` : ''));
}

// Words sql-formatter leaves lower case without parentheses (Postgres / MySQL).
const BARE_KEYWORDS = new Set(['CURRENT_DATE', 'CURRENT_TIME', 'CURRENT_TIMESTAMP', 'LOCALTIME', 'LOCALTIMESTAMP']);

// sql-formatter leaves `date` in `DECLARE d date` and `day` in `INTERVAL 7 day`
// lowercase. Upper-case them only in unambiguous type/unit positions.
function upperTypesAndUnits(text, tokenize) {
  const toks = tokenize(text).filter((t) => t.t !== 'ws' && t.t !== 'comment');
  const edits = [];
  let inDeclare = false;
  let afterDefault = false;
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t.s === ';') { inDeclare = false; afterDefault = false; continue; }
    if (t.t !== 'ident') continue;
    if (t.u === 'DECLARE') { inDeclare = true; afterDefault = false; continue; }
    if (t.u === 'DEFAULT' && inDeclare) { afterDefault = true; continue; }
    if (t.s === t.u) continue;
    const prev = toks[i - 1];
    const prev2 = toks[i - 2];
    const next = toks[i + 1];
    const isType = TYPES.has(t.u) && (
      (inDeclare && !afterDefault && prev && prev.t === 'ident' && prev.u !== 'DECLARE') ||
      (prev && prev.u === 'AS' && next && (next.s === ')' || next.s === '<'))
    );
    const isUnit = UNITS.has(t.u) && (
      (prev2 && prev2.u === 'INTERVAL') ||
      (prev && prev.s === ',' && next && next.s === ')')
    );
    const isKeyword = (t.u === 'INTERVAL' && next && (next.t === 'number' || next.t === 'string')) ||
      (['DATE', 'TIME', 'TIMESTAMP', 'DATETIME'].includes(t.u) && next?.t === 'string' && prev?.s !== '.') ||
      (BARE_KEYWORDS.has(t.u) && next?.s !== '(' && prev?.s !== '.');
    if (isType || isUnit || isKeyword) edits.push(t);
  }
  let res = text;
  for (let k = edits.length - 1; k >= 0; k--) {
    const t = edits[k];
    res = res.slice(0, t.a) + t.u + res.slice(t.b);
  }
  return res;
}

// sql-formatter puts the comma after a trailing comment on its own line:
//     v.a AS x
//     -- note
//   ,
// Move it back to the end of the code line (before any inline comment).
function reattachCommas(text, tokenize, hash = true) {
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*),\s*(.*)$/.exec(lines[i]);
    if (!m) continue;
    let j = i - 1;
    while (j >= 0 && ((hash ? /^\s*(--|#)/ : /^\s*--/).test(lines[j]) || !lines[j].trim())) j--;
    if (j < 0) continue;
    const toks = tokenize(lines[j]).filter((t) => t.t !== 'ws');
    const last = toks[toks.length - 1];
    if (!last || last.s === ',' || last.s === '(') continue;
    if (last.t === 'comment') {
      const before = toks[toks.length - 2];
      if (!before) continue;
      lines[j] = lines[j].slice(0, before.b) + ',' + lines[j].slice(before.b);
    } else {
      lines[j] = lines[j].replace(/\s*$/, ',');
    }
    if (m[2]) {
      lines[i] = m[1] + m[2];
    } else {
      lines.splice(i, 1);
      i--;
    }
  }
  return lines.join('\n');
}

// GROUP BY / ORDER BY / PARTITION BY lists of short items go on one line.
function collapseShortLists(text) {
  const lines = text.split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*)(GROUP BY|ORDER BY|PARTITION BY|SELECT|SELECT DISTINCT)$/i.exec(lines[i]);
    if (!m) {
      out.push(lines[i]);
      continue;
    }
    const indent = m[1];
    const items = [];
    let j = i + 1;
    let deeper = false;
    while (j < lines.length && lines[j].startsWith(indent + '  ') && lines[j].trim()) {
      if (lines[j].startsWith(indent + '   ')) deeper = true;
      items.push(lines[j].trim());
      j++;
    }
    const isSelect = /^SELECT/i.test(m[2]);
    const joined = items.join(' ');
    const ok = items.length > 0 && !deeper && joined.length <= 70 &&
      items.every((s) => s.length <= 32 && !s.startsWith('--')) &&
      (!isSelect || items.length === 1);
    if (ok) {
      out.push(`${indent}${m[2]} ${joined}`);
      i = j - 1;
    } else {
      out.push(lines[i]);
    }
  }
  return out.join('\n');
}

// Reserved words (BigQuery's, which cover the common ones): never an unquoted alias.
const RESERVED = new Set(`ALL AND ANY ARRAY AS ASC ASSERT_ROWS_MODIFIED AT BETWEEN BY CASE CAST COLLATE CONTAINS
  CREATE CROSS CUBE CURRENT DEFAULT DEFINE DESC DISTINCT ELSE END ENUM ESCAPE EXCEPT EXCLUDE EXISTS EXTRACT FALSE
  FETCH FOLLOWING FOR FROM FULL GROUP GROUPING GROUPS HASH HAVING IF IGNORE IN INNER INTERSECT INTERVAL INTO IS JOIN
  LATERAL LEFT LIKE LIMIT LOOKUP MERGE NATURAL NEW NO NOT NULL NULLS OF ON OR ORDER OUTER OVER PARTITION PRECEDING
  PROTO QUALIFY RANGE RECURSIVE RESPECT RIGHT ROLLUP ROWS SELECT SET SOME STRUCT TABLESAMPLE THEN TO TREAT TRUE
  UNBOUNDED UNION UNNEST USING WHEN WHERE WINDOW WITH WITHIN`.split(/\s+/));
const JOIN_MODS = new Set(['LEFT', 'RIGHT', 'FULL', 'OUTER', 'INNER', 'CROSS', 'NATURAL']);
const ITEM_END = new Set(['WHERE', 'GROUP', 'HAVING', 'QUALIFY', 'WINDOW', 'ORDER', 'LIMIT', 'UNION', 'INTERSECT',
  'ON', 'USING', 'JOIN', ...JOIN_MODS,
  // statements that start without a `;` before them (SQL Server)
  'GO', 'DECLARE', 'SET', 'CREATE', 'DROP', 'INSERT', 'UPDATE', 'DELETE', 'MERGE', 'TRUNCATE', 'INTO', 'VALUES', 'OPTION']);
// Tokens an expression can end with, so that a following bare word is its alias.
const endsExpr = (t) => ['qident', 'number', 'string', 'param', 'sysvar'].includes(t.t) || t.s === ')' || t.s === ']' ||
  (t.t === 'ident' && (!RESERVED.has(t.u) || ['END', 'NULL', 'TRUE', 'FALSE'].includes(t.u)));

// `FROM t u` -> `FROM t AS u`, `COUNT(*) n` -> `COUNT(*) AS n`, bare `JOIN` -> `INNER JOIN`
// (sqlfluff AL01, AL02, AM05).
function explicitAliasesAndJoins(text, tokenize, kw = (s) => s) {
  const T = tokenize(text).filter((t) => t.t !== 'ws' && t.t !== 'comment');
  const inserts = []; // { at, s }
  const frames = [{ mode: null, start: 0 }];
  const top = () => frames[frames.length - 1];
  const closeItem = (end) => {
    const f = top();
    if (!f.mode) return;
    const last = T[end - 1];
    const prev = T[end - 2];
    if (end - f.start < 2 || !last || last.t !== 'ident' || RESERVED.has(last.u)) return;
    if (!endsExpr(prev) || prev.u === 'AS' || T[end - 3]?.s === '.' && prev.t !== 'ident' && prev.t !== 'qident') return;
    if (UNITS.has(last.u) && T.slice(f.start, end).some((t) => t.u === 'INTERVAL')) return;
    inserts.push({ at: last.a, s: kw('AS ') });
  };
  const open = (i, mode) => { closeItem(i); Object.assign(top(), { mode, start: i + 1 }); };
  for (let i = 0; i < T.length; i++) {
    const t = T[i];
    if (t.s === '(' || t.s === '[') { frames.push({ mode: null, start: i + 1 }); continue; }
    if (t.s === ')' || t.s === ']') {
      closeItem(i);
      if (frames.length > 1) frames.pop();
      continue;
    }
    if (t.s === ';') { open(i, null); continue; }
    if (t.s === ',') { if (top().mode) open(i, top().mode); continue; }
    if (t.t !== 'ident') continue;
    if (t.u === 'JOIN' && !JOIN_MODS.has(T[i - 1]?.u)) inserts.push({ at: t.a, s: kw('INNER ') });
    if (t.u === 'ON' && T[i - 1]?.u === 'DISTINCT') continue; // Postgres DISTINCT ON (…)
    if (t.u === 'SELECT') open(i, 'select');
    else if (t.u === 'TOP' && top().mode === 'select' && (top().start === i || (top().start === i - 1 && ['DISTINCT', 'ALL'].includes(T[i - 1].u)))) {
      // SQL Server: SELECT TOP 10 / TOP (10) [PERCENT] [WITH TIES]: not part of the first item
      let j = i + 1;
      if (T[j]?.s === '(') { let d = 0; for (; j < T.length; j++) { if (T[j].s === '(') d++; else if (T[j].s === ')' && --d === 0) break; } }
      j++;
      if (T[j]?.u === 'PERCENT') j++;
      if (T[j]?.u === 'WITH' && T[j + 1]?.u === 'TIES') j += 2;
      top().start = j;
      i = j - 1;
    }
    else if (t.u === 'FROM' || t.u === 'JOIN' || t.u === 'APPLY') open(i, 'from');
    else if (t.u === 'WITH' && T[i + 1]?.s === '(' && top().mode === 'from') {
      // SQL Server table hints, FROM t AS x WITH (NOLOCK): after the alias
      open(i, 'from');
      let d = 0;
      for (i++; i < T.length; i++) { if (T[i].s === '(') d++; else if (T[i].s === ')' && --d === 0) break; }
      top().start = i + 1;
    }
    else if (t.u === 'WITH' && top().mode !== 'from') open(i, null);
    else if (ITEM_END.has(t.u) || (t.u === 'EXCEPT' && T[i + 1]?.s !== '(')) open(i, null);
  }
  closeItem(T.length);
  let res = text;
  for (const { at, s } of inserts.sort((a, b) => b.at - a.at)) res = res.slice(0, at) + s + res.slice(at);
  return res;
}

const indentOf = (l) => /^\s*/.exec(l)[0].length;

// Lines that start inside a multi-line string or block comment: never re-indented.
function frozenLines(text, tokenize) {
  const frozen = new Set();
  let line = 0;
  let pos = 0;
  for (const t of tokenize(text)) {
    for (; pos < t.a; pos++) if (text[pos] === '\n') line++;
    const nl = (t.s.match(/\n/g) || []).length;
    if (nl && (t.t === 'string' || t.t === 'comment')) for (let k = 1; k <= nl; k++) frozen.add(line + k);
    line += nl;
    pos = t.b;
  }
  return frozen;
}

// sql-formatter puts a clause's body on the lines below it:
//     WITH                       WITH a AS (
//       a AS (                     SELECT …
//         SELECT …        ->     ),
//       ),
//       b AS (…)                 b AS (…)
//     FROM                       FROM t AS x
//       t AS x                   LEFT JOIN u AS y ON …
//       LEFT JOIN u AS y ON …
// Pull the first line up next to WITH / FROM and dedent the rest, with a blank
// line after each CTE (sqlfluff's layout).
function hoistClauseBodies(text, tokenize, hash = true) {
  const lines = text.split('\n');
  const frozen = frozenLines(text, tokenize);
  const blankAfter = new Set();
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*)(WITH|WITH RECURSIVE|FROM)$/i.exec(lines[i]);
    if (!m) continue;
    const ind = m[1].length;
    let j = i + 1;
    while (j < lines.length && lines[j].trim() && indentOf(lines[j]) >= ind + 2) j++;
    const body = lines.slice(i + 1, j);
    if (!body.length || indentOf(body[0]) !== ind + 2 || (hash ? /^\s*(--|#|\/\*)/ : /^\s*(--|\/\*)/).test(body[0])) continue;
    let ok = true;
    for (let k = i + 1; k < j; k++) if (frozen.has(k)) ok = false;
    // `FROM a,\n  b` (comma join) reads worse hoisted; leave it.
    if (m[2].toUpperCase() === 'FROM' && body.some((l) => indentOf(l) === ind + 2 && /,\s*$/.test(l))) ok = false;
    if (!ok) continue;
    lines[i] = `${m[1]}${m[2]} ${body[0].trim()}`;
    for (let k = i + 2; k < j; k++) lines[k - 1] = lines[k].slice(2);
    lines.splice(j - 1, 1);
    // Shift remembered blank-line positions below this edit.
    for (const b of [...blankAfter]) if (b > i) { blankAfter.delete(b); blankAfter.add(b - 1); }
    if (m[2].toUpperCase() !== 'FROM') {
      const close = ' '.repeat(ind) + ')';
      for (let k = i; k < j - 1; k++) {
        if (lines[k] === close + ',' || (lines[k] === close && k === j - 2 && lines[k + 1]?.trim())) blankAfter.add(k);
      }
    }
    for (let k = i + 1; k < j - 1; k++) if (frozen.has(k + 1)) { frozen.delete(k + 1); frozen.add(k); }
  }
  return lines.flatMap((l, k) => (blankAfter.has(k) ? [l, ''] : [l])).join('\n');
}

// SQL Server layout fixes on sql-formatter's output:
//     SELECT                    SELECT TOP 10
//       TOP 10 a,       ->        a,
//     INTO                      INTO #team
//       #team
//     FROM t AS x               FROM t AS x WITH (NOLOCK)
//     WITH (nolock)
//     DECLARE @a INT = 1,       DECLARE @a INT = 1,
//     @b DATE                           @b DATE
const HINTS = 'NOLOCK|READUNCOMMITTED|READCOMMITTED|READPAST|HOLDLOCK|UPDLOCK|ROWLOCK|PAGLOCK|TABLOCKX?|XLOCK|NOWAIT|SERIALIZABLE|REPEATABLEREAD|SNAPSHOT|FORCESEEK|FORCESCAN|NOEXPAND';
const TABLE_HINT = new RegExp(`^\\s*WITH \\(((?:${HINTS})(?:\\s*,\\s*(?:${HINTS}))*)\\)(.*)$`, 'i');
function tsqlLayout(text) {
  let out = text.replace(/^(\s*)(SELECT(?: DISTINCT)?)\n(\s+)(TOP\s+(?:\([^()\n]*\)|\S+)(?:\s+PERCENT)?(?:\s+WITH\s+TIES)?)\s+/gim, '$1$2 $4\n$3');
  out = out.replace(/^(\s*)(INTO)\n\s+(\S+)$/gim, '$1$2 $3');
  out = out.replace(/^(\s*)(WITH)\n\s+(\([^()\n]*\))$/gim, (m, ind, w, h) => (TABLE_HINT.test(`WITH ${h}`) ? `${ind}${w} ${h}` : m));
  const lines = out.split('\n');
  const res = [];
  let inDeclare = false;
  for (const l of lines) {
    const hint = TABLE_HINT.exec(l);
    if (hint && res.length && res[res.length - 1].trim()) {
      res[res.length - 1] += ` ${/with/.test(l) ? 'with' : 'WITH'} (${hint[1].toUpperCase()})${hint[2]}`;
      continue;
    }
    const more = inDeclare && /^@/.test(l);
    res.push(more ? ' '.repeat(8) + l : l);
    inDeclare = (more || /^DECLARE /i.test(l)) && /,\s*$/.test(l);
  }
  return res.join('\n');
}

// WHERE / HAVING / QUALIFY with a short, flat body go on one line:
//   WHERE u.country IN ('SG', 'MY') AND u.is_seller = TRUE
function collapseShortConditions(text, hash = true) {
  const lines = text.split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*)(WHERE|HAVING|QUALIFY)$/i.exec(lines[i]);
    if (!m) { out.push(lines[i]); continue; }
    const ind = m[1].length;
    let j = i + 1;
    while (j < lines.length && lines[j].trim() && indentOf(lines[j]) >= ind + 2) j++;
    const body = lines.slice(i + 1, j);
    const flat = body.length && body.every((l) => indentOf(l) === ind + 2 && !(hash ? /(--|#|\/\*)/ : /(--|\/\*)/).test(l));
    const joined = `${m[1]}${m[2]} ${body.map((l) => l.trim()).join(' ')}`;
    if (flat && (body.length === 1 || joined.length <= 90)) {
      out.push(joined);
      i = j - 1;
    } else {
      out.push(lines[i]);
    }
  }
  return out.join('\n');
}
