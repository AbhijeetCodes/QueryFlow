// Editor commands on the name under the cursor: hover card, go to definition
// (F12 or ⌘-click), find references (⇧F12, press again for the next one),
// rename (F2) and "preview this CTE" (⌘⌥Enter). Every edit is one transaction.

import { EditorView, hoverTooltip, keymap, ViewPlugin } from '@codemirror/view';
import { analyzeDoc, joinLabel } from './analyzer.js';
import { symbolAt, occurrences, renameEdits, cteAt, RENAMABLE } from './symbols.js';
import { shapeChips, clip } from './shape.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const isMac = /Mac|iPhone|iPad/.test(globalThis.navigator?.platform || '');
const MOD = isMac ? '⌘' : 'Ctrl+';
const times = (n) => (n === 1 ? 'once' : n === 2 ? 'twice' : `${n} times`);
const KIND = { cte: 'CTE', table: 'table', alias: 'alias', variable: 'variable', param: 'parameter', cteParam: 'constant' };

function lineOf(view, pos) { return view.state.doc.lineAt(pos).number; }

export function symbolFeatures({ setFocusRanges, toast = () => {}, onPreview = () => {} }) {
  const here = (view) => {
    const a = analyzeDoc(view.state.doc);
    const pos = view.state.selection.main.head;
    return { a, pos, sym: symbolAt(a, pos) };
  };
  const show = (view, r, all) => view.dispatch({
    selection: { anchor: r.from, head: r.to },
    effects: [EditorView.scrollIntoView(r.from, { y: 'center' }), ...(all ? [setFocusRanges.of(all)] : [])],
  });
  const nothing = () => { toast('Put the cursor on a CTE, table, alias, variable or @parameter'); return true; };

  function goToDefinition(view) {
    const { pos, sym } = here(view);
    if (!sym) return nothing();
    if (!sym.def) {
      toast(sym.kind === 'param'
        ? `@${sym.name} is a query parameter: its value is set in BigQuery, not in the SQL`
        : `${sym.name} is a table outside this query`);
      return findReferences(view);
    }
    if (pos >= sym.def.from && pos <= sym.def.to) {
      toast(`This is where ${sym.name} is defined. ⇧F12 steps through its ${sym.refs.length} use${sym.refs.length === 1 ? '' : 's'}`);
      return true;
    }
    show(view, sym.def, occurrences(sym));
    return true;
  }

  function findReferences(view) {
    const { pos, sym } = here(view);
    if (!sym) return nothing();
    const all = occurrences(sym);
    if (!all.length) return nothing();
    const cur = all.findIndex((r) => r.from <= pos && pos <= r.to);
    let next = cur >= 0 ? (cur + 1) % all.length : all.findIndex((r) => r.from > pos);
    if (next < 0) next = 0;
    show(view, all[next], all);
    const r = all[next];
    toast(`${sym.name}: ${next + 1} of ${all.length}${sym.def && r.from === sym.def.from ? ' (definition)' : ''} · ⇧F12 for the next`);
    return true;
  }

  function rename(view) {
    const { pos, sym } = here(view);
    if (!sym) return nothing();
    if (!RENAMABLE.has(sym.kind)) { toast(`${sym.name} is a table outside this query, so it can't be renamed here`, 'error'); return true; }
    view.plugin(renameBox)?.open(sym, pos);
    return true;
  }

  function preview(view) {
    const n = cteAt(analyzeDoc(view.state.doc), view.state.selection.main.head);
    if (!n) { toast('Put the cursor inside a CTE (or on its name) to preview it'); return true; }
    onPreview(n.id);
    return true;
  }

  // F2: a small box over the name. Enter renames every occurrence, Esc cancels.
  const renameBox = ViewPlugin.fromClass(class {
    constructor(view) {
      this.view = view;
      this.dom = document.createElement('div');
      this.dom.className = 'cm-qf-rename';
      this.dom.hidden = true;
      this.dom.innerHTML = '<input spellcheck="false" autocomplete="off" aria-label="New name"><small></small>';
      this.input = this.dom.querySelector('input');
      this.note = this.dom.querySelector('small');
      this.input.addEventListener('input', () => this.check());
      this.input.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Enter') { e.preventDefault(); this.apply(); }
        if (e.key === 'Escape') { e.preventDefault(); this.close(true); }
      });
      this.input.addEventListener('blur', () => this.close(false));
      view.dom.appendChild(this.dom);
    }
    open(sym, pos) {
      this.sym = sym;
      this.doc = this.view.state.doc;
      const all = occurrences(sym);
      const at = all.find((r) => r.from <= pos && pos <= r.to) || all[0];
      const c = this.view.coordsAtPos(at.from);
      const box = this.view.dom.getBoundingClientRect();
      if (!c) return;
      this.dom.style.left = Math.max(4, c.left - box.left - 6) + 'px';
      this.dom.style.top = c.bottom - box.top + 4 + 'px';
      this.dom.hidden = false;
      this.input.value = sym.name;
      this.check();
      this.input.focus();
      this.input.select();
    }
    check() {
      const r = renameEdits(analyzeDoc(this.doc), this.sym, this.input.value);
      const n = occurrences(this.sym).length;
      this.dom.classList.toggle('bad', !!r.error);
      this.note.textContent = r.error || `Rename ${KIND[this.sym.kind]} in ${n} place${n === 1 ? '' : 's'} · Enter · Esc`;
      return r;
    }
    apply() {
      if (this.view.state.doc !== this.doc) { this.close(true); toast('The query changed while renaming. Press F2 again.', 'error'); return; }
      const r = this.check();
      if (r.error) return;
      const old = this.sym.name;
      this.close(true);
      if (!r.changes.length) return;
      this.view.dispatch({ changes: r.changes, userEvent: 'rename' });
      toast(`Renamed ${old} → ${this.input.value.trim().replace(/^@/, '')} in ${r.changes.length} place${r.changes.length === 1 ? '' : 's'} · ⌘Z to undo`);
    }
    close(refocus) {
      if (this.dom.hidden) return;
      this.dom.hidden = true;
      if (refocus) this.view.focus();
    }
    destroy() { this.dom.remove(); }
  });

  // Hover card: what the name is, plus buttons for the commands above.
  const hover = hoverTooltip((view, pos) => {
    const a = analyzeDoc(view.state.doc);
    const sym = symbolAt(a, pos);
    if (!sym) return null;
    const all = occurrences(sym);
    const r = all.find((x) => x.from <= pos && pos <= x.to) || { from: pos, to: pos };
    return {
      pos: r.from,
      end: r.to,
      above: true,
      create: () => {
        const dom = document.createElement('div');
        dom.className = 'cm-qf-hover';
        dom.innerHTML = hoverHtml(view, a, sym);
        dom.addEventListener('mousedown', (e) => {
          const act = e.target.closest('[data-hact]')?.dataset.hact;
          if (!act) return;
          e.preventDefault();
          view.dispatch({ selection: { anchor: pos } });
          view.focus();
          ({ def: goToDefinition, refs: findReferences, rename, preview })[act](view);
        });
        return { dom };
      },
    };
  }, { hoverTime: 400, hideOnChange: true });

  function hoverHtml(view, a, sym) {
    const byId = new Map(a.graph.nodes.map((n) => [n.id, n]));
    const names = (ids) => ids.map((id) => byId.get(id)).filter((n) => n && n.kind !== 'subquery').map((n) => esc(n.label)).join(', ');
    const lines = [];
    let title = esc(sym.kind === 'param' ? '@' + sym.name : sym.name);
    if (sym.kind === 'cte' || sym.kind === 'table') {
      const n = sym.node;
      if (n.full && n.full !== n.label) lines.push(`<code>${esc(n.full)}</code>`);
      if (n.def && sym.kind === 'cte') lines.push(`Defined on line ${lineOf(view, n.def.from)}${n.isParams ? ' · one row of constants' : ''}`);
      if (n.kind === 'created') lines.push('Created by this script');
      const reads = names(n.in || []);
      if (reads) lines.push(`Reads ${reads}`);
      const chips = shapeChips(n.shape).map((c) => esc(c.text));
      if (chips.length) lines.push(chips.join(' · '));
      const feeds = names(n.out || []);
      lines.push(feeds ? `Feeds ${feeds}` : n.unused ? '<span class="warn">Not used anywhere</span>' : '');
    } else if (sym.kind === 'alias') {
      const it = sym.item;
      const target = it.nodeId && byId.get(it.nodeId);
      title += ` <span class="arrow">→</span> ${esc(target && target.kind !== 'subquery' ? target.label : it.kind === 'subquery' ? '(subquery)' : it.name)}`;
      const jl = joinLabel(it);
      if (jl) lines.push(esc(jl));
      if (it.onText && !it.onText.startsWith('USING')) lines.push(`<code>ON ${esc(clip(it.onText, 90))}</code>`);
    } else if (sym.kind === 'variable') {
      const v = sym.variable;
      lines.push(`<code>DECLARE ${esc(sym.name)}${v.type ? ' ' + esc(v.type) : ''}${v.valueText ? ' DEFAULT ' + esc(clip(v.valueText, 60)) : ''}</code>`);
    } else if (sym.kind === 'param') {
      lines.push('Query parameter: its value is set in BigQuery when the query runs');
    } else if (sym.kind === 'cteParam') {
      const cp = sym.cteParam;
      lines.push(`<code>${esc(clip(cp.value, 60))}</code> from ${esc(cp.cteLabel)}`);
      if (cp.note) lines.push(esc(cp.note));
    }
    const uses = sym.refs.length;
    lines.push(`Used ${times(uses)}`);
    const btn = (act, label, key) => `<button data-hact="${act}" title="${esc(key)}">${label}</button>`;
    const acts = [
      sym.def ? btn('def', 'Definition', `F12 or ${MOD}click`) : '',
      occurrences(sym).length > 1 ? btn('refs', `Uses (${uses})`, '⇧F12') : '',
      RENAMABLE.has(sym.kind) ? btn('rename', 'Rename', 'F2') : '',
      sym.kind === 'cte' ? btn('preview', 'Copy preview', `${MOD}⌥Enter: copies WITH … SELECT * FROM ${sym.name} LIMIT 100`) : '',
    ].join('');
    return `<div class="h-head"><span class="h-kind ${sym.kind}">${KIND[sym.kind]}</span><b>${title}</b></div>` +
      lines.filter(Boolean).map((l) => `<div class="h-line">${l}</div>`).join('') +
      (acts ? `<div class="h-acts">${acts}</div>` : '');
  }

  // ⌘-click (Ctrl-click elsewhere) a name to jump to its definition. On anything
  // else it keeps CodeMirror's meaning: add a cursor.
  const modClick = EditorView.domEventHandlers({
    mousedown(e, view) {
      if (e.button !== 0 || !(isMac ? e.metaKey : e.ctrlKey) || e.altKey || e.shiftKey) return false;
      const pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
      if (pos == null) return false;
      const sym = symbolAt(analyzeDoc(view.state.doc), pos);
      if (!sym?.def) return false;
      e.preventDefault();
      view.dispatch({ selection: { anchor: pos } });
      goToDefinition(view);
      return true;
    },
  });

  // While ⌘ / Ctrl is held, names that ⌘-click would follow are underlined.
  const modHeld = ViewPlugin.fromClass(class {
    constructor(view) {
      this.set = (on) => view.dom.classList.toggle('cm-qf-mod', on);
      this.key = (e) => this.set(isMac ? e.metaKey : e.ctrlKey);
      this.off = () => this.set(false);
      window.addEventListener('keydown', this.key);
      window.addEventListener('keyup', this.key);
      window.addEventListener('blur', this.off);
    }
    destroy() {
      window.removeEventListener('keydown', this.key);
      window.removeEventListener('keyup', this.key);
      window.removeEventListener('blur', this.off);
    }
  });

  return [
    hover,
    renameBox,
    modClick,
    modHeld,
    keymap.of([
      { key: 'F12', run: goToDefinition, preventDefault: true },
      { key: 'Shift-F12', run: findReferences, preventDefault: true },
      { key: 'F2', run: rename, preventDefault: true },
      { key: 'Mod-Alt-Enter', run: preview, preventDefault: true },
    ]),
  ];
}
