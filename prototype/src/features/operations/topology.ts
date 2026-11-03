import { edgeColor, validEdgeColor } from './edgeColors';
import type { Asset, Unit } from '../../model';
import type { Topology, TopologyEdge, TopologyNode, TopologyPoint, TopologyPort } from './types';
import { orthogonalPath, routingContext } from './orthogonal';
import { orderedRegions } from './topologyWorkbench';
import { getSquirclePath } from '../../squircleGeometry';
import { fitNodeText, iconKinds, nodeDetails, nodeIcon, nodeLayout, validIcon } from './nodeAppearance';

export const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]!));
export const topologyRegions = (topology: Topology) => topology.regions ?? [];
const nodeWidth = (node: TopologyNode) => node.width ?? 260;
const nodeHeight = (node: TopologyNode) => node.height ?? 132;
const defaultPorts: TopologyPort[] = [{ id: 'top', x: .5, y: 0 }, { id: 'right', x: 1, y: .5 }, { id: 'bottom', x: .5, y: 1 }, { id: 'left', x: 0, y: .5 }];
export const nodePorts = (node: TopologyNode): TopologyPort[] => [...new Map([...defaultPorts, ...(node.connectionPoints ?? [])].map((port) => [port.id, port])).values()];
export const portPosition = (node: TopologyNode, port: TopologyPoint): TopologyPoint => ({ x: node.x + port.x * nodeWidth(node), y: node.y + port.y * nodeHeight(node) });
export function boundaryPoint(node: TopologyNode, point: TopologyPoint): TopologyPoint {
  const x = Math.max(0, Math.min(1, (point.x - node.x) / nodeWidth(node))); const y = Math.max(0, Math.min(1, (point.y - node.y) / nodeHeight(node)));
  const distances = [y * nodeHeight(node), (1 - x) * nodeWidth(node), (1 - y) * nodeHeight(node), x * nodeWidth(node)];
  const side = distances.indexOf(Math.min(...distances));
  return { x: side === 1 ? 1 : side === 3 ? 0 : x, y: side === 0 ? 0 : side === 2 ? 1 : y };
}
let labelContext: CanvasRenderingContext2D | null | undefined;
function edgeLabelWidth(label: string) {
  if (!label) return 80;
  if (labelContext === undefined) labelContext = typeof document === 'undefined' ? null : document.createElement('canvas').getContext('2d');
  if (labelContext) labelContext.font = "12px 'Microsoft YaHei UI','Microsoft YaHei',sans-serif";
  const measured = labelContext?.measureText(label);
  return Math.max(80, Math.ceil(measured ? Math.max(measured.width, measured.actualBoundingBoxLeft + measured.actualBoundingBoxRight) : Array.from(label).length * 14) + 16);
}
export function topologyEdgePath(from: TopologyNode, to: TopologyNode, edge?: TopologyEdge, nodes: TopologyNode[] = [from, to], context?: ReturnType<typeof routingContext>) {
  const fromWidth = nodeWidth(from); const fromHeight = nodeHeight(from); const toWidth = nodeWidth(to); const toHeight = nodeHeight(to);
  const fromCenter = { x: from.x + fromWidth / 2, y: from.y + fromHeight / 2 };
  const toCenter = { x: to.x + toWidth / 2, y: to.y + toHeight / 2 };
  const dx = toCenter.x - fromCenter.x; const dy = toCenter.y - fromCenter.y;
  const fromScale = 1 / Math.max(Math.abs(dx) / (fromWidth / 2), Math.abs(dy) / (fromHeight / 2), .0001);
  const toScale = 1 / Math.max(Math.abs(dx) / (toWidth / 2), Math.abs(dy) / (toHeight / 2), .0001);
  const fromPort = nodePorts(from).find((port) => port.id === edge?.fromPort); const toPort = nodePorts(to).find((port) => port.id === edge?.toPort);
  const start = fromPort ? portPosition(from, fromPort) : { x: fromCenter.x + dx * fromScale, y: fromCenter.y + dy * fromScale };
  const end = toPort ? portPosition(to, toPort) : { x: toCenter.x - dx * toScale, y: toCenter.y - dy * toScale };
  const points = edge?.routing === 'straight' ? [start, ...(edge?.waypoints ?? []), end] : orthogonalPath(from, to, start, end, nodes, edge?.waypoints, context);
  const labelWidth = edgeLabelWidth(edge?.label ?? '');
  const labels = points.slice(0, -1).flatMap((p, index) => [-10, 20].map((offset) => {
    const next = points[index + 1]; const x = (p.x + next.x) / 2; const y = (p.y + next.y) / 2 + offset;
    const overlap = nodes.some((node) => x - labelWidth / 2 < node.x + nodeWidth(node) && x + labelWidth / 2 > node.x && y - 15 < node.y + nodeHeight(node) && y + 4 > node.y);
    return { x, y, score: Math.hypot(next.x - p.x, next.y - p.y) - (overlap ? 100000 : 0) - (offset > 0 ? 1 : 0) };
  })).sort((a, b) => b.score - a.score);
  return { x1: start.x, y1: start.y, x2: end.x, y2: end.y, points, d: points.map((point, index) => `${index ? 'L' : 'M'} ${point.x} ${point.y}`).join(' '), labelX: labels[0]?.x ?? start.x, labelY: labels[0]?.y ?? start.y, labelWidth };
}
type EdgePath = ReturnType<typeof topologyEdgePath>;
export type TopologyPathCache = { nodes: Map<string, TopologyNode>; edges: Map<string, TopologyEdge>; paths: Map<string, EdgePath> };
const sameBox = (a: TopologyNode, b: TopologyNode) => a.x === b.x && a.y === b.y && nodeWidth(a) === nodeWidth(b) && nodeHeight(a) === nodeHeight(b);
const sameAnchor = (a: TopologyNode | undefined, b: TopologyNode | undefined) => a && b && sameBox(a, b) && (a.connectionPoints === b.connectionPoints || JSON.stringify(a.connectionPoints) === JSON.stringify(b.connectionPoints));
export function buildTopologyPaths(topology: Topology, previous?: TopologyPathCache): TopologyPathCache {
  const nodes = new Map(topology.nodes.map((node) => [node.id, node])); const edges = new Map(topology.edges.map((edge) => [edge.id, edge])); const paths = new Map<string, EdgePath>();
  const changed = previous ? [...topology.nodes.filter((node) => !previous.nodes.has(node.id) || !sameBox(node, previous.nodes.get(node.id)!)), ...[...previous.nodes.values()].filter((node) => !nodes.has(node.id) || !sameBox(node, nodes.get(node.id)!))] : [];
  const first = topology.nodes[0]; const oldFirst = first && previous?.nodes.get(first.id); const dx = oldFirst ? first.x - oldFirst.x : 0; const dy = oldFirst ? first.y - oldFirst.y : 0;
  const translated = Boolean(previous && (dx || dy) && nodes.size === previous.nodes.size && topology.nodes.every((node) => { const old = previous.nodes.get(node.id); return old && node.x === old.x + dx && node.y === old.y + dy && nodeWidth(node) === nodeWidth(old) && nodeHeight(node) === nodeHeight(old) && JSON.stringify(node.connectionPoints) === JSON.stringify(old.connectionPoints); }));
  let context: ReturnType<typeof routingContext> | undefined;
  for (const edge of topology.edges) {
    const from = nodes.get(edge.from); const to = nodes.get(edge.to); if (!from || !to) continue;
    const old = previous?.edges.get(edge.id); const line = previous?.paths.get(edge.id);
    const sameRoute = old && old.from === edge.from && old.to === edge.to && old.fromPort === edge.fromPort && old.toPort === edge.toPort && old.routing === edge.routing && old.label === edge.label;
    if (line && sameRoute && translated && (old.waypoints?.length ?? 0) === (edge.waypoints?.length ?? 0) && (edge.waypoints ?? []).every((point, index) => point.x === old.waypoints![index].x + dx && point.y === old.waypoints![index].y + dy)) {
      paths.set(edge.id, { ...line, x1: line.x1 + dx, y1: line.y1 + dy, x2: line.x2 + dx, y2: line.y2 + dy, labelX: line.labelX + dx, labelY: line.labelY + dy, points: line.points.map((point) => ({ x: point.x + dx, y: point.y + dy })), d: line.points.map((point, index) => `${index ? 'L' : 'M'} ${point.x + dx} ${point.y + dy}`).join(' ') }); continue;
    }
    if (line && sameRoute && old.waypoints === edge.waypoints && sameAnchor(from, previous?.nodes.get(from.id)) && sameAnchor(to, previous?.nodes.get(to.id))) {
      let left = line.labelX - line.labelWidth / 2, right = line.labelX + line.labelWidth / 2, top = line.labelY - 15, bottom = line.labelY + 4;
      for (const point of line.points) { left = Math.min(left, point.x); right = Math.max(right, point.x); top = Math.min(top, point.y); bottom = Math.max(bottom, point.y); }
      if (!changed.some((node) => node.x - 18 <= right && node.x + nodeWidth(node) + 18 >= left && node.y - 18 <= bottom && node.y + nodeHeight(node) + 18 >= top)) { paths.set(edge.id, line); continue; }
    }
    context ??= routingContext(topology.nodes); paths.set(edge.id, topologyEdgePath(from, to, edge, topology.nodes, context));
  }
  return { nodes, edges, paths };
}
export function topologyBounds(topology: Topology, contentOnly = false, paths?: ReadonlyMap<string, EdgePath>) {
  let minX = contentOnly ? Infinity : 0, minY = contentOnly ? Infinity : 0, maxX = contentOnly ? -Infinity : 800, maxY = contentOnly ? -Infinity : 480;
  const include = (left: number, top: number, right: number, bottom: number) => { minX = Math.min(minX, left); minY = Math.min(minY, top); maxX = Math.max(maxX, right); maxY = Math.max(maxY, bottom); };
  for (const node of topology.nodes) include(node.x - 35, node.y - 35, node.x + nodeWidth(node) + 35, node.y + nodeHeight(node) + 40);
  for (const region of topologyRegions(topology)) include(region.x - 20, region.y - 40, region.x + region.width + 20, region.y + region.height + 20);
  for (const edge of topology.edges) for (const point of edge.waypoints ?? []) include(point.x - 35, point.y - 35, point.x + 35, point.y + 35);
  if (paths) for (const edge of topology.edges) {
    const line = paths.get(edge.id); if (!line) continue;
    for (const point of line.points) include(point.x - 16, point.y - 16, point.x + 16, point.y + 16);
    if (edge.label) include(line.labelX - line.labelWidth / 2 - 4, line.labelY - 21, line.labelX + line.labelWidth / 2 + 4, line.labelY + 10);
  }
  return Number.isFinite(minX) ? { x: minX, y: minY, width: Math.max(800, maxX - minX), height: Math.max(480, maxY - minY) } : { x: 0, y: 0, width: 800, height: 480 };
}
function edgeMarkup(edge: TopologyEdge, line: ReturnType<typeof topologyEdgePath> | undefined) {
  if (!line) return '';
  const marker = `arrow-${edgeColor(edge).slice(1)}`;
  const direction = edge.direction ?? 'forward';
  const arrow = `${direction === 'reverse' || direction === 'both' ? ` marker-start="url(#${marker})"` : ''}${direction === 'forward' || direction === 'both' ? ` marker-end="url(#${marker})"` : ''}`;
  const dash = edge.style === 'dashed' ? '8 6' : edge.style === 'dotted' ? '2 6' : '';
  const middleX = line.labelX; const labelY = line.labelY;
  return `<g><path d="${line.d}" fill="none" stroke="${edgeColor(edge)}" stroke-width="2"${dash ? ` stroke-dasharray="${dash}"` : ''}${arrow}/>${edge.label ? `<rect x="${middleX - line.labelWidth / 2}" y="${labelY - 17}" width="${line.labelWidth}" height="23" rx="6" fill="#f3efe5"/><text x="${middleX}" y="${labelY}" font-size="12" text-anchor="middle">${escapeHtml(edge.label)}</text>` : ''}</g>`;
}
export type TopologyExportOptions = { background: string; grid?: boolean };
const exportBackground = (options?: TopologyExportOptions) => /^#[\da-f]{6}$/i.test(options?.background ?? '') ? options!.background : '#ffffff';
let exportSequence = 0;
function renderTopologySvg(topology: Topology, assets: Asset[], units: Unit[], options: TopologyExportOptions | undefined, paths: Map<string, EdgePath>, bounds: ReturnType<typeof topologyBounds>) {
  const textPrefix = `export-text-${++exportSequence}`;
  const regions = orderedRegions(topologyRegions(topology)).map((region) => {
    const color = /^#[\da-f]{6}$/i.test(region.color) ? region.color : '#4f8160';
    return `<g transform="translate(${region.x},${region.y})"><title>${escapeHtml(region.label)}</title><path class="topology-region-surface topology-squircle" d="${getSquirclePath(region.width, region.height, 16)}" fill="${color}" fill-opacity=".08" stroke="${color}" stroke-dasharray="6 4"/><path d="M 14 18 h 20 M 14 24 h 20 M 14 30 h 20" stroke="${color}" stroke-width="2"/><text x="46" y="27" font-size="15" font-weight="700">${escapeHtml(fitNodeText(region.label, Math.max(0, region.width - 62), 15, true))}</text><line x1="12" x2="${region.width - 12}" y1="38" y2="38" stroke="${color}" opacity=".25"/></g>`;
  }).join('');
  const edges = topology.edges.map((edge) => edgeMarkup(edge, paths.get(edge.id))).join('');
  const nodes = topology.nodes.map((node, nodeIndex) => {
    const info = nodeDetails(node, assets, units); const title = info.name; const detail = `${info.host || (info.missing ? '资产关联已失效' : node.role)}\n${info.ip || '未设置 IP'}`;
    const width = nodeWidth(node); const height = nodeHeight(node); const layout = nodeLayout(node, info.tags);
    const textWidth = Math.max(0, width - 96); const clipId = `${textPrefix}-${nodeIndex}`;
    const tags = layout.badges.map((tag, index) => `<path class="topology-tag-fill topology-squircle" d="${getSquirclePath(Math.min(tag.width, textWidth + 8), 13, 6)}" transform="translate(76,${layout.tagY + index * 14 - 10})" fill="#e2eee5" stroke="#b8d2c2"/><text x="80" y="${layout.tagY + index * 14}" font-size="9" fill="#448364">${escapeHtml(fitNodeText(info.tags[index], textWidth, 9))}</text>`).join('');
    return `<g data-node="${escapeHtml(node.id)}" tabindex="0" transform="translate(${node.x},${node.y})"><path class="topology-node-surface topology-squircle" d="${getSquirclePath(width, height, 12)}" fill="#fcfdfe" stroke="${info.missing ? '#cc7760' : '#cdd6d0'}"/><title>${escapeHtml(`${title}\n${detail}\n${info.tags.join('、')}${node.note ? `\n${node.note}` : ''}`)}</title><path d="${getSquirclePath(56, 56, 10)}" transform="translate(12,${layout.iconY - 4})" fill="#edf0f3" stroke="#d6dce2" stroke-width=".6"/><image href="${escapeHtml(nodeIcon(node))}" x="16" y="${layout.iconY}" width="48" height="48"/><defs><clipPath id="${clipId}"><rect x="76" y="0" width="${Math.max(0, width - 92)}" height="${height}"/></clipPath></defs>${tags}<g clip-path="url(#${clipId})"><text x="80" y="${layout.textY}" font-size="15" font-weight="700">${escapeHtml(fitNodeText(title, textWidth, 15, true))}</text><text x="80" y="${layout.textY + 22}" font-size="12" fill="#756e61">${escapeHtml(fitNodeText(info.host || (info.missing ? '资产关联已失效' : node.role), textWidth, 12))}</text><text x="80" y="${layout.textY + 42}" font-size="12" fill="#756e61">${escapeHtml(fitNodeText(info.ip || '未设置 IP', textWidth, 12))}</text>${layout.notes.map((line, index) => `<text x="80" y="${layout.noteY + index * 14}" font-size="11" fill="#756e61">${escapeHtml(fitNodeText(line, textWidth, 11))}</text>`).join('')}</g></g>`;
  }).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${bounds.width}" height="${bounds.height}" viewBox="${bounds.x} ${bounds.y} ${bounds.width} ${bounds.height}" style="font-family:'Microsoft YaHei UI','Microsoft YaHei',sans-serif;fill:#302c24"><style>.topology-squircle{filter:drop-shadow(0 0 .5px #3037401f) drop-shadow(0 0 2px #3037400f)}</style><rect id="topology-background" x="${bounds.x}" y="${bounds.y}" width="${bounds.width}" height="${bounds.height}" fill="${exportBackground(options)}"/>${options?.grid ? `<defs><pattern id="export-grid" width="20" height="20" patternUnits="userSpaceOnUse"><path d="M20 0H0V20" fill="none" stroke="#aab9ad" stroke-opacity=".3" stroke-width=".7"/></pattern></defs><rect x="${bounds.x}" y="${bounds.y}" width="${bounds.width}" height="${bounds.height}" fill="url(#export-grid)"/>` : ''}<defs>${[...new Set(topology.edges.map(edgeColor))].map((color) => `<marker id="arrow-${color.slice(1)}" markerWidth="8" markerHeight="8" refX="5" refY="3" orient="auto-start-reverse"><path d="M0,0 L0,6 L6,3 z" fill="${color}"/></marker>`).join('')}</defs>${regions}${edges}${nodes}</svg>`;
}
export function topologySvg(topology: Topology, assets: Asset[], units: Unit[] = [], options?: TopologyExportOptions) {
  const paths = buildTopologyPaths(topology).paths;
  return renderTopologySvg(topology, assets, units, options, paths, topologyBounds(topology, false, paths));
}
export function topologyHtml(title: string, topology: Topology, assets: Asset[], units: Unit[] = [], options?: TopologyExportOptions) {
  const svg = topologySvg(topology, assets, units, options);
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>body{margin:0;background:${exportBackground(options)};color:#302c24;font-family:'Microsoft YaHei UI','Microsoft YaHei',sans-serif}header{padding:16px;display:flex;gap:12px;align-items:center;flex-wrap:wrap}h1{font-size:20px;margin:0}button{padding:8px 16px;border:1px solid #dcd5c8;border-radius:20px;background:#fffcf5;cursor:pointer}main{overflow:auto;height:calc(100vh - 85px)}svg{display:block;transform-origin:top left}g[data-node]{cursor:pointer}g[data-node]:focus .topology-node-surface{stroke-width:3;stroke:#287eb2}#detail{white-space:pre-line}</style><header><h1>${escapeHtml(title)}</h1><button id="out">缩小</button><button id="in">放大</button><button id="reset">还原</button><span id="detail">点击节点查看信息；此文件可离线打开。</span></header><main>${svg}</main><script>const svg=document.querySelector('svg');let zoom=1;function resize(){svg.style.width=Number(svg.getAttribute('width'))*zoom+'px';svg.style.height=Number(svg.getAttribute('height'))*zoom+'px'}document.getElementById('in').onclick=()=>{zoom=Math.min(3,zoom+.2);resize()};document.getElementById('out').onclick=()=>{zoom=Math.max(.2,zoom-.2);resize()};document.getElementById('reset').onclick=()=>{zoom=1;resize()};document.querySelectorAll('g[data-node]').forEach(node=>{const show=()=>document.getElementById('detail').textContent=node.querySelector('title').textContent;node.onclick=show;node.onkeydown=e=>{if(e.key==='Enter')show()}});</script></html>`;
}
export async function topologyPng(topology: Topology, assets: Asset[], units: Unit[] = [], options?: TopologyExportOptions) {
  const paths = buildTopologyPaths(topology).paths;
  const bounds = topologyBounds(topology, false, paths); const maxSide = 12000;
  const scale = Math.min(2, maxSide / bounds.width, maxSide / bounds.height, Math.sqrt(32_000_000 / (bounds.width * bounds.height)));
  const { renderTopologyPng } = await import('./pngRenderer');
  return renderTopologyPng(renderTopologySvg(topology, assets, units, options, paths, bounds), Math.ceil(bounds.width * scale), Math.ceil(bounds.height * scale));
}
export function parseTopology(text: string): Topology {
  const raw = JSON.parse(text);
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.nodes) || !Array.isArray(raw.edges) || raw.nodes.length > 1000 || raw.edges.length > 5000) throw new Error('拓扑需要 nodes／edges 数组，最多 1000 个节点、5000 条连接');
  const validPort = (port: TopologyPort) => port && typeof port.id === 'string' && port.id && Number.isFinite(port.x) && Number.isFinite(port.y) && port.x >= 0 && port.x <= 1 && port.y >= 0 && port.y <= 1 && (port.x === 0 || port.x === 1 || port.y === 0 || port.y === 1);
  const validPoint = (point: TopologyPoint) => point && Number.isFinite(point.x) && Number.isFinite(point.y) && Math.abs(point.x) <= 50000 && Math.abs(point.y) <= 50000;
  const nodeIds = new Set<string>();
  for (const node of raw.nodes) {
    if (!node || typeof node !== 'object' || typeof node.id !== 'string' || !node.id || nodeIds.has(node.id) || !Number.isFinite(node.x) || !Number.isFinite(node.y) || Math.abs(node.x) > 50000 || Math.abs(node.y) > 50000 || typeof node.label !== 'string' || typeof node.role !== 'string' || (node.width !== undefined && (!Number.isFinite(node.width) || node.width < 160 || node.width > 1000)) || (node.height !== undefined && (!Number.isFinite(node.height) || node.height < 100 || node.height > 800)) || (node.assetId !== undefined && typeof node.assetId !== 'string') || (node.note !== undefined && typeof node.note !== 'string')) throw new Error('拓扑节点标识、坐标、尺寸或内容无效');
    if (node.connectionPoints !== undefined && (!Array.isArray(node.connectionPoints) || node.connectionPoints.length > 100 || node.connectionPoints.some((port: TopologyPort) => !validPort(port)) || new Set(node.connectionPoints.map((port: TopologyPort) => port.id)).size !== node.connectionPoints.length)) throw new Error('节点连接点需要唯一标识和有效边缘位置');
    if ((node.iconKind !== undefined && !Object.hasOwn(iconKinds, node.iconKind)) || (node.customIcon !== undefined && (typeof node.customIcon !== 'string' || !validIcon(node.customIcon))) || (node.tags !== undefined && (!Array.isArray(node.tags) || node.tags.length > 20 || node.tags.some((tag: unknown) => typeof tag !== 'string' || tag.length > 64))) || ['host', 'ip', 'environment'].some((key) => node[key] !== undefined && (typeof node[key] !== 'string' || node[key].length > 128))) throw new Error('节点图标、标签或信息无效');
    nodeIds.add(node.id);
  }
  const regions: unknown[] = raw.regions ?? [];
  if (!Array.isArray(regions) || regions.length > 500) throw new Error('拓扑区域过多或格式无效');
  for (const region of regions) {
    if (!region || typeof region !== 'object') throw new Error('拓扑区域坐标、尺寸、颜色或内容无效');
    const item = region as Record<string, unknown>;
    if (typeof item.id !== 'string' || !item.id || typeof item.label !== 'string' || !['x', 'y', 'width', 'height'].every((key) => typeof item[key] === 'number' && Number.isFinite(item[key])) || Number(item.width) < 100 || Number(item.height) < 80 || Number(item.width) > 50000 || Number(item.height) > 50000 || Math.abs(Number(item.x)) > 50000 || Math.abs(Number(item.y)) > 50000 || typeof item.color !== 'string' || !/^#[\da-f]{6}$/i.test(item.color)) throw new Error('拓扑区域坐标、尺寸、颜色或内容无效');
  }
  const edgeIds = new Set<string>();
  for (const edge of raw.edges) {
    if (!edge || typeof edge !== 'object' || typeof edge.id !== 'string' || !edge.id || edgeIds.has(edge.id) || !nodeIds.has(edge.from) || !nodeIds.has(edge.to) || edge.from === edge.to || typeof edge.label !== 'string' || (edge.style !== undefined && !['solid', 'dashed', 'dotted'].includes(edge.style)) || (edge.direction !== undefined && !['none', 'forward', 'reverse', 'both'].includes(edge.direction))) throw new Error('拓扑连接无效');
    if ((edge.waypoints !== undefined && (!Array.isArray(edge.waypoints) || edge.waypoints.length > 100 || edge.waypoints.some((point: TopologyPoint) => !validPoint(point)))) || [ ['from', 'fromPort'], ['to', 'toPort'] ].some(([nodeKey, portKey]) => edge[portKey] !== undefined && !nodePorts(raw.nodes.find((node: TopologyNode) => node.id === edge[nodeKey])).some((port) => port.id === edge[portKey]))) throw new Error('连线路径或连接点无效');
    if (edge.color !== undefined && !validEdgeColor(edge.color)) throw new Error('连线颜色无效');
    if (edge.routing !== undefined && !['orthogonal', 'straight'].includes(edge.routing)) throw new Error('连线走线方式无效');
    edgeIds.add(edge.id);
  }
  const regionIds = new Set<string>();
  for (const region of regions as Array<{ id: string }>) { if (regionIds.has(region.id)) throw new Error('拓扑区域标识重复'); regionIds.add(region.id); }
  const parents = new Map((regions as NonNullable<Topology['regions']>).map(region => [region.id, region.parentId]));
  for (const region of regions as NonNullable<Topology['regions']>) {
    if (region.parentId !== undefined && (typeof region.parentId !== 'string' || !regionIds.has(region.parentId))) throw new Error('分组的上级不存在');
    const seen = new Set([region.id]); let parent = region.parentId;
    while (parent) { if (seen.has(parent)) throw new Error('分组不能循环嵌套'); seen.add(parent); parent = parents.get(parent); }
  }
  return {
    regions: (regions as NonNullable<Topology['regions']>).map(({ id, label, x, y, width, height, color, parentId }) => ({ id, label, x, y, width, height, color, ...(parentId ? { parentId } : {}) })),
    nodes: raw.nodes.map(({ id, assetId, label, role, x, y, width, height, note, regionId, connectionPoints, iconKind, customIcon, tags, host, ip, environment }: TopologyNode) => ({ id, ...(assetId ? { assetId } : {}), label, role, x, y, ...(width !== undefined ? { width } : {}), ...(height !== undefined ? { height } : {}), ...(note ? { note } : {}), ...(regionId === '' || regionIds.has(regionId ?? '') ? { regionId } : {}), ...(connectionPoints ? { connectionPoints: connectionPoints.map(({ id, x, y }) => ({ id, x, y })) } : {}), ...(iconKind ? { iconKind } : {}), ...(customIcon ? { customIcon } : {}), ...(tags ? { tags } : {}), ...(host ? { host } : {}), ...(ip ? { ip } : {}), ...(environment ? { environment } : {}) })),
    edges: raw.edges.map(({ id, from, to, label, style, direction, fromPort, toPort, waypoints, routing, color }: TopologyEdge) => ({ id, from, to, label, ...(style ? { style } : {}), ...(direction ? { direction } : {}), ...(fromPort ? { fromPort } : {}), ...(toPort ? { toPort } : {}), ...(waypoints ? { waypoints: waypoints.map(({ x, y }) => ({ x, y })) } : {}), ...(routing ? { routing } : {}), ...(color ? { color: color.toLowerCase() } : {}) })),
  };
}
