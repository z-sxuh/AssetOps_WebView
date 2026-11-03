import { fieldColumnKey, type Asset, type FieldDef, type TableColumnSetting, type VaultData } from './model';
import type { EntryScope } from './features/reports/reportModel';
import { assetFieldValues } from './assetValidation';

const keys: Record<string, string> = { business_system: 'businessSystem', ip_1: 'ip', ip_2: 'ip2', mem: 'memory', user: 'accounts', pwd_rotate: 'pwdRotate', pwd_cycle_days: 'pwdCycle', pwd_expire_at: 'passwordExpiry', created_at: 'createdAt', updated_at: 'updatedAt' };
const builtins = new Set(['business_system', 'name', 'host', 'ip_1', 'ip_2', 'status', 'cpu', 'mem', 'disks', 'os', 'user', 'password', 'pwd_rotate', 'pwd_cycle_days', 'pwd_expire_at', 'created_at', 'updated_at']);
export type LedgerFieldGroup = { key: string; baseKey: string; field: FieldDef; systemIds: Set<string>; quickCopySystemIds: Set<string> };
export function ledgerFieldGroups(data: Pick<VaultData, 'units' | 'fieldDefs'>, scope: EntryScope): LedgerFieldGroup[] {
  const systems = new Set(data.units.filter(unit => !scope.unitId || unit.id === scope.unitId).flatMap(unit => unit.environments.filter(env => !scope.environmentId || env.id === scope.environmentId).flatMap(env => env.zones.filter(zone => !scope.zoneId || zone.id === scope.zoneId).flatMap(zone => zone.systems.filter(system => !scope.systemId || system.id === scope.systemId).map(system => system.id)))));
  const groups = new Map<string, LedgerFieldGroup>();
  for (const field of [...data.fieldDefs].sort((a, b) => a.sortOrder - b.sortOrder)) {
    if (!systems.has(field.systemId)) continue;
    const key = fieldColumnKey(field);
    const group = groups.get(key);
    if (group) {
      group.systemIds.add(field.systemId);
      if (field.quickCopy) group.quickCopySystemIds.add(field.systemId);
      if (field.showInList && !group.field.showInList) group.field = { ...group.field, showInList: true };
    }
    else groups.set(key, { key, baseKey: keys[field.key] ?? (builtins.has(field.key) ? field.key : `custom:${field.key}`), field, systemIds: new Set([field.systemId]), quickCopySystemIds: new Set(field.quickCopy ? [field.systemId] : []) });
  }
  return [...groups.values()];
}
export function ledgerFieldValue(group: LedgerFieldGroup, asset: Asset) {
  if (!group.systemIds.has(asset.systemId)) return undefined;
  if (group.field.key === 'created_at') return asset.createdAt;
  if (group.field.key === 'updated_at') return asset.updatedAt;
  return assetFieldValues(asset)[group.field.key];
}

export function ledgerCopyText(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'boolean') return value ? '是' : '否';
  return typeof value === 'object' ? JSON.stringify(value) : String(value);
}

export function applyFieldColumnSettings(fields: FieldDef[], groups: LedgerFieldGroup[], settings: TableColumnSetting[]): FieldDef[] {
  const editable = new Map(groups.map(group => [group.key, group.systemIds]));
  const values = new Map(settings.map(setting => [setting.key, setting.visible]));
  return fields.map(field => {
    const key = fieldColumnKey(field), visible = values.get(key);
    return editable.get(key)?.has(field.systemId) && visible !== undefined && visible !== field.showInList ? { ...field, showInList: visible } : field;
  });
}
