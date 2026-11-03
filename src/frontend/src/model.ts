import { defaultDashboardLayout, normalizeDashboardLayout } from './features/home/dashboardLayout';
import type { ReportsData } from './features/reports/types';
import type { OpsSystem } from './features/operations/types';

export type AssetStatus = '生产' | '测试' | '关机' | '待切换';

export type Account = {
  id?: string;
  username: string;
  password: string;
  passwordUpdatedAt: string;
};

export type Disk = { id?: string; label: string; capacity: number; unit?: string };
export type System = { id: string; name: string; sortOrder?: number };
export type NetworkZone = { id: string; name: string; systems: System[]; sortOrder?: number };
export type Environment = { id: string; name: string; zones: NetworkZone[]; sortOrder?: number };
export type Unit = { id: string; name: string; environments: Environment[]; sortOrder?: number };

export type FieldType = 'text' | 'textarea' | 'ip' | 'integer' | 'disk' | 'user' | 'password' | 'boolean' | 'date' | 'datetime' | 'url' | 'email' | 'phone' | 'path';

export type FieldValidation = {
  min?: number;
  max?: number;
  maxLength?: number;
  pattern?: string;
};

export type FieldDef = {
  id: string;
  systemId: string;
  key: string;
  label: string;
  templateNote?: string;
  type: FieldType;
  required: boolean;
  unique: boolean;
  quickCopy?: boolean;
  defaultValue?: unknown;
  options: string[];
  validation: FieldValidation;
  width: number;
  showInList: boolean;
  sortOrder: number;
  systemField: boolean;
  readOnly?: boolean;
};

export type FieldTemplateField = Omit<FieldDef, 'id' | 'systemId'>;

export const fieldColumnKey = (field: Pick<FieldDef, 'key' | 'type' | 'label'>) => `field:${encodeURIComponent(field.key)}:${field.type}:${encodeURIComponent(field.label)}`;

export type FieldTemplate = {
  id: string;
  name: string;
  fields: FieldTemplateField[];
  createdAt: string;
  updatedAt: string;
};

export type Asset = {
  id: string;
  businessSystem?: string;
  unitId: string;
  environmentId: string;
  zoneId: string;
  systemId: string;
  name: string;
  host: string;
  ip: string;
  ip2?: string;
  status: AssetStatus;
  cpu: number | null;
  memory: number | null;
  os: string;
  disks: Disk[];
  accounts: Account[];
  rotatePassword: boolean;
  passwordCycleDays: number;
  custom?: Record<string, unknown>;
  tags?: string[];
  createdAt: string;
  updatedAt: string;
};

export type ChangeSource = '手动' | '批量' | '导入' | '回滚' | '恢复' | '系统';
export type ChangeAction = '新增' | '编辑' | '删除' | '恢复' | '回滚';

export type ChangeItem = {
  fieldKey: string;
  fieldLabel?: string;
  before: unknown;
  after: unknown;
};

export type ChangeRecord = {
  id: string;
  assetName: string;
  action: ChangeAction;
  at: string;
  assetId?: string;
  systemId?: string;
  objectType?: ObjectType;
  objectId?: string;
  objectName?: string;
  source?: ChangeSource;
  batchId?: string;
  operator?: string;
  note?: string;
  items?: ChangeItem[];
  before?: unknown;
  after?: unknown;
};

export type ObjectType = 'asset' | 'environment' | 'zone' | 'system' | 'unit';
export const normalizeChangeRecord = (change: ChangeRecord): ChangeRecord => ({ ...change, source: change.source ?? '手动', objectName: change.objectName ?? change.assetName, items: change.items ?? [] });
export type BackupRetention = {
  recent: number;
  daily: number;
  weekly: number;
  monthly: number;
  yearly: number;
};

export type Settings = {
  requirePasswordOnStart: boolean;
  autoLock: boolean;
  autoLockMinutes: 5 | 15 | 30 | 60;
  closeBehavior: 'tray' | 'exit';
  searchHotkey: string;
  searchHotkeyRevision: number;
  exportDirectory: string;
  holidayCalendarUrl: string;
  dashboardLayout: import('./features/home/dashboardLayout').DashboardItem[];
  reportUnitId: string;
  reportSystemId: string;
  preserveSearch: boolean;
  dataDirectory: string;
  showPlainPassword: boolean;
  enableMultipleAccounts: boolean;
  enablePasswordRotation: boolean;
  passwordWarningDays: number;
  exportPlainPassword: boolean;
  startupBackup: boolean;
  backupBeforeWrite: boolean;
  scheduledBackup: boolean;
  scheduledBackupCron: string;
  scheduledBackupTime: string;
  scheduledBackupMode: 'daily' | 'interval';
  scheduledBackupIntervalHours: number;
  backupDirectory: string;
  backupRetention: BackupRetention;
  scheduledBackupRetention: BackupRetention;
  theme: 'light' | 'dark' | 'spring' | 'system';
  sidebarCollapsed: boolean;
  tableColumns: TableColumnSetting[];
  ledgerOnlySystem: boolean;
};

export type TableColumnSetting = {
  key: string;
  visible: boolean;
  width?: number;
  widthMode?: 'auto' | 'manual' | 'locked';
  fixed?: 'left' | 'right';
  sortOrder: number;
};

export type TableView = {
  id: string;
  name: string;
  systemId?: string;
  columns: TableColumnSetting[];
  filters?: Record<string, unknown>;
  sort?: { field: string; order: 'ascend' | 'descend' };
  pageSize?: number;
  createdAt: string;
  updatedAt: string;
};

export type ImportRowStatus = '新增' | '更新' | '无变化' | '冲突' | '错误';

export type ImportPreviewRow = {
  id: string;
  rowNumber: number;
  status: ImportRowStatus;
  selected: boolean;
  externalKey?: string;
  name?: string;
  values: Record<string, unknown>;
  differences: ChangeItem[];
  errors: string[];
};

export type ImportPreview = {
  id: string;
  filePath: string;
  systemId?: string;
  projectId?: string;
  fieldFingerprint?: string;
  requiresMapping: boolean;
  columnMapping: Record<string, string>;
  rows: ImportPreviewRow[];
  totals: Record<ImportRowStatus, number>;
  createdAt: string;
};

export type VaultData = {
  version: 4;
  defaultsRevision?: number;
  units: Unit[];
  assets: Asset[];
  fieldDefs: FieldDef[];
  fieldTemplates: FieldTemplate[];
  history: ChangeRecord[];
  settings: Settings;
  tableViews: TableView[];
  reports: ReportsData;
  opsSystems: OpsSystem[];
};

export const defaultSettings: Settings = {
  requirePasswordOnStart: true,
  autoLock: false,
  autoLockMinutes: 15,
  closeBehavior: 'exit',
  searchHotkey: 'F4',
  searchHotkeyRevision: 1,
  exportDirectory: '',
  holidayCalendarUrl: 'https://unpkg.com/holiday-calendar/data/CN/2026.json',
  dashboardLayout: defaultDashboardLayout,
  reportUnitId: '',
  reportSystemId: '',
  preserveSearch: true,
  dataDirectory: 'data',
  showPlainPassword: true,
  enableMultipleAccounts: true,
  enablePasswordRotation: true,
  passwordWarningDays: 7,
  exportPlainPassword: true,
  startupBackup: true,
  backupBeforeWrite: true,
  scheduledBackup: true,
  scheduledBackupCron: '0 */8 * * *',
  scheduledBackupTime: '18:00',
  scheduledBackupMode: 'daily',
  scheduledBackupIntervalHours: 6,
  backupDirectory: 'data\\backups',
  backupRetention: { recent: 20, daily: 7, weekly: 8, monthly: 6, yearly: 2 },
  scheduledBackupRetention: { recent: 20, daily: 7, weekly: 8, monthly: 6, yearly: 2 },
  theme: 'spring',
  sidebarCollapsed: true,
  tableColumns: [],
  ledgerOnlySystem: true,
};

const defaultTemplateNotes: Record<string, string> = {
  host: '必填 同系统内唯一',
  status: '默认生产 可选: 生产 / 测试 / 关机 / 待切换',
  disks: '如 sda|500G 或 /data|1T 多块换行或分号分隔',
  user: '留空默认 root\n多账号换行对应密码',
  password: '空密码留空\n多密码换行对应账号',
  pwd_rotate: '是/否，默认为"否"',
  pwd_cycle_days: '定期修改密码选择"是"时，该处必须填写对应周期',
};

const withTemplateNote = <T extends FieldTemplateField>(value: T): T => ({
  ...value,
  templateNote: value.key === 'disks' && value.templateNote === '如 sda|500GB 或 /data|1TB 多块换行或分号分隔' ? defaultTemplateNotes.disks : value.templateNote ?? defaultTemplateNotes[value.key] ?? '/',
  ...(value.key === 'disks' && value.label === '磁盘' ? { label: '硬盘' } : {}),
  ...(['pwd_rotate', 'pwd_cycle_days', 'pwd_expire_at'].includes(value.key) ? { systemField: true } : {}),
  quickCopy: value.quickCopy ?? (value.type === 'ip' || value.type === 'password'),
});

const field = (
  systemId: string,
  key: string,
  label: string,
  type: FieldType,
  sortOrder: number,
  partial: Partial<FieldDef> = {},
): FieldDef => ({
  id: `${systemId}:field:${key}`,
  systemId,
  key,
  label,
  templateNote: defaultTemplateNotes[key] ?? '/',
  type,
  required: false,
  unique: false,
  quickCopy: type === 'ip' || type === 'password',
  options: [],
  validation: {},
  width: 120,
  showInList: true,
  sortOrder,
  systemField: false,
  ...partial,
});

export const defaultFields = (systemId: string): FieldDef[] => [
  field(systemId, 'name', '服务器名称', 'text', 0, { width: 150, validation: { maxLength: 128 } }),
  field(systemId, 'host', '主机名', 'text', 1, { required: true, unique: true, showInList: false, validation: { maxLength: 64 } }),
  field(systemId, 'ip_1', '内网IP', 'ip', 2, { width: 130, required: true, unique: true, templateNote: '必填\n同系统内唯一' }),
  field(systemId, 'cpu', 'CPU', 'integer', 3, { width: 80, validation: { min: 1, max: 256 } }),
  field(systemId, 'mem', '内存', 'integer', 4, { width: 90, validation: { min: 1, max: 4096 } }),
  field(systemId, 'disks', '硬盘', 'disk', 5, { width: 180 }),
  field(systemId, 'user', '账号', 'user', 6, { width: 130 }),
  field(systemId, 'password', '密码', 'password', 7, { width: 150, readOnly: true }),
  field(systemId, 'os', '操作系统', 'text', 8, { width: 140 }),
  field(systemId, 'status', '服务器状态', 'text', 9, { width: 110, systemField: true, readOnly: true, options: ['生产', '测试', '关机', '待切换'] }),
  field(systemId, 'business_system', '业务系统', 'text', 10, { width: 150, showInList: false }),
  field(systemId, 'updated_at', '修改日期', 'date', 11, { width: 120, systemField: true, readOnly: true }),
  field(systemId, 'created_at', '创建日期', 'date', 12, { width: 120, systemField: true, readOnly: true, showInList: false }),
  field(systemId, 'pwd_rotate', '定期修改密码', 'boolean', 13, { defaultValue: false, width: 130, systemField: true, showInList: false }),
  field(systemId, 'pwd_cycle_days', '密码更新周期', 'integer', 14, { width: 130, validation: { min: 1, max: 3650 }, systemField: true, showInList: false }),
  field(systemId, 'pwd_expire_at', '密码更新期限', 'date', 15, { width: 130, systemField: true, showInList: false }),
  field(systemId, 'notes', '备注', 'textarea', 16, { width: 260, showInList: false }),
];

const asArray = <T>(value: unknown): T[] => Array.isArray(value) ? value as T[] : [];
const asRecord = (value: unknown): Record<string, unknown> => value && typeof value === 'object' ? value as Record<string, unknown> : {};

const normalizedSnapshots = new WeakSet<VaultData>();
const rememberNormalized = (data: VaultData) => { normalizedSnapshots.add(data); return data; };

export function normalizeSettings(raw: unknown): Settings {
  const storedSettings = { ...asRecord(raw) };
  delete storedSettings.searchAsYouType;
  delete storedSettings.tableDensity;
  delete storedSettings.recycleRetentionDays;
  delete storedSettings.recycleMaxItems;
  delete storedSettings.fontSize;
  delete storedSettings.zebraRows;
  const retention = asRecord(storedSettings.backupRetention);
  const scheduledRetention = storedSettings.scheduledBackupRetention === undefined ? retention : asRecord(storedSettings.scheduledBackupRetention);
  delete storedSettings.reportAI;
  delete storedSettings.observancesUrl;
  delete storedSettings.chineseDaysUrl;
  delete storedSettings.lockHotkey;
  delete storedSettings.reportInsertHotkey;
  const backupTime = typeof storedSettings.scheduledBackupTime === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(storedSettings.scheduledBackupTime) ? storedSettings.scheduledBackupTime : '18:00';
  const [backupHour, backupMinute] = backupTime.split(':').map(Number);
  // 旧的每日时间可精确转换；间隔保留原语义，直到用户显式保存 crontab。
  const storedCron = typeof storedSettings.scheduledBackupCron === 'string' ? storedSettings.scheduledBackupCron.trim() : storedSettings.scheduledBackupMode === 'interval' ? '' : `${backupMinute} ${backupHour} * * *`;
  const backupCron = storedCron === '0 18 * * *' ? defaultSettings.scheduledBackupCron : storedCron;
  const holidayCalendarUrl = typeof storedSettings.holidayCalendarUrl === 'string' ? storedSettings.holidayCalendarUrl.trim() : '';
  return {
    ...defaultSettings,
    ...storedSettings,
    searchHotkey: typeof storedSettings.searchHotkey !== 'string' || (storedSettings.searchHotkeyRevision !== 1 && storedSettings.searchHotkey === 'Ctrl+Shift+K') ? 'F4' : storedSettings.searchHotkey,
    searchHotkeyRevision: 1,
    exportDirectory: typeof storedSettings.exportDirectory === 'string' ? storedSettings.exportDirectory.trim() : '',
    holidayCalendarUrl: holidayCalendarUrl || defaultSettings.holidayCalendarUrl,
    dashboardLayout: normalizeDashboardLayout(storedSettings.dashboardLayout),
    scheduledBackupMode: storedSettings.scheduledBackupMode === 'interval' ? 'interval' : 'daily',
    scheduledBackupIntervalHours: typeof storedSettings.scheduledBackupIntervalHours === 'number' && Number.isFinite(storedSettings.scheduledBackupIntervalHours) ? Math.max(1, Math.min(168, Math.round(storedSettings.scheduledBackupIntervalHours))) : 6,
    scheduledBackupTime: backupTime,
    scheduledBackupCron: backupCron,
    backupRetention: { ...defaultSettings.backupRetention, ...retention },
    scheduledBackupRetention: { ...defaultSettings.scheduledBackupRetention, ...scheduledRetention },
  } as Settings;
}

export function normalizeVault(raw: unknown): VaultData {
  const source = asRecord(raw);
  if (source.version !== undefined && (typeof source.version !== 'number' || !Number.isInteger(source.version) || source.version < 0)) throw new Error('数据仓库版本格式错误，原数据已保留');
  if (typeof source.version === 'number' && source.version > 4) throw new Error('数据仓库版本高于当前应用支持的版本，请使用新版应用打开');
  const updateDefaults = !(typeof source.defaultsRevision === 'number' && source.defaultsRevision >= 1);
  const updateListDefaults = !(typeof source.defaultsRevision === 'number' && source.defaultsRevision >= 2);
  const updateHiddenColumns = !(typeof source.defaultsRevision === 'number' && source.defaultsRevision >= 3);
  const updateNameColumn = !(typeof source.defaultsRevision === 'number' && source.defaultsRevision >= 4);
  const normalizeField = <T extends FieldTemplateField>(value: T): T => {
    let normalized = withTemplateNote(value);
    if (normalized.key === 'notes' && normalized.validation.maxLength !== undefined) {
      const validation = { ...normalized.validation }; delete validation.maxLength;
      normalized = { ...normalized, validation };
    }
    if (!updateDefaults) return normalized;
    const oldLength = value.key === 'name' ? 64 : value.key === 'host' ? 128 : undefined;
    const oldNote = value.key === 'host' ? '必填\n系统内唯一' : value.key === 'status' ? '默认生产\n生产 / 测试\n关机 / 待切换' : undefined;
    return {
      ...normalized,
      ...(oldLength !== undefined && value.validation?.maxLength === oldLength ? { validation: { ...value.validation, maxLength: value.key === 'name' ? 128 : 64 } } : {}),
      ...(oldNote !== undefined && value.templateNote === oldNote ? { templateNote: defaultTemplateNotes[value.key] } : {}),
    };
  };
  const settings = normalizeSettings(source.settings);
  const storedReports = asRecord(source.reports);
  const storedCalendar = asRecord(storedReports.calendar);
  const reports: ReportsData = {
    entries: asArray<ReportsData['entries'][number]>(storedReports.entries),
    reports: asArray<ReportsData['reports'][number]>(storedReports.reports).map((report) => {
      const clean = { ...report } as ReportsData['reports'][number] & Record<string, unknown>;
      delete clean.sourceFingerprint; delete clean.scheduled; delete clean.scheduledComplete;
      return { ...clean, revisions: asArray<ReportsData['reports'][number]['revisions'][number]>(report.revisions) };
    }),
    calendar: {
      overrides: Object.fromEntries(Object.entries(asRecord(storedCalendar.overrides)).filter(([, value]) => typeof value === 'boolean')) as Record<string, boolean>,
      exclusions: asArray<ReportsData['calendar']['exclusions'][number]>(storedCalendar.exclusions),
      holidays: Object.fromEntries(Object.entries(asRecord(storedCalendar.holidays)).filter(([, value]) => value && typeof (value as { workday?: unknown }).workday === 'boolean')) as NonNullable<ReportsData['calendar']['holidays']>,
      tasks: asArray<NonNullable<ReportsData['calendar']['tasks']>[number]>(storedCalendar.tasks).filter((task) => task && typeof task.id === 'string' && typeof task.title === 'string' && Number.isFinite(Date.parse(task.dueAt))).map((task) => ({ ...task, repeat: ['daily', 'weekly', 'monthly'].includes(task.repeat) ? task.repeat : 'none', priority: task.priority === 'high' ? 'high' : 'normal' })),
    },
  };
  const fieldTemplates = asArray<FieldTemplate>(source.fieldTemplates).map((template) => ({
    ...template,
    fields: asArray<FieldTemplateField>(template.fields).map(normalizeField),
  }));

  // 版本 4 起结构为 单位 → 环境 → 网络区域 → 系统；旧版本业务数据按约定清空重建，保留设置与字段模板。
  if (source.version !== 4) {
    return rememberNormalized({
      version: 4,
      defaultsRevision: 4,
      units: [],
      assets: [],
      fieldDefs: [],
      fieldTemplates,
      history: [],
      settings,
      tableViews: [],
      reports: { entries: [], reports: [], calendar: { overrides: {}, exclusions: [] } },
      opsSystems: [],
    });
  }

  const units = asArray<Unit>(source.units).map((unit) => ({
    ...unit,
    environments: asArray<Environment>(unit.environments).map((environment) => ({
      ...environment,
      zones: asArray<NetworkZone>(environment.zones).map((zone) => ({
        ...zone,
        systems: asArray<System>(zone.systems),
      })),
    })),
  }));
  const assets = asArray<Asset>(source.assets).map((asset) => ({
    ...asset,
    ...(updateDefaults && !asset.businessSystem?.trim() && typeof asset.custom?.business_system === 'string' && asset.custom.business_system.trim() ? { businessSystem: asset.custom.business_system.trim() } : {}),
    status: (asset.status as string) === '关机/下电' ? '关机' as const : asset.status,
    ip2: asset.ip2 ?? '',
    custom: asset.custom ?? {},
    tags: asset.tags ?? [],
    disks: asArray<Disk>(asset.disks),
    accounts: (() => {
      const used = new Set<string>();
      return asArray<Account>(asset.accounts).map((account, index) => {
        let accountId = account.id;
        if (!accountId || used.has(accountId)) {
          accountId = `${asset.id}:account:${index}`;
          while (used.has(accountId)) accountId += ':new';
        }
        used.add(accountId);
        return { ...account, id: accountId, passwordUpdatedAt: account.passwordUpdatedAt || asset.updatedAt || asset.createdAt || new Date().toISOString().slice(0, 10) };
      });
    })(),
  }));
  const storedFields = asArray<FieldDef>(source.fieldDefs).map(normalizeField);
  const knownSystems = units.flatMap((unit) => unit.environments).flatMap((environment) => environment.zones).flatMap((zone) => zone.systems);
  const fieldsBySystem = new Map<string, FieldDef[]>();
  for (const value of storedFields) {
    const fields = fieldsBySystem.get(value.systemId) ?? [];
    fields.push(value); fieldsBySystem.set(value.systemId, fields);
  }
  let fieldDefs = knownSystems.flatMap((system) => {
    const existing = fieldsBySystem.get(system.id) ?? [];
    if (!existing.length || !updateDefaults || existing.some(item => item.key === 'notes')) return existing;
    const notesField = defaultFields(system.id).find(item => item.key === 'notes')!;
    return [...existing, { ...notesField, sortOrder: Math.max(...existing.map(item => item.sortOrder), -1) + 1 }];
  });
  if (updateListDefaults) {
    const previousOrder = ['business_system', 'name', 'host', 'ip_1', 'status', 'cpu', 'mem', 'disks', 'os', 'user', 'password', 'updated_at', 'created_at', 'pwd_rotate', 'pwd_cycle_days', 'pwd_expire_at', 'notes'];
    const defaults = new Map(defaultFields('').map(field => [field.key, field]));
    const legacyKeys: Record<string, string> = { business_system: 'businessSystem', ip_1: 'ip', ip_2: 'ip2', mem: 'memory', user: 'accounts', pwd_rotate: 'pwdRotate', pwd_cycle_days: 'pwdCycle', pwd_expire_at: 'passwordExpiry', created_at: 'createdAt', updated_at: 'updatedAt' };
    const previousKeys = new Map(asArray<FieldDef>(source.fieldDefs).map(field => [fieldColumnKey(field), fieldColumnKey(withTemplateNote(field))]));
    settings.tableColumns = settings.tableColumns.map(column => ({ ...column, key: previousKeys.get(column.key) ?? column.key }));
    const storedColumns = new Map(settings.tableColumns.map(column => [column.key, column]));
    const defaultOrderSystems = new Set(knownSystems.filter(system => (fieldsBySystem.get(system.id) ?? []).every(field => !previousOrder.includes(field.key) || field.sortOrder === previousOrder.indexOf(field.key) - 1)).map(system => system.id));
    const orders = new Map<string, number>();
    const rank = (field: FieldDef) => defaults.get(field.key)?.sortOrder ?? (field.type === 'ip' ? defaults.get('ip_1')!.sortOrder + .5 : defaults.size + field.sortOrder);
    for (const systemId of defaultOrderSystems) [...(fieldsBySystem.get(systemId) ?? [])].sort((a, b) => rank(a) - rank(b)).forEach((field, sortOrder) => orders.set(field.id, sortOrder));
    fieldDefs = fieldDefs.map(field => {
      const column = storedColumns.get(fieldColumnKey(field)) ?? storedColumns.get(legacyKeys[field.key] ?? field.key);
      const preset = defaults.get(field.key);
      return { ...field, showInList: column?.visible ?? (preset?.showInList === false ? false : field.showInList),
        sortOrder: orders.get(field.id) ?? field.sortOrder };
    });
  }
  if (updateHiddenColumns) {
    const hidden = new Set(defaultFields('').filter(field => !field.showInList).map(field => field.key));
    fieldDefs = fieldDefs.map(field => hidden.has(field.key) ? { ...field, showInList: false } : field);
    const keys = new Set(fieldDefs.filter(field => hidden.has(field.key)).map(fieldColumnKey));
    for (const key of ['businessSystem', 'notes', 'custom:notes', 'createdAt', 'pwdRotate', 'pwdCycle', 'passwordExpiry']) keys.add(key);
    settings.tableColumns = settings.tableColumns.map(column => keys.has(column.key) ? { ...column, visible: false } : column);
  }
  if (updateNameColumn) {
    const previousOrder = ['host', 'ip_1', 'cpu', 'mem', 'disks', 'user', 'password', 'os', 'status', 'name', 'business_system', 'updated_at', 'created_at', 'pwd_rotate', 'pwd_cycle_days', 'pwd_expire_at', 'notes'];
    const defaults = new Map(defaultFields('').map(field => [field.key, field]));
    const defaultOrderSystems = new Set(knownSystems.filter(system => (fieldsBySystem.get(system.id) ?? []).every(field => !previousOrder.includes(field.key) || field.sortOrder === previousOrder.indexOf(field.key))).map(system => system.id));
    const previous = new Map(fieldDefs.map(field => [fieldColumnKey(field), field.sortOrder]));
    fieldDefs = fieldDefs.map(field => ({ ...field,
      ...(field.key === 'host' ? { showInList: false } : {}),
      ...(defaultOrderSystems.has(field.systemId) && defaults.has(field.key) ? { sortOrder: defaults.get(field.key)!.sortOrder, ...(field.key === 'name' ? { showInList: true } : {}) } : {}),
    }));
    const next = new Map(fieldDefs.map(field => [fieldColumnKey(field), field]));
    const defaultOrder = settings.tableColumns.every(column => !previous.has(column.key) || column.sortOrder === previous.get(column.key));
    settings.tableColumns = settings.tableColumns.map(column => ({ ...column,
      ...(column.key === 'host' || next.get(column.key)?.key === 'host' ? { visible: false } : {}),
      ...(defaultOrder && next.has(column.key) ? { sortOrder: next.get(column.key)!.sortOrder } : {}),
    }));
  }
  const zeroIsEmpty = new Map<string, Set<string>>();
  for (const value of fieldDefs) if (['cpu', 'mem'].includes(value.key) && !value.required && (value.validation.min ?? 0) > 0) {
    const keys = zeroIsEmpty.get(value.systemId) ?? new Set<string>();
    keys.add(value.key); zeroIsEmpty.set(value.systemId, keys);
  }
  const history = asArray<ChangeRecord>(source.history).map(normalizeChangeRecord);

  return rememberNormalized({
    version: 4,
    defaultsRevision: typeof source.defaultsRevision === 'number' && source.defaultsRevision > 4 ? source.defaultsRevision : 4,
    units,
    assets: assets.map((asset) => ({
      ...asset,
      cpu: asset.cpu === 0 && zeroIsEmpty.get(asset.systemId)?.has('cpu') ? null : asset.cpu ?? null,
      memory: asset.memory === 0 && zeroIsEmpty.get(asset.systemId)?.has('mem') ? null : asset.memory ?? null,
    })),
    fieldDefs,
    fieldTemplates,
    history,
    settings,
    tableViews: asArray<TableView>(source.tableViews),
    reports,
    opsSystems: asArray<OpsSystem>(source.opsSystems).map((system) => ({
      ...system,
      topology: { nodes: asArray(system.topology?.nodes), edges: asArray(system.topology?.edges), regions: asArray(system.topology?.regions) },
      revisions: asArray<OpsSystem['revisions'][number]>(system.revisions).map((revision) => ({
        ...revision,
        topology: { nodes: asArray(revision.topology?.nodes), edges: asArray(revision.topology?.edges), regions: asArray(revision.topology?.regions) },
      })),
    })),
  });
}

const businessBranches = ['units', 'assets', 'fieldDefs', 'fieldTemplates', 'history', 'opsSystems', 'reports', 'tableViews'] as const;

export function normalizeVaultUpdate(expected: VaultData, next: VaultData): VaultData {
  const trusted = normalizedSnapshots.has(expected);
  if (trusted && next.version === expected.version && next.defaultsRevision === expected.defaultsRevision && businessBranches.every(key => next[key] === expected[key])) {
    return rememberNormalized({ ...expected, settings: next.settings === expected.settings ? expected.settings : normalizeSettings(next.settings) });
  }
  const normalized = normalizeVault(next);
  if (!trusted) return normalized;
  return rememberNormalized({ ...normalized,
    units: next.units === expected.units ? expected.units : normalized.units,
    assets: next.assets === expected.assets && next.fieldDefs === expected.fieldDefs && next.units === expected.units && next.version === expected.version && next.defaultsRevision === expected.defaultsRevision ? expected.assets : normalized.assets,
    fieldDefs: next.fieldDefs === expected.fieldDefs && next.units === expected.units ? expected.fieldDefs : normalized.fieldDefs,
    fieldTemplates: next.fieldTemplates === expected.fieldTemplates ? expected.fieldTemplates : normalized.fieldTemplates,
    history: next.history === expected.history ? expected.history : normalized.history,
    opsSystems: next.opsSystems === expected.opsSystems ? expected.opsSystems : normalized.opsSystems,
    reports: next.reports === expected.reports ? expected.reports : normalized.reports,
    settings: next.settings === expected.settings ? expected.settings : normalized.settings,
    tableViews: next.tableViews === expected.tableViews ? expected.tableViews : normalized.tableViews,
  });
}

export const emptyVault: VaultData = normalizeVault({});

export const id = () => crypto.randomUUID();

export const displayPath = (value: string) => value.replaceAll('/', '\\').replace(/^\\\\\?\\UNC\\/, '\\\\').replace(/^\\\\\?\\/, '').replace(/(^|\\)\.\\/g, '$1');
