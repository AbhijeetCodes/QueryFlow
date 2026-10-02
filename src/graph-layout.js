// Dagre layout of the lineage graph as a pure function of plain data, so it can
// run in a Web Worker (graph-layout.worker.js) as well as on the page.
import dagre from '@dagrejs/dagre';

/**
 * @param {{ dir: 'LR'|'TB', nodes: {id, width, height}[], edges: {from, to, labelWidth, labelHeight?, weight}[] }} input
 * @returns {{ dir, width, height, nodes: Record<id, {x, y, width, height}>, edges: Record<'from\nto', {points, x, y, width}> }}
 */
export function layoutGraph({ dir, nodes, edges }) {
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: dir, nodesep: dir === 'LR' ? 14 : 22, ranksep: dir === 'LR' ? 48 : 36, edgesep: 10, marginx: 12, marginy: 12 });
  g.setDefaultEdgeLabel(() => ({}));
  for (const n of nodes) g.setNode(n.id, { width: n.width, height: n.height });
  for (const e of edges) {
    g.setEdge(e.from, e.to, e.labelWidth ? { width: e.labelWidth, height: e.labelHeight || 16, labelpos: 'c', weight: e.weight } : { weight: e.weight });
  }
  dagre.layout(g);
  const gi = g.graph();
  const out = { dir, width: gi.width, height: gi.height, nodes: {}, edges: {} };
  for (const n of nodes) {
    const p = g.node(n.id);
    out.nodes[n.id] = { x: p.x, y: p.y, width: p.width, height: p.height };
  }
  for (const e of edges) {
    const d = g.edge(e.from, e.to);
    out.edges[edgeKey(e)] = { points: d.points, x: d.x, y: d.y, width: d.width };
  }
  return out;
}

export const edgeKey = (e) => `${e.from}\n${e.to}`;
