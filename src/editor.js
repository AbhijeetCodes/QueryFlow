import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection,
  Decoration, ViewPlugin, dropCursor, rectangularSelection, crosshairCursor } from '@codemirror/view';
import { EditorState, StateEffect, StateField, Compartment } from '@codemirror/state';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { searchKeymap, highlightSelectionMatches } from '@codemirror/search';
import { autocompletion, completionKeymap, closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
import { HighlightStyle, syntaxHighlighting, bracketMatching, indentOnInput, foldGutter, foldKeymap,
  foldService, codeFolding } from '@codemirror/language';
import { linter, lintGutter, lintKeymap } from '@codemirror/lint';
import { sql, SQLDialect, PostgreSQL, MySQL, MSSQL, keywordCompletionSource } from '@codemirror/lang-sql';
import { tags as t } from '@lezer/highlight';
import { analyzeDoc } from './analyzer.js';
import { currentDialect, setCurrentDialect, quoteTable } from './dialect.js';
import { scopeAt, columnsOf } from './scope.js';
import { symbolFeatures } from './symbol-ui.js';

const escHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const KEYWORDS = `select from where group by having qualify window order limit offset with as recursive join inner
left right full outer cross natural on using union intersect except all distinct and or not in is null
true false like between case when then else end exists cast safe_cast extract interval partition over
rows range unbounded preceding following current row asc desc nulls first last create or replace temp
temporary table view materialized function procedure if declare set default insert into values update
delete merge matched begin transaction commit rollback call execute immediate return returns language
options cluster struct array unnest tablesample system system_time of for loop while do repeat until
break continue leave iterate raise exception assert pivot unpivot respect ignore lateral within at
escape collate contains exclude define lookup new proto treat some any cube rollup grouping sets
grouping groups hash enum fetch no`;

const TYPES = `int64 int integer smallint bigint tinyint byteint float64 numeric bignumeric decimal bigdecimal
bool boolean string bytes date datetime time timestamp interval json geography range`;

const BUILTINS = `count sum avg min max countif count_if any_value array_agg string_agg logical_and logical_or
approx_count_distinct approx_quantiles approx_top_count coalesce ifnull nullif if iff concat lower upper trim
ltrim rtrim substr substring replace regexp_contains regexp_extract regexp_extract_all regexp_replace split
length starts_with ends_with strpos format lpad rpad reverse initcap safe_divide round floor ceil abs mod
div pow power sqrt exp ln log log10 greatest least row_number rank dense_rank percent_rank ntile lag lead
first_value last_value nth_value current_date current_datetime current_timestamp current_time date_add
date_sub date_diff date_trunc datetime_add datetime_sub datetime_diff datetime_trunc timestamp_add
timestamp_sub timestamp_diff timestamp_trunc format_date format_timestamp format_datetime parse_date
parse_timestamp parse_datetime unix_seconds unix_millis timestamp_seconds timestamp_millis last_day
generate_date_array generate_array generate_uuid farm_fingerprint md5 sha256 to_json_string
json_extract json_extract_scalar json_value json_query json_extract_array to_hex array_length array_concat
array_to_string offset ordinal safe_offset safe_ordinal struct st_distance st_geogpoint hll_count
percentile_cont percentile_disc stddev variance corr covar_pop`;

export const bigQueryDialect = SQLDialect.define({
  keywords: KEYWORDS,
  types: TYPES,
  builtin: BUILTINS,
  hashComments: true,
  doubleQuotedStrings: true,
  backslashEscapes: true,
  identifierQuotes: '`',
  specialVar: '@',
  caseInsensitiveIdentifiers: true,
});

const LANG = { bigquery: bigQueryDialect, postgres: PostgreSQL, mysql: MySQL, sqlserver: MSSQL };

// Highlighting and keyword completion follow the dialect picker.
const langSlot = new Compartment();
let keywords = null;
const langFor = (id) => {
  const dialect = LANG[id] || bigQueryDialect;
  keywords = keywordCompletionSource(dialect, true);
  return sql({ dialect, upperCaseKeywords: true });
};
// Keywords and functions, except right after `name.` where only columns make sense.
const keywordsNotAfterDot = (ctx) => (ctx.matchBefore(/\.\w*$/) ? null : keywords(ctx));

// Dispatched with a dialect change: everything drawn from the analysis redraws.
export const dialectChanged = StateEffect.define();
const changedDialect = (u) => u.transactions.some((tr) => tr.effects.some((e) => e.is(dialectChanged)));

/** Switch the editor (and analyzeDoc) to another dialect. */
export function setEditorDialect(view, id) {
  setCurrentDialect(id);
  view.dispatch({ effects: [langSlot.reconfigure(langFor(currentDialect())), dialectChanged.of(currentDialect())] });
}

const highlight = HighlightStyle.define([
  { tag: t.keyword, color: 'var(--syn-keyword)' },
  { tag: [t.typeName], color: 'var(--syn-type)' },
  { tag: [t.standard(t.name)], color: 'var(--syn-fn)' },
  { tag: [t.string, t.special(t.string)], color: 'var(--syn-string)' },
  { tag: [t.number, t.bool, t.null], color: 'var(--syn-number)' },
  { tag: [t.lineComment, t.blockComment, t.comment], color: 'var(--syn-comment)', fontStyle: 'italic' },
  { tag: [t.special(t.name)], color: 'var(--syn-var)' },
  { tag: [t.operator], color: 'var(--syn-op)' },
  { tag: [t.punctuation, t.paren, t.bracket], color: 'var(--syn-punct)' },
]);

// Quoted identifiers may be coloured as strings by lang-sql; our table/CTE marks
// override that colour where the analyzer knows better.
const theme = EditorView.theme({
  '&': { height: '100%', fontSize: '13px', backgroundColor: 'var(--editor-bg)', color: 'var(--text)' },
  '.cm-scroller': { fontFamily: 'var(--mono)', lineHeight: '1.55' },
  '.cm-content': { caretColor: 'var(--accent)', padding: '8px 0' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--accent)', borderLeftWidth: '2px' },
  '.cm-gutters': { backgroundColor: 'var(--editor-bg)', color: 'var(--text-faint)', border: 'none', borderRight: '1px solid var(--border)' },
  '.cm-activeLineGutter': { backgroundColor: 'var(--active-line)', color: 'var(--text-muted)' },
  '.cm-activeLine': { backgroundColor: 'var(--active-line)' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': { backgroundColor: 'var(--selection) !important' },
  '.cm-selectionMatch': { backgroundColor: 'var(--selection-match)' },
  '&.cm-focused .cm-matchingBracket': { backgroundColor: 'var(--selection-match)', outline: '1px solid var(--border-strong)' },
  '.cm-foldPlaceholder': { backgroundColor: 'var(--chip)', border: '1px solid var(--border)', color: 'var(--text-muted)', padding: '0 6px', borderRadius: '4px' },
  '.cm-tooltip': { backgroundColor: 'var(--panel)', border: '1px solid var(--border)', color: 'var(--text)', borderRadius: '6px' },
  '.cm-tooltip-autocomplete > ul > li[aria-selected]': { backgroundColor: 'var(--accent-soft)', color: 'var(--text)' },
  '.cm-panels': { backgroundColor: 'var(--panel)', color: 'var(--text)' },
  '.cm-panels.cm-panels-top': { borderBottom: '1px solid var(--border)' },
  '.cm-textfield': { backgroundColor: 'var(--bg)', border: '1px solid var(--border)', color: 'var(--text)' },
  '.cm-button': { backgroundImage: 'none', backgroundColor: 'var(--chip)', border: '1px solid var(--border)', color: 'var(--text)' },
  '.cm-lens-sticky': {
    position: 'absolute', top: '0', right: '14px', zIndex: '5', display: 'flex', alignItems: 'baseline', gap: '8px',
    padding: '3px 12px 4px 10px', border: 'none', borderBottom: '1px solid var(--border)', borderRadius: '0 0 6px 0',
    background: 'var(--editor-bg)', boxShadow: '0 4px 10px -8px rgba(0, 0, 0, 0.35)', textAlign: 'left',
    fontFamily: 'var(--mono)', fontSize: '12px', cursor: 'pointer',
  },
  '.cm-lens-sticky b': { color: 'var(--c-cte)', fontWeight: '600' },
  '.cm-lens-sticky span': { color: 'var(--text-faint)', fontFamily: 'var(--sans)', fontSize: '11px' },
  '.cm-lens-sticky:hover b': { textDecoration: 'underline' },
  '.cm-diagnostic': { borderLeftWidth: '3px' },
  '.cm-lintRange-info': { backgroundImage: 'none', borderBottom: '1px dotted var(--info)' },
});

// ---- analyzer-driven decorations --------------------------------------
const markCache = new Map();
function markDeco(cls) {
  if (!markCache.has(cls)) markCache.set(cls, Decoration.mark({ class: cls }));
  return markCache.get(cls);
}

const lensMarks = ViewPlugin.fromClass(class {
  constructor(view) { this.decorations = this.build(view); }
  update(u) { if (u.docChanged || changedDialect(u)) this.decorations = this.build(u.view); }
  build(view) {
    const a = analyzeDoc(view.state.doc);
    const ranges = [];
    let lastTo = -1;
    for (const m of a.marks) {
      if (m.from >= m.to || m.from < lastTo) continue;
      ranges.push(markDeco(m.cls).range(m.from, m.to));
      lastTo = m.to;
    }
    return Decoration.set(ranges, true);
  }
}, { decorations: (v) => v.decorations });

// Transient highlight of ranges picked from the side panels / graph.
export const setFocusRanges = StateEffect.define();
const focusMark = Decoration.mark({ class: 'cm-lens-focus' });
const focusField = StateField.define({
  create: () => Decoration.none,
  update(deco, tr) {
    deco = deco.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(setFocusRanges)) {
        deco = Decoration.set(e.value.filter((r) => r.to > r.from).map((r) => focusMark.range(r.from, r.to)), true);
      }
    }
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

// Sticky header: the CTE whose body is at the top of the view, once its
// `name AS (` line has scrolled out of sight. Click it to jump back up.
const stickyCte = ViewPlugin.fromClass(class {
  constructor(view) {
    this.view = view;
    this.cur = null;
    this.dom = document.createElement('button');
    this.dom.className = 'cm-lens-sticky';
    this.dom.hidden = true;
    this.dom.addEventListener('mousedown', (e) => {
      e.preventDefault();
      if (!this.cur) return;
      view.dispatch({ selection: { anchor: this.cur.def.from, head: this.cur.def.to }, effects: EditorView.scrollIntoView(this.cur.def.from, { y: 'start', yMargin: 24 }) });
      view.focus();
    });
    view.dom.appendChild(this.dom);
    this.onScroll = () => this.measure();
    view.scrollDOM.addEventListener('scroll', this.onScroll, { passive: true });
    this.measure();
  }
  update(u) { if (u.docChanged || u.geometryChanged || changedDialect(u)) this.measure(); }
  measure() {
    this.view.requestMeasure({
      key: this,
      read: (v) => ({
        top: v.lineBlockAtHeight(v.scrollDOM.getBoundingClientRect().top - v.documentTop + 2).from,
        left: v.dom.querySelector('.cm-gutters')?.offsetWidth || 0,
      }),
      write: ({ top, left }, v) => {
        const topLine = v.state.doc.lineAt(top).from;
        let hit = null;
        for (const n of analyzeDoc(v.state.doc).graph.nodes) {
          if (n.kind !== 'cte' || !n.def || !n.body || n.body.from > top || n.body.to <= top || n.def.from >= topLine) continue;
          if (!hit || n.body.from > hit.body.from) hit = n;
        }
        this.dom.style.left = left + 'px';
        if (hit === this.cur) return;
        this.cur = hit;
        this.dom.hidden = !hit;
        if (hit) {
          this.dom.innerHTML = `<b>${escHtml(hit.label)}</b><span>line ${v.state.doc.lineAt(hit.def.from).number}</span>`;
          this.dom.title = `In CTE ${hit.label}: click to jump to where it starts`;
        }
      },
    });
  }
  destroy() {
    this.view.scrollDOM.removeEventListener('scroll', this.onScroll);
    this.dom.remove();
  }
});

// Fold any parenthesised block that spans lines (CTE bodies, subqueries).
const parenFold = foldService.of((state, lineStart, lineEnd) => {
  const a = analyzeDoc(state.doc);
  const T = a.tokens;
  let lo = 0;
  let hi = T.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (T[mid].a < lineStart) lo = mid + 1; else hi = mid;
  }
  for (let i = lo; i < T.length && T[i].a < lineEnd; i++) {
    if (T[i].s === '(' && T[i].t === 'punct' && a.match[i] > i) {
      const close = T[a.match[i]];
      if (close.a > lineEnd) return { from: T[i].b, to: close.a };
    }
  }
  return null;
});

const lensLint = linter((view) => [
  ...analyzeDoc(view.state.doc).diags.map((d) => ({
    from: d.from,
    to: Math.max(d.to, d.from),
    severity: d.severity,
    message: d.message,
    source: 'QueryFlow',
  })),
], { delay: 300, needsRefresh: changedDialect });

// Completions for names found in this query (CTEs, tables, aliases, variables).
function lensCompletions(ctx) {
  const a = analyzeDoc(ctx.state.doc);
  // After `alias.`: the columns of the table or CTE that alias names here.
  const dotted = ctx.matchBefore(/[A-Za-z_]\w*\.\w*$/);
  if (dotted && !/[.\w`]/.test(ctx.state.sliceDoc(dotted.from - 1, dotted.from))) {
    const [alias] = dotted.text.split('.');
    const item = scopeAt(a, dotted.from).get(alias.toLowerCase());
    const cols = item && columnsOf(a, item);
    if (cols) {
      return {
        from: dotted.from + alias.length + 1,
        options: cols.map((c) => ({ label: c.name, type: 'property', detail: c.type, info: c.description || undefined, boost: 10 })),
        validFor: /^\w*$/,
      };
    }
  }
  const word = ctx.matchBefore(/[\w@$`".-]*/);
  if (!word || (word.from === word.to && !ctx.explicit)) return null;
  const opts = [];
  const seen = new Set();
  const add = (label, type, detail) => {
    if (seen.has(label)) return;
    seen.add(label);
    opts.push({ label, type, detail, boost: 5 });
  };
  for (const n of a.graph.nodes) {
    if (n.kind === 'cte') add(n.label, 'class', 'CTE');
    else if (n.kind === 'table' && n.full) add(quoteTable(n.full, a.dialect), 'type', 'table');
  }
  for (const v of a.variables) for (const n of v.names) add(n, 'variable', v.type || 'variable');
  for (const p of a.params) add(p.text, 'variable', 'parameter');
  // Bare column names from the tables in scope, below the query's own names.
  for (const item of scopeAt(a, word.from).values()) {
    for (const c of columnsOf(a, item) || []) {
      if (seen.has(c.name)) continue;
      seen.add(c.name);
      opts.push({ label: c.name, type: 'property', detail: `${c.type ? c.type + ' · ' : ''}${item.alias || ''}`.replace(/ · $/, ''), info: c.description || undefined, boost: 0 });
    }
  }
  return { from: word.from, options: opts, validFor: /^[\w@$`".-]*$/ };
}

export function createEditor(parent, { doc, onDocChange, onPaste, onSelection, extraKeys = [], extensions = [], toast, onPreview }) {
  const state = EditorState.create({
    doc,
    extensions: [
      lineNumbers(),
      highlightActiveLineGutter(),
      foldGutter({ markerDOM: (open) => {
        const el = document.createElement('span');
        el.className = open ? 'cm-fold-marker open' : 'cm-fold-marker';
        el.textContent = open ? '▾' : '▸';
        return el;
      } }),
      codeFolding(),
      parenFold,
      history(),
      drawSelection(),
      dropCursor(),
      EditorState.allowMultipleSelections.of(true),
      indentOnInput(),
      bracketMatching(),
      closeBrackets(),
      autocompletion({ activateOnTyping: true, override: [lensCompletions, keywordsNotAfterDot] }),
      rectangularSelection(),
      crosshairCursor(),
      highlightActiveLine(),
      highlightSelectionMatches(),
      langSlot.of(langFor(currentDialect())),
      syntaxHighlighting(highlight),
      lensMarks,
      stickyCte,
      focusField,
      lensLint,
      lintGutter(),
      theme,
      EditorState.tabSize.of(2),
      symbolFeatures({ setFocusRanges, toast, onPreview }),
      extensions,
      keymap.of([
        ...extraKeys,
        ...closeBracketsKeymap,
        ...defaultKeymap,
        ...searchKeymap,
        ...historyKeymap,
        ...foldKeymap,
        ...completionKeymap,
        ...lintKeymap,
        indentWithTab,
      ]),
      EditorView.updateListener.of((u) => {
        if (u.selectionSet || u.docChanged) onSelection?.(u);
        if (!u.docChanged) return;
        onDocChange?.(u);
        for (const tr of u.transactions) {
          if (tr.isUserEvent('input.paste') || tr.isUserEvent('input.drop')) {
            onPaste?.(tr, u);
            break;
          }
        }
      }),
    ],
  });
  return new EditorView({ state, parent });
}

export function focusRanges(view, ranges, { scroll = true } = {}) {
  const effects = [setFocusRanges.of(ranges)];
  if (scroll && ranges.length) {
    effects.push(EditorView.scrollIntoView(ranges[0].from, { y: 'center' }));
  }
  view.dispatch({ effects });
}
