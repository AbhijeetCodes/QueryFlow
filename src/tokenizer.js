// Tolerant BigQuery (GoogleSQL) tokenizer. Never throws: malformed input
// produces tokens flagged with `err` so the linter can point at them.
//
// Token: { t: type, s: text, a: from, b: to, u?: UPPER (words), err?: msg }
// Types: ws, comment, string, number, ident, qident (`quoted`), param (@x),
//        sysvar (@@x), op, punct

const MULTI_OPS = ['|>', '<=', '>=', '<>', '!=', '||', '<<', '>>', '=>', '->'];
const SINGLE_OPS = '=<>+-*/%&|^~!:?';
const PUNCT = '(),;.[]{}';

const STRING_START = /([rRbB]{1,2})?('''|"""|'|")/y;
const WORD = /[A-Za-z_][A-Za-z0-9_]*/y;
const PATH_PART = /[A-Za-z0-9_]+/y; // after a dot, parts may start with digits
const NUMBER = /(?:0[xX][0-9a-fA-F]+|(?:\d+(?:\.\d+|\.(?![A-Za-z_]))?|\.\d+)(?:[eE][+-]?\d+)?)/y;

function stickyMatch(re, src, i) {
  re.lastIndex = i;
  const m = re.exec(src);
  return m ? m : null;
}

export function tokenize(src) {
  const toks = [];
  const n = src.length;
  let i = 0;

  const push = (t, a, b, extra) => {
    const tok = { t, s: src.slice(a, b), a, b };
    if (extra) Object.assign(tok, extra);
    toks.push(tok);
    return tok;
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

    // line comments: -- and #
    if ((c === '-' && src[i + 1] === '-') || c === '#') {
      while (i < n && src[i] !== '\n') i++;
      push('comment', start, i);
      continue;
    }

    // block comment
    if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      if (end === -1) {
        i = n;
        push('comment', start, i, { err: 'Unterminated comment' });
      } else {
        i = end + 2;
        push('comment', start, i);
      }
      continue;
    }

    // strings (with optional r/b prefixes)
    if (c === "'" || c === '"' || /[rRbB]/.test(c)) {
      const m = stickyMatch(STRING_START, src, i);
      if (m && (!m[1] || /^(r|b|rb|br)$/i.test(m[1]))) {
        const prefix = m[1] || '';
        const q = m[2];
        const raw = /r/i.test(prefix);
        let j = i + prefix.length + q.length;
        let closed = false;
        while (j < n) {
          const ch = src[j];
          if (!raw && ch === '\\') { j += 2; continue; }
          if (q.length === 1 && ch === '\n') break;
          if (src.startsWith(q, j)) { j += q.length; closed = true; break; }
          j++;
        }
        if (j > n) j = n;
        push('string', start, j, {
          pre: prefix.length,
          q: q.length,
          ...(closed ? {} : { err: 'Unterminated string' }),
        });
        i = j;
        continue;
      }
    }

    // backtick-quoted identifier
    if (c === '`') {
      let j = i + 1;
      let closed = false;
      while (j < n) {
        if (src[j] === '\\') { j += 2; continue; }
        if (src[j] === '`') { j++; closed = true; break; }
        if (src[j] === '\n') break;
        j++;
      }
      push('qident', start, Math.min(j, n), closed ? undefined : { err: 'Unterminated `identifier`' });
      i = Math.min(j, n);
      continue;
    }

    // parameters / system variables
    if (c === '@') {
      if (src[i + 1] === '@') {
        const m = stickyMatch(WORD, src, i + 2);
        i = m ? i + 2 + m[0].length : i + 2;
        push('sysvar', start, i);
      } else {
        const m = stickyMatch(WORD, src, i + 1);
        i = m ? i + 1 + m[0].length : i + 1;
        push('param', start, i, { name: src.slice(start + 1, i) });
      }
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
      const m = stickyMatch(WORD, src, i);
      i += m[0].length;
      push('ident', start, i, { u: m[0].toUpperCase() });
      continue;
    }

    if (PUNCT.includes(c)) {
      i++;
      push('punct', start, i);
      continue;
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

export function unquoteIdent(s) {
  return s.startsWith('`') ? s.slice(1, s.endsWith('`') && s.length > 1 ? -1 : undefined) : s;
}
