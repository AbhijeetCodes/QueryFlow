import './styles.css';
import { openLintPanel } from '@codemirror/lint';
import { EditorView } from '@codemirror/view';
import { undo, redo, undoDepth, redoDepth } from '@codemirror/commands';
import { createEditor, setEditorDialect } from './editor.js';
import { analyzeDoc } from './analyzer.js';
import { createVarsPanel } from './vars-panel.js';
import { createGraphPanel } from './graph-panel.js';
import { DIALECTS, dialectOf, currentDialect, setCurrentDialect, detectDialect } from './dialect.js';
import { diffLines, diffStats } from './diff.js';
import { previewSql, cteAt } from './symbols.js';
import { encodeShare, decodeShare } from './share.js';

const store = {
  get(k, d) { try { const v = localStorage.getItem('queryflow.' + k); return v === null ? d : v; } catch { return d; } },
  set(k, v) { try { localStorage.setItem('queryflow.' + k, v); } catch { /* private mode */ } },
};

// The dialect is set before anything reads the SQL.
setCurrentDialect(store.get('dialect', 'bigquery'));
const engine = () => dialectOf(currentDialect()).name;

// ---- toast ---------------------------------------------------------------
const toastEl = document.getElementById('toast');
let toastTimer;
function toast(msg, kind = 'ok') {
  toastEl.textContent = msg;
  toastEl.className = `toast show ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toastEl.className = 'toast'; }, 2600);
}

// ---- lazy modules --------------------------------------------------------------
// The formatter and the review dialog aren't needed to show the editor, so
// they load on first use (and when idle).
let formatMod = null;
const loadFormat = () => (formatMod ??= import('./format.js'));
async function formatSql(src, dialect = currentDialect()) {
  return (await loadFormat()).formatSql(src, dialect);
}

// ---- formatting ------------------------------------------------------------
async function formatDoc(view, { quiet = false, note = '' } = {}) {
  if (!view.state.doc.toString().trim()) return;
  let src, out;
  try {
    const fmt = await loadFormat();
    src = view.state.doc.toString(); // read after the await: typing may have changed it
    out = fmt.formatSql(src, currentDialect());
  } catch (err) {
    toast(`Couldn't format: ${String(err.message || err).split('\n')[0]}`, 'error');
    return;
  }
  if (out === src) { if (!quiet) toast('Already formatted'); return false; }
  // Replace only the differing middle so the cursor and scroll stay put.
  let a = 0;
  while (a < src.length && a < out.length && src[a] === out[a]) a++;
  let b = 0;
  while (b < src.length - a && b < out.length - a && src[src.length - 1 - b] === out[out.length - 1 - b]) b++;
  view.dispatch({ changes: { from: a, to: src.length - b, insert: out.slice(a, out.length - b) }, userEvent: 'format' });
  toast(note || 'Formatted · ⌘Z to undo');
  return true;
}

async function writeClipboard(text, message) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = Object.assign(document.createElement('textarea'), { value: text });
    document.body.append(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
  toast(message);
}

const lineCount = (text) => text.split('\n').length;

// Copy SQL: when the query was edited since it was pasted, review the diff first.
function copyAll(view) {
  const text = view.state.doc.toString();
  if (reviewBeforeCopy && original !== null && original.trim() && original !== text) {
    openDiff(original, text);
    return;
  }
  writeClipboard(text, `Copied ${lineCount(text)} lines, ready to paste into ${engine()}`);
}

// ---- editor ----------------------------------------------------------------
let formatOnPaste = store.get('formatOnPaste', '1') === '1';
let detectOnPaste = store.get('detectDialect', '1') === '1';
let reviewBeforeCopy = store.get('reviewBeforeCopy', '1') === '1';
// A first visit starts empty; the example loads only from the card below or the ⋯ menu.
const initial = store.get('doc', '');

// What an empty editor shows: how to start, and the example query with its test tables.
const pasteKey = matchMedia('(hover: none)').matches ? '' : /Mac|iPhone|iPad/.test(navigator.platform || '') ? ' (⌘V)' : ' (Ctrl+V)';
const emptyEl = document.createElement('div');
emptyEl.className = 'editor-empty';
emptyEl.innerHTML = `<div class="ee-card">
  <b>Paste a query to start</b>
  <p>Paste one here${pasteKey} and it is tidied up for you, or open a .sql file.</p>
  <div class="ee-acts">
    <button class="btn primary sm" data-act="sample">Load the example</button>
    <button class="btn sm" data-act="open">Open .sql file…</button>
  </div>
  <small>The example is a short query on a made-up Pokédex, with 3 test tables to run it on in the Run tab.</small>
</div>`;
document.getElementById('editor').append(emptyEl);
emptyEl.addEventListener('click', (e) => {
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (act === 'sample') loadSample();
  else if (act === 'open') openFile();
  else view.focus();
});
const syncEmpty = () => { emptyEl.hidden = view.state.doc.length > 0; };

let refreshTimer;
let saveTimer;
const view = createEditor(document.getElementById('editor'), {
  doc: initial,
  extraKeys: [
    { key: 'Mod-Shift-f', run: (v) => { formatDoc(v); return true; } },
    { key: 'Mod-s', run: (v) => { formatDoc(v); return true; }, preventDefault: true },
    { key: 'Mod-Shift-Enter', run: (v) => { copyAll(v); return true; } },
    { key: 'Mod-Enter', run: () => { runQuery(); return true; }, preventDefault: true },
    { key: 'Mod-Shift-m', run: (v) => { openLintPanel(v); return true; } },
    { key: 'Mod-o', run: () => { openFile(); return true; }, preventDefault: true },
    { key: 'Mod-Shift-s', run: () => { saveFile(); return true; }, preventDefault: true },
  ],
  extensions: [EditorView.domEventHandlers({
    // A .sql file dropped on the editor replaces the query (text drops still insert).
    drop(e) {
      const file = e.dataTransfer?.files?.[0];
      if (!file) return false;
      e.preventDefault();
      readFile(file);
      return true;
    },
  })],
  toast,
  onPreview: (id) => previewCte(id),
  onDocChange: () => {
    syncEmpty();
    syncHistoryButtons();
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(refresh, 120);
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => store.set('doc', view.state.doc.toString()), 400);
  },
  onPaste: (tr, u) => {
    const before = u.startState.doc.length;
    const after = u.state.doc.length;
    let inserted = 0;
    tr.changes.iterChanges((fa, ta, fb, tb) => { inserted += tb - fb; });
    // Only a paste of (nearly) the whole query formats it and becomes "the original".
    if (before === 0 || inserted >= after * 0.9) {
      setTimeout(async () => {
        const switched = await detectFor(view.state.doc.toString());
        const formatted = formatOnPaste && await formatDoc(view, { quiet: true, note: switched + 'Pasted & formatted · ⌘Z to see the original' });
        if (switched && !formatted) toast(switched + 'pick another above if that is wrong');
        setOriginal(view.state.doc.toString());
      }, 0);
    }
  },
});

syncEmpty();
view.dom.addEventListener('keyup', updateCursor);
view.dom.addEventListener('click', updateCursor);

// ---- test runs (the Run tab) ---------------------------------------------------------
// The panel, the BigQuery -> DuckDB translator and DuckDB itself load on first use.
const isBigQuery = () => currentDialect() === 'bigquery';
let runPanel = null;
let runMod = null;
const runEl = () => document.querySelector('.run-view');
function loadRun(el = runEl()) {
  return (runMod ??= import('./run-panel.js').then(({ createRunPanel }) => {
    runPanel = createRunPanel(el, {
      view, toast, getAnalysis: () => analyzeDoc(view.state.doc), isBigQuery,
      // A practice example: BigQuery SQL, so it switches the dialect too.
      openQuery: async (text, note) => {
        if (!isBigQuery()) await setDialect('bigquery', { quiet: true });
        await loadQuery(text, note, { format: false, detect: false });
      },
    });
    return runPanel;
  }));
}
async function runQuery(target) {
  setMView('panel');
  graph.showTab('run');
  if (!isBigQuery()) { toast('Running needs the BigQuery dialect: switch it next to the logo'); return; }
  (await loadRun()).run(target);
}

// ---- phones: one view at a time ---------------------------------------------------
// Below 820px the CSS shows only the editor, the values panel or the Steps / Graph / Run panel,
// whichever body[data-mview] names; the bottom bar switches between them.
const mnav = document.querySelector('.m-nav');
let panelTab = 'graph';
function setMView(v) {
  document.body.dataset.mview = v;
  mnav.querySelectorAll('button').forEach((b) =>
    b.classList.toggle('active', b.dataset.mview === v && (v !== 'panel' || b.dataset.tab === panelTab)));
}
mnav.addEventListener('click', (e) => {
  const b = e.target.closest('[data-mview]');
  if (!b) return;
  setMView(b.dataset.mview);
  if (b.dataset.tab) graph.showTab(b.dataset.tab);
});

// Picking a step in the graph / Steps view narrows the filter panel to that
// step; picking a step tag in the filter panel selects it in the graph.
const vars = createVarsPanel(document.getElementById('vars'), { view, toast, onPickStep: (id) => graph.select(id) });
const graph = createGraphPanel(document.getElementById('graph'), {
  view,
  onSelect: (id) => vars.focusStep(id),
  onPreview: (id) => previewCte(id),
  onRunTab: (el) => loadRun(el).then((p) => p.update(analyzeDoc(view.state.doc))),
  onRun: (id) => runQuery(id),
  onTab: (name) => { panelTab = name; setMView(document.body.dataset.mview || 'sql'); },
});

// ---- preview a CTE -------------------------------------------------------------
// Copies a query that shows the CTE's rows: the DECLAREs, the CTEs it reads, then
// SELECT * FROM it LIMIT 100. The usual way to debug one step of a long query.
function previewCte(id) {
  const p = previewSql(analyzeDoc(view.state.doc), id);
  if (!p) return;
  writeClipboard(p.sql, `Copied a preview of ${p.label} (${plural(p.ctes, 'CTE')}, LIMIT 100), ready to paste into ${engine()}`);
}

// ---- load a whole query (paste button, file, shared link) --------------------------
// One transaction, so ⌘Z brings back what was there. `format` follows "Format on paste";
// `detect` switches the dialect when the query clearly reads as another one.
async function loadQuery(text, note, { format = formatOnPaste, detect = true } = {}) {
  view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text }, userEvent: 'input.replace' });
  const switched = detect ? await detectFor(text) : '';
  if (!(format && await formatDoc(view, { quiet: true, note: switched + note }))) toast(switched + note.replace(/^Pasted & formatted/, 'Loaded'));
  setOriginal(view.state.doc.toString());
  view.focus();
}

// ---- open / save .sql files --------------------------------------------------------
const fileInput = Object.assign(document.createElement('input'), { type: 'file', accept: '.sql,.txt,.bq,text/plain', hidden: true });
document.body.append(fileInput);
fileInput.addEventListener('change', () => {
  if (fileInput.files[0]) readFile(fileInput.files[0]);
  fileInput.value = '';
});
function openFile() { fileInput.click(); }
async function readFile(file) {
  if (file.size > 20 * 1024 * 1024) { toast(`${file.name} is over 20 MB, too big to open`, 'error'); return; }
  let text;
  try { text = await file.text(); } catch { toast(`Couldn't read ${file.name}`, 'error'); return; }
  if (text.includes('\u0000')) { toast(`${file.name} doesn't look like a text file`, 'error'); return; }
  store.set('fileName', file.name);
  await loadQuery(text, `Opened ${file.name}${formatOnPaste ? ' & formatted' : ''} · ⌘Z to undo`);
}
function saveFile() {
  let name = store.get('fileName', 'query.sql');
  if (!/\.(sql|bq|txt)$/i.test(name)) name += '.sql';
  const url = URL.createObjectURL(new Blob([view.state.doc.toString()], { type: 'text/plain' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast(`Saved ${name} to your downloads`);
}

// ---- share by link -------------------------------------------------------------------
// The query travels inside the link's #hash, which browsers don't send to the host.
async function shareLink() {
  const text = view.state.doc.toString();
  if (!text.trim()) { toast('Nothing to share yet', 'error'); return; }
  let hash;
  try { hash = await encodeShare(text, currentDialect()); } catch { toast('This browser cannot build share links', 'error'); return; }
  const url = location.href.split('#')[0] + hash;
  const kb = Math.round(url.length / 1024);
  await writeClipboard(url, url.length > 8000
    ? `Link copied (${kb} KB). Some chat apps cut links this long; Save as .sql is safer.`
    : 'Link copied. The query is inside the link: nothing is uploaded.');
}
async function openShared() {
  let shared;
  try { shared = await decodeShare(location.hash); } catch { toast('This share link is damaged or incomplete', 'error'); }
  if (shared == null) return;
  history.replaceState(null, '', location.href.split('#')[0]);
  const switched = shared.dialect !== currentDialect() && DIALECTS[shared.dialect];
  if (switched) await setDialect(shared.dialect, { quiet: true });
  if (shared.text === view.state.doc.toString()) { if (switched) toast(`Switched to ${engine()} for the shared query`); return; }
  await loadQuery(shared.text, `Opened the shared ${switched ? engine() + ' ' : ''}query · ⌘Z brings back yours`, { format: false, detect: false });
}
addEventListener('hashchange', openShared);

const statSummary = document.getElementById('stat-summary');
const statLint = document.getElementById('stat-lint');
const statCursor = document.getElementById('stat-cursor');
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

// ---- the pasted original, for "review changes before copying" ------------------
let original = store.get('original', null);
if (original === null) { original = view.state.doc.toString(); store.set('original', original); }
const changesBtn = document.querySelector('[data-act="changes"]');
function setOriginal(text) {
  original = text;
  store.set('original', text);
  updateChangesBadge();
}
function updateChangesBadge() {
  const cur = view.state.doc.toString();
  if (original === null || !original.trim() || cur === original) { changesBtn.hidden = true; return; }
  const st = diffStats(diffLines(original, cur));
  changesBtn.hidden = !st.changed;
  changesBtn.innerHTML = `<span class="changes-label">Changes</span>${st.add ? `<span class="d-add">+${st.add}</span>` : ''}${st.del ? `<span class="d-del">−${st.del}</span>` : ''}`;
  changesBtn.title = `${st.add + st.del} line${st.add + st.del === 1 ? '' : 's'} changed since you pasted the query: click to review`;
}
let diffModal = null;
const loadDiff = () => (diffModal ??= import('./diff-view.js').then(({ createDiffModal }) => createDiffModal({
  onCopyEdited: (text) => writeClipboard(text, `Copied ${lineCount(text)} lines (edited), ready to paste into ${engine()}`),
  onCopyOriginal: (text) => writeClipboard(text, `Copied the original ${lineCount(text)} lines`),
  onMarkOriginal: (text) => { setOriginal(text); toast('Current SQL is now the original'); },
  getAlways: () => reviewBeforeCopy,
  setAlways: (on) => { reviewBeforeCopy = on; store.set('reviewBeforeCopy', on ? '1' : '0'); },
})));
const openDiff = (...args) => loadDiff().then((m) => m.open(...args));

function refresh() {
  updateChangesBadge();
  const a = analyzeDoc(view.state.doc);
  vars.update(a);
  graph.update(a);
  if (runPanel && !runEl().hidden) runPanel.update(a);
  const vcount = a.variables.reduce((s, v) => s + v.names.length, 0);
  statSummary.textContent = [
    plural(view.state.doc.lines, 'line'),
    plural(a.stats.tables, 'table'),
    plural(a.stats.ctes, 'CTE'),
    plural(vcount + a.params.length + a.cteParams.length, 'variable'),
  ].join(' · ');
  renderProblems(a.diags);
  updateCursor();
}

// ---- problems --------------------------------------------------------------------
function renderProblems(diags) {
  const counts = { error: 0, warning: 0, info: 0 };
  for (const d of diags) counts[d.severity]++;
  statLint.innerHTML = [
    counts.error ? `<span class="sev error">● ${counts.error}</span>` : '',
    counts.warning ? `<span class="sev warning">▲ ${counts.warning}</span>` : '',
    counts.info ? `<span class="sev info">i ${counts.info}</span>` : '',
  ].join('') || '<span class="sev ok">✓ No problems</span>';
  statLint.title = `${plural(diags.length, 'problem')}. Click to list them (⌘⇧M).`;
}
statLint.addEventListener('click', () => openLintPanel(view));

function updateCursor() {
  const pos = view.state.selection.main.head;
  const line = view.state.doc.lineAt(pos);
  statCursor.textContent = `Ln ${line.number}, Col ${pos - line.from + 1}`;
}

// ---- editor toolbar ------------------------------------------------------------
document.querySelector('.actions').addEventListener('click', async (e) => {
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (!act) return;
  if (act === 'undo' || act === 'redo') { runHistory(act); return; }
  if (act === 'format-on-paste') {
    formatOnPaste = !formatOnPaste;
    store.set('formatOnPaste', formatOnPaste ? '1' : '0');
    fopItem.setAttribute('aria-checked', String(formatOnPaste));
    return;
  }
  if (act === 'detect-dialect') {
    detectOnPaste = !detectOnPaste;
    store.set('detectDialect', detectOnPaste ? '1' : '0');
    detectItem.setAttribute('aria-checked', String(detectOnPaste));
    return;
  }
  if (e.target.closest('.theme-menu')) toggleThemeMenu(false);
  if (act === 'format') formatDoc(view);
  if (act === 'copy') copyAll(view);
  if (act === 'paste') {
    let text;
    try {
      text = await navigator.clipboard.readText();
    } catch {
      toast('Clipboard access was blocked. Click the editor and press ⌘V instead.', 'error');
      return;
    }
    if (!text.trim()) { toast('Clipboard is empty', 'error'); return; }
    await loadQuery(text, 'Pasted & formatted · ⌘Z to see the original', { format: true });
  }
  if (act === 'open') openFile();
  if (act === 'save') saveFile();
  if (act === 'run') runQuery();
  if (act === 'share') shareLink();
  if (act === 'preview') {
    const n = cteAt(analyzeDoc(view.state.doc), view.state.selection.main.head);
    if (n) previewCte(n.id); else toast('Put the cursor inside a CTE (or on its name) to preview it');
  }
  if (act === 'sample') await loadSample();
  if (act === 'changes') {
    if (original !== null) openDiff(original, view.state.doc.toString());
  }
  if (act === 'clear') {
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: '' } });
    view.focus();
    toast('Cleared · ⌘Z to undo');
  }
  if (act === 'theme') toggleThemeMenu();
});

// ---- dialect -------------------------------------------------------------------
// The picker in the toolbar. Switching re-reads the same text; an untouched
// example query is swapped for the new dialect's example.
// An in-app menu (like the ⋯ menu) rather than the browser's native <select> popup.
const DIALECT_NOTES = {
  bigquery: '`proj.ds.t`, DECLARE, @params',
  postgres: '"Names", :: casts, $1 / :name',
  mysql: '`names`, SET @var, # comments',
};
const dialectBtn = document.querySelector('.dialect');
const dialectMenu = document.querySelector('.dialect-menu');
dialectMenu.innerHTML = Object.values(DIALECTS).map((d) => `<button class="tm-item" role="menuitemradio" data-dialect="${d.id}">
  <span class="tm-check">✓</span><span class="tm-text"><b>${d.name}</b><small>${DIALECT_NOTES[d.id] || ''}</small></span></button>`).join('');
const dialectItems = () => [...dialectMenu.querySelectorAll('.tm-item')];
function paintDialect(id = currentDialect()) {
  dialectBtn.querySelector('.dialect-name').textContent = dialectOf(id).name;
  dialectItems().forEach((el) => el.setAttribute('aria-checked', String(el.dataset.dialect === id)));
}
function toggleDialectMenu(open = dialectMenu.hidden) {
  dialectMenu.hidden = !open;
  dialectBtn.setAttribute('aria-expanded', String(open));
  if (open) (dialectMenu.querySelector('[aria-checked="true"]') || dialectItems()[0]).focus();
}
dialectBtn.addEventListener('click', () => toggleDialectMenu());
dialectBtn.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); toggleDialectMenu(true); }
});
dialectMenu.addEventListener('click', (e) => {
  const item = e.target.closest('[data-dialect]');
  if (!item) return;
  toggleDialectMenu(false);
  dialectBtn.focus();
  setDialect(item.dataset.dialect);
});
dialectMenu.addEventListener('keydown', (e) => {
  const items = dialectItems();
  const i = items.indexOf(document.activeElement);
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    items[(i + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length].focus();
  }
  if (e.key === 'Escape' || e.key === 'Tab') { e.preventDefault(); toggleDialectMenu(false); dialectBtn.focus(); }
});
document.addEventListener('pointerdown', (e) => {
  if (!dialectMenu.hidden && !e.target.closest('.dialect-pick')) toggleDialectMenu(false);
});
paintDialect();

// The example query (src/sample.js, loaded on first use) and its test tables in the Run tab.
// One transaction, so ⌘Z brings back what was there.
async function loadSample({ quiet = false } = {}) {
  const { SAMPLES, SAMPLE_TABLES } = await import('./sample.js');
  let s = SAMPLES[currentDialect()];
  try { s = await formatSql(s); } catch { /* raw */ }
  view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: s }, userEvent: 'input.replace' });
  setOriginal(s);
  view.focus();
  const tables = (await loadRun()).loadTables(SAMPLE_TABLES, 'practice data');
  if (quiet) return;
  const n = Object.keys(SAMPLE_TABLES).length;
  toast(!tables ? 'Loaded the example query · ⌘Z to undo'
    : isBigQuery() ? `Loaded the example and its ${n} test tables · ⌘Enter runs it`
      : `Loaded the example and its ${n} test tables · running them needs BigQuery`);
}

// `quiet`: the caller loads its own text and says what happened (no sample swap, no toast).
async function setDialect(id, { quiet = false } = {}) {
  const old = currentDialect();
  if (!DIALECTS[id] || id === old) return;
  const doc = view.state.doc.toString();
  let wasSample = false;
  if (!quiet) {
    if (doc.trim()) {
      try {
        const { SAMPLES } = await import('./sample.js');
        wasSample = doc === SAMPLES[old] || doc === await formatSql(SAMPLES[old], old);
      } catch { /* not the sample */ }
    }
  }
  store.set('dialect', id);
  paintDialect(id);
  setEditorDialect(view, id);
  if (wasSample) await loadSample({ quiet: true });
  refresh();
  if (!quiet) toast(wasSample ? `Loaded the ${engine()} example` : `Reading the query as ${engine()}`);
}

// A whole query pasted or opened that clearly reads as another dialect switches to it
// (⌘Z undoes the paste, not the switch). Returns the start of a toast, or ''.
async function detectFor(text) {
  if (!detectOnPaste) return '';
  const d = detectDialect(text);
  if (!d || d.id === currentDialect()) return '';
  await setDialect(d.id, { quiet: true });
  return `Switched to ${engine()} (${d.reasons.slice(0, 2).join(', ')}) · `;
}

// ---- undo / redo ---------------------------------------------------------------
// Every change (typing, formatting, panel edits, → variable, paste, clear) is a
// CodeMirror transaction, so one history covers all of them.
const undoBtn = document.querySelector('[data-act="undo"]');
const redoBtn = document.querySelector('[data-act="redo"]');
function syncHistoryButtons() {
  undoBtn.disabled = undoDepth(view.state) === 0;
  redoBtn.disabled = redoDepth(view.state) === 0;
}
function runHistory(which) {
  // Leave any side-panel input so the panel re-renders with the restored values.
  const ae = document.activeElement;
  if (ae && ae !== document.body && !view.dom.contains(ae)) ae.blur();
  const ok = which === 'undo' ? undo(view) : redo(view);
  if (!ok) toast(which === 'undo' ? 'Nothing to undo' : 'Nothing to redo');
  syncHistoryButtons();
}
// ⌘Z / ⌘⇧Z / ⌘Y outside the editor (e.g. in a filter value box) undo the query,
// not just the text inside that box. Inside the editor CodeMirror handles it.
document.addEventListener('keydown', (e) => {
  if (!(e.metaKey || e.ctrlKey) || e.altKey || view.dom.contains(e.target)) return;
  const k = e.key.toLowerCase();
  const isUndo = k === 'z' && !e.shiftKey;
  const isRedo = (k === 'z' && e.shiftKey) || k === 'y';
  if (!isUndo && !isRedo) return;
  const t = e.target;
  // Let the promote form's own name / default inputs keep native text undo.
  if (t.closest?.('.promote')) return;
  // …and the Run tab's test tables and parameter values.
  if (t.closest?.('.run-view, .tt-modal')) return;
  e.preventDefault();
  runHistory(isUndo ? 'undo' : 'redo');
}, true);

// ---- theme -------------------------------------------------------------------
// Palettes live in styles.css as [data-theme] blocks. The stored preference is a
// theme id or 'system', which follows the OS between Paper and Midnight.
const THEMES = [
  { id: 'paper', name: 'Paper', kind: 'Light', note: 'Crisp and cool' },
  { id: 'linen', name: 'Linen', kind: 'Light', note: 'Warm, low glare' },
  { id: 'midnight', name: 'Midnight', kind: 'Dark', note: 'Deep blue-black' },
  { id: 'graphite', name: 'Graphite', kind: 'Dark', note: 'Neutral, softer contrast' },
];
const sysDark = matchMedia('(prefers-color-scheme: dark)');
const themeBtn = document.querySelector('[data-act="theme"]');
const themeMenu = document.querySelector('.theme-menu');

function themePref() {
  const p = store.get('theme', 'system');
  return THEMES.some((t) => t.id === p) ? p : 'system';
}
function resolveTheme(pref) {
  return pref === 'system' ? (sysDark.matches ? 'midnight' : 'paper') : pref;
}
function applyTheme() {
  const pref = themePref();
  const id = resolveTheme(pref);
  document.documentElement.dataset.theme = id;
  themeMenu.querySelectorAll('[data-theme-id]').forEach((el) => {
    el.setAttribute('aria-checked', String(el.dataset.themeId === pref));
  });
  paintFavicon();
}
// The favicon is the toolbar logo in the active theme's accent (logo.svg is the
// Paper version, used until this runs).
const favicon = document.querySelector('link[rel="icon"]');
function paintFavicon() {
  const css = getComputedStyle(document.documentElement);
  const bg = css.getPropertyValue('--accent').trim();
  const fg = css.getPropertyValue('--on-accent').trim();
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="${bg}"/><path d="M22.5 14.5A8 8 0 1 0 20.16 20.16L24.5 24.5" fill="none" stroke="${fg}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/><circle cx="24.5" cy="24.5" r="2.5" fill="${fg}"/></svg>`;
  favicon.href = 'data:image/svg+xml,' + encodeURIComponent(svg);
}

// The ⋯ menu: occasional editor actions, the format-on-paste setting and the theme.
const swatch = (id) => `<span class="tsw" data-theme="${id}"><i></i><i></i><i></i></span>`;
const menuItem = (id, name, note, sw) => `<button class="tm-item" role="menuitemradio" data-theme-id="${id}">
  ${sw}<span class="tm-text"><b>${name}</b><small>${note}</small></span><span class="tm-check">✓</span></button>`;
const actItem = (act, name, key = '') => `<button class="tm-item tm-act" role="menuitem" data-act="${act}"><span class="tm-text"><b>${name}</b></span>${key ? `<kbd>${key}</kbd>` : ''}</button>`;
themeMenu.innerHTML =
  actItem('paste', 'Paste &amp; format', '⌘A ⌘V') + actItem('open', 'Open .sql file…', '⌘O') + actItem('save', 'Save as .sql', '⌘⇧S') +
  actItem('preview', 'Copy preview of this CTE', '⌘⌥↵') +
  actItem('run', 'Run on test data', '⌘↵') +
  '<div class="tm-sep"></div>' + actItem('sample', 'Load the example (Pokédex)') + actItem('clear', 'Clear editor') +
  `<div class="tm-sep"></div><button class="tm-item tm-act" role="menuitemcheckbox" data-act="format-on-paste"><span class="tm-text"><b>Format on paste</b></span><span class="tm-check">✓</span></button>` +
  `<button class="tm-item tm-act" role="menuitemcheckbox" data-act="detect-dialect"><span class="tm-text"><b>Detect dialect on paste</b></span><span class="tm-check">✓</span></button>` +
  '<div class="tm-sep"></div><div class="tm-group">Theme</div>' +
  menuItem('system', 'Match system', 'Paper or Midnight', '<span class="tsw system"></span>') +
  THEMES.map((t) => menuItem(t.id, t.name, `${t.kind} · ${t.note}`, swatch(t.id))).join('');

function toggleThemeMenu(open = themeMenu.hidden) {
  themeMenu.hidden = !open;
  themeBtn.setAttribute('aria-expanded', String(open));
  if (open) themeMenu.querySelector('.tm-item').focus();
}
themeMenu.addEventListener('click', (e) => {
  const item = e.target.closest('[data-theme-id]');
  if (!item) return;
  store.set('theme', item.dataset.themeId);
  applyTheme();
  toggleThemeMenu(false);
  themeBtn.focus();
});
themeMenu.addEventListener('keydown', (e) => {
  const items = [...themeMenu.querySelectorAll('.tm-item')];
  const i = items.indexOf(document.activeElement);
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    items[(i + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length].focus();
  }
  if (e.key === 'Escape') { toggleThemeMenu(false); themeBtn.focus(); }
});
document.addEventListener('pointerdown', (e) => {
  if (!themeMenu.hidden && !e.target.closest('.theme-pick')) toggleThemeMenu(false);
});
applyTheme();
sysDark.addEventListener('change', applyTheme);

const fopItem = themeMenu.querySelector('[data-act="format-on-paste"]');
fopItem.setAttribute('aria-checked', String(formatOnPaste));
const detectItem = themeMenu.querySelector('[data-act="detect-dialect"]');
detectItem.setAttribute('aria-checked', String(detectOnPaste));

// ---- resizable panes -------------------------------------------------------
const layoutEl = document.querySelector('.layout');
const rightEl = document.querySelector('.right');
const leftPct = parseFloat(store.get('split.left', '52'));
const topPct = parseFloat(store.get('split.top', '42'));
layoutEl.style.setProperty('--left', leftPct + '%');
rightEl.style.setProperty('--top', topPct + '%');

document.querySelectorAll('.gutter').forEach((g) => {
  g.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    g.setPointerCapture(e.pointerId);
    g.classList.add('dragging');
    const which = g.dataset.split;
    const move = (ev) => {
      if (which === 'left') {
        const r = layoutEl.getBoundingClientRect();
        const pct = Math.min(80, Math.max(25, ((ev.clientX - r.left) / r.width) * 100));
        layoutEl.style.setProperty('--left', pct + '%');
        store.set('split.left', pct.toFixed(1));
      } else {
        const r = rightEl.getBoundingClientRect();
        const pct = Math.min(80, Math.max(15, ((ev.clientY - r.top) / r.height) * 100));
        rightEl.style.setProperty('--top', pct + '%');
        store.set('split.top', pct.toFixed(1));
      }
    };
    const up = () => {
      g.classList.remove('dragging');
      g.removeEventListener('pointermove', move);
      g.removeEventListener('pointerup', up);
    };
    g.addEventListener('pointermove', move);
    g.addEventListener('pointerup', up);
  });
});

refresh();
syncHistoryButtons();
view.focus();
openShared();
(window.requestIdleCallback ?? setTimeout)(() => { loadFormat(); loadDiff(); });
// First visit in this browser: a small card saying what QueryFlow does.
if (!store.get('welcomed')) {
  store.set('welcomed', '1');
  import('./welcome.js').then(({ showWelcome }) => showWelcome());
}
