import './styles.css';
import { openLintPanel } from '@codemirror/lint';
import { EditorView } from '@codemirror/view';
import { undo, redo, undoDepth, redoDepth } from '@codemirror/commands';
import { createEditor, setEditorDialect } from './editor.js';
import { analyzeDoc } from './analyzer.js';
import { createVarsPanel } from './vars-panel.js';
import { createGraphPanel } from './graph-panel.js';
import { SAMPLES } from './sample.js';
import { DIALECTS, dialectOf, currentDialect, setCurrentDialect } from './dialect.js';
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
  if (out === src) { if (!quiet) toast('Already formatted'); return; }
  // Replace only the differing middle so the cursor and scroll stay put.
  let a = 0;
  while (a < src.length && a < out.length && src[a] === out[a]) a++;
  let b = 0;
  while (b < src.length - a && b < out.length - a && src[src.length - 1 - b] === out[out.length - 1 - b]) b++;
  view.dispatch({ changes: { from: a, to: src.length - b, insert: out.slice(a, out.length - b) }, userEvent: 'format' });
  toast(note || 'Formatted · ⌘Z to undo');
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
let reviewBeforeCopy = store.get('reviewBeforeCopy', '1') === '1';
const saved = store.get('doc', null);
let initial = saved ?? SAMPLES[currentDialect()];
if (saved === null) { try { initial = await formatSql(initial); } catch { /* keep raw */ } }

let refreshTimer;
let saveTimer;
const view = createEditor(document.getElementById('editor'), {
  doc: initial,
  extraKeys: [
    { key: 'Mod-Shift-f', run: (v) => { formatDoc(v); return true; } },
    { key: 'Mod-s', run: (v) => { formatDoc(v); return true; }, preventDefault: true },
    { key: 'Mod-Shift-Enter', run: (v) => { copyAll(v); return true; } },
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
        if (formatOnPaste) await formatDoc(view, { quiet: true, note: 'Pasted & formatted · ⌘Z to see the original' });
        setOriginal(view.state.doc.toString());
      }, 0);
    }
  },
});

view.dom.addEventListener('keyup', updateCursor);
view.dom.addEventListener('click', updateCursor);

// Picking a step in the graph / Steps view narrows the filter panel to that
// step; picking a step tag in the filter panel selects it in the graph.
const vars = createVarsPanel(document.getElementById('vars'), { view, toast, onPickStep: (id) => graph.select(id) });
const graph = createGraphPanel(document.getElementById('graph'), {
  view,
  onSelect: (id) => vars.focusStep(id),
  onPreview: (id) => previewCte(id),
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
// One transaction, so ⌘Z brings back what was there. `format` follows "Format on paste".
async function loadQuery(text, note, { format = formatOnPaste } = {}) {
  view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text }, userEvent: 'input.replace' });
  if (format) await formatDoc(view, { quiet: true, note });
  else toast(note.replace(/^Pasted & formatted/, 'Loaded'));
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
  if (switched) await setDialect(shared.dialect, { keepSample: true });
  if (shared.text === view.state.doc.toString()) { if (switched) toast(`Switched to ${engine()} for the shared query`); return; }
  await loadQuery(shared.text, `Opened the shared ${switched ? engine() + ' ' : ''}query · ⌘Z brings back yours`, { format: false });
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
// sample query is swapped for the new dialect's sample.
const dialectSelect = document.querySelector('select.dialect');
dialectSelect.value = currentDialect();
dialectSelect.addEventListener('change', () => setDialect(dialectSelect.value));

async function loadSample() {
  let s = SAMPLES[currentDialect()];
  try { s = await formatSql(s); } catch { /* raw */ }
  view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: s } });
  setOriginal(s);
}

async function setDialect(id, { keepSample = false } = {}) {
  const old = currentDialect();
  if (!DIALECTS[id] || id === old) return;
  const doc = view.state.doc.toString();
  let wasSample = false;
  if (!keepSample) {
    try { wasSample = doc === SAMPLES[old] || doc === await formatSql(SAMPLES[old], old); } catch { /* not the sample */ }
  }
  store.set('dialect', id);
  dialectSelect.value = id;
  setEditorDialect(view, id);
  if (wasSample) await loadSample();
  refresh();
  if (!keepSample) toast(wasSample ? `Loaded the ${engine()} sample query` : `Reading the query as ${engine()}`);
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
  '<div class="tm-sep"></div>' + actItem('sample', 'Load sample query') + actItem('clear', 'Clear editor') +
  `<div class="tm-sep"></div><button class="tm-item tm-act" role="menuitemcheckbox" data-act="format-on-paste"><span class="tm-text"><b>Format on paste</b></span><span class="tm-check">✓</span></button>` +
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
