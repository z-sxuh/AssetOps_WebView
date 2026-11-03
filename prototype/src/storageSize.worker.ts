import type { SizeRequest, SizeResponse } from './storageSizeService';

type Payload = unknown[] | Record<string, unknown>;
const versions = new Map<string, Map<number, Payload>>();
const pending = new Map<string, { id: number; payload: Payload }>();
function atPath(payload: Payload, path: Array<string | number>): any {
  let value: any = payload;
  for (const part of path) { if (!value || !Object.hasOwn(value, part)) throw new Error('容量分片路径无效'); value = value[part]; }
  return value;
}
const worker = self as unknown as { onmessage: ((event: MessageEvent<SizeRequest>) => void) | null; postMessage: (message: SizeResponse) => void };
worker.onmessage = ({ data }) => {
  if (data.type === 'clear') { versions.delete(data.key); pending.delete(data.key); return; }
  if (data.type === 'release') { versions.get(data.key)?.delete(data.id); return; }
  try {
    if (data.type === 'begin') {
      const base = data.base === undefined ? undefined : versions.get(data.key)?.get(data.base) as Record<string, unknown> | undefined;
      const payload = data.array ? [] : Object.fromEntries(data.keys.map(key => [key, base?.[key]]));
      pending.set(data.key, { id: data.id, payload }); return;
    }
    const job = pending.get(data.key);
    if (!job || job.id !== data.id) return;
    if (data.type === 'set') (job.payload as Record<string, unknown>)[data.field] = data.value;
    if (data.type === 'fragment' || data.type === 'text') {
      const parent = atPath(job.payload, data.path.slice(0, -1)), field = data.path[data.path.length - 1];
      const value = data.type === 'text' ? parent[field] + data.value : data.value;
      Object.defineProperty(parent, field, { value, writable: true, enumerable: true, configurable: true });
    }
    if (data.type === 'append') {
      const values = data.path ? atPath(job.payload, data.path) : data.field === undefined ? job.payload : (job.payload as Record<string, unknown>)[data.field];
      (values as unknown[]).push(...data.values);
    }
    if (data.type === 'finish') {
      const bytes = new TextEncoder().encode(JSON.stringify(job.payload)).byteLength;
      const retained = versions.get(data.key) ?? new Map<number, Payload>();
      retained.set(data.id, job.payload); versions.set(data.key, retained); pending.delete(data.key);
      worker.postMessage({ key: data.key, id: data.id, bytes });
    }
  } catch (error) {
    pending.delete(data.key);
    worker.postMessage({ key: data.key, id: data.id, error: error instanceof Error ? error.message : String(error) });
  }
};
