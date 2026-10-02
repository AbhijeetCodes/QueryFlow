// The SQL dialects QueryFlow reads. A dialect decides how the tokenizer reads
// quotes, comments and parameters, which lint rules apply, and how a hardcoded
// value becomes a variable. Everything else (CTE graph, steps, rename, …) is
// the same SQL in all of them.

const words = (s) => new Set(s.split(/\s+/).filter(Boolean));

export const DIALECTS = {
  bigquery: {
    id: 'bigquery',
    name: 'BigQuery',
    // tokenizer
    hashComments: true,
    doubleQuote: 'string',
    backslashEscapes: true,
    doubledQuotes: false,
    multilineStrings: false,
    stringPrefix: /([rRbB]{1,2})?('''|"""|'|")/y,
    rawPrefix: /r/i,
    dollarStrings: false,
    params: '@',
    // analysis
    vars: 'declare', // DECLARE name TYPE DEFAULT value
    arrays: true, // IN ('a', 'b') can become an ARRAY variable
    reserved: words(''),
    types: ['STRING', 'DATE', 'DATETIME', 'TIMESTAMP', 'INT64', 'FLOAT64', 'NUMERIC', 'BOOL'],
    paramNote: 'its value is set in BigQuery when the query runs',
    paramLint: (p) => `${p} is a query parameter — set it in BigQuery query settings, or turn it into a DECLARE variable from the side panel`,
  },
  postgres: {
    id: 'postgres',
    name: 'PostgreSQL',
    hashComments: false,
    doubleQuote: 'ident',
    backslashEscapes: false, // only in E'…' strings
    doubledQuotes: true,
    multilineStrings: true,
    stringPrefix: /([eEbBxXnN]|[uU]&)?(')/y,
    rawPrefix: null,
    escapePrefix: /^e$/i,
    dollarStrings: true,
    nestedComments: true,
    params: '$:', // $1 and :name
    atIsOperator: true,
    vars: null, // plain SQL has no script variables; a params CTE plays that role
    arrays: false,
    reserved: words(`OFFSET RETURNING ILIKE SIMILAR ONLY ANALYZE ANALYSE CONSTRAINT CHECK PRIMARY REFERENCES
      FOREIGN UNIQUE VARIADIC LOCALTIME LOCALTIMESTAMP CURRENT_DATE CURRENT_TIME CURRENT_TIMESTAMP CURRENT_USER
      SESSION_USER USER LEADING TRAILING BOTH SYMMETRIC ASYMMETRIC`),
    types: [],
    paramNote: 'its value is bound by the client when the query runs',
    paramLint: (p) => `${p} is a bind parameter — its value comes from the client that runs the query`,
  },
  mysql: {
    id: 'mysql',
    name: 'MySQL',
    hashComments: true,
    doubleQuote: 'string',
    backslashEscapes: true,
    doubledQuotes: true,
    multilineStrings: true,
    stringPrefix: /([nNbBxX])?('|")/y,
    rawPrefix: null,
    dollarStrings: false,
    params: '@',
    vars: 'set', // SET @name = value
    arrays: false,
    reserved: words(`OFFSET STRAIGHT_JOIN FORCE USE REGEXP RLIKE DIV XOR CURRENT_DATE CURRENT_TIME
      CURRENT_TIMESTAMP CURRENT_USER LOCALTIME LOCALTIMESTAMP UTC_DATE UTC_TIME UTC_TIMESTAMP`),
    types: [],
    paramNote: 'it is never SET in this script, so it is NULL unless the session set it',
    paramLint: (p) => `${p} is never SET in this script — it is NULL unless the session set it earlier. Turn it into a SET from the side panel.`,
  },
};

export const DIALECT_IDS = Object.keys(DIALECTS);

export const dialectOf = (id) => DIALECTS[id] || DIALECTS.bigquery;

// The editor's dialect. analyzeDoc() reads it, so the panels and the editor
// always agree on how the SQL is read.
let current = 'bigquery';
export const currentDialect = () => current;
export function setCurrentDialect(id) { current = DIALECTS[id] ? id : 'bigquery'; }

const SIMPLE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** A table path as the dialect writes it: `proj.ds.t` in BigQuery, quoted parts only where needed elsewhere. */
export function quoteTable(full, id) {
  if (id === 'bigquery') return '`' + full + '`';
  const q = id === 'mysql' ? '`' : '"';
  return full.split('.').map((p) => (SIMPLE.test(p) && (id === 'mysql' || p === p.toLowerCase()) ? p : q + p.split(q).join(q + q) + q)).join('.');
}

/** An identifier with its quotes taken off (`x`, "x"). */
export const bareName = (s) => String(s ?? '').replace(/[`"]/g, '');
