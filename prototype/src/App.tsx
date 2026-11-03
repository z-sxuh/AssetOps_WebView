import { autoEnter } from '../prototype/runtime';
import { startTransition, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import {
  Alert, Button, Card, ConfigProvider, Drawer, Empty, Form, Input, InputNumber, Layout, Modal,
  Badge, Pagination, Popconfirm, Popover, Space, Table, Tag, Timeline, Tooltip, Typography, message,
} from 'antd';
import zhCN from 'antd/locale/zh_CN';
import { createAppTheme } from './appTheme';
import { composingCancel } from './composition';
import ModuleStorageFooter from './components/ModuleStorageFooter';
import SearchToolbar from './components/SearchToolbar';
import { emitTo, listen } from '@tauri-apps/api/event';
import type { TableProps } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import {
  ApartmentOutlined, AppstoreOutlined,
  CloudServerOutlined, CopyOutlined, DashboardOutlined, DatabaseOutlined, DeleteOutlined,
  EditOutlined, EyeOutlined, EyeInvisibleOutlined, LeftOutlined, RightOutlined, FilterOutlined, HistoryOutlined, HddOutlined, ImportOutlined,
  LockOutlined, UnlockOutlined, PlusOutlined, SettingOutlined, FolderOpenOutlined,
  ReloadOutlined, FileTextOutlined, FullscreenOutlined,
} from '@ant-design/icons';
import type { Account, Asset, AssetStatus, ChangeItem, ChangeRecord, ObjectType, Settings, TableColumnSetting, VaultData } from './model';
import { defaultFields, emptyVault, id, normalizeVault } from './model';
import { accountExpiryDate, rotationEnabled, selectedAccount, updateAccountDates } from './passwordPolicy';
import { createAssetValidationContext, isValidIp, optionalNumber, validateAsset, validateFieldValue } from './assetValidation';
import { applyFieldColumnSettings, ledgerCopyText, ledgerFieldGroups, ledgerFieldValue } from './ledgerFields';
import { vault } from './vault';
import { VaultSession } from './vaultSession';
import { assetDiff } from './assetChanges';
import { assetFieldDefaults } from './assetDefaults';
import { GlobalSearch, type SearchItem } from './components/GlobalSearch';
import { SearchInsertCache } from './components/searchInsertCache';
import { quickEntry, type QuickEntryInput, type SearchInsertRequest } from './features/reports/quickEntry';
import AssetDetailsFields from './components/AssetDetailsFields';
import Select from './components/AppSelect';
import DateTimeInput from './components/DateTimeInput';
import OrganizationSelect from './components/OrganizationSelect';
import OrgTreePanel from './components/OrgTreePanel';
import WindowTitlebar from './components/WindowTitlebar';
import WorkbenchLayout from './components/WorkbenchLayout';
import ThemeSwitcher from './components/ThemeSwitcher';
import FieldsPage from './features/fields/FieldsPage';
import ImportExportPage from './components/LazyImportExportPage';
import type { ExportRequest } from './features/import-export/ImportExportPage';
import { importAssets, previewImport, type ImportOptions, type ImportPreview, type ImportSelection } from './features/import-export/importWorkflow';
import HistoryPage from './features/history/HistoryPage';
import BackupPage, { type BackupInfo as BackupPageInfo, type RetentionPolicy as BackupPagePolicy } from './features/backup/BackupPage';
import { SettingsPage, type AppInfo, type SettingsModel } from './features/settings/SettingsPage';
import { native, type BackupInfo as NativeBackupInfo } from './native';
import StructureManager, { type StructureTarget } from './features/structure/StructureManager';
import OrganizationTransfer from './features/structure/OrganizationTransfer';
import { mergeOrganization, type DirectoryUnit } from './features/structure/organizationDirectory';
import ColumnSettings from './components/ColumnSettings';
import { nextBackupAt } from './backupSchedule';
import { validateBackupCron } from './cron';
import { usePageSize } from './usePageSize';
import { diskCapacityText, parseDisks } from './disks';
import { matchesHotkey } from './hotkeys';
import type { SearchSnapshot } from './components/SearchWindow';
import DashboardPage, { maintenanceAccounts } from './features/home/DashboardPage';
import ReportsPage from './features/reports/ReportsPage';
import OperationsPage from './features/operations/OperationsPage';
import { operationScopes } from './features/operations/operationScope';
import { chinaTime, scopeValue } from './features/reports/reportModel';
import { completeReminders, notifyDueReminders, snoozeReminders } from './features/reports/reminders';

const { Content } = Layout;
const { Title, Text } = Typography;
const statusColors: Record<AssetStatus, string> = { 生产: 'green', 测试: 'blue', 关机: 'default', 待切换: 'orange' };
const statusList: AssetStatus[] = ['生产', '测试', '关机', '待切换'];
const brandIcons = {
  light: new URL('../src-tauri/icons/server_asset/server_asset_app_light_128.png', import.meta.url).href,
  dark: new URL('../src-tauri/icons/server_asset/server_asset_app_dark_128.png', import.meta.url).href,
  spring: new URL('../src-tauri/icons/server_asset/server_asset_app_spring_128.png', import.meta.url).href,
};
const nav = [
  { key: 'home', label: '系统导览', icon: <DashboardOutlined /> },
  { key: 'ledger', label: '资产台账', icon: <HddOutlined /> },
  { key: 'operations', label: '系统运维', icon: <ApartmentOutlined /> },
  { key: 'reports', label: '工作报告', icon: <FileTextOutlined /> },
  { key: 'fields', label: '字段定义', icon: <AppstoreOutlined /> },
  { key: 'import', label: '导入导出', icon: <ImportOutlined /> },
  { key: 'history', label: '历史变更', icon: <HistoryOutlined /> },
  { key: 'backup', label: '系统备份', icon: <DatabaseOutlined /> },
  { key: 'settings', label: '系统设置', icon: <SettingOutlined /> },
];

type StructureForm = { unitChoice: string; unitName?: string; envChoice: string; envName?: string; zoneChoice: string; zoneName?: string; systemName: string };

type AssetForm = {
  businessSystem: string; name: string; host: string; ip: string; ip2: string; status: AssetStatus; systemId: string;
  cpu: number | null; memory: number | null; os: string; disks: string; accounts: Account[];
  rotatePassword: boolean; passwordCycleDays: number; tags: string; custom?: Record<string, unknown>;
};

const today = () => {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
};
const stamp = () => new Date().toISOString();
const dateText = (value: string, includeTime = false) => {
  const date = value ? new Date(value) : undefined;
  if (!date || Number.isNaN(date.getTime())) return '—';
  return includeTime ? date.toLocaleString('zh-CN', { hour12: false }) : date.toLocaleDateString('zh-CN');
};
const formatBytes = (bytes = 0) => bytes < 1024 ? `${Math.max(0, bytes)} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
const backupKindText: Record<string, string> = { manual: '手动', 'pre-import': '导入前', startup: '启动自动', scheduled: '定时', 'pre-schema': '结构变更前', 'pre-restore': '恢复前' };

function remainingDays(date: Date) {
  return Math.ceil((date.getTime() - new Date(new Date().toDateString()).getTime()) / 86_400_000);
}


function sameAssetSnapshot(left: Asset | undefined, right: Asset | undefined, data: VaultData) {
  const comparable = (asset: Asset | undefined) => {
    if (!asset) return null;
    const normalized = normalizeVault({ ...data, assets: [asset] }).assets[0];
    return { ...normalized, accounts: normalized.accounts.map(({ id: _id, ...account }) => account) };
  };
  const canonical = (value: unknown) => JSON.stringify(value, (_, current) => current && typeof current === 'object' && !Array.isArray(current)
    ? Object.fromEntries(Object.keys(current).sort().map(key => [key, current[key]])) : current);
  return canonical(comparable(left)) === canonical(comparable(right));
}


const settingsToView = (settings: Settings): SettingsModel => ({
  autoLockMinutes: settings.autoLock ? settings.autoLockMinutes : 0,
  closeBehavior: settings.closeBehavior,
  passwordWarningDays: settings.passwordWarningDays,
  searchHotkey: settings.searchHotkey,
  showPlainPasswords: settings.showPlainPassword,
  exportPlainPasswords: settings.exportPlainPassword,
  theme: settings.theme,
  keepSearchQuery: settings.preserveSearch,
  startupBackup: settings.startupBackup,
  beforeWriteBackup: settings.backupBeforeWrite,
  backupDirectory: settings.backupDirectory,
  exportDirectory: settings.exportDirectory,
  holidayCalendarUrl: settings.holidayCalendarUrl,
  sidebarCollapsed: settings.sidebarCollapsed,
  ledgerOnlySystem: settings.ledgerOnlySystem,
});

const settingsFromView = (current: Settings, value: SettingsModel): Settings => ({
  ...current,
  autoLock: value.autoLockMinutes > 0,
  autoLockMinutes: (value.autoLockMinutes || 15) as Settings['autoLockMinutes'],
  closeBehavior: value.closeBehavior,
  passwordWarningDays: value.passwordWarningDays,
  searchHotkey: value.searchHotkey,
  showPlainPassword: value.showPlainPasswords,
  exportPlainPassword: value.exportPlainPasswords,
  theme: value.theme,
  preserveSearch: value.keepSearchQuery,
  startupBackup: value.startupBackup,
  backupBeforeWrite: value.beforeWriteBackup,
  backupDirectory: value.backupDirectory,
  exportDirectory: value.exportDirectory,
  holidayCalendarUrl: value.holidayCalendarUrl,
  sidebarCollapsed: value.sidebarCollapsed,
  ledgerOnlySystem: value.ledgerOnlySystem,
});

function Gate({ setup, brandIcon, onUnlock }: { setup: boolean; brandIcon: string; onUnlock: (password: string) => Promise<void> }) {
  const [form] = Form.useForm<{ password: string; confirm: string }>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const visibilityIcon = (visible: boolean) => <button type="button" aria-label={visible ? '隐藏密码' : '显示密码'} aria-pressed={visible} title={visible ? '隐藏密码' : '显示密码'}>{visible ? <EyeOutlined aria-hidden="true" /> : <EyeInvisibleOutlined aria-hidden="true" />}</button>;

  const submit = async (values: { password: string; confirm: string }) => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      if (setup && values.password !== values.confirm) throw new Error('两次输入的主密码不一致');
      await onUnlock(values.password);
    } catch (reason) {
      setError(reason instanceof Error && reason.name === 'OperationError' ? '主密码不正确，请重试' : reason instanceof Error ? reason.message : String(reason));
    } finally { setBusy(false); }
  };

  return <div className="gate-page">
    <div className="gate-brand"><span className="brand-mark brand-image"><img src={brandIcon} alt="" /></span><div><b>工作台</b></div></div>
    <Card className={`gate-card${setup ? '' : ' gate-unlock'}`} bordered={false}>
      {setup && <><div className="gate-icon"><LockOutlined /></div><Title level={3}>设置主密码</Title></>}
      {setup && <Text type="secondary">主密码用于加密本地资产数据，请妥善保管。</Text>}
      {error && <Alert className="gate-error" type="error" showIcon message={error} />}
      <Form form={form} layout="vertical" onFinish={submit} requiredMark={false}>
        <Form.Item name="password" label={setup ? '主密码' : undefined} rules={[{ required: true, message: '请输入主密码' }]}>
          <Input.Password className="gate-password" size="large" variant="outlined" autoFocus aria-label="主密码" placeholder="请输入主密码" iconRender={visibilityIcon} suffix={!setup && <Button className="gate-submit" type="text" htmlType="submit" icon={<UnlockOutlined />} aria-label="解锁系统" title="解锁系统" loading={busy} />} />
        </Form.Item>
        {setup && <Form.Item name="confirm" label="再次输入" rules={[{ required: true, message: '请再次输入主密码' }]}>
          <Input.Password className="gate-password" size="large" placeholder="确认主密码" iconRender={visibilityIcon} />
        </Form.Item>}
        {setup && <Button type="primary" htmlType="submit" size="large" block loading={busy}>创建加密数据仓库</Button>}
        {setup && <Text type="warning" className="gate-strength-note">应用不强制密码强度，建议使用复杂密码并妥善保管。</Text>}
      </Form>
    </Card>
  </div>;
}

const disabledWave = { disabled: true };

function hasOpenOverlay() {
  return [...document.querySelectorAll<HTMLElement>('.ant-modal-wrap, .ant-drawer-open')]
    .some((element) => element.getClientRects().length > 0 && getComputedStyle(element).display !== 'none');
}
function DiskTagRows({ disks }: { disks: Asset['disks'] }) {
  if (!disks.length) return <Text type="secondary">—</Text>;
  return <div className="disk-tags">
    {Array.from({ length: Math.ceil(disks.length / 2) }, (_, rowIndex) => <div className="disk-tag-row" key={rowIndex}>
      {disks.slice(rowIndex * 2, rowIndex * 2 + 2).map((disk, index) => <Tag key={`${disk.label}-${rowIndex * 2 + index}`}>{disk.label} · {diskCapacityText(disk)}</Tag>)}
    </div>)}
  </div>;
}

export default function App() {
  const [messageApi, contextHolder] = message.useMessage({ maxCount: 3 });
  const [modalApi, modalContext] = Modal.useModal();
  const windowError = useCallback((reason: unknown) => { void messageApi.error(reason instanceof Error ? reason.message : String(reason)); }, [messageApi]);
  const [session] = useState(() => {
    const storedTheme = localStorage.getItem('assetops-theme');
    const initial = { ...emptyVault, settings: { ...emptyVault.settings, theme: storedTheme === 'light' || storedTheme === 'dark' || storedTheme === 'spring' || storedTheme === 'system' ? storedTheme : emptyVault.settings.theme } };
    return new VaultSession(initial, vault, { ...native, setSearchHotkey: async (hotkey) => {
      try { await native.setSearchHotkey(hotkey); globalSearchRegisteredRef.current = native.desktop && Boolean(hotkey); }
      catch (error) { globalSearchRegisteredRef.current = false; throw error; }
    } }, (warning) => { void messageApi.warning(warning); });
  });
  const { stage, data, saving, ledgerSaving, checkError, lockPending, lockError } = useSyncExternalStore(session.subscribe, session.getSnapshot);
  useEffect(() => {
    if (!native.desktop) return;
    let disposed = false, confirmation: ReturnType<typeof modalApi.confirm> | undefined;
    let release: (() => void) | undefined;
    const exit = async () => {
      if (session.getSnapshot().saving || document.querySelector('.ant-btn-loading, [data-exit-saving="true"]')) {
        messageApi.warning('正在保存或处理数据，请完成后再退出'); return;
      }
      await native.confirmExit();
    };
    void listen('assetops-exit-request', () => {
      if (confirmation) return;
      if (session.getSnapshot().saving || document.querySelector('.ant-btn-loading, [data-exit-saving="true"]')) {
        messageApi.warning('正在保存或处理数据，请完成后再退出'); return;
      }
      const draft = [...document.querySelectorAll<HTMLElement>('.ant-modal-wrap, .ant-drawer-open, [data-exit-dirty="true"]')]
        .some((element) => element.matches('[data-exit-dirty="true"]') || element.getClientRects().length > 0 && Boolean(element.querySelector('form, textarea, [contenteditable="true"]')));
      if (!draft) { void exit().catch((reason) => messageApi.error(String(reason))); return; }
      confirmation = modalApi.confirm({ title: '退出前有尚未保存的编辑', content: '返回界面保存后再退出，或放弃当前草稿并退出。已保存的数据会保留。', okText: '放弃草稿并退出', cancelText: '返回保存', okButtonProps: { danger: true }, onOk: exit, afterClose: () => { confirmation = undefined; } });
    }).then(async (stop) => {
      if (disposed) { stop(); return; }
      release = stop; await native.setExitGuard(true);
    }).catch((reason) => messageApi.warning('退出保护未能启用：' + String(reason)));
    return () => { disposed = true; release?.(); confirmation?.destroy(); void native.setExitGuard(false).catch(() => undefined); };
  }, [session, modalApi, messageApi]);
  const dataRef = useMemo(() => ({ get current() { return session.getSnapshot().data; } }), [session]);
  const [page, setActivePage] = useState('home');
  const [openPages, setOpenPages] = useState(['home']);
  const [reminderNotice, setReminderNotice] = useState<string[]>([]);
  useEffect(() => {
    const tasks = data.reports.calendar.tasks ?? [];
    setReminderNotice((current) => { const remaining = current.filter((taskId) => tasks.some((task) => task.id === taskId && !task.completedAt)); return remaining.length === current.length ? current : remaining; });
  }, [data.reports.calendar.tasks]);
  const setPage = useCallback((next: string) => { setOpenPages((pages) => pages.includes(next) ? pages : [...pages, next]); setActivePage(next); }, []);
  const [reportFocusId, setReportFocusId] = useState<string>();
  const [opsFocusId, setOpsFocusId] = useState<string>();
  const [historyAsset, setHistoryAsset] = useState<{ id: string; name: string } | null>(null);
  const [maintenanceOnly, setMaintenanceOnly] = useState(false);
  const [query, setQuery] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchFocusRequest, setSearchFocusRequest] = useState(0);
  const [searchInstant, setSearchInstant] = useState(true);
  const stageRef = useMemo(() => ({ get current() { return session.getSnapshot().stage; } }), [session]);
  const searchHotkeyRef = useRef(data.settings.searchHotkey);
  if (stage === 'ready') searchHotkeyRef.current = data.settings.searchHotkey;
  const detachedSearchRef = useRef(false);
  const searchRequestRef = useRef(0);
  const searchSnapshotRef = useRef<SearchSnapshot>();
  const searchActionsRef = useRef<{ openItem: (target: { id: string; type: string }) => void; openHome: () => void; insert: (input: SearchInsertRequest) => Promise<void> }>({ openItem: () => {}, openHome: () => {}, insert: async () => {} });
  const quickInsertBusy = useRef(false);
  const globalSearchRegisteredRef = useRef(false);
  const publishSearch = useCallback(() => {
    if (native.desktop && detachedSearchRef.current && stageRef.current === 'ready' && searchSnapshotRef.current) {
      void emitTo('search', 'assetops-search-begin', searchRequestRef.current);
      void emitTo('search', 'assetops-search-state', { ...searchSnapshotRef.current, request: searchRequestRef.current });
    }
  }, []);
  const requestSearch = useCallback((force = false, detached = false, nativeRequest?: number, pointer = false) => {
    if (!force && document.activeElement instanceof HTMLElement && document.activeElement.closest('[data-hotkey-recorder]')) return;
    if (stageRef.current !== 'ready' || hasOpenOverlay()) return;
    if (detached) {
      detachedSearchRef.current = true;
      searchRequestRef.current = nativeRequest ?? searchRequestRef.current + 1;
      if (searchSnapshotRef.current) searchSnapshotRef.current = { ...searchSnapshotRef.current, query: '' };
      setQuery('');
      setSearchOpen(false);
      publishSearch();
      return;
    }
    setSearchInstant(!pointer); setSearchOpen(true);
    setSearchFocusRequest((value) => value + 1);
  }, [publishSearch]);
  const [activeUnit, setActiveUnit] = useState<string | null>(null);
  const [activeSystem, setActiveSystem] = useState<string | null>(null);
  const [ledgerDirectoryFloating, setLedgerDirectoryFloating] = useState(false);
  const [ledgerDirectoryOpen, setLedgerDirectoryOpen] = useState(false);
  const ledgerDirectoryToggle = useRef<HTMLButtonElement>(null);
  const ledgerDirectoryVisible = !ledgerDirectoryFloating || ledgerDirectoryOpen;
  useLayoutEffect(() => {
    if (ledgerDirectoryFloating) ledgerDirectoryToggle.current?.focus({ preventScroll: true });
  }, [ledgerDirectoryFloating]);
  useLayoutEffect(() => { setLedgerDirectoryOpen(false); }, [page]);
  const toggleLedgerDirectory = useCallback(() => { setLedgerDirectoryFloating(value => !value); setLedgerDirectoryOpen(false); }, []);
  const [fieldsSystemId, setFieldsSystemId] = useState<string | null>(null);
  const openSystemFields = useCallback((systemId: string | null) => { setFieldsSystemId(systemId); setPage('fields'); }, [setPage]);
  const [activeEnvironment, setActiveEnvironment] = useState<string | null>(null);
  const [activeZone, setActiveZone] = useState<string | null>(null);
  const [revealPath, setRevealPath] = useState<{ ids: string[]; token: number } | null>(null);
  const selectStructure = useCallback((unit: string | null, environment: string | null, zone: string | null, system: string | null) => {
    setActiveUnit(unit); setActiveEnvironment(environment); setActiveZone(zone); setActiveSystem(system);
  }, []);
  const openStructureManage = useCallback((target: StructureTarget) => setStructureTarget(target), []);
  const [activeAccount, setActiveAccount] = useState<Record<string, string>>({});
  const [structureOpen, setStructureOpen] = useState(false);
  const [structureTarget, setStructureTarget] = useState<StructureTarget | null>(null);
  const [dialogSubmitting, setDialogSubmitting] = useState(false);
  const submittingDialog = useRef(false);
  const dialogSaving = saving || dialogSubmitting;
  const submitDialog = async (operation: () => Promise<void>) => {
    if (submittingDialog.current) return;
    submittingDialog.current = true; setDialogSubmitting(true);
    try { await operation(); }
    catch (reason) { messageApi.error(reason instanceof Error ? reason.message : String(reason)); }
    finally { submittingDialog.current = false; setDialogSubmitting(false); }
  };
  const assetSession = useRef(0);
  const batchSession = useRef(0);
  const structureSession = useRef(0);
  const [assetOpen, setAssetOpenState] = useState(false);
  const assetOpenRef = useRef(false);
  const setAssetOpen = useCallback((open: boolean) => { assetOpenRef.current = open; setAssetOpenState(open); }, []);
  const assetTrigger = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => { if (page !== 'ledger' || stage !== 'ready') assetTrigger.current = null; }, [page, stage]);
  const restoreAssetFocus = useCallback(() => {
    const trigger = assetTrigger.current; assetTrigger.current = null;
    const ledger = document.querySelector<HTMLElement>('#page-ledger:not([hidden])');
    if (!ledger) return;
    if ([...document.querySelectorAll<HTMLElement>('.ant-modal-wrap')].some(wrapper => wrapper.style.display !== 'none' && !wrapper.classList.contains('asset-editor-wrap'))) return;
    const available = (element: HTMLElement | null): element is HTMLElement => Boolean(element?.isConnected && element.getClientRects().length && !element.matches(':disabled'));
    const fallback = ledger.querySelector<HTMLElement>('.table-toolbar .ant-btn-primary');
    if (available(trigger)) trigger.focus({ preventScroll: true });
    else if (available(fallback)) fallback.focus({ preventScroll: true });
  }, []);
  const [assetPresent, setAssetPresent] = useState(false);
  const [notesOpen, setNotesOpen] = useState(false); const [notesDraft, setNotesDraft] = useState('');
  const [editingAsset, setEditingAsset] = useState<Asset | null>(null);
  const [detailAsset, setDetailAsset] = useState<Asset | null>(null);
  const [detailClosing, setDetailClosing] = useState(false);
  const pendingDetailEditRef = useRef<Asset | null>(null);
  const [structureForm] = Form.useForm<StructureForm>();
  const [assetForm] = Form.useForm<AssetForm>();
  const [batchForm] = Form.useForm<{ operation: 'status' | 'system' | 'replace'; status?: AssetStatus; systemId?: string; field?: 'name' | 'host' | 'ip' | 'os'; find?: string; replace?: string }>();
  const editorSystemId = Form.useWatch('systemId', { form: assetForm, preserve: true });
  const structureUnitChoice = Form.useWatch('unitChoice', { form: structureForm, preserve: true }) ?? '__new__';
  const structureEnvChoice = Form.useWatch('envChoice', { form: structureForm, preserve: true }) ?? '__new__';
  const structureZoneChoice = Form.useWatch('zoneChoice', { form: structureForm, preserve: true }) ?? '__none__';
  const editorRotatePassword = Form.useWatch('rotatePassword', { form: assetForm, preserve: true });
  const editorPasswordCycleDays = Form.useWatch('passwordCycleDays', { form: assetForm, preserve: true });
  const editorAccounts = Form.useWatch('accounts', { form: assetForm, preserve: true });
  const openStructureCreate = useCallback((scope?: Partial<Pick<Asset, 'unitId' | 'environmentId' | 'zoneId'>>) => {
    const unit = data.units.find((item) => item.id === (scope?.unitId ?? activeUnit)) ?? data.units[0];
    const environment = unit?.environments.find((item) => item.id === (scope?.environmentId ?? activeEnvironment)) ?? unit?.environments[0];
    const zone = environment?.zones.find((item) => item.id === (scope?.zoneId ?? activeZone)) ?? environment?.zones[0];
    structureForm.resetFields();
    structureForm.setFieldsValue({ unitChoice: unit?.id ?? '__new__', envChoice: environment?.id ?? '__new__', zoneChoice: zone ? (zone.name ? zone.id : '__none__') : '__none__' });
    structureSession.current++;
    setStructureOpen(true);
  }, [data.units, activeUnit, activeEnvironment, activeZone, structureForm]);
  const batchOperation = Form.useWatch('operation', batchForm);
  const [selectedAssetIds, setSelectedAssetIds] = useState<string[]>([]);
  const [statusFilter, setStatusFilter] = useState<AssetStatus[]>([]);
  const [statusDraft, setStatusDraft] = useState<AssetStatus[]>([]);
  const [fieldFilters, setFieldFilters] = useState<Array<{ id: string; key: string; op: 'contains' | 'equals'; value: string }>>([]);
  const [filterDraft, setFilterDraft] = useState<Array<{ id: string; key: string; op: 'contains' | 'equals'; value: string }>>([]);
  const [filterOpen, setFilterOpen] = useState(false);
  const [pageRevisions, setPageRevisions] = useState<Record<string, number>>({});
  useLayoutEffect(() => {
    document.querySelector<HTMLElement>('.content-area')?.scrollTo({ top: 0 });
  }, [page, pageRevisions[page]]);
  const tablePanelRef = useRef<HTMLDivElement>(null);
  const [tableBodyHeight, setTableBodyHeight] = useState(240);
  const [nextScheduledAt, setNextScheduledAt] = useState<string | null>(null);
  const scheduledBackupBusy = useRef(false);
  const lastScheduledBackupAt = useRef<number>();
  const columnSettings = useMemo(() => data.settings.tableColumns ?? [], [data.settings.tableColumns]);
  const [columnSettingsOpen, setColumnSettingsOpen] = useState(false);
  const { pageSize: tablePageSize, setPageSize: setTablePageSize, sizeChanger: pageSizeChanger } = usePageSize();
  const [ledgerPage, setLedgerPage] = useState(1);
  const [compactLedgerPagination, setCompactLedgerPagination] = useState(false);
  useEffect(() => { setLedgerPage(1); }, [activeUnit, activeEnvironment, activeZone, activeSystem, statusFilter, fieldFilters, maintenanceOnly]);
  const [actionsCollapsed, setActionsCollapsed] = useState(true);
  const [actionsPresent, setActionsPresent] = useState(false);
  const [tableSort, setTableSort] = useState<{ field: string; order: 'ascend' | 'descend' }>();
  const [batchOpen, setBatchOpen] = useState(false);
  const [batchDeleteOpen, setBatchDeleteOpen] = useState(false);
  const [batchDeleteLeft, setBatchDeleteLeft] = useState(0);
  useEffect(() => {
    const assetIds = new Set(data.assets.map((asset) => asset.id));
    setSelectedAssetIds((current) => {
      const remaining = current.filter((assetId) => assetIds.has(assetId));
      return remaining.length === current.length ? current : remaining;
    });
    setDetailAsset((current) => current ? data.assets.find((asset) => asset.id === current.id) ?? null : null);
  }, [data.assets]);
  useEffect(() => {
    if (actionsCollapsed && (page !== 'ledger' || stage !== 'ready')) setActionsPresent(false);
  }, [actionsCollapsed, page, stage]);
  useEffect(() => {
    if (!batchDeleteOpen) return;
    setBatchDeleteLeft(3);
    const timer = window.setInterval(() => setBatchDeleteLeft((left) => (left <= 1 ? 0 : left - 1)), 1000);
    return () => window.clearInterval(timer);
  }, [batchDeleteOpen]);
  const [backups, setBackups] = useState<BackupPageInfo[]>([]);
  const [backupLoading, setBackupLoading] = useState(false);
  const [backupError, setBackupError] = useState('');
  const [backupReadReady, setBackupReadReady] = useState(false);
  const backupRequest = useRef(0);
  useEffect(() => {
    if (stage !== 'ready') { backupRequest.current++; setBackupLoading(false); setBackupError(''); setBackupReadReady(false); setBackups([]); }
    return () => { backupRequest.current++; };
  }, [stage]);
  const [appInfo, setAppInfo] = useState<AppInfo>();
  const [appInfoError, setAppInfoError] = useState('');
  const [appInfoLoading, setAppInfoLoading] = useState(false);
  const appInfoRequest = useRef(0);
  useLayoutEffect(() => { if (stage !== 'ready') { appInfoRequest.current++; setAppInfoError(''); setAppInfoLoading(false); } }, [stage]);
  const refreshAppInfo = useCallback(async () => {
    if (stageRef.current !== 'ready') return;
    const request = ++appInfoRequest.current;
    setAppInfoLoading(true);
    try {
      const info = await native.info();
      if (request !== appInfoRequest.current || stageRef.current !== 'ready') return;
      setAppInfo(info); setAppInfoError('');
    } catch (reason) {
      if (request === appInfoRequest.current && stageRef.current === 'ready') setAppInfoError(reason instanceof Error ? reason.message : String(reason));
    } finally { if (request === appInfoRequest.current && stageRef.current === 'ready') setAppInfoLoading(false); }
  }, [stageRef]);
  const [systemDark, setSystemDark] = useState(() => window.matchMedia('(prefers-color-scheme: dark)').matches);
  const darkTheme = data.settings.theme === 'dark' || (data.settings.theme === 'system' && systemDark);
  const springTheme = data.settings.theme === 'spring';
  const activeTheme = darkTheme ? 'dark' : springTheme ? 'spring' : 'light';
  const brandIcon = brandIcons[activeTheme];
  const appTheme = useMemo(() => createAppTheme(activeTheme), [activeTheme]);

  useEffect(() => { void session.check().then(() => autoEnter(session, enter)).catch(windowError); }, [session]);



  useEffect(() => {
    if (!native.desktop) return;
    let disposed = false;
    const releases: Array<() => void> = [];
    const subscribe = async () => {
      const handlers: Array<[string, (payload: unknown) => void]> = [
        ['assetops-open-search', (payload) => { const request = payload as { fromBackground: boolean; detached: boolean; request?: number }; requestSearch(request.fromBackground, request.detached, request.request); }],
        ['assetops-search-ready', publishSearch],
        ['assetops-search-query', (payload) => { if (stageRef.current === 'ready' && detachedSearchRef.current) setQuery(String(payload)); }],
        ['assetops-search-insert', (payload) => { void searchActionsRef.current.insert(payload as SearchInsertRequest); }],
        ['assetops-search-select', (payload) => searchActionsRef.current.openItem(payload as { id: string; type: string })],
        ['assetops-search-home', () => searchActionsRef.current.openHome()],
        ['assetops-search-closed', () => { detachedSearchRef.current = false; if (!dataRef.current.settings.preserveSearch) setQuery(''); }],
        ['assetops-search-activity', () => window.dispatchEvent(new Event('assetops-activity'))],
        ['assetops-operation-error', (payload) => messageApi.error(String(payload))],
      ];
      for (const [name, handler] of handlers) {
        const release = await listen(name, ({ payload }) => handler(payload));
        if (disposed) release(); else releases.push(release);
      }
    };
    void subscribe().catch((error) => { releases.splice(0).forEach((release) => release()); windowError(error); });
    native.searchHotkeyStatus().then((status) => {
      if (disposed || !status) return;
      globalSearchRegisteredRef.current = status.registered;
      searchHotkeyRef.current = status.hotkey;
    }).catch(windowError);
    return () => { disposed = true; releases.forEach((release) => release()); };
  }, [requestSearch, publishSearch, windowError]);

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLElement && event.target.closest('[data-hotkey-recorder]')) return;
      if (!globalSearchRegisteredRef.current && matchesHotkey(event, searchHotkeyRef.current)) {
        event.preventDefault();
        requestSearch();
      }
    };
    window.addEventListener('keydown', handleKey, true);
    return () => window.removeEventListener('keydown', handleKey, true);
  }, [requestSearch]);

  useEffect(() => {
    const handleWheel = (event: WheelEvent) => {
      if (!event.altKey) return;
      const container = (event.target as HTMLElement | null)?.closest('.ant-table-body, .ant-table-content');
      if (!container) return;
      event.preventDefault();
      container.scrollLeft += event.deltaY;
    };
    document.addEventListener('wheel', handleWheel, { passive: false });
    return () => document.removeEventListener('wheel', handleWheel);
  }, []);

  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const update = () => setSystemDark(media.matches);
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  useLayoutEffect(() => {
    document.documentElement.dataset.theme = activeTheme;
    if (stage === 'ready') localStorage.setItem('assetops-theme', data.settings.theme);
  }, [activeTheme, data.settings.theme, stage]);
  useEffect(() => {
    void native.setWindowAppearance(activeTheme).catch((reason) => messageApi.error(reason instanceof Error ? reason.message : '窗口主题设置失败'));
  }, [activeTheme]);

  useEffect(() => {
    if (stage !== 'ready' || !data.settings.autoLock) return;
    let timeout = window.setTimeout(() => void lockApplication(), data.settings.autoLockMinutes * 60_000);
    const reset = () => { window.clearTimeout(timeout); timeout = window.setTimeout(() => void lockApplication(), data.settings.autoLockMinutes * 60_000); };
    for (const name of ['mousedown', 'keydown', 'touchstart', 'assetops-activity']) window.addEventListener(name, reset);
    return () => { window.clearTimeout(timeout); for (const name of ['mousedown', 'keydown', 'touchstart', 'assetops-activity']) window.removeEventListener(name, reset); };
  }, [stage, data.settings.autoLock, data.settings.autoLockMinutes]);

  useEffect(() => {
    if (stage !== 'ready' || !native.desktop || !data.settings.scheduledBackup) { setNextScheduledAt(null); return; }
    let cancelled = false;
    let lastBackupAt: number | undefined;
    const enabledAt = Date.now();
    const check = async () => {
      if (cancelled || scheduledBackupBusy.current) return;
      const last = Math.max(lastBackupAt ?? 0, lastScheduledBackupAt.current ?? 0) || undefined;
      const next = nextBackupAt(data.settings, new Date(), last, enabledAt);
      if (next === null) { setNextScheduledAt(null); return; }
      setNextScheduledAt(new Date(next).toISOString());
      if (next > Date.now()) return;
      scheduledBackupBusy.current = true;
      try {
        const created = await native.createBackup('scheduled');
        lastBackupAt = Date.parse(created.createdAt);
        lastScheduledBackupAt.current = lastBackupAt;
        if (!cancelled) {
          setNextScheduledAt(new Date(nextBackupAt(data.settings, new Date(), lastBackupAt, enabledAt)!).toISOString());
          await refreshBackups();
        }
      } catch (reason) {
        if (!cancelled) messageApi.error(reason instanceof Error ? reason.message : '定时备份失败，下次检查将重试');
      } finally { scheduledBackupBusy.current = false; }
    };
    let interval: number | undefined;
    void native.listBackups().then((items) => {
      if (cancelled) return;
      const times = items.filter((item) => item.kind === 'scheduled').map((item) => Date.parse(item.createdAt)).filter(Number.isFinite);
      lastBackupAt = times.length ? Math.max(...times) : undefined;
      if (!scheduledBackupBusy.current) lastScheduledBackupAt.current = lastBackupAt;
      void check(); interval = window.setInterval(() => void check(), 60_000);
    }).catch((reason) => { if (!cancelled) messageApi.error(reason instanceof Error ? reason.message : '无法读取定时备份记录'); });
    return () => { cancelled = true; window.clearInterval(interval); };
  }, [stage, data.settings.scheduledBackup, data.settings.scheduledBackupCron, data.settings.scheduledBackupTime, data.settings.scheduledBackupMode, data.settings.scheduledBackupIntervalHours]);

  useLayoutEffect(() => {
    if (page !== 'ledger' || stage !== 'ready') return;
    const panel = tablePanelRef.current;
    if (!panel) return;
    const resize = () => {
      const body = panel.querySelector('.ant-table-body') as HTMLElement | null;
      const gutter = body ? body.offsetWidth - body.clientWidth : 0;
      const toolbar = panel.querySelector('.table-toolbar')?.getBoundingClientRect().height ?? 55;
      const summary = panel.querySelector('.table-summary')?.getBoundingClientRect().height ?? 32;
      const header = panel.querySelector('.ant-table-header')?.getBoundingClientRect().height ?? 0;
      const height = Math.max(100, Math.floor((panel.querySelector('.table-panel')?.clientHeight ?? panel.clientHeight) - toolbar - summary - header));
      setCompactLedgerPagination(panel.clientWidth < 640);
      panel.style.setProperty('--ledger-actions-gutter', `${gutter}px`);
      panel.parentElement?.style.setProperty('--ledger-toolbar-height', `${toolbar}px`);
      setTableBodyHeight(height);
    };
    const observer = new ResizeObserver(resize);
    observer.observe(panel);
    for (const selector of ['.table-toolbar', '.ant-table-header', '.table-summary']) {
      const element = panel.querySelector(selector); if (element) observer.observe(element);
    }
    resize(); return () => observer.disconnect();
  }, [page, stage, pageRevisions, tablePageSize, activeUnit, activeSystem, data.fieldDefs, data.settings.ledgerOnlySystem]);

  const enter = async (password: string) => {
    const unlockedData = await session.unlock(password);
    native.info().then(setAppInfo).catch(() => undefined);
    const backupDate = localStorage.getItem('assetops-startup-backup-date');
    if (native.desktop && unlockedData!.settings.startupBackup && backupDate !== today()) {
      native.createBackup('startup').then(() => localStorage.setItem('assetops-startup-backup-date', today())).catch(() => undefined);
    }
  };

  const commit = useCallback(async (next: VaultData, syncRuntimeSettings = false, reportError = true) => {
    try {
      await session.save(data, next, syncRuntimeSettings);
    } catch (error) {
      if (!reportError) throw error;
      const reason = error instanceof Error ? error.message : String(error);
      if (/正在保存|数据已更新/.test(reason)) messageApi.warning(reason);
      else messageApi.error(`保存失败：${reason}`);
      throw error;
    }
  }, [session, data, messageApi]);
  const calendarGeneration = session.getGeneration();
  const saveCalendarSources = async (sources: Pick<SettingsModel, 'holidayCalendarUrl'>, holidays: VaultData['reports']['calendar']['holidays']) => {
    if (session.getGeneration() !== calendarGeneration) throw new Error('数据仓库已切换，请重新下载日历');
    const latest = session.getSnapshot().data;
    await session.save(latest, { ...latest, settings: { ...latest.settings, ...sources }, reports: { ...latest.reports, calendar: { ...latest.reports.calendar, holidays } } });
  };
  const changeReports = useCallback((reports: VaultData['reports']) => session.save(data, { ...data, reports }), [session, data]);
  const changeOperations = useCallback((opsSystems: VaultData['opsSystems']) => commit({ ...data, opsSystems }), [commit, data]);
  const handleReportFocus = useCallback(() => setReportFocusId(undefined), []);
  const handleOperationsFocus = useCallback(() => setOpsFocusId(undefined), []);
  const openReportPage = useCallback((tab: 'entries' | 'calendar') => { setReportFocusId(tab); setPage('reports'); }, [setPage]);
  const openUnitAssets = useCallback((unit: VaultData['units'][number]) => { selectStructure(unit.id, null, null, null); setMaintenanceOnly(false); setPage('ledger'); }, [selectStructure, setPage]);
  const openOperationsAsset = useCallback((assetId: string) => {
    const asset = data.assets.find(item => item.id === assetId);
    if (!asset) { messageApi.warning('此资产已删除，原拓扑节点保留'); return; }
    assetTrigger.current = null;
    selectStructure(asset.unitId, asset.environmentId, asset.zoneId, asset.systemId);
    setStatusFilter([]); setFieldFilters([]); setMaintenanceOnly(false); setPage('ledger'); setDetailAsset(asset);
  }, [data.assets, messageApi, selectStructure, setPage]);
  const changeSidebar = async (sidebarCollapsed: boolean) => {
    try { await session.changeSidebar(data, sidebarCollapsed); }
    catch (error) { messageApi.error(`保存侧栏偏好失败：${error instanceof Error ? error.message : String(error)}`); throw error; }
  };

  useEffect(() => {
    if (stage !== 'ready') return;
    let cancelled = false; let running = false;
    const check = async () => {
      if (cancelled || running || session.getSnapshot().saving || dataRef.current !== data) return;
      running = true;
      try {
        await notifyDueReminders(session, data, async (due) => {
          const ids = due.map(task => task.id);
          setReminderNotice((previous) => [...new Set([...previous, ...ids])]);
          await native.showReminder(due.length === 1 ? due[0].title : `${due.length} 项提醒已到期`, due.map((task) => `${task.title} · ${chinaTime(task.dueAt)}${task.note ? '\n' + task.note : ''}`).join('\n').slice(0, 2100)).catch((error) => { messageApi.warning({ content: `系统通知发送失败：${error instanceof Error ? error.message : String(error)}。请在应用内查看到期提醒。`, duration: 8 }); void native.showMainWindow().catch(() => undefined); });
        });
      } catch { /* 保存占用或失败时，下一轮重试，不提前标记已提醒。 */ }
      finally { running = false; }
    };
    void check(); const timer = window.setInterval(() => void check(), 15000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [stage, data, saving]);

  const restoreVault = async (backupId: string, backupPassword?: string) => {
    await session.restore(data, backupId, backupPassword);
    setAppInfo(undefined); setAppInfoError('');
    await Promise.all([refreshAppInfo(), refreshBackups()]);
  };

  const changeMasterPassword = async (currentPassword: string, newPassword: string) => {
    try { await session.changePassword(data, currentPassword, newPassword); }
    catch (error) { if (String(error).includes('数据仓库已锁定')) { await session.lock(); messageApi.error({ content: error instanceof Error ? error.message : String(error), duration: 12 }); } throw error; }
    messageApi.success('主密码已修改');
  };

  const reinitializeVault = async (newPassword: string) => {
    await session.reinitialize(data, newPassword);
    messageApi.success('数据仓库已重新初始化');
    void refreshAppInfo();
    void refreshBackups();
  };

  const changeBackupDirectory = async (newDirectory: string) => {
    const path = await session.changeBackupDirectory(data, newDirectory);
    setAppInfo((current) => current ? { ...current, backupDirectory: path } : current);
    void refreshAppInfo();
    void refreshBackups();
    return path;
  };

  const assertValidAssets = (assets: Asset[]) => {
    const candidate = normalizeVault({ ...data, assets }).assets;
    const context = createAssetValidationContext(candidate, data);
    for (const asset of candidate) {
      const errors = validateAsset(asset, candidate, data, context);
      if (errors.length) throw new Error(`资产 ${asset.name}：${errors.join('；')}`);
    }
  };

  const addHistory = (assetName: string, action: ChangeRecord['action'], options: Partial<ChangeRecord> = {}): ChangeRecord => ({ id: id(), assetName, objectName: assetName, action, at: stamp(), source: '手动', ...options });

  const lockApplication = async () => {
    searchInsertCache.clear();
    const locked = session.lock().catch(windowError);
    detachedSearchRef.current = false;
    searchSnapshotRef.current = undefined;
    setSearchOpen(false);
    setOpenPages(['home']); setActivePage('home'); setPageRevisions({}); setReminderNotice([]);
    pendingDetailEditRef.current = null;
    setStructureOpen(false); setStructureTarget(null); setAssetOpen(false); setAssetPresent(false); setNotesOpen(false); setNotesDraft(''); setEditingAsset(null); setDetailAsset(null); setDetailClosing(false);
    assetTrigger.current = null; assetOpenRef.current = false;
    setBatchOpen(false); setBatchDeleteOpen(false); setColumnSettingsOpen(false); setFilterOpen(false);
    setSelectedAssetIds([]); setActiveAccount({});
    assetForm.resetFields(); structureForm.resetFields(); batchForm.resetFields();
    await native.closeSearchWindow().catch(windowError);
    await locked;
  };



  const columnFieldKeys: Record<string, string> = { businessSystem: 'business_system', ip: 'ip_1', ip2: 'ip_2', memory: 'mem', accounts: 'user', pwdRotate: 'pwd_rotate', pwdCycle: 'pwd_cycle_days', passwordExpiry: 'pwd_expire_at', updatedAt: 'updated_at', createdAt: 'created_at' };
  const fieldLabel = useCallback((key: string, fallback: string, systemId = activeSystem) => systemId ? data.fieldDefs.find((field) => field.key === (columnFieldKeys[key] ?? key) && field.systemId === systemId)?.label ?? fallback : fallback, [activeSystem, data.fieldDefs]);
  const ledgerGroups = useMemo(() => ledgerFieldGroups(data, { unitId: activeUnit ?? undefined, environmentId: activeEnvironment ?? undefined, zoneId: activeZone ?? undefined, systemId: activeSystem ?? undefined }), [data.units, data.fieldDefs, activeUnit, activeEnvironment, activeZone, activeSystem]);
  const visibleColumns = useMemo(() => [...ledgerGroups.filter(group => group.field.showInList).map(group => group.key), ...(ledgerGroups.length && columnSettings.some(column => column.key === 'tags' && column.visible) ? ['tags'] : [])], [ledgerGroups, columnSettings]);
  const filterableFields = useMemo(() => {
    const base = [
      { value: 'businessSystem', label: '业务系统' }, { value: 'name', label: '服务器名称' }, { value: 'host', label: '主机名' },
      { value: 'ip', label: '主 IP' }, { value: 'ip2', label: '备用 IP' }, { value: 'os', label: '操作系统' },
      { value: 'accounts', label: '账号' }, { value: 'tags', label: '标签' },
    ];
    const options = ledgerGroups.length ? [...ledgerGroups.filter(group => !['password', 'pwd_expire_at', 'status'].includes(group.field.key)).map(group => ({ value: group.key, label: group.field.label })), { value: 'tags', label: '标签' }] : base;
    const seen = new Set<string>();
    return options.filter((item) => { if (seen.has(item.value)) return false; seen.add(item.value); return true; });
  }, [ledgerGroups]);
  const defaultFilterKey = ledgerGroups.find(group => group.field.key === 'name')?.key ?? 'name';
  const filterValueOf = (asset: Asset, key: string): string => {
    const group = ledgerGroups.find(item => item.key === key);
    if (group) { const value = ledgerFieldValue(group, asset); return group.field.type === 'user' && Array.isArray(value) ? value.map(account => account.username).join(' ') : String(value ?? ''); }
    if (key.startsWith('custom:')) return String(asset.custom?.[key.slice(7)] ?? '');
    if (key === 'accounts') return asset.accounts.map((account) => account.username).join(' ');
    if (key === 'tags') return (asset.tags ?? []).join(' ');
    return String((asset as unknown as Record<string, unknown>)[key] ?? '');
  };
  const filteredAssets = useMemo(() => {
    if (!activeUnit && !activeEnvironment && !activeZone && !activeSystem) return [];
    if (data.settings.ledgerOnlySystem && !activeSystem) return [];
    return data.assets.filter((asset) => {
    const matchesTree = (!activeUnit || asset.unitId === activeUnit) && (!activeEnvironment || asset.environmentId === activeEnvironment) && (!activeZone || asset.zoneId === activeZone) && (!activeSystem || asset.systemId === activeSystem);
    if (!matchesTree || (statusFilter.length && !statusFilter.includes(asset.status))) return false;
    const matchesFields = fieldFilters.every((filter) => {
      if (!filter.value.trim()) return true;
      const haystack = filterValueOf(asset, filter.key).toLowerCase();
      const needle = filter.value.trim().toLowerCase();
      return filter.op === 'equals' ? haystack === needle : haystack.includes(needle);
    });
    return matchesFields && (!maintenanceOnly || maintenanceAccounts([asset], data.settings.passwordWarningDays).length > 0);
    });
  }, [data.assets, activeUnit, activeEnvironment, activeZone, activeSystem, statusFilter, fieldFilters, ledgerGroups, maintenanceOnly, data.settings.passwordWarningDays, data.settings.ledgerOnlySystem]);

  const visibleAssetIds = useMemo(() => new Set(filteredAssets.map((asset) => asset.id)), [filteredAssets]);
  useEffect(() => {
    setSelectedAssetIds((current) => {
      const remaining = current.filter((assetId) => visibleAssetIds.has(assetId));
      return remaining.length === current.length ? current : remaining;
    });
  }, [visibleAssetIds]);
  const systemOptions = useMemo(() => data.units.flatMap((unit) => unit.environments.flatMap((environment) => environment.zones.flatMap((zone) => zone.systems.map((system) => ({
    unit, environment, zone, system,
  }))))), [data.units]);
  useEffect(() => {
    if (stage !== 'ready') return;
    const unit = data.units.find((item) => item.id === activeUnit);
    const environment = unit?.environments.find((item) => item.id === activeEnvironment);
    const zone = environment?.zones.find((item) => item.id === activeZone);
    if (activeUnit && !unit) selectStructure(null, null, null, null);
    else if (activeEnvironment && !environment) selectStructure(activeUnit, null, null, null);
    else if (activeZone && !zone) selectStructure(activeUnit, activeEnvironment, null, null);
    else if (activeSystem && !zone?.systems.some((item) => item.id === activeSystem)) selectStructure(activeUnit, activeEnvironment, activeZone, null);
  }, [data.units, stage, activeUnit, activeEnvironment, activeZone, activeSystem, selectStructure]);

  const editorCustomFields = data.fieldDefs.filter((field) => field.systemId === editorSystemId && !field.systemField && !['business_system', 'name', 'host', 'ip_1', 'ip_2', 'cpu', 'mem', 'disks', 'os', 'user', 'password', 'pwd_rotate', 'pwd_cycle_days', 'pwd_expire_at', 'status'].includes(field.key)).sort((left, right) => left.sortOrder - right.sortOrder);
  const editorFieldOrder = new Map(data.fieldDefs.filter((field) => field.systemId === editorSystemId).map((field) => [field.key, field.sortOrder]));
  const editorHasField = (key: string) => data.fieldDefs.some((field) => field.systemId === editorSystemId && field.key === key);
  const editorMaxLength = (key: string, fallback: number) => {
    const field = data.fieldDefs.find((item) => item.systemId === editorSystemId && item.key === key);
    return field ? field.validation.maxLength : fallback;
  };
  const formOrder = (fieldKey: string, fallback: number) => editorFieldOrder.get(fieldKey) ?? fallback;

  const refreshBackups = async () => {
    if (stageRef.current !== 'ready') return;
    const request = ++backupRequest.current;
    setBackupLoading(true);
    try {
      const list = await native.listBackups();
      if (request !== backupRequest.current || stageRef.current !== 'ready') return;
      setBackups(list.map((backup: NativeBackupInfo) => ({
        id: backup.fileName, fileName: backup.fileName,
        kind: backup.kind,
        sizeBytes: backup.size, createdAt: backup.createdAt,
        integrity: backup.integrity === 'ok' ? 'valid' : backup.integrity === 'unchecked' ? 'unchecked' : 'invalid', path: backup.path,
      })));
      setBackupReadReady(true); setBackupError('');
    } catch (error) { if (request === backupRequest.current && stageRef.current === 'ready') setBackupError(error instanceof Error ? error.message : String(error)); }
    finally { if (request === backupRequest.current && stageRef.current === 'ready') setBackupLoading(false); }
  };

  useEffect(() => { if (page === 'backup' && stage === 'ready') void refreshBackups(); }, [page, stage]);
  useEffect(() => { if (stage === 'ready') void refreshBackups(); }, [stage]);

  const openNewAsset = useCallback(() => {
    if (!systemOptions.length) {
      messageApi.info('请先新建单位、环境、区域和系统');
      openStructureCreate();
      return;
    }
    const option = systemOptions.find((item) => item.system.id === activeSystem) ?? systemOptions.find(item => data.fieldDefs.some(field => field.systemId === item.system.id));
    if (!option || !data.fieldDefs.some(field => field.systemId === option.system.id)) {
      messageApi.info('请先在字段定义中为该系统配置并保存字段');
      openSystemFields(option?.system.id ?? activeSystem);
      return;
    }
    setEditingAsset(null);
    assetTrigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    assetForm.resetFields();
    assetForm.setFieldsValue({
      businessSystem: '', name: '', host: '', ip: '', ip2: '', status: '生产', systemId: option.system.id,
      cpu: undefined, memory: undefined, os: '', disks: '', tags: '', accounts: [{ username: '', password: '', passwordUpdatedAt: today() }],
      ...assetFieldDefaults(data.fieldDefs.filter((field) => field.systemId === option.system.id)),
    });
    assetSession.current++;
    startTransition(() => { setAssetPresent(true); setAssetOpen(true); });
  }, [systemOptions, activeSystem, data.fieldDefs, messageApi, openStructureCreate, assetForm, openSystemFields, setAssetOpen]);

  const openEditAsset = useCallback((asset: Asset, fromDetail = false) => {
    if (!fromDetail) assetTrigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setEditingAsset(asset);
    assetForm.resetFields();
    assetForm.setFieldsValue({
      businessSystem: asset.businessSystem ?? '', name: asset.name, host: asset.host, ip: asset.ip, ip2: asset.ip2 ?? '', status: asset.status, systemId: asset.systemId,
      cpu: asset.cpu, memory: asset.memory, os: asset.os,
      tags: (asset.tags ?? []).join(', '),
      disks: asset.disks.map((disk) => `${disk.label} | ${diskCapacityText(disk)}`).join('\n'),
      accounts: asset.accounts,
      rotatePassword: asset.rotatePassword, passwordCycleDays: asset.passwordCycleDays,
    });
    assetForm.setFieldValue('custom', asset.custom ?? {});
    assetSession.current++;
    if (fromDetail) { setAssetPresent(true); setAssetOpen(true); }
    else startTransition(() => { setAssetPresent(true); setAssetOpen(true); });
  }, [assetForm, setAssetOpen]);

  const closeDetail = () => { pendingDetailEditRef.current = null; setDetailClosing(true); };
  const finishDetailMotion = (open: boolean) => {
    if (open || !detailClosing) return;
    const pending = pendingDetailEditRef.current;
    pendingDetailEditRef.current = null;
    const asset = pending && data.assets.find((item) => item.id === pending.id);
    if (asset) openEditAsset(asset, true);
    else restoreAssetFocus();
    setDetailAsset(null); setDetailClosing(false);
  };

  const importOrganization = async (incoming: DirectoryUnit[]) => {
    const merged = mergeOrganization(data.units, incoming);
    if (!merged.added.length) return;
    const fieldDefs = data.fieldDefs;
    const history = [...merged.added.map((item) => addHistory(item.path, '新增', { objectType: item.type, objectId: item.id, source: '导入', note: '合并导入组织目录' })), ...data.history];
    if (data.settings.backupBeforeWrite && native.desktop) await native.createBackup('pre-import');
    await commit({ ...data, units: merged.units, fieldDefs, history });
  };

  const saveStructure = async (values: StructureForm) => {
    const session = structureSession.current;
    const systemName = (values.systemName ?? '').trim();
    if (!systemName) return;
    const units = data.units.map((unit) => ({ ...unit, environments: unit.environments.map((environment) => ({ ...environment, zones: environment.zones.map((zone) => ({ ...zone, systems: [...zone.systems] })) })) }));

    let unit = values.unitChoice === '__new__' ? undefined : units.find((item) => item.id === values.unitChoice);
    if (!unit) {
      const unitName = (values.unitName ?? '').trim();
      if (!unitName) { messageApi.error('请选择或填写单位'); return; }
      if (units.some((item) => item.name === unitName)) { messageApi.error('已有同名单位'); return; }
      unit = { id: id(), name: unitName, environments: [] };
      units.push(unit);
    }
    let environment = values.envChoice === '__new__' ? undefined : unit.environments.find((item) => item.id === values.envChoice);
    if (!environment) {
      const envName = (values.envName ?? '').trim();
      if (!envName) { messageApi.error('请选择或填写环境'); return; }
      if (unit.environments.some((item) => item.name === envName)) { messageApi.error('当前单位已有同名环境，请在环境下拉框选择已有项'); return; }
      environment = { id: id(), name: envName, zones: [] };
      unit.environments.push(environment);
    }
    let zone = values.zoneChoice === '__none__' ? environment.zones.find((item) => !item.name) : values.zoneChoice === '__new__' ? undefined : environment.zones.find((item) => item.id === values.zoneChoice);
    if (!zone) {
      const zoneName = values.zoneChoice === '__none__' ? '' : (values.zoneName ?? '').trim();
      if (!zoneName && values.zoneChoice !== '__none__') { messageApi.error('请选择或填写区域'); return; }
      if (environment.zones.some((item) => item.name === zoneName)) { messageApi.error('当前环境已有同名区域，请在区域下拉框选择已有项'); return; }
      zone = { id: id(), name: zoneName, systems: [] };
      environment.zones.push(zone);
    }
    if (zone.systems.some((item) => item.name === systemName)) { messageApi.error('当前区域已有同名系统'); return; }
    const system = { id: id(), name: systemName };
    zone.systems.push(system);

    const fieldDefs = data.fieldDefs;
    const pathText = [unit.name, environment.name, zone.name, system.name].filter(Boolean).join(' / ');
    const history = [addHistory(pathText, '新增', { objectType: 'system', objectId: system.id, source: '手动', note: '新建系统，字段待配置' }), ...data.history];
    if (data.settings.backupBeforeWrite && native.desktop) await native.createBackup('pre-schema');
    await commit({ ...data, units, fieldDefs, history }, false, false);
    setActiveUnit(unit.id); setActiveEnvironment(environment.id); setActiveZone(zone.id); setActiveSystem(system.id);
    if (page === 'operations') setOpsFocusId(system.id);
    setRevealPath({ ids: [unit.id, environment.id, ...(zone.name ? [zone.id] : [])], token: Date.now() });
    if (session === structureSession.current) { setStructureOpen(false); structureForm.resetFields(); }
    messageApi.success('组织结构已保存');
  };

  const renameStructure = async (type: Exclude<ObjectType, 'asset'>, targetId: string, nextName: string) => {
    let previousName = '';
    const duplicateError: Record<string, string> = { unit: '已有同名单位', environment: '当前单位已有同名环境', zone: '当前环境已有同名区域', system: '当前区域已有同名系统' };
    const units = data.units.map((unit) => {
      if (type === 'unit' && unit.id === targetId) {
        if (data.units.some((item) => item.id !== targetId && item.name === nextName)) throw new Error(duplicateError.unit);
        previousName = unit.name;
        return { ...unit, name: nextName };
      }
      return {
        ...unit,
        environments: unit.environments.map((environment) => {
          if (type === 'environment' && environment.id === targetId) {
            if (unit.environments.some((item) => item.id !== targetId && item.name === nextName)) throw new Error(duplicateError.environment);
            previousName = environment.name;
            return { ...environment, name: nextName };
          }
          return {
            ...environment,
            zones: environment.zones.map((zone) => {
              if (type === 'zone' && zone.id === targetId) {
                if (environment.zones.some((item) => item.id !== targetId && item.name === nextName)) throw new Error(duplicateError.zone);
                previousName = zone.name;
                return { ...zone, name: nextName };
              }
              return {
                ...zone,
                systems: zone.systems.map((system) => {
                  if (type !== 'system' || system.id !== targetId) return system;
                  if (zone.systems.some((item) => item.id !== targetId && item.name === nextName)) throw new Error(duplicateError.system);
                  previousName = system.name;
                  return { ...system, name: nextName };
                }),
              };
            }),
          };
        }),
      };
    });
    if (!previousName) throw new Error('找不到要重命名的结构');
    if (data.settings.backupBeforeWrite && native.desktop) await native.createBackup('pre-schema');
    await commit({ ...data, units, history: [addHistory(nextName, '编辑', { objectType: type, objectId: targetId, source: '手动', note: `${previousName} → ${nextName}`, items: [{ fieldKey: 'name', fieldLabel: '名称', before: previousName, after: nextName }] }), ...data.history] });
    messageApi.success('名称已更新');
  };

  const deleteStructure = async (type: Exclude<ObjectType, 'asset'>, targetId: string) => {
    let name = '';
    let snapshot: Record<string, unknown> | undefined;
    let units = data.units;
    let assets = data.assets;
    let fieldDefs = data.fieldDefs;
    let tableViews = data.tableViews;
    const detach = (systemIds: Set<string>, assetIds: Set<string>) => {
      fieldDefs = fieldDefs.filter((field) => !systemIds.has(field.systemId));
      tableViews = tableViews.filter((view) => !view.systemId || !systemIds.has(view.systemId));
      assets = assets.filter((asset) => !assetIds.has(asset.id));
    };

    if (type === 'unit') {
      const unit = data.units.find((item) => item.id === targetId);
      if (unit) {
        const systemIds = new Set(unit.environments.flatMap((environment) => environment.zones.flatMap((zone) => zone.systems.map((system) => system.id))));
        const relatedAssets = data.assets.filter((asset) => asset.unitId === unit.id);
        name = unit.name;
        snapshot = { unit, assets: relatedAssets, fieldDefs: data.fieldDefs.filter((field) => systemIds.has(field.systemId)), tableViews: data.tableViews.filter((view) => view.systemId && systemIds.has(view.systemId)) };
        units = data.units.filter((item) => item.id !== unit.id);
        detach(systemIds, new Set(relatedAssets.map((asset) => asset.id)));
      }
    } else {
      for (const unit of data.units) {
        if (snapshot) break;
        if (type === 'environment') {
          const environment = unit.environments.find((item) => item.id === targetId);
          if (environment) {
            const systemIds = new Set(environment.zones.flatMap((zone) => zone.systems.map((system) => system.id)));
            const relatedAssets = data.assets.filter((asset) => asset.environmentId === environment.id);
            name = environment.name;
            snapshot = { unitId: unit.id, environment, assets: relatedAssets, fieldDefs: data.fieldDefs.filter((field) => systemIds.has(field.systemId)), tableViews: data.tableViews.filter((view) => view.systemId && systemIds.has(view.systemId)) };
            units = data.units.map((item) => item.id === unit.id ? { ...item, environments: item.environments.filter((value) => value.id !== environment.id) } : item);
            detach(systemIds, new Set(relatedAssets.map((asset) => asset.id)));
          }
        }
        if (snapshot) break;
        for (const environment of unit.environments) {
          if (type === 'zone') {
            const zone = environment.zones.find((item) => item.id === targetId);
            if (zone) {
              const systemIds = new Set(zone.systems.map((system) => system.id));
              const relatedAssets = data.assets.filter((asset) => asset.zoneId === zone.id);
              name = zone.name;
              snapshot = { unitId: unit.id, environmentId: environment.id, zone, assets: relatedAssets, fieldDefs: data.fieldDefs.filter((field) => systemIds.has(field.systemId)), tableViews: data.tableViews.filter((view) => view.systemId && systemIds.has(view.systemId)) };
              units = data.units.map((item) => item.id === unit.id ? { ...item, environments: item.environments.map((env) => env.id === environment.id ? { ...env, zones: env.zones.filter((value) => value.id !== zone.id) } : env) } : item);
              detach(systemIds, new Set(relatedAssets.map((asset) => asset.id)));
            }
          }
          if (snapshot) break;
          if (type === 'system') {
            const owner = environment.zones.find((zone) => zone.systems.some((system) => system.id === targetId));
            const system = owner?.systems.find((item) => item.id === targetId);
            if (owner && system) {
              const relatedAssets = data.assets.filter((asset) => asset.systemId === system.id);
              name = system.name;
              snapshot = { unitId: unit.id, environmentId: environment.id, zoneId: owner.id, system, assets: relatedAssets, fieldDefs: data.fieldDefs.filter((field) => field.systemId === system.id), tableViews: data.tableViews.filter((view) => view.systemId === system.id) };
              units = data.units.map((item) => item.id === unit.id ? { ...item, environments: item.environments.map((env) => env.id === environment.id ? { ...env, zones: env.zones.map((value) => value.id === owner.id ? { ...value, systems: value.systems.filter((candidate) => candidate.id !== system.id) } : value) } : env) } : item);
              detach(new Set([system.id]), new Set(relatedAssets.map((asset) => asset.id)));
            }
          }
        }
      }
    }
    if (!snapshot) throw new Error('找不到要删除的结构');
    if (data.settings.backupBeforeWrite && native.desktop) await native.createBackup('pre-schema');
    await commit({ ...data, units, assets, fieldDefs, tableViews, history: [addHistory(name, '删除', { objectType: type, objectId: targetId, source: '手动', before: snapshot, note: `结构及关联的 ${data.assets.length - assets.length} 台资产已删除` }), ...data.history] });
    if (type === 'unit' && activeUnit === targetId) { setActiveUnit(null); setActiveEnvironment(null); setActiveZone(null); setActiveSystem(null); }
    if (type === 'environment' && activeEnvironment === targetId) { setActiveEnvironment(null); setActiveZone(null); setActiveSystem(null); }
    if (type === 'zone' && activeZone === targetId) { setActiveZone(null); setActiveSystem(null); }
    if (type === 'system' && activeSystem === targetId) setActiveSystem(null);
    messageApi.success('结构及关联数据已删除');
  };

  const saveAsset = async (values: AssetForm) => {
    const session = assetSession.current;
    const owner = systemOptions.find((option) => option.system.id === values.systemId);
    if (!owner) { messageApi.error('请选择有效系统'); return; }
    if (!data.fieldDefs.some(field => field.systemId === values.systemId)) { messageApi.error('该系统还没有保存字段，请先配置字段模板'); return; }
    const existing = editingAsset;
    if (existing && !sameAssetSnapshot(data.assets.find((asset) => asset.id === existing.id), existing, data)) {
      messageApi.error('该资产已更新或删除，请关闭后重新打开编辑'); return;
    }
    const accounts = updateAccountDates(values.accounts ?? [], existing?.accounts ?? [], today());
    const rotatePassword = rotationEnabled(values.rotatePassword ?? existing?.rotatePassword);
    const passwordCycleDays = Number(values.passwordCycleDays ?? existing?.passwordCycleDays) || 0;
    if (rotatePassword && (!Number.isInteger(passwordCycleDays) || passwordCycleDays < 1 || passwordCycleDays > 3650)) {
      messageApi.error('请填写密码更新周期（1–3650 天的整数）'); return;
    }
    if (new Set(accounts.map((account) => account.username.toLowerCase())).size !== accounts.length) {
      messageApi.error('同一服务器不能录入重复账号'); return;
    }
    if (!isValidIp(values.ip.trim()) || !isValidIp((values.ip2 ?? '').trim())) {
      messageApi.error('请输入合法的 IPv4 或 IPv6 地址'); return;
    }
    let disks: Asset['disks'];
    try { disks = parseDisks(values.disks); } catch (error) { messageApi.error(error instanceof Error ? error.message : String(error)); return; }
    const asset: Asset = {
      id: existing?.id ?? id(), unitId: owner.unit.id, environmentId: owner.environment.id, zoneId: owner.zone.id, systemId: owner.system.id,
      businessSystem: (values.businessSystem ?? existing?.businessSystem ?? '').trim(), name: values.name.trim(), host: values.host.trim(), ip: values.ip.trim(), ip2: (values.ip2 ?? existing?.ip2 ?? '').trim(), status: values.status,
      cpu: optionalNumber(values.cpu), memory: optionalNumber(values.memory), os: values.os.trim(), disks, accounts,
      rotatePassword, passwordCycleDays,
      custom: { ...editingAsset?.custom, ...values.custom }, tags: values.tags.split(/[,，]/).map((tag) => tag.trim()).filter(Boolean),
      createdAt: existing?.createdAt ?? stamp(), updatedAt: stamp(),
    };
    const errors = validateAsset(asset, data.assets, data);
    if (errors.length) { messageApi.error(errors.join('；')); return; }
    const assets = existing ? data.assets.map((item) => item.id === asset.id ? asset : item) : [...data.assets, asset];
    const items = assetDiff(existing ?? undefined, asset);
    if (existing && !items.length) { if (session === assetSession.current) setAssetOpen(false); messageApi.info('数据没有变化'); return; }
    const history = [addHistory(asset.name, existing ? '编辑' : '新增', { assetId: asset.id, systemId: asset.systemId, objectId: asset.id, objectType: 'asset', items, before: existing, after: asset }), ...data.history];
    await commit({ ...data, assets, history }, false, false);
    if (session === assetSession.current) setAssetOpen(false);
    messageApi.success(existing ? '资产已更新' : '资产已新增');
  };

  const copyAssets = async () => {
    const selected = data.assets.filter((asset) => selectedAssetIds.includes(asset.id));
    if (!selected.length) return;
    const now = stamp();
    const assets = [...data.assets];
    const batchId = selected.length > 1 ? `BATCH-${Date.now()}` : undefined;
    const changes: ChangeRecord[] = [];
    for (const asset of selected) {
      const copy: Asset = { ...asset, id: id(), name: `${asset.name} - 副本`, host: `${asset.host}-copy`, accounts: asset.accounts.map((account) => ({ ...account, id: id() })), disks: asset.disks.map((disk) => ({ ...disk, id: id() })), createdAt: now, updatedAt: now };
      let suffix = 2;
      while (assets.some((item) => item.systemId === copy.systemId && item.host.toLowerCase() === copy.host.toLowerCase())) copy.host = `${asset.host}-copy-${suffix++}`;
      assets.push(copy);
      changes.push(addHistory(copy.name, '新增', { assetId: copy.id, systemId: copy.systemId, objectType: 'asset', objectId: copy.id, source: batchId ? '批量' : '手动', batchId, note: `复制自 ${asset.host}`, after: copy, items: assetDiff(undefined, copy) }));
    }
    assertValidAssets(assets);
    await commit({ ...data, assets, history: [...changes, ...data.history] });
    messageApi.success(`已复制 ${selected.length} 台资产`);
  };

  const saveColumnSettings = async (settings: TableColumnSetting[]) => {
    await commit({ ...data, fieldDefs: applyFieldColumnSettings(data.fieldDefs, ledgerGroups, settings), settings: { ...data.settings, tableColumns: settings } });
    if (stageRef.current !== 'ready') return;
    setColumnSettingsOpen(false);
  };

  const batchDeleteAssets = async () => {
    const selected = data.assets.filter((asset) => selectedAssetIds.includes(asset.id));
    if (!selected.length) return;
    if (data.settings.backupBeforeWrite && native.desktop) {
      try { await native.createBackup('pre-batch'); }
      catch (reason) { messageApi.error(`删除前备份失败：${reason instanceof Error ? reason.message : String(reason)}`); return; }
    }
    const batchId = `BATCH-${Date.now()}`;
    const changes = selected.map((asset) => addHistory(asset.name, '删除', { assetId: asset.id, systemId: asset.systemId, objectType: 'asset', objectId: asset.id, source: '批量', batchId, before: asset, items: assetDiff(asset, undefined) }));
    const selectedIds = new Set(selectedAssetIds);
    await commit({ ...data, assets: data.assets.filter((asset) => !selectedIds.has(asset.id)), history: [...changes, ...data.history] });
    setSelectedAssetIds([]);
    messageApi.success(`已将 ${selected.length} 台资产删除`);
  };

  const batchEditAssets = async (values: { operation: 'status' | 'system' | 'replace'; status?: AssetStatus; systemId?: string; field?: 'name' | 'host' | 'ip' | 'os'; find?: string; replace?: string }) => {
    const session = batchSession.current;
    const selectedIds = new Set(selectedAssetIds);
    const batchId = `BATCH-${Date.now()}`;
    const changes: ChangeRecord[] = [];
    const assets = data.assets.map((asset) => {
      if (!selectedIds.has(asset.id)) return asset;
      let next: Asset = { ...asset, updatedAt: stamp() };
      if (values.operation === 'status' && values.status) next.status = values.status;
      if (values.operation === 'system' && values.systemId) {
        const owner = systemOptions.find((item) => item.system.id === values.systemId);
        if (!owner) throw new Error('目标系统不存在');
        next = { ...next, unitId: owner.unit.id, environmentId: owner.environment.id, zoneId: owner.zone.id, systemId: owner.system.id };
      }
      if (values.operation === 'replace' && values.field && values.find) {
        next = { ...next, [values.field]: String(asset[values.field] ?? '').split(values.find).join(values.replace ?? '') };
      }
      const items = assetDiff(asset, next);
      if (items.length) changes.push(addHistory(next.name, '编辑', { assetId: next.id, systemId: next.systemId, objectType: 'asset', objectId: next.id, source: '批量', batchId, before: asset, after: next, items }));
      return items.length ? next : asset;
    });
    assertValidAssets(assets);
    if (!changes.length) { messageApi.info('所选资产没有发生变化'); if (session === batchSession.current) setBatchOpen(false); return; }
    if (data.settings.backupBeforeWrite && native.desktop) await native.createBackup('pre-batch');
    await commit({ ...data, assets, history: [...changes, ...data.history] }, false, false);
    if (session === batchSession.current) { setBatchOpen(false); batchForm.resetFields(); }
    messageApi.success(`已批量更新 ${changes.length} 台资产`);
  };

  const handleFieldsChange = async (next: VaultData, options?: { orderOnly?: boolean }) => {
    if (options?.orderOnly) { await commit(next); return; }
    if (data.settings.backupBeforeWrite && native.desktop) await native.createBackup('pre-schema');
    let changedSystem: string | undefined;
    if (next.fieldDefs !== data.fieldDefs) {
      const previous = new Map(data.fieldDefs.map(field => [field.id, field]));
      changedSystem = next.fieldDefs.find(field => {
        const current = previous.get(field.id);
        return current !== field && (!current || JSON.stringify(current) !== JSON.stringify(field));
      })?.systemId;
      if (!changedSystem) {
        const remaining = new Set(next.fieldDefs.map(field => field.id));
        changedSystem = data.fieldDefs.find(field => !remaining.has(field.id))?.systemId;
      }
    }
    changedSystem ??= activeSystem ?? undefined;
    await commit({ ...next, history: [addHistory('字段定义', '编辑', { objectType: 'system', objectId: changedSystem, systemId: changedSystem, note: '字段定义或模板已更新' }), ...next.history] });
  };

  const rollbackChange = async (record: ChangeRecord) => {
    const before = record.before as Asset | undefined;
    const after = record.after as Asset | undefined;
    if (!record.assetId && !before?.id && !after?.id) { messageApi.info('该记录没有可回滚的资产快照'); return; }
    const assetId = record.assetId ?? before?.id ?? after!.id;
    const current = data.assets.find((asset) => asset.id === assetId);
    if (!sameAssetSnapshot(current, after, data)) { messageApi.error('该资产在此记录之后又发生了变化，不能直接回滚旧快照'); return; }
    let assets = data.assets.filter((asset) => asset.id !== assetId);
    if (before) assets = [...assets, { ...before, updatedAt: stamp() }];
    assertValidAssets(assets);
    const inverse = addHistory(record.assetName, '回滚', { assetId, systemId: record.systemId, objectType: 'asset', objectId: assetId, source: '回滚', batchId: record.batchId, before: after, after: before, items: (record.items ?? []).map((item) => ({ ...item, before: item.after, after: item.before })), note: `回滚变更 ${record.id}` });
    await commit({ ...data, assets, history: [inverse, ...data.history] });
    messageApi.success('已生成反向变更并完成回滚');
  };

  const rollbackChangeItem = async (record: ChangeRecord, item: ChangeItem) => {
    if (!record.assetId) { messageApi.info('该记录没有可回滚的资产'); return; }
    const current = data.assets.find((asset) => asset.id === record.assetId);
    if (!current) { messageApi.error('该资产当前不在台账中'); return; }
    const matches = sameAssetSnapshot(current, { ...current, [item.fieldKey]: item.after } as Asset, data);
    if (!matches) {
      messageApi.error(`“${item.fieldLabel || item.fieldKey}”在此记录之后又发生了变化，不能直接回滚`);
      return;
    }
    let next = { ...current, [item.fieldKey]: item.before, updatedAt: stamp() } as Asset;
    if (item.fieldKey === 'systemId') {
      const owner = systemOptions.find((option) => option.system.id === item.before);
      if (!owner) { messageApi.error('原系统已不存在，无法回滚'); return; }
      next = { ...next, unitId: owner.unit.id, environmentId: owner.environment.id, zoneId: owner.zone.id };
    }
    assertValidAssets(data.assets.map((asset) => asset.id === next.id ? next : asset));
    const inverse = addHistory(next.name, '回滚', {
      assetId: next.id,
      systemId: next.systemId,
      objectType: 'asset',
      objectId: next.id,
      source: '回滚',
      before: current,
      after: next,
      items: [{ ...item, before: item.after, after: item.before }],
      note: `单字段回滚变更 ${record.id}`,
    });
    await commit({ ...data, assets: data.assets.map((asset) => asset.id === next.id ? next : asset), history: [inverse, ...data.history] });
    messageApi.success(`已回滚字段“${item.fieldLabel || item.fieldKey}”`);
  };

  const rollbackBatch = async (batchId: string) => {
    const records = data.history.filter((record) => record.batchId === batchId && record.action !== '回滚' && record.assetId);
    if (!records.length) { messageApi.info('该批次没有可回滚的资产变更'); return false; }
    const stale = records.find((record) => {
      const current = data.assets.find((asset) => asset.id === record.assetId);
      return !sameAssetSnapshot(current, record.after as Asset | undefined, data);
    });
    if (stale) { messageApi.error(`无法整批回滚：${stale.assetName} 在该批次后又发生了变化`); return false; }
    let assets = [...data.assets];
    const rollbackBatchId = `RB-${batchId}-${Date.now()}`;
    const inverse: ChangeRecord[] = [];
    for (const record of records) {
      const before = record.before as Asset | undefined;
      const after = record.after as Asset | undefined;
      assets = assets.filter((asset) => asset.id !== record.assetId);
      if (before) assets.push({ ...before, updatedAt: stamp() });
      inverse.push(addHistory(record.assetName, '回滚', {
        assetId: record.assetId,
        systemId: record.systemId,
        objectType: 'asset',
        objectId: record.assetId,
        source: '回滚',
        batchId: rollbackBatchId,
        before: after,
        after: before,
        items: (record.items ?? []).map((item) => ({ ...item, before: item.after, after: item.before })),
        note: `整批回滚 ${batchId}`,
      }));
    }
    assertValidAssets(assets);
    if (data.settings.backupBeforeWrite && native.desktop) await native.createBackup('pre-batch-rollback');
    await commit({ ...data, assets, history: [...inverse, ...data.history] });
    messageApi.success(`已回滚批次 ${batchId}，共 ${records.length} 条资产变更`);
    return true;
  };

  const parseImport = async (file: File, options: ImportOptions = {}): Promise<ImportPreview> => {
    const parsed = await native.parseImport(file, options.columnMapping, options.sheetColumnMapping);
    return previewImport(data, parsed, options);
  };
  const importRows = async (selection: ImportSelection, batchId: string) => {
    await importAssets(session, data, selection, batchId, data.settings.backupBeforeWrite && native.desktop ? () => native.createBackup('pre-import') : undefined);
  };

  const exportAssets = async (request: ExportRequest) => {
    const result = await native.exportAssets(data, {
      scope: request.scope === 'project' ? 'all' : request.scope,
      unitId: request.unitId ?? undefined, systemId: request.systemId ?? undefined, assetIds: request.selectedIds,
      includePasswords: request.options.includePlaintextPasswords,
      includeFieldDescriptions: request.options.includeFieldDefinitions, includeHistory: request.options.includeHistory,
    });
    return typeof result === 'string' ? result : result.path;
  };

  const searchItems = useMemo<SearchItem[]>(() => {
    const items: SearchItem[] = [];
    const assetCounts = new Map<string, number>();
    for (const asset of data.assets) assetCounts.set(asset.systemId, (assetCounts.get(asset.systemId) ?? 0) + 1);
    const systemOwners = new Map<string, (typeof systemOptions)[number]>();
    for (const option of systemOptions) if (!systemOwners.has(option.system.id)) systemOwners.set(option.system.id, option);
    for (const unit of data.units) {
      items.push({ id: unit.id, type: '单位', name: unit.name, meta: `${unit.environments.length} 个环境`, page: 'ledger', targetId: unit.id, searchText: unit.name });
      for (const environment of unit.environments) {
        for (const zone of environment.zones) {
          for (const system of zone.systems) {
            items.push({ id: system.id, type: '系统', name: system.name, meta: `${[unit.name, environment.name, zone.name].filter(Boolean).join(' / ')} · ${assetCounts.get(system.id) ?? 0} 台服务器`, page: 'ledger', targetId: system.id, searchText: `${unit.name} ${environment.name} ${zone.name} ${system.name}` });
          }
        }
      }
    }
    for (const asset of data.assets) {
      const owner = systemOwners.get(asset.systemId);
      const organization = owner ? [owner.unit.name, owner.environment.name, owner.zone.name, owner.system.name].filter(Boolean).join(' / ') : '未绑定系统';
      items.push({ id: asset.id, type: '服务器', name: asset.name, meta: organization, detail: [asset.host, asset.ip, asset.ip2, asset.os, asset.status].filter(Boolean).join(' · '), page: 'ledger', targetId: asset.id, searchText: `${asset.name} ${organization} ${asset.host} ${asset.ip} ${asset.ip2} ${asset.os} ${asset.accounts.map((account) => account.username).join(' ')} ${(asset.tags ?? []).join(' ')}`, ipText: `${asset.ip} ${asset.ip2}`, tagText: (asset.tags ?? []).join(' ') });
    }
    for (const field of data.fieldDefs) items.push({ id: field.id, type: '字段', name: `${field.label} (${field.key})`, meta: field.type, page: 'fields', targetId: field.systemId, searchText: `${field.label} ${field.key} ${field.type}` });
    for (const [idValue, name, meta, pageValue] of [['security', '启动与安全', '自动锁屏、主密码', 'settings'], ['backup', '自动备份留存策略', '最近、每日、每周、每月、每年、定时备份 crontab', 'backup']] as const) items.push({ id: idValue, type: '设置', name, meta, page: pageValue, searchText: `${name} ${meta}` });
    for (const entry of data.reports.entries) items.push({ id: entry.id, type: '工作记录', name: entry.text.slice(0, 80), meta: `${entry.scopeName} · ${entry.section}`, page: 'reports', targetId: entry.id, searchText: `${entry.text} ${entry.at}` });
    for (const report of data.reports.reports) items.push({ id: report.id, type: '报告', name: report.title, meta: `${report.start} 至 ${report.end}`, page: 'reports', targetId: report.id, searchText: report.markdown });
    const opsScopes = operationScopes(data.units);
    const opsByValue = new Map<string, (typeof opsScopes)[number]>();
    const opsBySystem = new Map<string, (typeof opsScopes)[number]>();
    for (const node of opsScopes) {
      if (!opsByValue.has(node.value)) opsByValue.set(node.value, node);
      if (node.scope.systemId && !opsBySystem.has(node.scope.systemId)) opsBySystem.set(node.scope.systemId, node);
    }
    for (const system of data.opsSystems) {
      const key = system.systemId ? opsBySystem.get(system.systemId)?.value : scopeValue(system);
      items.push({ id: system.id, type: '系统运维', name: (key ? opsByValue.get(key)?.path : undefined) ?? system.scopeName, meta: '', page: 'operations', targetId: system.id, searchText: system.markdown });
    }
    return items;
  }, [data.units, data.assets, data.fieldDefs, data.reports.entries, data.reports.reports, data.opsSystems, systemOptions]);

  const openSearchItem = (item: SearchItem) => {
    pendingDetailEditRef.current = null;
    setPage(item.page); setSearchOpen(false);
    if (item.page === 'reports') setReportFocusId(item.targetId);
    if (item.page === 'operations') setOpsFocusId(item.targetId);
    if (item.type === '字段') setFieldsSystemId(item.targetId ?? null);
    if (item.page === 'ledger') setMaintenanceOnly(false);
    if (!data.settings.preserveSearch) setQuery('');
    if (item.type === '单位') { setActiveUnit(item.targetId ?? null); setActiveEnvironment(null); setActiveZone(null); setActiveSystem(null); }
    if (item.type === '系统' || item.type === '字段') { const option = systemOptions.find((entry) => entry.system.id === item.targetId); setActiveUnit(option?.unit.id ?? null); setActiveEnvironment(option?.environment.id ?? null); setActiveZone(option?.zone.id ?? null); setActiveSystem(item.targetId ?? null); }
    if (item.type === '服务器') { const asset = data.assets.find((entry) => entry.id === item.targetId); if (asset) { assetTrigger.current = document.querySelector<HTMLElement>('.search-trigger'); setActiveUnit(asset.unitId); setActiveEnvironment(asset.environmentId); setActiveZone(asset.zoneId); setActiveSystem(asset.systemId); setDetailClosing(false); setDetailAsset(asset); } }
  };

  const insertWorkRecord = async (input: QuickEntryInput) => {
    if (stageRef.current !== 'ready') throw new Error('请先解锁工作台');
    if (quickInsertBusy.current) throw new Error('工作记录正在保存');
    quickInsertBusy.current = true;
    try {
      const current = dataRef.current;
      const entry = quickEntry(input, current.units);
      await commit({ ...current, reports: { ...current.reports, entries: [entry, ...current.reports.entries] } });
    } finally { quickInsertBusy.current = false; }
  };
  searchSnapshotRef.current = { units: stage === 'ready' ? data.units : [], items: stage === 'ready' ? searchItems : [], query, theme: activeTheme, hotkey: data.settings.searchHotkey, request: searchRequestRef.current };
  const openSearchHome = () => {
    if (stageRef.current !== 'ready' || !detachedSearchRef.current) return;
    pendingDetailEditRef.current = null;
    setPage('home'); setSearchOpen(false); setDetailAsset(null); setDetailClosing(false);
    setAssetOpen(false); setEditingAsset(null); setStructureOpen(false); setStructureTarget(null);
    setColumnSettingsOpen(false); setBatchOpen(false); setBatchDeleteOpen(false); setFilterOpen(false);
    void native.closeSearchWindow().then(() => native.showMainWindow()).catch(windowError);
  };
  const [searchInsertCache] = useState(() => new SearchInsertCache());
  searchActionsRef.current = {
    openHome: openSearchHome,
    insert: async (input) => {
      if (!input || typeof input.token !== 'string' || input.token.length > 64 || !Number.isSafeInteger(input.request)) return;
      let error: string | undefined;
      try {
        if (stageRef.current !== 'ready' || !detachedSearchRef.current || input.request !== searchRequestRef.current) throw new Error('搜索会话已过期，请重新唤起');
        if (typeof input.token !== 'string' || !input.token) throw new Error('搜索保存请求无效');
        error = await searchInsertCache.run(input.request, input.token, Boolean(input.statusOnly), () => insertWorkRecord(input));
      } catch (reason) { error = reason instanceof Error ? reason.message : String(reason); }
      await emitTo('search', 'assetops-search-insert-result', { request: input.request, token: input.token, error }).catch(() => undefined);
    },
    openItem: (target) => {
      if (stageRef.current !== 'ready' || !detachedSearchRef.current) return;
      const item = searchItems.find((entry) => entry.id === target.id && entry.type === target.type);
      if (!item) return;
      openSearchItem(item);
      void native.closeSearchWindow().then(() => native.showMainWindow()).catch(windowError);
    },
  };
  useEffect(publishSearch, [searchItems, data.units, activeTheme, data.settings.searchHotkey, stage, publishSearch]);
  const openHistory = (asset?: { id: string; name: string }) => { assetTrigger.current = null; pendingDetailEditRef.current = null; setHistoryAsset(asset ?? null); setDetailAsset(null); setDetailClosing(false); setPage('history'); };
  const latestBackup = useMemo(() => [...backups].sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0], [backups]);

  const selectedOption = systemOptions.find((item) => item.system.id === activeSystem);
  const selectedSystem = selectedOption?.system;

  const copyPassword = useCallback(async (asset: Asset) => {
    const account = selectedAccount(asset, activeAccount[asset.id]);
    const password = account?.password;
    if (!password) { messageApi.info('该资产还没有录入密码'); return; }
    try { await navigator.clipboard.writeText(password); messageApi.success('密码已复制到剪贴板'); }
    catch { messageApi.error('当前环境不支持复制，请在桌面应用中使用'); }
  }, [activeAccount, messageApi]);

  const copyFieldValue = useCallback(async (text: string, label: string) => {
    try { await navigator.clipboard.writeText(text); messageApi.success(`${label}已复制到剪贴板`); }
    catch { messageApi.error('当前环境不支持复制，请在桌面应用中使用'); }
  }, [messageApi]);

  const handleLedgerTableChange = useCallback<NonNullable<TableProps<Asset>['onChange']>>((pagination, _filters, sorter) => {
    setLedgerPage(pagination.current ?? 1);
    setTablePageSize(pagination.pageSize ?? 25);
    const active = Array.isArray(sorter) ? sorter[0] : sorter;
    setTableSort(active.order && active.columnKey ? { field: String(active.columnKey), order: active.order } : undefined);
  }, [setTablePageSize]);

  const ledgerDay = today();
  const baseColumns = useMemo<ColumnsType<Asset>>(() => {
    const businessSystemLabel = (asset: Asset) => asset.businessSystem ? [data.units.find((unit) => unit.id === asset.unitId)?.name, asset.businessSystem].filter(Boolean).join('/') : '';
    return [
      { title: '业务系统', key: 'businessSystem', sorter: (a, b) => businessSystemLabel(a).localeCompare(businessSystemLabel(b), 'zh-CN'), render: (_, asset) => businessSystemLabel(asset) || <Text type="secondary">—</Text> },
      { title: '服务器名称', dataIndex: 'name', key: 'name', fixed: 'left', sorter: (a, b) => a.name.localeCompare(b.name, 'zh-CN'), render: (value: string, asset) => <div className="asset-name-cell"><b>{value}</b><span>{asset.host}</span></div> },
      { title: '主机名', dataIndex: 'host', key: 'host', fixed: 'left', sorter: (a, b) => a.host.localeCompare(b.host, 'zh-CN'), render: (value: string) => value || <Text type="secondary">—</Text> },
      { title: 'IP', dataIndex: 'ip', key: 'ip', sorter: (a, b) => a.ip.localeCompare(b.ip), render: (value: string) => value || <Text type="secondary">—</Text> },
      { title: '备用 IP', dataIndex: 'ip2', key: 'ip2', render: (value: string) => value || <Text type="secondary">—</Text> },
      { title: '状态', dataIndex: 'status', key: 'status', render: (value: AssetStatus) => <Tag color={statusColors[value]} bordered={false}>{value}</Tag> },
      { title: 'CPU', dataIndex: 'cpu', key: 'cpu', sorter: (a, b) => (a.cpu ?? 0) - (b.cpu ?? 0), render: (value: number | null) => value === null ? '—' : `${value} 核` },
      { title: '内存', dataIndex: 'memory', key: 'memory', sorter: (a, b) => (a.memory ?? 0) - (b.memory ?? 0), render: (value: number | null) => value === null ? '—' : `${value} G` },
      { title: '标签', dataIndex: 'tags', key: 'tags', render: (tags: string[]) => tags.length ? <Space wrap size={4}>{tags.map((tag, index) => <Tag key={`${tag}-${index}`}>{tag}</Tag>)}</Space> : <Text type="secondary">—</Text> },
      { title: '硬盘', dataIndex: 'disks', key: 'disks', render: (disks: Asset['disks']) => <DiskTagRows disks={disks} /> },
      { title: '操作系统', dataIndex: 'os', key: 'os', render: (value: string) => value || <Text type="secondary">—</Text> },
      { title: '账号', dataIndex: 'accounts', key: 'accounts', render: (accounts: Account[], asset) => accounts.length > 1 ? <span className="account-multi" title={`${accounts.length} 个账号`}><Select className="account-select" size="small" variant="borderless" value={accounts.find((account) => account.id === activeAccount[asset.id])?.id ?? accounts[0].id} options={accounts.map((account) => ({ value: account.id, label: account.username }))} onChange={(accountId) => setActiveAccount((current) => ({ ...current, [asset.id]: accountId }))} /></span> : accounts.length ? accounts[0].username : <Text type="secondary">—</Text> },
      { title: '密码', key: 'password', render: (_, asset) => { const account = selectedAccount(asset, activeAccount[asset.id]); return <Text>{data.settings.showPlainPassword ? (account?.password || '—') : account?.password ? '••••••••' : '—'}</Text>; } },
      { title: '定期修改密码', key: 'pwdRotate', render: (_, asset) => asset.rotatePassword ? <Tag color="blue" bordered={false}>是</Tag> : <Text type="secondary">否</Text> },
      { title: '密码更新周期', key: 'pwdCycle', render: (_, asset) => asset.rotatePassword && asset.passwordCycleDays ? `${asset.passwordCycleDays} 天` : <Text type="secondary">—</Text> },
      { title: '密码更新期限', key: 'passwordExpiry', render: (_, asset) => { const account = selectedAccount(asset, activeAccount[asset.id]); const date = account ? accountExpiryDate(asset, account) : null; if (!date) return <Text type="secondary">—</Text>; const days = remainingDays(date); return <Tag color={days < 0 ? 'red' : days <= 3 ? 'volcano' : days <= data.settings.passwordWarningDays ? 'gold' : 'green'} bordered={false}>{passwordLabel(date)}</Tag>; } },
      { title: '修改日期', dataIndex: 'updatedAt', key: 'updatedAt', sorter: (a, b) => a.updatedAt.localeCompare(b.updatedAt), render: (value: string) => dateText(value) },
      { title: '创建日期', dataIndex: 'createdAt', key: 'createdAt', sorter: (a, b) => a.createdAt.localeCompare(b.createdAt), render: (value: string) => dateText(value) },
      { title: <div className="ledger-actions-viewport"><div className="ledger-actions-surface"><div className="ledger-actions-content">操作</div></div></div>, key: 'actions', fixed: 'right', width: '0px', className: `ledger-actions-cell${actionsCollapsed ? ' is-closing' : ' is-opening'}`, onHeaderCell: () => ({ onAnimationEnd: (event) => { if ((event.target as HTMLElement).classList.contains('ledger-actions-surface') && event.animationName === 'actions-close' && actionsCollapsed) setActionsPresent(false); } }), render: (_, asset) => <div className="ledger-actions-viewport"><div className="ledger-actions-surface"><div className="ledger-actions-content"><Space size={0}><Button type="text" size="small" icon={<EyeOutlined />} onClick={event => { assetTrigger.current = event.currentTarget; setDetailAsset(asset); }}>详情</Button><Button type="text" size="small" icon={<EditOutlined />} onClick={() => openEditAsset(asset)}>编辑</Button></Space></div></div></div> },
    ];
  }, [data.units, data.settings.showPlainPassword, data.settings.passwordWarningDays, activeAccount, actionsCollapsed, openEditAsset, ledgerDay]);
  const { shownColumns, availableColumns } = useMemo(() => {
    const groupByKey = new Map(ledgerGroups.map(group => [group.key, group]));
    const schemaColumns: ColumnsType<Asset> = ledgerGroups.map(group => {
      const base = baseColumns.find(column => column.key === group.baseKey);
      return { ...base, title: group.field.label, key: group.key, dataIndex: undefined,
        sorter: base?.sorter ? (a, b) => String(ledgerFieldValue(group, a) ?? '').localeCompare(String(ledgerFieldValue(group, b) ?? ''), 'zh-CN', { numeric: true }) : undefined,
        render: (_, asset, index) => {
          if (!group.systemIds.has(asset.systemId)) return <Text type="secondary">—</Text>;
          if (base?.render) { const dataIndex = 'dataIndex' in base ? base.dataIndex : undefined; return base.render(dataIndex ? (asset as unknown as Record<string, unknown>)[String(dataIndex)] : undefined, asset, index); }
          const value = ledgerFieldValue(group, asset);
          return group.field.type === 'password' && !data.settings.showPlainPassword ? (value ? '••••••••' : '—') : typeof value === 'object' && value !== null ? JSON.stringify(value) : String(value ?? '—');
        } };
    });
    const columns = [...schemaColumns, ...baseColumns.filter(column => column.key === 'actions' || (column.key === 'tags' && ledgerGroups.length > 0))]
      .map(column => {
        const key = String(column.key), group = groupByKey.get(key);
        const title = typeof column.title === 'string' && !group ? fieldLabel(key, column.title) : column.title;
        const result = { ...column, align: 'left' as const, title };
        if (!group?.quickCopySystemIds.size) return result;
        return { ...result, render: (value: unknown, asset: Asset, index: number) => {
          const content = column.render?.(value, asset, index) as React.ReactNode;
          if (!group.quickCopySystemIds.has(asset.systemId)) return content;
          const baseKey = group.baseKey;
          const account = selectedAccount(asset, activeAccount[asset.id]);
          const expiry = baseKey === 'passwordExpiry' && account ? accountExpiryDate(asset, account) : null;
          const text = ledgerCopyText(baseKey === 'accounts' ? account?.username : baseKey === 'password' ? account?.password : baseKey === 'passwordExpiry' ? expiry ? dateText(expiry.toISOString()) : '' : ledgerFieldValue(group, asset));
          const label = group.field.label;
          return <Space size={3}>{content}<Button type="text" size="small" icon={<CopyOutlined />} aria-label={`复制${label}`} title={`复制${label}`} disabled={!text} onClick={(event) => { event.stopPropagation(); if (baseKey === 'password') void copyPassword(asset); else void copyFieldValue(text, label); }} /></Space>;
        } };
      });
    const settingsByKey = new Map(columnSettings.map((item) => [item.key, item]));
    const shownColumns = columns
      .map((column, index) => {
        const group = groupByKey.get(String(column.key));
        const setting = settingsByKey.get(String(column.key)) ?? (group ? settingsByKey.get(group.baseKey) : undefined);
        return { ...column, fixed: column.key === 'actions' ? 'right' as const : setting ? setting.fixed : column.fixed,
          sortOrder: column.sorter ? (tableSort?.field === String(column.key) ? tableSort.order : null) : column.sortOrder,
          __order: column.key === 'actions' ? columns.length : setting?.sortOrder ?? index, __visible: column.key === 'actions' || (column.key === 'tags' ? Boolean(setting?.visible) : Boolean(group?.field.showInList)) };
      })
      .filter((column) => column.__visible && (column.key !== 'actions' || actionsPresent))
      .sort((left, right) => left.__order - right.__order)
      .map(({ __order: _order, __visible: _visible, ...column }, index) => column.key === 'actions' ? column : { ...column, render: (value: unknown, asset: Asset, rowIndex: number) => <div className="ledger-cell-block" style={{ width: `var(--ledger-column-${index}, max-content)` }}><div className="ledger-cell-content" data-ledger-column={index}>{(column.render ? column.render(value, asset, rowIndex) : value) as React.ReactNode}</div></div> });
    const defaults = new Map(defaultFields('').map(field => [field.key, field.showInList]));
    const availableColumns = columns.filter((column) => column.key).map((column) => { const group = groupByKey.get(String(column.key)); return { key: String(column.key), label: column.key === 'actions' ? '操作' : typeof column.title === 'string' ? column.title : String(column.key), fixed: column.fixed === 'left' || column.fixed === 'right' ? column.fixed : undefined, visible: column.key === 'actions' || (column.key === 'tags' ? Boolean(settingsByKey.get('tags')?.visible) : Boolean(group?.field.showInList)), defaultVisible: column.key === 'tags' ? false : group ? defaults.get(group.field.key) ?? group.field.showInList : true }; });
    return { shownColumns, availableColumns };
  }, [baseColumns, ledgerGroups, data.settings.showPlainPassword, columnSettings, tableSort, visibleColumns, actionsPresent, fieldLabel, activeAccount, copyPassword, copyFieldValue]);
  const selectedSystemHasAssets = useMemo(() => data.assets.some(asset => asset.systemId === activeSystem), [data.assets, activeSystem]);
  const currentLedgerPage = Math.min(ledgerPage, Math.max(1, Math.ceil(filteredAssets.length / tablePageSize)));
  const ledgerSummaryText = `总数 ${data.assets.length} · 已筛选 ${filteredAssets.length} · 已选择 ${selectedAssetIds.length} 台`;
  const ledgerHasColumns = Boolean(activeUnit) && (!data.settings.ledgerOnlySystem || Boolean(activeSystem)) && shownColumns.some(column => column.key !== 'actions');
  const ledgerTable = useMemo(() => <Table<Asset> className="ledger-table" rowKey="id" size="middle" columns={ledgerHasColumns ? shownColumns : []} dataSource={filteredAssets} showHeader={ledgerHasColumns} loading={{ spinning: ledgerSaving, delay: 150 }} rowSelection={filteredAssets.length ? { selectedRowKeys: selectedAssetIds, onChange: (keys) => setSelectedAssetIds(keys.map(String)) } : undefined} tableLayout="auto" scroll={{ x: ledgerHasColumns ? 'max-content' : undefined, y: tableBodyHeight }} pagination={{ current: currentLedgerPage, pageSize: tablePageSize, position: [] }} onChange={handleLedgerTableChange} locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={!activeUnit ? '请选择左侧组织目录' : data.settings.ledgerOnlySystem && !activeSystem ? '请选择具体系统查看资产' : activeSystem && !selectedSystemHasAssets ? ledgerGroups.length ? '当前系统还没有资产' : '当前系统尚未配置字段，请导入字段模板' : data.assets.length ? '没有匹配的服务器' : '当前目录还没有服务器'}>{activeSystem && !selectedSystemHasAssets && <Button type="link" onClick={() => openSystemFields(activeSystem)}>导入字段模板</Button>}{!data.assets.length && ledgerGroups.length > 0 && <Button type="primary" icon={<PlusOutlined />} onClick={openNewAsset}>新增第一台资产</Button>}</Empty> }} />, [ledgerHasColumns, shownColumns, filteredAssets, ledgerSaving, selectedAssetIds, tableBodyHeight, tablePageSize, currentLedgerPage, handleLedgerTableChange, data.assets.length, activeUnit, activeSystem, selectedSystemHasAssets, ledgerGroups.length, data.settings.ledgerOnlySystem, openNewAsset, openSystemFields]);
  useLayoutEffect(() => {
    if (page !== 'ledger' || stage !== 'ready') return;
    const panel = tablePanelRef.current;
    if (!panel) return;
    const contents = [...panel.querySelectorAll<HTMLElement>('.ledger-table tr[data-row-key] .ledger-cell-content')];
    const align = () => {
      if (!panel.getClientRects().length) return;
      const widths = new Map<string, number>();
      for (const content of contents) {
        const column = content.dataset.ledgerColumn!;
        widths.set(column, Math.max(widths.get(column) ?? 0, Math.ceil(content.getBoundingClientRect().width)));
      }
      for (const [column, width] of widths) {
        const property = `--ledger-column-${column}`, value = `${width}px`;
        if (panel.style.getPropertyValue(property) !== value) panel.style.setProperty(property, value);
      }
    };
    const observer = new ResizeObserver(align);
    contents.forEach(content => observer.observe(content));
    align();
    return () => observer.disconnect();
  }, [ledgerTable, page, stage, pageRevisions]);
  const passwordLabel = (date: Date) => {
    const days = remainingDays(date);
    return days < 0 ? `已逾期 ${Math.abs(days)} 天` : `剩余 ${days} 天`;
  };

  if (stage === 'checking') return <><WindowTitlebar onError={windowError} /><div className="boot-screen"><span className="brand-mark brand-image"><img src={brandIcon} alt="" /></span><span>正在打开本地数据…</span></div></>;
  if (stage === 'error') return <ConfigProvider locale={zhCN} theme={appTheme} wave={disabledWave}>{contextHolder}{modalContext}<WindowTitlebar onError={windowError} />
    <div className="gate-page"><Card className="gate-card gate-error-card" bordered={false}>
      <div className="gate-icon"><DatabaseOutlined /></div>
      <Title level={3}>无法读取本地数据仓库</Title>
      <Text type="secondary">数据没有被初始化或覆盖。请检查数据目录权限后重试。</Text>
      <Alert className="gate-error" type="error" showIcon message={checkError || '读取本地数据仓库失败'} />
      <Button type="primary" size="large" block loading={false} onClick={() => void session.check()}>重新检查</Button>
      <Button block onClick={async () => { try { await navigator.clipboard.writeText(`仓库读取失败：${checkError || '未知读取错误'}`); messageApi.success('诊断信息已复制'); } catch { messageApi.warning('复制失败，请重试'); } }}>复制诊断信息</Button>
    </Card></div>
  </ConfigProvider>;
  if (stage === 'setup' || stage === 'unlock') return <ConfigProvider locale={zhCN} theme={appTheme} wave={disabledWave}>{contextHolder}{modalContext}<WindowTitlebar onError={windowError} />{lockPending || lockError ? <div className="gate"><Alert type={lockError ? 'error' : 'info'} showIcon message={lockError || '正在确认原生锁定…'} action={lockError && <Button onClick={() => void session.lock().catch(windowError)}>重试锁定</Button>} /></div> : <Gate setup={stage === 'setup'} brandIcon={brandIcon} onUnlock={enter} />}</ConfigProvider>;

  return <ConfigProvider locale={zhCN} theme={appTheme} wave={disabledWave}>
    {contextHolder}
    {modalContext}
    <WorkbenchLayout storedCollapsed={data.settings.sidebarCollapsed} saving={saving} page={page} brandIcon={brandIcon}
      items={nav.map((item) => ({ key: item.key, label: item.label, icon: item.icon, 'aria-label': item.label }))} onNavigate={(selected) => { if (selected === 'history') setHistoryAsset(null); setPage(selected); }} onCollapsedChange={changeSidebar} onWindowError={windowError}>
        <SearchToolbar page={page} open={searchOpen}>
          <div className="top-actions">
            <GlobalSearch items={searchItems} units={data.units} onInsert={insertWorkRecord} open={searchOpen} query={query} hotkey={data.settings.searchHotkey} focusRequest={searchFocusRequest} instant={searchInstant} onOpen={(pointer) => requestSearch(false, false, undefined, pointer)} onQueryChange={setQuery} onClose={() => { setSearchOpen(false); if (!data.settings.preserveSearch) setQuery(''); }} onOpenItem={openSearchItem} />
          </div>
        </SearchToolbar>

        <Content className={`content-area${page === 'ledger' ? ' ledger-content' : ''}`}>
          {openPages.map((tabPage) => <div key={`${tabPage}-${pageRevisions[tabPage] ?? 0}`} id={`page-${tabPage}`} role="region" aria-label={nav.find((item) => item.key === tabPage)?.label} className="app-tab-content" hidden={page !== tabPage}>
          {tabPage === 'home' && <DashboardPage visible={page === 'home'} data={data} onUnit={openUnitAssets} onOpenReports={openReportPage} onReportsChange={changeReports} />}

          {tabPage === 'ledger' && <div className="page-content ledger-page">
            <div className="page-heading ledger-heading"><div><Title level={2}>资产台账</Title></div></div>
            <div className={`ledger-workspace${ledgerDirectoryFloating ? ' has-floating-directory' : ''}`} data-organization-workspace="" onKeyDown={event => {
              if (event.key === 'Escape' && ledgerDirectoryOpen && !event.nativeEvent.isComposing && event.keyCode !== 229) {
                event.preventDefault(); event.stopPropagation(); setLedgerDirectoryOpen(false);
                event.currentTarget.querySelector<HTMLButtonElement>('.ledger-directory-toggle')?.focus();
              }
            }}>
              <div id="ledger-directory" className="ledger-directory" hidden={!ledgerDirectoryVisible}><OrgTreePanel active={page === 'ledger' && ledgerDirectoryVisible} commitPendingSelection={page === 'ledger'} data={data} activeUnit={activeUnit} activeEnvironment={activeEnvironment} activeZone={activeZone} activeSystem={activeSystem} revealPath={revealPath} onSelect={selectStructure} onManage={openStructureManage} onCreate={() => openStructureCreate()} onToggleDirectory={toggleLedgerDirectory} directoryCollapsed={ledgerDirectoryFloating} disabled={saving} transfer={<OrganizationTransfer active={page === 'ledger'} units={data.units} disabled={saving} onImport={importOrganization} />} /></div>
              <div className="table-panel-host" ref={tablePanelRef} style={{ '--ledger-body-height': `${tableBodyHeight}px` } as React.CSSProperties}><Card className="table-panel workspace-surface" bordered={false}>
                <div className="table-toolbar"><div className="ledger-scope-title">{ledgerDirectoryFloating && <Button ref={ledgerDirectoryToggle} className="ledger-directory-toggle" icon={<FolderOpenOutlined />} aria-controls="ledger-directory" aria-expanded={ledgerDirectoryOpen} aria-label={ledgerDirectoryOpen ? '收起组织目录' : '展开组织目录'} onClick={() => setLedgerDirectoryOpen(value => !value)}>目录</Button>}<span><b>{selectedSystem?.name ?? (activeUnit ? data.units.find(unit => unit.id === activeUnit)?.name : '请选择目录')}</b><Text type="secondary">{selectedOption ? ` · ${[selectedOption.environment.name, selectedOption.zone.name].filter(Boolean).join(' / ')}` : ''}</Text></span></div><Space wrap>{selectedAssetIds.length > 0 && <><Button onClick={() => { batchForm.setFieldsValue({ operation: 'status', status: '生产' }); batchSession.current++; setBatchOpen(true); }}>批量编辑（{selectedAssetIds.length}）</Button><Button icon={<CopyOutlined />} disabled={saving} onClick={() => { void copyAssets().catch((reason) => messageApi.error(reason instanceof Error ? reason.message : String(reason))); }}>复制所选</Button><Popconfirm open={batchDeleteOpen} onOpenChange={(open) => setBatchDeleteOpen(open && selectedAssetIds.length > 0)} title={`删除选中的 ${selectedAssetIds.length} 台资产？`} description="删除后可通过历史变更或备份恢复。" okText={batchDeleteLeft ? `删除（${batchDeleteLeft}）` : "删除"} cancelText="取消" okButtonProps={{ danger: true, disabled: batchDeleteLeft > 0 }} onConfirm={() => batchDeleteAssets().catch(() => undefined)}><Button danger disabled={saving}>批量删除</Button></Popconfirm></>}<Button type="primary" icon={<PlusOutlined />} onClick={openNewAsset}>新增资产</Button><Button icon={<SettingOutlined />} onClick={() => startTransition(() => setColumnSettingsOpen(true))}>列设置</Button><Popover classNames={{ root: 'field-filter-popover' }} open={filterOpen} onOpenChange={(open) => { setFilterOpen(open); if (open) { setStatusDraft(statusFilter); setFilterDraft(fieldFilters.length ? fieldFilters : [{ id: id(), key: defaultFilterKey, op: 'contains', value: '' }]); } }} trigger="click" placement="bottomRight" content={<div className="field-filter-panel"><div className="field-filter-status"><span>服务器状态</span><Select aria-label="筛选服务器状态" mode="multiple" placeholder="全部状态" value={statusDraft} options={statusList.map(value => ({ value, label: value }))} onChange={setStatusDraft} /></div>{filterDraft.map((item) => <div className="field-filter-row" key={item.id}><Select value={item.key} style={{ width: 128 }} options={filterableFields} onChange={(key) => setFilterDraft((current) => current.map((entry) => entry.id === item.id ? { ...entry, key } : entry))} /><Select value={item.op} style={{ width: 74 }} options={[{ value: 'contains', label: '包含' }, { value: 'equals', label: '等于' }]} onChange={(op) => setFilterDraft((current) => current.map((entry) => entry.id === item.id ? { ...entry, op: op as 'contains' | 'equals' } : entry))} /><Input value={item.value} placeholder="筛选值" style={{ width: 150 }} onChange={(event) => setFilterDraft((current) => current.map((entry) => entry.id === item.id ? { ...entry, value: event.target.value } : entry))} /><Button type="text" size="small" icon={<DeleteOutlined />} disabled={filterDraft.length <= 1} onClick={() => setFilterDraft((current) => current.filter((entry) => entry.id !== item.id))} /></div>)}<div className="field-filter-foot"><Button size="small" icon={<PlusOutlined />} onClick={() => setFilterDraft((current) => [...current, { id: id(), key: defaultFilterKey, op: 'contains', value: '' }])}>添加条件</Button><Space><Button size="small" onClick={() => { setStatusFilter([]); setFieldFilters([]); setMaintenanceOnly(false); setFilterOpen(false); }}>重置筛选</Button><Button size="small" type="primary" onClick={() => { setStatusFilter(statusDraft); setFieldFilters(filterDraft.filter((item) => item.value.trim())); setFilterOpen(false); }}>应用</Button></Space></div></div>}><Badge count={fieldFilters.length + statusFilter.length} size="small"><Button icon={<FilterOutlined />}>字段筛选</Button></Badge></Popover></Space><Button className="actions-toggle" type="text" size="small" aria-label={actionsCollapsed ? '展开操作列' : '收起操作列'} title={actionsCollapsed ? '展开操作列' : '收起操作列'} icon={actionsCollapsed ? <LeftOutlined /> : <RightOutlined />} onClick={() => { setActionsPresent(true); setActionsCollapsed((value) => !value); }} /></div>
                {ledgerTable}
                <div className="table-summary"><span><span className="ledger-summary-counts" title={ledgerSummaryText}>{ledgerSummaryText}</span>{maintenanceOnly && <Tag closable color="gold" onClose={() => setMaintenanceOnly(false)}>密码维护清单</Tag>}</span><Pagination className="ledger-table-pagination" size="small" simple={compactLedgerPagination} current={currentLedgerPage} pageSize={tablePageSize} total={filteredAssets.length} pageSizeOptions={[25, 50, 100]} showSizeChanger={{ ...pageSizeChanger, size: 'small' }} showTotal={compactLedgerPagination ? undefined : (count) => `共 ${count} 台服务器`} onChange={(current, size) => { setLedgerPage(current); setTablePageSize(size); tablePanelRef.current?.querySelector('.ant-table-body')?.scrollTo({ top: 0 }); }} /></div>
              </Card></div>
            </div>
          </div>}

          {tabPage === 'reports' && <ReportsPage active={page === 'reports'} data={data} focusId={reportFocusId} onFocusHandled={handleReportFocus} onChange={changeReports} />}
          {tabPage === 'operations' && <OperationsPage active={page === 'operations'} data={data} focusId={opsFocusId} onFocusHandled={handleOperationsFocus} onChange={changeOperations} onAsset={openOperationsAsset} onCreateDirectory={openStructureCreate} onManageDirectory={openStructureManage} directoryDisabled={saving} directoryTransfer={<OrganizationTransfer active={page === 'operations'} units={data.units} disabled={saving} onImport={importOrganization} />} />}
          {tabPage === 'fields' && <FieldsPage active={page === 'fields'} data={data} systemId={fieldsSystemId} onSystemChange={(systemId) => {
            setFieldsSystemId(systemId);
            const owner = systemOptions.find(option => option.system.id === systemId);
            selectStructure(owner?.unit.id ?? null, owner?.environment.id ?? null, owner?.zone.id ?? null, owner?.system.id ?? null);
          }} onChange={handleFieldsChange} />}
          {tabPage === 'import' && <ImportExportPage active={page === 'import'} data={data} activeSystemId={activeSystem} parseImport={parseImport} exportAssets={exportAssets} onImport={importRows} onRollbackBatch={rollbackBatch} onExportReport={(rows) => native.exportImportReport(rows)} onExportTemplate={native.exportTemplate} />}
          {tabPage === 'history' && <HistoryPage active={page === 'history'} data={data} session={session} assetFilter={historyAsset} onClearAssetFilter={() => setHistoryAsset(null)} onRollback={(record) => rollbackChange(record).catch(windowError)} onRollbackItem={(record, item) => rollbackChangeItem(record, item).catch(windowError)} onExport={async (includePasswords) => { try { const result = await native.exportAudit(includePasswords); messageApi.success({ content: <Space size={10}><span>审计表已导出：{result.path}</span><Button size="small" type="link" style={{ padding: 0 }} onClick={() => void native.revealInFolder(result.path)}>打开目录</Button></Space>, duration: 8 }); } catch (error) { throw new Error(`审计表导出失败：${error instanceof Error ? error.message : String(error)}`); } }} />}
          {tabPage === 'backup' && <BackupPage active={page === 'backup'} readReady={backupReadReady} readError={backupError} onRetry={refreshBackups} backups={backups} retentionPolicy={{ recent: data.settings.backupRetention.recent, daily: data.settings.backupRetention.daily, weekly: data.settings.backupRetention.weekly, monthly: data.settings.backupRetention.monthly, yearly: data.settings.backupRetention.yearly }} scheduledRetentionPolicy={data.settings.scheduledBackupRetention} nextScheduledAt={nextScheduledAt} loading={backupLoading} onBackupNow={async () => { const created = await native.createBackup('manual'); await refreshBackups(); return { id: created.fileName, fileName: created.fileName, kind: 'manual', sizeBytes: created.size, createdAt: created.createdAt, integrity: created.integrity === 'ok' ? 'valid' : 'invalid', path: created.path }; }} onRestore={restoreVault} onDelete={async (backupId) => { await native.deleteBackup(backupId); await refreshBackups(); }} onDeleteMany={async (ids) => { const failed: Array<{ id: string; error: string }> = []; try { for (const id of ids) { try { await native.deleteBackup(id); } catch (reason) { failed.push({ id, error: reason instanceof Error ? reason.message : String(reason) }); } } } finally { await refreshBackups(); } return failed; }} onSavePolicy={async (policy: BackupPagePolicy, scheduledPolicy: BackupPagePolicy) => { await commit({ ...data, settings: { ...data.settings, backupRetention: policy, scheduledBackupRetention: scheduledPolicy } }); }} onCleanup={async (policy, scheduledPolicy) => { const candidates = await native.simulateCleanup({ keepLast: policy.recent, keepDaily: policy.daily, keepWeekly: policy.weekly, keepMonthly: policy.monthly, keepYearly: policy.yearly }, { keepLast: scheduledPolicy.recent, keepDaily: scheduledPolicy.daily, keepWeekly: scheduledPolicy.weekly, keepMonthly: scheduledPolicy.monthly, keepYearly: scheduledPolicy.yearly }); let count = 0; try { for (const backup of candidates) { await native.deleteBackup(backup.fileName); count++; } return count; } finally { await refreshBackups(); } }} />}
          {tabPage === 'settings' && <SettingsPage active={page === 'settings'} snapshot={data} schedule={data.settings} onSaveSchedule={async (enabled, cron) => { await commit({ ...data, settings: { ...data.settings, scheduledBackup: enabled, scheduledBackupCron: validateBackupCron(cron) } }); }}  onSaveCalendarSources={saveCalendarSources} value={settingsToView(data.settings)} info={appInfo} infoError={appInfoError} infoLoading={appInfoLoading} onRetryInfo={refreshAppInfo} onChange={async (patch) => { if (patch.exportDirectory !== undefined) await native.validateExportDirectory(patch.exportDirectory); const latest = session.getSnapshot().data; const settings = settingsFromView(latest.settings, { ...settingsToView(latest.settings), ...patch }); await session.save(latest, { ...latest, settings }, true); if (patch.exportDirectory !== undefined) void refreshAppInfo(); }} onChangePassword={changeMasterPassword} onReinitialize={reinitializeVault} onBackupNow={async () => { const created = await native.createBackup('manual'); await refreshBackups(); messageApi.success(`已创建备份：${created.fileName}`); }} onChangeBackupDirectory={changeBackupDirectory} onOpenDataDirectory={() => native.openDataDirectory()} onOpenBackupDirectory={() => native.openBackupDirectory()} onOpenExportDirectory={() => native.openExportDirectory()} />}
          </div>)}
        </Content>
        <Modal title="提醒事项已到期" zIndex={1600} open={reminderNotice.length > 0} footer={<Space><Button onClick={() => { setPage('reports'); setReportFocusId('calendar'); setReminderNotice([]); }}>查看工作日历</Button><Button disabled={saving} onClick={() => { const ids = new Set(reminderNotice); void commit({ ...data, reports: { ...data.reports, calendar: { ...data.reports.calendar, tasks: snoozeReminders(data.reports.calendar.tasks ?? [], ids) } } }).then(() => setReminderNotice([])).catch(() => undefined); }}>10 分钟后提醒</Button><Button type="primary" disabled={saving} onClick={() => { const ids = new Set(reminderNotice); void commit({ ...data, reports: { ...data.reports, calendar: { ...data.reports.calendar, tasks: completeReminders(data.reports.calendar.tasks ?? [], ids) } } }).then(() => setReminderNotice([])).catch(() => undefined); }}>标记完成</Button></Space>} onCancel={() => setReminderNotice([])}>{(data.reports.calendar.tasks ?? []).filter((task) => reminderNotice.includes(task.id) && !task.completedAt).map((task) => <div key={task.id}><Typography.Title level={4}>{task.title}</Typography.Title><p>{chinaTime(task.dueAt)} · {task.note}</p></div>)}</Modal>
        <footer className="app-footer"><span className="footer-item"><DatabaseOutlined /> 数据库：{appInfo ? `${appInfo.databasePath.split(/[\\/]/).pop() ?? 'assets.db'} · ${formatBytes(appInfo.databaseSize)}` : appInfoLoading ? '读取中…' : '—'}</span><span className="footer-item">最近备份：{backupLoading ? '读取中…' : backupError ? '读取失败' : !backupReadReady ? '待读取' : latestBackup ? `${dateText(latestBackup.createdAt)}（${backupKindText[latestBackup.kind] ?? latestBackup.kind}）` : '暂无备份'}</span><span className="footer-spacer" /><span id="footer-storage-slot" className="footer-storage"><ModuleStorageFooter key={page} page={page} data={data} /></span><button className="footer-lock" title="点击锁定应用" aria-label="锁定应用" onClick={() => void lockApplication()}><UnlockOutlined /><span>已解锁</span></button><Tooltip title="刷新当前页面"><Button className="footer-refresh" type="text" size="small" icon={<ReloadOutlined />} aria-label="刷新当前页面" disabled={saving} onClick={() => { if (document.getElementById(`page-${page}`)?.querySelector('[data-exit-dirty="true"]')) { messageApi.warning("当前页面有未保存修改，请先保存后刷新"); return; } setFilterOpen(false); setPageRevisions((revisions) => ({ ...revisions, [page]: (revisions[page] ?? 0) + 1 })); void native.info().then(setAppInfo).catch(() => undefined); void refreshBackups(); messageApi.success('当前页面已刷新'); }} /></Tooltip><ThemeSwitcher value={data.settings.theme} disabled={saving} onChange={(theme) => commit({ ...data, settings: { ...data.settings, theme } })} /></footer>
    </WorkbenchLayout>

    {/* 详情与编辑共用一层遮罩，交接及离场期间保持模糊背景。 */}
    {(detailAsset || assetPresent) && createPortal(<div className="ant-modal-mask asset-overlay-mask" aria-hidden="true" onClick={() => { if (dialogSaving) return; if (assetOpen) setAssetOpen(false); else if (detailAsset) closeDetail(); }} />, document.body)}
    <Drawer title={detailAsset?.name ?? '资产详情'} width={620} open={Boolean(detailAsset) && !detailClosing} mask={false} onClose={closeDetail} afterOpenChange={finishDetailMotion} extra={detailAsset && <Button icon={<EditOutlined />} onClick={() => { pendingDetailEditRef.current = detailAsset; setDetailClosing(true); }}>编辑</Button>}>
      {detailAsset && <Space direction="vertical" size={18} className="full-width">
        <AssetDetailsFields asset={detailAsset} fields={data.fieldDefs} showPlainPassword={data.settings.showPlainPassword} onCopy={copyFieldValue} />
        <Card size="small" title="变更时间线" extra={<Button type="link" size="small" onClick={() => openHistory(detailAsset)}>查看历史变更</Button>}>
          {data.history.some((record) => record.assetId === detailAsset.id)
            ? <Timeline items={data.history.filter((record) => record.assetId === detailAsset.id).slice(0, 20).map((record) => ({
              color: record.action === '删除' ? 'red' : record.action === '恢复' ? 'green' : 'blue',
              children: <div><b>{record.action}</b><Text type="secondary"> · {dateText(record.at, true)}</Text><div>{(record.items ?? []).map((item) => item.fieldLabel || item.fieldKey).join('、') || record.source || '资产变更'}</div></div>,
            }))} />
            : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无变更记录" />}
        </Card>
      </Space>}
    </Drawer>
    <StructureManager target={structureTarget} data={data} onClose={() => setStructureTarget(null)} onRename={renameStructure} onDelete={deleteStructure} />
    <ColumnSettings open={columnSettingsOpen} columns={availableColumns} value={columnSettings} visibleKeys={visibleColumns} saving={saving} onClose={() => setColumnSettingsOpen(false)} onSave={saveColumnSettings} />
    <Modal title={`批量编辑 ${selectedAssetIds.length} 台资产`} open={batchOpen} okText="应用更改" cancelText="取消" confirmLoading={dialogSaving} closable={!dialogSaving} maskClosable={!dialogSaving} keyboard={!dialogSaving} cancelButtonProps={{ disabled: dialogSaving }} onCancel={event => { if (!dialogSaving && !composingCancel(event)) { batchSession.current++; setBatchOpen(false); } }} onOk={() => batchForm.submit()}>
      <Form disabled={dialogSaving} form={batchForm} layout="vertical" onFinish={(values) => void submitDialog(() => batchEditAssets(values))}>
        <Form.Item name="operation" label="操作" rules={[{ required: true }]}><Select options={[{ value: 'status', label: '设置运行状态' }, { value: 'system', label: '移动到其他系统' }, { value: 'replace', label: '查找并替换文本' }]} /></Form.Item>
        {batchOperation === 'status' && <Form.Item name="status" label="运行状态" rules={[{ required: true }]}><Select options={statusList.map((value) => ({ value, label: value }))} /></Form.Item>}
        {batchOperation === 'system' && <Form.Item name="systemId" label="目标系统" rules={[{ required: true }]}><OrganizationSelect units={data.units} level="systemId" /></Form.Item>}
        {batchOperation === 'replace' && <><Form.Item name="field" label="字段" rules={[{ required: true }]}><Select options={[{ value: 'name', label: '服务器名称' }, { value: 'host', label: '主机名' }, { value: 'ip', label: '主 IP' }, { value: 'os', label: '操作系统' }]} /></Form.Item><Form.Item name="find" label="查找内容" rules={[{ required: true, message: '查找内容不能为空' }]}><Input /></Form.Item><Form.Item name="replace" label="替换为"><Input /></Form.Item></>}
      </Form>
    </Modal>

    <Modal title={<span><ApartmentOutlined />　新建单位 / 环境 / 区域 / 系统</span>} open={structureOpen} onCancel={(event) => { if (!dialogSaving && !composingCancel(event)) { structureSession.current++; setStructureOpen(false); } }} onOk={() => structureForm.submit()} okText="保存结构" cancelText="取消" confirmLoading={dialogSaving} closable={!dialogSaving} maskClosable={!dialogSaving} keyboard={!dialogSaving} cancelButtonProps={{ disabled: dialogSaving }} destroyOnHidden>
      <div className="modal-intro">逐级选择已有上级，或切换为新建并填写名称；新系统的字段需在字段定义中导入模板并保存。</div>
      <Form disabled={dialogSaving} form={structureForm} layout="vertical" onFinish={(values) => void submitDialog(() => saveStructure(values))} initialValues={{ unitChoice: '__new__', envChoice: '__new__', zoneChoice: '__none__' }}>
        <Form.Item name="unitChoice" label="单位" rules={[{ required: true, message: '请选择单位' }]}>
          <OrganizationSelect units={data.units} level="unitId" options={[{ value: '__new__', label: '＋ 新建单位' }]} onChange={(value) => {
            const environment = data.units.find((unit) => unit.id === value)?.environments[0];
            structureForm.setFieldsValue({ unitName: undefined, envName: undefined, zoneName: undefined, envChoice: environment?.id ?? '__new__', zoneChoice: environment?.zones[0] ? (environment.zones[0].name ? environment.zones[0].id : '__none__') : '__none__' });
          }} />
        </Form.Item>
        {structureUnitChoice === '__new__' && <Form.Item name="unitName" label="新单位名称" rules={[{ required: true, whitespace: true, message: '请输入单位名称' }]}><Input maxLength={64} /></Form.Item>}
        <Form.Item name="envChoice" label="环境" rules={[{ required: true, message: '请选择环境' }]}>
          <OrganizationSelect units={data.units.filter((unit) => unit.id === structureUnitChoice)} level="environmentId" options={[{ value: '__new__', label: '＋ 新建环境' }]} onChange={(value) => {
            const environment = data.units.find((unit) => unit.id === structureUnitChoice)?.environments.find((item) => item.id === value);
            structureForm.setFieldsValue({ envName: undefined, zoneName: undefined, zoneChoice: environment?.zones[0] ? (environment.zones[0].name ? environment.zones[0].id : '__none__') : '__none__' });
          }} />
        </Form.Item>
        {structureEnvChoice === '__new__' && <Form.Item name="envName" label="新环境名称" rules={[{ required: true, whitespace: true, message: '请输入环境名称' }]}><Input maxLength={64} /></Form.Item>}
        <Form.Item name="zoneChoice" label="区域" rules={[{ required: true, message: '请选择区域' }]}>
          <OrganizationSelect units={data.units.filter((unit) => unit.id === structureUnitChoice).map((unit) => ({ ...unit, environments: unit.environments.filter((env) => env.id === structureEnvChoice) }))} level="zoneId" options={[{ value: '__none__', label: '不设区域（三层目录）' }, { value: '__new__', label: '＋ 新建区域' }]} onChange={() => structureForm.setFieldValue('zoneName', undefined)} />
        </Form.Item>
        {structureZoneChoice === '__new__' && <Form.Item name="zoneName" label="新区域名称" rules={[{ required: true, whitespace: true, message: '请输入区域名称' }]}><Input maxLength={64} /></Form.Item>}
        <Form.Item name="systemName" label="系统" rules={[{ required: true, whitespace: true, message: '请输入系统' }]}><Input maxLength={64} /></Form.Item>
      </Form>
    </Modal>

    {assetPresent && <Modal className="asset-editor-modal" classNames={{ wrapper: 'asset-editor-wrap' }} title={<span><CloudServerOutlined />　{editingAsset ? '编辑服务器' : '新增服务器'}</span>} open={assetOpen} mask={false} onCancel={(event) => { if (!dialogSaving && !composingCancel(event)) { if (notesOpen) { setNotesOpen(false); return; } assetSession.current++; setAssetOpen(false); } }} afterClose={() => { if (assetOpenRef.current) return; setAssetPresent(false); setEditingAsset(null); setNotesOpen(false); setNotesDraft(''); assetForm.resetFields(); restoreAssetFocus(); }} onOk={() => assetForm.submit()} okText="保存资产" cancelText="取消" confirmLoading={dialogSaving} closable={!dialogSaving} keyboard={!dialogSaving} cancelButtonProps={{ disabled: dialogSaving }} width={700} destroyOnHidden>
      <div className="modal-intro">服务器字段保存在所属系统的台账中；账号密码随加密数据一同保存。</div>
      <Form disabled={dialogSaving} form={assetForm} layout="vertical" onFinish={(values) => void submitDialog(() => saveAsset(values))}>
        <div className="form-grid asset-form-grid">
          <Form.Item name="systemId" label="所属系统" style={{ order: -3 }} rules={[{ required: true, message: '请选择所属系统' }]}><OrganizationSelect units={data.units} level="systemId" /></Form.Item>
          <Form.Item name="businessSystem" label={fieldLabel('business_system', '业务系统', editorSystemId)} style={{ order: formOrder('business_system', -2) }}><Input maxLength={128} /></Form.Item>
          <Form.Item name="status" label={fieldLabel('status', '统计分类', editorSystemId)} style={{ order: -1 }} rules={[{ required: true }]}><Select options={statusList.map((value) => ({ value, label: value }))} /></Form.Item>
          <Form.Item name="tags" label="标签" style={{ order: -1 }}><Input /></Form.Item>
          <Form.Item name="name" label={fieldLabel('name', '服务器名称', editorSystemId)} style={{ order: formOrder('name', 0) }} rules={[{ required: true, whitespace: true, message: '请输入服务器名称' }]}><Input maxLength={editorMaxLength('name', 128)} /></Form.Item>
          <Form.Item name="host" label={fieldLabel('host', '主机名', editorSystemId)} style={{ order: formOrder('host', 1) }} rules={[{ required: true, whitespace: true, message: '请输入主机名' }]}><Input maxLength={editorMaxLength('host', 64)} /></Form.Item>
          <Form.Item name="ip" label={fieldLabel('ip_1', 'IP', editorSystemId)} style={{ order: formOrder('ip_1', 2) }}><Input /></Form.Item>
          {editorHasField('ip_2') && <Form.Item name="ip2" label={fieldLabel('ip_2', '备用 IP', editorSystemId)} style={{ order: formOrder('ip_2', 3) }}><Input /></Form.Item>}
          <Form.Item name="cpu" label={fieldLabel('cpu', 'CPU 核数', editorSystemId)} style={{ order: formOrder('cpu', 4) }}><InputNumber min={1} max={256} className="full-width" addonAfter="核" /></Form.Item>
          <Form.Item name="memory" label={fieldLabel('mem', '内存', editorSystemId)} style={{ order: formOrder('mem', 5) }}><InputNumber min={1} max={4096} className="full-width" addonAfter="GB" /></Form.Item>
          <Form.Item name="os" label={fieldLabel('os', '操作系统', editorSystemId)} style={{ order: formOrder('os', 7) }}><Input /></Form.Item>
          {editorCustomFields.map((field) => <Form.Item key={field.id} name={['custom', field.key]} label={field.key === 'notes' && field.type === 'textarea' ? <span className="asset-notes-label"><span>{field.label}</span><Button type="text" size="small" icon={<FullscreenOutlined />} title="放大编辑备注" aria-label="放大编辑备注" onClick={(event) => { event.preventDefault(); setNotesDraft(String(assetForm.getFieldValue(['custom', 'notes']) ?? '')); setNotesOpen(true); }} /></span> : field.label} className={field.type === 'textarea' ? `asset-form-wide${field.key === 'notes' ? ' asset-notes-field' : ''}` : undefined} style={{ order: field.sortOrder }} rules={[{ required: field.required, message: `请输入${field.label}` }, { validator: (_, value) => { const errors = validateFieldValue(field, value); return errors.length ? Promise.reject(new Error(errors.join('；'))) : Promise.resolve(); } }]}>
          {field.type === 'textarea' ? <Input.TextArea aria-label={field.key === 'notes' ? field.label : undefined} rows={4} maxLength={field.validation.maxLength} showCount /> : field.type === 'integer' ? <InputNumber className="full-width" min={field.validation.min} max={field.validation.max} /> : field.type === 'boolean' ? <Select options={[{ value: true, label: '是' }, { value: false, label: '否' }]} /> : field.type === 'date' ? <DateTimeInput aria-label={field.label} className="full-width" dateOnly /> : field.type === 'datetime' ? <DateTimeInput aria-label={field.label} className="full-width" /> : field.type === 'url' ? <Input type="url" /> : field.type === 'email' ? <Input type="email" /> : field.type === 'phone' ? <Input type="tel" /> : field.type === 'password' ? <Input.Password maxLength={field.validation.maxLength} /> : field.options.length ? <Select options={field.options.map((value) => ({ value, label: value }))} /> : <Input maxLength={field.validation.maxLength} />}
          </Form.Item>)}
          <Form.Item name="disks" label={fieldLabel('disks', '硬盘', editorSystemId)} extra="如 sda|500G 或 /data|1T，多块换行或分号分隔" className="asset-form-wide" style={{ order: formOrder('disks', 6) }}><Input.TextArea rows={3} /></Form.Item>
          <Form.Item label={`${fieldLabel('user', '账号', editorSystemId)}与${fieldLabel('password', '密码', editorSystemId)}`} className="asset-form-wide" style={{ order: formOrder('user', 8) }}><Form.List name="accounts">
          {(fields, { add, remove }) => <div className="accounts-list">
            {fields.map(({ key: fieldKey, ...field }) => <div className="account-form-row" key={fieldKey}>
              <Form.Item {...field} name={[field.name, 'username']} rules={[{ required: true, whitespace: true, message: '请输入账号' }]}><Input placeholder="账号" /></Form.Item>
              <Form.Item {...field} name={[field.name, 'password']}><Input.Password autoComplete="new-password" placeholder="密码" /></Form.Item>
              <Button type="text" danger icon={<DeleteOutlined />} onClick={() => remove(field.name)} aria-label="删除账号" />
            </div>)}
            <Button type="dashed" block icon={<PlusOutlined />} onClick={() => add({ id: id(), username: '', password: '', passwordUpdatedAt: today() })}>添加账号</Button>
          </div>}
          </Form.List></Form.Item>
          {editorHasField('pwd_rotate') && <Form.Item name="rotatePassword" label={fieldLabel('pwd_rotate', '定期修改密码', editorSystemId)} style={{ order: formOrder('pwd_rotate', 12) }}><Select options={[{ value: true, label: '是' }, { value: false, label: '否' }]} /></Form.Item>}
          {editorHasField('pwd_cycle_days') && <Form.Item name="passwordCycleDays" label={fieldLabel('pwd_cycle_days', '密码更新周期', editorSystemId)} style={{ order: formOrder('pwd_cycle_days', 13) }} rules={[{ required: !!editorRotatePassword, message: '请填写多少天更新一次密码' }, { validator: (_, value) => !editorRotatePassword || (Number.isInteger(value) && value >= 1 && value <= 3650) ? Promise.resolve() : Promise.reject(new Error('请输入 1–3650 天的整数')) }]}><InputNumber disabled={!editorRotatePassword} min={1} max={3650} precision={0} placeholder="填写多少天更新一次" addonAfter="天" className="full-width" /></Form.Item>}
          {editorHasField('pwd_expire_at') && <Form.Item label={fieldLabel('pwd_expire_at', '密码更新期限', editorSystemId)} className="asset-form-wide" style={{ order: formOrder('pwd_expire_at', 14) }}><Input readOnly disabled={!editorRotatePassword} placeholder={editorRotatePassword ? '填写周期后，按各账号的密码创建／修改时间自动计算' : '未启用定期修改密码'} value={updateAccountDates(editorAccounts ?? [], editingAsset?.accounts ?? [], today()).map((account) => { const date = accountExpiryDate({ rotatePassword: !!editorRotatePassword, passwordCycleDays: Number(editorPasswordCycleDays) }, account); return date ? `${account.username}：${dateText(date.toISOString())}` : ''; }).filter(Boolean).join('；')} /></Form.Item>}
        </div>
      </Form>
    </Modal>}
    <Modal title="编辑备注" className="asset-notes-editor" zIndex={1100} open={assetOpen && notesOpen} width={900} okText="应用到备注" cancelText="取消" onCancel={(event) => { if (!composingCancel(event)) setNotesOpen(false); }} onOk={() => { assetForm.setFieldValue(['custom', 'notes'], notesDraft); setNotesOpen(false); }}>
      <div className="asset-notes-editor-body"><Input.TextArea aria-label="放大备注内容" value={notesDraft} onChange={(event) => setNotesDraft(event.target.value)} /><Text className="asset-notes-count" type="secondary">{notesDraft.length} 字</Text></div>
    </Modal>
  </ConfigProvider>;
}
