import type { Topology, TopologyNode, TopologyRegion } from './types';

export const deviceTemplates = [
  { kind: 'application', label: '应用服务器', role: '应用服务', hint: '业务与应用服务' },
  { kind: 'database', label: '数据库', role: '数据库', hint: '关系库与缓存' },
  { kind: 'file', label: '文件服务', role: '文件服务', hint: '存储与文件共享' },
  { kind: 'switch', label: '交换机', role: '交换机', hint: '网络交换设备' },
  { kind: 'firewall', label: '防火墙', role: '防火墙', hint: '边界与安全设备' },
] as const;
export type DeviceKind = typeof deviceTemplates[number]['kind'];
export type EditorTool = 'select' | 'pan' | 'connect';
export type TopologyClipboard = Pick<Topology, 'nodes' | 'edges'>;

// 旧拓扑没有显式归属，沿用画布按最小包含区域判定分组的行为。
function nodeRegion(node: TopologyNode, regions: TopologyRegion[]) {
  return node.regionId ?? [...regions].filter(r => node.x >= r.x && node.y >= r.y && node.x + (node.width ?? 260) <= r.x + r.width && node.y + (node.height ?? 132) <= r.y + r.height).sort((a, b) => a.width * a.height - b.width * b.height)[0]?.id;
}

export function descendants(regions: TopologyRegion[], id: string): Set<string> {
  const result = new Set<string>(), pending = [id];
  while (pending.length) { const parent = pending.pop()!; for (const region of regions) if (region.parentId === parent && !result.has(region.id) && region.id !== id) { result.add(region.id); pending.push(region.id); } }
  return result;
}
export function orderedRegions(regions: TopologyRegion[]) {
  const map = new Map(regions.map(r => [r.id, r]));
  const depth = (region: TopologyRegion) => { const visited = new Set([region.id]); let count = 0, parent = region.parentId; while (parent && map.has(parent) && !visited.has(parent)) { visited.add(parent); count++; parent = map.get(parent)!.parentId; } return count; };
  return [...regions].sort((a, b) => depth(a) - depth(b));
}
export function nestRegion(topology: Topology, id: string, parentId?: string): Topology {
  const regions = topology.regions ?? [], region = regions.find(r => r.id === id);
  if (!region || parentId === id || parentId && (!regions.some(r => r.id === parentId) || descendants(regions, id).has(parentId))) return topology;
  const updates = new Map(regions.map(r => [r.id, r.id === id ? { ...r, parentId } : r]));
  let child = updates.get(id)!;
  while (child.parentId) {
    const parent = updates.get(child.parentId)!;
    const x = Math.max(-50000, Math.min(parent.x, child.x - 24)), y = Math.max(-50000, Math.min(parent.y, child.y - 48));
    const width = Math.max(parent.x + parent.width, child.x + child.width + 24) - x, height = Math.max(parent.y + parent.height, child.y + child.height + 24) - y;
    if (width > 50000 || height > 50000) throw new Error('分组所需范围超过 50000 尺寸上限，无法设置上级分组');
    child = { ...parent, x, y, width, height }; updates.set(child.id, child);
  }
  return { ...topology, regions: regions.map(r => updates.get(r.id)!) };
}
export function groupNodes(topology: Topology, ids: string[], id: string): Topology {
  const chosen = new Set(ids), nodes = topology.nodes.filter(n => chosen.has(n.id));
  if (!nodes.length || (topology.regions?.length ?? 0) >= 500) return topology;
  const left = Math.min(...nodes.map(n => n.x)), top = Math.min(...nodes.map(n => n.y));
  const right = Math.max(...nodes.map(n => n.x + (n.width ?? 260))), bottom = Math.max(...nodes.map(n => n.y + (n.height ?? 132)));
  const parent = nodeRegion(nodes[0], topology.regions ?? []), parentId = parent && nodes.every(n => nodeRegion(n, topology.regions ?? []) === parent) ? parent : undefined;
  const x = Math.max(-50000, left - 24), y = Math.max(-50000, top - 48), width = right + 24 - x, height = bottom + 24 - y;
  if (width > 50000 || height > 50000) throw new Error('所选成员范围超过 50000 尺寸上限，无法创建分组');
  const region: TopologyRegion = { id, label: '新建分组', x, y, width, height, color: '#668c70', ...(parentId ? { parentId } : {}) };
  return nestRegion({ ...topology, regions: [...(topology.regions ?? []), region], nodes: topology.nodes.map(n => chosen.has(n.id) ? { ...n, regionId: id } : n) }, id, parentId || undefined);
}
export function dissolveRegion(topology: Topology, id: string): Topology {
  const target = topology.regions?.find(r => r.id === id); if (!target) return topology;
  return { ...topology, regions: topology.regions!.filter(r => r.id !== id).map(r => r.parentId === id ? { ...r, parentId: target.parentId } : r), nodes: topology.nodes.map(n => nodeRegion(n, topology.regions!) === id ? { ...n, regionId: target.parentId ?? '' } : n) };
}
export function copyNodes(topology: Topology, ids: string[]): TopologyClipboard {
  const chosen = new Set(ids);
  return { nodes: topology.nodes.filter(n => chosen.has(n.id)), edges: topology.edges.filter(e => chosen.has(e.from) && chosen.has(e.to)) };
}
export function pasteNodes(topology: Topology, clipboard: TopologyClipboard, id: () => string = () => crypto.randomUUID()) {
  if (!clipboard.nodes.length || topology.nodes.length + clipboard.nodes.length > 1000 || topology.edges.length + clipboard.edges.length > 5000) return undefined;
  const ids = new Map(clipboard.nodes.map(n => [n.id, id()]));
  let dx = clipboard.nodes.some(n => n.x > 49900) ? -40 : 40, dy = clipboard.nodes.some(n => n.y > 49900) ? -40 : 40;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const include = (p: { x: number; y: number }) => { minX = Math.min(minX, p.x); minY = Math.min(minY, p.y); maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y); };
  for (const node of clipboard.nodes) include(node);
  for (const edge of clipboard.edges) for (const point of edge.waypoints ?? []) include(point);
  dx = Math.max(-50000 - minX, Math.min(dx, 50000 - maxX)); dy = Math.max(-50000 - minY, Math.min(dy, 50000 - maxY));
  const shift = (value: number, delta: number) => value + delta;
  const nodes: TopologyNode[] = clipboard.nodes.map(n => ({ ...n, id: ids.get(n.id)!, x: shift(n.x, dx), y: shift(n.y, dy), ...(n.regionId && !topology.regions?.some(r => r.id === n.regionId) ? { regionId: '' } : {}) }));
  const edges = clipboard.edges.map(e => ({ ...e, id: id(), from: ids.get(e.from)!, to: ids.get(e.to)!, ...(e.waypoints ? { waypoints: e.waypoints.map(p => ({ x: shift(p.x, dx), y: shift(p.y, dy) })) } : {}) }));
  return { topology: { ...topology, nodes: [...topology.nodes, ...nodes], edges: [...topology.edges, ...edges] }, ids: nodes.map(n => n.id), overlapping: dx === 0 && dy === 0 };
}
