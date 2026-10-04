// The Run tab: small test tables (CSV / TSV text per source table), test values
// for @parameters, and the rows the query returns when it runs on them with
// DuckDB-WASM in this browser. Loaded on first use, like the formatter.

import { EditorView } from '@codemirror/view';
import { previewSql } from './symbols.js';
import { track } from './stats.js';
import { tableKey } from './bq2duck.js';
import { planRun, executePlan, planText } from './runner.js';
import { PRACTICE_TABLES, PRACTICE_QUERIES, PRACTICE_NOTE } from './practice.js';
import { LIMITS, inspectTable, queryColumns, starterRows, withColumns, csvLine, importText, resolveTableData, parseDelimited, sqlName } from './testdata.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const plural = (n, w) => `${n.toLocaleString()} ${w}${n === 1 ? '' : 's'}`;
const STORE_KEY = 'queryflow.testdata';

function loadStore() {
  try {
    const v = JSON.parse(localStorage.getItem(STORE_KEY) || '{}');
    return { tables: v.tables || {}, params: v.params || {}, cut: v.cut || {} };
  } catch { return { tables: {}, params: {}, cut: {} }; }
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
// The tab itself stays small: what to run, the test tables as chips, parameter
// values and the results. Typing, pasting and importing rows happens in the
// test tables dialog, opened from a chip or "+ Create or upload table".

export function createRunPanel(root, { view, toast, getAnalysis, isBigQuery, openQuery }) {
  root.innerHTML = `
    <div class="run-head">
      <select class="run-target" aria-label="What to run" title="Run the whole query, or stop at one CTE"></select>
      <button class="btn primary sm run-go" title="Run on the test tables (⌘Enter)">Run</button>
      <span class="run-status" aria-live="polite"></span>
      <div class="rp-pick">
        <button class="mini rp-btn" aria-haspopup="menu" aria-expanded="false" title="A small made-up Pokédex database, with example queries to learn SQL on">Practice ▾</button>
        <div class="rp-menu" role="menu" aria-label="Practice" hidden></div>
      </div>
    </div>
    <div class="run-off" hidden>Running needs the BigQuery dialect: switch it next to the logo. Test tables work in any dialect.</div>
    <div class="run-tables">
      <div class="rt-chips"></div>
      <button class="mini accent rt-new" data-act="new" title="Type or paste rows, or upload .csv / .xlsx files. Files can also be dropped here">+ Create or upload table</button>
    </div>
    <div class="run-params" hidden></div>
    <div class="run-results"></div>`;

  const $ = (s) => root.querySelector(s);
  const targetSel = $('.run-target');
  const goBtn = $('.run-go');
  const statusEl = $('.run-status');
  const resEl = $('.run-results');
  const chipsEl = $('.rt-chips');
  const paramsEl = $('.run-params');
  const offEl = $('.run-off');

  const modal = document.createElement('div');
  modal.className = 'tt-modal';
  modal.hidden = true;
  modal.innerHTML = `
    <div class="tt-backdrop" data-act="close"></div>
    <div class="tt-dialog" role="dialog" aria-modal="true" aria-labelledby="tt-title">
      <header class="tt-dhead">
        <div>
          <h2 id="tt-title">Test tables</h2>
          <p class="tt-dsub">Small tables kept in this browser. The query runs on them with DuckDB, here: nothing is uploaded.</p>
        </div>
        <button class="icon-btn" data-act="close" title="Close (Esc)" aria-label="Close">×</button>
      </header>
      <div class="tt-dbody">
        <nav class="tt-side" aria-label="Test tables">
          <div class="tt-side-acts">
            <button class="mini accent" data-act="add">+ New table</button>
            <button class="mini" data-act="import" title="Import .csv, .tsv or .xlsx files. orders.csv, or a sheet named orders, fills the query's orders table">Upload files…</button>
          </div>
          <div class="tt-group" data-group="query"><h4>This query reads</h4><ul></ul></div>
          <div class="tt-group" data-group="other"><h4>Other saved tables</h4><ul></ul></div>
        </nav>
        <div class="tt-main"></div>
      </div>
      <footer class="tt-dfoot">
        <span class="tt-tip">Paste cells from Excel or Sheets, or CSV / TSV. Up to ${LIMITS.rows.toLocaleString()} rows and ${LIMITS.cols} columns. <code>id:INT64</code> in the header sets a type.</span>
        <span class="spacer"></span>
        <button class="link" data-act="clear-all" title="Delete every saved test table and parameter value">Clear all</button>
        <button class="btn" data-act="close">Done</button>
        <button class="btn primary" data-act="run" title="⌘Enter">Run query</button>
      </footer>
    </div>`;
  document.body.append(modal);
  const sideEl = modal.querySelector('.tt-side');
  const mainEl = modal.querySelector('.tt-main');

  const fileInput = Object.assign(document.createElement('input'), { type: 'file', accept: '.csv,.tsv,.txt,.xlsx,.xlsm,text/csv,text/tab-separated-values,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', multiple: true, hidden: true });
  root.append(fileInput);
  let importTarget = null; // a table's key, or null to match files to tables by name

  let store = loadStore();
  let analysis = null;
  let running = null; // { stop() }
  let lastPlan = null;
  let resultShown = false; // results or problems from a run, rather than the idle hint
  let ran = null; // { src, tables } of the run on show
  const cards = new Map(); // tableKey -> editor element
  let draft = null; // a "+ New table" editor that has no name yet
  let selected = null; // the editor shown in the dialog
  let returnFocus = null;
  let saveTimer;

  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      const text = JSON.stringify(store);
      if (text.length > LIMITS.total) { toast(`Test data is over ${Math.round(LIMITS.total / 1e6 * 10) / 10} MB, so it won't be kept after a reload: trim some tables`, 'error'); return; }
      try { localStorage.setItem(STORE_KEY, text); } catch { toast('This browser blocked saving test data', 'error'); }
    }, 300);
  }

  // ---- test tables --------------------------------------------------------------------
  // Two kinds: the tables the current query reads (fixed names, with helpers that
  // read the query), and every other saved test table (named by you, kept for any
  // query). A saved `orders` serves a query's `proj.ds.orders` when that one is empty.

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

  // A table filled from a file that had more rows than a test table keeps.
  const cutOf = (key) => (key && store.tables[key]?.trim() && store.cut[key]) || null;
  const cutText = (c) => `the first ${c.rows.toLocaleString()} of ${plural(c.total, 'row')} of ${c.file}`;

  function statText(text, from, key) {
    const info = inspectTable(text);
    if (info.empty) return from ? { text: `uses ${from}`, cls: '' } : { text: 'no rows yet', cls: 'warn' };
    if (info.error) return { text: info.error, cls: 'error' };
    const c = cutOf(key);
    if (c) return { text: `${cutText(c)} · ${plural(info.cols, 'column')}`, cls: 'warn' };
    return { text: `${plural(info.rows, 'row')} · ${plural(info.cols, 'column')}`, cls: info.rows ? '' : 'warn' };
  }
  const shortStat = (text, from, key) => {
    const info = inspectTable(text);
    if (info.empty) return from ? { text: from, cls: '' } : { text: 'empty', cls: 'warn' };
    if (info.error) return { text: '!', cls: 'error' };
    const c = cutOf(key);
    if (c) return { text: `${c.rows.toLocaleString()} of ${c.total.toLocaleString()}`, cls: 'warn' };
    return { text: plural(info.rows, 'row'), cls: info.rows ? 'ok' : 'warn' };
  };

  const TOOLS = {
    query: `
      <button class="mini" data-act="header" title="Add the columns this query reads from the table to the header row">Columns from query</button>
      <button class="mini" data-act="starter" title="Add 3 rows of made-up values that match the query's joins and filters">Starter rows</button>`,
    other: '',
  };

  function card(key, kind) {
    const el = document.createElement('section');
    el.className = `tt tt-${kind}`;
    el.dataset.key = key;
    el.dataset.kind = kind;
    el.innerHTML = `
      <header>${kind === 'query'
        ? '<b class="tt-name"></b><span class="tt-full"></span>'
        : '<input class="tt-rename" spellcheck="false" autocomplete="off" placeholder="Table name, e.g. orders" aria-label="Table name">'}
        <span class="tt-stat"></span></header>
      <div class="tt-cols"></div>
      <textarea class="tt-text" spellcheck="false" autocomplete="off" rows="10" aria-label="Rows as CSV or TSV"></textarea>
      <div class="tt-grid" hidden></div>
      <div class="tt-tools">${TOOLS[kind]}
        <button class="mini" data-act="import-one" title="Fill this table from a .csv, .tsv or .xlsx file">Upload file…</button>
        <button class="mini" data-act="view" title="Switch between the text and a table view of the rows">Table view</button>
        <span class="tt-drop-hint">or drop a file here</span>
        <button class="mini tt-end" data-act="${kind === 'query' ? 'clear' : 'delete'}">${kind === 'query' ? 'Clear' : 'Delete'}</button>
      </div>`;
    const ta = el.querySelector('textarea');
    ta.value = store.tables[key] ?? '';
    ta.placeholder = kind === 'query' ? '' : 'id,name,created_at\n1,Ana,2024-01-15 10:00:00\n2,Ben,2024-02-03 09:30:00';
    ta.addEventListener('input', () => {
      const k = el.dataset.key;
      if (!k) return; // a draft without a name keeps its text until it gets one
      if (ta.value || el.dataset.kind === 'other') store.tables[k] = ta.value;
      else delete store.tables[k];
      if (!ta.value.trim()) delete store.cut[k];
      save();
      paintStat(el);
      paintNav();
    });
    ta.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); closeTables(); run(); }
    });
    // A big paste (a whole sheet) into an empty box keeps the header and the first rows.
    ta.addEventListener('paste', (e) => {
      const t = e.clipboardData?.getData('text') ?? '';
      if (t.length < 5000 || (ta.value && !(ta.selectionStart === 0 && ta.selectionEnd === ta.value.length))) return;
      const r = importText(t);
      if (!r.truncated) return;
      e.preventDefault();
      setText(el, r.text);
      toast(`Kept the header and the first ${r.rows.toLocaleString()} of ${r.total.toLocaleString()} rows`);
    });
    const name = el.querySelector('.tt-rename');
    if (name) {
      name.value = key;
      name.addEventListener('change', () => renameCard(el, name.value));
      name.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); name.blur(); } });
    }
    return el;
  }

  function setText(el, text) {
    const ta = el.querySelector('textarea');
    if (!el.querySelector('.tt-grid').hidden) toggleView(el, false);
    // execCommand keeps the textarea's own undo; fall back to a plain set.
    ta.focus();
    ta.select();
    if (!document.execCommand?.('insertText', false, text)) { ta.value = text; ta.dispatchEvent(new Event('input')); }
  }

  function paintStat(el) {
    const st = statText(el.querySelector('textarea').value, el.dataset.from, el.dataset.key);
    const s = el.querySelector('.tt-stat');
    s.textContent = st.text;
    s.className = 'tt-stat ' + st.cls;
  }

  // Which saved tables stand in for which empty query tables.
  function paintLinks() {
    const served = new Map(); // saved key -> [query table names]
    for (const el of cards.values()) {
      if (el.dataset.kind !== 'query') continue;
      const found = resolveTableData(store.tables, el.dataset.key);
      const from = found && !found.exact ? found.key : '';
      el.dataset.from = from;
      el.querySelector('.tt-uses')?.remove();
      if (from) {
        el.querySelector('.tt-cols').insertAdjacentHTML('afterend', `<div class="tt-uses">Uses your saved table <button class="link" data-act="goto-table" data-key="${esc(from)}">${esc(from)}</button>. Rows typed here take its place.</div>`);
        served.set(from, [...(served.get(from) || []), el.querySelector('.tt-name').textContent]);
      }
      paintStat(el);
    }
    for (const el of cards.values()) {
      if (el.dataset.kind !== 'other') continue;
      const names = served.get(el.dataset.key);
      el.querySelector('.tt-cols').innerHTML = names ? `Used by this query as <code>${names.map(esc).join('</code>, <code>')}</code>` : '';
      paintStat(el);
    }
  }

  function toggleView(el, grid = el.querySelector('.tt-grid').hidden) {
    const g = el.querySelector('.tt-grid');
    const ta = el.querySelector('textarea');
    g.hidden = !grid;
    ta.hidden = grid;
    el.querySelector('[data-act="view"]').textContent = grid ? 'Text view' : 'Table view';
    if (!grid) return;
    const info = inspectTable(ta.value);
    const { rows } = parseDelimited(ta.value);
    if (!rows.length) { g.innerHTML = '<div class="tt-grid-empty">No rows yet</div>'; return; }
    const shown = rows.slice(1, 201);
    const width = info.names.length;
    g.innerHTML = `<table class="res-grid"><thead><tr><th class="rn">#</th>${info.names.map((n) => `<th>${esc(n)}${info.types[n] ? `<small>${esc(info.types[n])}</small>` : ''}</th>`).join('')}</tr></thead><tbody>${
      shown.map((r, i) => `<tr><td class="rn">${i + 1}</td>${Array.from({ length: Math.max(width, r.length) }, (_, j) => {
        const v = r[j];
        return v === undefined || v === '' || v === 'NULL' ? '<td class="null">NULL</td>' : `<td>${esc(v.length > 80 ? v.slice(0, 80) + '…' : v)}</td>`;
      }).join('')}</tr>`).join('')}</tbody></table>${rows.length - 1 > shown.length ? `<div class="tt-grid-more">First ${shown.length} of ${plural(rows.length - 1, 'row')}</div>` : ''}`;
  }

  const validName = (s) => /^[A-Za-z0-9_`\-.*$]+$/.test(s) && !/^\.|\.$|\.\./.test(s);

  function renameCard(el, raw) {
    const name = raw.trim().replace(/`/g, '');
    const input = el.querySelector('.tt-rename');
    const old = el.dataset.key;
    if (!name) { if (old) input.value = old; return; }
    if (!validName(name)) { toast('Use letters, digits, _ - and dots, like orders or proj.ds.orders', 'error'); input.value = old || ''; return; }
    const key = tableKey(name);
    if (key === old) return;
    if (store.tables[key] !== undefined || cards.has(key)) { toast(`There is already a test table called ${key}`, 'error'); input.value = old || ''; return; }
    const text = el.querySelector('textarea').value;
    if (old) { delete store.tables[old]; cards.delete(old); }
    if (draft === el) draft = null;
    store.tables[key] = text;
    if (old && store.cut[old]) { store.cut[key] = store.cut[old]; delete store.cut[old]; }
    save();
    el.dataset.key = key;
    cards.set(key, el);
    renderTables(analysis);
    // A name the query reads turns the editor into that table's one.
    select(cards.get(key), false);
    toast(old ? `Renamed to ${key}` : `Added ${key}`);
  }

  function addTable() {
    if (!draft) draft = card('', 'other');
    renderTables(analysis);
    select(draft, false);
    draft.querySelector('.tt-rename').focus();
  }

  // ---- the dialog -------------------------------------------------------------------------

  function select(el, focus = true) {
    if (!el) return;
    selected = el;
    if (mainEl.firstChild !== el) mainEl.replaceChildren(el);
    paintNav();
    if (focus) el.querySelector('textarea').focus({ preventScroll: true });
  }

  // Open on a table (its key) or on a new table ('new').
  function openTables(what) {
    if (modal.hidden) returnFocus = document.activeElement;
    modal.hidden = false;
    if (what === 'new') { addTable(); return; }
    renderTables(analysis);
    select(cards.get(what) || selected);
  }

  function closeTables() {
    if (modal.hidden) return;
    modal.hidden = true;
    renderChips();
    if (!resultShown) renderIdle();
    returnFocus?.focus?.();
    returnFocus = null;
  }

  function navItem(el, label) {
    const key = el.dataset.key;
    const st = el === draft ? { text: 'new', cls: '' } : shortStat(el.querySelector('textarea').value, el.dataset.from, key);
    return `<li><button class="tt-navi${el === selected ? ' sel' : ''}" data-key="${esc(key)}"${el === draft ? ' data-draft="1"' : ''} title="${esc(key || 'New table')}">
      <span class="tt-navn">${esc(label)}</span><span class="tt-navs ${st.cls}">${esc(st.text)}</span></button></li>`;
  }

  function paintNav() {
    if (modal.hidden) return;
    const q = [];
    const o = draft ? [navItem(draft, 'New table')] : [];
    for (const el of cards.values()) {
      if (el.dataset.kind === 'query') q.push(navItem(el, el.querySelector('.tt-name').textContent));
      else o.push(navItem(el, el.dataset.key));
    }
    const qg = sideEl.querySelector('[data-group="query"]');
    const og = sideEl.querySelector('[data-group="other"]');
    qg.querySelector('ul').innerHTML = q.join('') || '<li class="tt-navnone">None: the query reads no tables</li>';
    og.querySelector('ul').innerHTML = o.join('');
    og.hidden = !o.length;
  }

  sideEl.addEventListener('click', (e) => {
    const b = e.target.closest('.tt-navi');
    if (b) select(b.dataset.draft ? draft : cards.get(b.dataset.key));
  });

  modal.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); closeTables(); }
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); closeTables(); run(); }
  });

  // ---- importing files ------------------------------------------------------------------

  // A file or sheet name as a table name: orders.csv -> orders, "Q1 orders" -> Q1_orders.
  const plainName = (n) => n.replace(/\.[^.]+$/, '').trim().replace(/[^A-Za-z0-9_.\-]+/g, '_').replace(/^[._-]+|[._-]+$/g, '');
  const GENERIC_SHEET = /^(sheet|tabelle|feuil|hoja|planilha|foglio|blad)\s*\d*$/i;

  // The table a name fills: one the query reads with that name, else a new saved table.
  function targetFor(name) {
    const base = tableKey(plainName(name));
    const q = analysis ? sourceTables(analysis) : [];
    const hit = q.find((t) => t.key === base || t.label.toLowerCase() === base || t.key.endsWith('.' + base));
    return hit ? { key: hit.key, query: true } : { key: base, query: false };
  }

  // Put text in a table, asking before replacing rows that are there. `r` is what
  // importText or readXlsx said about it: a cut file is noted with the table.
  function fill(key, r, what, file) {
    if (!validName(key)) { toast(`Rename ${what} to a plain name like orders first`, 'error'); return false; }
    if ((store.tables[key] ?? '').trim() && store.tables[key] !== r.text && !confirm(`Replace the test data in ${key} with ${what}?`)) return false;
    store.tables[key] = r.text;
    if (r.truncated) store.cut[key] = { rows: r.rows, total: r.total, file };
    else delete store.cut[key];
    const el = cards.get(key);
    if (el) { el.querySelector('textarea').value = r.text; if (!el.querySelector('.tt-grid').hidden) toggleView(el, true); }
    return true;
  }
  const rowsNote = (r) => (r.truncated ? `only the first ${r.rows.toLocaleString()} of ${plural(r.total, 'row')}: test tables are kept small` : plural(r.rows, 'row'));

  // Each sheet with cells becomes a table: a sheet named like a table the query
  // reads fills it; otherwise a one-sheet file is named after the file, and a
  // sheet with a real name after the sheet. Returns what it filled, as importFiles does.
  async function importWorkbook(file, target) {
    let sheets;
    try {
      const { readXlsx } = await import('./xlsx.js');
      sheets = await readXlsx(await file.arrayBuffer(), { maxRows: LIMITS.rows });
    } catch (err) { toast(`${file.name}: ${err.message || err}`, 'error'); return []; }
    if (!sheets.length) { toast(`${file.name} has no cells to import`, 'error'); return []; }
    // A sheet within the row limit can still be over the character limit.
    sheets = sheets.map((sh) => {
      const r = importText(sh.text);
      return r.truncated ? { ...sh, text: r.text, rows: r.rows, truncated: true } : sh;
    });
    const plan = [];
    if (target) {
      const named = sheets.find((sh) => { const k = tableKey(plainName(sh.name)); return k === target || target.endsWith('.' + k); });
      plan.push({ key: target, sheet: named || sheets[0] });
    } else {
      const base = plainName(file.name);
      sheets.forEach((sh, i) => {
        const bySheet = targetFor(sh.name);
        if (bySheet.query) plan.push({ key: bySheet.key, sheet: sh, query: true });
        else if (sheets.length === 1) plan.push({ key: targetFor(file.name).key, sheet: sh, query: targetFor(file.name).query });
        else plan.push({ key: GENERIC_SHEET.test(sh.name) ? tableKey(`${base}_${i + 1}`) : bySheet.key, sheet: sh, query: false });
      });
    }
    const one = sheets.length === 1;
    const done = plan.filter((p) => fill(p.key, p.sheet, one ? file.name : `sheet "${p.sheet.name}" of ${file.name}`, one ? file.name : `${file.name} (${p.sheet.name})`));
    if (!done.length) return [];
    save();
    renderTables(analysis);
    const parts = done.map((p) => `${one ? '→ ' : `${p.sheet.name} → `}${p.key} (${rowsNote(p.sheet)})`);
    const skipped = target && sheets.length > 1 ? ` · the other ${plural(sheets.length - 1, 'sheet')} skipped: use "Upload files…" to import every sheet` : '';
    toast(`Imported ${file.name} ${parts.join(', ')}${skipped}`);
    return done.map((p) => ({ key: p.key, file: file.name, rows: p.sheet.rows, total: p.sheet.total, truncated: !!p.sheet.truncated, query: !!(target || p.query) }));
  }

  // Each file becomes a test table, or fills the one it is named after (or `target`).
  // Returns [{ key, file, rows, total, truncated, query }], `query` when the query reads it.
  async function importFiles(files, target = null) {
    const done = [];
    for (const file of files) {
      if (/\.(xls|numbers|ods)$/i.test(file.name)) {
        toast(`${file.name}: save it as .xlsx or CSV first, or copy its cells and paste them into a table`, 'error');
        continue;
      }
      if (file.size > 20 * 1024 * 1024) { toast(`${file.name} is over 20 MB: test tables are meant to be small`, 'error'); continue; }
      if (/\.(xlsx|xlsm)$/i.test(file.name)) { done.push(...await importWorkbook(file, target)); continue; }
      let raw;
      try { raw = await file.text(); } catch { toast(`Couldn't read ${file.name}`, 'error'); continue; }
      if (raw.includes('\u0000')) { toast(`${file.name} doesn't look like a CSV file`, 'error'); continue; }
      const t = target ? { key: target, query: true } : targetFor(file.name);
      const r = importText(raw);
      if (!fill(t.key, r, file.name, file.name)) continue;
      save();
      renderTables(analysis);
      toast(`Imported ${file.name} → ${t.key} (${rowsNote(r)})`);
      done.push({ key: t.key, file: file.name, rows: r.rows, total: r.total, truncated: r.truncated, query: t.query });
    }
    return done;
  }

  // Imported into the open dialog: an empty new-table editor gives way to the
  // table the file made, and the dialog shows that table.
  async function importAndShow(files, target) {
    const done = await importFiles(files, target);
    const keys = done.map((d) => d.key);
    if (!keys.length) return done;
    if (draft && !draft.querySelector('textarea').value.trim() && (selected === draft || !target)) {
      if (selected === draft) selected = null;
      draft = null;
    }
    if (modal.hidden) { renderChips(); if (!resultShown) renderIdle(); return done; }
    renderTables(analysis);
    select(cards.get(keys[keys.length - 1]), false);
    return done;
  }

  fileInput.addEventListener('change', () => {
    const files = [...fileInput.files];
    fileInput.value = '';
    importAndShow(files, importTarget);
    importTarget = null;
  });

  // Files dropped on the dialog's editor fill that table (one file); dropped on
  // its list, each file finds its table by name. Drops anywhere else on the page
  // come in through addFiles (main.js).
  function dropZone(el, targetOf) {
    const clear = () => { el.classList.remove('dropping'); document.querySelectorAll('.drop-on').forEach((x) => x.classList.remove('drop-on')); };
    el.addEventListener('dragover', (e) => {
      if (![...(e.dataTransfer?.types || [])].includes('Files')) return;
      e.preventDefault();
      el.classList.add('dropping');
      document.querySelectorAll('.drop-on').forEach((x) => x.classList.remove('drop-on'));
      e.target.closest('.tt-main')?.classList.add('drop-on');
    });
    el.addEventListener('dragleave', (e) => { if (!el.contains(e.relatedTarget)) clear(); });
    el.addEventListener('drop', (e) => {
      const files = [...(e.dataTransfer?.files || [])];
      clear();
      if (!files.length) return;
      e.preventDefault();
      importAndShow(files, files.length === 1 ? targetOf(e) : null);
    });
  }
  dropZone(modal.querySelector('.tt-dialog'), (e) => (e.target.closest('.tt-main') && selected?.dataset.key) || null);

  modal.addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const act = b.dataset.act;
    if (act === 'close') { closeTables(); return; }
    if (act === 'run') { closeTables(); run(); return; }
    if (act === 'add') { addTable(); return; }
    if (act === 'import') { importTarget = null; fileInput.click(); return; }
    if (act === 'clear-all') { clearAll(); return; }
    if (act === 'goto-table') { select(cards.get(b.dataset.key)); return; }
    const el = e.target.closest('.tt');
    if (!el) return;
    const key = el.dataset.key;
    const ta = el.querySelector('textarea');
    if (act === 'import-one') {
      importTarget = key || null; // a new table without a name takes the file's name
      fileInput.click();
    }
    if (act === 'view') toggleView(el);
    if (act === 'delete') {
      if (ta.value.trim() && !confirm(`Delete the test table ${key || '(unnamed)'}?`)) return;
      if (key) { delete store.tables[key]; delete store.cut[key]; cards.delete(key); save(); }
      if (draft === el) draft = null;
      selected = null;
      el.remove();
      renderTables(analysis);
      return;
    }
    if (act === 'clear') setText(el, '');
    const cols = (analysis && queryColumns(analysis).get(key)) || [];
    if (act === 'header') {
      if (!cols.length) { toast('The query doesn\'t name any columns of this table (it may only use *): type a header row'); return; }
      setText(el, withColumns(ta.value, cols));
    }
    if (act === 'starter') {
      let text = ta.value;
      let header = inspectTable(text).names;
      if (!header.length) {
        if (!cols.length) { toast('Type a header row first: the query doesn\'t name this table\'s columns'); return; }
        header = cols;
        text = csvLine(cols) + '\n';
      }
      const info = inspectTable(text);
      const rows = starterRows(header, analysis, 3, key);
      const sep = info.delim !== ',' ? (l) => l.split(',').join(info.delim) : (l) => l;
      setText(el, text.replace(/\n*$/, '\n') + rows.map(sep).join('\n') + '\n');
    }
  });

  function clearAll() {
    if (!Object.keys(store.tables).length && !Object.keys(store.params).length) { toast('No test data saved'); return; }
    if (!confirm('Delete all saved test tables and parameter values (for every query)?')) return;
    store = { tables: {}, params: {}, cut: {} };
    save();
    for (const el of cards.values()) { el.querySelector('textarea').value = ''; if (!el.querySelector('.tt-grid').hidden) toggleView(el, false); }
    draft = null;
    selected = null;
    paramsEl.dataset.sig = '';
    renderTables(analysis);
    if (analysis) { renderParams(analysis); renderChips(); if (!resultShown) renderIdle(); }
    toast('Test data cleared');
  }

  // ---- the tab: chips, parameters and the idle hint ----------------------------------------

  // The query's tables that have no rows of their own or from a saved table.
  const emptyTables = () => (analysis ? sourceTables(analysis).filter((t) => !resolveTableData(store.tables, t.key)) : []);

  function renderChips() {
    if (!analysis) return;
    const tables = sourceTables(analysis);
    const queryKeys = new Set(tables.map((t) => t.key));
    const others = Object.keys(store.tables).filter((k) => !queryKeys.has(k)).sort();
    const chip = (key, label, text, from) => {
      const st = shortStat(text, from, key);
      return `<button class="rt-chip ${st.cls}" data-key="${esc(key)}" title="${esc(key)}: ${esc(statText(text, from, key).text)}. Click to edit"><span>${esc(label)}</span><small>${esc(st.text)}</small></button>`;
    };
    let html = tables.map((t) => {
      const found = resolveTableData(store.tables, t.key);
      return chip(t.key, t.label, store.tables[t.key] ?? '', found && !found.exact ? found.key : '');
    }).join('');
    // With no tables in the query (a learner starting out), the saved tables are the point.
    if (!tables.length) html = others.map((k) => chip(k, k, store.tables[k], '')).join('');
    else if (others.length) html += `<button class="rt-more" data-act="open" data-key="${esc(others[0])}" title="Saved test tables this query doesn't read">+${others.length} saved</button>`;
    chipsEl.innerHTML = html;
    if (tables.length > LIMITS.tables) toast(`This query reads ${tables.length} tables: test runs take up to ${LIMITS.tables}`, 'error');
  }

  // What the results area says before a run: what's missing, or that it's ready.
  function renderIdle() {
    if (!analysis) return;
    const tables = sourceTables(analysis);
    const empty = emptyTables();
    const saved = Object.keys(store.tables).filter((k) => store.tables[k]?.trim());
    const runKey = '<kbd>⌘</kbd><kbd>Enter</kbd>';
    let html;
    const practice = practiceLoaded();
    if (practice && (!analysis.src.trim() || !tables.length)) {
      html = `<h3>Practice database: a small Pokédex</h3>
        <p>${esc(PRACTICE_NOTE)} Pick an example to load and run it, or write your own query, e.g. <code>SELECT * FROM pokedex.trainers</code>.</p>
        ${examplesHtml()}`;
    } else if (!analysis.src.trim() || (!tables.length && !saved.length)) {
      html = `<h3>Practise SQL on a small database</h3>
        <p>Load a made-up Pokédex (Pokémon, trainers and their teams) and try example queries on it, from <code>SELECT *</code> to joins and CTEs. Or make tables of your own. It all runs here in your browser.</p>
        <div class="res-idle-acts">
          <button class="btn primary sm" data-act="practice">Load the practice database</button>
          <button class="btn sm" data-act="new">+ Create or upload table</button>
        </div>`;
    } else if (!tables.length) {
      const example = saved.sort((x, y) => x.length - y.length)[0] || 'orders';
      html = `<h3>Practise on a small table</h3>
        <ol>
          <li>${saved.length ? 'Use one of your tables above, or create one' : 'Create a table'}: type a few rows, paste cells from a sheet, or upload a CSV / Excel file.</li>
          <li>Write a query on it in the editor, e.g. <code>SELECT * FROM ${esc(example)}</code>.</li>
          <li>Run it (${runKey}): it runs here in your browser, nothing is uploaded.</li>
        </ol>
        <div class="res-idle-acts"><button class="btn primary sm" data-act="new">+ Create or upload table</button></div>`;
    } else if (empty.length) {
      const fillable = empty.filter((t) => (queryColumns(analysis).get(t.key) || []).length);
      html = `<h3>${empty.length === tables.length ? 'Add a few rows to run this query' : `${plural(empty.length, 'table')} still ${empty.length === 1 ? 'has' : 'have'} no rows`}</h3>
        <p>${empty.slice(0, 6).map((t) => `<button class="link" data-act="edit" data-key="${esc(t.key)}">${esc(t.label)}</button>`).join(', ')}${empty.length > 6 ? ` and ${empty.length - 6} more` : ''}: type or paste rows, or upload a file.${fillable.length ? ' Or fill them with made-up rows that match the query\'s joins and filters.' : ''}</p>
        <div class="res-idle-acts">
          ${fillable.length ? `<button class="btn primary sm" data-act="fill" title="3 made-up rows per table, from the columns the query reads">Fill with starter rows</button>` : ''}
          <button class="btn sm" data-act="edit" data-key="${esc(empty[0].key)}">Add rows…</button>
        </div>`;
    } else if (!isBigQuery()) {
      html = '<h3>Test tables are ready</h3><p>Switch the dialect to BigQuery to run the query on them.</p>';
    } else {
      html = `<h3>Ready to run</h3><p>Press <b>Run</b> (${runKey}) to run the ${tables.length ? 'query on the test tables' : 'query'}. Pick a CTE next to Run to see the rows of one step.</p>`;
    }
    resEl.innerHTML = `<div class="res-idle">${html}</div>`;
  }

  // ---- the practice database ------------------------------------------------------------

  const PRACTICE_KEYS = Object.keys(PRACTICE_TABLES);
  const practiceLoaded = () => PRACTICE_KEYS.every((k) => store.tables[k]?.trim());
  const examplesHtml = () => `<ol class="res-examples">${PRACTICE_QUERIES.map((q, i) =>
    `<li><button class="link" data-act="example" data-i="${i}">${esc(q.title)}</button></li>`).join('')}</ol>`;

  // Writes the practice tables (for the Practice menu or the editor's example), asking
  // before replacing edited ones. Returns false when declined.
  function loadTables(tables, what) {
    const keys = Object.keys(tables);
    const changed = keys.filter((k) => store.tables[k]?.trim() && store.tables[k] !== tables[k]);
    if (changed.length && !confirm(`Reset ${changed.join(', ')} to the ${what}? Your edits to ${changed.length === 1 ? 'it' : 'them'} are replaced.`)) return false;
    for (const k of keys) {
      store.tables[k] = tables[k];
      delete store.cut[k];
      const el = cards.get(k);
      if (el) { el.querySelector('textarea').value = tables[k]; if (!el.querySelector('.tt-grid').hidden) toggleView(el, true); }
    }
    save();
    if (analysis) { renderTables(analysis); renderChips(); if (!resultShown) renderIdle(); }
    return true;
  }
  function loadPractice({ quiet = false } = {}) {
    if (!loadTables(PRACTICE_TABLES, 'practice data')) return false;
    if (!quiet) toast(`Loaded the practice database: ${PRACTICE_KEYS.join(', ')}`);
    return true;
  }

  // An example goes into the editor (one undo brings the old query back) and runs.
  async function runExample(i) {
    const q = PRACTICE_QUERIES[i];
    if (!q) return;
    if (!practiceLoaded() && !loadPractice({ quiet: true })) return;
    await openQuery(q.sql, `Example: ${q.title} · ⌘Z brings back your query`);
    targetSel.value = '';
    run('');
  }

  const pickBtn = $('.rp-btn');
  const pickMenu = $('.rp-menu');
  function togglePractice(open = pickMenu.hidden) {
    if (open) {
      pickMenu.innerHTML = `<div class="rp-h">Example queries</div>
        ${PRACTICE_QUERIES.map((q, i) => `<button class="rp-item" role="menuitem" data-act="example" data-i="${i}">${esc(q.title)}</button>`).join('')}
        <div class="rp-sep"></div>
        <button class="rp-item" role="menuitem" data-act="practice">${practiceLoaded() ? 'Reset the practice tables' : 'Load the practice tables only'}</button>`;
    }
    pickMenu.hidden = !open;
    pickBtn.setAttribute('aria-expanded', String(open));
    if (open) pickMenu.querySelector('.rp-item')?.focus();
  }
  pickBtn.addEventListener('click', () => togglePractice());
  pickMenu.addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    togglePractice(false);
    if (b.dataset.act === 'example') runExample(+b.dataset.i);
    else loadPractice();
  });
  pickMenu.addEventListener('keydown', (e) => {
    const items = [...pickMenu.querySelectorAll('.rp-item')];
    const i = items.indexOf(document.activeElement);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      items[(i + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length].focus();
    }
    if (e.key === 'Escape' || e.key === 'Tab') { e.preventDefault(); togglePractice(false); pickBtn.focus(); }
  });
  document.addEventListener('pointerdown', (e) => {
    if (!pickMenu.hidden && !e.target.closest('.rp-pick')) togglePractice(false);
  });

  // One click to runnable: 3 made-up rows in each empty table the query names columns of.
  function fillStarters() {
    const filled = [];
    for (const t of emptyTables()) {
      const cols = queryColumns(analysis).get(t.key) || [];
      if (!cols.length) continue;
      const text = `${csvLine(cols)}\n${starterRows(cols, analysis, 3, t.key).join('\n')}\n`;
      store.tables[t.key] = text;
      const el = cards.get(t.key);
      if (el) { el.querySelector('textarea').value = text; if (!el.querySelector('.tt-grid').hidden) toggleView(el, true); }
      filled.push(t.label);
    }
    if (!filled.length) return;
    save();
    renderTables(analysis);
    renderChips();
    renderIdle();
    const left = emptyTables().length;
    toast(`Added 3 made-up rows to ${filled.join(', ')}${left ? ` · ${plural(left, 'table')} still need a header row` : ''}. Click a table to edit its rows`);
  }

  root.querySelector('.run-tables').addEventListener('click', (e) => {
    const b = e.target.closest('.rt-chip, [data-act]');
    if (!b) return;
    openTables(b.dataset.act === 'new' ? 'new' : b.dataset.key);
  });

  // Keep the editors in step with the query: one per table it reads and per saved table.
  function renderTables(a) {
    if (!a) return;
    const tables = sourceTables(a);
    const cols = queryColumns(a);
    const queryKeys = new Set(tables.map((t) => t.key));
    const savedOther = Object.keys(store.tables).filter((k) => !queryKeys.has(k)).sort();
    const want = new Map([...tables.map((t) => [t.key, 'query']), ...savedOther.map((k) => [k, 'other'])]);
    for (const [k, el] of cards) {
      if (want.get(k) !== el.dataset.kind) { el.remove(); cards.delete(k); }
    }
    const order = new Map();
    for (const t of tables) {
      let el = cards.get(t.key);
      if (!el) el = card(t.key, 'query');
      el.querySelector('.tt-name').textContent = t.label;
      el.querySelector('.tt-full').textContent = t.full === t.label ? '' : t.full;
      const c = cols.get(t.key) || [];
      el.querySelector('.tt-cols').innerHTML = c.length
        ? `Query reads ${c.map((x) => `<code>${esc(x)}</code>`).join(' ')}`
        : '<span class="muted">The query names no columns of this table: type a header row</span>';
      const ta = el.querySelector('textarea');
      if (!ta.placeholder) ta.placeholder = c.length ? `${csvLine(c)}\n${starterRows(c, a, 1, t.key)[0]}` : 'id,name\n1,first';
      order.set(t.key, el);
    }
    for (const k of savedOther) order.set(k, cards.get(k) || card(k, 'other'));
    cards.clear();
    for (const [k, el] of order) cards.set(k, el);
    paintLinks();
    if (selected && selected !== draft && !cards.has(selected.dataset.key)) selected = cards.get(selected.dataset.key) || null;
    if (!modal.hidden) {
      const el = selected || draft || [...cards.values()][0];
      if (el) select(el, false); else addTable();
    }
  }

  function renderParams(a) {
    const params = (a.params || []).filter((p) => (p.sigil ?? '@') === '@');
    paramsEl.hidden = !params.length;
    if (!params.length) { paramsEl.innerHTML = ''; paramsEl.dataset.sig = ''; return; }
    const focused = document.activeElement?.closest?.('.run-params') ? document.activeElement.dataset.param : null;
    const sig = params.map((p) => p.name.toLowerCase()).join(',');
    if (paramsEl.dataset.sig === sig) return;
    paramsEl.dataset.sig = sig;
    paramsEl.innerHTML = `<span class="rp-label" title="A SQL value for each, e.g. 'SG', 42, DATE '2024-01-01'. Empty means NULL">Parameters</span>
      ${params.map((p) => `<label class="tt-param"><span>@${esc(p.name)}</span><input data-param="${esc(p.name.toLowerCase())}" spellcheck="false" placeholder="NULL" value="${esc(store.params[p.name.toLowerCase()] ?? '')}"></label>`).join('')}`;
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
    resultShown = true;
    ran = { src: a.src, tables: tablesSig(a) };
    resEl.classList.remove('stale');
    if (problems.length) {
      renderProblems(problems, translation);
      setStatus('Not run', 'error');
      return;
    }
    track('run');
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
  }
  goBtn.addEventListener('click', () => run());

  // ---- results ------------------------------------------------------------------------------

  function notesHtml(warnings) {
    if (!warnings?.length) return '';
    return `<ul class="res-notes">${warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul>`;
  }

  // Tables the run read that hold only part of their file: counts and totals cover those rows.
  function cutHtml(a) {
    const seen = new Set();
    const cut = [];
    for (const t of sourceTables(a)) {
      const k = resolveTableData(store.tables, t.key)?.key;
      const c = cutOf(k);
      if (c && !seen.has(k)) { seen.add(k); cut.push(`<b>${esc(t.label)}</b> has ${esc(cutText(c))}`); }
    }
    if (!cut.length) return '';
    return `<div class="res-cut">${cut.join('; ')}. Test tables keep up to ${LIMITS.rows.toLocaleString()} rows and ${Math.round(LIMITS.chars / 1000)}k characters, so counts and totals here cover only the rows kept.</div>`;
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
      ${cutHtml(getAnalysis())}
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
    if (b.dataset.act === 'add-data' || b.dataset.act === 'edit') openTables(b.dataset.key);
    if (b.dataset.act === 'new') openTables('new');
    if (b.dataset.act === 'fill') fillStarters();
    if (b.dataset.act === 'rerun') run();
    if (b.dataset.act === 'practice') loadPractice();
    if (b.dataset.act === 'example') runExample(+b.dataset.i);
    if (b.dataset.act === 'copy-sql' && lastPlan) {
      navigator.clipboard?.writeText(planText(lastPlan)).then(() => toast('Copied the DuckDB SQL'), () => toast('Clipboard access was blocked', 'error'));
    }
  });

  const tablesSig = (a) => sourceTables(a).map((t) => t.key).join(',');

  // Results of an earlier version of the query: a query on other tables starts
  // over from the hint; other edits keep the rows with a note to run again.
  function markStale(a) {
    if (!resultShown || !ran || running) return;
    if (ran.tables !== tablesSig(a)) { resultShown = false; ran = null; setStatus(''); return; }
    const stale = a.src !== ran.src;
    let bar = resEl.querySelector('.res-stale');
    if (stale && !bar) {
      resEl.insertAdjacentHTML('afterbegin', '<div class="res-stale">The query changed since this run. <button class="link" data-act="rerun">Run again</button> <span class="muted">(⌘Enter)</span></div>');
    } else if (!stale && bar) bar.remove();
    resEl.classList.toggle('stale', stale);
  }

  function update(a) {
    analysis = a;
    markStale(a);
    const on = isBigQuery();
    offEl.hidden = on;
    root.classList.toggle('off', !on);
    goBtn.disabled = !on && !running;
    modal.querySelector('[data-act="run"]').hidden = !on;
    // Test tables work in every dialect; only running needs BigQuery.
    renderTargets(a);
    renderTables(a);
    renderChips();
    renderParams(a);
    if (!resultShown) renderIdle();
  }

  // Files dropped on the page or opened from the editor: see importFiles. `sql` is
  // the table's name as the query writes it.
  const addFiles = async (files) => (await importAndShow(files, null)).map((d) => ({ ...d, sql: sqlName(d.key) }));

  return { update, run, openTables, loadTables, addFiles };
}
