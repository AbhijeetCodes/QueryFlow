// Right-bottom panel: lineage/join graph (dagre layout, SVG) + table list.
import { joinLabel } from './analyzer.js';
import { layoutGraph, edgeKey } from './graph-layout.js';
import { shapeChips, soleSource, extraWindows, windowCard } from './shape.js';
import { createStepsView } from './steps-view.js';
import { EditorView } from '@codemirror/view';
import { focusRanges } from './editor.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const JOIN_CLASS = { FROM: 'from', INNER: 'inner', LEFT: 'left', RIGHT: 'right', FULL: 'full', CROSS: 'cross', COMMA: 'cross' };
const KIND_LABEL = { table: 'table', cte: 'CTE', subquery: 'subquery', result: 'output', created: 'output' };

let measureCtx;
function textWidth(s, font) {
  measureCtx ??= document.createElement('canvas').getContext('2d');
  measureCtx.font = font;
  return measureCtx.measureText(s).width;
}

function edgeClass(e) {
  const types = new Set(e.joins.map((j) => j.joinType));
  if (types.size === 1) return JOIN_CLASS[[...types][0]] || 'from';
  for (const t of ['CROSS', 'COMMA', 'FULL', 'LEFT', 'RIGHT', 'INNER']) if (types.has(t)) return JOIN_CLASS[t];
  return 'from';
}

function semiEdgeText(e) {
  if (e.role === 'params') return 'constants';
  const j = e.joins[0].inline;
  return `${j.kind}${j.col ? ' · ' + j.col : ''}`;
}

function edgeText(e) {
  const labels = [...new Set(e.joins.map(joinLabel).filter(Boolean))];
  // The first read of a self-joined table: name its alias, the other reads have their own boxes.
  if (!labels.length && e.selfJoin?.alias) labels.push('as ' + e.selfJoin.alias);
  const s = labels.join(' + ');
  return s.length > 34 ? s.slice(0, 33) + '…' : s;
}

// Second label line: the table(s) the join attaches to ("with employees"), from the
// aliases its ON names. A self-joined partner gets its alias: "with employees (e)".
function edgeWith(e, byId) {
  const owner = byId.get(e.to);
  const names = new Set();
  for (const j of e.joins) {
    for (const p of j.partners || []) {
      const block = owner?.blocks.find((b) => b.includes(p));
      const twice = p.nodeId && block && block.filter((x) => x.nodeId === p.nodeId).length > 1;
      const name = (p.nodeId && byId.get(p.nodeId)?.label) || p.alias || (p.name || '').split('.').pop();
      names.add(twice && p.alias ? `${name} (${p.alias})` : name);
    }
  }
  if (!names.size) return '';
  const s = 'with ' + [...names].join(', ');
  return s.length > 34 ? s.slice(0, 33) + '…' : s;
}

function smoothPath(pts) {
  if (pts.length < 2) return '';
  let d = `M${pts[0].x},${pts[0].y}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const mx = (pts[i].x + pts[i + 1].x) / 2;
    const my = (pts[i].y + pts[i + 1].y) / 2;
    d += ` Q${pts[i].x},${pts[i].y} ${mx},${my}`;
  }
  const l = pts[pts.length - 1];
  d += ` L${l.x},${l.y}`;
  return d;
}

const CHIP_ROW = 19;
const CHIP_FONT = '600 10px Inter, system-ui, sans-serif';
const LABEL_FONT = '600 12.5px Inter, system-ui, sans-serif';
const SUB_FONT = '10.5px Inter, system-ui, sans-serif';
const MAX_NODE_W = 290;

// A step that reads the same table or CTE twice in one FROM clause (a self-join) would
// otherwise get one merged edge that shows only the last join. Draw every extra read as
// an alias box of its own, with its own edge and join keys. Display only: the alias box
// stands for the same node (data-id), so selection, hover and lineage treat them as one.
function splitSelfJoins(nodes, edges) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const ghosts = [];
  const out = [];
  for (const e of edges) {
    const owner = byId.get(e.to);
    const real = e.role === 'filter' || e.role === 'params' ? [] : e.joins.filter((j) => !j.inline && !j.params);
    const extra = new Set();
    for (const block of owner?.blocks || []) {
      const mine = real.filter((j) => block.includes(j));
      for (const j of mine.slice(1)) extra.add(j);
    }
    if (!extra.size) { out.push(e); continue; }
    const src = byId.get(e.from);
    const keep = e.joins.filter((j) => !extra.has(j));
    out.push({ ...e, joins: keep, selfJoin: keep.find((j) => real.includes(j)) });
    let i = 0;
    for (const j of extra) {
      const id = `${e.from}@${e.to}#${++i}`;
      ghosts.push({ ...src, id, ref: src.id, ghost: j, in: [], out: [e.to], unused: false });
      out.push({ ...e, id: `${id}→${e.to}`, from: id, fromRef: src.id, joins: [j], role: 'data' });
    }
  }
  return { nodes: ghosts.length ? [...nodes, ...ghosts] : nodes, edges: out };
}

function isDerivation(e, byId) {
  const to = byId.get(e.to);
  return !!to && ['cte', 'subquery', 'created'].includes(to.kind) && soleSource(to) === e.from;
}

// Sizes, subtitle and chip placement for one node.
function decorate(n, byId) {
  if (n.ghost) {
    const sub = `self-join${n.ghost.alias ? ' · as ' + n.ghost.alias : ''}`;
    const width = Math.min(MAX_NODE_W, Math.max(textWidth(n.label, LABEL_FONT), textWidth(sub, SUB_FONT)) + 28);
    return { sub, derived: false, chipRows: [], chipTop: 41, width, height: 42 };
  }
  const src = soleSource(n);
  let sub = n.sub || '';
  const derived = !!src && ['cte', 'subquery', 'created'].includes(n.kind);
  if (n.kind === 'cte' || n.kind === 'subquery' || n.kind === 'result' || n.kind === 'created') {
    const real = n.blocks.filter((b) => !b.inline);
    const count = real.reduce((s, b) => s + b.filter((i) => (i.nodeId || i.kind === 'unnest') && !i.params).length, 0);
    const union = (n.shape?.branches || 1) > 1;
    const role = derived ? `from ${byId.get(src)?.label || '?'}`
      : union ? `union of ${n.shape.branches}`
      : count > 1 ? `joins ${count} inputs` : '';
    if (n.kind === 'created') sub = [n.sub, role].filter(Boolean).join(' · ');
    else if (n.kind === 'subquery') sub = role ? `subquery · ${role}` : 'subquery';
    else sub = role;
  }
  if (n.isParams) sub = `constants · ${n.shape.columns} value${n.shape.columns === 1 ? '' : 's'}`;
  sub = sub.length > 40 ? '…' + sub.slice(-39) : sub;
  const chips = shapeChips(n.shape).map((c) => ({ ...c, w: Math.ceil(textWidth(c.text, CHIP_FONT)) + 12 }));
  const inner = MAX_NODE_W - 28;
  const rows = [];
  let row = [];
  let x = 0;
  for (const c of chips) {
    if (row.length && x + c.w > inner) { rows.push(row); row = []; x = 0; }
    row.push({ ...c, x });
    x += c.w + 4;
  }
  if (row.length) rows.push(row);
  const chipsW = Math.max(0, ...rows.map((r) => r.reduce((s, c) => s + c.w + 4, -4)));
  const width = Math.min(MAX_NODE_W, Math.max(textWidth(n.label, LABEL_FONT), sub ? textWidth(sub, SUB_FONT) : 0, chipsW) + 28);
  const chipTop = sub ? 41 : 28;
  const height = rows.length ? chipTop + rows.length * CHIP_ROW + 3 : sub ? 42 : 30;
  return { sub, derived, chipRows: rows, chipTop, width, height };
}

// Graphs up to this many boxes lay out on the page in a few ms; bigger ones go to
// a worker per direction, so "auto" (which tries both) costs one layout of wall time.
const SYNC_MAX_NODES = 40;
const workers = {}; // dir -> { w, busy } | null when workers are unavailable (e.g. dist/ opened from file://)

function startWorker() {
  try {
    return { w: new Worker(new URL('./graph-layout.worker.js', import.meta.url), { type: 'module' }), busy: null };
  } catch {
    return null;
  }
}

function layoutInWorker(input) {
  if (workers[input.dir] === undefined) workers[input.dir] = startWorker();
  let slot = workers[input.dir];
  if (!slot) return Promise.resolve(layoutGraph(input));
  // A newer request replaces one still running: restart the worker rather than wait for stale work.
  if (slot.busy) {
    slot.w.terminate();
    slot.busy.cancel();
    slot = workers[input.dir] = startWorker();
    if (!slot) return Promise.resolve(layoutGraph(input));
  }
  return new Promise((resolve, reject) => {
    const { w } = slot;
    const done = () => { w.onmessage = w.onerror = null; slot.busy = null; };
    slot.busy = { cancel: () => { done(); reject(new Error('superseded')); } };
    w.onmessage = (e) => { done(); if (e.data.error) reject(new Error(e.data.error)); else resolve(e.data.result); };
    // The worker script failed to load: lay out here from now on.
    w.onerror = (e) => { e.preventDefault(); done(); workers[input.dir] = null; resolve(layoutGraph(input)); };
    w.postMessage({ input });
  });
}

// Recent layouts by input, so undo/redo, toggling links or direction, and re-opening the tab are instant.
const layoutCache = new Map();
function cached(input) {
  const key = JSON.stringify(input);
  const hit = layoutCache.get(key);
  if (hit) { layoutCache.delete(key); layoutCache.set(key, hit); }
  return { key, hit };
}
function remember(key, result) {
  layoutCache.set(key, result);
  if (layoutCache.size > 8) layoutCache.delete(layoutCache.keys().next().value);
  return result;
}

function inlineHeading(ctx) {
  return {
    IN: `subquery filter: ${ctx.col || '…'} IN (…)`, 'NOT IN': `subquery filter: ${ctx.col || '…'} NOT IN (…)`,
    EXISTS: 'subquery filter: EXISTS (…)', 'NOT EXISTS': 'subquery filter: NOT EXISTS (…)',
    ARRAY: 'ARRAY (subquery)',
  }[ctx.kind] || 'scalar subquery';
}

// Everything upstream and downstream of one node.
function lineageOf(id, nodes) {
  const byId = new Map(nodes.map((x) => [x.id, x]));
  const set = new Set([id]);
  for (const dir of ['in', 'out']) {
    const stack = [id];
    while (stack.length) {
      const cur = byId.get(stack.pop());
      for (const nx of cur?.[dir] || []) if (!set.has(nx)) { set.add(nx); stack.push(nx); }
    }
  }
  return set;
}

export function createGraphPanel(root, { view, onSelect, onPreview, onRunTab, onRun, onTab }) {
  root.innerHTML = `
    <div class="graph-head">
      <div class="tabs" role="tablist">
        <button class="tab" data-tab="steps" role="tab" title="The query as a readable top-to-bottom recipe">Steps</button>
        <button class="tab" data-tab="graph" role="tab" title="Lineage / join graph">Graph</button>
        <button class="tab" data-tab="tables" role="tab">Tables <span class="badge" data-count="tables">0</span></button>
        <button class="tab" data-tab="run" role="tab" title="Run the query on small test tables, here in the browser (⌘Enter)">Run</button>
      </div>
      <div class="graph-tools">
        <button class="mini" data-act="links" title="IN / EXISTS subquery filters and reads of a params (constants) CTE. Hidden, they show as 'in X' / 'uses X' chips on the node; shown, they are dotted edges."></button>
        <button class="mini" data-act="dir" title="Layout direction: auto picks whichever fits the panel best">Auto</button>
        <span class="zoom-group" role="group" aria-label="Zoom">
          <button class="icon-btn sm" data-act="zoom-out" title="Zoom out (−)" aria-label="Zoom out">−</button>
          <button class="zoom-pct" data-act="zoom-reset" title="Reset to 100% (1)">100%</button>
          <button class="icon-btn sm" data-act="zoom-in" title="Zoom in (+)" aria-label="Zoom in">+</button>
        </span>
        <button class="icon-btn sm" data-act="fit" title="Fit to view (0)" aria-label="Fit to view">⤢</button>
      </div>
    </div>
    <div class="graph-body">
      <div class="graph-view">
        <svg class="graph-svg" xmlns="http://www.w3.org/2000/svg" tabindex="-1">
          <defs>${['from', 'inner', 'left', 'right', 'full', 'cross', 'derive', 'semi'].map((c) =>
            `<marker id="arrow-${c}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,1 L9,5 L0,9 z" class="arrow ${c}"/></marker>`).join('')}
          </defs>
          <g class="viewport"></g>
        </svg>
        <div class="iso-bar" hidden><span>Lineage of <b></b></span><button class="mini" data-act="show-all">Show all</button></div>
        <div class="graph-empty" hidden>Paste a query: tables, CTEs and joins show up here.</div>
        <div class="graph-busy" aria-live="polite"></div>
        <div class="legend">
          <span><i class="lg derive"></i>derived</span><span><i class="lg semi"></i>IN filter / constants</span><span><i class="lg from"></i>FROM</span><span><i class="lg inner"></i>INNER</span><span><i class="lg left"></i>LEFT</span>
          <span><i class="lg right"></i>RIGHT</span><span><i class="lg full"></i>FULL</span><span><i class="lg cross"></i>CROSS</span>
          <span class="sep"></span>
          <span><b class="nk table"></b>table</span><span><b class="nk cte"></b>CTE</span><span><b class="nk result"></b>output</span>
          <span class="sep"></span>
          <span class="hint-tip">Hover a chip or click a node for details · pinch or wheel to zoom, double-click to zoom in</span>
        </div>
        <div class="detail" hidden></div>
      </div>
      <div class="tables-view" hidden></div>
      <div class="steps-view" hidden></div>
      <div class="run-view" hidden></div>
    </div>`;

  const svg = root.querySelector('.graph-svg');
  const vp = root.querySelector('.viewport');
  // The legend scrolls sideways in a narrow panel; fade its right edge while more is hidden.
  const legend = root.querySelector('.legend');
  const syncLegend = () => legend.classList.toggle('more', legend.scrollLeft + legend.clientWidth < legend.scrollWidth - 2);
  legend.addEventListener('scroll', syncLegend, { passive: true });
  new ResizeObserver(syncLegend).observe(legend);
  const detail = root.querySelector('.detail');
  const empty = root.querySelector('.graph-empty');
  const tablesView = root.querySelector('.tables-view');
  const graphView = root.querySelector('.graph-view');
  const busyEl = root.querySelector('.graph-busy');
  let analysis = null;
  let layout = null;
  let signature = '';
  let graphStale = false; // an update arrived while the Graph tab was hidden
  let layoutJob = 0; // bumped per layout request; an older result that arrives late is dropped
  let selected = null;
  let tf = { x: 0, y: 0, k: 1 };
  let direction = 'auto';
  let isolate = null; // node id whose lineage is shown alone
  let showFilterLinks = false; // draw IN / EXISTS subquery links as dotted edges
  try { showFilterLinks = localStorage.getItem('queryflow.filterLinks') === '1'; } catch { /* ignore */ }
  try { direction = localStorage.getItem('queryflow.graphDir') || 'auto'; } catch { /* ignore */ }
  const refCycle = new Map();

  const MIN_K = 0.1;
  const MAX_K = 4;
  const zoomPct = root.querySelector('.zoom-pct');
  let userMoved = false; // the view was zoomed or panned by hand since the last fit
  let raf = 0;
  let anim = 0;
  // Coalesce transform writes to one per frame: wheel and pinch fire faster than the screen repaints.
  const applyTf = () => {
    if (![tf.x, tf.y, tf.k].every(Number.isFinite)) tf = { x: 0, y: 0, k: 1 };
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      vp.setAttribute('transform', `translate(${tf.x},${tf.y}) scale(${tf.k})`);
      zoomPct.textContent = `${Math.round(tf.k * 100)}%`;
    });
  };

  // Ease the view to a target transform (buttons, keys, double-click, fit).
  let target = null; // where a running animation is heading
  function stopAnim() { cancelAnimationFrame(anim); target = null; }
  function animateTo(to, ms = 180) {
    stopAnim();
    target = to;
    const from = { ...tf };
    const t0 = performance.now();
    const step = (now) => {
      const t = Math.min(1, (now - t0) / ms);
      const e = 1 - (1 - t) ** 3;
      tf = { x: from.x + (to.x - from.x) * e, y: from.y + (to.y - from.y) * e, k: from.k + (to.k - from.k) * e };
      applyTf();
      if (t < 1) anim = requestAnimationFrame(step); else target = null;
    };
    anim = requestAnimationFrame(step);
  }
  // Repeated clicks or key presses mid-animation stack on its destination instead of restarting from the midpoint.
  const goal = () => target || tf;

  function fitTf() {
    if (!layout) return null;
    const w = svg.clientWidth;
    const h = svg.clientHeight - 30; // legend strip
    if (w <= 0 || h <= 0) return null;
    const gw = layout.width;
    const gh = layout.height;
    // dagre reports -Infinity for an empty graph
    if (!(gw > 0 && gh > 0 && Number.isFinite(gw) && Number.isFinite(gh))) return null;
    const k = Math.min(1.25, Math.max(MIN_K, Math.min(w / gw, h / gh) * 0.95));
    return { k, x: (w - gw * k) / 2, y: Math.max(4, (h - gh * k) / 2) };
  }

  function fit({ animate = false } = {}) {
    const t = fitTf();
    if (!t) return;
    userMoved = false;
    if (animate) animateTo(t);
    else { stopAnim(); tf = t; applyTf(); }
  }

  // Transform that scales by `factor` while keeping screen point (cx, cy) still.
  function zoomedTf(factor, cx, cy, base = tf) {
    const k = Math.min(MAX_K, Math.max(MIN_K, base.k * factor));
    return { k, x: cx - ((cx - base.x) * k) / base.k, y: cy - ((cy - base.y) * k) / base.k };
  }

  function zoomAt(factor, cx, cy, { animate = false } = {}) {
    userMoved = true;
    if (animate) animateTo(zoomedTf(factor, cx, cy, goal()));
    else { stopAnim(); tf = zoomedTf(factor, cx, cy); applyTf(); }
  }

  const center = () => ({ x: svg.clientWidth / 2, y: (svg.clientHeight - 30) / 2 });

  // pan / zoom
  // Pinch on a trackpad (and ctrl/cmd + wheel) arrives as a wheel event with ctrlKey and small deltas;
  // a mouse wheel sends big notches or line-mode deltas; two-finger trackpad scroll pans.
  svg.addEventListener('wheel', (e) => {
    e.preventDefault();
    const r = svg.getBoundingClientRect();
    const cx = e.clientX - r.left;
    const cy = e.clientY - r.top;
    const dy = e.deltaMode === 1 ? e.deltaY * 40 : e.deltaMode === 2 ? e.deltaY * 400 : e.deltaY;
    const pinch = e.ctrlKey || e.metaKey;
    const mouseWheel = !pinch && !e.shiftKey && e.deltaX === 0 && (e.deltaMode !== 0 || Math.abs(e.deltaY) >= 40 && Number.isInteger(e.deltaY));
    if (pinch) {
      zoomAt(Math.exp(-Math.max(-60, Math.min(60, dy)) * 0.012), cx, cy);
    } else if (mouseWheel) {
      zoomAt(Math.exp(-Math.max(-200, Math.min(200, dy)) * 0.003), cx, cy);
    } else {
      stopAnim();
      userMoved = true;
      tf.x -= e.shiftKey && !e.deltaX ? e.deltaY : e.deltaX;
      tf.y -= e.shiftKey && !e.deltaX ? 0 : e.deltaY;
      applyTf();
    }
  }, { passive: false });

  // Safari sends trackpad pinch as gesture events rather than ctrl+wheel. On iOS a two-finger touch
  // fires them too, alongside the pointer events below; those already handle it, so skip them then.
  let gestureK = null;
  svg.addEventListener('gesturestart', (e) => { e.preventDefault(); gestureK = pointers.size > 1 ? null : { ...tf }; });
  svg.addEventListener('gesturechange', (e) => {
    if (!gestureK || pointers.size > 1) return;
    e.preventDefault();
    const r = svg.getBoundingClientRect();
    userMoved = true;
    tf = zoomedTf(e.scale, e.clientX - r.left, e.clientY - r.top, gestureK);
    applyTf();
  });
  svg.addEventListener('gestureend', () => { gestureK = null; });

  // Drag pans; two fingers pinch-zoom and pan around their midpoint. A touch drag may start on a node
  // (they cover most of a phone-sized view); a mouse drag from a node is left alone.
  const pointers = new Map(); // pointerId -> { x, y } in svg coordinates
  let drag = null; // the gesture's start: pointer positions and the transform then
  let suppressClick = false; // the finger moved, so the tap that ends it is not a click on a node
  let lastTap = null; // { t, x, y } of the last touch tap on the background, for double-tap zoom
  let lastPointer = 'mouse';
  const local = (e) => { const r = svg.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
  function startGesture() {
    const pts = [...pointers.values()];
    drag = { pts, tf: { ...tf }, moved: drag?.moved || false };
  }
  svg.addEventListener('pointerdown', (e) => {
    lastPointer = e.pointerType;
    if (e.pointerType === 'mouse' && (e.button !== 0 || e.target.closest('.node'))) return;
    stopAnim();
    svg.focus({ preventScroll: true }); // so the zoom keys work
    pointers.set(e.pointerId, local(e));
    if (pointers.size > 2) return;
    if (pointers.size === 1) suppressClick = false;
    startGesture();
    if (!e.target.closest('.node')) svg.setPointerCapture(e.pointerId);
  });
  svg.addEventListener('pointermove', (e) => {
    if (!drag || !pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, local(e));
    const [a, b] = [...pointers.values()];
    const [a0, b0] = drag.pts;
    if (b && b0) {
      // Scale by the change in finger spread, then move so the start midpoint follows the current one.
      const d0 = Math.hypot(b0.x - a0.x, b0.y - a0.y) || 1;
      const m0 = { x: (a0.x + b0.x) / 2, y: (a0.y + b0.y) / 2 };
      const z = zoomedTf(Math.hypot(b.x - a.x, b.y - a.y) / d0, m0.x, m0.y, drag.tf);
      tf = { k: z.k, x: z.x + (a.x + b.x) / 2 - m0.x, y: z.y + (a.y + b.y) / 2 - m0.y };
      drag.moved = true;
    } else {
      const dx = a.x - a0.x;
      const dy = a.y - a0.y;
      if (!drag.moved && Math.abs(dx) + Math.abs(dy) <= (e.pointerType === 'mouse' ? 3 : 8)) return;
      drag.moved = true;
      tf = { ...drag.tf, x: drag.tf.x + dx, y: drag.tf.y + dy };
    }
    userMoved = true;
    suppressClick = true;
    applyTf();
  });
  function endPointer(e) {
    if (!pointers.has(e.pointerId)) return;
    const at = pointers.get(e.pointerId);
    pointers.delete(e.pointerId);
    if (pointers.size) { startGesture(); return; } // one finger lifted mid-pinch: keep panning with the other
    const tapped = e.type === 'pointerup' && drag && !drag.moved;
    drag = null;
    if (!tapped || e.target.closest('.node')) return;
    select(null);
    if (e.pointerType !== 'touch') return;
    // Double-tap the background to zoom in there (dblclick is unreliable for touch).
    const now = e.timeStamp;
    if (lastTap && now - lastTap.t < 350 && Math.hypot(at.x - lastTap.x, at.y - lastTap.y) < 30) {
      lastTap = null;
      zoomAt(2, at.x, at.y, { animate: true });
    } else lastTap = { t: now, ...at };
  }
  svg.addEventListener('pointerup', endPointer);
  svg.addEventListener('pointercancel', endPointer);
  svg.addEventListener('click', (e) => {
    if (suppressClick) { e.stopPropagation(); suppressClick = false; }
  }, true);

  // Double-click the background to zoom in there (shift: out). Double-click on a node isolates its lineage.
  svg.addEventListener('dblclick', (e) => {
    if (e.target.closest('.node') || lastPointer === 'touch') return; // touch: see the double-tap above
    const r = svg.getBoundingClientRect();
    zoomAt(e.shiftKey ? 1 / 2 : 2, e.clientX - r.left, e.clientY - r.top, { animate: true });
  });

  function panBy(dx, dy) {
    userMoved = true;
    const g = goal();
    animateTo({ ...g, x: g.x + dx, y: g.y + dy }, 120);
  }
  svg.addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const c = center();
    const pan = 60;
    const act = {
      '+': () => zoomAt(1.5, c.x, c.y, { animate: true }), '=': () => zoomAt(1.5, c.x, c.y, { animate: true }),
      '-': () => zoomAt(1 / 1.5, c.x, c.y, { animate: true }), _: () => zoomAt(1 / 1.5, c.x, c.y, { animate: true }),
      0: () => fit({ animate: true }),
      1: () => zoomAt(1 / goal().k, c.x, c.y, { animate: true }),
      ArrowLeft: () => panBy(pan, 0), ArrowRight: () => panBy(-pan, 0),
      ArrowUp: () => panBy(0, pan), ArrowDown: () => panBy(0, -pan),
    }[e.key];
    if (act) { e.preventDefault(); act(); }
  });

  root.querySelector('.graph-tools').addEventListener('click', (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    const c = center();
    if (act === 'fit') fit({ animate: true });
    if (act === 'links') {
      showFilterLinks = !showFilterLinks;
      try { localStorage.setItem('queryflow.filterLinks', showFilterLinks ? '1' : '0'); } catch { /* ignore */ }
      signature = '';
      if (analysis) update(analysis);
    }
    if (act === 'dir') {
      direction = { auto: 'LR', LR: 'TB', TB: 'auto' }[direction] || 'auto';
      try { localStorage.setItem('queryflow.graphDir', direction); } catch { /* ignore */ }
      signature = '';
      if (analysis) update(analysis);
    }
    if (act === 'zoom-in') zoomAt(1.5, c.x, c.y, { animate: true });
    if (act === 'zoom-out') zoomAt(1 / 1.5, c.x, c.y, { animate: true });
    if (act === 'zoom-reset') zoomAt(1 / goal().k, c.x, c.y, { animate: true });
  });

  const stepsEl = root.querySelector('.steps-view');
  const steps = createStepsView(stepsEl, {
    onPick: (id) => { select(id); jumpTo(id); },
    onRange: (from, to) => selectRange(from, to),
  });
  function showTab(name) {
    root.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
    graphView.hidden = name !== 'graph';
    tablesView.hidden = name !== 'tables';
    stepsEl.hidden = name !== 'steps';
    const runEl = root.querySelector('.run-view');
    runEl.hidden = name !== 'run';
    if (name === 'run') onRunTab?.(runEl); // the Run panel loads on first use
    root.closest('.right')?.classList.toggle('run-mode', name === 'run');
    root.querySelector('.graph-tools').style.visibility = name === 'graph' ? 'visible' : 'hidden';
    try { localStorage.setItem('queryflow.tab', name); } catch { /* ignore */ }
    onTab?.(name);
    if (name === 'graph' && graphStale && analysis) { graphStale = false; drawGraph(analysis); }
    if (name === 'graph') setTimeout(() => { if (!userMoved) fit(); }, 0);
  }
  root.querySelector('.tabs').addEventListener('click', (e) => {
    const tab = e.target.closest('.tab');
    if (tab) showTab(tab.dataset.tab);
  });
  let startTab = 'graph';
  try { startTab = localStorage.getItem('queryflow.tab') || 'graph'; } catch { /* ignore */ }
  showTab(['steps', 'graph', 'tables', 'run'].includes(startTab) ? startTab : 'graph');

  vp.addEventListener('click', (e) => {
    const n = e.target.closest('.node');
    if (!n) return;
    if (n.dataset.at) {
      // An alias box of a self-join: select the table, jump to that read of it.
      const at = { from: +n.dataset.at, to: +n.dataset.atEnd };
      select(n.dataset.id);
      focusRanges(view, [at], { scroll: false });
      view.dispatch({ selection: { anchor: at.from }, effects: EditorView.scrollIntoView(at.from, { y: 'center' }) });
      return;
    }
    select(n.dataset.id, { jump: true });
  });
  // Hover: light up the box, its direct inputs and the edges between them.
  let hoverId = null;
  vp.addEventListener('mouseover', (e) => {
    const n = e.target.closest('.node');
    if (!n || n.dataset.id === hoverId) return;
    hoverId = n.dataset.id;
    applyHover();
  });
  vp.addEventListener('mouseout', (e) => {
    const n = e.target.closest('.node');
    if (!n || (e.relatedTarget && n.contains(e.relatedTarget))) return;
    hoverId = null;
    applyHover();
  });
  function applyHover() {
    vp.querySelectorAll('.hl, .hl-up').forEach((el) => el.classList.remove('hl', 'hl-up'));
    const n = hoverId && analysis?.graph.nodes.find((x) => x.id === hoverId);
    vp.classList.toggle('hovering', !!n);
    if (!n) return;
    const ups = new Set(n.in);
    vp.querySelectorAll('.node').forEach((el) => {
      if (el.dataset.id === hoverId) el.classList.add('hl');
      else if (ups.has(el.dataset.id)) el.classList.add('hl', 'hl-up');
    });
    vp.querySelectorAll('.edge').forEach((el) => {
      if (el.dataset.to === hoverId) el.classList.add('hl');
    });
  }

  vp.addEventListener('dblclick', (e) => {
    const n = e.target.closest('.node');
    if (n) setIsolate(n.dataset.id);
  });
  root.querySelector('.iso-bar').addEventListener('click', (e) => {
    if (e.target.closest('[data-act="show-all"]')) setIsolate(null);
  });

  function setIsolate(id) {
    isolate = id;
    signature = '';
    if (analysis) update(analysis);
  }

  detail.addEventListener('click', (e) => {
    const link = e.target.closest('[data-node]');
    if (link) select(link.dataset.node, { jump: true });
    if (e.target.closest('[data-act="close"]')) select(null);
    if (e.target.closest('[data-act="isolate"]')) setIsolate(isolate === selected ? null : selected);
    if (e.target.closest('[data-act="preview"]')) onPreview?.(selected);
    if (e.target.closest('[data-act="run-cte"]')) onRun?.(selected);
    const win = e.target.closest('.win[data-from]');
    if (win) selectRange(+win.dataset.from, +win.dataset.to);
  });

  function selectRange(from, to) {
    view.dispatch({ selection: { anchor: from, head: to }, effects: EditorView.scrollIntoView(from, { y: 'center' }) });
    view.focus();
  }

  tablesView.addEventListener('click', (e) => {
    if (e.target.closest('[data-act="to-run"]')) { showTab('run'); return; }
    const item = e.target.closest('[data-node]');
    if (!item) return;
    jumpTo(item.dataset.node);
  });

  function jumpTo(id) {
    const n = analysis?.graph.nodes.find((x) => x.id === id);
    if (!n) return;
    const list = n.kind === 'cte' && n.def ? [n.def, ...n.refs] : n.refs.length ? n.refs : n.def ? [n.def] : [];
    if (!list.length) return;
    const idx = ((refCycle.get(id) ?? -1) + 1) % list.length;
    refCycle.set(id, idx);
    focusRanges(view, list, { scroll: false });
    view.dispatch({ selection: { anchor: list[idx].from }, effects: EditorView.scrollIntoView(list[idx].from, { y: 'center' }) });
  }

  function select(id, { jump = false } = {}) {
    selected = id;
    const nodes = analysis?.graph.nodes || [];
    const n = nodes.find((x) => x.id === id);
    onSelect?.(n ? id : null);
    vp.classList.toggle('has-selection', !!n);
    if (!n) {
      vp.querySelectorAll('.lit, .selected').forEach((el) => el.classList.remove('lit', 'selected'));
      detail.hidden = true;
      focusRanges(view, [], { scroll: false });
      return;
    }
    // highlight upstream + downstream lineage
    const byId = new Map(nodes.map((x) => [x.id, x]));
    const lit = new Set([id]);
    const walk = (start, dir) => {
      const stack = [start];
      while (stack.length) {
        const cur = byId.get(stack.pop());
        for (const nx of cur?.[dir] || []) if (!lit.has(nx)) { lit.add(nx); stack.push(nx); }
      }
    };
    walk(id, 'in');
    walk(id, 'out');
    vp.querySelectorAll('.node').forEach((el) => el.classList.toggle('lit', lit.has(el.dataset.id)));
    vp.querySelectorAll('.edge').forEach((el) => el.classList.toggle('lit', lit.has(el.dataset.from) && lit.has(el.dataset.to)));
    vp.querySelectorAll('.node').forEach((el) => el.classList.toggle('selected', el.dataset.id === id));
    renderDetail(n, byId);
    if (jump) jumpTo(id);
  }

  function renderDetail(n, byId) {
    const nameOf = (id) => byId.get(id)?.label ?? id;
    const blocks = [...n.blocks].sort((x, y) => !!x.inline - !!y.inline).map((items) => (items.inline ? `<div class="union-sep">${esc(inlineHeading(items.inline))}</div>` : '') + items.map((it) => {
      const kw = it.joinType === 'FROM' ? 'FROM' : it.joinType === 'COMMA' ? ', (cross)' : `${it.joinType} JOIN`;
      const src = it.nodeId
        ? `<button class="link" data-node="${esc(it.nodeId)}">${esc(it.kind === 'subquery' ? '(subquery)' : nameOf(it.nodeId))}</button>`
        : `<span class="muted">${esc(it.name)}</span>`;
      const alias = it.alias ? ` <span class="alias">${esc(it.alias)}</span>` : '';
      const on = it.onText ? `<div class="on">${it.onText.startsWith('USING') ? '' : 'ON '}${esc(it.onText)}</div>` : '';
      // The earlier FROM item(s) this join attaches to.
      const partners = (it.partners || []).map((p) => (p.nodeId
        ? `<button class="link" data-node="${esc(p.nodeId)}">${esc(p.kind === 'subquery' ? p.alias || '(subquery)' : nameOf(p.nodeId))}</button>`
        : `<span>${esc(p.alias || p.name)}</span>`) + (p.alias && p.kind !== 'subquery' ? ` <span class="alias">${esc(p.alias)}</span>` : ''));
      const withLine = partners.length ? `<div class="on with">with ${partners.join(', ')}</div>` : '';
      return `<li><span class="jk ${JOIN_CLASS[it.joinType] || 'from'}">${esc(kw)}</span> ${src}${alias}${withLine}${on}</li>`;
    }).join('')).map((b) => `<ul class="joins">${b}</ul>`).join('');
    const feeds = n.out.map((id) => `<button class="link" data-node="${esc(id)}">${esc(nameOf(id))}</button>`).join(', ');
    detail.innerHTML = `
      <div class="detail-head">
        <span class="kind ${n.kind}">${KIND_LABEL[n.kind] || n.kind}</span>
        <b>${esc(n.label)}</b>
        ${n.kind === 'cte' ? '<button class="mini" data-act="preview" title="Copy WITH … SELECT * FROM this CTE LIMIT 100, ready to run (⌘⌥Enter in the editor)">Copy preview</button>' : ''}
        ${n.kind === 'cte' && onRun ? '<button class="mini" data-act="run-cte" title="Run the query up to this CTE on the test tables and show its rows">Run</button>' : ''}
        <button class="mini" data-act="isolate" title="Show only what feeds this step and what it feeds (or double-click a node)">${isolate === n.id ? 'Show all' : 'Focus lineage'}</button>
        <button class="icon-btn" data-act="close" title="Close">×</button>
      </div>
      ${n.full && n.full !== n.label ? `<div class="full">${esc(n.full)}</div>` : ''}
      ${blocks ? `<div class="dsec">Reads from</div>${blocks}` : ''}
      ${shapeDetail(n.shape)}
      ${feeds ? `<div class="dsec">Feeds into</div><div class="feeds">${feeds}</div>` : ''}
      ${n.unused ? `<div class="warn">Not used anywhere</div>` : ''}
      <div class="dfoot">${n.refs.length ? `${n.refs.length} reference${n.refs.length > 1 ? 's' : ''} · click the node again to cycle` : ''}</div>`;
    detail.hidden = false;
  }

  function shapeDetail(sh) {
    if (!sh) return '';
    const rows = [];
    const code = (t) => `<code>${esc(t)}</code>`;
    const list = (arr, joiner = 'AND') => arr.map((t, i) => `<div class="cond">${i ? `<span class="muted">${joiner}</span> ` : ''}${code(t)}</div>`).join('');
    rows.push(['Columns', sh.star ? `all (<code>*</code>)${sh.columns > 1 ? ` + ${sh.columns - 1} more` : ''}` : `${sh.columns}`]);
    if (sh.dedupe) {
      rows.push(['Dedupe', `keeps the <b>${sh.dedupe.latest ? 'latest' : 'first'}</b> row per ${code(sh.dedupe.per)}${sh.dedupe.order ? ` by ${code(sh.dedupe.order)}` : ''} <span class="muted">(${sh.dedupe.where === 'QUALIFY' || sh.dedupe.where === 'DISTINCT ON' ? sh.dedupe.where : sh.dedupe.where === 'join' ? 'rn = 1 in the join' : 'rn = 1 in WHERE'})</span>`]);
    }
    if (sh.filters.length) rows.push(['Filters', list(sh.filters)]);
    if (sh.groupBy.length) rows.push(['Group by', sh.groupBy.map(code).join(', ')]);
    if (sh.aggregates.length) rows.push(['Aggregates', sh.aggregates.map((a) => code(a + '()')).join(' ')]);
    if (sh.having.length) rows.push(['Having', list(sh.having)]);
    if (sh.qualify.length) rows.push(['Qualify', list(sh.qualify)]);
    if (sh.distinct) rows.push(['Distinct', 'yes']);
    if (sh.branches > 1) rows.push(['Union', `${sh.branches} SELECTs`]);
    if (sh.limit) rows.push(['Limit', code(sh.limit)]);
    const wins = extraWindows(sh);
    return `<div class="dsec">What it does</div><dl class="shape">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>` +
      (wins.length ? `<div class="dsec">Window functions · ${wins.length}</div><div class="wins">${wins.map((w) => windowCard(w, esc)).join('')}</div>` : '');
  }

  function renderTables(a) {
    const nodes = a.graph.nodes;
    const byId = new Map(nodes.map((x) => [x.id, x]));
    const tables = nodes.filter((n) => n.kind === 'table').sort((x, y) => (x.full || '').localeCompare(y.full || ''));
    const outputs = nodes.filter((n) => n.kind === 'created');
    const ctes = nodes.filter((n) => n.kind === 'cte');
    root.querySelector('[data-count="tables"]').textContent = tables.length;
    const aliasesOf = (id) => {
      const s = new Set();
      for (const e of a.graph.edges) if (e.from === id) for (const j of e.joins) if (j.alias) s.add(j.alias);
      return [...s];
    };
    const row = (n) => {
      const used = n.out.map((id) => byId.get(id)?.label).filter(Boolean);
      const aliases = aliasesOf(n.id);
      return `<li data-node="${esc(n.id)}" title="Click to jump through references">
        <div class="t-name"><span class="t-sub">${esc(n.sub ? n.sub + '.' : '')}</span>${esc(n.label)}</div>
        <div class="t-meta">${n.refs.length}× ${aliases.length ? `· as ${esc(aliases.join(', '))}` : ''} ${used.length ? `· used in ${esc(used.join(', '))}` : ''}</div>
      </li>`;
    };
    tablesView.innerHTML = `
      ${onRunTab ? '<div class="t-testdata"><button class="mini accent" data-act="to-run">Add test data…</button><span>Type, paste or import rows for these tables in the Run tab, then run the query on them</span></div>' : ''}
      <div class="t-group"><h4>Source tables <span class="badge">${tables.length}</span></h4><ul>${tables.map(row).join('') || '<li class="empty">None</li>'}</ul></div>
      ${outputs.length ? `<div class="t-group"><h4>Written / created <span class="badge">${outputs.length}</span></h4><ul>${outputs.map(row).join('')}</ul></div>` : ''}
      <div class="t-group"><h4>CTEs <span class="badge">${ctes.length}</span></h4><ul>${ctes.map(row).join('') || '<li class="empty">None</li>'}</ul></div>`;
  }

  function update(a) {
    analysis = a;
    renderTables(a);
    steps.update(a);
    // Laying out a big graph takes a while (≈0.5 s at 180 steps): only do it when it's on screen.
    graphStale = graphView.hidden;
    if (!graphStale) drawGraph(a);
  }

  function drawGraph(a) {
    let { nodes, edges } = a.graph;
    const isoBar = root.querySelector('.iso-bar');
    if (isolate && nodes.some((n) => n.id === isolate)) {
      const keep = lineageOf(isolate, nodes);
      nodes = nodes.filter((n) => keep.has(n.id));
      edges = edges.filter((e) => keep.has(e.from) && keep.has(e.to));
      isoBar.hidden = false;
      isoBar.querySelector('b').textContent = `${a.graph.nodes.find((n) => n.id === isolate).label} (${nodes.length} of ${a.graph.nodes.length})`;
    } else {
      isolate = null;
      isoBar.hidden = true;
    }
    const linkBtn = root.querySelector('[data-act="links"]');
    // Helper links: IN / EXISTS subquery filters and reads of a one-row params CTE.
    const helper = (e) => e.role === 'filter' || e.role === 'params';
    const helperCount = edges.filter(helper).length;
    linkBtn.hidden = !helperCount;
    linkBtn.textContent = showFilterLinks ? 'Hide links' : `Show links (${helperCount})`;
    if (!showFilterLinks) edges = edges.filter((e) => !helper(e));
    ({ nodes, edges } = splitSelfJoins(nodes, edges));
    const allById = new Map(a.graph.nodes.map((x) => [x.id, x]));
    edges = edges.map((e) => ({ ...e, withText: edgeWith(e, allById) }));
    empty.hidden = nodes.length > 0;
    const sig = nodes.map((n) => n.id + ':' + shapeChips(n.shape).map((c) => c.text).join(',')).join('|') +
      '#' + edges.map((e) => e.id + edgeText(e) + e.withText).join('|') + '#' + direction + '#' + isolate + '#' + showFilterLinks;
    if (sig === signature) {
      if (selected) select(selected);
      return;
    }
    const structural = nodes.map((n) => n.id).join('|') + '#' + edges.map((e) => e.id).join('|');
    const refit = structural !== layout?.structural;
    signature = sig;
    const job = ++layoutJob;
    if (!nodes.length) {
      layout = null;
      graphView.classList.remove('busy');
      vp.innerHTML = '';
      select(null);
      return;
    }

    const byId = new Map(nodes.map((x) => [x.id, x]));
    const deco = new Map(nodes.map((n) => [n.id, decorate(n, byId)]));
    const boxes = nodes.map((n) => ({ id: n.id, width: deco.get(n.id).width, height: deco.get(n.id).height }));
    const links = edges.map((e) => {
      const plain = isDerivation(e, byId) || e.role === 'filter' || e.role === 'params';
      const text = isDerivation(e, byId) ? '' : plain ? semiEdgeText(e) : edgeText(e);
      const sub = plain ? '' : e.withText;
      const labelWidth = text || sub ? Math.max(textWidth(text, SUB_FONT), textWidth(sub, SUB_FONT)) + 10 : 0;
      // Helper links pull less on the layout than real data flow.
      return { from: e.from, to: e.to, labelWidth, labelHeight: text && sub ? 28 : 16, weight: e.role === 'filter' || e.role === 'params' ? 1 : 2 };
    });
    const jobs = (direction === 'auto' ? ['LR', 'TB'] : [direction]).map((dir) => {
      const input = { dir, nodes: boxes, edges: links };
      return { input, ...cached(input) };
    });
    const render = (results) => {
      if (job !== layoutJob) return;
      graphView.classList.remove('busy');
      renderGraph(results, { nodes, edges, byId, deco, structural, refit });
    };
    if (jobs.every((j) => j.hit) || nodes.length <= SYNC_MAX_NODES) {
      render(jobs.map((j) => j.hit || remember(j.key, layoutGraph(j.input))));
      return;
    }
    graphView.classList.add('busy');
    busyEl.textContent = `Laying out ${nodes.length} boxes…`;
    Promise.all(jobs.map((j) => j.hit || layoutInWorker(j.input).then((r) => remember(j.key, r))))
      .then(render, (err) => { if (err.message !== 'superseded' && job === layoutJob) { graphView.classList.remove('busy'); console.error(err); } });
  }

  // Draws a finished layout; with two (auto direction) keeps whichever fits the panel at a larger scale.
  function renderGraph(results, { nodes, edges, byId, deco, structural, refit }) {
    const w = svg.clientWidth || 600;
    const h = (svg.clientHeight || 400) - 30;
    const score = (r) => Math.min(w / r.width, h / r.height);
    const g = results.length === 2 && score(results[1]) > score(results[0]) * 1.15 ? results[1] : results[0];
    const changedDir = layout && layout.dir !== g.dir;
    layout = { width: g.width, height: g.height, structural, dir: g.dir };
    root.querySelector('[data-act="dir"]').textContent = direction === 'auto' ? `Auto · ${g.dir === 'LR' ? '→' : '↓'}` : g.dir === 'LR' ? '→' : '↓';

    const edgeSvg = edges.map((e) => {
      const d = g.edges[edgeKey(e)];
      const derive = isDerivation(e, byId);
      const semi = e.role === 'filter' || e.role === 'params';
      const cls = derive ? 'derive' : semi ? 'semi' : edgeClass(e);
      const text = derive ? '' : semi ? semiEdgeText(e) : edgeText(e);
      const dashed = !derive && !semi && (e.role === 'lookup' || byId.get(e.from)?.kind === 'subquery' || e.joins.every((j) => j.kind === 'subquery')) ? ' dashed' : '';
      const title = e.joins.map((j) => `${j.joinType === 'FROM' ? 'FROM' : j.joinType + ' JOIN'} ${j.name}${j.alias ? ' ' + j.alias : ''}${j.onText ? '\n  ' + j.onText : ''}`).join('\n');
      const sub = derive || semi ? '' : e.withText;
      const two = text && sub;
      const lbl = (text || sub) && Number.isFinite(d.x) && Number.isFinite(d.y)
        ? `<g class="elabel" transform="translate(${d.x},${d.y})"><rect x="${-d.width / 2}" y="${two ? -14 : -8}" width="${d.width}" height="${two ? 28 : 16}" rx="4"/>` +
          (text ? `<text y="${two ? -2.5 : 3.5}" text-anchor="middle">${esc(text)}</text>` : '') +
          (sub ? `<text class="with" y="${two ? 10 : 3.5}" text-anchor="middle">${esc(sub)}</text>` : '') + '</g>'
        : '';
      return `<g class="edge ${cls}${dashed}" data-from="${esc(e.fromRef ?? e.from)}" data-to="${esc(e.to)}">
        <title>${esc(derive ? 'derived from ' + (byId.get(e.from)?.label || '') : semi ? 'subquery filter (rows are kept or dropped, no columns are added):\n' + title : title)}</title>
        <path d="${smoothPath(d.points)}" marker-end="url(#arrow-${cls})"/>
        ${lbl}
      </g>`;
    }).join('');
    const nodeSvg = nodes.map((n) => {
      const p = g.nodes[n.id];
      const dc = deco.get(n.id);
      const x = p.x - p.width / 2;
      const y = p.y - p.height / 2;
      const title = `${KIND_LABEL[n.kind] || n.kind}: ${n.full || n.label}${n.unused ? ' (unused)' : ''}` +
        (n.ghost ? `\nread again${n.ghost.alias ? ' as ' + n.ghost.alias : ''} in the same FROM (self-join)` : '');
      const chips = dc.chipRows.map((row, ri) => row.map((c) => {
        const cy = dc.chipTop + ri * CHIP_ROW;
        return `<g class="chip ${c.cls}" transform="translate(${c.x + 14},${cy})"><title>${esc(c.title || c.text)}</title><rect width="${c.w}" height="15" rx="4"/><text x="${c.w / 2}" y="11" text-anchor="middle">${esc(c.text)}</text></g>`;
      }).join('')).join('');
      const at = n.ghost ? ` data-at="${n.ghost.from}" data-at-end="${n.ghost.to}"` : '';
      return `<g class="node ${n.kind}${n.ghost ? ' ghost' : ''}${n.unused ? ' unused' : ''}${dc.derived ? ' derived' : ''}" data-id="${esc(n.ref ?? n.id)}"${at} transform="translate(${x},${y})">
        <title>${esc(title)}</title>
        <rect width="${p.width}" height="${p.height}" rx="7"/>
        <rect class="stripe" width="4" height="${p.height}" rx="2"/>
        <text x="14" y="19" class="nlabel">${esc(n.label)}</text>
        ${dc.sub ? `<text x="14" y="33" class="nsub">${esc(dc.sub)}</text>` : ''}
        ${chips}
      </g>`;
    }).join('');
    vp.innerHTML = `<g class="edges">${edgeSvg}</g><g class="nodes">${nodeSvg}</g>`;
    if (refit || changedDir) { userMoved = false; setTimeout(fit, 0); }
    applyHover();
    if (selected && byId.has(selected)) select(selected); else select(null);
  }

  // Keep a hand-set zoom when the panel resizes; only re-fit a view the user hasn't touched.
  new ResizeObserver(() => { if (layout && !userMoved) fit(); }).observe(svg);

  return { update, fit, select: (id) => { select(id); if (id) jumpTo(id); }, showTab };
}
