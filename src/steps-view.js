// "Steps" view: the query as a top-to-bottom recipe. One card per CTE / temp
// table / output in execution order; FROM-subqueries are nested inside the
// step that uses them, so a derived "sub table" sits right where it is used.

import { shapeChips, extraWindows, soleSource, semiPhrase, windowCard } from './shape.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const JOIN_CLASS = { FROM: 'from', INNER: 'inner', LEFT: 'left', RIGHT: 'right', FULL: 'full', CROSS: 'cross', COMMA: 'cross' };
const JOIN_TEXT = { FROM: 'FROM', INNER: 'JOIN', LEFT: 'LEFT JOIN', RIGHT: 'RIGHT JOIN', FULL: 'FULL JOIN', CROSS: 'CROSS JOIN', COMMA: ', (cross)' };
const KIND = { cte: 'CTE', created: 'table', result: 'output', subquery: 'subquery' };

function keysText(item) {
  if (!item.keys?.length) return '';
  return item.keys.map((k) => {
    const l = k.left.split('.').pop();
    const r = k.right.split('.').pop();
    return l.toLowerCase() === r.toLowerCase() ? l : `${l} = ${r}`;
  }).join(', ');
}

export function createStepsView(root, { onPick, onRange }) {
  root.addEventListener('click', (e) => {
    const win = e.target.closest('.win[data-from]');
    if (win) { onRange(+win.dataset.from, +win.dataset.to); return; }
    const t = e.target.closest('[data-node]');
    if (t) { onPick(t.dataset.node); return; }
    if (e.target.closest('[data-expand]')) {
      const all = root.querySelectorAll('.step, .nested');
      const on = [...all].some((el) => !el.classList.contains('open'));
      all.forEach((el) => el.classList.toggle('open', on));
      syncExpand();
      return;
    }
    const tog = e.target.closest('[data-toggle]');
    if (tog) { tog.closest('.step, .nested')?.classList.toggle('open'); syncExpand(); }
  });

  // One button: "Expand all" while any step is closed, else "Collapse all".
  function syncExpand() {
    const b = root.querySelector('[data-expand]');
    if (b) b.textContent = root.querySelector('.step:not(.open), .nested:not(.open)') ? 'Expand all' : 'Collapse all';
  }

  function sourceLabel(n) {
    if (!n) return '?';
    if (n.kind === 'table') return `<span class="s-sub">${esc(n.sub ? n.sub + '.' : '')}</span>${esc(n.label)}`;
    return esc(n.label);
  }

  function describe(sh) {
    if (!sh) return '';
    const rows = [];
    const code = (t) => `<code>${esc(t)}</code>`;
    if (sh.dedupe) {
      rows.push(`<li class="d-dedupe">Keeps the <b>${sh.dedupe.latest ? 'latest' : 'first'}</b> row per ${code(sh.dedupe.per)}${sh.dedupe.order ? ` (by ${code(sh.dedupe.order)})` : ''}</li>`);
    }
    if (sh.filters.length) {
      rows.push(`<li class="d-filter"><span class="dk">where</span> ${sh.filters.map(code).join(' <span class="and">and</span> ')}</li>`);
    }
    if (sh.groupBy.length || sh.aggregates.length) {
      const by = sh.groupBy.length ? `per ${sh.groupBy.map(code).join(', ')}` : 'over all rows';
      rows.push(`<li class="d-agg"><span class="dk">aggregate</span> ${by}${sh.aggregates.length ? ` <span class="muted">· ${sh.aggregates.map((a) => a.toLowerCase()).join(', ')}</span>` : ''}</li>`);
    }
    if (sh.having.length) rows.push(`<li class="d-filter"><span class="dk">having</span> ${sh.having.map(code).join(' <span class="and">and</span> ')}</li>`);
    const wins = extraWindows(sh);
    if (wins.length) rows.push(`<li class="d-window"><span class="dk">window</span><div class="wins">${wins.map((w) => windowCard(w, esc)).join('')}</div></li>`);
    if (sh.qualify.length && !(sh.dedupe && sh.dedupe.where === 'QUALIFY')) rows.push(`<li class="d-filter"><span class="dk">qualify</span> ${sh.qualify.map(code).join(' and ')}</li>`);
    if (sh.distinct) rows.push(`<li><span class="dk">distinct</span> rows</li>`);
    if (sh.branches > 1) rows.push(`<li><span class="dk">union</span> of ${sh.branches} SELECTs</li>`);
    if (sh.limit) rows.push(`<li><span class="dk">limit</span> ${code(sh.limit)}</li>`);
    rows.push(`<li class="d-cols"><span class="dk">outputs</span> ${sh.star ? `all columns${sh.columns > 1 ? ` + ${sh.columns - 1}` : ''}` : `${sh.columns} column${sh.columns === 1 ? '' : 's'}`}</li>`);
    return `<ul class="does">${rows.join('')}</ul>`;
  }

  function readsList(n, byId, depth) {
    const real = n.blocks.filter((b) => !b.inline);
    const inline = n.blocks.filter((b) => b.inline);
    const renderItem = (it) => {
      const src = it.nodeId ? byId.get(it.nodeId) : null;
      const jc = JOIN_CLASS[it.joinType] || 'from';
      const kt = keysText(it);
      const on = it.onText && !it.keys?.length ? it.onText : it.extraCond ? it.onText : '';
      let name;
      if (src && src.kind === 'subquery' && depth < 3) {
        name = renderNested(src, byId, depth + 1, it.alias);
      } else if (src) {
        name = `<button class="s-src ${src.kind}" data-node="${esc(src.id)}">${sourceLabel(src)}</button>`;
      } else {
        name = `<span class="s-src unnest">${esc(it.name)}</span>`;
      }
      return `<li class="r-item">
        <span class="jp ${jc}">${esc(it.apply ? (it.joinType === 'LEFT' ? 'OUTER APPLY' : 'CROSS APPLY') : JOIN_TEXT[it.joinType] || it.joinType)}</span>
        <div class="r-main">${name}${it.alias && !(src && src.kind === 'subquery') ? ` <span class="alias">${esc(it.alias)}</span>` : ''}
          ${kt ? `<span class="keys">on ${esc(kt)}</span>` : ''}
          ${on ? `<div class="on">${it.onText.startsWith('USING') ? '' : 'on '}${esc(on)}</div>` : ''}
        </div>
      </li>`;
    };
    let html = real.map((b, i) => `${i ? '<div class="branch">union with</div>' : ''}<ul class="reads">${b.map(renderItem).join('')}</ul>`).join('');
    if (inline.length) {
      const btn = (id) => `<button class="s-src ${byId.get(id)?.kind}" data-node="${esc(id)}">${sourceLabel(byId.get(id))}</button>`;
      const seen = new Set();
      for (const b of inline) {
        const ids = [...new Set(b.filter((it) => it.nodeId).map((it) => it.nodeId))];
        const key = b.inline.kind + b.inline.col + ids.join();
        if (!ids.length || seen.has(key)) continue;
        seen.add(key);
        const ctx = b.inline;
        let line;
        if (['IN', 'NOT IN', 'EXISTS', 'NOT EXISTS'].includes(ctx.kind)) {
          const p = semiPhrase({ ...ctx, label: '' }).long.replace(/ in $| in$/, ' in').trim();
          line = `<span class="dk semi-k">${ctx.kind.startsWith('NOT') ? 'excludes' : 'only'}</span> ${esc(p.replace(/^(keeps only|drops) /, ''))} ${ids.map(btn).join(', ')}`;
        } else {
          line = `<span class="dk">lookup</span> a value from ${ids.map(btn).join(', ')} <span class="muted">(${ctx.kind === 'ARRAY' ? 'ARRAY subquery' : 'scalar subquery'})</span>`;
        }
        html += `<div class="inline-reads">${line}</div>`;
      }
    }
    return html;
  }

  function chipsHtml(sh) {
    return shapeChips(sh).map((c) => `<span class="schip ${c.cls}" title="${esc(c.title || c.text)}">${esc(c.text)}</span>`).join('');
  }

  function renderNested(n, byId, depth, alias) {
    return `<div class="nested">
      <div class="n-head" data-toggle>
        <span class="caret">▸</span>
        <button class="s-name" data-node="${esc(n.id)}">${esc(alias || n.label)}</button>
        <span class="kind subquery">subquery</span>
        <span class="chips">${chipsHtml(n.shape)}</span>
      </div>
      <div class="n-body">${readsList(n, byId, depth)}${describe(n.shape)}</div>
    </div>`;
  }

  function update(a) {
    const nodes = a.graph.nodes;
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const steps = nodes
      .filter((n) => n.kind === 'cte' || n.kind === 'created' || n.kind === 'result')
      .filter((n) => n.kind !== 'created' || n.blocks.length)
      .sort((x, y) => (x.order ?? x.def?.from ?? 0) - (y.order ?? y.def?.from ?? 0));
    const tables = nodes.filter((n) => n.kind === 'table');
    if (!steps.length) {
      root.innerHTML = `<p class="empty steps-empty">Paste a query to see its steps.</p>`;
      return;
    }
    const open = new Set([...root.querySelectorAll('.step.open')].map((el) => el.dataset.id));
    const firstRender = !root.querySelector('.step');
    const html = steps.map((n, i) => {
      const src = soleSource(n);
      const derived = src && n.kind !== 'result';
      const used = n.out.map((id) => byId.get(id)).filter(Boolean);
      // A short query opens every step; a long one starts as a list of names.
      const isOpen = firstRender ? steps.length <= 8 : open.has(n.id);
      return `<section class="step ${n.kind}${n.unused ? ' unused' : ''}${isOpen ? ' open' : ''}" data-id="${esc(n.id)}">
        <div class="s-head" data-toggle>
          <span class="num">${i + 1}</span>
          <button class="s-name" data-node="${esc(n.id)}">${esc(n.label)}</button>
          <span class="kind ${n.kind}">${KIND[n.kind] || n.kind}${derived ? ' · derived' : ''}</span>
          <span class="chips">${chipsHtml(n.shape)}</span>
          <span class="caret">▸</span>
        </div>
        <div class="s-body">
          ${readsList(n, byId, 0)}
          ${describe(n.shape)}
          <div class="used">${n.unused ? '<span class="warn">not used anywhere</span>' : used.length ? `<span class="dk">feeds</span> ${used.map((u) => `<button class="s-src ${u.kind}" data-node="${esc(u.id)}">${esc(u.label)}</button>`).join(' ')}` : '<span class="dk">final output</span>'}</div>
        </div>
      </section>`;
    }).join('<div class="s-arrow" aria-hidden="true">↓</div>');
    const summary = `<div class="s-summary">${steps.length} step${steps.length === 1 ? '' : 's'} · ${tables.length} source table${tables.length === 1 ? '' : 's'}
      <span class="spacer"></span><button class="mini" data-expand>Expand all</button></div>`;
    root.innerHTML = summary + html;
    syncExpand();
  }

  return { update };
}
