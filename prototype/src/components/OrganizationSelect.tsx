import { TreeSelect } from 'antd';
import type { CSSProperties } from 'react';
import { useLayoutEffect, useMemo, useState } from 'react';
import type { Unit } from '../model';
import { scopeTree, type ScopeNode, type EntryScope } from '../features/reports/reportModel';
import { selectPlacements } from './AppSelect';

type Level = keyof EntryScope;
type Node = { title: string; value: string; path: string; selectable: boolean; children?: Node[] };

// 需要具体对象的表单使用真实 ID；父目录仅展开，不能充当目标系统。
export default function OrganizationSelect({ active = true, units, level, value, onChange, options = [], placeholder = '选择组织目录', label, style, disabled, allowClear, id }: {
  active?: boolean;
  units: Unit[]; level: Level; value?: string; onChange?: (value: string | undefined) => void;
  options?: Array<{ value: string; label: string }>; placeholder?: string; label?: string;
  style?: CSSProperties; disabled?: boolean; allowClear?: boolean; id?: string;
}) {
  const [popupOpen, setPopupOpen] = useState(false);
  useLayoutEffect(() => { if (!active) setPopupOpen(false); }, [active]);
  const tree = useMemo(() => {
    const order: Level[] = ['unitId', 'environmentId', 'zoneId', 'systemId'];
    const convert = (nodes: ScopeNode[]): Node[] => nodes.flatMap((node) => {
      const current = [...order].reverse().find((key) => node.scope[key]);
      if (!current || order.indexOf(current) > order.indexOf(level)) return [];
      const children = node.children ? convert(node.children) : undefined;
      if (current !== level && !children?.length) return [];
      return [{ title: node.title, path: node.path, value: node.scope[current]!, selectable: current === level, children }];
    });
    return convert(scopeTree(units));
  }, [units, level]);
  return <TreeSelect id={id} aria-label={label} open={active && popupOpen} className="report-scope-select organization-select" value={value} onChange={onChange} disabled={disabled} allowClear={allowClear} style={style} placeholder={placeholder} treeData={[...options.map((option) => ({ title: option.label, path: option.label, value: option.value, selectable: true })), ...tree]} showSearch treeExpandAction="click" treeNodeFilterProp="path" treeNodeLabelProp="path" popupMatchSelectWidth listHeight={280} builtinPlacements={selectPlacements} classNames={{ popup: { root: `scope-tree-dropdown${level === 'unitId' ? ' unit-tree-dropdown' : ''}` } }} styles={{ popup: { root: { maxWidth: 'min(620px, calc(100vw - 48px))' } } }}
    onDropdownVisibleChange={setPopupOpen}
    onInputKeyDown={(event) => { if (event.nativeEvent.isComposing && event.key === 'Escape') event.stopPropagation(); }}
    onKeyDown={(event) => { if (popupOpen && event.key === 'Escape') event.stopPropagation(); }} />;
}
