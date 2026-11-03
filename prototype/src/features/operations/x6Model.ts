import type { EdgeMetadata, NodeMetadata } from '@antv/x6';
import type { Asset, Unit } from '../../model';
import { getSquirclePath } from '../../squircleGeometry';
import { edgeColor } from './edgeColors';
import { fitNodeText, nodeDetails, nodeDetailsIndex, nodeIcon, nodeLayout } from './nodeAppearance';
import { nodePorts, topologyRegions } from './topology';
import { sameTopologyValue } from './topologyEquality';
import type { Topology, TopologyEdge, TopologyNode, TopologyRegion } from './types';

export const cellId = (kind: 'node' | 'edge' | 'region', id: string) => `${kind}:${id}`;
export type CellData = { kind: 'node'; value: TopologyNode } | { kind: 'edge'; value: TopologyEdge } | { kind: 'region'; value: TopologyRegion };
export type GraphCell = { id?: string; data?: CellData; position?: { x: number; y: number }; size?: { width: number; height: number }; source?: { cell?: string; port?: string }; target?: { cell?: string; port?: string }; vertices?: { x: number; y: number }[] };
const bounded = (value: number) => Math.max(-50000, Math.min(50000, value));

export function serverCell(node: TopologyNode, assets: Asset[] | ReturnType<typeof nodeDetailsIndex>, units: Unit[]): NodeMetadata {
  const info = nodeDetails(node, assets, units), width = node.width ?? 260, height = node.height ?? 132;
  const layout = nodeLayout(node, info.tags), textWidth = Math.max(0, width - 96);
  const markup: NodeMetadata['markup'] = [{ tagName: 'path', selector: 'body', className: 'topology-node-surface topology-squircle' }, { tagName: 'title', selector: 'title' }, { tagName: 'path', selector: 'iconBackground' }, { tagName: 'image', selector: 'icon' }];
  const attrs: NodeMetadata['attrs'] = {
    body: { d: getSquirclePath(width, height, 12), fill: 'var(--surface)', stroke: info.missing ? 'var(--coral)' : 'var(--line)', strokeWidth: 1.3 },
    title: { text: `${info.name}\n${info.host || node.role}\n${info.ip || '未设置 IP'}\n${info.tags.join('、')}\n${node.note ?? ''}` },
    iconBackground: { d: getSquirclePath(56, 56, 10), transform: `translate(12,${layout.iconY - 4})`, fill: 'var(--inset)', stroke: 'var(--line)', strokeWidth: .6, pointerEvents: 'none' },
    icon: { x: 16, y: layout.iconY, width: 48, height: 48, 'xlink:href': nodeIcon(node), pointerEvents: 'none' },
  };
  const text = (selector: string, value: string, y: number, size: number, className = '', bold = false) => {
    markup.push({ tagName: 'text', selector, className });
    attrs[selector] = { text: fitNodeText(value, textWidth, size, bold), x: 80, y, fontFamily: "'Microsoft YaHei UI','Microsoft YaHei','Segoe UI',sans-serif", fontSize: size, fontWeight: bold ? 700 : 400, fill: bold ? 'var(--ink)' : 'var(--muted)', textAnchor: 'start', textVerticalAnchor: 0, pointerEvents: 'none' };
  };
  text('name', info.name, layout.textY, 15, 'topology-title', true);
  text('host', info.host || (info.missing ? '资产关联已失效' : node.role), layout.textY + 22, 12);
  text('ip', info.ip || '未设置 IP', layout.textY + 42, 12);
  layout.badges.forEach((tag, i) => {
    const selector = `badge${i}`;
    markup.push({ tagName: 'path', selector, className: 'topology-tag-fill' });
    attrs[selector] = { d: getSquirclePath(Math.min(tag.width, textWidth + 8), 13, 6), transform: `translate(76,${layout.tagY + i * 14 - 10})`, fill: 'var(--selection)', stroke: 'var(--line)', strokeWidth: .6, pointerEvents: 'none' };
    text(`tag${i}`, info.tags[i], layout.tagY + i * 14, 9, 'topology-tag');
  });
  layout.notes.forEach((note, i) => text(`note${i}`, note, layout.noteY + i * 14, 11, 'topology-note'));
  return { id: cellId('node', node.id), shape: 'rect', x: node.x, y: node.y, width, height, zIndex: 10, markup, attrs, data: { kind: 'node', value: node }, ports: {
    groups: { boundary: { position: 'absolute', attrs: { circle: { r: 6, magnet: true, class: 'topology-port', fill: 'var(--surface)', stroke: 'var(--blue)', strokeWidth: 2 } } } },
    items: nodePorts(node).map(port => ({ id: port.id, group: 'boundary', args: { x: `${port.x * 100}%`, y: `${port.y * 100}%` } })),
  } };
}

export function regionCell(region: TopologyRegion): NodeMetadata {
  return { id: cellId('region', region.id), shape: 'rect', x: region.x, y: region.y, width: region.width, height: region.height, zIndex: 0, data: { kind: 'region', value: region }, markup: [
    { tagName: 'path', selector: 'body', className: 'topology-region-surface topology-squircle' }, { tagName: 'text', selector: 'regionLabel' }, { tagName: 'path', selector: 'header' },
  ], attrs: { body: { d: getSquirclePath(region.width, region.height, 16), fill: region.color, fillOpacity: .08, stroke: region.color, strokeDasharray: '6 4', strokeWidth: 2 }, regionLabel: { text: fitNodeText(region.label, region.width - 32, 14, true), x: 16, y: 26, textAnchor: 'start', textVerticalAnchor: 0, fill: 'var(--ink)', fontSize: 14, fontWeight: 700 }, header: { d: `M 12 38 H ${region.width - 12}`, stroke: region.color, opacity: .3 } } };
}

export function edgeCell(edge: TopologyEdge, regions: string[] = []): EdgeMetadata {
  const direction = edge.direction ?? 'forward', marker = { name: 'classic', size: 7 };
  return { id: cellId('edge', edge.id), shape: 'edge', source: { cell: cellId('node', edge.from), ...(edge.fromPort ? { port: edge.fromPort } : {}) }, target: { cell: cellId('node', edge.to), ...(edge.toPort ? { port: edge.toPort } : {}) }, zIndex: 5, data: { kind: 'edge', value: edge }, vertices: edge.waypoints ?? [],
    router: edge.routing === 'straight' ? 'normal' : { name: 'manhattan', args: { padding: 18, excludeNodes: regions, maxLoopCount: 2000 } },
    connector: edge.routing === 'straight' ? { name: 'normal' } : { name: 'rounded', args: { radius: 10 } }, attrs: { wrap: { connection: true, class: 'x6-edge-wrap', fill: 'none', stroke: 'transparent', strokeWidth: 14 }, line: { connection: true, class: 'x6-edge-line', fill: 'none', style: { stroke: edgeColor(edge) }, stroke: edgeColor(edge), strokeWidth: 2, strokeDasharray: edge.style === 'dashed' ? '8 6' : edge.style === 'dotted' ? '2 6' : null, sourceMarker: direction === 'reverse' || direction === 'both' ? marker : null, targetMarker: direction === 'forward' || direction === 'both' ? marker : null } },
    labels: edge.label ? [{ attrs: { label: { text: edge.label, fill: 'var(--ink)', fontSize: 12 }, body: { fill: 'var(--inset)', stroke: 'var(--line)', rx: 4, ry: 4 } }, position: { distance: .5, offset: -12 } }] : [],
  };
}

// X6 JSON stays inside the editor. Business snapshots retain the existing portable schema.
export function readGraphCells(base: Topology, cells: GraphCell[]): Topology {
  const byId = new Map(cells.map(cell => [cell.id, cell]));
  const edgesById = new Map(base.edges.map(edge => [edge.id, edge]));
  const box = (cell: GraphCell, value: TopologyNode | TopologyRegion) => ({ x: bounded(cell.position?.x ?? value.x), y: bounded(cell.position?.y ?? value.y) });
  const nodes = base.nodes.map(value => {
    const cell = byId.get(cellId('node', value.id)); if (!cell) return value;
    const width = Math.max(160, Math.min(1000, cell.size?.width ?? value.width ?? 260)), height = Math.max(100, Math.min(800, cell.size?.height ?? value.height ?? 132));
    const next = { ...value, ...box(cell, value), ...(width !== (value.width ?? 260) ? { width } : {}), ...(height !== (value.height ?? 132) ? { height } : {}) };
    return sameTopologyValue(value, next) ? value : next;
  });
  const nodeIds = new Set(nodes.map(node => cellId('node', node.id)));
  const edges = cells.flatMap(cell => {
    if (!cell.source?.cell || !cell.target?.cell || cell.source.cell === cell.target.cell || !nodeIds.has(cell.source.cell) || !nodeIds.has(cell.target.cell)) return [];
    const value = cell.data?.kind === 'edge' ? cell.data.value : undefined;
    if ((cell.vertices?.length ?? 0) > 100) throw new Error('每条连接最多允许 100 个拐点');
    const waypoints = (cell.vertices ?? []).map(p => ({ x: bounded(p.x), y: bounded(p.y) }));
    const next = { ...(value ?? { id: cell.id!.replace(/^edge:/, ''), label: '', style: 'solid' as const, direction: 'forward' as const }), from: cell.source.cell.slice(5), to: cell.target.cell.slice(5), fromPort: cell.source.port, toPort: cell.target.port, ...(value?.waypoints || waypoints.length ? { waypoints } : {}) };
    const original = edgesById.get(next.id);
    return [original && sameTopologyValue(original, next) ? original : next];
  });
    return { nodes, edges, regions: topologyRegions(base).map(value => {
      const cell = byId.get(cellId('region', value.id)); if (!cell) return value;
      const next = { ...value, ...box(cell, value), width: Math.max(100, Math.min(50000, cell.size?.width ?? value.width)), height: Math.max(80, Math.min(50000, cell.size?.height ?? value.height)) };
      return sameTopologyValue(value, next) ? value : next;
    }) };
}
