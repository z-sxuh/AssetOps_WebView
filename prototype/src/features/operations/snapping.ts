import type { Topology, TopologyNode, TopologyPoint } from './types';

export type AlignmentGuide = { axis: 'x' | 'y'; at: number; start: number; end: number };
const width = (node: TopologyNode) => node.width ?? 260;
const height = (node: TopologyNode) => node.height ?? 132;
const bounded = (value: number) => Math.max(-50000, Math.min(50000, Math.round(value)));
type AxisAnchor = { at: number; node: TopologyNode; order: number };
export type MoveSnapIndex = { ids: ReadonlySet<string>; moving: TopologyNode[]; stationaryCount: number; x: AxisAnchor[]; y: AxisAnchor[] };

export function createMoveSnapIndex(nodes: TopologyNode[], ids: string[]): MoveSnapIndex {
  const selected = new Set(ids); const moving: TopologyNode[] = []; const others: TopologyNode[] = [];
  for (const node of nodes) (selected.has(node.id) ? moving : others).push(node);
  const anchors = (axis: 'x' | 'y') => {
    const size = axis === 'x' ? width : height;
    const sorted = others.flatMap((node, index) => [0, .5, 1].map((fraction, target) => ({ at: node[axis] + size(node) * fraction, node, order: index * 9 + target }))).sort((a, b) => a.at - b.at || a.order - b.order);
    return sorted.filter((anchor, index) => !index || anchor.at !== sorted[index - 1].at);
  };
  return { ids: selected, moving, stationaryCount: others.length, x: anchors('x'), y: anchors('y') };
}

export function snapMove(nodes: TopologyNode[], ids: string[], dx: number, dy: number, options = { grid: true, align: true, threshold: 6 }, index = createMoveSnapIndex(nodes, ids)) {
  const { moving } = index;
  const guides: AlignmentGuide[] = []; if (!moving.length) return { dx, dy, guides };
  const rawDx = dx; const rawDy = dy;
  if (options.grid) { dx = Math.round((moving[0].x + dx) / 20) * 20 - moving[0].x; dy = Math.round((moving[0].y + dy) / 20) * 20 - moving[0].y; }
  if (options.align) for (const axis of ['x', 'y'] as const) {
    let best: { distance: number; order: number; guide: AlignmentGuide } | undefined;
    const anchors = index[axis]; const size = axis === 'x' ? width : height; const delta = axis === 'x' ? rawDx : rawDy;
    for (let nodeIndex = 0; nodeIndex < moving.length; nodeIndex++) {
      const node = moving[nodeIndex];
      for (let fraction = 0; fraction < 3; fraction++) {
        const position = node[axis] + size(node) * fraction / 2 + delta;
        let low = 0; let high = anchors.length;
        while (low < high) { const middle = (low + high) >>> 1; if (anchors[middle].at < position) low = middle + 1; else high = middle; }
        for (const candidate of [low - 1, low]) {
          const anchor = anchors[candidate]; if (!anchor) continue;
          const { at, node: other } = anchor; const distance = at - position;
          // Preserve the exhaustive node/other/fraction/target order when distances tie.
          const order = nodeIndex * index.stationaryCount * 9 + anchor.order + fraction * 3;
          if (Math.abs(distance) > options.threshold || (best && (Math.abs(distance) > Math.abs(best.distance) || (Math.abs(distance) === Math.abs(best.distance) && order >= best.order)))) continue;
          const opposite = axis === 'x' ? 'y' : 'x'; const crossSize = axis === 'x' ? height : width;
          const crossDelta = axis === 'x' ? dy : dx;
          best = { distance, order, guide: { axis, at, start: Math.min(node[opposite] + crossDelta, other[opposite]) - 20, end: Math.max(node[opposite] + crossDelta + crossSize(node), other[opposite] + crossSize(other)) + 20 } };
        }
      }
    }
    if (best) { if (axis === 'x') dx = rawDx + best.distance; else dy = rawDy + best.distance; guides.push(best.guide); }
  }
  return { dx: Math.round(dx), dy: Math.round(dy), guides };
}

export function moveNodes(topology: Topology, ids: string[] | ReadonlySet<string>, dx: number, dy: number): Topology {
  const selected: ReadonlySet<string> = Array.isArray(ids) ? new Set(ids) : ids;
  // Clamp the group as a whole so nodes and internal waypoints retain their spacing.
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const include = (point: TopologyPoint) => { minX = Math.min(minX, point.x); minY = Math.min(minY, point.y); maxX = Math.max(maxX, point.x); maxY = Math.max(maxY, point.y); };
  for (const node of topology.nodes) if (selected.has(node.id)) include(node);
  for (const edge of topology.edges) if (selected.has(edge.from) && selected.has(edge.to)) for (const point of edge.waypoints ?? []) include(point);
  if (Number.isFinite(minX)) { dx = Math.max(-50000 - minX, Math.min(dx, 50000 - maxX)); dy = Math.max(-50000 - minY, Math.min(dy, 50000 - maxY)); }
  return { ...topology, nodes: topology.nodes.map((node) => selected.has(node.id) ? { ...node, x: bounded(node.x + dx), y: bounded(node.y + dy) } : node), edges: topology.edges.map((edge) => selected.has(edge.from) && selected.has(edge.to) && edge.waypoints?.length ? { ...edge, waypoints: edge.waypoints.map((point) => ({ x: bounded(point.x + dx), y: bounded(point.y + dy) })) } : edge) };
}
