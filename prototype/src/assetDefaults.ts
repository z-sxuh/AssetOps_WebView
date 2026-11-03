import type { FieldDef } from './model';
import { emptyValue } from './assetValidation';
import { passwordPolicyDefaults, rotationEnabled } from './passwordPolicy';

const builtInKeys: Record<string, string> = { business_system: 'businessSystem', name: 'name', host: 'host', ip_1: 'ip', ip_2: 'ip2', cpu: 'cpu', mem: 'memory', os: 'os', status: 'status' };
const managedKeys = new Set(['disks', 'user', 'password', 'updated_at', 'created_at', 'pwd_rotate', 'pwd_cycle_days', 'pwd_expire_at']);

export function assetFieldDefaults(fields: FieldDef[]): Record<string, unknown> & { custom: Record<string, string | number | boolean>; rotatePassword: boolean; passwordCycleDays?: number } {
  const values: Record<string, unknown> = {};
  const custom: Array<[string, string | number | boolean]> = [];
  for (const field of fields) {
    const fallback = field.defaultValue;
    if (managedKeys.has(field.key)) continue;
    if (emptyValue(fallback)) {
      if (!Object.hasOwn(builtInKeys, field.key)) custom.push([field.key, '']);
      continue;
    }
    if (typeof fallback !== 'string' && typeof fallback !== 'number' && typeof fallback !== 'boolean') continue;
    const value = field.type === 'integer' ? Number(fallback) : field.type === 'boolean' ? rotationEnabled(fallback) : fallback;
    if (Object.hasOwn(builtInKeys, field.key)) values[builtInKeys[field.key]] = value;
    else custom.push([field.key, value]);
  }
  return { ...values, ...passwordPolicyDefaults(fields), custom: Object.fromEntries(custom) };
}
