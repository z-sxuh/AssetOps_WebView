import { TreeSelect, type TreeSelectProps } from 'antd';
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Unit } from '../../model';
import { entryScopeValue, scopeTree, type EntryScope, type ScopeNode } from './reportModel';
import { selectPlacements } from '../../components/AppSelect';

const emptyNodes: ScopeNode[] = [];

export default function ScopeSelect({ units, scope, value, label = '工作记录归属', extraNodes = emptyNodes, unitsOnly = false, disabled, onChange, active = true, open, listHeight = 280, onDropdownVisibleChange, ...popup }: { units: Unit[]; scope: EntryScope & { scopeName?: string }; value?: string; label?: string; extraNodes?: ScopeNode[]; unitsOnly?: boolean; disabled?: boolean; active?: boolean; onChange: (value: string) => void } & Pick<TreeSelectProps, 'open' | 'listHeight' | 'onDropdownVisibleChange' | 'getPopupContainer'>) {
  const tree = useMemo(() => unitsOnly ? scopeTree(units).map(node => ({ ...node, children: undefined })) : scopeTree(units), [units, unitsOnly]);
  const [localOpen, setLocalOpen] = useState(false);
  const [popupWidth, setPopupWidth] = useState<number>();
  const popupRef = useRef<HTMLDivElement | null>(null);
  const widthCache = useRef<{ tree: ScopeNode[]; extraNodes: ScopeNode[]; font: string; width: number }>();
  const selectingBranch = useRef(false);
  const visible = active && (open ?? localOpen);
  useLayoutEffect(() => { if (!active) { setLocalOpen(false); selectingBranch.current = false; } }, [active]);
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  const measurePopup = useCallback((element: HTMLDivElement | null) => {
    popupRef.current = element;
    if (!element?.isConnected || !visibleRef.current) return;
    const title = element.querySelector<HTMLElement>('.ant-select-tree-title');
    if (!title) return;
    const menu = element.closest<HTMLElement>('.scope-tree-dropdown')!;
    const typography = getComputedStyle(title);
    const content = getComputedStyle(element.querySelector('.ant-select-tree-node-content-wrapper')!);
    const surface = getComputedStyle(menu.firstElementChild!);
    const switcher = getComputedStyle(element.querySelector('.ant-select-tree-switcher')!);
    const indent = Number.parseFloat(getComputedStyle(menu).getPropertyValue('--scope-tree-indent'));
    const font = [typography.fontStyle, typography.fontSize, typography.fontFamily, typography.letterSpacing, indent, switcher.width, content.paddingLeft, content.paddingRight, surface.paddingLeft, surface.paddingRight, window.devicePixelRatio].join('|');
    if (widthCache.current?.tree === tree && widthCache.current.extraNodes === extraNodes && widthCache.current.font === font) {
      setPopupWidth(widthCache.current.width); return;
    }
    const context = document.createElement('canvas').getContext('2d')!;
    context.font = `${typography.fontStyle} 600 ${typography.fontSize} ${typography.fontFamily}`;
    const spacing = Number.parseFloat(typography.letterSpacing) || 0;
    let width = 0;
    const measure = (nodes: ScopeNode[], depth = 0) => {
      for (const node of nodes) {
        width = Math.max(width, context.measureText(node.title).width + Math.max(0, node.title.length - 1) * spacing + depth * indent);
        if (node.children) measure(node.children, depth + 1);
      }
    };
    measure(tree); measure(extraNodes);
    const measured = Math.ceil(width + (unitsOnly ? 0 : Number.parseFloat(switcher.width)) + Number.parseFloat(content.paddingLeft) + Number.parseFloat(content.paddingRight) + Number.parseFloat(surface.paddingLeft) + Number.parseFloat(surface.paddingRight) + 12);
    widthCache.current = { tree, extraNodes, font, width: measured }; setPopupWidth(measured);
  }, [tree, extraNodes, unitsOnly]);
  useLayoutEffect(() => { if (visible) measurePopup(popupRef.current); }, [visible, measurePopup]);
  useLayoutEffect(() => {
    if (!visible) return;
    const refresh = () => { widthCache.current = undefined; measurePopup(popupRef.current); };
    window.addEventListener('resize', refresh); document.fonts?.addEventListener('loadingdone', refresh);
    return () => { window.removeEventListener('resize', refresh); document.fonts?.removeEventListener('loadingdone', refresh); };
  }, [visible, measurePopup]);
  return <TreeSelect {...popup} aria-label={label} className="report-scope-select" value={value ?? entryScopeValue(scope, units)} placeholder={scope.scopeName || (unitsOnly ? '选择单位' : '选择单位／环境／区域／系统')} disabled={disabled} treeData={extraNodes.length ? [...tree, ...extraNodes] : tree} showSearch treeExpandAction={unitsOnly ? false : 'click'} treeNodeFilterProp="path" treeNodeLabelProp="path" popupMatchSelectWidth={popupWidth ?? true} popupRender={(menu) => <div ref={measurePopup}>{menu}</div>} builtinPlacements={selectPlacements} listHeight={listHeight} classNames={{ popup: { root: `scope-tree-dropdown${unitsOnly ? ' unit-scope-dropdown' : ''}` } }} styles={{ popup: { root: { maxWidth: 'calc(100vw - 24px)' } } }} onChange={onChange}
    onKeyDown={(event) => { if (visible && event.key === 'Escape') event.stopPropagation(); }}
    open={visible} onSelect={(_, node) => { selectingBranch.current = Boolean(node.children?.length); }} onDropdownVisibleChange={(next) => { const nextVisible = next || selectingBranch.current; selectingBranch.current = false; setLocalOpen(nextVisible); onDropdownVisibleChange?.(nextVisible); }} />;
}
