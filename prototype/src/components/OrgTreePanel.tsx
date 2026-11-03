import { ApartmentOutlined, DownOutlined, MenuFoldOutlined, MenuUnfoldOutlined, PlusOutlined, SearchOutlined } from '@ant-design/icons';
import { Button, Card, Dropdown, Input, Menu, Space } from 'antd';
import type { MenuProps } from 'antd';
import type { MenuRef } from 'antd/es/menu';
import { cloneElement, createContext, memo, startTransition, useCallback, useContext, useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { MouseEvent as ReactMouseEvent, ReactNode } from 'react';
import type { VaultData } from '../model';
import type { StructureTarget } from '../features/structure/StructureManager';
import { filterOrganizationTree } from '../organizationTree';

type Scope = { unit: string | null; environment: string | null; zone: string | null; system: string | null };

type Props = {
  active?: boolean;
  commitPendingSelection?: boolean;
  data: VaultData;
  activeUnit: string | null;
  activeEnvironment: string | null;
  activeZone: string | null;
  activeSystem: string | null;
  revealPath: { ids: string[]; token: number } | null;
  onSelect: (unit: string | null, environment: string | null, zone: string | null, system: string | null) => void;
  onManage?: (target: StructureTarget) => void;
  onCreate?: () => void;
  onToggleDirectory?: () => void;
  directoryCollapsed?: boolean;
  transfer?: ReactNode;
  footer?: ReactNode;
  disabled: boolean;
};

// 节点高亮通过 context 传递，结构不随选中状态重建。
const TreeActiveContext = createContext<{ unit: string | null; environment: string | null; zone: string | null; system: string | null }>({ unit: null, environment: null, zone: null, system: null });

const TreeLabel = memo(function TreeLabel({ kind, id, className, extraClassName, onClick, children, ...rest }: {
  kind: 'unit' | 'environment' | 'zone' | 'system';
  id: string;
  className?: string;
  extraClassName?: string;
  onClick: (event: ReactMouseEvent<HTMLSpanElement>) => void;
  children: ReactNode;
} & Omit<React.HTMLAttributes<HTMLSpanElement>, 'className' | 'onClick'>) {
  const active = useContext(TreeActiveContext);
  const isActive = kind === 'unit' ? active.unit === id && !active.environment
    : kind === 'environment' ? active.environment === id && !active.zone && !active.system
    : kind === 'zone' ? active.zone === id && !active.system
    : active.system === id;
  const merged = [`tree-${kind}`, extraClassName, className].filter(Boolean).join(' ');
  return <span {...rest} className={merged} data-tree-kind={kind} data-tree-id={id} data-active={isActive || undefined} onClick={onClick}>{children}</span>;
});

// 组织目录独立成记忆化组件：展开/收缩只重渲染树本身，不再触发整页重渲染。
export default memo(function OrgTreePanel({ active = true, commitPendingSelection = false, data, activeUnit, activeEnvironment, activeZone, activeSystem, revealPath, onSelect, onManage, onCreate, onToggleDirectory, directoryCollapsed = false, transfer, disabled, footer }: Props) {
  const [expanded, setExpanded] = useState<string[]>([]);
  const [width, setWidth] = useState(218);
  const expandedRef = useRef(expanded);
  const previousExpanded = useRef(expanded);
  const changeExpanded = useCallback((keys: string[]) => { expandedRef.current = keys; setExpanded(keys); }, []);
  const [query, setQuery] = useState('');
  const deferredQuery = useDeferredValue(query);
  const search = useMemo(() => filterOrganizationTree(data.units, deferredQuery), [data.units, deferredQuery]);
  const beforeSearch = useRef<string[] | null>(null);
  useEffect(() => {
    if (deferredQuery.trim()) {
      beforeSearch.current ??= [...expandedRef.current];
      changeExpanded([...new Set([...expandedRef.current, ...search.expanded])]);
    } else if (beforeSearch.current) { changeExpanded(beforeSearch.current); beforeSearch.current = null; }
  }, [deferredQuery, search, changeExpanded]);
  const panelRef = useRef<HTMLDivElement>(null);
  const unitInsets = useRef(116);
  useLayoutEffect(() => {
    const host = panelRef.current, workspace = host?.closest<HTMLElement>('[data-organization-workspace]');
    if (!host || !workspace) return;
    const context = document.createElement('canvas').getContext('2d');
    if (!context) return;
    context.font = `600 12px ${getComputedStyle(host).fontFamily}`;
    const longest = data.units.reduce((value, unit) => Math.max(value, context.measureText(unit.name).width), 0);
    let measured = false;
    const fit = () => {
      if (!workspace.clientWidth) return;
      if (!measured) {
        for (const unit of host.querySelectorAll<HTMLElement>('.tree-unit')) {
          const style = getComputedStyle(unit), children = [...unit.children];
          const other = children.filter((_, index) => index !== 1).reduce((sum, child) => sum + child.getBoundingClientRect().width, 0);
          unitInsets.current = Math.max(unitInsets.current, host.clientWidth - unit.getBoundingClientRect().width + other + (parseFloat(style.columnGap) || 0) * (children.length - 1));
        }
        measured = true;
      }
      setWidth(Math.round(Math.max(218, Math.min(Math.ceil(longest + unitInsets.current), 420, workspace.clientWidth * .45))));
    };
    const observer = new ResizeObserver(fit);
    observer.observe(workspace); fit();
    return () => observer.disconnect();
  }, [data.units, data.assets]);
  const selectRef = useRef(onSelect);
  useLayoutEffect(() => { selectRef.current = onSelect; }, [onSelect]);
  const [optimisticScope, setOptimisticScope] = useState<Scope | null>(null);
  const [reducedMotion, setReducedMotion] = useState(() => typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  const activeRef = useRef(active);
  const pendingScope = useRef<{ scope: Scope; branch: string; opening: boolean; owner?: HTMLElement } | null>(null);
  const pendingTimer = useRef<number>();
  const runningHeights = useRef(new Set<HTMLElement>());
  const branchList = useCallback((branch: string) => {
    const label = [...(panelRef.current?.querySelectorAll<HTMLElement>('[data-tree-id]') ?? [])].find(item => item.dataset.treeId === branch);
    return label?.closest('li')?.querySelector<HTMLElement>(':scope > .ant-menu-sub');
  }, []);
  const heightOwner = useCallback((list?: HTMLElement | null) => [...runningHeights.current].find(node => node.isConnected && list && node.contains(list) && ![...runningHeights.current].some(parent => parent !== node && parent.contains(node))), []);
  const commitScope = useCallback((scope: Scope) => {
    pendingScope.current = null;
    if (pendingTimer.current) { window.clearTimeout(pendingTimer.current); pendingTimer.current = undefined; }
    startTransition(() => {
      setOptimisticScope(null);
      if (activeRef.current) selectRef.current(scope.unit, scope.environment, scope.zone, scope.system);
    });
  }, []);
  const selectScope = useCallback((scope: Scope, branch?: string, opening = false) => {
    if (!activeRef.current) return;
    if (!branch || typeof window === 'undefined' || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      if (pendingScope.current && typeof window !== 'undefined') {
        // 目录仍在动画中：保留高亮和最后一次点击，动画结束后统一筛选，避免表格重算抢占动画帧。
        pendingScope.current.scope = scope;
        if (pendingTimer.current) window.clearTimeout(pendingTimer.current);
        pendingTimer.current = window.setTimeout(() => {
          const pending = pendingScope.current;
          if (pending) commitScope(pending.scope);
        }, 220);
        setOptimisticScope(scope);
        return;
      }
      commitScope(scope); return;
    }
    pendingScope.current = { scope, branch, opening, owner: heightOwner(branchList(branch)) };
    setOptimisticScope(scope);
  }, [commitScope, branchList, heightOwner]);
  useLayoutEffect(() => {
    const host = panelRef.current;
    if (!host) return;
    let frame = 0;
    const track = (event: TransitionEvent) => {
      if (event.propertyName !== 'height' || !(event.target instanceof HTMLElement) || !event.target.matches('.ant-menu-sub')) return;
      const node = event.target;
      if (event.type === 'transitionrun' || event.type === 'transitionstart') {
        runningHeights.current.add(node);
        const pending = pendingScope.current;
        if (pending) pending.owner = heightOwner(branchList(pending.branch)) ?? pending.owner;
      } else {
        runningHeights.current.delete(node);
        if (event.type !== 'transitioncancel' || pendingScope.current?.owner !== node) return;
        cancelAnimationFrame(frame);
        frame = requestAnimationFrame(() => {
          const pending = pendingScope.current;
          if (!pending || pending.owner !== node) return;
          // 反向的 transitionrun 可能紧随 cancel；按这一帧实际动画接续，不增加选择延时。
          const owner = heightOwner(branchList(pending.branch));
          if (owner) pending.owner = owner;
          else if (!node.getAnimations().some(animation => 'transitionProperty' in animation && animation.transitionProperty === 'height' && animation.playState !== 'finished' && animation.playState !== 'idle')) commitScope(pending.scope);
        });
      }
    };
    for (const name of ['transitionrun', 'transitionstart', 'transitionend', 'transitioncancel']) host.addEventListener(name, track as EventListener, true);
    return () => {
      cancelAnimationFrame(frame);
      runningHeights.current.clear();
      for (const name of ['transitionrun', 'transitionstart', 'transitionend', 'transitioncancel']) host.removeEventListener(name, track as EventListener, true);
    };
  }, [branchList, heightOwner, commitScope]);
  useLayoutEffect(() => {
    // 同页收起目录时保留最后一次选择；切换页面仍取消待提交的选择。
    if (!active && commitPendingSelection && pendingScope.current) commitScope(pendingScope.current.scope);
    activeRef.current = active;
    if (!active) { pendingScope.current = null; setOptimisticScope(null); if (pendingTimer.current) window.clearTimeout(pendingTimer.current); }
  }, [active, commitPendingSelection, commitScope]);
  useLayoutEffect(() => {
    pendingScope.current = null; setOptimisticScope(null); if (pendingTimer.current) window.clearTimeout(pendingTimer.current);
  }, [activeUnit, activeEnvironment, activeZone, activeSystem, revealPath]);
  useLayoutEffect(() => {
    const previous = previousExpanded.current; previousExpanded.current = expanded;
    const pending = pendingScope.current;
    if (!pending || previous.includes(pending.branch) !== expanded.includes(pending.branch)) return;
    const list = branchList(pending.branch);
    // 同批次开后即关，最终 openKeys 未变，rc-motion 不会发出结束事件。
    if (!pending.owner && !list?.className.includes('ant-motion-collapse-')) commitScope(pending.scope);
  }, [expanded, commitScope, branchList]);
  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => { setReducedMotion(media.matches); if (media.matches && pendingScope.current) commitScope(pendingScope.current.scope); };
    media.addEventListener('change', update);
    return () => { media.removeEventListener('change', update); pendingScope.current = null; if (pendingTimer.current) window.clearTimeout(pendingTimer.current); };
  }, [commitScope]);
  const motion = useMemo<MenuProps['motion']>(() => {
    const end: NonNullable<MenuProps['motion']>['onEnterEnd'] = (node, event) => {
      if (!event?.deadline && (!event || !('propertyName' in event) || event.propertyName !== 'height')) return false;
      const pending = pendingScope.current;
      const label = node?.parentElement?.querySelector<HTMLElement>(':scope > .ant-menu-submenu-title [data-tree-id]');
      if (pending && (pending.owner ? pending.owner === node : label?.dataset.treeId === pending.branch)) commitScope(pending.scope);
      return true;
    };
    const collapsed = () => ({ height: 0, opacity: 0 });
    const expandedHeight = (node: HTMLElement) => ({ height: node.scrollHeight, opacity: 1 });
    return {
      motionName: 'ant-motion-collapse', motionDeadline: 500,
      motionAppear: !reducedMotion, motionEnter: !reducedMotion, motionLeave: !reducedMotion,
      onAppearStart: collapsed, onEnterStart: collapsed,
      onAppearActive: expandedHeight, onEnterActive: expandedHeight,
      onLeaveStart: node => ({ height: node?.offsetHeight ?? 0 }), onLeaveActive: collapsed,
      onAppearEnd: end, onEnterEnd: end, onLeaveEnd: end,
      onVisibleChanged: () => {
        // 快速反向可能在过渡开始前被合并；此时直接按最终 DOM 状态结算。
        const pending = pendingScope.current;
        if (!pending) return;
        const list = branchList(pending.branch);
        if (!pending.owner && list && !list.className.includes('ant-motion-collapse-') && !list.classList.contains('ant-menu-hidden') === pending.opening) commitScope(pending.scope);
      },
    };
  }, [commitScope, reducedMotion, branchList]);
  const contextTarget = useRef<Pick<StructureTarget, 'type' | 'id'> | null>(null);
  const contextOrigin = useRef<HTMLElement | null>(null);
  const [contextOpen, setContextOpen] = useState(false);
  const contextFocusObserver = useRef<MutationObserver>();
  const focusContextMenu = useCallback((menu: MenuRef | null) => {
    contextFocusObserver.current?.disconnect();
    const popup = menu?.menu?.list.closest<HTMLElement>('.ant-dropdown');
    if (!popup || !contextOpen) return;
    const focus = () => {
      if (!activeRef.current || disabled || !contextOrigin.current?.isConnected) { contextFocusObserver.current?.disconnect(); return; }
      if (!popup.isConnected || !popup.hasAttribute('data-motion-ready') || popup.hasAttribute('data-position-pending') || popup.hasAttribute('data-position-closed')) return;
      menu?.focus({ preventScroll: true }); contextFocusObserver.current?.disconnect();
    };
    contextFocusObserver.current = new MutationObserver(focus);
    contextFocusObserver.current.observe(popup, { attributes: true, attributeFilter: ['data-motion-ready', 'data-position-pending', 'data-position-closed', 'class', 'style'] });
    focus();
  }, [contextOpen, disabled]);
  useEffect(() => () => contextFocusObserver.current?.disconnect(), []);
  const closeContextMenu = () => {
    setContextOpen(false); contextTarget.current = null; contextFocusObserver.current?.disconnect();
    if (activeRef.current && contextOrigin.current?.isConnected && !disabled) contextOrigin.current.focus({ preventScroll: true });
    contextOrigin.current = null;
  };
  useLayoutEffect(() => { if (!active || disabled) { setContextOpen(false); contextTarget.current = null; contextOrigin.current = null; } }, [active, disabled]);
  const unitBranches = useMemo(() => new Map(data.units.map(unit => [unit.id, [unit.id, ...unit.environments.flatMap(environment => [environment.id, ...environment.zones.filter(zone => zone.name).map(zone => zone.id)])]])), [data.units]);
  useLayoutEffect(() => {
    const pending = pendingScope.current;
    if (pending && ![...unitBranches.values()].some(branch => branch.includes(pending.branch))) {
      pendingScope.current = null; setOptimisticScope(null);
    } else if (pending?.owner && !pending.owner.isConnected) commitScope(pending.scope);
  }, [unitBranches, commitScope]);
  const counts = useMemo(() => {
    const result = new Map<string, number>();
    for (const asset of data.assets) for (const key of [asset.unitId, asset.environmentId, asset.zoneId, asset.systemId]) result.set(key, (result.get(key) ?? 0) + 1);
    return result;
  }, [data.assets]);
  useEffect(() => {
    if (revealPath && !revealPath.ids.every(key => expandedRef.current.includes(key))) changeExpanded([...new Set([...expandedRef.current, ...revealPath.ids])]);
  }, [revealPath, changeExpanded]);

  const structureItems = useMemo(() => {
    const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name, 'zh-CN', { sensitivity: 'base', numeric: true });
    return [...search.units].sort(byName).map((unit) => ({
    key: unit.id,
    // 单位点击只展开当前层；收起时清理本单位的下级展开状态。
    label: <TreeLabel kind="unit" id={unit.id} onClick={(event) => { event.stopPropagation(); const branch = unitBranches.get(unit.id) ?? []; const current = expandedRef.current; const opening = !current.includes(unit.id); selectScope({ unit: unit.id, environment: null, zone: null, system: null }, unit.environments.length ? unit.id : undefined, opening); changeExpanded(opening ? [...new Set([...current, unit.id])] : current.filter(key => !branch.includes(key))); }}>
      <ApartmentOutlined /> <span>{unit.name}</span><i>{counts.get(unit.id) ?? 0}</i>
    </TreeLabel>,
    children: [...unit.environments].sort(byName).map((environment) => ({
      key: environment.id,
      label: <TreeLabel kind="environment" id={environment.id} onClick={() => selectScope({ unit: unit.id, environment: environment.id, zone: null, system: null }, environment.zones.some(zone => zone.name || zone.systems.length) ? environment.id : undefined, !expandedRef.current.includes(environment.id))}>
        <span>{environment.name}</span><i>{counts.get(environment.id) ?? 0}</i>
      </TreeLabel>,
      children: [...environment.zones].sort(byName).flatMap((zone) => {
        const children = [...zone.systems].sort(byName).map((system) => ({ key: system.id, label: <TreeLabel kind="system" id={system.id} extraClassName={zone.name ? undefined : 'tree-direct-system'} onClick={() => selectScope({ unit: unit.id, environment: environment.id, zone: zone.id, system: system.id })}><span>{system.name}</span><i>{counts.get(system.id) ?? 0}</i></TreeLabel> }));
        return zone.name ? [{ key: zone.id, label: <TreeLabel kind="zone" id={zone.id} onClick={() => selectScope({ unit: unit.id, environment: environment.id, zone: zone.id, system: null }, zone.systems.length ? zone.id : undefined, !expandedRef.current.includes(zone.id))}><span>{zone.name}</span><i>{counts.get(zone.id) ?? 0}</i></TreeLabel>, children }] : children;
      }),
    })),
  }));
  }, [search.units, counts, unitBranches, selectScope, changeExpanded]);

  // 展开/收缩走 antd 默认的内联折叠动画（ant-motion-collapse，按真实高度做 height 过渡），
  // 节奏统一在 styles.css 的 --tree-motion-* 里调；此前显式关掉了 motion，开合是瞬间跳变的。
  const toggleAll = () => changeExpanded(expandedRef.current.length ? [] : [...unitBranches.values()].flat());
  const activeValue = useMemo(() => optimisticScope ?? ({ unit: activeUnit, environment: activeEnvironment, zone: activeZone, system: activeSystem }), [optimisticScope, activeUnit, activeEnvironment, activeZone, activeSystem]);

  return <div ref={panelRef} className="tree-panel-host" style={{ width }}><Card className="tree-panel" bordered={false} title={<Space className="tree-toolbar" size={4}><span>组织目录</span>{onToggleDirectory && <Button size="small" icon={directoryCollapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />} disabled={disabled} aria-expanded={!directoryCollapsed} aria-label={directoryCollapsed ? '展开目录树' : '折叠目录树'} title={directoryCollapsed ? '展开目录树' : '折叠目录树'} onClick={onToggleDirectory} />}</Space>} extra={<Space className="tree-toolbar" size={4}>{onCreate && <Button size="small" icon={<PlusOutlined />} disabled={disabled} aria-label="新建组织结构" title="新建组织结构" onClick={onCreate} />}{transfer}<Button size="small" icon={<DownOutlined rotate={expanded.length ? 180 : 0} />} disabled={disabled} aria-label={expanded.length ? '收缩全部' : '展开全部'} title={expanded.length ? '收缩全部' : '展开全部'} onClick={toggleAll} /></Space>}>
    <div className="tree-search"><Input size="small" aria-label="搜索组织目录" prefix={<SearchOutlined />} allowClear disabled={disabled} value={query} onChange={event => setQuery(event.target.value)} /></div>
    {structureItems.length ? <TreeActiveContext.Provider value={activeValue}><Dropdown trigger={['contextMenu']} popupRender={menu => cloneElement(menu as React.ReactElement<React.RefAttributes<MenuRef>>, { ref: focusContextMenu })} open={active && !disabled && contextOpen} onOpenChange={setContextOpen} disabled={!active || disabled || !onManage} menu={{ onKeyDown: event => {
      if (event.key !== 'Escape') return;
      event.stopPropagation(); if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
      event.preventDefault(); closeContextMenu();
    }, items: [{ key: 'rename', label: '重命名' }, { key: 'delete', label: '删除', danger: true }], onClick: ({ key, domEvent }) => {
      domEvent.stopPropagation();
      setContextOpen(false);
      if (activeRef.current && !disabled && contextTarget.current && panelRef.current?.querySelector(`[data-tree-id="${CSS.escape(contextTarget.current.id)}"]`)) onManage?.({ ...contextTarget.current, action: key as StructureTarget['action'] });
      contextTarget.current = null;
      contextOrigin.current = null;
    } }}><div className="tree-menu-frame" onContextMenuCapture={event => {
      const item = (event.target as HTMLElement).closest<HTMLElement>('.ant-menu-submenu-title,.ant-menu-item');
      const label = (event.target as HTMLElement).closest<HTMLElement>('[data-tree-kind]') ?? item?.querySelector<HTMLElement>(':scope > .ant-menu-title-content > [data-tree-id]');
      contextTarget.current = label ? { type: label.dataset.treeKind as StructureTarget['type'], id: label.dataset.treeId! } : null;
      contextOrigin.current = item ?? null;
      if (!contextTarget.current || !active || disabled || !onManage) { event.preventDefault(); event.stopPropagation(); }
    }} onKeyDownCapture={event => {
      if (event.key === 'Escape' && contextOpen) { event.stopPropagation(); if (!event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229) { event.preventDefault(); closeContextMenu(); } return; }
      if (event.key !== 'Enter') return;
      const item = (event.target as HTMLElement).closest<HTMLElement>('.ant-menu-submenu-title,.ant-menu-item');
      const label = item?.querySelector<HTMLElement>(':scope > .ant-menu-title-content > [data-tree-id]');
      if (!label) return;
      event.stopPropagation();
      if (event.nativeEvent.isComposing || event.keyCode === 229 || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      event.preventDefault(); label.click();
    }}><Menu motion={motion} mode="inline" inlineIndent={14} items={structureItems} openKeys={expanded} onOpenChange={keys => changeExpanded(keys as string[])} selectedKeys={[activeValue.system ?? activeValue.zone ?? activeValue.environment ?? activeValue.unit ?? '']} /></div></Dropdown></TreeActiveContext.Provider> : <div className="tree-empty">{deferredQuery.trim() ? '没有匹配的目录' : <>还没有组织目录{onCreate && <><br /><Button type="link" size="small" onClick={onCreate}>立即添加</Button></>}</>}</div>}
    {footer}
  </Card></div>;
});
