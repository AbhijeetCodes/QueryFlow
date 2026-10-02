// "Review changes" dialog: before copying, what changed since the query was
// pasted, with the edited part of each changed line highlighted.

import { diffLines, diffStats, toHunks, toSplitRows } from './diff.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function lineHtml(o) {
  if (!o.hl) return esc(o.text) || ' ';
  const [s, e] = o.hl;
  return `${esc(o.text.slice(0, s))}<mark>${esc(o.text.slice(s, e)) || ' '}</mark>${esc(o.text.slice(e))}`;
}

const getMode = () => { try { return localStorage.getItem('queryflow.diffMode') === 'unified' ? 'unified' : 'split'; } catch { return 'split'; } };
const saveMode = (m) => { try { localStorage.setItem('queryflow.diffMode', m); } catch { /* private mode */ } };

export function createDiffModal({ onCopyEdited, onCopyOriginal, onMarkOriginal, getAlways, setAlways }) {
  const el = document.createElement('div');
  el.className = 'diff-modal';
  el.hidden = true;
  el.innerHTML = `
    <div class="diff-backdrop" data-act="close"></div>
    <div class="diff-dialog" role="dialog" aria-modal="true" aria-labelledby="diff-title">
      <header class="diff-head">
        <div>
          <h2 id="diff-title">Review changes before copying</h2>
          <p class="diff-sub"></p>
        </div>
        <div class="mode-switch diff-mode" role="group" aria-label="Diff layout">
          <button data-mode="split" title="Old on the left, new on the right">Side by side</button>
          <button data-mode="unified" title="One column, removals then additions">Unified</button>
        </div>
        <button class="icon-btn" data-act="close" title="Close (Esc)">×</button>
      </header>
      <div class="diff-body"></div>
      <footer class="diff-foot">
        <label class="toggle" title="When off, Copy SQL copies straight away"><input type="checkbox" data-setting="always"/> <span>Always review before copying</span></label>
        <button class="link" data-act="mark" title="Compare against the current SQL from now on">Mark current as original</button>
        <span class="spacer"></span>
        <button class="btn" data-act="copy-original">Copy original</button>
        <button class="btn primary" data-act="copy-edited" title="Enter">Copy edited SQL</button>
      </footer>
    </div>`;
  document.body.append(el);
  const body = el.querySelector('.diff-body');
  const sub = el.querySelector('.diff-sub');
  const always = el.querySelector('[data-setting="always"]');
  let state = null;
  let expanded = false;
  let mode = getMode();

  const unifiedHtml = (items) => `<table class="diff-table"><tbody>${items.map((o) => {
    if (o.t === 'fold') return `<tr class="fold"><td colspan="4"><button class="link" data-act="expand">⋯ ${o.count} unchanged line${o.count === 1 ? '' : 's'}</button></td></tr>`;
    const sign = o.t === 'add' ? '+' : o.t === 'del' ? '−' : '';
    return `<tr class="${o.t}"><td class="ln">${o.a !== undefined ? o.a + 1 : ''}</td><td class="ln">${o.b !== undefined ? o.b + 1 : ''}</td><td class="sg">${sign}</td><td class="tx"><pre>${lineHtml(o)}</pre></td></tr>`;
  }).join('')}</tbody></table>`;

  const side = (o, n) => (o
    ? `<td class="ln">${n + 1}</td><td class="tx"><pre>${lineHtml(o)}</pre></td>`
    : '<td class="ln"></td><td class="tx"><pre> </pre></td>');
  const splitHtml = (items) => `<table class="diff-table split"><colgroup><col class="c-ln"><col class="c-tx"><col class="c-ln"><col class="c-tx"></colgroup>
    <thead><tr><th colspan="2">Original</th><th colspan="2">Edited</th></tr></thead>
    <tbody>${toSplitRows(items).map((r) => {
    if (r.t === 'fold') return `<tr class="fold"><td colspan="4"><button class="link" data-act="expand">⋯ ${r.count} unchanged line${r.count === 1 ? '' : 's'}</button></td></tr>`;
    const cls = r.t === 'same' ? 'same' : `chg${r.l ? ' has-l' : ''}${r.r ? ' has-r' : ''}`;
    return `<tr class="${cls}">${side(r.l, r.l?.a)}${side(r.r, r.r?.b)}</tr>`;
  }).join('')}</tbody></table>`;

  function render() {
    const { ops } = state;
    const st = diffStats(ops);
    sub.innerHTML = st.changed
      ? `${[st.add ? `<span class="d-add">+${st.add}</span>` : '', st.del ? `<span class="d-del">−${st.del}</span>` : ''].filter(Boolean).join(' ')} line${st.add + st.del === 1 ? '' : 's'} changed since you pasted the query`
      : 'No changes since you pasted the query.';
    const items = expanded ? ops : toHunks(ops, 3);
    body.innerHTML = mode === 'split' ? splitHtml(items) : unifiedHtml(items);
    el.classList.toggle('is-split', mode === 'split');
    el.querySelectorAll('.diff-mode button').forEach((b) => b.classList.toggle('on', b.dataset.mode === mode));
    const first = body.querySelector('tr.add, tr.del, tr.chg');
    if (first && !expanded) first.scrollIntoView({ block: 'center' });
  }

  function open(original, current) {
    state = { original, current, ops: diffLines(original, current) };
    expanded = false;
    mode = getMode();
    always.checked = getAlways();
    el.hidden = false;
    render();
    el.querySelector('[data-act="copy-edited"]').focus();
  }
  function primary() {
    onCopyEdited(state.current);
    close();
  }
  function close() { el.hidden = true; state = null; }

  el.addEventListener('click', (e) => {
    const m = e.target.closest('.diff-mode button')?.dataset.mode;
    if (m && state) { mode = m; saveMode(m); render(); return; }
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (!act || !state) return;
    if (act === 'close') close();
    if (act === 'expand') { expanded = true; render(); }
    if (act === 'copy-edited') primary();
    if (act === 'copy-original') { onCopyOriginal(state.original); close(); }
    if (act === 'mark') { onMarkOriginal(state.current); close(); }
  });
  always.addEventListener('change', () => setAlways(always.checked));
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); close(); }
    if (e.key === 'Enter' && !e.target.closest('input, button')) { e.preventDefault(); primary(); }
  });

  return { open, close, isOpen: () => !el.hidden };
}
