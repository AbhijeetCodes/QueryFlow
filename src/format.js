import { formatDialect, bigquery, postgresql, mysql } from 'sql-formatter';
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
};

export function formatSql(src, dialect = 'bigquery') {
  const fmt = FORMATTER[dialect] || FORMATTER.bigquery;
  const tok = (text) => tokenize(text, dialect);
  const { text, trailing } = liftTrailingComments(src, tok);
  let out = formatDialect(text, {
    ...fmt,
    keywordCase: 'upper',
    dataTypeCase: 'upper',
    functionCase: 'upper',
    tabWidth: 2,
    linesBetweenQueries: 1,
    logicalOperatorNewline: 'before',
    expressionWidth: 60,
  });
  out = distinctOnLine(out);
  out = upperTypesAndUnits(out, tok);
  out = explicitAliasesAndJoins(out, tok);
  out = reattachCommas(out, tok);
  out = collapseShortLists(out);
  out = hoistClauseBodies(out, tok);
  out = collapseShortConditions(out);
  out = restoreTrailingComments(out, trailing, tok);
  // `SET\n  @x = 1;` and `LIMIT\n  10` on one line
  out = out.replace(/^SET\n {2}([^\n]*;)$/gm, 'SET $1');
  out = out.replace(/^(\s*)LIMIT\n\s+([^\n]+)$/gm, '$1LIMIT $2');
  // keep consecutive DECLAREs (SET @vars) together
  out = out.replace(/^(DECLARE[^\n]*;)\n\n(?=DECLARE)/gm, '$1\n');
  out = out.replace(/^(SET @[^\n]*;)\n\n(?=SET @)/gm, '$1\n');
  return out.endsWith('\n') ? out : out + '\n';
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
  return text.replace(/^(\s*)SELECT DISTINCT\n\s+ON (\([^()\n]*\)) ?([^\n]*)$/gm,
    (m, ind, keys, rest) => `${ind}SELECT DISTINCT ON ${keys}` + (rest ? `\n${ind}  ${rest}` : ''));
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
function reattachCommas(text, tokenize) {
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*),\s*(.*)$/.exec(lines[i]);
    if (!m) continue;
    let j = i - 1;
    while (j >= 0 && (/^\s*(--|#)/.test(lines[j]) || !lines[j].trim())) j--;
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
    const m = /^(\s*)(GROUP BY|ORDER BY|PARTITION BY|SELECT|SELECT DISTINCT)$/.exec(lines[i]);
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
    const isSelect = m[2].startsWith('SELECT');
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
  'ON', 'USING', 'JOIN', ...JOIN_MODS]);
// Tokens an expression can end with, so that a following bare word is its alias.
const endsExpr = (t) => ['qident', 'number', 'string', 'param', 'sysvar'].includes(t.t) || t.s === ')' || t.s === ']' ||
  (t.t === 'ident' && (!RESERVED.has(t.u) || ['END', 'NULL', 'TRUE', 'FALSE'].includes(t.u)));

// `FROM t u` -> `FROM t AS u`, `COUNT(*) n` -> `COUNT(*) AS n`, bare `JOIN` -> `INNER JOIN`
// (sqlfluff AL01, AL02, AM05).
function explicitAliasesAndJoins(text, tokenize) {
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
    inserts.push({ at: last.a, s: 'AS ' });
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
    if (t.u === 'JOIN' && !JOIN_MODS.has(T[i - 1]?.u)) inserts.push({ at: t.a, s: 'INNER ' });
    if (t.u === 'ON' && T[i - 1]?.u === 'DISTINCT') continue; // Postgres DISTINCT ON (…)
    if (t.u === 'SELECT') open(i, 'select');
    else if (t.u === 'FROM' || t.u === 'JOIN') open(i, 'from');
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
function hoistClauseBodies(text, tokenize) {
  const lines = text.split('\n');
  const frozen = frozenLines(text, tokenize);
  const blankAfter = new Set();
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*)(WITH|WITH RECURSIVE|FROM)$/.exec(lines[i]);
    if (!m) continue;
    const ind = m[1].length;
    let j = i + 1;
    while (j < lines.length && lines[j].trim() && indentOf(lines[j]) >= ind + 2) j++;
    const body = lines.slice(i + 1, j);
    if (!body.length || indentOf(body[0]) !== ind + 2 || /^\s*(--|#|\/\*)/.test(body[0])) continue;
    let ok = true;
    for (let k = i + 1; k < j; k++) if (frozen.has(k)) ok = false;
    // `FROM a,\n  b` (comma join) reads worse hoisted; leave it.
    if (m[2] === 'FROM' && body.some((l) => indentOf(l) === ind + 2 && /,\s*$/.test(l))) ok = false;
    if (!ok) continue;
    lines[i] = `${m[1]}${m[2]} ${body[0].trim()}`;
    for (let k = i + 2; k < j; k++) lines[k - 1] = lines[k].slice(2);
    lines.splice(j - 1, 1);
    // Shift remembered blank-line positions below this edit.
    for (const b of [...blankAfter]) if (b > i) { blankAfter.delete(b); blankAfter.add(b - 1); }
    if (m[2] !== 'FROM') {
      const close = ' '.repeat(ind) + ')';
      for (let k = i; k < j - 1; k++) {
        if (lines[k] === close + ',' || (lines[k] === close && k === j - 2 && lines[k + 1]?.trim())) blankAfter.add(k);
      }
    }
    for (let k = i + 1; k < j - 1; k++) if (frozen.has(k + 1)) { frozen.delete(k + 1); frozen.add(k); }
  }
  return lines.flatMap((l, k) => (blankAfter.has(k) ? [l, ''] : [l])).join('\n');
}

// WHERE / HAVING / QUALIFY with a short, flat body go on one line:
//   WHERE u.country IN ('SG', 'MY') AND u.is_seller = TRUE
function collapseShortConditions(text) {
  const lines = text.split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*)(WHERE|HAVING|QUALIFY)$/.exec(lines[i]);
    if (!m) { out.push(lines[i]); continue; }
    const ind = m[1].length;
    let j = i + 1;
    while (j < lines.length && lines[j].trim() && indentOf(lines[j]) >= ind + 2) j++;
    const body = lines.slice(i + 1, j);
    const flat = body.length && body.every((l) => indentOf(l) === ind + 2 && !/^\s*(--|#|\/\*)/.test(l) && !/(--|#|\/\*)/.test(l));
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
