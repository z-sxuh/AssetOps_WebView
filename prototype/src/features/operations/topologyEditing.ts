import type { Topology, TopologyNode } from './types';

export type NodeAlignment = 'left' | 'right' | 'top' | 'bottom' | 'horizontal' | 'vertical' | 'distribute-x' | 'distribute-y';
const width = (node: TopologyNode) => node.width ?? 260;
const height = (node: TopologyNode) => node.height ?? 132;
export function alignNodes(topology: Topology, ids: string[], mode: NodeAlignment): Topology {
  const nodes = topology.nodes.filter((node) => ids.includes(node.id)); if (nodes.length < 2) return topology;
  const left = Math.min(...nodes.map((node) => node.x)); const right = Math.max(...nodes.map((node) => node.x + width(node)));
  const top = Math.min(...nodes.map((node) => node.y)); const bottom = Math.max(...nodes.map((node) => node.y + height(node)));
  const axis = mode === 'distribute-y' ? 'y' : 'x';
  const sorted = [...nodes].sort((a, b) => a[axis] + (axis === 'x' ? width(a) : height(a)) / 2 - b[axis] - (axis === 'x' ? width(b) : height(b)) / 2);
  const centers = sorted.map((node) => node[axis] + (axis === 'x' ? width(node) : height(node)) / 2);
  const deltas = new Map(nodes.map((node) => {
    let x = node.x, y = node.y;
    if (mode === 'left') x = left; if (mode === 'right') x = right - width(node); if (mode === 'top') y = top; if (mode === 'bottom') y = bottom - height(node);
    if (mode === 'horizontal') y = (top + bottom - height(node)) / 2; if (mode === 'vertical') x = (left + right - width(node)) / 2;
    if (mode.startsWith('distribute') && nodes.length >= 3) { const position = centers[0] + (centers.at(-1)! - centers[0]) * sorted.indexOf(node) / (nodes.length - 1); if (axis === 'x') x = position - width(node) / 2; else y = position - height(node) / 2; }
    return [node.id, { dx: Math.round(x - node.x), dy: Math.round(y - node.y) }] as const;
  }));
  const groups = new Map<string, { dx: number; dy: number; active: boolean; minX: number; minY: number; maxX: number; maxY: number }>();
  const memberships = new Map<string, string>();
  for (const [id, delta] of deltas) {
    const key = `${delta.dx},${delta.dy}`; memberships.set(id, key);
    if (!groups.has(key)) groups.set(key, { ...delta, active: Boolean(delta.dx || delta.dy), minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity });
  }
  const include = (group: NonNullable<ReturnType<typeof groups.get>>, point: { x: number; y: number }) => { group.minX = Math.min(group.minX, point.x); group.minY = Math.min(group.minY, point.y); group.maxX = Math.max(group.maxX, point.x); group.maxY = Math.max(group.maxY, point.y); };
  for (const node of topology.nodes) { const key = memberships.get(node.id); if (key !== undefined) { const group = groups.get(key)!; if (group.active) include(group, node); } }
  const internalGroup = (edge: Topology['edges'][number]) => { const key = memberships.get(edge.from); return key !== undefined && key === memberships.get(edge.to) ? groups.get(key) : undefined; };
  for (const edge of topology.edges) { const group = internalGroup(edge); if (group?.active) for (const point of edge.waypoints ?? []) include(group, point); }
  let active = false;
  for (const group of groups.values()) if (group.active) { active = true; group.dx = Math.max(-50000 - group.minX, Math.min(group.dx, 50000 - group.maxX)); group.dy = Math.max(-50000 - group.minY, Math.min(group.dy, 50000 - group.maxY)); }
  if (!active) return topology;
  const bounded = (value: number) => Math.max(-50000, Math.min(50000, Math.round(value)));
  return { ...topology, nodes: topology.nodes.map(node => { const key = memberships.get(node.id), group = key === undefined ? undefined : groups.get(key); return group?.active ? { ...node, x: bounded(node.x + group.dx), y: bounded(node.y + group.dy) } : node; }), edges: topology.edges.map(edge => { const group = internalGroup(edge); return group?.active && edge.waypoints?.length ? { ...edge, waypoints: edge.waypoints.map(point => ({ x: bounded(point.x + group.dx), y: bounded(point.y + group.dy) })) } : edge; }) };
}
