// Right-top panel: DECLARE variables, @parameters and hardcoded filter values.
// Editing an input rewrites the SQL in place (one undoable transaction per
// keystroke burst); the panel defers re-rendering while an input has focus so
// typing is never interrupted.

import { EditorView } from '@codemirror/view';
import { focusRanges } from './editor.js';
import { fmtDay, windowText } from './shape.js';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DATETIME_RE = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?/;
const TYPES = ['STRING', 'DATE', 'DATETIME', 'TIMESTAMP', 'INT64', 'FLOAT64', 'NUMERIC', 'BOOL'];

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

function inferType(value, kind, typed) {
  if (typed) return typed;
  if (kind === 'number') return /^-?\d+$/.test(value) ? 'INT64' : 'FLOAT64';
  if (DATE_RE.test(value)) return 'DATE';
  if (DATETIME_RE.test(value)) return 'TIMESTAMP';
  return 'STRING';
}

function identFromLabel(label) {
  // "DATE(o.created_at) BETWEEN" -> created_at ; "so.country IN (…)" -> country
  const m = label.match(/([A-Za-z_][A-Za-z0-9_]*)\)?\s*(?:[=<>!]+|BETWEEN|LIKE|IN)/);
  if (m) return m[1];
  const m2 = label.match(/(?:[=<>!]+)\s*(?:[A-Za-z_]+\.)*([A-Za-z_][A-Za-z0-9_]*)/);
  if (m2) return m2[1];
  const m3 = label.match(/INTERVAL · (\w+)/);
  if (m3) return 'interval_' + m3[1].toLowerCase() + 's';
  return 'value';
}

export function createVarsPanel(root, { view, toast, onPickStep }) {
  let analysis = null;
  let stepFocus = null; // node id picked in the graph / steps view
  let pending = null;
  let rows = new Map(); // key -> { ranges, kind }
  const cycle = new Map();
  // Section titles the user collapsed; remembered across reloads.
  let collapsed = new Set();
  try { collapsed = new Set(JSON.parse(localStorage.getItem('queryflow.collapsed') || '[]')); } catch { /* private mode */ }
  const saveCollapsed = () => { try { localStorage.setItem('queryflow.collapsed', JSON.stringify([...collapsed])); } catch { /* private mode */ } };

  root.addEventListener('focusout', () => {
    setTimeout(() => {
      if (!root.contains(document.activeElement) && pending) render(pending);
    }, 0);
  });

  function update(a) {
    const ae = document.activeElement;
    if (ae && root.contains(ae) && (ae.tagName === 'INPUT' || ae.tagName === 'SELECT')) {
      pending = a;
      analysis = a;
      return;
    }
    render(a);
  }

  // Show only the filter values that live in one step (and its nested subqueries).
  function focusStep(id) {
    if (id === stepFocus) return;
    stepFocus = id;
    if (!analysis) return;
    const ae = document.activeElement;
    if (ae && root.contains(ae) && (ae.tagName === 'INPUT' || ae.tagName === 'SELECT')) { pending = analysis; return; }
    render(analysis);
    root.scrollTop = 0;
  }

  function stepSet(a, id) {
    const byId = new Map(a.graph.nodes.map((n) => [n.id, n]));
    const focus = byId.get(id);
    if (!focus) return null;
    const set = new Set([id]);
    const within = (n) => (n.spans || []).some((sp) => (focus.spans || []).some((fs) => fs.from <= sp.from && sp.to <= fs.to));
    for (const n of a.graph.nodes) if (n.kind === 'subquery' && within(n)) set.add(n.id);
    return { set, focus, byId };
  }

  function byLabel(id) {
    return analysis.graph.nodes.find((n) => n.id === id)?.label || id;
  }

  // Step names as buttons; past `max` the rest fold into "+N more" (hover lists them).
  function stepTags(owners, byId, max = 6) {
    const list = (owners || []).map((id) => byId.get(id)).filter(Boolean);
    const shown = list.length > max ? list.slice(0, max - 1) : list;
    const rest = list.slice(shown.length);
    return shown.map((n) => `<button class="step-tag ${n.kind}" data-act="pick-step" data-node="${esc(n.id)}" title="Show this step in the graph">${esc(n.label)}</button>`).join('') +
      (rest.length ? `<span class="ctx" title="${esc(rest.map((n) => n.label).join(', '))}">+${rest.length} more</span>` : '');
  }

  function taken(name) {
    const lower = name.toLowerCase();
    return analysis.tokens.some((t) => (t.t === 'ident' || t.t === 'param') && (t.name || t.s).toLowerCase() === lower);
  }

  function uniqueName(base) {
    let name = base.replace(/[^A-Za-z0-9_]/g, '_').replace(/^(\d)/, '_$1');
    let n = 2;
    const root = name;
    while (taken(name)) name = `${root}_${n++}`;
    return name;
  }

  function declareInsert(decl) {
    const a = analysis;
    if (a.insertDeclareAt >= 0) return { from: a.insertDeclareAt, insert: '\n' + decl };
    const first = a.tokens[0];
    const pos = first ? view.state.doc.lineAt(first.a).from : 0;
    return { from: pos, insert: decl + '\n\n' };
  }

  function render(a) {
    analysis = a;
    pending = null;
    const scroll = root.scrollTop;
    rows = new Map();
    const parts = [];
    const byId = new Map(a.graph.nodes.map((n) => [n.id, n]));
    const sf = stepFocus ? stepSet(a, stepFocus) : null;
    if (stepFocus && !sf) stepFocus = null;
    const inStep = (owners) => !sf || (owners || []).some((o) => sf.set.has(o));
    if (sf) {
      const count = a.literals.filter((g) => inStep(g.owners)).length;
      parts.push(`<div class="focus-bar"><span>Filters in <b class="${sf.focus.kind}">${esc(sf.focus.label)}</b> · ${count} value${count === 1 ? '' : 's'}</span><button class="mini" data-act="clear-focus">Show all</button></div>`);
    }

    // Date windows: which dates each step reads, and whether the steps agree
    const D = a.dates;
    if (D && D.steps.length) {
      const warnCount = D.issues.filter((x) => x.severity === 'warning').length;
      parts.push(section('Date windows', D.steps.length, '', warnCount
        ? `<span class="dw-status warn">⚠ ${warnCount} issue${warnCount === 1 ? '' : 's'}</span>`
        : `<span class="dw-status ok">✓ consistent</span>`));
      // Steps that read the same window and have no issue share one row; the dates
      // then cycle through each step's bound when clicked.
      const groups = [];
      const bySig = new Map();
      for (const st of D.steps) {
        const clean = !D.issues.some((x) => x.owner === st.id) && !st.mismatch.start && !st.mismatch.end && !st.mismatch.partition;
        const sig = clean && [st.event.start, st.event.end, st.partition.start, st.partition.end].map((b) => b?.day ?? '').join('|');
        if (sig && bySig.has(sig)) { bySig.get(sig).push(st); continue; }
        const g = [st];
        groups.push(g);
        if (sig) bySig.set(sig, g);
      }
      groups.forEach((g, i) => {
        const st = g[0];
        const key = 'date:' + i;
        const sides = {};
        for (const w of ['event', 'partition']) {
          for (const which of ['start', 'end']) sides[`${w}.${which}`] = g.map((x) => x[w][which]).filter(Boolean).map((b) => ({ from: b.from, to: b.to }));
        }
        rows.set(key, { focus: g.flatMap((x) => x.bounds.map((b) => ({ from: b.from, to: b.to }))), ranges: [], sides });
        const side = (w, which, isPart) => {
          const b = w[which];
          if (!b) return `<span class="dw-open">…</span>`;
          const bad = isPart ? st.mismatch.partition : st.mismatch[which];
          const src = b.src?.kind === 'literal' ? 'hardcoded' : b.src?.name || '';
          const where = g.length > 1 ? ` · click again for the next of ${g.length} steps` : '';
          return `<button class="dw-day${bad ? ' bad' : ''}" data-act="jump-side" data-side="${isPart ? 'partition' : 'event'}.${which}" title="${esc(`${b.colText} ${b.op} … · ${src}${where}`)}">${fmtDay(b.day)}</button>`;
        };
        const alignBtns = D.issues.filter((x) => x.owner === st.id && x.bound?.src?.kind === 'literal' && D.ref[x.side] !== null && D.ref[x.side] !== undefined)
          .map((x) => `<button class="mini accent" data-act="align-date" data-issue="${D.issues.indexOf(x)}" title="Change this hardcoded date to match the other steps">Align ${x.side} → ${fmtDay(D.ref[x.side])}</button>`).join('');
        const msgs = D.issues.filter((x) => x.owner === st.id).map((x) => `<div class="dw-msg ${x.severity}">${esc(x.message)}</div>`).join('');
        const hasEvent = st.event.start || st.event.end;
        const hasPart = st.partition.start || st.partition.end;
        const tags = stepTags(g.map((x) => x.id), byId, 4);
        const inFocus = !stepFocus || g.some((x) => sf && sf.set.has(x.id));
        parts.push(`
          <div class="row dw-row${inFocus ? '' : ' dim'}" data-key="${key}">
            <div class="row-main">
              ${hasEvent ? `<span class="dw-win">${side(st.event, 'start')} <span class="arrow">→</span> ${side(st.event, 'end')}</span>` : ''}
              ${hasPart ? `<span class="dw-part" title="Filter on the partition column (bytes scanned)">partition ${side(st.partition, 'start', true)} → ${side(st.partition, 'end', true)}</span>` : ''}
              <span class="dw-steps">${tags}</span>
            </div>
            ${msgs}${alignBtns ? `<div class="dw-actions">${alignBtns}</div>` : ''}
          </div>`);
      });
    }

    // Variables
    parts.push(section('Variables', a.variables.length + a.cteParams.length, a.cteParams.length ? 'DECLARE + params CTE' : 'DECLARE'));
    if (!a.variables.length && !a.cteParams.length) {
      parts.push(`<p class="empty">No <code>DECLARE</code> variables. Turn any hardcoded value below into one with <b>→ Variable</b>.</p>`);
    }
    a.variables.forEach((v, i) => {
      const key = 'var:' + i;
      rows.set(key, { ranges: v.edit ? [{ from: v.edit.from, to: v.edit.to }] : [], focus: [...v.nameToks, ...v.refs] });
      parts.push(`
        <div class="row${inStep(v.owners) ? '' : ' dim'}" data-key="${key}">
          <div class="row-main">
            <button class="name var" data-act="jump" title="Jump to uses">${esc(v.names.join(', '))}</button>
            <span class="meta">${esc(v.type || 'inferred')} · ${plural(v.refs.length, 'use')}</span>
          </div>
          ${v.edit ? valueInput(key, v.value, v.edit.kind, v.edit.wrap) : '<span class="meta">no DEFAULT value</span>'}
          ${v.owners?.length ? `<div class="ctxs"><span class="used-in">used in</span>${stepTags(v.owners, byId)}</div>` : ''}
        </div>`);
    });

    // Values defined in a params CTE:  params AS (SELECT DATE '2024-01-01' AS start_date, …)
    a.cteParams.forEach((cp, i) => {
      const key = 'cteparam:' + i;
      rows.set(key, { ranges: [{ from: cp.edit.from, to: cp.edit.to }], focus: [cp.def, ...cp.refs] });
      parts.push(`
        <div class="row${inStep(cp.owners) ? '' : ' dim'}" data-key="${key}">
          <div class="row-main">
            <button class="name var" data-act="jump" title="Jump to uses"><span class="cp-cte">${esc(cp.cteLabel)}.</span>${esc(cp.name)}</button>
            <span class="meta">CTE value · ${plural(cp.refs.length, 'use')}</span>
          </div>
          ${cp.note ? `<div class="cp-note" title="Comment next to this value in the SQL">-- ${esc(cp.note)}</div>` : ''}
          ${valueInput(key, cp.value, cp.edit.kind, cp.edit.wrap, cp.edit.fn)}
          <div class="ctxs"><span class="used-in">defined in</span>${stepTags([cp.cte], byId)}</div>
        </div>`);
    });

    // Parameters
    if (a.params.length) {
      parts.push(section('Query parameters', a.params.length, '@name'));
      a.params.forEach((p, i) => {
        const key = 'param:' + i;
        rows.set(key, { param: p, focus: p.refs });
        parts.push(`
          <div class="row${inStep(p.owners) ? '' : ' dim'}" data-key="${key}">
            <div class="row-main">
              <button class="name param" data-act="jump" title="Jump to uses">@${esc(p.name)}</button>
              <span class="meta">${plural(p.refs.length, 'use')} · not defined in the query</span>
              <button class="mini" data-act="promote-open">→ Variable</button>
            </div>
            ${p.owners?.length ? `<div class="ctxs"><span class="used-in">used in</span>${stepTags(p.owners, byId)}</div>` : ''}
            <div class="promote" hidden></div>
          </div>`);
      });
    }

    // Literals
    const shown = a.literals.filter((g) => inStep(g.owners)).length;
    parts.push(section('Hardcoded filter values', sf ? `${shown} / ${a.literals.length}` : a.literals.length, 'in WHERE / ON / IN / INTERVAL',
      a.literals.length ? `<button class="mini accent" data-act="promote-all" title="Turn every hardcoded value in the query into a DECLARE variable (one undo step)">→ All to variables</button>` : ''));
    if (!a.literals.length) {
      parts.push(`<p class="empty">No hardcoded values found in filters.</p>`);
    } else if (!shown) {
      parts.push(`<p class="empty">No hardcoded values in <b>${esc(sf.focus.label)}</b>.</p>`);
    }
    a.literals.forEach((g, i) => {
      if (!inStep(g.owners)) return;
      const key = 'lit:' + i;
      rows.set(key, { ranges: g.occ.map((o) => ({ ...o.edit })), group: g, focus: g.occ });
      const labels = g.labels.slice(0, 3).map((l) => `<span class="ctx">${esc(l)}</span>`).join('') +
        (g.labels.length > 3 ? `<span class="ctx">+${g.labels.length - 3}</span>` : '');
      parts.push(`
        <div class="row" data-key="${key}">
          <div class="row-main">
            ${valueInput(key, g.value, g.kind, g.occ[0].typed)}
            <button class="count" data-act="jump" title="Jump to uses">×${g.occ.length}</button>
            ${g.sameAsVar ? `<button class="mini accent" data-act="use-var" title="Replace with the variable that already holds this value">Use ${esc(g.sameAsVar)}</button>` : ''}
            <button class="mini" data-act="promote-open">→ Variable</button>
          </div>
          <div class="ctxs">${stepTags(g.owners, byId)}${labels}</div>
          <div class="promote" hidden></div>
        </div>`);
    });

    // Each section header owns everything up to the next one, so it can fold it away.
    let html = '';
    let open = false;
    for (const p of parts) {
      const title = /^<div class="section[^"]*" data-sec="([^"]*)"/.exec(p)?.[1];
      if (title === undefined) { html += p; continue; }
      if (open) html += '</div>';
      html += p + `<div class="sec-body"${collapsed.has(title) ? ' hidden' : ''}>`;
      open = true;
    }
    root.innerHTML = html + (open ? '</div>' : '');
    root.scrollTop = scroll;
  }

  function section(title, n, hint, action = '') {
    const shut = collapsed.has(title);
    return `<div class="section${shut ? ' shut' : ''}" data-sec="${esc(title)}"><h3><button class="sec-toggle" data-act="toggle-sec" aria-expanded="${!shut}" title="${shut ? 'Show' : 'Hide'} this section"><span class="sec-caret" aria-hidden="true">▾</span>${esc(title)} <span class="badge">${n}</span></button></h3>${action || `<span class="hint">${esc(hint)}</span>`}</div>`;
  }

  // One click: every hardcoded filter value becomes a DECLARE variable.
  //  - IN ('a', 'b') lists of literals -> ARRAY variable, used as IN UNNEST(v)
  //  - a value that equals an existing variable -> that variable is reused
  //  - everything else -> DECLARE v_<column>[_from|_to|_min|_max] TYPE DEFAULT <literal>
  function promoteAll() {
    const a = analysis;
    const used = new Set();
    const unique = (base) => {
      const root = base.replace(/[^A-Za-z0-9_]/g, '_').replace(/_+/g, '_').replace(/^(\d)/, '_$1');
      let name = root;
      let n = 2;
      while (taken(name) || used.has(name.toLowerCase())) name = `${root}_${n++}`;
      used.add(name.toLowerCase());
      return name;
    };
    const nameFor = (label, kind) => {
      let base = 'v_' + identFromLabel(label).toLowerCase();
      if (/BETWEEN \(end\)$/.test(label)) base += '_to';
      else if (/BETWEEN$/.test(label)) base += '_from';
      else if (/(>=|>)$/.test(label) || /^(<=|<)\s/.test(label)) base += kind === 'number' ? '_min' : '_from';
      else if (/(<=|<)$/.test(label) || /^(>=|>)\s/.test(label)) base += kind === 'number' ? '_max' : '_to';
      return base;
    };
    const inside = (pos) => a.inLists.some((l) => l.from <= pos && pos < l.to);
    const decls = [];
    const changes = [];
    let reused = 0;
    let replaced = 0;

    for (const l of a.inLists) {
      const type = inferType(l.sample, l.kind, l.typed);
      const name = unique(`v_${identFromLabel(l.label).toLowerCase()}_list`);
      decls.push(`DECLARE ${name} ARRAY<${type}> DEFAULT [${l.items.join(', ')}];`);
      changes.push({ from: l.from, to: l.to, insert: `UNNEST(${name})` });
      replaced += l.items.length;
    }
    for (const g of a.literals) {
      const occ = g.occ.filter((o) => !inside(o.from));
      if (!occ.length) continue;
      replaced += occ.length;
      if (g.sameAsVar) {
        for (const o of occ) changes.push({ from: o.from, to: o.to, insert: g.sameAsVar });
        reused++;
        continue;
      }
      const typedOcc = occ.find((o) => o.typed);
      const type = inferType(g.value, g.kind, typedOcc?.typed);
      const name = unique(nameFor(occ[0].label, g.kind));
      decls.push(`DECLARE ${name} ${type} DEFAULT ${typedOcc ? typedOcc.text : occ[0].text};`);
      for (const o of occ) changes.push({ from: o.from, to: o.to, insert: name });
    }
    if (!changes.length) { toast('Nothing to convert'); return; }
    if (decls.length) changes.push(declareInsert(decls.join('\n')));
    document.activeElement?.blur();
    stepFocus = null;
    view.dispatch({ changes, userEvent: 'input.lens' });
    const parts = [`${decls.length} variable${decls.length === 1 ? '' : 's'} created`];
    if (reused) parts.push(`${reused} reused`);
    toast(`${parts.join(', ')} · ${replaced} value${replaced === 1 ? '' : 's'} replaced · ⌘Z to undo`);
  }

  function valueInput(key, value, kind, wrap, fn) {
    const isDate = kind === 'string' && DATE_RE.test(value);
    const pre = kind === 'string' ? `${fn ? fn + '(' : wrap ? wrap + ' ' : ''}'` : '';
    const post = kind === 'string' ? `'${fn ? ')' : ''}` : '';
    return `<label class="val ${kind}">
      ${pre ? `<span class="q">${esc(pre)}</span>` : ''}
      <input type="text" data-key="${key}" value="${esc(value)}" spellcheck="false" autocomplete="off"
        ${kind === 'expr' ? 'title="Expression — edited as raw SQL"' : ''}/>
      ${post ? `<span class="q">${post}</span>` : ''}
      ${isDate ? `<button type="button" class="cal" data-act="pick-date" title="Pick a date" tabindex="-1">
        <svg width="13" height="13" viewBox="0 0 16 16" aria-hidden="true"><rect x="1.5" y="2.5" width="13" height="12" rx="2" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M1.5 6.5h13M5 1v3M11 1v3" stroke="currentColor" stroke-width="1.4"/></svg>
      </button><input type="date" class="cal-input" tabindex="-1" aria-hidden="true"/>` : ''}
    </label>`;
  }

  // ---- editing ----------------------------------------------------------
  root.addEventListener('input', (e) => {
    const input = e.target;
    if (input.tagName !== 'INPUT' || !input.dataset.key) return;
    const row = rows.get(input.dataset.key);
    if (!row || !row.ranges?.length) return;
    const value = input.value;
    const tr = view.state.update({
      changes: row.ranges.map((r) => ({ from: r.from, to: r.to, insert: value })),
      userEvent: 'input.lens',
    });
    view.dispatch(tr);
    row.ranges = row.ranges.map((r) => ({ from: tr.changes.mapPos(r.from, -1), to: tr.changes.mapPos(r.to, 1) }));
    focusRanges(view, row.ranges, { scroll: false });
  });

  root.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.tagName === 'INPUT') {
      e.preventDefault();
      if (e.target.closest('.promote')) {
        e.target.closest('.promote').querySelector('[data-act="promote"]')?.click();
      } else {
        e.target.blur();
      }
    }
  });

  // ---- hover highlights -------------------------------------------------
  root.addEventListener('mouseover', (e) => {
    const rowEl = e.target.closest('.row');
    if (!rowEl || rowEl === root._hover) return;
    root._hover = rowEl;
    const row = rows.get(rowEl.dataset.key);
    if (row) focusRanges(view, row.focus || row.ranges || [], { scroll: false });
  });
  root.addEventListener('mouseleave', () => {
    root._hover = null;
    focusRanges(view, [], { scroll: false });
  });

  // ---- actions ----------------------------------------------------------
  root.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    if (btn.dataset.act === 'pick-step') { onPickStep?.(btn.dataset.node); return; }
    if (btn.dataset.act === 'toggle-sec') {
      const head = btn.closest('.section');
      const title = head.dataset.sec;
      const shut = !collapsed.has(title);
      if (shut) collapsed.add(title); else collapsed.delete(title);
      saveCollapsed();
      head.classList.toggle('shut', shut);
      head.nextElementSibling.hidden = shut;
      btn.setAttribute('aria-expanded', String(!shut));
      btn.title = `${shut ? 'Show' : 'Hide'} this section`;
      return;
    }
    if (btn.dataset.act === 'promote-all') { promoteAll(); return; }
    if (btn.dataset.act === 'align-date') {
      const x = analysis.dates.issues[+btn.dataset.issue];
      const b = x?.bound;
      const refDay = analysis.dates.ref[x?.side];
      if (!b || refDay === null || refDay === undefined || b.src?.kind !== 'literal') return;
      // Keep the operator's meaning: "> X" needs X = day before, "< X" the day after.
      const day = b.op === '>' ? refDay - 1 : b.op === '<' ? refDay + 1 : refDay;
      const iso = fmtDay(day);
      const text = b.fmt === 'compact' ? iso.replace(/-/g, '') : iso;
      document.activeElement?.blur();
      view.dispatch({ changes: { from: b.src.edit.from, to: b.src.edit.to, insert: text }, userEvent: 'input.lens' });
      toast(`Aligned ${x.side} of ${byLabel(x.owner)} to ${fmtDay(refDay)} · ⌘Z to undo`);
      return;
    }
    if (btn.dataset.act === 'clear-focus') { onPickStep?.(null); focusStep(null); return; }
    const rowEl = btn.closest('.row');
    const key = rowEl?.dataset.key;
    const row = rows.get(key);
    if (!row) return;
    const act = btn.dataset.act;

    if (act === 'pick-date') {
      e.preventDefault();
      const text = btn.parentElement.querySelector('input[data-key]');
      const picker = btn.parentElement.querySelector('.cal-input');
      picker.value = DATE_RE.test(text.value) ? text.value : '';
      picker.onchange = () => {
        if (!picker.value) return;
        text.value = picker.value;
        text.dispatchEvent(new Event('input', { bubbles: true }));
        text.focus();
      };
      try { picker.showPicker(); } catch { picker.focus(); }
      return;
    }

    if (act === 'jump' || act === 'jump-side') {
      const list = (act === 'jump' ? row.focus : row.sides?.[btn.dataset.side]) || [];
      if (!list.length) return;
      const ck = act === 'jump' ? key : key + ':' + btn.dataset.side;
      const idx = ((cycle.get(ck) ?? -1) + 1) % list.length;
      cycle.set(ck, idx);
      focusRanges(view, list, { scroll: false });
      view.dispatch({ selection: { anchor: list[idx].from, head: list[idx].to }, effects: EditorView.scrollIntoView(list[idx].from, { y: 'center' }) });
      view.focus();
    }

    if (act === 'use-var') {
      document.activeElement?.blur();
      const g = row.group;
      view.dispatch({
        changes: g.occ.map((o) => ({ from: o.from, to: o.to, insert: g.sameAsVar })),
        userEvent: 'input.lens',
      });
      toast(`Replaced ${plural(g.occ.length, 'value')} with ${g.sameAsVar}`);
    }

    if (act === 'promote-cancel') { rowEl.querySelector('.promote').hidden = true; return; }

    if (act === 'promote-open') {
      const box = rowEl.querySelector('.promote');
      if (!box.hidden) { box.hidden = true; return; }
      let name, type, value;
      if (row.param) {
        const n = row.param.name;
        name = taken(n) && analysis.tokens.filter((t) => t.t === 'ident' && t.s.toLowerCase() === n.toLowerCase()).length ? uniqueName('v_' + n) : n;
        type = 'STRING';
        value = '';
      } else {
        const g = row.group;
        name = uniqueName('v_' + identFromLabel(g.labels[0]).toLowerCase());
        type = inferType(g.value, g.kind, g.occ.find((o) => o.typed)?.typed);
        value = null;
      }
      box.innerHTML = `
        <input class="p-name" value="${esc(name)}" spellcheck="false" title="Variable name"/>
        <select class="p-type" title="BigQuery type">${TYPES.map((t) => `<option${t === type ? ' selected' : ''}>${t}</option>`).join('')}</select>
        ${value !== null ? `<input class="p-value" placeholder="default value, e.g. 'SG'" spellcheck="false" title="DEFAULT value (SQL literal)"/>` : ''}
        <button class="mini accent" data-act="promote">Create</button>
        <button class="mini" data-act="promote-cancel" title="Esc">Cancel</button>
        <p class="p-hint">Adds <code>DECLARE</code> at the top and replaces ${row.param ? `every @${esc(row.param.name)}` : `all ${row.group.occ.length} occurrence${row.group.occ.length > 1 ? 's' : ''}`}. Match the column's type: BigQuery will not convert a STRING variable to DATE.</p>`;
      box.hidden = false;
      box.querySelector(row.param ? '.p-value' : '.p-name').focus();
    }

    if (act === 'promote') {
      const box = rowEl.querySelector('.promote');
      const name = box.querySelector('.p-name').value.trim();
      const type = box.querySelector('.p-type').value;
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) { toast('Variable names use letters, digits and _ only', 'error'); return; }
      if (analysis.variables.some((v) => v.names.some((n) => n.toLowerCase() === name.toLowerCase()))) { toast(`"${name}" is already declared`, 'error'); return; }
      let def, replaced;
      const changes = [];
      if (row.param) {
        let raw = box.querySelector('.p-value').value.trim();
        if (!raw) { toast('Give the variable a default value', 'error'); return; }
        if (['STRING', 'DATE', 'DATETIME', 'TIMESTAMP'].includes(type) && !/^['"]/.test(raw) && !/^[A-Z_]+\s*\(/i.test(raw)) raw = `'${raw.replace(/'/g, "\\'")}'`;
        def = raw;
        for (const r of row.param.refs) changes.push({ from: r.from, to: r.to, insert: name });
        replaced = row.param.refs.length;
      } else {
        const g = row.group;
        const typedOcc = g.occ.find((o) => o.typed);
        def = typedOcc ? typedOcc.text : g.occ[0].text;
        for (const o of g.occ) changes.push({ from: o.from, to: o.to, insert: name });
        replaced = g.occ.length;
      }
      changes.push(declareInsert(`DECLARE ${name} ${type} DEFAULT ${def};`));
      document.activeElement?.blur();
      view.dispatch({ changes, userEvent: 'input.lens' });
      toast(`Created ${name} and replaced ${plural(replaced, 'occurrence')}`);
    }
  });

  // Esc closes an open "→ Variable" form.
  root.addEventListener('keydown', (e) => {
    const box = e.target.closest?.('.promote');
    if (e.key === 'Escape' && box) { box.hidden = true; box.closest('.row')?.querySelector('[data-act="promote-open"]')?.focus(); }
  });

  // Opens the "→ Variable" form of a query parameter (from Results' "Make @x a variable").
  function openParam(name) {
    if (stepFocus) { onPickStep?.(null); focusStep(null); }
    const i = analysis?.params.findIndex((p) => '@' + p.name.toLowerCase() === name.toLowerCase().replace(/^@?/, '@'));
    const rowEl = i >= 0 && root.querySelector(`[data-key="param:${i}"]`);
    if (!rowEl) return;
    const body = rowEl.closest('.sec-body');
    if (body?.hidden) body.previousElementSibling.querySelector('[data-act="toggle-sec"]').click();
    rowEl.scrollIntoView({ block: 'nearest' });
    if (rowEl.querySelector('.promote').hidden) rowEl.querySelector('[data-act="promote-open"]').click();
  }

  return { update, focusStep, openParam };
}
