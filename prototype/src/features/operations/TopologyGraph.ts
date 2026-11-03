import { Graph, MiniMap, Selection, Snapline, Transform, type Cell, type CellView, type Node, type NodeMetadata } from '@antv/x6';
import type { Asset, Unit } from '../../model';
import { boundaryPoint, topologyBounds, topologyRegions } from './topology';
import { sameTopology, sameTopologyValue } from './topologyEquality';
import type { Topology, TopologyPoint } from './types';
import { nodeDetails, nodeDetailsIndex } from './nodeAppearance';
import { orderedRegions, type EditorTool } from './topologyWorkbench';
import { cellId, edgeCell, readGraphCells, regionCell, serverCell, type CellData } from './x6Model';

export type GraphSelection = { nodes: string[]; edge?: string; region?: string };
type Callbacks = { change: (value: Topology) => void; selection: (selection: GraphSelection) => void; zoom: (zoom: number) => void; connect?: (id: string) => void; rejected?: (reason: string) => void };

export class TopologyGraph {
  readonly graph: Graph;
  private value: Topology = { nodes: [], edges: [], regions: [] };
  private assets: Asset[] = [];
  private units: Unit[] = [];
  private detailsIndex = nodeDetailsIndex([], []);
  private selectedRegion?: string;
  private regionSignature = '';
  private syncing = false;
  private pressed = false;
  private dirty = false;
  private frame = 0;
  private rendered = new Map<string, CellData['value']>();
  private snapEnabled = true;
  private spacePressed = false;
  private tool: EditorTool = 'select';
  private regionBackground = false;
  private disposed = false;
  private gridKind: 'square' | 'dots' | 'none' = 'square';
  private readonly themeObserver: MutationObserver;
  private readonly resizeObserver: ResizeObserver;
  private portDrag?: { node: Node; port: string };
  movingPort?: { nodeId: string; portId: string };
  private readonly snapline: Snapline;
  private readonly transform: Transform;
  private readonly selection: Selection;

  constructor(private container: HTMLDivElement, overview: HTMLDivElement, private callbacks: Callbacks) {
    const graph: Graph = this.graph = new Graph({ container, width: container.clientWidth || 800, height: container.clientHeight || 480, grid: { size: 20, visible: true }, background: { color: 'transparent' }, async: true, virtual: true,
      scaling: { min: .01, max: 3 }, panning: { enabled: true, eventTypes: ['mouseWheelDown', 'mouseWheel'] },
      mousewheel: { enabled: true, modifiers: ['ctrl', 'meta'], minScale: .01, maxScale: 3, zoomAtMousePosition: true },
      translating: { restrict: view => this.movementArea(view) },
      connecting: { allowBlank: false, allowLoop: false, allowEdge: false, allowNode: true, allowPort: true, snap: { radius: 16 }, highlight: true,
        router: { name: 'manhattan', args: { padding: 18 } }, connectionPoint: 'boundary',
        createEdge: () => graph.createEdge(edgeCell({ id: crypto.randomUUID(), from: '', to: '', label: '', style: 'solid', direction: 'forward' }, topologyRegions(this.value).map(r => cellId('region', r.id)))),
        validateMagnet: ({ cell }) => cell.getData<CellData>()?.kind === 'node' && this.value.edges.length < 5000,
        validateConnection: ({ targetCell, sourceCell }) => targetCell?.getData<CellData>()?.kind === 'node' && targetCell !== sourceCell,
      },
      embedding: { enabled: true, findParent: ({ node }) => graph.getNodes().filter(parent => parent !== node && !node.isAncestorOf(parent) && parent.getData<CellData>()?.kind === 'region' && parent.getBBox().containsRect(node.getBBox())).sort((a, b) => a.size().width * a.size().height - b.size().width * b.size().height).slice(0, 1), validate: ({ child, parent }) => child !== parent && !child.isAncestorOf(parent) && parent.getData<CellData>()?.kind === 'region' },
      interacting: () => ({ nodeMovable: this.tool === 'select' && !this.regionBackground && !this.spacePressed && !this.portDrag && !this.movingPort, edgeLabelMovable: false, vertexAddable: true, vertexMovable: true, vertexDeletable: true, arrowheadMovable: true, magnetConnectable: this.tool !== 'pan' && !this.spacePressed && !this.portDrag && !this.movingPort, useEdgeTools: true }),
    });
    this.selection = new Selection({ enabled: true, multiple: true, rubberband: true, rubberNode: true, rubberEdge: false, modifiers: null, multipleSelectionModifiers: ['ctrl', 'meta', 'shift'], eventTypes: ['leftMouseDown'], showNodeSelectionBox: false, showEdgeSelectionBox: false, movingRouterFallback: 'orth', filter: cell => cell.getData<CellData>()?.kind !== 'region' });
    this.snapline = new Snapline({ enabled: true, tolerance: 6 });
    this.transform = new Transform({ resizing: { enabled: true, minWidth: 160, minHeight: node => node.getData<CellData>()?.kind === 'region' ? 120 : 100, maxWidth: node => node.getData<CellData>()?.kind === 'region' ? 50000 : 1000, maxHeight: node => node.getData<CellData>()?.kind === 'region' ? 50000 : 800 }, rotating: false });
    graph.use(this.selection).use(this.snapline).use(this.transform).use(new MiniMap({ container: overview, width: 174, height: 104, padding: 10, scalable: false, graphOptions: { createCellView: cell => cell.isEdge() ? null : undefined } }));
    graph.on('scale', ({ sx }) => { callbacks.zoom(sx); this.drawUnsnappedGrid(); });
    graph.on('translate', () => this.drawUnsnappedGrid());
    graph.on('selection:changed', ({ selected }) => {
      if (this.syncing) return;
      this.selectedRegion = undefined;
      const data = selected.map(cell => cell.getData<CellData>());
      callbacks.selection({ nodes: data.flatMap(d => d?.kind === 'node' ? [d.value.id] : []), edge: data.length === 1 && data[0]?.kind === 'edge' ? data[0].value.id : undefined });
      this.decorateSelection();
    });
    graph.on('node:click', ({ node }) => { const data = node.getData<CellData>(); if (data?.kind === 'node' && this.tool === 'connect') callbacks.connect?.(data.value.id); else if (data?.kind === 'region' && this.tool !== 'pan') this.select({ nodes: [], region: data.value.id }); });
    graph.on('node:unhandled:mousedown', ({ e, x, y }) => { if (this.regionBackground && !this.spacePressed && this.tool === 'select') graph.trigger('blank:mousedown', { e, x, y }); });
    graph.on('blank:click', () => this.select({ nodes: [] }));
    graph.on('view:mounted', ({ view }) => this.decorate(view.cell));
    graph.on('cell:changed', () => { if (!this.syncing) { this.dirty = true; this.schedule(); } });
    graph.on('cell:removed', () => { if (!this.syncing) { this.dirty = true; this.schedule(); } });
    graph.on('edge:connected', () => { this.dirty = true; this.schedule(); });
    graph.on('node:embedded', ({ node, currentParent }) => {
      const data = node.getData<CellData>(); if (this.syncing || !data || data.kind === 'edge') return;
      const parent = currentParent?.getData<CellData>();
      node.setData({ ...data, value: { ...data.value, ...(data.kind === 'node' ? { regionId: parent?.kind === 'region' ? parent.value.id : '' } : { parentId: parent?.kind === 'region' ? parent.value.id : undefined }) } });
      this.dirty = true;
    });
    graph.on('node:change:size', ({ node }) => { if (!this.syncing) this.appearance(node); });
    container.addEventListener('mousedown', this.down, true);
    document.addEventListener('mousedown', this.commitPending, true);
    document.addEventListener('mousemove', this.movePort, true);
    document.addEventListener('mouseup', this.up, true);
    window.addEventListener('blur', this.cancel);
    this.themeObserver = new MutationObserver(() => this.grid(this.gridKind, this.snapEnabled));
    this.themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    this.resizeObserver = new ResizeObserver(([entry]) => { const { width, height } = entry.contentRect; if (width > 0 && height > 0) graph.resize(width, height); });
    this.resizeObserver.observe(container.parentElement!);
  }

  private down = (event: MouseEvent) => {
    if (event.button !== 0) return;
    const target = event.target as Element, port = target.closest('[port]')?.getAttribute('port');
    if (target.closest('.x6-edge-tool-source-arrowhead, .x6-edge-tool-target-arrowhead')) this.container.closest<HTMLElement>('.topology-viewport')?.focus({ preventScroll: true });
    const regionId = target.closest('[data-region-id]')?.getAttribute('data-region-id');
    const region = this.value.regions?.find(region => region.id === regionId);
    this.regionBackground = Boolean(region && this.point(event.clientX, event.clientY).y > region.y + 38);
    const id = target.closest('[data-node-id]')?.getAttribute('data-node-id');
    if (port && id && (event.altKey || this.movingPort?.nodeId === id && this.movingPort.portId === port)) {
      const node = this.graph.getCellById(cellId('node', id)) as Node;
      const value = this.value.nodes.find(n => n.id === id)!;
      if ((value.connectionPoints?.length ?? 0) >= 100 && !value.connectionPoints?.some(p => p.id === port)) { event.stopImmediatePropagation(); event.preventDefault(); return; }
      this.portDrag = { node, port }; this.movingPort = undefined;
      event.stopImmediatePropagation(); event.preventDefault();
    }
    this.pressed = true;
    if (event.altKey) { this.snapline.disable(); this.graph.setGridSize(1); }
  };
  private commitPending = () => { if (!this.pressed) this.flush(); };
  private movePort = (event: MouseEvent) => {
    const drag = this.portDrag; if (!drag) return;
    event.preventDefault(); const position = this.graph.clientToLocal(event.clientX, event.clientY), box = drag.node.getBBox();
    const p = boundaryPoint({ id: '', label: '', role: '', x: box.x, y: box.y, width: box.width, height: box.height }, position);
    drag.node.portProp(drag.port, 'args', { x: `${p.x * 100}%`, y: `${p.y * 100}%` });
    this.dirty = true;
  };
  private up = () => {
    if (!this.pressed && !this.portDrag) return;
    if (this.portDrag) {
      const { node, port } = this.portDrag, data = node.getData<CellData>();
      if (data?.kind === 'node' && this.dirty) {
        const args = node.getPort(port)?.args as { x: string; y: string };
        node.setData({ ...data, value: { ...data.value, connectionPoints: [...(data.value.connectionPoints ?? []).filter(p => p.id !== port), { id: port, x: parseFloat(args.x) / 100, y: parseFloat(args.y) / 100 }] } });
      }
      this.portDrag = undefined;
    }
    this.pressed = false; this.grid(this.gridKind, this.snapEnabled); this.schedule();
  };
  private schedule() {
    if (this.disposed || this.frame) return;
    this.frame = requestAnimationFrame(() => { this.frame = 0; if (!this.pressed) this.flush(); });
  }
  private movementArea(view?: CellView | null) {
    const roots = view && !this.graph.isSelected(view.cell) ? [view.cell] : this.graph.getSelectedCells();
    const moving = new Map(roots.flatMap(cell => [cell, ...cell.getDescendants({ deep: true })]).filter(cell => cell.isNode()).map(cell => [cell.id, cell as Node]));
    if (!moving.size) return null;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    const include = (point: TopologyPoint) => { minX = Math.min(minX, point.x); minY = Math.min(minY, point.y); maxX = Math.max(maxX, point.x); maxY = Math.max(maxY, point.y); };
    for (const node of moving.values()) include(node.position());
    for (const edge of this.graph.getEdges()) if (moving.has(edge.getSourceCellId()!) && moving.has(edge.getTargetCellId()!)) for (const point of edge.getVertices()) include(point);
    const box = view?.cell.isNode() ? view.cell.getBBox({ deep: true }) : this.graph.getCellsBBox(roots);
    if (!box) return null;
    return { x: box.x - 50000 - minX, y: box.y - 50000 - minY, width: box.width + 100000 - maxX + minX, height: box.height + 100000 - maxY + minY };
  }
  flush() {
    if (this.disposed || !this.dirty || this.syncing) return;
    this.dirty = false;
    const edges = this.graph.getEdges();
    const existing = new Set(this.value.edges.map(edge => cellId('edge', edge.id)));
    const incomplete = edges.some(edge => existing.has(edge.id) && [edge.getSourceCell(), edge.getTargetCell()].some(node => node?.getData<CellData>()?.kind !== 'node'));
    const outside = (point: TopologyPoint) => !Number.isFinite(point.x) || !Number.isFinite(point.y) || Math.abs(point.x) > 50000 || Math.abs(point.y) > 50000;
    const rejected = this.graph.getNodes().some(node => outside(node.position())) || edges.some(edge => edge.getVertices().some(outside)) ? '坐标不能超出 ±50000，已恢复本次调整' : edges.some(edge => edge.getVertices().length > 100) ? '每条连接最多允许 100 个拐点，已恢复原路径' : edges.some(edge => [edge.getSource(), edge.getTarget()].some(terminal => 'anchor' in terminal && terminal.anchor)) ? '该端点调整无法保存，已恢复原路径；请使用连接点或拐点调整' : incomplete ? '连接调整未完成，已恢复原连接' : undefined;
    if (rejected) { this.sync(this.value, this.assets, this.units, true); this.callbacks.rejected?.(rejected); return; }
    const base = { ...this.value, nodes: this.value.nodes.map(value => { const data = this.graph.getCellById(cellId('node', value.id))?.getData<CellData>(); return data?.kind === 'node' && !sameTopologyValue(value, data.value) ? data.value : value; }), regions: topologyRegions(this.value).map(value => { const data = this.graph.getCellById(cellId('region', value.id))?.getData<CellData>(); return data?.kind === 'region' && !sameTopologyValue(value, data.value) ? data.value : value; }) };
    const next = readGraphCells(base, this.graph.getCells().map(cell => ({ id: cell.id, data: cell.getData<CellData>(), ...(cell.isNode() ? { position: cell.position(), size: cell.size() } : cell.isEdge() ? { source: { cell: cell.getSourceCellId(), port: cell.getSourcePortId() }, target: { cell: cell.getTargetCellId(), port: cell.getTargetPortId() }, vertices: cell.getVertices() } : {}) })));
    if (!sameTopology(this.value, next)) this.callbacks.change(next);
  }
  cancel = () => {
    const changed = this.dirty || this.pressed || Boolean(this.portDrag);
    if (this.pressed) {
      // End X6's document gesture before restoring the business snapshot.
      this.syncing = true;
      try { document.body.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })); } finally { this.syncing = false; }
    }
    this.spacePan(false);
    this.pressed = false; this.portDrag = undefined; this.movingPort = undefined; this.dirty = false;
    if (changed) this.sync(this.value, this.assets, this.units, true);
  };
  private appearance(node: Node) {
    const data = node.getData<CellData>(); if (!data || data.kind === 'edge') return;
    const size = node.size(), value = { ...data.value, ...size };
    const meta = data.kind === 'node' ? serverCell(value as typeof data.value, this.detailsIndex, this.units) : regionCell(value as typeof data.value);
    node.setMarkup(meta.markup!); node.setAttrs(meta.attrs!, { overwrite: true });
  }
  private parent(cell: Cell, parent: Cell | null) {
    if (cell.getParentId() === parent?.id && (!parent || parent.getChildren()?.includes(cell))) return;
    cell.getParent()?.unembed(cell);
    cell.setParent(null);
    if (parent && !cell.isAncestorOf(parent)) parent.embed(cell);
  }
  sync(value: Topology, assets: Asset[], units: Unit[], force = false) {
    const appearanceChanged = this.assets !== assets || this.units !== units;
    if (appearanceChanged) this.detailsIndex = nodeDetailsIndex(assets, units);
    this.value = value; this.assets = assets; this.units = units;
    this.syncing = true;
    try {
      const ids = new Set([...value.nodes.map(n => cellId('node', n.id)), ...value.edges.map(e => cellId('edge', e.id)), ...topologyRegions(value).map(r => cellId('region', r.id))]);
      const previous = this.graph.getCells(), retained = previous.filter(cell => ids.has(cell.id));
      const bulk = previous.length - retained.length + ids.size - retained.length > 50;
      for (const cell of retained) if (cell.getParentId() && !ids.has(cell.getParentId()!)) this.parent(cell, null);
      for (const cell of previous) if (!ids.has(cell.id)) { if (!bulk) this.graph.removeCell(cell, { disconnectEdges: false, deep: false }); this.rendered.delete(cell.id); }
      const additions: Cell[] = [];
      const regions = orderedRegions(topologyRegions(value)), regionIds = regions.map(r => cellId('region', r.id));
      const regionSignature = JSON.stringify(regionIds), regionsChanged = this.regionSignature !== regionSignature;
      for (const item of [...regions.map(r => ({ kind: 'region' as const, value: r })), ...value.nodes.map(n => ({ kind: 'node' as const, value: n })), ...value.edges.map(e => ({ kind: 'edge' as const, value: e }))]) {
        const id = cellId(item.kind, item.value.id), current = this.graph.getCellById(id);
        if (!force && current && this.rendered.get(id) === item.value && !(appearanceChanged && item.kind === 'node') && !(regionsChanged && item.kind === 'edge')) continue;
        const previousValue = this.rendered.get(id);
        if (!force && current?.isNode() && item.kind !== 'edge' && !(appearanceChanged && item.kind === 'node') && previousValue && sameTopologyValue({ ...previousValue, x: item.value.x, y: item.value.y }, item.value)) {
          current.position(item.value.x, item.value.y); current.setData(item, { overwrite: true });
          this.rendered.set(id, item.value);
          continue;
        }
        const meta = item.kind === 'node' ? serverCell(item.value, this.detailsIndex, units) : item.kind === 'region' ? regionCell(item.value) : edgeCell(item.value, regionIds);
        if (!current) {
          const added = item.kind === 'edge' ? this.graph.createEdge(meta) : this.graph.createNode(meta);
          added.setAttrs(meta.attrs!, { overwrite: true });
          if (bulk) additions.push(added); else this.graph.addCell(added);
        }
        else if (current.isNode()) {
          const n = meta as NodeMetadata;
          current.position(n.x!, n.y!); current.resize(n.width!, n.height!);
          current.setMarkup(n.markup!); current.setAttrs(n.attrs!, { overwrite: true }); current.setData(n.data, { overwrite: true });
          if (n.ports) current.setProp('ports', n.ports);
        } else if (current.isEdge() && item.kind === 'edge') {
          const e = edgeCell(item.value, regionIds);
          current.setSource({ cell: cellId('node', item.value.from), port: item.value.fromPort }, { rewrite: true }); current.setTarget({ cell: cellId('node', item.value.to), port: item.value.toPort }, { rewrite: true });
          current.setVertices(item.value.waypoints ?? []); current.setRouter(e.router!); current.setConnector(e.connector!); current.setAttrs(e.attrs!, { overwrite: true }); current.setLabels(e.labels ?? []); current.setData(e.data, { overwrite: true });
        }
        this.rendered.set(id, item.value);
      }
      // X6 disposes old cells during reset; retain their values in fresh instances.
      if (bulk) this.graph.resetCells([...retained.map(cell => cell.clone({ keepId: true })), ...additions]);
      this.regionSignature = regionSignature;
      for (const [index, region] of regions.entries()) {
        const cell = this.graph.getCellById(cellId('region', region.id)), parent = region.parentId ? this.graph.getCellById(cellId('region', region.parentId)) : null;
        if (cell) this.parent(cell, parent);
        cell?.setZIndex(index - 500);
      }
      for (const valueNode of value.nodes) {
        const cell = this.graph.getCellById(cellId('node', valueNode.id));
        const parent = regions.find(r => r.id === valueNode.regionId) ?? (valueNode.regionId === undefined ? regions.filter(r => valueNode.x >= r.x && valueNode.y >= r.y && valueNode.x + (valueNode.width ?? 260) <= r.x + r.width && valueNode.y + (valueNode.height ?? 132) <= r.y + r.height).sort((a,b) => a.width * a.height - b.width * b.height)[0] : undefined);
        const parentCell = parent ? this.graph.getCellById(cellId('region', parent.id)) : null;
        if (cell) this.parent(cell, parentCell);
      }
      for (const edge of this.graph.getEdges()) this.parent(edge, edge.updateParent());
      if (bulk && this.container.parentElement!.clientWidth > 0) this.graph.resize(this.container.parentElement!.clientWidth, this.container.parentElement!.clientHeight);
      this.graph.getCells().forEach(cell => this.decorate(cell));
    } finally { this.syncing = false; }
  }
  select(selection: GraphSelection) {
    this.selectedRegion = selection.region;
    const cells = [...selection.nodes.map(id => this.graph.getCellById(cellId('node', id))), selection.edge ? this.graph.getCellById(cellId('edge', selection.edge)) : undefined].filter((c): c is Cell => Boolean(c));
    const syncing = this.syncing; this.syncing = true;
    try { this.graph.resetSelection(cells); } finally { this.syncing = syncing; }
    this.transform.clearWidgets();
    if (selection.region && this.tool === 'select') { const cell = this.graph.getCellById(cellId('region', selection.region)); if (cell?.isNode()) this.transform.createWidget(cell); }
    else if (cells.length === 1 && cells[0].isNode() && this.tool === 'select') this.transform.createWidget(cells[0]);
    this.callbacks.selection(selection); this.decorateSelection(selection.region);
  }
  private decorate(cell: Cell) {
    const view = this.graph.findViewByCell(cell), data = cell.getData<CellData>(); if (!view || !data) return;
    view.container.classList.add(`topology-${data.kind}`);
    view.container.classList.toggle('is-missing', data.kind === 'node' && nodeDetails(data.value, this.detailsIndex).missing);
    view.container.classList.toggle('is-selected', this.graph.isSelected(cell) || data.kind === 'region' && this.selectedRegion === data.value.id);
    view.container.setAttribute(`data-${data.kind}-id`, data.value.id);
    view.container.setAttribute('tabindex', '0'); view.container.setAttribute('role', 'button');
    const label = data.kind === 'node' ? nodeDetails(data.value, this.detailsIndex).name : data.value.label;
    view.container.setAttribute('aria-label', `${label || '未备注'}${data.kind === 'node' ? '拓扑节点' : data.kind === 'region' ? '拓扑区域' : '连线'}`);
    if (cell.isEdge()) {
      if (this.graph.isSelected(cell) && this.tool === 'select') { if (!cell.hasTools()) cell.addTools([{ name: 'vertices' }, { name: 'segments' }, { name: 'source-arrowhead' }, { name: 'target-arrowhead' }]); }
      else cell.removeTools();
    }
  }
  private decorateSelection(region?: string) {
    for (const cell of this.graph.getCells()) { const view = this.graph.findViewByCell(cell); view?.container.classList.toggle('is-selected', this.graph.isSelected(cell) || cell.id === cellId('region', region ?? '')); if (cell.isEdge()) this.decorate(cell); }
  }
  point(x: number, y: number): TopologyPoint { const p = this.graph.clientToLocal(x, y); return { x: p.x, y: p.y }; }
  setTool(tool: EditorTool) { this.tool = tool; this.spacePan(false); this.transform.clearWidgets(); if (tool === 'select') { const cells = this.graph.getSelectedCells(), cell = this.selectedRegion ? this.graph.getCellById(cellId('region', this.selectedRegion)) : cells.length === 1 ? cells[0] : undefined; if (cell?.isNode()) this.transform.createWidget(cell); } this.decorateSelection(this.selectedRegion); }
  spacePan(enabled: boolean) { this.spacePressed = enabled; const pan = enabled || this.tool === 'pan'; this.graph.options.panning.eventTypes = pan ? ['leftMouseDown', 'mouseWheelDown', 'mouseWheel'] : ['mouseWheelDown', 'mouseWheel']; this.selection.toggleRubberband(!pan && this.tool === 'select'); }
  open() { if (this.value.nodes.length > 100 || this.value.edges.length > 500) { const b = topologyBounds(this.value, true); this.graph.translate(32 - b.x, 96 - b.y); } else this.fit(); }
  fit() {
    if (this.disposed) return;
    const host = this.container.parentElement!;
    if (host.clientWidth <= 0 || host.clientHeight <= 0) return;
    this.graph.resize(host.clientWidth, host.clientHeight);
    this.graph.zoomToFit({ padding: { top: 24, right: 32, bottom: 24, left: 32 }, maxScale: 2, minScale: .01, contentArea: topologyBounds(this.value, true) });
  }
  zoom(value: number) { this.graph.zoomTo(Math.max(.01, Math.min(3, value))); }
  locate(id: string) { const cell = this.graph.getCellById(cellId('node', id)); if (cell) { if (this.graph.zoom() < .65) this.zoom(.65); this.graph.centerCell(cell); this.select({ nodes: [id] }); } }
  locateRegion(id: string) { const cell = this.graph.getCellById(cellId('region', id)); if (cell) { this.graph.centerCell(cell); this.select({ nodes: [], region: id }); } }
  grid(kind: 'square' | 'dots' | 'none', snap: boolean) { this.gridKind = kind; this.snapEnabled = snap; this.graph.setGridSize(snap ? 20 : 1); if (kind === 'none') this.graph.clearGrid(); else this.graph.drawGrid({ type: kind === 'square' ? 'mesh' : 'dot', args: { color: getComputedStyle(this.container).getPropertyValue('--line').trim(), thickness: 1 } }); this.snapline.toggleEnabled(snap); this.drawUnsnappedGrid(); }
  private drawUnsnappedGrid() {
    const style = this.container.style;
    if (this.snapEnabled || this.gridKind === 'none') { style.backgroundImage = ''; return; }
    const matrix = this.graph.matrix(), spacing = 20 * matrix.a;
    style.backgroundImage = this.gridKind === 'dots' ? 'radial-gradient(circle, var(--line) 1px, transparent 1px)' : 'linear-gradient(to right, var(--line) 1px, transparent 1px), linear-gradient(to bottom, var(--line) 1px, transparent 1px)';
    style.backgroundSize = `${spacing}px ${spacing}px`; style.backgroundPosition = `${matrix.e}px ${matrix.f}px`;
  }
  dispose() { this.disposed = true; this.syncing = true; this.themeObserver.disconnect(); this.resizeObserver.disconnect(); cancelAnimationFrame(this.frame); this.container.removeEventListener('mousedown', this.down, true); document.removeEventListener('mousedown', this.commitPending, true); document.removeEventListener('mousemove', this.movePort, true); document.removeEventListener('mouseup', this.up, true); window.removeEventListener('blur', this.cancel); this.graph.dispose(); }
}
