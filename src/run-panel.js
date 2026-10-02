// The Run tab: small test tables (CSV / TSV text per source table), test values
// for @parameters, and the rows the query returns when it runs on them with
// DuckDB-WASM in this browser. Loaded on first use, like the formatter.

import { EditorView } from '@codemirror/view';
import { previewSql } from './symbols.js';
import { tableKey } from './bq2duck.js';
import { planRun, executePlan, planText } from './runner.js';
import { LIMITS, inspectTable, queryColumns, starterRows, withColumns, csvLine } from './testdata.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const plural = (n, w) => `${n.toLocaleString()} ${w}${n === 1 ? '' : 's'}`;
const STORE_KEY = 'queryflow.testdata';

function loadStore() {
  try {
    const v = JSON.parse(localStorage.getItem(STORE_KEY) || '{}');
    return { tables: v.tables || {}, params: v.params || {} };
  } catch { return { tables: {}, params: {} }; }
}

// ---- formatting result values (Arrow values from DuckDB) ---------------------------

const pad = (n, w = 2) => String(n).padStart(w, '0');
function isoTs(ms) {
  if (!Number.isFinite(ms)) return String(ms);
  const d = new Date(Math.floor(ms));
  const s = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
  const frac = Math.round((ms - Math.floor(ms / 1000) * 1000) * 1000); // microseconds within the second
  return frac ? `${s}.${String(frac).padStart(6, '0').replace(/0+$/, '')}` : s;
}

/** A value as BigQuery's results grid would show it. */
export function formatValue(v, type) {
  if (v === null || v === undefined) return null;
  const ts = String(type ?? '');
  if (ts.startsWith('Date')) return new Date(Number(v)).toISOString().slice(0, 10);
  if (ts.startsWith('Timestamp')) return isoTs(Number(v));
  if (ts.startsWith('Time')) {
    const us = Number(v) / (ts.includes('NANO') ? 1000 : ts.includes('MILLI') ? 0.001 : 1);
    const s = Math.floor(us / 1e6);
    return `${pad(Math.floor(s / 3600))}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}`;
  }
  if (ts.startsWith('List') || ts.startsWith('FixedSizeList')) {
    const child = type.children?.[0]?.type;
    const items = [...v].map((x) => fmtNested(x, child));
    return `[${items.join(', ')}]`;
  }
  if (ts.startsWith('Struct')) {
    const fields = type.children || [];
    return `{${fields.map((f) => `${f.name}: ${fmtNested(v[f.name], f.type)}`).join(', ')}}`;
  }
  if (typeof v === 'bigint') return v.toString();
  if (v instanceof Uint8Array) return 'b\'' + [...v].map((b) => (b >= 32 && b < 127 && b !== 39 && b !== 92 ? String.fromCharCode(b) : '\\x' + pad(b.toString(16)))).join('') + '\'';
  if (typeof v === 'object') { try { return JSON.stringify(v, (k, x) => (typeof x === 'bigint' ? x.toString() : x)); } catch { return String(v); } }
  return String(v);
}
function fmtNested(v, type) {
  const s = formatValue(v, type);
  if (s === null) return 'NULL';
  return String(type ?? '').startsWith('Utf8') ? JSON.stringify(s) : s;
}
const isNumType = (t) => /^(Int|Uint|Float|Decimal)/.test(String(t ?? ''));
const shortType = (t) => {
  const s = String(t ?? '');
  if (/^Int|^Uint/.test(s)) return 'INT64';
  if (/^Float|^Decimal/.test(s)) return 'FLOAT64';
  if (s.startsWith('Utf8')) return 'STRING';
  if (s.startsWith('Bool')) return 'BOOL';
  if (s.startsWith('Date')) return 'DATE';
  if (s.startsWith('Timestamp')) return 'TIMESTAMP';
  if (s.startsWith('Time')) return 'TIME';
  if (s.startsWith('List')) return 'ARRAY';
  if (s.startsWith('Struct')) return 'STRUCT';
  if (s.startsWith('Binary')) return 'BYTES';
  return s.split('<')[0].toUpperCase();
};

// ---- the panel ----------------------------------------------------------------------

export function createRunPanel(root, { view, toast, getAnalysis, isBigQuery }) {
  root.innerHTML = `
    <div class="run-head">
      <select class="run-target" aria-label="What to run" title="Run the whole query, or stop at one CTE"></select>
      <button class="btn primary sm run-go" title="Run on the test tables (⌘Enter)">Run</button>
      <span class="run-status" aria-live="polite"></span>
      <span class="run-spacer"></span>
      <div class="run-seg" role="tablist">
        <button class="run-pane-btn" data-pane="data" role="tab">Test data</button>
        <button class="run-pane-btn" data-pane="results" role="tab">Results</button>
      </div>
    </div>
    <div class="run-off" hidden>Test runs translate BigQuery SQL for DuckDB. Switch the dialect to BigQuery to use them.</div>
    <div class="run-data">
      <p class="run-intro">Type or paste a few rows per table as CSV or TSV (a copy from a spreadsheet works). The query runs on them here in your browser with DuckDB: nothing is uploaded. Up to ${LIMITS.rows.toLocaleString()} rows and ${LIMITS.cols} columns per table. Add <code>:TYPE</code> to a header to set a type, e.g. <code>id:INT64</code>.</p>
      <div class="tt-list"></div>
      <div class="tt-params"></div>
      <div class="tt-foot"><button class="mini" data-act="clear-all">Clear all test data</button></div>
    </div>
    <div class="run-results" hidden><div class="res-empty">Run the query to see its rows here (⌘Enter).</div></div>`;

  const $ = (s) => root.querySelector(s);
  const targetSel = $('.run-target');
  const goBtn = $('.run-go');
  const statusEl = $('.run-status');
  const dataEl = $('.run-data');
  const resEl = $('.run-results');
  const listEl = $('.tt-list');
  const paramsEl = $('.tt-params');
  const offEl = $('.run-off');

  let store = loadStore();
  let analysis = null;
  let running = null; // { stop() }
  let lastPlan = null;
  const cards = new Map(); // tableKey -> element
  let saveTimer;

  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      const text = JSON.stringify(store);
      if (text.length > LIMITS.total) { toast(`Test data is over ${Math.round(LIMITS.total / 1e6 * 10) / 10} MB, so it won't be kept after a reload: trim some tables`, 'error'); return; }
      try { localStorage.setItem(STORE_KEY, text); } catch { toast('This browser blocked saving test data', 'error'); }
    }, 300);
  }

  function showPane(name) {
    dataEl.hidden = name !== 'data';
    resEl.hidden = name !== 'results';
    root.querySelectorAll('.run-pane-btn').forEach((b) => b.classList.toggle('active', b.dataset.pane === name));
  }
  root.querySelector('.run-seg').addEventListener('click', (e) => {
    const b = e.target.closest('[data-pane]');
    if (b) showPane(b.dataset.pane);
  });
  showPane('data');

  // ---- test tables --------------------------------------------------------------------

  function sourceTables(a) {
    const seen = new Map();
    for (const n of a.graph.nodes) {
      if (n.kind !== 'table') continue;
      const full = (n.full || n.label).replace(/`/g, '');
      const key = tableKey(full);
      if (!seen.has(key)) seen.set(key, { key, full, label: n.label });
    }
    return [...seen.values()].sort((x, y) => x.full.localeCompare(y.full));
  }

  function statText(text) {
    const info = inspectTable(text);
    if (info.empty) return { text: 'no data yet', cls: 'warn' };
    if (info.error) return { text: info.error, cls: 'error' };
    return { text: `${plural(info.rows, 'row')} · ${plural(info.cols, 'column')}`, cls: info.rows ? '' : 'warn' };
  }

  function card(t) {
    const el = document.createElement('section');
    el.className = 'tt';
    el.dataset.key = t.key;
    el.innerHTML = `
      <header><b class="tt-name"></b><span class="tt-full"></span><span class="tt-stat"></span></header>
      <div class="tt-cols"></div>
      <textarea class="tt-text" spellcheck="false" autocomplete="off" rows="4"></textarea>
      <div class="tt-tools">
        <button class="mini" data-act="header" title="Add the columns this query reads from the table to the header row">Columns from query</button>
        <button class="mini" data-act="starter" title="Add 3 rows of made-up values that match the query's joins and filters">Starter rows</button>
        <button class="mini" data-act="clear" title="Empty this table">Clear</button>
      </div>`;
    const ta = el.querySelector('textarea');
    ta.value = store.tables[t.key] ?? '';
    ta.addEventListener('input', () => {
      store.tables[t.key] = ta.value;
      if (!ta.value) delete store.tables[t.key];
      save();
      paintStat(el);
    });
    ta.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); run(); }
    });
    return el;
  }

  function setText(el, text) {
    const ta = el.querySelector('textarea');
    // execCommand keeps the textarea's own undo; fall back to a plain set.
    ta.focus();
    ta.select();
    if (!document.execCommand?.('insertText', false, text)) { ta.value = text; ta.dispatchEvent(new Event('input')); }
  }

  function paintStat(el) {
    const st = statText(el.querySelector('textarea').value);
    const s = el.querySelector('.tt-stat');
    s.textContent = st.text;
    s.className = 'tt-stat ' + st.cls;
  }

  listEl.addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]');
    const el = e.target.closest('.tt');
    if (!b || !el) return;
    const key = el.dataset.key;
    const cols = (analysis && queryColumns(analysis).get(key)) || [];
    const ta = el.querySelector('textarea');
    if (b.dataset.act === 'header') {
      if (!cols.length) { toast('The query doesn\'t name any columns of this table (it may only use *): type a header row'); return; }
      setText(el, withColumns(ta.value, cols));
    }
    if (b.dataset.act === 'starter') {
      let text = ta.value;
      let header = inspectTable(text).names;
      if (!header.length) {
        if (!cols.length) { toast('Type a header row first: the query doesn\'t name this table\'s columns'); return; }
        header = cols;
        text = csvLine(cols) + '\n';
      }
      const info = inspectTable(text);
      const rows = starterRows(header, analysis, 3, key);
      const sep = info.delim === '\t' ? (l) => l.split(',').join('\t') : (l) => l;
      setText(el, text.replace(/\n*$/, '\n') + rows.map(sep).join('\n') + '\n');
    }
    if (b.dataset.act === 'clear') setText(el, '');
  });

  function renderTables(a) {
    const tables = sourceTables(a);
    const cols = queryColumns(a);
    const keep = new Set(tables.map((t) => t.key));
    for (const [k, el] of cards) if (!keep.has(k)) { el.remove(); cards.delete(k); }
    tables.forEach((t, i) => {
      let el = cards.get(t.key);
      if (!el) { el = card(t); cards.set(t.key, el); }
      if (listEl.children[i] !== el) listEl.insertBefore(el, listEl.children[i] || null);
      el.querySelector('.tt-name').textContent = t.label;
      el.querySelector('.tt-full').textContent = t.full === t.label ? '' : t.full;
      const c = cols.get(t.key) || [];
      el.querySelector('.tt-cols').innerHTML = c.length
        ? `Query reads ${c.map((x) => `<code>${esc(x)}</code>`).join(' ')}`
        : '<span class="muted">The query names no columns of this table</span>';
      const ta = el.querySelector('textarea');
      if (!ta.placeholder) ta.placeholder = c.length ? `${csvLine(c)}\n${starterRows(c, a, 1, t.key)[0]}` : 'id,name\n1,first';
      paintStat(el);
    });
    if (!tables.length) listEl.innerHTML = '<div class="tt-none">This query reads no tables. Runs work on its literals alone (e.g. SELECT … FROM UNNEST([…])).</div>';
    else listEl.querySelector('.tt-none')?.remove();
    if (tables.length > LIMITS.tables) toast(`This query reads ${tables.length} tables: test runs take up to ${LIMITS.tables}`, 'error');
  }

  function renderParams(a) {
    const params = (a.params || []).filter((p) => (p.sigil ?? '@') === '@');
    if (!params.length) { paramsEl.innerHTML = ''; return; }
    const focused = document.activeElement?.closest?.('.tt-params') ? document.activeElement.dataset.param : null;
    const sig = params.map((p) => p.name.toLowerCase()).join(',');
    if (paramsEl.dataset.sig === sig) return;
    paramsEl.dataset.sig = sig;
    paramsEl.innerHTML = `<h4>Query parameters</h4>
      <p class="muted">A SQL value for each, e.g. <code>'SG'</code>, <code>42</code>, <code>DATE '2024-01-01'</code>. Empty means NULL.</p>
      ${params.map((p) => `<label class="tt-param"><span>@${esc(p.name)}</span><input data-param="${esc(p.name.toLowerCase())}" spellcheck="false" value="${esc(store.params[p.name.toLowerCase()] ?? '')}"></label>`).join('')}`;
    if (focused) paramsEl.querySelector(`[data-param="${CSS.escape(focused)}"]`)?.focus();
  }
  paramsEl.addEventListener('input', (e) => {
    const k = e.target.dataset.param;
    if (!k) return;
    if (e.target.value.trim()) store.params[k] = e.target.value; else delete store.params[k];
    save();
  });
  paramsEl.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); run(); }
  });

  $('[data-act="clear-all"]').addEventListener('click', () => {
    if (!Object.keys(store.tables).length && !Object.keys(store.params).length) { toast('No test data saved'); return; }
    if (!confirm('Delete all saved test tables and parameter values (for every query)?')) return;
    store = { tables: {}, params: {} };
    save();
    for (const el of cards.values()) { el.querySelector('textarea').value = ''; paintStat(el); }
    paramsEl.dataset.sig = '';
    if (analysis) renderParams(analysis);
    toast('Test data cleared');
  });

  // ---- what to run -----------------------------------------------------------------------

  function renderTargets(a) {
    const ctes = a.graph.nodes.filter((n) => n.kind === 'cte' && n.body);
    const cur = targetSel.value;
    const html = `<option value="">Whole query</option>${ctes.map((n) => `<option value="${esc(n.id)}">CTE ${esc(n.label)}</option>`).join('')}`;
    if (targetSel.dataset.html !== html) {
      targetSel.innerHTML = html;
      targetSel.dataset.html = html;
      targetSel.value = ctes.some((n) => n.id === cur) ? cur : '';
    }
  }

  // The SQL to run for a target: the whole script, or every statement before the
  // CTE's statement plus WITH … SELECT * FROM cte.
  function sourceFor(a, target) {
    if (!target) return { src: a.src, label: 'whole query' };
    const n = a.graph.nodes.find((x) => x.id === target);
    const p = n && previewSql(a, target, { limit: LIMITS.resultRows + 1 });
    if (!p) return { src: a.src, label: 'whole query' };
    const k = p.sql.search(/^WITH( RECURSIVE)? /m);
    const stmt = a.statements.find((s) => s.from <= n.def.from && n.def.from <= s.to);
    const before = a.statements.filter((s) => stmt && s.to <= stmt.from).map((s) => a.src.slice(s.from, s.to).trim().replace(/;?$/, ';'));
    return { src: [...before, p.sql.slice(Math.max(0, k))].join('\n'), label: `CTE ${n.label}`, preview: true };
  }

  // ---- running ---------------------------------------------------------------------------

  function setStatus(text, cls = '') {
    statusEl.textContent = text;
    statusEl.className = 'run-status ' + cls;
  }

  async function run(target = targetSel.value) {
    if (!isBigQuery()) { toast('Test runs need the BigQuery dialect'); return; }
    if (running) { running.stop(); return; }
    const a = getAnalysis();
    if (!a.src.trim()) { toast('Nothing to run yet'); return; }
    if (target && targetSel.value !== target) { renderTargets(a); targetSel.value = target; }
    const { src, label, preview } = sourceFor(a, target);
    const { plan, translation, problems } = planRun(src, { data: store.tables, params: store.params });
    lastPlan = plan;
    if (problems.length) {
      renderProblems(problems, translation);
      showPane('results');
      setStatus('Not run', 'error');
      return;
    }
    const engine = await import('./engine.js');
    let stopped = false;
    running = { stop: () => { stopped = true; engine.stop(); } };
    goBtn.textContent = 'Stop';
    goBtn.classList.remove('primary');
    setStatus(engine.isLoaded() ? 'Running…' : 'Loading DuckDB (first run only, ≈8 MB)…', 'busy');
    let res;
    try {
      const driver = await engine.createDriver();
      if (!stopped) setStatus('Running…', 'busy');
      res = await executePlan(plan, driver, { maxRows: LIMITS.resultRows });
    } catch (err) {
      res = stopped ? { stopped: true } : { error: { text: String(err?.message || err).split('\n')[0], where: 'starting DuckDB' } };
    } finally {
      running = null;
      goBtn.textContent = 'Run';
      goBtn.classList.add('primary');
    }
    if (stopped) res = { stopped: true };
    renderResult(res, { label, translation, preview, a: preview ? null : a });
    showPane('results');
  }
  goBtn.addEventListener('click', () => run());

  // ---- results ------------------------------------------------------------------------------

  function notesHtml(warnings) {
    if (!warnings?.length) return '';
    return `<ul class="res-notes">${warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul>`;
  }

  function sqlBox() {
    return lastPlan ? `<details class="res-sql"><summary>SQL sent to DuckDB</summary><div class="res-sql-tools"><button class="mini" data-act="copy-sql">Copy</button></div><pre>${esc(planText(lastPlan))}</pre></details>` : '';
  }

  function renderProblems(problems, translation) {
    resEl.innerHTML = `<div class="res-error"><b>Can't run yet</b><ul>${problems.map((p) => `<li>${esc(p.message)}${
      p.table ? ` <button class="mini" data-act="add-data" data-key="${esc(p.table)}">Add test data</button>` : ''}${
      p.line ? ` <button class="mini" data-act="goto" data-line="${p.line}">Line ${p.line}</button>` : ''}</li>`).join('')}</ul></div>
      ${notesHtml(translation?.warnings)}`;
  }

  function renderResult(res, { label, translation, preview, a }) {
    if (res.stopped) {
      setStatus('Stopped', 'warn');
      resEl.innerHTML = '<div class="res-empty">Stopped. DuckDB reloads on the next run.</div>';
      return;
    }
    if (res.error) {
      const e = res.error;
      setStatus('Failed', 'error');
      // Line numbers only map onto the editor when the whole script ran as written.
      const line = !preview && e.line ? e.line : null;
      const lineText = line && a ? a.src.split('\n')[line - 1]?.trim() : '';
      resEl.innerHTML = `<div class="res-error"><b>${esc(e.text)}</b>
        ${e.where ? `<div class="muted">while ${esc(e.where)}</div>` : ''}
        ${line ? `<div class="res-at">Line ${line}${lineText ? `: <code>${esc(lineText.slice(0, 120))}</code>` : ''} <button class="mini" data-act="goto" data-line="${line}">Go to line</button></div>` : ''}
        ${e.table ? `<button class="mini" data-act="add-data" data-key="${esc(e.table)}">Check the test data</button>` : ''}
        ${e.detail ? `<pre class="res-detail">${esc(e.detail)}</pre>` : ''}
        ${e.table || !lastPlan ? '' : '<p class="muted">Some BigQuery features have no DuckDB match yet; the SQL below is what DuckDB received.</p>'}</div>
        ${notesHtml(translation.warnings)}${sqlBox()}`;
      return;
    }
    const { fields, rows, truncated, ms } = res;
    setStatus(`${truncated ? `First ${plural(rows.length, 'row')}` : plural(rows.length, 'row')} · ${ms} ms`, 'ok');
    const head = `<tr><th class="rn">#</th>${fields.map((f) => `<th${isNumType(f.type) ? ' class="num"' : ''}>${esc(f.name)}<small>${esc(shortType(f.type))}</small></th>`).join('')}</tr>`;
    const body = rows.map((r, i) => `<tr><td class="rn">${i + 1}</td>${r.map((v, j) => {
      const s = formatValue(v, fields[j].type);
      if (s === null) return '<td class="null">NULL</td>';
      const long = s.length > 80;
      return `<td${isNumType(fields[j].type) ? ' class="num"' : ''}${long ? ` title="${esc(s.slice(0, 2000))}"` : ''}>${esc(long ? s.slice(0, 80) + '…' : s)}</td>`;
    }).join('')}</tr>`).join('');
    resEl.innerHTML = `
      <div class="res-meta"><b>${esc(label)}</b> · ${truncated ? `showing the first ${plural(rows.length, 'row')}` : plural(rows.length, 'row')} · ${ms} ms <span class="muted">· DuckDB on test data, results can differ from BigQuery in edge cases</span></div>
      ${notesHtml(translation.warnings)}
      ${fields.length ? `<div class="res-grid-wrap"><table class="res-grid"><thead>${head}</thead><tbody>${body}</tbody></table></div>` : '<div class="res-empty">The statement ran and returned no columns.</div>'}
      ${rows.length || !fields.length ? '' : '<div class="res-empty">No rows. Check the filters against the test data.</div>'}
      ${sqlBox()}`;
  }

  resEl.addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    if (b.dataset.act === 'goto') {
      const line = Math.min(+b.dataset.line, view.state.doc.lines);
      const l = view.state.doc.line(line);
      view.dispatch({ selection: { anchor: l.from, head: l.to }, effects: EditorView.scrollIntoView(l.from, { y: 'center' }) });
      view.focus();
    }
    if (b.dataset.act === 'add-data') {
      showPane('data');
      const el = cards.get(b.dataset.key);
      el?.scrollIntoView({ block: 'nearest' });
      el?.querySelector('textarea').focus();
    }
    if (b.dataset.act === 'copy-sql' && lastPlan) {
      navigator.clipboard?.writeText(planText(lastPlan)).then(() => toast('Copied the DuckDB SQL'), () => toast('Clipboard access was blocked', 'error'));
    }
  });

  function update(a) {
    analysis = a;
    const on = isBigQuery();
    offEl.hidden = on;
    root.classList.toggle('off', !on);
    if (!on) return;
    renderTargets(a);
    renderTables(a);
    renderParams(a);
  }

  return { update, run };
}
