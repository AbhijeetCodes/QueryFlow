// The SQL dialects QueryFlow reads (BigQuery, PostgreSQL, MySQL, SQL Server). A dialect decides how the tokenizer reads
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
  sqlserver: {
    id: 'sqlserver',
    name: 'SQL Server',
    hashComments: false,
    doubleQuote: 'ident',
    backslashEscapes: false,
    doubledQuotes: true,
    multilineStrings: true,
    stringPrefix: /([nN])?(')/y,
    rawPrefix: null,
    dollarStrings: false,
    bracketIdents: true, // [Order Details]
    hashNames: true, // #temp and ##global temp tables
    params: '@',
    vars: 'tsql', // DECLARE @name TYPE = value, SET @name = value
    arrays: false,
    reserved: words(`TOP PERCENT OFFSET FETCH APPLY PIVOT UNPIVOT OPTION CURRENT_DATE CURRENT_TIMESTAMP
      CURRENT_USER SESSION_USER SYSTEM_USER IDENTITY`),
    types: ['NVARCHAR(100)', 'DATE', 'DATETIME2', 'INT', 'BIGINT', 'DECIMAL(18, 2)', 'BIT'],
    typeOf: { STRING: 'NVARCHAR(100)', INT64: 'INT', FLOAT64: 'DECIMAL(18, 2)', TIMESTAMP: 'DATETIME2', DATETIME: 'DATETIME2', BOOL: 'BIT' },
    paramNote: 'it is never declared in this script, so it must be a parameter of the procedure or come from the caller',
    paramLint: (p) => `${p} is never declared in this script — SQL Server needs DECLARE ${p} <type> unless it is a procedure parameter. Turn it into a DECLARE from the side panel.`,
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
  if (id === 'sqlserver') return full.split('.').map((p) => (SIMPLE.test(p) ? p : '[' + p.split(']').join(']]') + ']')).join('.');
  const q = id === 'mysql' ? '`' : '"';
  return full.split('.').map((p) => (SIMPLE.test(p) && (id === 'mysql' || p === p.toLowerCase()) ? p : q + p.split(q).join(q + q) + q)).join('.');
}

/** An identifier with its quotes taken off (`x`, "x", [x]). */
export const bareName = (s) => String(s ?? '').replace(/[`"[\]]/g, '');

// ---- detection ------------------------------------------------------------------
// Clues that a query was written for one dialect: [dialect, weight, label, pattern].
// `raw` patterns look at string contents too; the rest see strings as '' so a
// value like '#1' or 'a::b' can't vote.
const CLUES = [
  ['bigquery', 3, 'backtick project.dataset paths', /`[\w-]+\.[\w-]+(\.[\w-]+)?`/],
  ['bigquery', 3, 'DECLARE … DEFAULT', /\bDECLARE\s+\w+(\s*,\s*\w+)*\s+[A-Za-z][\w<>, ]*?\s+DEFAULT\b/i],
  ['bigquery', 2, 'QUALIFY', /\bQUALIFY\b/i],
  ['bigquery', 2, 'SAFE_ functions', /\bSAFE(_CAST|_DIVIDE|\.)/i],
  ['bigquery', 2, 'BigQuery types', /\b(INT64|FLOAT64|BIGNUMERIC)\b|\b(STRUCT|ARRAY)\s*</i],
  ['bigquery', 3, 'partition pseudo-columns', /\b_(PARTITIONTIME|PARTITIONDATE|TABLE_SUFFIX)\b/i],
  ['bigquery', 2, 'BigQuery date functions', /\b(TIMESTAMP|DATETIME)_(SUB|ADD|DIFF|TRUNC)\s*\(|\b(FORMAT|PARSE)_(DATE|TIMESTAMP|DATETIME)\s*\(|\bGENERATE_DATE_ARRAY\b|\bCOUNTIF\s*\(/i],
  ['bigquery', 3, 'CREATE TEMP FUNCTION', /\bCREATE\s+(OR\s+REPLACE\s+)?TEMP(ORARY)?\s+FUNCTION\b/i],
  ['bigquery', 3, 'FOR SYSTEM_TIME AS OF', /\bFOR\s+SYSTEM_TIME\b/i],
  ['bigquery', 2, 'SELECT * EXCEPT (…)', /\*\s*EXCEPT\s*\(\s*(?!SELECT\b|WITH\b|\()[A-Za-z_`]/i],
  ['bigquery', 2, 'DATE_TRUNC(x, MONTH)', /\bDATE_TRUNC\s*\([^()']*,\s*(DAY|WEEK|ISOWEEK|MONTH|QUARTER|YEAR)\s*\)/i],
  ['postgres', 3, ':: casts', /[\w)'\]]\s*::\s*[A-Za-z_]/],
  ['postgres', 3, '$$ strings', /\$\w*\$[\s\S]*?\$\w*\$/, 'raw'],
  ['postgres', 2, '$1 parameters', /\$\d+\b/],
  ['postgres', 3, 'DISTINCT ON', /\bDISTINCT\s+ON\s*\(/i],
  ['postgres', 2, 'ILIKE', /\bILIKE\b/i],
  ['postgres', 2, "INTERVAL '7 days'", /\bINTERVAL\s+'\s*-?\d+\s*[a-z]+\s*'/i, 'raw'],
  ['postgres', 2, "date_trunc('month', …)", /\bDATE_TRUNC\s*\(\s*'/i, 'raw'],
  ['postgres', 2, 'generate_series', /\bGENERATE_SERIES\s*\(/i],
  ['postgres', 2, 'Postgres types', /\b(JSONB|TIMESTAMPTZ|BIGSERIAL|SERIAL)\b/i],
  ['postgres', 2, 'RETURNING', /\bRETURNING\b/i],
  ['mysql', 3, 'SET @variables', /\bSET\s+@\w+\s*:?=/i],
  ['mysql', 3, ':= assignments', /@\w+\s*:=/],
  ['mysql', 3, '`db`.`table` names', /`[^`.\n]+`\.`[^`\n]+`/],
  ['mysql', 2, 'MySQL date functions', /\b(DATE_FORMAT|STR_TO_DATE|UNIX_TIMESTAMP|FROM_UNIXTIME)\s*\(/i],
  ['mysql', 3, 'CURDATE()', /\bCURDATE\s*\(/i],
  ['mysql', 3, 'GROUP_CONCAT', /\bGROUP_CONCAT\s*\(/i],
  ['mysql', 3, 'LIMIT offset, count', /\bLIMIT\s+\d+\s*,\s*\d+/i],
  ['mysql', 3, 'MySQL table options', /\b(AUTO_INCREMENT|STRAIGHT_JOIN|UNSIGNED|TINYINT|MEDIUMINT)\b|\bENGINE\s*=/i],
  ['sqlserver', 4, 'DECLARE @variables', /\bDECLARE\s+@\w+/i],
  ['sqlserver', 3, '[bracketed] names', /\[[A-Za-z_][\w ]*\]\s*\.\s*\[?[A-Za-z_]|\b(FROM|JOIN)\s+\[[A-Za-z_][\w ]*\]/i],
  ['sqlserver', 3, 'SELECT TOP n', /\bSELECT\s+(DISTINCT\s+)?TOP\s*\(?\s*(\d+|@\w+)/i],
  ['sqlserver', 3, '#temp tables', /\b(INTO|FROM|JOIN|TABLE)\s+##?[A-Za-z_]/i],
  ['sqlserver', 3, 'CROSS / OUTER APPLY', /\b(CROSS|OUTER)\s+APPLY\b/i],
  ['sqlserver', 3, 'WITH (NOLOCK)', /\bWITH\s*\(\s*NOLOCK\s*\)/i],
  ['sqlserver', 2, 'SQL Server functions', /\b(GETDATE|GETUTCDATE|SYSDATETIME|ISNULL|DATEADD|DATEDIFF|DATEPART|DATENAME|EOMONTH|IIF|CHARINDEX|LEN)\s*\(/i],
  ['sqlserver', 2, 'SQL Server types', /\b(NVARCHAR|DATETIME2|UNIQUEIDENTIFIER|SMALLDATETIME|DATETIMEOFFSET|MONEY)\b/i],
  ['sqlserver', 3, 'GO batches', /^\s*GO\s*$/im],
];

// The text without comments, and a copy with string contents removed too.
function scrub(src) {
  let raw = '';
  let code = '';
  const n = src.length;
  let lineStart = true; // only blanks so far on this line
  for (let i = 0; i < n;) {
    const c = src[i];
    if (c === '\n') lineStart = true;
    else if (c !== ' ' && c !== '\t' && c !== '#') lineStart = false;
    // # starts a comment at the start of a line or before a space (Postgres uses it as an operator)
    if ((c === '-' && src[i + 1] === '-') || (c === '#' && (lineStart || /\s/.test(src[i + 1] ?? ' ')))) {
      while (i < n && src[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      i = end < 0 ? n : end + 2;
      raw += ' ';
      code += ' ';
      continue;
    }
    if (c === "'" || c === '"') {
      let j = i + 1;
      while (j < n && src[j] !== c && src[j] !== '\n') j += src[j] === '\\' ? 2 : 1;
      raw += src.slice(i, j + 1);
      code += c + c;
      i = j + 1;
      continue;
    }
    raw += c;
    code += c;
    i++;
  }
  return { raw, code };
}

/**
 * The dialect a query is clearly written in: { id, reasons } or null when the
 * clues are too few or point more than one way.
 */
export function detectDialect(src) {
  const { raw, code } = scrub(String(src ?? ''));
  const score = Object.fromEntries(DIALECT_IDS.map((id) => [id, 0]));
  const reasons = Object.fromEntries(DIALECT_IDS.map((id) => [id, []]));
  for (const [id, weight, label, re, on] of CLUES) {
    if (!re.test(on === 'raw' ? raw : code)) continue;
    score[id] += weight;
    reasons[id].push(label);
  }
  const [best, second] = Object.entries(score).sort((a, b) => b[1] - a[1]);
  if (best[1] < 3 || best[1] - second[1] < 2) return null;
  return { id: best[0], reasons: reasons[best[0]] };
}
