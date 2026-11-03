import { useCallback, useEffect, useRef, useState } from 'react';
import { StorageSizeService, type StorageModule, type StorageSize } from './storageSizeService';

const service = new StorageSizeService(() => new Worker(new URL('./storageSize.worker.ts', import.meta.url), { type: 'module' }));
export function useStorageSize(key: StorageModule, payload: object, enabled = true): StorageSize & { retry: () => void } {
  const [state, setState] = useState<StorageSize>({ pending: true });
  const requested = useRef<object>();
  useEffect(() => {
    if (!enabled) { requested.current = undefined; setState({ pending: false }); return; }
    const release = service.subscribe(key, () => setState(service.read(key)));
    setState(service.read(key));
    return release;
  }, [key, enabled]);
  useEffect(() => {
    if (enabled) { requested.current = payload; service.request(key, payload); }
  }, [key, payload, enabled]);
  const retry = useCallback(() => { if (enabled) service.request(key, payload); }, [key, payload, enabled]);
  return { ...state, retry, pending: enabled && (state.pending || requested.current !== payload) };
}
export { storageSizeText } from './storageSizeService';
