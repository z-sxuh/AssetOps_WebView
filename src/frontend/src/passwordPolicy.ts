import type { Account, Asset, FieldDef } from './model';

export const rotationEnabled = (value: unknown) => value === true || value === 1 || ['true', '是', '1'].includes(String(value).trim().toLowerCase());

export function passwordPolicyDefaults(fields: FieldDef[]) {
  return {
    rotatePassword: rotationEnabled(fields.find((field) => field.key === 'pwd_rotate')?.defaultValue),
    passwordCycleDays: Number(fields.find((field) => field.key === 'pwd_cycle_days')?.defaultValue) || undefined,
  };
}

export function updateAccountDates(accounts: Account[], previous: Account[], date: string): Account[] {
  return accounts.filter((account) => account.username.trim()).map((account) => {
    const username = account.username.trim();
    const old = account.id ? previous.find((item) => item.id === account.id) : previous.find((item) => item.username === username);
    return { ...account, id: account.id || old?.id || crypto.randomUUID(), username, passwordUpdatedAt: old && old.password === account.password ? old.passwordUpdatedAt || date : date };
  });
}

export const selectedAccount = (asset: Pick<Asset, 'accounts'>, accountId?: string) => asset.accounts.find((account) => account.id === accountId && accountId) ?? asset.accounts[0];

export function accountExpiryDate(asset: Pick<Asset, 'rotatePassword' | 'passwordCycleDays'>, account: Pick<Account, 'passwordUpdatedAt'>) {
  if (!rotationEnabled(asset.rotatePassword) || !Number.isInteger(asset.passwordCycleDays) || asset.passwordCycleDays < 1 || !account.passwordUpdatedAt) return null;
  const value = account.passwordUpdatedAt;
  const date = /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T00:00:00`) : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  date.setDate(date.getDate() + asset.passwordCycleDays);
  return date;
}
