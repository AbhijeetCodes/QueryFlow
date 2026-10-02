// Tolerant SQL tokenizer for BigQuery (GoogleSQL), PostgreSQL and MySQL. Never
// throws: malformed input produces tokens flagged with `err` so the linter can
// point at them.
//
// Token: { t: type, s: text, a: from, b: to, u?: UPPER (words), err?: msg }
// Types: ws, comment, string, number, ident, qident (`quoted` / "quoted"),
//        param (@x, $1, :x — with `name` and `sigil`), sysvar (@@x), op, punct

import { dialectOf } from './dialect.js';

const MULTI_OPS = ['|>', '<=', '>=', '<>', '!=', '||', '<<', '>>', '=>', '->', '::', ':='];
// Postgres operators, longest first (JSON, containment, regex, text search).
const PG_OPS = ['#>>', '->>', '!~*', '#>', '@>', '<@', '?|', '?&', '~*', '!~', '&&', '@@', '#-'];
const SINGLE_OPS = '=<>+-*/%&|^~!:?#@';
const PUNCT = '(),;.[]{}';

const WORD = /[A-Za-z_][A-Za-z0-9_]*/y;
const WORD_DOLLAR = /[A-Za-z_][A-Za-z0-9_$]*/y; // Postgres and MySQL allow $ after the first letter
const PATH_PART = /[A-Za-z0-9_]+/y; // after a dot, parts may start with digits
const NUMBER = /(?:0[xX][0-9a-fA-F]+|(?:\d+(?:\.\d+|\.(?![A-Za-z_]))?|\.\d+)(?:[eE][+-]?\d+)?)/y;
const DOLLAR_TAG = /\$([A-Za-z_][A-Za-z0-9_]*)?\$/y;

function stickyMatch(re, src, i) {
  re.lastIndex = i;
  const m = re.exec(src);
  return m ? m : null;
}

export function tokenize(src, dialect) {
  const D = dialectOf(dialect);
  const word = D.id === 'bigquery' ? WORD : WORD_DOLLAR;
  const toks = [];
  const n = src.length;
  let i = 0;

  const push = (t, a, b, extra) => {
    const tok = { t, s: src.slice(a, b), a, b };
    if (extra) Object.assign(tok, extra);
    toks.push(tok);
    return tok;
  };

  // A quoted run starting at i (after any prefix): returns [end, closed].
  const scanQuoted = (j, q, { backslash, doubled, multiline }) => {
    while (j < n) {
      const ch = src[j];
      if (backslash && ch === '\\') { j += 2; continue; }
      if (!multiline && q.length === 1 && ch === '\n') break;
      if (src.startsWith(q, j)) {
        if (doubled && q.length === 1 && src[j + 1] === q) { j += 2; continue; }
        return [j + q.length, true];
      }
      j++;
    }
    return [Math.min(j, n), false];
  };

  while (i < n) {
    const c = src[i];
    const start = i;

    // whitespace
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f') {
      while (i < n && /\s/.test(src[i])) i++;
      push('ws', start, i);
      continue;
    }

    // line comments: -- (and # in BigQuery / MySQL)
    if ((c === '-' && src[i + 1] === '-') || (c === '#' && D.hashComments)) {
      while (i < n && src[i] !== '\n') i++;
      push('comment', start, i);
      continue;
    }

    // block comment (Postgres nests them)
    if (c === '/' && src[i + 1] === '*') {
      let j = i + 2;
      let level = 1;
      while (j < n && level) {
        if (src[j] === '*' && src[j + 1] === '/') { level--; j += 2; continue; }
        if (D.nestedComments && src[j] === '/' && src[j + 1] === '*') { level++; j += 2; continue; }
        j++;
      }
      i = j;
      push('comment', start, i, level ? { err: 'Unterminated comment' } : undefined);
      continue;
    }

    // Postgres dollar-quoted strings: $$ … $$, $tag$ … $tag$
    if (c === '$' && D.dollarStrings) {
      const m = stickyMatch(DOLLAR_TAG, src, i);
      if (m) {
        const end = src.indexOf(m[0], i + m[0].length);
        const closed = end >= 0;
        i = closed ? end + m[0].length : n;
        push('string', start, i, { pre: 0, q: m[0].length, ...(closed ? {} : { err: 'Unterminated $$ string' }) });
        continue;
      }
    }

    // strings, with the dialect's prefixes (r'' b'' in BigQuery, E'' in Postgres, N'' in MySQL)
    if (c === "'" || (c === '"' && D.doubleQuote === 'string') || /[A-Za-z]/.test(c)) {
      const m = stickyMatch(D.stringPrefix, src, i);
      if (m && (!m[1] || D.id !== 'bigquery' || /^(r|b|rb|br)$/i.test(m[1]))) {
        const prefix = m[1] || '';
        const q = m[2];
        const raw = D.rawPrefix ? D.rawPrefix.test(prefix) : false;
        const backslash = !raw && (D.backslashEscapes || !!(D.escapePrefix && D.escapePrefix.test(prefix)));
        const [j, closed] = scanQuoted(i + prefix.length + q.length, q, { backslash, doubled: D.doubledQuotes, multiline: D.multilineStrings || q.length === 3 });
        push('string', start, Math.min(j, n), {
          pre: prefix.length,
          q: q.length,
          ...(closed ? {} : { err: 'Unterminated string' }),
        });
        i = Math.min(j, n);
        continue;
      }
    }

    // quoted identifiers: `x` (all), "x" (Postgres)
    if (c === '`' || (c === '"' && D.doubleQuote === 'ident')) {
      const [j, closed] = scanQuoted(i + 1, c, { backslash: D.id === 'bigquery', doubled: D.id !== 'bigquery', multiline: false });
      push('qident', start, j, closed ? undefined : { err: `Unterminated ${c}identifier${c}` });
      i = j;
      continue;
    }

    // parameters / variables / system variables: @x @@x (BigQuery, MySQL), $1 :x (Postgres)
    if (c === '@' && D.params.includes('@')) {
      if (src[i + 1] === '@') {
        const m = stickyMatch(word, src, i + 2);
        i = m ? i + 2 + m[0].length : i + 2;
        while (D.id === 'mysql' && src[i] === '.' && stickyMatch(word, src, i + 1)) i += 1 + stickyMatch(word, src, i + 1)[0].length;
        push('sysvar', start, i);
      } else if (D.id === 'mysql' && (src[i + 1] === "'" || src[i + 1] === '"' || src[i + 1] === '`')) {
        const [j] = scanQuoted(i + 2, src[i + 1], { backslash: true, doubled: true, multiline: false });
        i = j;
        push('param', start, i, { name: src.slice(start + 2, i - 1), sigil: '@' });
      } else {
        const m = stickyMatch(word, src, i + 1);
        i = m ? i + 1 + m[0].length : i + 1;
        push('param', start, i, { name: src.slice(start + 1, i), sigil: '@' });
      }
      continue;
    }
    if (c === '$' && D.params.includes('$') && /[0-9]/.test(src[i + 1] || '')) {
      i++;
      while (i < n && /[0-9]/.test(src[i])) i++;
      push('param', start, i, { name: src.slice(start + 1, i), sigil: '$' });
      continue;
    }
    if (c === ':' && D.params.includes(':') && src[i + 1] !== ':' && src[i - 1] !== ':' && /[A-Za-z_]/.test(src[i + 1] || '')) {
      const m = stickyMatch(word, src, i + 1);
      i += 1 + m[0].length;
      push('param', start, i, { name: src.slice(start + 1, i), sigil: ':' });
      continue;
    }

    // identifier path parts right after a dot may start with digits (dataset.2024_sales)
    const prev = toks.length ? toks[toks.length - 1] : null;
    if (prev && prev.s === '.' && prev.b === i && /[0-9]/.test(c)) {
      const m = stickyMatch(PATH_PART, src, i);
      if (m && /[A-Za-z_]/.test(m[0])) {
        i += m[0].length;
        push('ident', start, i, { u: m[0].toUpperCase() });
        continue;
      }
    }

    // numbers
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] || ''))) {
      const m = stickyMatch(NUMBER, src, i);
      if (m) {
        i += m[0].length;
        push('number', start, i);
        continue;
      }
    }

    // words
    if (/[A-Za-z_]/.test(c)) {
      const m = stickyMatch(word, src, i);
      i += m[0].length;
      push('ident', start, i, { u: m[0].toUpperCase() });
      continue;
    }

    if (PUNCT.includes(c)) {
      i++;
      push('punct', start, i);
      continue;
    }

    if (D.atIsOperator) {
      const op = PG_OPS.find((o) => src.startsWith(o, i));
      if (op) {
        i += op.length;
        push('op', start, i);
        continue;
      }
    }
    const op2 = src.slice(i, i + 2);
    if (MULTI_OPS.includes(op2)) {
      i += 2;
      push('op', start, i);
      continue;
    }
    if (SINGLE_OPS.includes(c)) {
      i++;
      push('op', start, i);
      continue;
    }

    // anything else (unicode etc.)
    i++;
    push('op', start, i);
  }
  return toks;
}

// Span of a string token's contents, excluding prefix and quotes.
export function stringInner(tok) {
  const from = tok.a + (tok.pre || 0) + (tok.q || 1);
  const to = tok.err ? tok.b : tok.b - (tok.q || 1);
  return { from, to: Math.max(from, to) };
}

// `x` or "x" -> x (a doubled quote inside stands for one).
export function unquoteIdent(s) {
  const q = s[0];
  if (q !== '`' && q !== '"') return s;
  const inner = s.slice(1, s.length > 1 && s.endsWith(q) ? -1 : undefined);
  return inner.split(q + q).join(q);
}
