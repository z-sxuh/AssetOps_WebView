import { useMemo } from 'react';
import type { VaultData } from '../model';
import { moduleStorage } from '../moduleStorage';
import type { StorageModule } from '../storageSizeService';
import { useStorageSize } from '../useStorageSize';
import StorageSizeLabel from './StorageSizeLabel';

const emptyPayload: object = [];

export default function ModuleStorageFooter({ page, data }: { page: string; data: VaultData }) {
  const key = page as StorageModule;
  const scope = useMemo(() => moduleStorage(key, data), [key, data]);
  const fields = useMemo(() => ({ fieldDefs: data.fieldDefs, fieldTemplates: data.fieldTemplates }), [data.fieldDefs, data.fieldTemplates]);
  const payload = key === 'fields' && scope.payload ? fields : scope.payload;
  const visible = ['ledger', 'operations', 'reports', 'fields', 'history'].includes(page);
  const state = useStorageSize(key, payload ?? emptyPayload, visible && Boolean(payload));
  if (!visible) return null;
  return <StorageSizeLabel label={scope.label} title={scope.title}
    className={key === 'reports' ? 'reports-storage' : key === 'history' ? 'history-storage' : 'module-storage'}
    state={scope.payload ? state : { bytes: 0, pending: false, retry: state.retry }} />;
}
