// The Run tab: small test tables (CSV / TSV text per source table), test values
// for @parameters, and the rows the query returns when it runs on them with
// DuckDB-WASM in this browser. Loaded on first use, like the formatter.

import { EditorView } from '@codemirror/view';
import { previewSql } from './symbols.js';
import { tableKey } from './bq2duck.js';
import { planRun, executePlan, planText } from './runner.js';
import { LIMITS, inspectTable, queryColumns, starterRows, withColumns, csvLine, importText, resolveTableData, parseDelimited } from './testdata.js';

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
    <div class="run-off" hidden>Running translates BigQuery SQL for DuckDB, so switch the dialect to BigQuery to run. You can add and import test tables in any dialect.</div>
    <div class="run-data">
      <p class="run-intro">Type or paste a few rows per table as CSV or TSV (cells copied from Excel or Sheets work), or import CSV and Excel files. The query runs on them here in your browser with DuckDB: nothing is uploaded. Up to ${LIMITS.rows.toLocaleString()} rows and ${LIMITS.cols} columns per table. Add <code>:TYPE</code> to a header to set a type, e.g. <code>id:INT64</code>.</p>
      <div class="tt-bar">
        <button class="mini accent" data-act="add" title="Add a test table by name, then paste or import its rows">+ Add table</button>
        <button class="mini" data-act="import" title="Import .csv, .tsv or .xlsx files. orders.csv, or a sheet named orders, fills the query's orders table">Import CSV / Excel…</button>
        <span class="tt-drop-hint">or drop .csv / .xlsx files here</span>
      </div>
      <h4 class="tt-h">Tables this query reads <span class="badge" data-count="query">0</span></h4>
      <div class="tt-list"></div>
      <div class="tt-other-wrap" hidden>
        <h4 class="tt-h">Your other test tables <span class="badge" data-count="other">0</span></h4>
        <p class="tt-hint">Saved in this browser for any query. A query uses one when it reads a table of that name; a short name like <code>orders</code> also serves <code>proj.ds.orders</code>.</p>
        <div class="tt-others"></div>
      </div>
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
  const otherEl = $('.tt-others');
  const fileInput = Object.assign(document.createElement('input'), { type: 'file', accept: '.csv,.tsv,.txt,.xlsx,.xlsm,text/csv,text/tab-separated-values,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', multiple: true, hidden: true });
  root.append(fileInput);
  let importTarget = null; // a card's key, or null to match files to tables by name
  const paramsEl = $('.tt-params');
  const offEl = $('.run-off');

  let store = loadStore();
  let analysis = null;
  let running = null; // { stop() }
  let lastPlan = null;
  const cards = new Map(); // tableKey -> element (both lists)
  let drafts = []; // "+ Add table" cards that have no name yet
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
  // Two lists: the tables the current query reads (fixed names, with helpers that
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

  function statText(text, from) {
    const info = inspectTable(text);
    if (info.empty) return from ? { text: `uses saved ${from}`, cls: '' } : { text: 'no data yet', cls: 'warn' };
    if (info.error) return { text: info.error, cls: 'error' };
    return { text: `${plural(info.rows, 'row')} · ${plural(info.cols, 'column')}`, cls: info.rows ? '' : 'warn' };
  }

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
        : '<input class="tt-rename" spellcheck="false" autocomplete="off" placeholder="table name, e.g. orders or proj.ds.orders" aria-label="Table name">'}
        <span class="tt-stat"></span></header>
      <div class="tt-cols"></div>
      <textarea class="tt-text" spellcheck="false" autocomplete="off" rows="4"></textarea>
      <div class="tt-grid" hidden></div>
      <div class="tt-tools">${TOOLS[kind]}
        <button class="mini" data-act="import-one" title="Fill this table from a .csv, .tsv or .xlsx file">Import file…</button>
        <button class="mini" data-act="view" title="Switch between the text and a table view of the rows">Table view</button>
        <button class="mini" data-act="${kind === 'query' ? 'clear' : 'delete'}">${kind === 'query' ? 'Clear' : 'Delete'}</button>
      </div>`;
    const ta = el.querySelector('textarea');
    ta.value = store.tables[key] ?? '';
    ta.placeholder = kind === 'query' ? '' : 'id,name,created_at\n1,Ana,2024-01-15 10:00:00';
    ta.addEventListener('input', () => {
      const k = el.dataset.key;
      if (!k) return; // a draft without a name keeps its text until it gets one
      if (ta.value || el.dataset.kind === 'other') store.tables[k] = ta.value;
      else delete store.tables[k];
      save();
      paintStat(el);
      if (el.dataset.kind === 'other' || !ta.value || ta.value.length < 3) paintLinks();
    });
    ta.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); run(); }
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
    const st = statText(el.querySelector('textarea').value, el.dataset.from);
    const s = el.querySelector('.tt-stat');
    s.textContent = st.text;
    s.className = 'tt-stat ' + st.cls;
  }

  // Which saved tables stand in for which empty query tables.
  function paintLinks() {
    const served = new Map(); // saved key -> [query table names]
    for (const el of listEl.querySelectorAll('.tt-query')) {
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
    for (const el of otherEl.querySelectorAll('.tt-other')) {
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
    drafts = drafts.filter((d) => d !== el);
    store.tables[key] = text;
    save();
    el.dataset.key = key;
    cards.set(key, el);
    renderTables(analysis);
    toast(old ? `Renamed to ${key}` : `Added ${key}`);
  }

  function addTable() {
    const el = card('', 'other');
    el.dataset.key = '';
    drafts.unshift(el);
    renderTables(analysis);
    el.scrollIntoView({ block: 'nearest' });
    el.querySelector('.tt-rename').focus();
  }

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

  // Put text in a table, asking before replacing rows that are there.
  function fill(key, text, what) {
    if (!validName(key)) { toast(`Rename ${what} to a plain name like orders first`, 'error'); return false; }
    if ((store.tables[key] ?? '').trim() && store.tables[key] !== text && !confirm(`Replace the test data in ${key} with ${what}?`)) return false;
    store.tables[key] = text;
    const el = cards.get(key);
    if (el) { el.querySelector('textarea').value = text; if (!el.querySelector('.tt-grid').hidden) toggleView(el, true); }
    return true;
  }
  const rowsNote = (r) => (r.truncated ? `first ${r.rows.toLocaleString()} of ${r.total.toLocaleString()} rows` : plural(r.rows, 'row'));

  // Each sheet with cells becomes a table: a sheet named like a table the query
  // reads fills it; otherwise a one-sheet file is named after the file, and a
  // sheet with a real name after the sheet.
  async function importWorkbook(file, target) {
    let sheets;
    try {
      const { readXlsx } = await import('./xlsx.js');
      sheets = await readXlsx(await file.arrayBuffer(), { maxRows: LIMITS.rows });
    } catch (err) { toast(`${file.name}: ${err.message || err}`, 'error'); return; }
    if (!sheets.length) { toast(`${file.name} has no cells to import`, 'error'); return; }
    const plan = [];
    if (target) {
      const named = sheets.find((sh) => { const k = tableKey(plainName(sh.name)); return k === target || target.endsWith('.' + k); });
      plan.push({ key: target, sheet: named || sheets[0] });
    } else {
      const base = plainName(file.name);
      sheets.forEach((sh, i) => {
        const bySheet = targetFor(sh.name);
        if (bySheet.query) plan.push({ key: bySheet.key, sheet: sh });
        else if (sheets.length === 1) plan.push({ key: targetFor(file.name).key, sheet: sh });
        else plan.push({ key: GENERIC_SHEET.test(sh.name) ? tableKey(`${base}_${i + 1}`) : bySheet.key, sheet: sh });
      });
    }
    const done = plan.filter((p) => fill(p.key, p.sheet.text, sheets.length > 1 ? `sheet "${p.sheet.name}" of ${file.name}` : file.name));
    if (!done.length) return;
    save();
    renderTables(analysis);
    const parts = done.map((p) => `${sheets.length > 1 ? `${p.sheet.name} → ` : '→ '}${p.key} (${rowsNote(p.sheet)})`);
    const skipped = target && sheets.length > 1 ? ` · the other ${plural(sheets.length - 1, 'sheet')} skipped: drop the file on the panel to import every sheet` : '';
    toast(`Imported ${file.name} ${parts.join(', ')}${skipped}`);
  }

  async function importFiles(files, target = null) {
    for (const file of files) {
      if (/\.(xls|numbers|ods)$/i.test(file.name)) {
        toast(`${file.name}: save it as .xlsx or CSV first, or copy its cells and paste them into a table`, 'error');
        continue;
      }
      if (file.size > 20 * 1024 * 1024) { toast(`${file.name} is over 20 MB: test tables are meant to be small`, 'error'); continue; }
      if (/\.(xlsx|xlsm)$/i.test(file.name)) { await importWorkbook(file, target); continue; }
      let raw;
      try { raw = await file.text(); } catch { toast(`Couldn't read ${file.name}`, 'error'); continue; }
      if (raw.includes('\u0000')) { toast(`${file.name} doesn't look like a CSV file`, 'error'); continue; }
      const key = target || targetFor(file.name).key;
      const r = importText(raw);
      if (!fill(key, r.text, file.name)) continue;
      save();
      renderTables(analysis);
      toast(`Imported ${file.name} → ${key} (${rowsNote(r)})`);
    }
  }

  fileInput.addEventListener('change', () => {
    const files = [...fileInput.files];
    fileInput.value = '';
    importFiles(files, importTarget);
    importTarget = null;
  });

  dataEl.addEventListener('dragover', (e) => {
    if (![...(e.dataTransfer?.types || [])].includes('Files')) return;
    e.preventDefault();
    dataEl.classList.add('dropping');
    root.querySelectorAll('.tt.drop-on').forEach((x) => x.classList.remove('drop-on'));
    e.target.closest('.tt')?.classList.add('drop-on');
  });
  dataEl.addEventListener('dragleave', (e) => {
    if (!dataEl.contains(e.relatedTarget)) { dataEl.classList.remove('dropping'); root.querySelectorAll('.tt.drop-on').forEach((x) => x.classList.remove('drop-on')); }
  });
  dataEl.addEventListener('drop', (e) => {
    const files = [...(e.dataTransfer?.files || [])];
    dataEl.classList.remove('dropping');
    root.querySelectorAll('.tt.drop-on').forEach((x) => x.classList.remove('drop-on'));
    if (!files.length) return;
    e.preventDefault();
    const onCard = e.target.closest('.tt');
    // Dropped on a card: that table (one file). Elsewhere: each file finds its table by name.
    importFiles(files, onCard?.dataset.key && files.length === 1 ? onCard.dataset.key : null);
  });

  dataEl.addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const act = b.dataset.act;
    if (act === 'add') { addTable(); return; }
    if (act === 'import') { importTarget = null; fileInput.click(); return; }
    if (act === 'goto-table') {
      const el = cards.get(b.dataset.key);
      el?.scrollIntoView({ block: 'nearest' });
      el?.querySelector('textarea').focus();
      return;
    }
    const el = e.target.closest('.tt');
    if (!el) return;
    const key = el.dataset.key;
    const ta = el.querySelector('textarea');
    if (act === 'import-one') {
      if (!key) { toast('Name the table first'); el.querySelector('.tt-rename')?.focus(); return; }
      importTarget = key;
      fileInput.click();
    }
    if (act === 'view') toggleView(el);
    if (act === 'delete') {
      if (ta.value.trim() && !confirm(`Delete the test table ${key || '(unnamed)'}?`)) return;
      if (key) { delete store.tables[key]; cards.delete(key); save(); }
      drafts = drafts.filter((d) => d !== el);
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

  // Put each card in its list, in order, creating the missing ones.
  function place(container, wanted) {
    wanted.forEach((el, i) => { if (container.children[i] !== el) container.insertBefore(el, container.children[i] || null); });
    for (const el of [...container.children]) if (!wanted.includes(el)) el.remove();
  }

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
    const qEls = tables.map((t) => {
      let el = cards.get(t.key);
      if (!el) { el = card(t.key, 'query'); cards.set(t.key, el); }
      el.querySelector('.tt-name').textContent = t.label;
      el.querySelector('.tt-full').textContent = t.full === t.label ? '' : t.full;
      const c = cols.get(t.key) || [];
      el.querySelector('.tt-cols').innerHTML = c.length
        ? `Query reads ${c.map((x) => `<code>${esc(x)}</code>`).join(' ')}`
        : '<span class="muted">The query names no columns of this table</span>';
      const ta = el.querySelector('textarea');
      if (!ta.placeholder) ta.placeholder = c.length ? `${csvLine(c)}\n${starterRows(c, a, 1, t.key)[0]}` : 'id,name\n1,first';
      return el;
    });
    place(listEl, qEls);
    if (!tables.length) listEl.innerHTML = '<div class="tt-none">This query reads no tables. Runs work on its literals alone (e.g. SELECT … FROM UNNEST([…])).</div>';
    const oEls = [...drafts, ...savedOther.map((k) => {
      let el = cards.get(k);
      if (!el) { el = card(k, 'other'); cards.set(k, el); }
      return el;
    })];
    place(otherEl, oEls);
    $('.tt-other-wrap').hidden = !oEls.length;
    root.querySelector('[data-count="query"]').textContent = tables.length;
    root.querySelector('[data-count="other"]').textContent = savedOther.length;
    paintLinks();
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
    for (const el of cards.values()) { el.querySelector('textarea').value = ''; if (!el.querySelector('.tt-grid').hidden) toggleView(el, false); }
    drafts = [];
    paramsEl.dataset.sig = '';
    renderTables(analysis);
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
    goBtn.disabled = !on && !running;
    // Test tables work in every dialect; only running needs BigQuery.
    renderTargets(a);
    renderTables(a);
    renderParams(a);
  }

  return { update, run };
}
