import { invoke, isTauri } from '@tauri-apps/api/core';
import type { FieldTemplateField, VaultData } from './model';
import type { AppInfo } from './features/settings/SettingsPage';
import type { ArchiveExport, ArchiveRange, HistoryArchive } from './features/history/historyArchive';

export type BackupInfo = {
  fileName: string;
  path?: string;
  kind: string;
  size: number;
  createdAt: string;
  integrity: string;
  sha256?: string;
};

export type RetentionPolicy = { keepLast: number; keepDaily: number; keepWeekly: number; keepMonthly: number; keepYearly: number };
export type SearchHotkeyStatus = { hotkey: string; registered: boolean; error: string | null };
export type ExportOptions = {
  scope: 'all' | 'unit' | 'system' | 'selected';
  unitId?: string;
  systemId?: string;
  assetIds?: string[];
  templateOnly?: boolean;
  includePasswords: boolean;
  includeFieldDescriptions: boolean;
  includeHistory: boolean;
  visibleColumns?: string[];
};

export type ParsedImportRow = Record<string, unknown> & { rowNumber: number; errors?: string[] };
export type ParsedImport = {
  rows: ParsedImportRow[];
  errors: Array<{ sheet: string; rowNumber: number; column: string; message: string }>;
  metadata?: { schema_version?: string; exported_at?: string; systemChoices?: Array<{ label: string; systemId: string; unit: string; system: string }>; systems?: Array<{ systemId: string; unit: string; system: string; fieldFingerprint: string; sheetName?: string }> };
  unmappedHeaders?: string[];
  headers: string[];
  sheetHeaders?: Record<string, string[]>;
};

export const native = {
  async setExitGuard(enabled: boolean) { if (this.desktop) await invoke('set_exit_guard', { enabled }); },
  async confirmExit() { if (this.desktop) await invoke('confirm_exit'); },
  desktop: isTauri(),
  async autostartEnabled(): Promise<boolean> { return isTauri() ? invoke<boolean>('autostart_enabled') : false; },
  async setAutostart(enabled: boolean): Promise<boolean> {
    if (!isTauri()) throw new Error('开机自启动仅支持 Windows 桌面应用');
    return invoke<boolean>('set_autostart', { enabled });
  },
  async fetchCalendar(url: string): Promise<string> {
    const parsed = new URL(url.trim());
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error('请输入不含账号密码的 HTTP/HTTPS 日历 URL');
    if (isTauri()) return invoke<string>('fetch_calendar', { url: parsed.href });
    const response = await fetch(parsed.href, { signal: AbortSignal.timeout(20000), credentials: 'omit' });
    if (!response.ok) throw new Error('日历 URL 返回错误状态');
    const content = await response.text(); if (new TextEncoder().encode(content).length > 2 * 1024 * 1024) throw new Error('日历文件不能超过 2 MB');
    return content;
  },
  async validateExportDirectory(directory: string) {
    if (isTauri()) await invoke('validate_export_directory', { directory });
    else if (directory && !/^([a-z]:[\\/]|\\\\)/i.test(directory)) throw new Error('导出目录需要完整绝对路径');
  },
  async openExportDirectory() { if (isTauri()) await invoke('open_export_directory'); },
  async showReminder(title: string, body: string) {
    if (isTauri()) await invoke('show_reminder', { title, body });
  },
  async exportDocument(name: string, extension: 'md' | 'png' | 'html' | 'svg' | 'json', content: string): Promise<string> {
    if (isTauri()) return invoke<string>('export_document', { name, extension, content });
    const url = extension === 'png' ? content : URL.createObjectURL(new Blob([content], { type: { md: 'text/markdown', html: 'text/html', svg: 'image/svg+xml', json: 'application/json' }[extension] }));
    const link = document.createElement('a'); link.href = url; link.download = `${name.replace(/[<>:"/\\|?*]/g, '_')}.${extension}`; link.click();
    if (extension !== 'png') URL.revokeObjectURL(url); return link.download;
  },
  async setWindowAppearance(theme: 'light' | 'dark' | 'spring') {
    if (isTauri()) await invoke('set_window_appearance', { dark: theme === 'dark', iconTheme: theme });
  },
  async lock() { if (isTauri()) await invoke('vault_lock'); },
  async setCloseBehavior(closeBehavior: 'tray' | 'exit') {
    if (isTauri()) await invoke('set_close_behavior', { closeBehavior });
  },
  async setSearchHotkey(hotkey: string) {
    if (isTauri()) await invoke('set_search_hotkey', { hotkey });
  },
  async showMainWindow() { if (isTauri()) await invoke('show_main_window'); },
  async showSearchWindow(height: number) { if (isTauri()) await invoke('show_search_window', { height }); },
  async resizeSearchWindow(height: number) { if (isTauri()) await invoke('resize_search_window', { height }); },
  async closeSearchWindow() { if (isTauri()) await invoke('close_search_window'); },
  async searchHotkeyStatus(): Promise<SearchHotkeyStatus | undefined> {
    if (!isTauri()) return undefined;
    return invoke<SearchHotkeyStatus>('search_hotkey_status');
  },
  async changePassword(currentPassword: string, newPassword: string) {
    if (!isTauri()) throw new Error('修改主密码仅支持桌面应用');
    await invoke('vault_change_password', { oldPassword: currentPassword, newPassword });
  },
  async reinitialize(password: string) {
    if (!isTauri()) throw new Error('重新初始化仅支持桌面应用');
    return invoke<VaultData>('vault_reinitialize', { password });
  },
  async info(): Promise<AppInfo | undefined> {
    if (!isTauri()) return undefined;
    return invoke<AppInfo>('app_info');
  },
  async revealInFolder(path: string) {
    if (!isTauri()) return;
    await invoke('reveal_in_folder', { path });
  },
  async openDataDirectory() {
    if (!isTauri()) throw new Error('打开数据目录仅支持桌面应用');
    await invoke('open_data_directory');
  },
  async openBackupDirectory() {
    if (!isTauri()) throw new Error('打开备份目录仅支持桌面应用');
    await invoke('open_backup_directory');
  },
  async listBackups(): Promise<BackupInfo[]> {
    if (!isTauri()) return [];
    return invoke<BackupInfo[]>('backup_list');
  },
  async createBackup(kind = 'manual'): Promise<BackupInfo> {
    if (!isTauri()) throw new Error('备份文件仅支持桌面应用');
    return invoke<BackupInfo>('backup_create', { kind });
  },
  async restoreBackup(fileName: string, password?: string): Promise<VaultData> {
    if (!isTauri()) throw new Error('备份恢复仅支持桌面应用');
    return invoke<VaultData>('backup_restore', { fileName, password: password ?? null });
  },
  async deleteBackup(fileName: string) {
    if (!isTauri()) throw new Error('备份删除仅支持桌面应用');
    await invoke('backup_delete', { fileName });
  },
  async simulateCleanup(policy: RetentionPolicy, scheduledPolicy: RetentionPolicy): Promise<BackupInfo[]> {
    if (!isTauri()) return [];
    return invoke<BackupInfo[]>('backup_simulate_cleanup', { policy, scheduledPolicy });
  },
  async copyBackupsToDirectory(newDirectory: string): Promise<string> {
    if (!isTauri()) throw new Error('更改备份目录仅支持桌面应用');
    return invoke<string>('backup_copy_to_directory', { newDirectory });
  },
  async exportAssets(data: VaultData, options: ExportOptions) {
    if (!isTauri()) throw new Error('Excel 导出仅支持桌面应用');
    let assetIds = options.assetIds;
    if (options.scope === 'unit' && options.unitId) assetIds = data.assets.filter((asset) => asset.unitId === options.unitId).map((asset) => asset.id);
    return invoke<{ path: string; fileName: string; rows: number }>('export_assets', {
      systemId: options.scope === 'system' ? options.systemId : null,
      assetIds: options.scope === 'selected' || options.scope === 'unit' ? assetIds : null,
      templateOnly: options.templateOnly ?? false,
      includePasswords: options.includePasswords,
      includeFieldDescriptions: options.includeFieldDescriptions,
      includeHistory: options.includeHistory,
      visibleColumns: options.visibleColumns ?? null,
    });
  },
  async exportTemplate(fields: FieldTemplateField[]): Promise<string> {
    if (!isTauri()) throw new Error('Excel 模板导出仅支持桌面应用');
    const result = await invoke<{ path: string }>('export_template', { fields });
    return result.path;
  },
  async exportAudit(includePasswords = false) {
    if (!isTauri()) throw new Error('审计表导出仅支持桌面应用');
    return invoke<{ path: string; fileName: string; rows: number }>('export_audit', { includePasswords });
  },
  async exportHistoryArchive(ids: string[], range: ArchiveRange, password: string): Promise<ArchiveExport> {
    if (!isTauri()) throw new Error('历史 ZIP 归档仅支持桌面应用');
    return invoke<ArchiveExport>('export_history_archive', { ids, ...range, password });
  },
  async readHistoryArchive(file: File, password = ''): Promise<HistoryArchive> {
    if (!isTauri()) throw new Error('历史 ZIP 导入仅支持桌面应用');
    if (file.size > 64 * 1024 * 1024) throw new Error('归档文件不能超过 64 MB');
    const bytes = new TextEncoder().encode(password);
    if (bytes.length > 4096) throw new Error('归档密码过长');
    return invoke<HistoryArchive>('read_history_archive', await file.arrayBuffer(), { headers: { 'x-archive-password': btoa(String.fromCharCode(...bytes)) } });
  },
  async compactHistoryDatabase() {
    if (!isTauri()) throw new Error('数据库整理仅支持桌面应用');
    await invoke('compact_history_database');
  },
  async parseImport(file: File, columnMapping: Record<string, string> = {}, sheetColumnMapping: Record<string, Record<string, string>> = {}): Promise<ParsedImport> {
    if (!isTauri()) throw new Error('Excel 导入预检仅支持桌面应用');
    if (file.size > 64 * 1024 * 1024) throw new Error('Excel 文件不能超过 64 MB');
    const encode = (value: unknown) => JSON.stringify(value).replace(/[\u007f-\uffff]/g, character => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`);
    return invoke<ParsedImport>('parse_import_xlsx', await file.arrayBuffer(), { headers: { 'x-column-mapping': encode(columnMapping), 'x-sheet-column-mapping': encode(sheetColumnMapping) } });
  },
  async exportImportReport(rows: Array<{ sheet: string; line: number; status: string; host: string; message: string }>): Promise<string> {
    if (!isTauri()) throw new Error('导入报告仅支持桌面应用');
    const result = await invoke<{ path: string }>('export_import_report', { rows });
    return result.path;
  },
};
