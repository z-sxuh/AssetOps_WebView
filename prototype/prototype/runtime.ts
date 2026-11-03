import JSZip from 'jszip';
import { emptyVault, normalizeVault, type VaultData } from '../src/model';
import type { VaultSession } from '../src/vaultSession';
import { matchesHotkey } from '../src/hotkeys';
import { createDemoData, demoPassword } from './seed';
import { emit } from './event';
import { assetSheets, auditRows, parseSpreadsheet, workbook } from './spreadsheet';

type DemoBackup = { fileName: string; path: string; kind: string; size: number; createdAt: string; integrity: string; data: VaultData; password: string };
type DemoState = { format: 'assetops-html-prototype-125'; data: VaultData; password: string; autostart: boolean; backups: DemoBackup[] };
const params = new URLSearchParams(location.search);
const storageKey = `assetops-html-prototype-125${params.get('gate') === 'setup' ? '-setup' : ''}`;
if (params.get('reset') === '1' && confirm('恢复全部虚构样例并清除当前原型修改？此操作只影响 HTML 原型。')) {
  localStorage.removeItem(storageKey); localStorage.removeItem(`${storageKey}-created`);
}
let state: DemoState;
let unlocked = false;
let hotkey = 'F4';
const clone = <T>(value: T): T => structuredClone(value);
function backup(data: VaultData, password: string, kind: string, createdAt = new Date().toISOString()): DemoBackup {
  const fileName = `prototype-${kind}-${createdAt.replace(/[:.]/g, '-')}-${crypto.randomUUID().slice(0, 8)}.json`;
  return { fileName, path: `浏览器演示备份\\${fileName}`, kind, size: new TextEncoder().encode(JSON.stringify(data)).length, createdAt, integrity: 'unchecked', data: clone(data), password };
}
function initialState(): DemoState {
  const data = createDemoData();
  return { format: 'assetops-html-prototype-125', data, password: demoPassword, autostart: false, backups: [backup(data, demoPassword, 'manual', new Date(Date.now() - 86400000).toISOString()), backup(data, demoPassword, 'scheduled', new Date(Date.now() - 2 * 86400000).toISOString()), backup(data, demoPassword, 'pre-schema', new Date(Date.now() - 3 * 86400000).toISOString())] };
}
function read(): DemoState {
  if (state) return state;
  const stored = localStorage.getItem(storageKey);
  if (stored) {
    const parsed = JSON.parse(stored) as DemoState;
    if (parsed.format !== 'assetops-html-prototype-125') throw new Error('原型演示数据格式无效，请从使用说明重置样例');
    state = { ...parsed, data: normalizeVault(parsed.data) };
  } else write(initialState());
  return state;
}
function write(next: DemoState) {
  try { localStorage.setItem(storageKey, JSON.stringify(next)); }
  catch { throw new Error('浏览器无法保存演示数据，请允许本地存储或先导出数据后重置样例'); }
  state = next;
}
export function download(name: string, content: Blob | string, type = 'application/json') {
  const url = typeof content === 'string' && content.startsWith('data:') ? content : URL.createObjectURL(content instanceof Blob ? content : new Blob([content], { type }));
  const link = document.createElement('a'); link.href = url; link.download = name.replace(/[<>:"/\\|?*]/g, '_'); link.click();
  if (url.startsWith('blob:')) setTimeout(() => URL.revokeObjectURL(url), 30000);
  return link.download;
}
const publicBackup = ({ data: _data, password: _password, ...info }: DemoBackup) => info;
const requireUnlocked = () => { if (!unlocked) throw new Error('数据仓库已锁定，请先解锁'); };
const bytes64 = (value: Uint8Array) => btoa(Array.from(value, byte => String.fromCharCode(byte)).join(''));
const from64 = (value: string) => Uint8Array.from(atob(value), character => character.charCodeAt(0));
async function archiveKey(password: string, salt: Uint8Array) {
  const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', salt: new Uint8Array(salt).buffer, iterations: 100000, hash: 'SHA-256' }, material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

export async function command(commandName: string, args: any = {}, options?: { headers?: Record<string, string> }): Promise<unknown> {
  const current = read();
  if (commandName === 'vault_exists') return params.get('gate') !== 'setup' || Boolean(localStorage.getItem(`${storageKey}-created`));
  if (commandName === 'vault_lock') { unlocked = false; return; }
  if (commandName === 'vault_unlock') { if (args.password !== current.password) throw new Error('主密码不正确，请重试'); unlocked = true; return clone(current.data); }
  if (commandName === 'vault_create') { write({ ...current, password: args.password, data: normalizeVault(args.data) }); localStorage.setItem(`${storageKey}-created`, 'true'); return; }
  if (['set_exit_guard', 'set_window_appearance', 'set_close_behavior', 'show_main_window', 'show_search_window', 'resize_search_window', 'close_search_window'].includes(commandName)) return;
  if (commandName === 'confirm_exit') { await emit('assetops-operation-error', 'HTML 原型请关闭浏览器标签页退出，已保存的演示数据会保留'); return; }
  if (commandName === 'set_search_hotkey') { hotkey = args.hotkey; return; }
  if (commandName === 'search_hotkey_status') return { hotkey, registered: true, error: null };
  requireUnlocked();
  switch (commandName) {
    case 'vault_save': write({ ...current, data: normalizeVault(args.data) }); return;
    case 'app_info': return { version: '1.2.5', dataDirectory: '浏览器本地存储（原型演示）', databasePath: '浏览器本地存储\\assets.db', backupDirectory: current.data.settings.backupDirectory, exportDirectory: current.data.settings.exportDirectory || '浏览器下载目录', databaseSize: new TextEncoder().encode(JSON.stringify(current.data)).length, journalMode: '浏览器演示', schemaVersion: 4, unlocked };
    case 'autostart_enabled': return current.autostart;
    case 'set_autostart': write({ ...current, autostart: Boolean(args.enabled) }); return state.autostart;
    case 'validate_export_directory': return;
    case 'open_data_directory': case 'open_backup_directory': case 'open_export_directory': case 'reveal_in_folder': throw new Error('HTML 原型使用浏览器本地存储；导出的文件请在浏览器下载列表中查看');
    case 'fetch_calendar': throw new Error('离线 HTML 原型不请求外部日历接口；可在工作日历中手动设置日期');
    case 'show_reminder': await emit('assetops-operation-error', `${args.title}：${args.body}`); return;
    case 'vault_change_password': {
      if (args.oldPassword !== current.password) throw new Error('当前主密码不正确');
      write({ ...current, password: args.newPassword, backups: current.backups.map(item => ({ ...item, password: args.newPassword })) }); return;
    }
    case 'vault_reinitialize': {
      const data = normalizeVault({ ...emptyVault, settings: current.data.settings });
      write({ ...current, data, password: args.password }); return clone(data);
    }
    case 'backup_list': return current.backups.map(publicBackup);
    case 'backup_create': {
      const item = backup(current.data, current.password, args.kind);
      write({ ...current, backups: [item, ...current.backups] }); return publicBackup(item);
    }
    case 'backup_restore': {
      const item = current.backups.find(item => item.fileName === args.fileName); if (!item) throw new Error('演示备份不存在');
      if ((args.password || current.password) !== item.password) throw new Error('备份主密码不正确');
      const data = normalizeVault({ ...clone(item.data), settings: current.data.settings });
      write({ ...current, data, backups: [backup(current.data, current.password, 'pre-restore'), ...current.backups] }); return clone(data);
    }
    case 'backup_delete': write({ ...current, backups: current.backups.filter(item => item.fileName !== args.fileName) }); return;
    case 'backup_simulate_cleanup': return ['startup', 'scheduled'].flatMap(kind => current.backups.filter(item => item.kind === kind).slice(Math.max(1, (kind === 'scheduled' ? args.scheduledPolicy : args.policy).keepLast))).map(publicBackup);
    case 'backup_copy_to_directory': return args.newDirectory;
    case 'export_document': {
      const types: Record<string, string> = { md: 'text/markdown;charset=utf-8', html: 'text/html;charset=utf-8', svg: 'image/svg+xml;charset=utf-8', json: 'application/json' };
      return download(`${args.name}.${args.extension}`, args.content, types[args.extension]);
    }
    case 'export_assets': {
      const result = assetSheets(current.data, args), fileName = args.templateOnly ? '资产导入模板-原型.xlsx' : '资产台账-原型.xlsx';
      download(fileName, await workbook(result.sheets)); return { path: fileName, fileName, rows: result.count };
    }
    case 'export_template': {
      const fileName = '字段模板-原型.xlsx'; download(fileName, await workbook([{ name: '资产模板', rows: [args.fields.map((field: { label: string }) => field.label)] }])); return { path: fileName };
    }
    case 'export_audit': {
      const fileName = '历史审计-原型.xlsx', rows = auditRows(current.data, args.includePasswords);
      download(fileName, await workbook([{ name: '历史审计', rows }])); return { path: fileName, fileName, rows: rows.length - 1 };
    }
    case 'export_import_report': {
      const fileName = '导入结果-原型.xlsx'; download(fileName, await workbook([{ name: '导入结果', rows: [['工作表', '行号', '状态', '主机名', '说明'], ...args.rows.map((row: any) => [row.sheet, row.line, row.status, row.host, row.message])] }])); return { path: fileName };
    }
    case 'parse_import_xlsx': return parseSpreadsheet(args, JSON.parse(options?.headers?.['x-column-mapping'] ?? '{}'), JSON.parse(options?.headers?.['x-sheet-column-mapping'] ?? '{}'));
    case 'export_history_archive': {
      const archive = { format: 'assetops-history', version: 1, exportedAt: new Date().toISOString(), period: args.period, start: args.start, end: args.end, records: current.data.history.filter(record => args.ids.includes(record.id)) };
      const salt = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12));
      const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await archiveKey(args.password, salt), new TextEncoder().encode(JSON.stringify(archive)));
      const zip = new JSZip(); zip.file('prototype.json', JSON.stringify({ format: 'assetops-html-demo-history', salt: bytes64(salt), iv: bytes64(iv) })); zip.file('archive.enc', encrypted);
      const path = download('历史归档-仅限HTML原型.zip', await zip.generateAsync({ type: 'blob' })); return { path, archive };
    }
    case 'read_history_archive': {
      const zip = await JSZip.loadAsync(args), metadata = JSON.parse(await zip.file('prototype.json')?.async('string') ?? '{}');
      if (metadata.format !== 'assetops-html-demo-history') throw new Error('此处仅支持 HTML 原型导出的演示归档，不兼容桌面加密归档');
      const password = new TextDecoder().decode(from64(options?.headers?.['x-archive-password'] ?? ''));
      try { return JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: from64(metadata.iv) }, await archiveKey(password, from64(metadata.salt)), await zip.file('archive.enc')!.async('arraybuffer')))); }
      catch { throw new Error('归档密码不正确或演示归档已损坏'); }
    }
    case 'compact_history_database': return;
    default: throw new Error(`HTML 原型尚未接入桌面命令：${commandName}`);
  }
}

export async function autoEnter(session: VaultSession, enter: (password: string) => Promise<void>) {
  if (!params.has('gate') && session.getSnapshot().stage === 'unlock') await enter(read().password);
}
window.addEventListener('keydown', event => {
  if (event.target instanceof Element && event.target.closest('[data-hotkey-recorder]')) return;
  if (matchesHotkey(event, hotkey)) { event.preventDefault(); void emit('assetops-open-search', { fromBackground: true, detached: false }); }
});
Object.defineProperty(window, 'assetopsPrototype', { value: Object.freeze({
  version: '1.2.5', getData: () => clone(read().data),
  reset() { if (confirm('恢复全部虚构样例并清除当前原型修改？此操作只影响 HTML 原型。')) { localStorage.removeItem(storageKey); localStorage.removeItem(`${storageKey}-created`); location.reload(); } },
  exportData() { return download('工作台-HTML原型演示数据.json', JSON.stringify(read().data, null, 2)); },
}), configurable: false });
