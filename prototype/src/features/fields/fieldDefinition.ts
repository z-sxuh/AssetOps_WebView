import type { FieldDef, FieldType } from '../../model';
import { normalizeFieldValidation } from '../../assetValidation';

const builtInTypes: Record<string, FieldType> = {
  business_system: 'text', name: 'text', host: 'text', ip_1: 'ip', ip_2: 'ip', cpu: 'integer', mem: 'integer',
  disks: 'disk', user: 'user', password: 'password', os: 'text', status: 'text',
  updated_at: 'date', created_at: 'date', pwd_rotate: 'boolean', pwd_cycle_days: 'integer', pwd_expire_at: 'date',
};
export const builtInFieldType = (key: string) => Object.hasOwn(builtInTypes, key) ? builtInTypes[key] : undefined;
export function checkedFieldDefinition<T extends Pick<FieldDef, 'key' | 'label' | 'type' | 'validation'>>(field: T, previous?: Pick<FieldDef, 'key'>): T {
  if (previous && field.key !== previous.key) throw new Error('已有字段的存储键不可修改，请修改显示名');
  if (builtInFieldType(field.key) && field.type !== builtInFieldType(field.key)) throw new Error(`内置字段“${field.label}”类型必须为 ${builtInFieldType(field.key)}，请修复字段类型`);
  return { ...field, validation: normalizeFieldValidation(field.validation) };
}
