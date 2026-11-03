import { HolderOutlined } from '@ant-design/icons';
import { Button, Checkbox, Modal } from 'antd';
import Select from './AppSelect';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { TableColumnSetting } from '../model';
import { useDragSort } from './useDragSort';
import { composingCancel } from '../composition';

export type AvailableColumn = {
  key: string;
  label: string;
  fixed?: 'left' | 'right';
  visible?: boolean;
  defaultVisible?: boolean;
};

type Props = {
  open: boolean;
  columns: AvailableColumn[];
  value: TableColumnSetting[];
  visibleKeys: string[];
  saving: boolean;
  onClose: () => void;
  onSave: (value: TableColumnSetting[]) => Promise<void>;
};

function buildSettings(columns: AvailableColumn[], value: TableColumnSetting[], visibleKeys: string[]) {
  const existing = new Map(value.map((item) => [item.key, item]));
  return columns.map((column, index) => ({
    key: column.key,
    fixed: column.fixed,
    sortOrder: index,
    ...existing.get(column.key),
    visible: column.visible ?? visibleKeys.includes(column.key),
    ...(column.key === 'actions' ? { visible: true, fixed: 'right' as const, sortOrder: columns.length } : {}),
    width: undefined,
    widthMode: 'auto' as const,
  })).sort((left, right) => left.sortOrder - right.sortOrder).map((item, index) => ({ ...item, sortOrder: index }));
}

const frozenOptions = [{ value: 'none', label: '不冻结' }, { value: 'left', label: '左侧' }, { value: 'right', label: '右侧' }];
const frozenStyle = { width: 92 };

export default function ColumnSettings({ open, columns, value, visibleKeys, saving, onClose, onSave }: Props) {
  const [draft, setDraft] = useState<TableColumnSetting[]>(() => buildSettings(columns, value, visibleKeys));
  const [initializedOpen, setInitializedOpen] = useState(open);
  if (open !== initializedOpen) {
    setInitializedOpen(open);
    if (open) {
      const next = buildSettings(columns, value, visibleKeys);
      if (next.length !== draft.length || next.some((item, index) => item.key !== draft[index].key || item.visible !== draft[index].visible || item.fixed !== draft[index].fixed || item.sortOrder !== draft[index].sortOrder)) setDraft(next);
    }
  }
  const labels = useMemo(() => new Map(columns.map((column) => [column.key, column.label])), [columns]);
  const drop = (sourceKey: string, targetKey: string) => {
    if (!sourceKey || sourceKey === targetKey || sourceKey === 'actions' || targetKey === 'actions' || saving) return;
    setDraft((current) => {
      const source = current.findIndex((item) => item.key === sourceKey);
      const target = current.findIndex((item) => item.key === targetKey);
      if (source < 0 || target < 0) return current;
      const next = [...current];
      next.splice(target, 0, ...next.splice(source, 1));
      return next.map((item, sortOrder) => ({ ...item, sortOrder }));
    });
  };
  const { start, keyDown, announcement, clearAnnouncement, draggingKey, dropKey } = useDragSort(drop, open && !saving);
  const sortHandlers = useRef({ start, keyDown }); sortHandlers.current = { start, keyDown };
  useEffect(() => { clearAnnouncement(); }, [open]);
  const rows = useMemo(() => draft.map((item) => <div className={`column-setting-row${draggingKey === item.key ? ' is-dragging' : ''}${draggingKey && dropKey === item.key ? ' is-drop-target' : ''}`} key={item.key} data-sort-key={item.key}>
      <Checkbox aria-label={`显示${labels.get(item.key) ?? item.key}列`} checked={item.visible} disabled={saving || item.key === 'actions'} onChange={(event) => setDraft((current) => current.map((entry) => entry.key === item.key ? { ...entry, visible: event.target.checked } : entry))} />
      <b>{item.key !== 'actions' && <button type="button" className="column-drag-handle" data-sort-handle disabled={saving} title="拖拽或使用上下方向键调整顺序" aria-label={`调整${labels.get(item.key) ?? item.key}列顺序，使用上下方向键`} aria-keyshortcuts="ArrowUp ArrowDown" onKeyDown={(event) => sortHandlers.current.keyDown(event, item.key, labels.get(item.key) ?? item.key)} onPointerDown={(event) => { if (!saving) sortHandlers.current.start(event, item.key); }}><HolderOutlined /></button>}{labels.get(item.key) ?? item.key}</b>
      <Select aria-label={`${labels.get(item.key) ?? item.key}列冻结位置`} disabled={saving || item.key === 'actions'} value={item.fixed ?? 'none'} style={frozenStyle} options={frozenOptions} onChange={(fixed) => setDraft((current) => current.map((entry) => entry.key === item.key ? { ...entry, fixed: fixed === 'left' || fixed === 'right' ? fixed : undefined } : entry))} />
    </div>), [draft, labels, saving, draggingKey, dropKey]);

  return <Modal className="column-settings-modal" title="列设置" open={open} width={600} okText="应用" cancelText="取消" confirmLoading={saving} closable={!saving} cancelButtonProps={{ disabled: saving }} onCancel={event => { if (!saving && !composingCancel(event)) onClose(); }} onOk={() => { void onSave(draft).catch(() => undefined); }}>
    <div className="column-setting-head"><span>显示</span><span>列名 / 拖动排序</span><span>冻结</span></div>
    <div className="column-setting-list" data-sort-group>{rows}</div>
    <div className="column-setting-foot"><Button disabled={saving} onClick={() => setDraft(buildSettings(columns.map(column => ({ ...column, visible: column.defaultVisible ?? column.visible })), [], visibleKeys))}>重置为默认</Button></div>
    <div className="sort-announcement" role="status" aria-live="polite" aria-atomic="true">{announcement}</div>
  </Modal>;
}
