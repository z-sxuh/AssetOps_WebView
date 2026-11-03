import type { VaultData } from '../../model';

const aliases: Record<string, string> = { business_system: 'businessSystem', ip_1: 'ip', ip_2: 'ip2', mem: 'memory', user: 'accounts', password: 'passwords', pwd_rotate: 'rotatePassword', pwd_cycle_days: 'passwordCycleDays' };
export const importFieldKey = (key: string) => aliases[key] ?? key;

export function importFieldOptions(data: Pick<VaultData, 'fieldDefs'>, systemId?: string) {
  const fields = data.fieldDefs.filter(field => field.systemId === systemId && !['created_at','updated_at','pwd_expire_at'].includes(field.key)).sort((a,b) => a.sortOrder - b.sortOrder);
  const options = fields.map(field => ({ value: importFieldKey(field.key), label: `${field.label} (${importFieldKey(field.key)})` }));
  if (!options.some((option) => option.value === 'asset:tags')) options.push({ value: 'asset:tags', label: '资产标签 (tags)' });
  if (fields.some(field => field.key === 'user')) options.push({ value: 'passwordUpdatedAt', label: '账号密码修改日期 (passwordUpdatedAt)' });
  return [{ value: '__auto__', label: '自动识别' }, { value: '__ignore__', label: '忽略此列' }, ...options,
    ...[['unit','单位'],['environment','环境'],['zone','网络区域'],['system','系统（组织归属）']].map(([value,label]) => ({ value,label:`${label} (${value})` }))];
}
