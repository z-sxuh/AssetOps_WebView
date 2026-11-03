import { emptyVault, normalizeVault, normalizeVaultUpdate, type Settings, type VaultData } from './model';

type VaultStorage = {
  exists(): Promise<boolean>;
  create(password: string): Promise<VaultData>;
  unlock(password: string): Promise<{ data: VaultData; key: CryptoKey | null }>;
  save(data: VaultData, key: CryptoKey | null): Promise<void>;
};
type VaultRuntime = {
  lock(): Promise<void>;
  setSearchHotkey(value: string): Promise<void>;
  setCloseBehavior(value: Settings['closeBehavior']): Promise<void>;
  restoreBackup(id: string, password?: string): Promise<VaultData>;
  changePassword(current: string, next: string): Promise<void>;
  reinitialize(password: string): Promise<VaultData>;
  copyBackupsToDirectory(path: string): Promise<string>;
};
export type VaultSnapshot = { stage: 'checking' | 'setup' | 'unlock' | 'ready' | 'error'; data: VaultData; saving: boolean; ledgerSaving: boolean; checkError?: string; lockPending?: boolean; lockError?: string };
export type VaultTransaction = { save(next: VaultData, syncRuntimeSettings?: boolean): Promise<void> };

// 会话拥有密钥、互斥与代次；页面只持有不可变的数据快照。
export class VaultSession {
  private snapshot: VaultSnapshot;
  private key: CryptoKey | null = null;
  private generation = 0;
  private replacementRevision = 0;
  private checkRequest = 0;
  private locking?: Promise<void>;
  private listeners = new Set<() => void>();

  constructor(initial: VaultData, private storage: VaultStorage, private runtime: VaultRuntime, private runtimeWarning: (message: string) => void = () => {}) {
    this.snapshot = { stage: 'checking', data: initial, saving: false, ledgerSaving: false };
  }
  getSnapshot = () => this.snapshot;
  getGeneration = () => this.generation + this.replacementRevision;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private publish(value: Partial<VaultSnapshot>) {
    this.snapshot = { ...this.snapshot, ...value };
    for (const listener of this.listeners) listener();
  }
  private assertGeneration(generation: number) {
    if (generation !== this.generation) throw new Error('数据仓库已锁定，请先解锁');
  }
  private assertIdle() {
    if (this.snapshot.saving || this.locking) throw new Error('正在保存，请稍后再操作');
  }
  async check() {
    if (this.snapshot.stage !== 'checking' && this.snapshot.stage !== 'error') return;
    const request = ++this.checkRequest;
    if (this.snapshot.stage === 'error') this.publish({ stage: 'checking', checkError: undefined });
    try {
      await this.runtime.lock();
      const exists = await this.storage.exists();
      if (request === this.checkRequest && this.snapshot.stage === 'checking') this.publish({ stage: exists ? 'unlock' : 'setup', checkError: undefined });
    } catch (error) {
      if (request === this.checkRequest && this.snapshot.stage === 'checking') this.publish({ stage: 'error', checkError: error instanceof Error ? error.message : String(error) });
    }
  }
  private async activateSettings(settings: Settings, generation: number) {
    this.assertGeneration(generation);
    try { await this.runtime.setCloseBehavior(settings.closeBehavior); }
    catch (error) { this.runtimeWarning(`窗口关闭行为未同步：${String(error)}`); }
    this.assertGeneration(generation);
    try { await this.runtime.setSearchHotkey(settings.searchHotkey); }
    catch (error) { this.runtimeWarning(`桌面搜索快捷键注册失败：${String(error)}`); }
    this.assertGeneration(generation);
  }
  async unlock(password: string) {
    this.assertIdle();
    if (this.snapshot.lockError) throw new Error('原生锁定尚未确认，请先重试锁定');
    const generation = ++this.generation;
    this.publish({ saving: true });
    try {
      if (this.snapshot.stage === 'setup') {
        await this.storage.create(password);
        this.assertGeneration(generation);
        this.publish({ stage: 'unlock' });
      }
      this.assertGeneration(generation);
      const result = await this.storage.unlock(password);
      this.assertGeneration(generation);
      const data = normalizeVault(result.data);
      if (JSON.stringify(data) !== JSON.stringify(result.data)) await this.storage.save(data, result.key);
      this.assertGeneration(generation);
      this.key = result.key;
      await this.activateSettings(data.settings, generation);
      this.publish({ stage: 'ready', data });
      return data;
    } finally { this.publish({ saving: false }); }
  }
  lock() {
    if (this.locking) return this.locking;
    ++this.generation;
    this.key = null;
    this.locking = Promise.resolve().then(() => this.runtime.lock()).then(() => {
      this.publish({ lockPending: false, lockError: undefined });
    }, error => {
      this.publish({ lockPending: false, lockError: `原生锁定未确认：${error instanceof Error ? error.message : String(error)}。请重试锁定，确认前无法解锁。` });
      throw error;
    }).finally(() => { this.locking = undefined; });
    this.publish({ stage: 'unlock', lockPending: true, lockError: undefined, data: { ...emptyVault, settings: { ...emptyVault.settings, theme: this.snapshot.data.settings.theme } } });
    return this.locking;
  }
  async run<T>(expected: VaultData, operation: (transaction: VaultTransaction) => Promise<T>, ledgerChange = false): Promise<T> {
    if (this.snapshot.stage !== 'ready') throw new Error('数据仓库已锁定，请先解锁');
    this.assertIdle();
    if (expected !== this.snapshot.data) throw new Error('数据已更新，请重新执行此操作');
    const generation = this.generation;
    this.publish({ saving: true, ledgerSaving: ledgerChange });
    const save = async (value: VaultData, syncRuntimeSettings = false) => {
      this.assertGeneration(generation);
      const previous = this.snapshot.data;
      const next = value;
      try {
        if (syncRuntimeSettings) {
          await this.runtime.setSearchHotkey(next.settings.searchHotkey);
          this.assertGeneration(generation);
          await this.runtime.setCloseBehavior(next.settings.closeBehavior);
          this.assertGeneration(generation);
        }
        await this.storage.save(next, this.key);
        this.assertGeneration(generation);
        this.publish({ data: next });
      } catch (error) {
        if (syncRuntimeSettings && generation === this.generation) {
          try {
            await this.runtime.setSearchHotkey(previous.settings.searchHotkey);
            this.assertGeneration(generation);
            await this.runtime.setCloseBehavior(previous.settings.closeBehavior);
          } catch (reason) { this.runtimeWarning(`恢复快捷键设置失败：${String(reason)}`); }
        }
        throw error;
      }
    };
    try {
      const result = await operation({ save });
      this.assertGeneration(generation);
      return result;
    } finally { this.publish({ saving: false, ledgerSaving: false }); }
  }
  save(expected: VaultData, next: VaultData, syncRuntimeSettings = false) {
    return this.run(expected, transaction => {
      return transaction.save(normalizeVaultUpdate(expected, next), syncRuntimeSettings);
    }, next.assets !== expected.assets);
  }
  changeSidebar(expected: VaultData, sidebarCollapsed: boolean) {
    return this.run(expected, (transaction) => transaction.save(normalizeVaultUpdate(expected, { ...expected, settings: { ...expected.settings, sidebarCollapsed } })));
  }
  private replace(expected: VaultData, load: () => Promise<VaultData>) {
    return this.run(expected, async () => {
      const generation = this.generation;
      const next = normalizeVault(await load());
      this.assertGeneration(generation);
      ++this.replacementRevision;
      this.publish({ data: next });
      await this.activateSettings(next.settings, generation);
    });
  }
  restore(expected: VaultData, id: string, password?: string) { return this.replace(expected, () => this.runtime.restoreBackup(id, password)); }
  reinitialize(expected: VaultData, password: string) { return this.replace(expected, () => this.runtime.reinitialize(password)); }
  changePassword(expected: VaultData, current: string, next: string) { return this.run(expected, () => this.runtime.changePassword(current, next)); }
  changeBackupDirectory(expected: VaultData, directory: string) {
    return this.run(expected, async (transaction) => {
      const path = await this.runtime.copyBackupsToDirectory(directory);
      await transaction.save(normalizeVault({ ...expected, settings: { ...expected.settings, backupDirectory: path } }));
      return path;
    });
  }
}
