import { Input, Modal, Typography } from 'antd';
import { useEffect, useMemo, useState } from 'react';
import type { ObjectType, VaultData } from '../../model';
import { composingCancel } from '../../composition';

const { Text } = Typography;

type StructureRow = {
  id: string;
  type: Exclude<ObjectType, 'asset'>;
  name: string;
};

export type StructureTarget = { type: StructureRow['type']; id: string; action: 'rename' | 'delete' };

type Props = {
  target: StructureTarget | null;
  data: VaultData;
  onClose: () => void;
  onRename: (type: StructureRow['type'], id: string, name: string) => Promise<void>;
  onDelete: (type: StructureRow['type'], id: string) => Promise<void>;
};

const labels = { unit: '单位', environment: '环境', zone: '区域', system: '系统' } as const;

export default function StructureManager({ target, data, onClose, onRename, onDelete }: Props) {
  const [modalApi, modalContext] = Modal.useModal();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const editing = useMemo(() => {
    if (!target) return;
    for (const unit of data.units) {
      if (target.type === 'unit' && unit.id === target.id) return { id: unit.id, type: target.type, name: unit.name };
      for (const environment of unit.environments) {
        if (target.type === 'environment' && environment.id === target.id) return { id: environment.id, type: target.type, name: environment.name };
        for (const zone of environment.zones) {
          if (target.type === 'zone' && zone.name && zone.id === target.id) return { id: zone.id, type: target.type, name: zone.name };
          if (target.type === 'system') { const system = zone.systems.find(system => system.id === target.id); if (system) return { id: system.id, type: target.type, name: system.name }; }
        }
      }
    }
  }, [target?.type, target?.id, data.units]);
  const assetCount = useMemo(() => {
    if (!editing || target?.action !== 'delete') return 0;
    const key = { unit: 'unitId', environment: 'environmentId', zone: 'zoneId', system: 'systemId' } as const;
    let count = 0; for (const asset of data.assets) if (asset[key[editing.type]] === editing.id) count++;
    return count;
  }, [editing?.type, editing?.id, target?.action, data.assets]);
  const deleting = target?.action === 'delete';
  useEffect(() => { setName(editing?.name ?? ''); }, [target, editing?.name]);

  return <>
    {modalContext}
    <Modal
      title={`${deleting ? '删除' : '重命名'}${editing ? labels[editing.type] : ''}${deleting && editing ? `“${editing.name}”？` : ''}`}
      open={Boolean(editing)}
      okText={deleting ? '删除' : '保存'}
      cancelText="取消"
      confirmLoading={busy}
      okButtonProps={{ danger: deleting, disabled: !deleting && (!name.trim() || name.trim() === editing?.name) }}
      closable={!busy}
      maskClosable={!busy}
      keyboard={!busy}
      onCancel={(event) => { if (!busy && !composingCancel(event)) onClose(); }}
      onOk={async () => {
        if (!editing || busy || (!deleting && !name.trim())) return;
        setBusy(true);
        try { if (deleting) await onDelete(editing.type, editing.id); else await onRename(editing.type, editing.id, name.trim()); onClose(); }
        catch (reason) { modalApi.error({ title: deleting ? '删除失败' : '重命名失败', content: reason instanceof Error ? reason.message : String(reason) }); }
        finally { setBusy(false); }
      }}
    >
      {deleting ? <Text>{assetCount ? `关联的 ${assetCount} 台资产也将删除，请确认已有所需备份。` : '结构及字段定义将删除，请确认已有所需备份。'}启用写前备份时，会先创建数据库备份。</Text> : <Input autoFocus value={name} maxLength={64} disabled={busy} onChange={(event) => setName(event.target.value)} />}
    </Modal>
  </>;
}
