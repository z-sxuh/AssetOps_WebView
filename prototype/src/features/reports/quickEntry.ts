import type { Unit } from '../../model';
import type { WorkEntry } from './types';
import { bindEntryScope } from './reportModel';

export type QuickEntryInput = { text: string; scope?: string };
export type SearchInsertRequest = QuickEntryInput & { request: number; token: string; statusOnly?: boolean };
export type SearchInsertResult = { request: number; token: string; error?: string };

export function quickEntry(input: QuickEntryInput, units: Unit[], at = new Date().toISOString()): WorkEntry {
  if (typeof input.text !== 'string' || !input.text.trim() || input.text.trim().length > 5000) throw new Error('工作记录不能为空，最多 5000 字');
  if (input.scope !== undefined && typeof input.scope !== 'string') throw new Error('工作记录归属无效');
  const entry: WorkEntry = { id: crypto.randomUUID(), text: input.text.trim(), section: '完成事项', scopeName: '', at, createdAt: at, updatedAt: at };
  return input.scope ? bindEntryScope(entry, input.scope, units, at) : entry;
}
