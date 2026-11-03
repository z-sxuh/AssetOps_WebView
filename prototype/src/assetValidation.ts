import type { Account, Asset, FieldDef, VaultData } from './model';

export const emptyValue = (value: unknown) => value === undefined || value === null || value === '' || (Array.isArray(value) && !value.length);
export const optionalNumber = (value: unknown): number | null => emptyValue(value) ? null : Number(value);

export function validPattern(pattern?: string) {
  try { if (pattern) new RegExp(pattern); return true; } catch { return false; }
}

export function normalizeFieldValidation(value: FieldDef['validation']): FieldDef['validation'] {
  const optional = (number: unknown) => number === null || number === '' ? undefined : number;
  const min = optional(value.min), max = optional(value.max), maxLength = optional(value.maxLength);
  if ([min, max].some(number => number !== undefined && (typeof number !== 'number' || !Number.isFinite(number)))
    || min !== undefined && max !== undefined && Number(min) > Number(max)
    || maxLength !== undefined && (!Number.isInteger(maxLength) || Number(maxLength) < 1)
    || value.pattern !== undefined && (typeof value.pattern !== 'string' || !validPattern(value.pattern))) throw new Error('校验规则无效：请检查数值范围、最大长度和正则表达式');
  return { min: min as number | undefined, max: max as number | undefined, maxLength: maxLength as number | undefined, pattern: value.pattern };
}

export function isValidIp(value: string) {
  if (!value) return true;
  const parts = value.split('.');
  if (parts.length === 4 && parts.every((part) => /^\d{1,3}$/.test(part) && String(Number(part)) === part && Number(part) <= 255)) return true;
  if (!value.includes(':')) return false;
  try { return new URL(`http://[${value}]/`).hostname.startsWith('['); } catch { return false; }
}

export function assetFieldValues(asset: Asset): Record<string, unknown> {
  return {
    ...asset.custom, business_system: asset.businessSystem, name: asset.name, host: asset.host,
    ip_1: asset.ip, ip_2: asset.ip2, status: asset.status, cpu: asset.cpu, mem: asset.memory,
    disks: asset.disks, os: asset.os, user: asset.accounts, password: asset.accounts.map((account) => account.password),
    pwd_rotate: asset.rotatePassword, pwd_cycle_days: asset.passwordCycleDays,
  };
}

export function validateFieldValue(field: FieldDef, value: unknown): string[] {
  const errors: string[] = [];
  if (Array.isArray(value) && value.length && ['user', 'password'].includes(field.type)) {
    return value.flatMap((item, index) => validateFieldValue({ ...field, type: 'text', label: `${field.label}（账号 ${index + 1}）` }, field.type === 'user' ? (item as Account).username : item));
  }
  let validation: FieldDef['validation'];
  try { validation = normalizeFieldValidation(field.validation); }
  catch { return [`${field.label}校验规则无效，请在字段定义中修复`]; }
  if (!validPattern(field.validation.pattern)) errors.push(`${field.label}校验规则无效，请在字段定义中修复`);
  if (emptyValue(value)) return field.required ? [...errors, `${field.label}为必填字段`] : errors;
  const optionValue = (option: unknown) => field.type === 'boolean'
    ? (['true', '是', '1'].includes(String(option).toLowerCase()) ? 'true' : ['false', '否', '0'].includes(String(option).toLowerCase()) ? 'false' : String(option)) : String(option);
  const selectedValues = Array.isArray(value) ? (field.type === 'user' ? (value as Account[]).map((account) => account.username) : value) : [value];
  if (field.options.length && selectedValues.some((selected) => !field.options.some((option) => optionValue(option) === optionValue(selected)))) errors.push(`${field.label}不在可选值范围内`);
  if (field.type === 'boolean' && ![true, false, 'true', 'false', '是', '否', '1', '0'].includes(value as string | boolean)) errors.push(`${field.label}应为是/否或 true/false`);
  if (field.type === 'ip' && !isValidIp(String(value))) errors.push(`${field.label}不是合法 IP`);
  if (field.type === 'date' && (!/^\d{4}-\d{2}-\d{2}$/.test(String(value)) || Number.isNaN(Date.parse(String(value))) || new Date(String(value)).toISOString().slice(0, 10) !== value)) errors.push(`${field.label}应为有效日期（YYYY-MM-DD）`);
  if (field.type === 'datetime' && (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(String(value)) || Number.isNaN(Date.parse(String(value))))) errors.push(`${field.label}应为有效日期时间`);
  if (field.type === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value))) errors.push(`${field.label}应为有效邮箱`);
  if (field.type === 'url') { try { new URL(String(value)); } catch { errors.push(`${field.label}应为有效 URL`); } }
  if (field.type === 'phone' && (!/^[0-9+()（）\-\s]{5,32}$/.test(String(value)) || String(value).replace(/\D/g, '').length < 5)) errors.push(`${field.label}应为有效电话号码`);
  if (field.type === 'path' && /[\u0000-\u001f]/.test(String(value))) errors.push(`${field.label}包含无效字符`);
  if (field.type === 'integer' && (!Number.isInteger(Number(value)) || (validation.min !== undefined && Number(value) < validation.min) || (validation.max !== undefined && Number(value) > validation.max))) errors.push(`${field.label}超出允许范围`);
  if (validation.maxLength !== undefined && String(value).length > validation.maxLength) errors.push(`${field.label}超过长度上限`);
  if (validation.pattern && validPattern(validation.pattern) && !new RegExp(validation.pattern).test(String(value))) errors.push(`${field.label}格式不正确`);
  return errors;
}

export function createAssetValidationContext(assets: Asset[], data: Pick<VaultData, 'units' | 'fieldDefs'>) {
  const owners = new Map<string, { unitId: string; environmentId: string; zoneId: string }>();
  for (const unit of data.units) for (const environment of unit.environments) for (const zone of environment.zones) for (const system of zone.systems) {
    if (!owners.has(system.id)) owners.set(system.id, { unitId: unit.id, environmentId: environment.id, zoneId: zone.id });
  }
  const fieldsBySystem = new Map<string, FieldDef[]>();
  for (const field of data.fieldDefs) {
    const fields = fieldsBySystem.get(field.systemId) ?? [];
    fields.push(field); fieldsBySystem.set(field.systemId, fields);
  }
  type ValueIds = Map<string, Map<string, number>>;
  const uniqueValues = new Map<string, Map<string, ValueIds>>();
  const adjust = (asset: Asset, delta: number) => {
    let fields = uniqueValues.get(asset.systemId);
    if (!fields) {
      const keys = new Set(['host', ...(fieldsBySystem.get(asset.systemId) ?? []).filter(field => !field.systemField && field.unique && !['disk', 'user', 'password'].includes(field.type)).map(field => field.key)]);
      fields = new Map(Array.from(keys, key => [key, new Map<string, Map<string, number>>() ]));
      uniqueValues.set(asset.systemId, fields);
    }
    const values = assetFieldValues(asset);
    for (const [key, index] of fields) {
      const value = String(values[key] ?? '').trim().toLowerCase();
      const ids = index.get(value) ?? new Map<string, number>();
      const count = (ids.get(asset.id) ?? 0) + delta;
      if (count > 0) ids.set(asset.id, count); else ids.delete(asset.id);
      if (ids.size) index.set(value, ids); else index.delete(value);
    }
  };
  for (const asset of assets) adjust(asset, 1);
  return {
    owners, fieldsBySystem,
    add: (asset: Asset) => adjust(asset, 1),
    remove: (asset: Asset) => adjust(asset, -1),
    hasDuplicate: (asset: Asset, key: string, value: unknown) => {
      const ids = uniqueValues.get(asset.systemId)?.get(key)?.get(String(value ?? '').trim().toLowerCase());
      return !!ids && ids.size > (ids.has(asset.id) ? 1 : 0);
    },
  };
}

export type AssetValidationContext = ReturnType<typeof createAssetValidationContext>;

export function validateAsset(asset: Asset, others: Asset[], data: Pick<VaultData, 'units' | 'fieldDefs'>, context = createAssetValidationContext(others, data)): string[] {
  const owner = context.owners.get(asset.systemId);
  const errors: string[] = [];
  if (!owner || owner.unitId !== asset.unitId || owner.environmentId !== asset.environmentId || owner.zoneId !== asset.zoneId) errors.push('资产所属组织不存在或层级不匹配');
  if (!asset.name?.trim() || !asset.host?.trim()) errors.push('服务器名称和主机名不能为空');
  if (!isValidIp(asset.ip) || !isValidIp(asset.ip2 ?? '')) errors.push('IP 地址无效');
  if (!['生产', '测试', '关机', '待切换'].includes(asset.status)) errors.push('服务器状态无效');
  if (context.hasDuplicate(asset, 'host', asset.host)) errors.push('主机名在当前系统中重复');
  if (asset.rotatePassword && (!Number.isInteger(asset.passwordCycleDays) || asset.passwordCycleDays < 1 || asset.passwordCycleDays > 3650)) errors.push('请填写密码更新周期（1–3650 天的整数）');
  const usernames = asset.accounts.map((account) => account.username.trim().toLowerCase());
  if (usernames.some((name) => !name) || new Set(usernames).size !== usernames.length) errors.push('账号名称不能为空或重复（忽略大小写）');
  if (asset.disks.some((disk) => !disk.label.trim() || !Number.isFinite(disk.capacity) || disk.capacity <= 0)) errors.push('硬盘标识不能为空，容量须为正数');
  const values = assetFieldValues(asset);
  for (const field of context.fieldsBySystem.get(asset.systemId) ?? []) {
    if (field.systemField) continue;
    if (field.key === 'pwd_expire_at' || (field.key === 'pwd_cycle_days' && !asset.rotatePassword)) continue;
    const value = values[field.key];
    errors.push(...validateFieldValue(field, value));
    if (!emptyValue(value) && field.unique && !['disk', 'user', 'password'].includes(field.type) && context.hasDuplicate(asset, field.key, value)) errors.push(`${field.label}在当前系统中重复`);
  }
  return [...new Set(errors)];
}
