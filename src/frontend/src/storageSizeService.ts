export type StorageModule = 'home' | 'ledger' | 'reports' | 'operations' | 'fields' | 'import' | 'history' | 'backup' | 'settings';
export type StorageSize = { bytes?: number; pending: boolean; error?: string };
export const storageSizeText = (bytes?: number) => bytes === undefined ? '统计中' : bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : bytes >= 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${bytes} B`;
export function storageSizeMessage({ bytes, pending, error }: StorageSize) {
  if (error) return bytes === undefined ? '统计失败' : `上次约 ${storageSizeText(bytes)}（更新失败）`;
  if (pending) return bytes === undefined ? '统计中…' : `上次约 ${storageSizeText(bytes)}（更新中）`;
  return bytes === undefined ? '尚未统计' : `占用约 ${storageSizeText(bytes)}`;
}
export type SizeRequest =
  | { type: 'begin'; key: StorageModule; id: number; base?: number; array: boolean; keys: string[] }
  | { type: 'set'; key: StorageModule; id: number; field: string; value: unknown }
  | { type: 'append'; key: StorageModule; id: number; field?: string; path?: Array<string | number>; values: unknown[] }
  | { type: 'fragment' | 'text'; key: StorageModule; id: number; path: Array<string | number>; value: unknown }
  | { type: 'finish' | 'release'; key: StorageModule; id: number }
  | { type: 'clear'; key: StorageModule };
export type SizeResponse = { key: StorageModule; id: number; bytes?: number; error?: string };
type Entry = {
  id: number; payload?: object; confirmed?: { id: number; payload: object };
  state: StorageSize; listeners: Set<() => void>;
};

// 同一模块共享结果；只在 effect 请求，数组分批复制，避免一次克隆整库。
export class StorageSizeService {
  private worker?: Worker;
  private entries = new Map<StorageModule, Entry>();
  private sequence = 0;
  constructor(private createWorker: () => Worker, private yieldTask = () => new Promise<void>(resolve => setTimeout(resolve, 0)), private now = () => performance.now()) {}
  private entry(key: StorageModule) {
    let entry = this.entries.get(key);
    if (!entry) { entry = { id: 0, state: { pending: true }, listeners: new Set() }; this.entries.set(key, entry); }
    return entry;
  }
  read(key: StorageModule): StorageSize { return this.entries.get(key)?.state ?? { pending: true }; }
  private publish(entry: Entry, state: StorageSize) { entry.state = state; entry.listeners.forEach(listener => listener()); }
  subscribe(key: StorageModule, listener: () => void) {
    const entry = this.entry(key); entry.listeners.add(listener);
    return () => {
      entry.listeners.delete(listener);
      if (entry.listeners.size) return;
      this.entries.delete(key); this.worker?.postMessage({ type: 'clear', key } satisfies SizeRequest);
      if (!this.entries.size) { this.worker?.terminate(); this.worker = undefined; }
    };
  }
  private ensureWorker() {
    if (this.worker) return this.worker;
    const worker = this.createWorker(); this.worker = worker;
    worker.onmessage = ({ data }: MessageEvent<SizeResponse>) => {
      if (this.worker !== worker) return;
      const entry = this.entries.get(data.key);
      if (!entry || entry.id !== data.id) { worker.postMessage({ type: 'release', key: data.key, id: data.id } satisfies SizeRequest); return; }
      if (data.error || data.bytes === undefined) { this.publish(entry, { bytes: entry.state.bytes, pending: false, error: data.error ?? '容量统计失败' }); return; }
      const previous = entry.confirmed;
      entry.confirmed = { id: data.id, payload: entry.payload! };
      this.publish(entry, { bytes: data.bytes, pending: false });
      if (previous) worker.postMessage({ type: 'release', key: data.key, id: previous.id } satisfies SizeRequest);
    };
    worker.onerror = event => {
      if (this.worker !== worker) return;
      worker.terminate(); this.worker = undefined;
      for (const entry of this.entries.values()) { entry.confirmed = undefined; this.publish(entry, { bytes: entry.state.bytes, pending: false, error: event.message || '容量统计失败' }); }
    };
    return worker;
  }
  request(key: StorageModule, payload: object) {
    const entry = this.entry(key);
    if (entry.payload === payload && !entry.state.error) return;
    entry.payload = payload; const id = ++this.sequence; entry.id = id;
    this.publish(entry, { bytes: entry.state.bytes, pending: true });
    void this.send(key, entry, id, payload).catch(error => {
      if (this.entries.get(key) === entry && entry.id === id) this.publish(entry, { bytes: entry.state.bytes, pending: false, error: String(error) });
    });
  }
  private async send(key: StorageModule, entry: Entry, id: number, payload: object) {
    const worker = this.ensureWorker();
    const current = () => this.worker === worker && this.entries.get(key) === entry && entry.id === id;
    const array = Array.isArray(payload);
    worker.postMessage({ type: 'begin', key, id, base: entry.confirmed?.id, array, keys: array ? [] : Object.keys(payload) } satisfies SizeRequest);
    let sliceStarted = this.now();
    const append = async (values: unknown[], field?: string) => {
      let count = 64;
      for (let offset = 0; offset < values.length;) {
        if (!current()) return;
        const batch = values.slice(offset, offset + count), start = this.now();
        worker.postMessage({ type: 'append', key, id, field, values: batch } satisfies SizeRequest);
        offset += batch.length;
        const elapsed = this.now() - start;
        count = Math.max(1, Math.min(128, Math.floor(count * 2 / Math.max(.1, elapsed))));
        if (this.now() - sliceStarted >= 4) { await this.yieldTask(); sliceStarted = this.now(); }
      }
    };
    if (array && key === 'operations') await this.sendOperations(worker, key, id, payload, current);
    else if (array) await append(payload);
    else for (const field of Object.keys(payload)) {
      if (!current()) return;
      const value = (payload as Record<string, unknown>)[field];
      if (entry.confirmed && value === (entry.confirmed.payload as Record<string, unknown>)[field]) continue;
      worker.postMessage({ type: 'set', key, id, field, value: Array.isArray(value) ? [] : value } satisfies SizeRequest);
      if (Array.isArray(value)) await append(value, field);
    }
    if (current()) worker.postMessage({ type: 'finish', key, id } satisfies SizeRequest);
  }
  // 运维按系统 → 版本 → 拓扑叶项传输；单条版本和大文本不能绕过批次预算。
  private async sendOperations(worker: Worker, key: StorageModule, id: number, systems: unknown[], current: () => boolean) {
    type Path = Array<string | number>;
    const limit = 8192;
    let started = this.now();
    const post = async (message: SizeRequest) => {
      if (!current()) return;
      worker.postMessage(message);
      if (this.now() - started >= 4) { await this.yieldTask(); started = this.now(); }
    };
    const leafCost = (value: unknown, depth = 0): number => {
      if (typeof value === 'string') return value.length;
      if (!value || typeof value !== 'object') return 16;
      const values = Array.isArray(value) ? value : Object.values(value);
      if (depth > 2 || values.length > 32) return limit + 1;
      let size = 32;
      for (const item of values) { size += leafCost(item, depth + 1); if (size > limit) break; }
      return size;
    };
    const record = async (value: unknown, path: Path): Promise<void> => {
      if (!current()) return;
      if (typeof value === 'string') {
        await post({ type: 'fragment', key, id, path, value: '' });
        for (let offset = 0; offset < value.length && current(); offset += limit) await post({ type: 'text', key, id, path, value: value.slice(offset, offset + limit) });
        return;
      }
      if (!value || typeof value !== 'object' || Array.isArray(value)) { await post({ type: 'fragment', key, id, path, value }); return; }
      const fields = Object.entries(value), shallow = Object.fromEntries(fields.map(([field, item]) => [field, Array.isArray(item) ? [] : typeof item === 'string' ? '' : field === 'topology' && item ? {} : item]));
      await post({ type: 'fragment', key, id, path, value: shallow });
      for (const [field, item] of fields) {
        if (!current()) return;
        const target = [...path, field];
        if (typeof item === 'string') {
          for (let offset = 0; offset < item.length && current(); offset += limit) await post({ type: 'text', key, id, path: target, value: item.slice(offset, offset + limit) });
        } else if (field === 'topology' && item) await record(item, target);
        else if (Array.isArray(item)) {
          if (field === 'revisions') { for (let index = 0; index < item.length && current(); index++) await record(item[index], [...target, index]); }
          else await leaves(item, target);
        }
      }
    };
    const leaves = async (values: unknown[], path: Path) => {
      for (let offset = 0; offset < values.length && current();) {
        if (leafCost(values[offset]) > limit) { await record(values[offset], [...path, offset]); offset++; continue; }
        let size = 0, end = offset;
        while (end < values.length && end - offset < 16) { const cost = leafCost(values[end]); if (size + cost > limit) break; size += cost; end++; }
        await post({ type: 'append', key, id, path, values: values.slice(offset, end) }); offset = end;
      }
    };
    for (let index = 0; index < systems.length && current(); index++) await record(systems[index], [index]);
  }
}
