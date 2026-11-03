import { edgeColors, edgeColor } from './edgeColors';
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { MouseEvent } from 'react';
import { Button, Checkbox, ConfigProvider, Dropdown, Input, InputNumber, Space, Tooltip, Typography, message } from 'antd';
import { AimOutlined, AppstoreOutlined, BorderOuterOutlined, CloseOutlined, CopyOutlined, DeleteOutlined, DragOutlined, FullscreenExitOutlined, FullscreenOutlined, GroupOutlined, LinkOutlined, RedoOutlined, SearchOutlined, SelectOutlined, SettingOutlined, UndoOutlined, UngroupOutlined } from '@ant-design/icons';
import Select from '../../components/AppSelect';
import type { Asset, Unit } from '../../model';
import type { Topology, TopologyNode, TopologyEdge, TopologyRegion, TopologyPoint } from './types';
import { boundaryPoint, topologyRegions } from './topology';
import { defaultIcon, iconKinds, nodeDetails, nodeDetailsIndex, nodeIcon, validIcon } from './nodeAppearance';
import { moveNodes, snapMove } from './snapping';
import { alignNodes, type NodeAlignment } from './topologyEditing';
import { TopologyGraph, type GraphSelection } from './TopologyGraph';
import { sameTopology } from './topologyEquality';
import { copyNodes, descendants, deviceTemplates, dissolveRegion, groupNodes, nestRegion, orderedRegions, pasteNodes, type DeviceKind, type EditorTool, type TopologyClipboard } from './topologyWorkbench';
import './topologyX6.css';

type Context = { x: number; y: number; point: TopologyPoint; nodeId?: string; portId?: string; edgeId?: string; regionId?: string };
const bounded = (value: number) => Math.max(-50000, Math.min(50000, Math.round(value)));

function TopologyCanvas({ active = true, value, assets, units, selectableAssets, onChange, onAsset }: {
  active?: boolean; value: Topology; assets: Asset[]; units: Unit[]; selectableAssets: Asset[]; onChange: (value: Topology) => void; onAsset: (id: string) => void;
}) {
  const [msg, messageContext] = message.useMessage({ maxCount: 3 });
  const [grid, setGrid] = useState<'square' | 'dots' | 'none'>('dots'), [snap, setSnap] = useState(true);
  const [zoom, setZoomState] = useState(1), [fullscreenOpen, setFullscreen] = useState(false), fullscreen = active && fullscreenOpen;
  const [selected, setSelected] = useState<string[]>([]), [selectedRegion, setSelectedRegion] = useState<string>(), [selectedEdge, setSelectedEdge] = useState<string>();
  const [assetChoice, setAssetChoice] = useState<string[]>([]), [context, setContext] = useState<Context>();
  const [size, setSize] = useState({ width: 800, height: 480 });
  const [libraryOpen, setLibraryOpen] = useState(true), [inspectorOpen, setInspectorOpen] = useState(true);
  const [libraryTab, setLibraryTab] = useState<'devices' | 'assets'>('assets'), [librarySearch, setLibrarySearch] = useState('');
  const [inspectorTab, setInspectorTab] = useState<'properties' | 'canvas'>('properties');
  const [tool, setTool] = useState<EditorTool>('select'), [connectionStart, setConnectionStart] = useState<string>();
  const [arrangeOpen, setArrangeOpen] = useState(false), [clipboardReady, setClipboardReady] = useState(false);
  const [, setHistoryTick] = useState(0);
  const slot = useRef<HTMLDivElement>(null), viewportRef = useRef<HTMLDivElement>(null), graphContainerRef = useRef<HTMLDivElement>(null), overviewRef = useRef<HTMLDivElement>(null);
  const graph = useRef<TopologyGraph>();
  const [host] = useState(() => { const element = document.createElement('div'); element.className = 'topology-canvas-host'; return element; });
  const latest = useRef(value); latest.current = value;
  const renderedValue = useRef(value), emittedValue = useRef(value);
  const onChangeRef = useRef(onChange); onChangeRef.current = onChange;
  const iconReader = useRef<FileReader>(), iconInput = useRef<HTMLInputElement>(null);
  const past = useRef<Topology[]>([]), future = useRef<Topology[]>([]);
  const clipboard = useRef<TopologyClipboard>();
  const selectionRef = useRef<GraphSelection>({ nodes: [] }); selectionRef.current = { nodes: selected, edge: selectedEdge, region: selectedRegion };
  const regions = topologyRegions(value), selectedNode = selected.length === 1 ? value.nodes.find(node => node.id === selected[0]) : undefined;
  const selectedRegionItem = regions.find(region => region.id === selectedRegion), selectedEdgeItem = value.edges.find(edge => edge.id === selectedEdge);
  const hasProperties = Boolean(selected.length || selectedRegionItem || selectedEdgeItem);
  const canvasSelectProps = { active, listHeight: Math.max(80, Math.min(256, size.height - 32)), dropdownAlign: { offset: [0, 0] } };
  const detailsIndex = useMemo(() => nodeDetailsIndex(assets, units), [assets, units]);
  const nodeInfo = useMemo(() => new Map(value.nodes.map(node => [node.id, nodeDetails(node, detailsIndex)])), [value.nodes, detailsIndex]);
  const availableAssets = useMemo(() => { const used = new Set(value.nodes.map(node => node.assetId)); return selectableAssets.filter(asset => !used.has(asset.id)); }, [selectableAssets, value.nodes]);
  const visibleAssets = useMemo(() => { const query = librarySearch.trim().toLowerCase(); return availableAssets.filter(asset => `${asset.name} ${asset.host} ${asset.ip}`.toLowerCase().includes(query)); }, [availableAssets, librarySearch]);
  const remember = (previous = latest.current) => { past.current = [...past.current.slice(-49), previous]; future.current = []; setHistoryTick(tick => tick + 1); };
  const emit = (next: Topology) => { latest.current = next; emittedValue.current = next; onChangeRef.current(next); };
  const change = (next: Topology) => { if (sameTopology(latest.current, next)) return; remember(); emit(next); };
  const changeRef = useRef(change); changeRef.current = change;
  const clearSelection = () => { setSelected([]); setSelectedRegion(undefined); setSelectedEdge(undefined); graph.current?.select({ nodes: [] }); };
  const cancelDrag = () => graph.current?.cancel();
  const setZoom = (update: (current: number) => number) => graph.current?.zoom(update(zoom));
  const setMovingPort = (value: { nodeId: string; portId: string } | undefined) => { if (graph.current) graph.current.movingPort = value; };
  const undo = (redo = false) => { cancelDrag(); const source = redo ? future : past, destination = redo ? past : future, next = source.current.pop(); if (!next) return; destination.current.push(latest.current); emit(next); clearSelection(); setHistoryTick(tick => tick + 1); };
  const activateTool = (next: EditorTool) => { cancelDrag(); setTool(next); setConnectionStart(undefined); graph.current?.setTool(next); viewportRef.current?.focus({ preventScroll: true }); };
  const selectNodes = (ids: string[]) => { setSelected(ids); setSelectedEdge(undefined); setSelectedRegion(undefined); setInspectorTab('properties'); };
  const connectNode = (id: string) => {
    if (!connectionStart) { setConnectionStart(id); return; }
    if (connectionStart === id) { setConnectionStart(undefined); return; }
    const next = latest.current, from = next.nodes.find(n => n.id === connectionStart), to = next.nodes.find(n => n.id === id);
    if (!from || !to || next.edges.length >= 5000) { setConnectionStart(undefined); return; }
    const dx = to.x + (to.width ?? 260) / 2 - from.x - (from.width ?? 260) / 2, dy = to.y + (to.height ?? 132) / 2 - from.y - (from.height ?? 132) / 2;
    const edge: TopologyEdge = { id: crypto.randomUUID(), from: from.id, to: to.id, fromPort: Math.abs(dx) > Math.abs(dy) ? dx > 0 ? 'right' : 'left' : dy > 0 ? 'bottom' : 'top', toPort: Math.abs(dx) > Math.abs(dy) ? dx > 0 ? 'left' : 'right' : dy > 0 ? 'top' : 'bottom', label: '', style: 'solid', direction: 'forward' };
    change({ ...next, edges: [...next.edges, edge] }); setConnectionStart(undefined); setSelected([]); setSelectedEdge(edge.id); setSelectedRegion(undefined); setInspectorTab('properties');
  };
  const connectRef = useRef(connectNode); connectRef.current = connectNode;
  useLayoutEffect(() => () => host.remove(), [host]);
  useLayoutEffect(() => {
    const focused = document.activeElement, restoreFocus = (focused instanceof HTMLElement || focused instanceof SVGElement) && host.contains(focused);
    const backgrounds = fullscreen ? [...document.querySelectorAll<HTMLElement>('[data-editor-background]')].map(element => ({ element, inert: element.inert })) : [];
    backgrounds.forEach(({ element }) => { element.inert = true; });
    (fullscreen ? document.body : slot.current)?.appendChild(host);
    if (restoreFocus) { if (active) focused.focus({ preventScroll: true }); else focused.blur(); }
    return () => { backgrounds.forEach(({ element, inert }) => { element.inert = inert; }); };
  }, [fullscreen, active, host]);
  useLayoutEffect(() => {
    const runtime = new TopologyGraph(graphContainerRef.current!, overviewRef.current!, {
      change: next => changeRef.current(next), selection: selection => { setSelected(selection.nodes); setSelectedEdge(selection.edge); setSelectedRegion(selection.region); if (selection.nodes.length || selection.edge || selection.region) setInspectorTab('properties'); }, zoom: setZoomState, connect: id => connectRef.current(id),
      rejected: reason => { void msg.warning({ key: 'topology-edit-rejected', content: reason }); },
    });
    graph.current = runtime;
    runtime.sync(latest.current, assets, units); runtime.open();
    const observer = new ResizeObserver(([entry]) => { if (entry.contentRect.width > 0 && entry.contentRect.height > 0) setSize({ width: entry.contentRect.width, height: entry.contentRect.height }); });
    observer.observe(viewportRef.current!);
    return () => { observer.disconnect(); runtime.dispose(); graph.current = undefined; };
  }, []);
  useLayoutEffect(() => {
    if (value !== emittedValue.current && !sameTopology(value, renderedValue.current)) { past.current = []; future.current = []; setHistoryTick(tick => tick + 1); }
    renderedValue.current = value;
    graph.current?.sync(value, assets, units);
    const previous = selectionRef.current, next = { nodes: previous.nodes.filter(id => value.nodes.some(n => n.id === id)), edge: value.edges.some(e => e.id === previous.edge) ? previous.edge : undefined, region: topologyRegions(value).some(r => r.id === previous.region) ? previous.region : undefined };
    if (next.nodes.length !== previous.nodes.length || next.edge !== previous.edge || next.region !== previous.region) graph.current?.select(next);
  }, [value, assets, units]);
  useLayoutEffect(() => { graph.current?.select(selectionRef.current); }, [selected, selectedEdge, selectedRegion]);
  useEffect(() => { graph.current?.grid(grid, snap); }, [grid, snap]);
  useLayoutEffect(() => { if (!active) { setFullscreen(false); setContext(undefined); setArrangeOpen(false); setConnectionStart(undefined); cancelDrag(); } }, [active]);
  useEffect(() => () => { const reader = iconReader.current; iconReader.current = undefined; if (reader) { reader.onload = null; reader.onerror = null; reader.abort(); } }, []);
  useEffect(() => {
    if (!fullscreen) return;
    const close = (event: KeyboardEvent) => { if (event.key === 'Escape' && !event.defaultPrevented && !event.isComposing && event.keyCode !== 229) setFullscreen(false); };
    window.addEventListener('keydown', close); return () => window.removeEventListener('keydown', close);
  }, [fullscreen]);
  const handleContext = (event: MouseEvent<HTMLDivElement>) => {
    if (!(event.target as Element).closest('.topology-stage') || (event.target as Element).closest('.topology-context-menu, .ant-select-dropdown, .topology-overview')) return;
    event.preventDefault(); const box = viewportRef.current!.getBoundingClientRect(), target = event.target as Element;
    const nodeId = target.closest('[data-node-id]')?.getAttribute('data-node-id') ?? undefined, edgeId = target.closest('[data-edge-id]')?.getAttribute('data-edge-id') ?? undefined, regionId = target.closest('[data-region-id]')?.getAttribute('data-region-id') ?? undefined;
    const portId = target.closest('[port]')?.getAttribute('port') ?? undefined;
    if (nodeId) graph.current?.select({ nodes: [nodeId] }); else if (edgeId) graph.current?.select({ nodes: [], edge: edgeId }); else if (regionId) graph.current?.select({ nodes: [], region: regionId }); else clearSelection();
    setAssetChoice([]); setContext({ x: Math.max(8, Math.min(event.clientX - box.left, box.width - 300)), y: Math.max(8, Math.min(event.clientY - box.top, box.height - 220)), point: graph.current!.point(event.clientX, event.clientY), nodeId, edgeId, regionId, portId });
  };

  const deleteSelection = () => {
    cancelDrag();
    const next = selectedRegion ? dissolveRegion(latest.current, selectedRegion) : latest.current; const ids = new Set(selected);
    change({ ...next, nodes: next.nodes.filter((node) => !ids.has(node.id)), edges: next.edges.filter((edge) => edge.id !== selectedEdge && !ids.has(edge.from) && !ids.has(edge.to)) }); clearSelection(); setContext(undefined);
  };
  const addAssets = () => {
    if (!context) return; const next = latest.current;
    const nodes = assetChoice.map((assetId) => selectableAssets.find((asset) => asset.id === assetId)).filter((asset) => asset && !next.nodes.some((node) => node.assetId === asset.id)).map((asset, index) => ({ id: crypto.randomUUID(), assetId: asset!.id, label: asset!.name, role: '服务器', x: bounded(context.point.x + (index % 2) * 310), y: bounded(context.point.y + Math.floor(index / 2) * 175) }));
    change({ ...next, nodes: [...next.nodes, ...nodes] }); setSelected(nodes.map((node) => node.id)); setSelectedEdge(undefined); setSelectedRegion(undefined); setContext(undefined);
  };
  const addObject = (region = false) => {
    if (!context) return; const next = latest.current; const position = { x: bounded(context.point.x), y: bounded(context.point.y) }; const id = crypto.randomUUID();
    if (region) { change({ ...next, regions: [...topologyRegions(next), { id, ...position, label: '新区域', width: 420, height: 260, color: '#668c70' }] }); setSelectedRegion(id); setSelected([]); setSelectedEdge(undefined); }
    else { change({ ...next, nodes: [...next.nodes, { id, ...position, label: '网络设备', role: '防火墙', iconKind: 'firewall', note: '' }] }); setSelected([id]); setSelectedRegion(undefined); setSelectedEdge(undefined); }
    setContext(undefined);
  };
  const editNode = (node: TopologyNode) => change({ ...latest.current, nodes: latest.current.nodes.map((item) => item.id === node.id ? node : item) });
  const editEdge = (edge: TopologyEdge) => change({ ...latest.current, edges: latest.current.edges.map((item) => item.id === edge.id ? edge : item) });
  const editRegion = (region: TopologyRegion) => { try { const next = { ...latest.current, regions: topologyRegions(latest.current).map(item => item.id === region.id ? region : item) }; change(topologyRegions(latest.current).find(r => r.id === region.id)?.parentId !== region.parentId ? nestRegion(next, region.id, region.parentId) : next); } catch (error) { msg.warning(error instanceof Error ? error.message : String(error)); } };
  const addPort = () => {
    const node = value.nodes.find((item) => item.id === context?.nodeId); if (!node || !context || (node.connectionPoints?.length ?? 0) >= 100) return;
    editNode({ ...node, connectionPoints: [...(node.connectionPoints ?? []), { id: crypto.randomUUID(), ...boundaryPoint(node, context.point) }] }); setContext(undefined);
  };
  const removePort = () => {
    if (!context?.nodeId || !context.portId) return; const { nodeId, portId } = context; const next = latest.current;
    change({ ...next, nodes: next.nodes.map((node) => node.id === nodeId ? { ...node, connectionPoints: node.connectionPoints?.filter((port) => port.id !== portId) } : node), edges: next.edges.map((edge) => ({ ...edge, ...(edge.from === nodeId && edge.fromPort === portId ? { fromPort: undefined } : {}), ...(edge.to === nodeId && edge.toPort === portId ? { toPort: undefined } : {}) })) }); setContext(undefined);
  };
  const fitCanvas = () => { graph.current?.fit(); clearSelection(); };
  const locateNode = (id: string) => graph.current?.locate(id);
  const insert = (item: `device:${DeviceKind}` | `asset:${string}` | 'group', point?: TopologyPoint) => {
    const runtime = graph.current; if (!runtime) return;
    const next = latest.current, box = graphContainerRef.current!.getBoundingClientRect();
    const center = point ?? runtime.point(box.left + box.width / 2, box.top + box.height / 2);
    const position = { x: bounded(center.x - (item === 'group' ? 210 : 130)), y: bounded(center.y - (item === 'group' ? 130 : 66)) };
    if (snap) { position.x = bounded(Math.round(position.x / 20) * 20); position.y = bounded(Math.round(position.y / 20) * 20); }
    if (!point) { let offset = 0; while (offset < 400 && next.nodes.some(n => n.x === position.x + offset && n.y === position.y + offset)) offset += 40; position.x = bounded(position.x + offset); position.y = bounded(position.y + offset); }
    const id = crypto.randomUUID();
    if (item === 'group') {
      if (topologyRegions(next).length >= 500) { msg.warning('最多支持 500 个分组'); return; }
      change({ ...next, regions: [...topologyRegions(next), { id, ...position, label: '新建分组', width: 420, height: 260, color: '#668c70' }] }); setSelected([]); setSelectedEdge(undefined); setSelectedRegion(id);
    } else {
      if (next.nodes.length >= 1000) { msg.warning('最多支持 1000 个节点'); return; }
      const template = deviceTemplates.find(t => item === `device:${t.kind}`), asset = item.startsWith('asset:') ? availableAssets.find(a => a.id === item.slice(6)) : undefined;
      if (!template && !asset) return;
      const parent = [...regions].filter(r => position.x >= r.x && position.y >= r.y + 38 && position.x + 260 <= r.x + r.width && position.y + 132 <= r.y + r.height).sort((a, b) => a.width * a.height - b.width * b.height)[0];
      const node: TopologyNode = { id, ...position, label: asset?.name ?? template!.label, role: asset ? '服务器' : template!.role, ...(asset ? { assetId: asset.id } : { iconKind: template!.kind }), ...(parent ? { regionId: parent.id } : {}) };
      change({ ...next, nodes: [...next.nodes, node] }); selectNodes([id]);
    }
    setInspectorTab('properties'); setContext(undefined); viewportRef.current?.focus({ preventScroll: true });
  };
  const copy = () => { if (!selected.length) return; clipboard.current = copyNodes(latest.current, selected); setClipboardReady(true); };
  const paste = (duplicate = false) => {
    const content = duplicate ? copyNodes(latest.current, selected) : clipboard.current; if (!content?.nodes.length) return;
    const result = pasteNodes(latest.current, content);
    if (!result) { msg.warning('粘贴后将超过 1000 个节点或 5000 条连线'); return; }
    change(result.topology); selectNodes(result.ids); clipboard.current = copyNodes(result.topology, result.ids); setClipboardReady(true);
    if (result.overlapping) msg.info('已创建副本；坐标已到边界，副本与原图重叠');
  };
  const makeGroup = () => { try { const id = crypto.randomUUID(), next = groupNodes(latest.current, selected, id); if (next === latest.current) return; change(next); setSelected([]); setSelectedEdge(undefined); setSelectedRegion(id); setInspectorTab('properties'); } catch (error) { msg.warning(error instanceof Error ? error.message : String(error)); } };
  const align = (mode: NodeAlignment) => change(alignNodes(latest.current, selected, mode));
  const alignOptions = [{ value: 'left', label: '左对齐' }, { value: 'right', label: '右对齐' }, { value: 'top', label: '顶部对齐' }, { value: 'bottom', label: '底部对齐' }, { value: 'horizontal', label: '水平居中' }, { value: 'vertical', label: '垂直居中' }, { value: 'distribute-x', label: '水平等距' }, { value: 'distribute-y', label: '垂直等距' }];
  return <div ref={slot} className="topology-canvas-slot">{createPortal(<div ref={viewportRef} tabIndex={0} className={`topology-viewport topology-editor tool-${tool}${fullscreen ? ' is-fullscreen' : ''}`} onContextMenu={handleContext} onPointerDown={() => setContext(undefined)} onBlur={() => graph.current?.spacePan(false)} onKeyUp={(event) => { if (event.code === 'Space') graph.current?.spacePan(false); }} onKeyDown={(event) => {
    const target = event.target as HTMLElement;
    if (event.defaultPrevented || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
    if (event.key === 'Escape' && context) { event.preventDefault(); event.stopPropagation(); setContext(undefined); return; }
    if (target.isContentEditable || target.closest('input, textarea, select, button, a[href], [contenteditable="true"], .ant-select') || (target !== event.currentTarget && !graphContainerRef.current?.contains(target))) return;
    if ((event.key === 'Enter' || event.key === ' ') && target.closest('[data-node-id], [data-edge-id], [data-region-id]')) {
      event.preventDefault(); event.stopPropagation(); const cell = target.closest('[data-node-id], [data-edge-id], [data-region-id]')!;
      graph.current?.select({ nodes: cell.hasAttribute('data-node-id') ? [cell.getAttribute('data-node-id')!] : [], edge: cell.getAttribute('data-edge-id') ?? undefined, region: cell.getAttribute('data-region-id') ?? undefined }); return;
    }
    if (event.code === 'Space') { graph.current?.spacePan(true); event.preventDefault(); }
    else if (event.key === 'Escape') { cancelDrag(); setContext(undefined); setMovingPort(undefined); if (connectionStart) setConnectionStart(undefined); else if (tool !== 'select') activateTool('select'); else if (fullscreen) setFullscreen(false); else clearSelection(); }
    else if (selected.length && ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key)) {
      event.preventDefault(); event.stopPropagation(); const step = event.ctrlKey || event.metaKey ? 20 : event.shiftKey ? 10 : 1; const dx = event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0; const dy = event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0;
      const move = snapMove(value.nodes, selected, dx, dy, { grid: snap && (event.ctrlKey || event.metaKey), align: false, threshold: 0 }); change(moveNodes(value, selected, move.dx, move.dy));
    }
    else if (event.key === 'Delete' || event.key === 'Backspace') { event.preventDefault(); if (selected.length || selectedEdge || selectedRegion) deleteSelection(); }
    else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a') { event.preventDefault(); setSelected(value.nodes.map((node) => node.id)); setSelectedEdge(undefined); setSelectedRegion(undefined); }
    else if ((event.ctrlKey || event.metaKey) && ['z', 'y'].includes(event.key.toLowerCase())) { event.preventDefault(); event.stopPropagation(); undo(event.key.toLowerCase() === 'y' || event.shiftKey); }
    else if ((event.ctrlKey || event.metaKey) && ['c', 'v', 'd', 'g'].includes(event.key.toLowerCase())) {
      event.preventDefault(); event.stopPropagation(); const key = event.key.toLowerCase(); if (key === 'c') copy(); if (key === 'v') paste(); if (key === 'd') paste(true); if (key === 'g') { if (event.shiftKey && selectedRegion) deleteSelection(); else makeGroup(); }
    }
    else if (!event.ctrlKey && !event.metaKey && !event.altKey && ['v', 'h', 'c'].includes(event.key.toLowerCase())) { event.preventDefault(); activateTool(event.key.toLowerCase() === 'v' ? 'select' : event.key.toLowerCase() === 'h' ? 'pan' : 'connect'); }
  }}>
    {messageContext}
    <ConfigProvider getPopupContainer={() => viewportRef.current!}>
    <div className="topology-controls topology-editor-toolbar" role="toolbar" aria-label="拓扑编辑工具">
      <div className="topology-tool-group">
        <Tooltip title="设备与资产素材"><Button type={libraryOpen ? 'text' : 'default'} aria-label="切换素材库" aria-pressed={libraryOpen} icon={<AppstoreOutlined />} onClick={() => setLibraryOpen(v => !v)} /></Tooltip>
      </div>
      <div className="topology-tool-group topology-mode-tools">
        <Tooltip title="选择与框选 (V)"><Button aria-label="选择工具" aria-pressed={tool === 'select'} type={tool === 'select' ? 'primary' : 'text'} icon={<SelectOutlined />} onClick={() => activateTool('select')}>选择</Button></Tooltip>
        <Tooltip title="平移画布 (H)，也可按住空格拖动"><Button aria-label="平移工具" aria-pressed={tool === 'pan'} type={tool === 'pan' ? 'primary' : 'text'} icon={<DragOutlined />} onClick={() => activateTool('pan')}>平移</Button></Tooltip>
        <Tooltip title="依次点击两个节点连接 (C)"><Button aria-label="连接工具" aria-pressed={tool === 'connect'} type={tool === 'connect' ? 'primary' : 'text'} icon={<LinkOutlined />} onClick={() => activateTool('connect')}>连接</Button></Tooltip>
      </div>
      <div className="topology-tool-group">
        <Tooltip title="撤销 (Ctrl+Z)"><Button type="text" aria-label="撤销拓扑操作" icon={<UndoOutlined />} disabled={!past.current.length} onClick={() => undo()} /></Tooltip>
        <Tooltip title="重做 (Ctrl+Shift+Z)"><Button type="text" aria-label="重做拓扑操作" icon={<RedoOutlined />} disabled={!future.current.length} onClick={() => undo(true)} /></Tooltip>
      </div>
      <div className="topology-tool-group">
        <Tooltip title="复制所选节点及内部连线 (Ctrl+D)"><Button type="text" aria-label="创建所选副本" icon={<CopyOutlined />} disabled={!selected.length} onClick={() => paste(true)} /></Tooltip>
        <Tooltip title={selectedRegion ? '解散分组，保留节点 (Ctrl+Shift+G)' : '将所选节点成组 (Ctrl+G)'}><Button type="text" aria-label={selectedRegion ? '解散所选分组' : '将所选节点成组'} icon={selectedRegion ? <UngroupOutlined /> : <GroupOutlined />} disabled={!selectedRegion && (!selected.length || regions.length >= 500)} onClick={selectedRegion ? deleteSelection : makeGroup} /></Tooltip>
        <Dropdown trigger={['click']} open={active && arrangeOpen} onOpenChange={setArrangeOpen} disabled={selected.length < 2} getPopupContainer={() => viewportRef.current!} menu={{ items: alignOptions.map(o => ({ key: o.value, label: o.label, disabled: o.value.startsWith('distribute') && selected.length < 3 })), onClick: ({ key }) => { align(key as NodeAlignment); setArrangeOpen(false); } }}><Button type="text" aria-label="对齐与分布" icon={<BorderOuterOutlined />} disabled={selected.length < 2} /></Dropdown>
        <Tooltip title="删除所选 (Delete)"><Button type="text" aria-label="删除拓扑所选" icon={<DeleteOutlined />} disabled={!hasProperties} onClick={deleteSelection} /></Tooltip>
      </div>
      <div className="topology-toolbar-spacer" />
      <Select {...canvasSelectProps} className="topology-locate" aria-label="搜索定位拓扑节点" showSearch value={undefined} placeholder={<><SearchOutlined /> 定位节点 / IP</>} optionFilterProp="label" options={value.nodes.map(node => ({ value: node.id, label: `${nodeInfo.get(node.id)!.name} ${nodeInfo.get(node.id)!.host} ${nodeInfo.get(node.id)!.ip}` }))} onChange={locateNode} />
      <div className="topology-tool-group topology-toolbar-end">
        <Tooltip title="属性与画布设置"><Button type="text" aria-label="切换属性面板" aria-pressed={inspectorOpen} icon={<SettingOutlined />} onClick={() => setInspectorOpen(v => !v)} /></Tooltip>
        <Tooltip title={fullscreen ? '退出全屏' : '全屏编辑'}><Button type="text" aria-label={fullscreen ? '退出放大' : '放大拓扑区域'} icon={fullscreen ? <FullscreenExitOutlined /> : <FullscreenOutlined />} onClick={() => setFullscreen(v => !v)} /></Tooltip>
      </div>
    </div>
    <div className={`topology-editor-body${libraryOpen ? '' : ' library-closed'}${inspectorOpen ? '' : ' inspector-closed'}`}>
      {libraryOpen && <aside className="topology-library" aria-label="拓扑素材库">
        <div className="topology-panel-heading"><Typography.Text strong>素材库</Typography.Text><Button type="text" size="small" aria-label="关闭素材库" icon={<CloseOutlined />} onClick={() => setLibraryOpen(false)} /></div>
        <div className="topology-panel-tabs" role="tablist" aria-label="素材类型"><button type="button" role="tab" aria-selected={libraryTab === 'assets'} onClick={() => { setLibraryTab('assets'); setLibrarySearch(''); }}>台账资产</button><button type="button" role="tab" aria-selected={libraryTab === 'devices'} onClick={() => { setLibraryTab('devices'); setLibrarySearch(''); }}>基础设备</button></div>
        <Input aria-label="筛选拓扑素材" prefix={<SearchOutlined />} placeholder={libraryTab === 'devices' ? '搜索设备' : '名称 / 主机名 / IP'} allowClear value={librarySearch} onChange={e => setLibrarySearch(e.target.value)} />
        <div className="topology-library-items">
          {libraryTab === 'devices' ? <>
            <div className="topology-library-caption">拖入画布，或点击添加</div>
            {deviceTemplates.filter(t => `${t.label} ${t.hint}`.includes(librarySearch.trim())).map(template => <button type="button" key={template.kind} className="topology-palette-item" aria-label={`添加${template.label}`} draggable disabled={value.nodes.length >= 1000} onDragStart={e => { e.dataTransfer.setData('application/x-assetops-topology', `device:${template.kind}`); e.dataTransfer.effectAllowed = 'copy'; }} onClick={() => insert(`device:${template.kind}`)}><span className="topology-palette-icon"><img src={nodeIcon({ id: '', label: '', role: '', x: 0, y: 0, iconKind: template.kind })} alt="" /></span><span><strong>{template.label}</strong><small>{template.hint}</small></span><span className="topology-palette-add" aria-hidden="true">＋</span></button>)}
            {!librarySearch.trim() && <><div className="topology-library-caption">组织与分组</div><button type="button" className="topology-palette-item" aria-label="添加分组容器" draggable disabled={regions.length >= 500} onDragStart={e => { e.dataTransfer.setData('application/x-assetops-topology', 'group'); e.dataTransfer.effectAllowed = 'copy'; }} onClick={() => insert('group')}><span className="topology-palette-icon topology-palette-group"><GroupOutlined /></span><span><strong>分组容器</strong><small>集群 / 机房 / 主备区域</small></span><span className="topology-palette-add" aria-hidden="true">＋</span></button></>}
          </> : <>
            <div className="topology-library-caption">可用资产 {visibleAssets.length} / {selectableAssets.length}</div>
            {visibleAssets.map(asset => <button type="button" key={asset.id} className="topology-palette-item" aria-label={`添加资产${asset.name}`} draggable disabled={value.nodes.length >= 1000} onDragStart={e => { e.dataTransfer.setData('application/x-assetops-topology', `asset:${asset.id}`); e.dataTransfer.effectAllowed = 'copy'; }} onClick={() => insert(`asset:${asset.id}`)}><span className="topology-palette-icon"><img src={nodeIcon({ id: '', label: '', role: '', x: 0, y: 0, assetId: asset.id })} alt="" /></span><span><strong title={asset.name}>{asset.name}</strong><small title={asset.ip || asset.host}>{asset.ip || asset.host || '未设置 IP'}</small></span></button>)}
            {!visibleAssets.length && <div className="topology-panel-empty">{availableAssets.length ? '没有匹配的资产' : selectableAssets.length ? '当前目录的资产已全部加入画布。' : '当前目录暂无资产，可先在资产台账中添加。'}</div>}
          </>}
        </div>
        <div className="topology-library-footer"><span>常用操作</span><kbd>V</kbd> 选择 <kbd>H</kbd> 平移 <kbd>C</kbd> 连接</div>
      </aside>}
      <div className="topology-stage" onDragOver={e => { if ([...e.dataTransfer.types].includes('application/x-assetops-topology')) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } }} onDrop={e => { const item = e.dataTransfer.getData('application/x-assetops-topology'); if (item === 'group' || deviceTemplates.some(t => item === `device:${t.kind}`) || availableAssets.some(a => item === `asset:${a.id}`)) { e.preventDefault(); insert(item as Parameters<typeof insert>[0], graph.current!.point(e.clientX, e.clientY)); } }}>
        <div className="topology-x6-shell"><div ref={graphContainerRef} className="topology-x6" aria-label="系统网络拓扑画布" /></div>
        <div className="topology-stage-label"><span /> 网络拓扑 <small>{tool === 'connect' ? '连接模式' : tool === 'pan' ? '平移模式' : '编辑模式'}</small></div>
        <div ref={overviewRef} className="topology-overview" aria-label="拓扑总览，拖动定位画布" hidden={value.nodes.length <= 20} />
        {!value.nodes.length && !regions.length && <div className="topology-editor-empty"><span className="topology-empty-icon"><GroupOutlined /></span><strong>开始构建网络拓扑</strong><span>从左侧拖入设备或台账资产，<br />拖动节点连接点，或使用连接工具建立关系。</span><Button type="primary" icon={<AppstoreOutlined />} onClick={() => { setLibraryOpen(true); insert('device:application'); }}>添加第一个设备</Button></div>}
      </div>
      {inspectorOpen && <aside className="topology-properties topology-inspector" aria-label="拓扑属性面板" onContextMenu={event => event.stopPropagation()}>
      <div className="topology-panel-heading"><Typography.Text strong>检查器</Typography.Text><Button type="text" size="small" aria-label="关闭拓扑属性" icon={<CloseOutlined />} onClick={() => setInspectorOpen(false)} /></div>
      <div className="topology-panel-tabs" role="tablist" aria-label="检查器内容"><button type="button" role="tab" aria-selected={inspectorTab === 'properties'} onClick={() => setInspectorTab('properties')}>对象属性</button><button type="button" role="tab" aria-selected={inspectorTab === 'canvas'} onClick={() => setInspectorTab('canvas')}>画布设置</button></div>
      <div className="topology-inspector-body">
      {inspectorTab === 'properties' ? hasProperties ? <>
      <div className="topology-inspector-kind"><span>{selectedNode ? selectedNode.assetId ? '台账资产' : '基础设备' : selectedEdgeItem ? '连接关系' : selectedRegionItem ? '分组容器' : '多选编辑'}</span><Typography.Text strong>{selectedNode ? nodeInfo.get(selectedNode.id)?.name : selectedEdgeItem ? '连线属性' : selectedRegionItem ? selectedRegionItem.label : `已选 ${selected.length} 个节点`}</Typography.Text></div>
      {selectedNode && <>
        {!selectedNode.assetId && <label>名称<Input aria-label="拓扑节点名称" value={selectedNode.label} maxLength={128} onChange={(event) => editNode({ ...selectedNode, label: event.target.value })} /></label>}
        <label>角色<Input aria-label="拓扑节点角色" value={selectedNode.role} maxLength={128} onChange={(event) => editNode({ ...selectedNode, role: event.target.value })} /></label>
        <label>图标<Select {...canvasSelectProps} aria-label="拓扑节点图标" value={selectedNode.customIcon && validIcon(selectedNode.customIcon) ? 'custom' : defaultIcon(selectedNode)} options={[...(selectedNode.customIcon && validIcon(selectedNode.customIcon) ? [{ value: 'custom', label: '自定义图标（48×48 px）' }] : []), ...Object.entries(iconKinds).map(([value, label]) => ({ value, label }))]} onChange={(iconKind) => { if (iconKind !== 'custom') { const reader = iconReader.current; iconReader.current = undefined; reader?.abort(); editNode({ ...selectedNode, iconKind: iconKind as NonNullable<TopologyNode['iconKind']>, customIcon: undefined }); } }} /></label>
        {selectedNode.customIcon && validIcon(selectedNode.customIcon) && <div className="topology-custom-icon-status"><img src={selectedNode.customIcon} alt="已选择的自定义图标" /><span>已选择自定义图标 · 48×48 px</span></div>}
        <div className="topology-icon-upload"><Button size="small" onClick={() => iconInput.current?.click()}>{selectedNode.customIcon ? '替换自定义图标' : '上传自定义图标'}</Button><input ref={iconInput} hidden aria-label="自定义拓扑图标" type="file" accept=".svg,.png,.jpg,.jpeg,.webp,image/svg+xml,image/png,image/jpeg,image/webp" onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ''; if (!file) return; const previous = iconReader.current; iconReader.current = undefined; previous?.abort(); if (file.size > 128 * 1024) { msg.error('图标文件不能超过 128 KB'); return; } const reader = new FileReader(); iconReader.current = reader; reader.onload = () => { if (iconReader.current !== reader) return; iconReader.current = undefined; const customIcon = String(reader.result); if (!validIcon(customIcon)) { msg.error('请选择 PNG、JPEG、WebP 或只含图形的 SVG'); return; } const node = latest.current.nodes.find((item) => item.id === selectedNode.id); if (node) editNode({ ...node, customIcon }); }; reader.onerror = () => { if (iconReader.current === reader) { iconReader.current = undefined; msg.error('图标读取失败，请重新选择'); } }; reader.readAsDataURL(file); }} /></div>
        <label>标签<Select {...canvasSelectProps} aria-label="拓扑节点标签" mode="tags" value={nodeInfo.get(selectedNode.id)!.tags} onChange={(tags) => editNode({ ...selectedNode, tags: tags.slice(0, 20).map((tag) => tag.slice(0, 64)) })} /></label>
        {!selectedNode.assetId && <><label>主机名<Input aria-label="拓扑节点主机名" value={selectedNode.host ?? ''} maxLength={128} onChange={(event) => editNode({ ...selectedNode, host: event.target.value })} /></label><label>IP<Input aria-label="拓扑节点IP" value={selectedNode.ip ?? ''} maxLength={128} onChange={(event) => editNode({ ...selectedNode, ip: event.target.value })} /></label><label>环境<Input aria-label="拓扑节点环境" value={selectedNode.environment ?? ''} maxLength={128} onChange={(event) => editNode({ ...selectedNode, environment: event.target.value })} /></label></>}
        <label>备注<Input.TextArea aria-label="拓扑节点备注" value={selectedNode.note ?? ''} rows={3} maxLength={1000} onChange={(event) => editNode({ ...selectedNode, note: event.target.value })} /></label>
        <div className="topology-property-section">布局</div>
        <div className="topology-dimensions">{(['x', 'y', 'width', 'height'] as const).map(key => <label key={key}>{({ x: 'X 坐标', y: 'Y 坐标', width: '宽度', height: '高度' })[key]}<InputNumber aria-label={`节点${key}`} value={selectedNode[key] ?? (key === 'width' ? 260 : 132)} min={key === 'width' ? 160 : key === 'height' ? 100 : -50000} max={key === 'width' ? 1000 : key === 'height' ? 800 : 50000} precision={0} onChange={number => { if (number !== null) { if (key === 'x' || key === 'y') change(moveNodes(latest.current, [selectedNode.id], key === 'x' ? number - selectedNode.x : 0, key === 'y' ? number - selectedNode.y : 0)); else editNode({ ...selectedNode, [key]: number }); } }} /></label>)}</div>
        <label>所属分组<Select {...canvasSelectProps} aria-label="节点所属分组" value={selectedNode.regionId ?? ''} options={[{ value: '', label: '无分组' }, ...orderedRegions(regions).map(r => ({ value: r.id, label: r.label }))]} onChange={regionId => editNode({ ...selectedNode, regionId })} /></label>
        {selectedNode.assetId && <Button type="link" onClick={() => onAsset(selectedNode.assetId!)}>打开资产台账</Button>}
      </>}
      {selectedEdgeItem && <>
        <Typography.Text className="topology-edge-summary">{nodeInfo.get(selectedEdgeItem.from)?.name} → {nodeInfo.get(selectedEdgeItem.to)?.name}</Typography.Text>
        <label>备注<Input aria-label="连线备注" value={selectedEdgeItem.label} maxLength={128} onChange={(event) => editEdge({ ...selectedEdgeItem, label: event.target.value })} /></label>
        <label>颜色<div className="topology-edge-colors" role="group" aria-label="连线颜色">{edgeColors.map((color) => <button key={color.value} type="button" aria-label={`连线颜色${color.label}`} title={color.label} aria-pressed={edgeColor(selectedEdgeItem) === color.value} style={{ background: color.value }} onClick={() => editEdge({ ...selectedEdgeItem, color: color.value })} />)}</div></label>
        <label>线型<Select {...canvasSelectProps} aria-label="连线样式" value={selectedEdgeItem.style ?? 'solid'} options={[{ value: 'solid', label: '实线' }, { value: 'dashed', label: '虚线' }, { value: 'dotted', label: '点线' }]} onChange={(style) => editEdge({ ...selectedEdgeItem, style })} /></label>
        <label>箭头<Select {...canvasSelectProps} aria-label="连线箭头方向" value={selectedEdgeItem.direction ?? 'forward'} options={[{ value: 'none', label: '无箭头' }, { value: 'forward', label: '起点 → 终点' }, { value: 'reverse', label: '终点 → 起点' }, { value: 'both', label: '双向' }]} onChange={(direction) => editEdge({ ...selectedEdgeItem, direction })} /></label>
        <label>走线<Select {...canvasSelectProps} aria-label="连线走线方式" value={selectedEdgeItem.routing ?? 'orthogonal'} options={[{ value: 'orthogonal', label: '正交自动绕线' }, { value: 'straight', label: '直线／自由折线' }]} onChange={(routing) => editEdge({ ...selectedEdgeItem, routing, waypoints: [] })} /></label>
        <Typography.Text type="secondary">默认避开节点；拖动线段平行调整走线，拖动端点重新连接。</Typography.Text>
        {!!selectedEdgeItem.waypoints?.length && <Button size="small" onClick={() => editEdge({ ...selectedEdgeItem, waypoints: [] })}>清除折点</Button>}
      </>}
      {selectedRegionItem && <>
        <label>名称<Input aria-label="拓扑区域名称" value={selectedRegionItem.label} maxLength={80} onChange={(event) => editRegion({ ...selectedRegionItem, label: event.target.value })} /></label>
        <label className="topology-color-picker">区域底色<input aria-label="拓扑区域底色" type="color" value={selectedRegionItem.color} onInput={(event) => editRegion({ ...selectedRegionItem, color: event.currentTarget.value })} /></label>
        <label>上级分组<Select {...canvasSelectProps} aria-label="区域上级分组" value={selectedRegionItem.parentId ?? ''} options={[{ value: '', label: '顶层分组' }, ...orderedRegions(regions).filter(r => r.id !== selectedRegionItem.id && !descendants(regions, selectedRegionItem.id).has(r.id)).map(r => ({ value: r.id, label: r.label }))]} onChange={parentId => editRegion({ ...selectedRegionItem, parentId: parentId || undefined })} /></label>
        <div className="topology-property-section">布局</div>
        <div className="topology-dimensions">{(['width', 'height'] as const).map(key => <label key={key}>{key === 'width' ? '宽度' : '高度'}<InputNumber aria-label={`分组${key}`} min={key === 'width' ? 160 : 120} max={50000} precision={0} value={selectedRegionItem[key]} onChange={number => { if (number !== null) editRegion({ ...selectedRegionItem, [key]: number }); }} /></label>)}</div>
        <Typography.Text type="secondary">拖动标题可移动整个分组；拖动设备到容器内可加入分组。解散分组会保留全部节点与连线。</Typography.Text>
        <Button aria-label="解散分组" icon={<UngroupOutlined />} onClick={deleteSelection}>解散分组</Button>
      </>}
      {selected.length > 1 && <><Select {...canvasSelectProps} aria-label="多选节点对齐" placeholder="对齐所选节点" value={undefined} options={alignOptions} onChange={align} /><Button icon={<GroupOutlined />} disabled={regions.length >= 500} onClick={makeGroup}>将所选节点成组</Button><Typography.Text type="secondary">共 {selected.length} 个节点，拖动可整体移动。复制时会保留节点之间的连线。</Typography.Text></>}
      {!!selected.length && <Space><Button onClick={copy}>复制</Button><Button onClick={() => paste(true)}>创建副本</Button></Space>}
      {!selectedRegionItem && <Button danger icon={<DeleteOutlined />} onClick={deleteSelection}>删除所选</Button>}
      </> : <div className="topology-inspector-empty"><SelectOutlined /><strong>选择一个对象</strong><span>点击设备、连线或分组，<br />在这里编辑属性与布局。</span><div className="topology-shortcut-list"><span>多选</span><kbd>Ctrl + 点击</kbd><span>成组</span><kbd>Ctrl + G</kbd><span>创建副本</span><kbd>Ctrl + D</kbd><span>平移画布</span><kbd>空格 + 拖动</kbd></div>{clipboardReady && <Button onClick={() => paste()}>粘贴已复制节点</Button>}</div> : <>
        <div className="topology-property-section">显示</div>
        <label>画布背景<Select {...canvasSelectProps} aria-label="画布背景" value={grid} options={[{ value: 'square', label: '方格' }, { value: 'dots', label: '点阵' }, { value: 'none', label: '纯色' }]} onChange={setGrid} /></label>
        <Checkbox checked={snap} onChange={event => setSnap(event.target.checked)}>网格与对齐吸附</Checkbox>
        <Typography.Text type="secondary">开启后以 20 px 网格吸附，并显示节点对齐参考线。</Typography.Text>
        <div className="topology-property-section">当前拓扑</div>
        <div className="topology-scene-stats"><span>设备节点<strong>{value.nodes.length}</strong></span><span>连接关系<strong>{value.edges.length}</strong></span><span>分组容器<strong>{regions.length}</strong></span></div>
        <Button icon={<AimOutlined />} onClick={fitCanvas}>适应画布</Button>
        {regions.length > 0 && <><div className="topology-property-section">分组导航</div>{orderedRegions(regions).map(region => <Button type="text" className="topology-region-nav" key={region.id} icon={<GroupOutlined />} onClick={() => graph.current?.locateRegion(region.id)}>{region.label}</Button>)}</>}
      </>}
      </div>
    </aside>}
    </div>
    <div className="topology-status"><div className="topology-status-hint"><span className={`topology-status-dot${connectionStart ? ' is-connecting' : ''}`} /><span>{tool === 'connect' ? connectionStart ? `已选起点 ${nodeInfo.get(connectionStart)?.name ?? ''}，点击终点连接 · Esc 取消` : '依次点击起点和终点，或拖动连接点连线' : tool === 'pan' ? '拖动画布平移 · 滚轮移动 · Ctrl + 滚轮缩放' : selected.length ? `已选 ${selected.length} 个节点 · 方向键微调 · Ctrl + G 成组` : '拖入设备 · 拖动连接点连线 · 空白处框选 · 空格平移'}</span></div><div className="topology-status-count">{value.nodes.length} 节点<span>·</span>{value.edges.length} 连线</div><div className="topology-zoom"><Button type="text" size="small" aria-label="缩小拓扑" onClick={() => setZoom(current => Math.max(.01, current / 1.25))}>−</Button><button type="button" className="topology-zoom-value" aria-label="重置拓扑缩放" title="恢复 100%" onClick={() => graph.current?.zoom(1)}>{Math.round(zoom * 100)}%</button><Button type="text" size="small" aria-label="放大拓扑" onClick={() => setZoom(current => Math.min(3, current * 1.25))}>＋</Button><Tooltip title="适应画布"><Button type="text" size="small" aria-label="适应画布" icon={<AimOutlined />} onClick={fitCanvas} /></Tooltip></div></div>
    {context && <div className="topology-context-menu" style={{ left: context.x, top: context.y }} onPointerDown={(event) => event.stopPropagation()} onContextMenu={(event) => event.stopPropagation()}>
      {context.nodeId ? <>
        <Space><Button size="small" onClick={() => { copy(); setContext(undefined); }}>复制节点</Button><Button size="small" onClick={() => { paste(true); setContext(undefined); }}>创建副本</Button></Space>
        <Button size="small" disabled={(selectedNode?.connectionPoints?.length ?? 0) >= 100} onClick={addPort}>在此边缘添加连接点</Button>
        {context.portId && <><Button size="small" onClick={() => { setMovingPort({ nodeId: context.nodeId!, portId: context.portId! }); setContext(undefined); }}>调整连接点位置（随后拖动此点）</Button><Button size="small" onClick={removePort}>移除／复位连接点</Button></>}
        {selectedNode?.assetId && <Button size="small" onClick={() => { onAsset(selectedNode.assetId!); setContext(undefined); }}>打开资产台账</Button>}
        <Typography.Text type="secondary">拖动连接点连线；Alt+拖动连接点可调整位置。节点备注在右侧直接编辑。</Typography.Text><Button danger size="small" onClick={deleteSelection}>删除节点</Button>
      </> : context.edgeId || context.regionId ? <><Typography.Text>在右侧调整{context.edgeId ? '连线备注、箭头和线型' : '分组名称、底色和上级'}</Typography.Text><Button danger size="small" onClick={deleteSelection}>{context.regionId ? '解散分组，保留节点' : '删除所选'}</Button></> : <>
        {clipboardReady && <Button size="small" onClick={() => { paste(); setContext(undefined); }}>粘贴节点</Button>}
        <Typography.Text strong>添加系统资产</Typography.Text>
        <Select {...canvasSelectProps} aria-label="右键选择拓扑资产" mode="multiple" showSearch optionFilterProp="label" value={assetChoice} options={availableAssets.map((asset) => ({ value: asset.id, label: `${asset.name} · ${asset.ip || asset.host}` }))} onChange={setAssetChoice} placeholder="多选服务器资产" />
        <Button type="primary" size="small" disabled={!assetChoice.length || value.nodes.length + assetChoice.length > 1000} onClick={addAssets}>添加资产</Button>
        <Space><Button size="small" disabled={value.nodes.length >= 1000} onClick={() => addObject()}>新增网络节点</Button><Button size="small" disabled={regions.length >= 500} onClick={() => addObject(true)}>新增区域</Button></Space>
      </>}
    </div>}
    </ConfigProvider>
  </div>, host)}</div>;
}

export default memo(TopologyCanvas);
