import { HolderOutlined } from '@ant-design/icons';
import { Modal, Typography } from 'antd';
import { useEffect, useState } from 'react';
import type { FieldDef } from '../model';
import { useDragSort } from './useDragSort';

type Props = {
  active?: boolean;
  open: boolean;
  fields: FieldDef[];
  saving: boolean;
  onClose: () => void;
  onSave: (fields: FieldDef[]) => Promise<void>;
};

export default function FieldOrderModal({ active = true, open, fields, saving, onClose, onSave }: Props) {
  const [draft, setDraft] = useState<FieldDef[]>([]);
  const drop = (sourceId: string, targetId: string) => {
    if (saving) return;
    setDraft((current) => {
      const source = current.findIndex((field) => field.id === sourceId);
      const target = current.findIndex((field) => field.id === targetId);
      if (source < 0 || target < 0 || source === target) return current;
      const next = [...current];
      next.splice(target, 0, ...next.splice(source, 1));
      return next;
    });
  };
  const { start, keyDown, announcement, clearAnnouncement, draggingKey, dropKey } = useDragSort(drop, active && open && !saving);
  useEffect(() => { if (open) setDraft([...fields]); clearAnnouncement(); }, [open]);

  return <Modal title="字段排序" open={active && open} focusTriggerAfterClose={active} width={600} okText="应用" cancelText="取消"
    confirmLoading={saving} cancelButtonProps={{ disabled: saving }} closable={!saving}
    maskClosable={!saving} keyboard={!saving} onCancel={onClose} onOk={() => void onSave(draft)}>
    <Typography.Paragraph type="secondary">拖动或聚焦排序手柄后使用上下方向键调整字段顺序，导出的模板列会采用此顺序。</Typography.Paragraph>
    <div className="column-setting-head field-order-head"><span>显示名 / 拖动排序</span><span>键名</span></div>
    <div className="column-setting-list" data-sort-group>{draft.map((field) => <div
      className={`column-setting-row field-order-row${draggingKey === field.id ? ' is-dragging' : ''}${draggingKey && dropKey === field.id ? ' is-drop-target' : ''}`}
      key={field.id} data-sort-key={field.id}>
      <b><button type="button" className="column-drag-handle" data-sort-handle disabled={saving} title="拖拽或使用上下方向键调整顺序" aria-label={`调整${field.label}字段顺序，使用上下方向键`} aria-keyshortcuts="ArrowUp ArrowDown"
        onKeyDown={(event) => keyDown(event, field.id, field.label)} onPointerDown={(event) => { if (!saving) start(event, field.id); }}><HolderOutlined /></button>{field.label}</b>
      <Typography.Text code>{field.key}</Typography.Text>
    </div>)}</div>
    <div className="sort-announcement" role="status" aria-live="polite" aria-atomic="true">{announcement}</div>
  </Modal>;
}
