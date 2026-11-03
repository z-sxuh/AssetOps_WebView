import type { ChangeRecord, VaultData } from '../../model';
import { normalizeChangeRecord } from '../../model';
import type { VaultSession } from '../../vaultSession';
import { shiftDate, validDate } from '../reports/reportModel';

export type ArchivePeriod = 'week' | 'month';
export type ArchiveRange = { period: ArchivePeriod; start: string; end: string };
export type HistoryArchive = ArchiveRange & { format: 'assetops-history'; version: 1; exportedAt: string; records: ChangeRecord[]; insecureLegacy?: boolean };
export type ArchiveExport = { path: string; archive: HistoryArchive };
export type ArchiveDriver = {
  export(ids: string[], range: ArchiveRange): Promise<ArchiveExport>;
  compact(): Promise<void>;
  backup?(): Promise<unknown>;
};

export function archiveRange(date: string, period: ArchivePeriod): ArchiveRange {
  if (!validDate(date)) throw new Error('请选择有效归档日期');
  const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
  const start = period === 'week' ? shiftDate(date, -((weekday + 6) % 7)) : `${date.slice(0, 7)}-01`;
  const end = period === 'week' ? shiftDate(start, 7) : new Date(Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)), 1)).toISOString().slice(0, 10);
  return { period, start: `${start}T00:00:00+08:00`, end: `${end}T00:00:00+08:00` };
}
export function recordsInArchiveRange(records: ChangeRecord[], range: ArchiveRange) {
  const start = Date.parse(range.start), end = Date.parse(range.end);
  return records.filter(record => { const at = Date.parse(record.at); return at >= start && at < end; });
}
// Native JSON 的对象键顺序可能不同；只比较内容，不把序列化顺序当成变更。
const canonical = (value: unknown): string => JSON.stringify(value, (_, current) => current && typeof current === 'object' && !Array.isArray(current) ? Object.fromEntries(Object.keys(current).sort().map(key => [key, current[key]])) : current);

function validateRecord(record: ChangeRecord) {
  const invalid = (field: string): never => { throw new Error(`记录 ${typeof record?.id === 'string' ? record.id : '未知'} 的 ${field} 格式无效`); };
  if (!record || typeof record.id !== 'string' || !record.id) invalid('id');
  if (typeof record.at !== 'string' || !Number.isFinite(Date.parse(record.at))) invalid('at');
  if (typeof record.assetName !== 'string' || !['新增', '编辑', '删除', '恢复', '回滚'].includes(record.action)) invalid('assetName/action');
  for (const key of ['assetId', 'systemId', 'objectType', 'objectId', 'objectName', 'source', 'batchId', 'operator', 'note'] as const) if (record[key] !== undefined && typeof record[key] !== 'string') invalid(key);
  if (record.items === undefined) return;
  if (!Array.isArray(record.items)) invalid('items');
  for (const item of record.items) {
    if (!item || typeof item.fieldKey !== 'string') invalid('items.fieldKey');
    if (item.fieldLabel !== undefined && typeof item.fieldLabel !== 'string') invalid('items.fieldLabel');
    if (item.fieldKey === 'accounts') for (const side of ['before', 'after'] as const) {
      const value = item[side];
      if (value == null) continue;
      if (!Array.isArray(value) || value.some(account => !account || typeof account !== 'object' || Array.isArray(account) || ['id', 'username', 'password'].some(key => account[key] !== undefined && typeof account[key] !== 'string'))) invalid(`items.accounts.${side}`);
    }
  }
}

function* mergingHistoryArchive(existing: ChangeRecord[], archive: HistoryArchive) {
  if (archive.format !== 'assetops-history' || archive.version !== 1 || !archive.records.length) throw new Error('历史归档格式无效');
  const previous = new Map<string, ChangeRecord>();
  for (const record of existing) { previous.set(record.id, record); yield; }
  const imported = new Set<string>();
  const additions: ChangeRecord[] = [];
  for (const raw of archive.records) {
    validateRecord(raw);
    const record = normalizeChangeRecord(raw);
    if (!record.id || imported.has(record.id)) throw new Error('归档中存在重复或无效记录');
    imported.add(record.id);
    const current = previous.get(record.id);
    if (current && canonical(normalizeChangeRecord(current)) !== canonical(record)) throw new Error(`记录 ${record.id} 与现有记录冲突，导入已取消`);
    if (!current) additions.push(record);
    yield;
  }
  return { history: [...additions, ...existing].sort((a, b) => b.at.localeCompare(a.at)), added: additions.length, skipped: archive.records.length - additions.length };
}

export function mergeHistoryArchive(existing: ChangeRecord[], archive: HistoryArchive) {
  const work = mergingHistoryArchive(existing, archive);
  let step = work.next();
  while (!step.done) step = work.next();
  return step.value;
}

async function mergeHistoryArchiveAsync(existing: ChangeRecord[], archive: HistoryArchive, check: () => void) {
  check();
  const work = mergingHistoryArchive(existing, archive);
  let deadline = performance.now() + 8, step = work.next();
  while (!step.done) {
    if (performance.now() >= deadline) {
      await new Promise<void>(resolve => { const channel = new MessageChannel(); channel.port1.onmessage = () => { channel.port1.close(); channel.port2.close(); resolve(); }; channel.port2.postMessage(null); });
      check(); deadline = performance.now() + 8;
    }
    step = work.next();
  }
  check();
  return step.value;
}

const previews = new WeakMap<HistoryArchive, { session: VaultSession; expected: VaultData; generation: number; result: ReturnType<typeof mergeHistoryArchive> }>();
const archiveCheck = (session: VaultSession, expected: VaultData, generation: number, signal?: AbortSignal) => () => {
  signal?.throwIfAborted();
  if (session.getGeneration() !== generation || session.getSnapshot().stage !== 'ready') throw new Error('数据仓库已锁定或替换，请重新导入');
  if (session.getSnapshot().data !== expected) throw new Error('数据已更新，请重新导入');
};
export async function prepareHistoryArchive(session: VaultSession, expected: VaultData, archive: HistoryArchive, signal?: AbortSignal) {
  const generation = session.getGeneration();
  const result = await mergeHistoryArchiveAsync(expected.history, archive, archiveCheck(session, expected, generation, signal));
  previews.set(archive, { session, expected, generation, result });
  return { added: result.added, skipped: result.skipped };
}

export async function archiveHistory(session: VaultSession, expected: VaultData, records: ChangeRecord[], range: ArchiveRange, driver: ArchiveDriver) {
  return session.run(expected, async transaction => {
    const generation = session.getGeneration();
    const ids = new Set(records.map(record => record.id));
    if (!ids.size || ids.size !== records.length || recordsInArchiveRange(records, range).length !== records.length) throw new Error('归档记录或日期范围无效');
    const original = expected.history.filter(record => ids.has(record.id));
    const chosen = new Map(records.map(record => [record.id, record]));
    if (original.length !== records.length || original.some(record => canonical(record) !== canonical(chosen.get(record.id)))) throw new Error('记录已更新，请重新归档');
    const result = await driver.export([...ids], range);
    if (result.archive.period !== range.period || result.archive.start !== range.start || result.archive.end !== range.end || result.archive.records.length !== original.length || (await mergeHistoryArchiveAsync(original, result.archive, archiveCheck(session, expected, generation))).added) throw new Error('归档回读内容与当前记录不一致，数据库记录已保留');
    await driver.backup?.();
    await transaction.save({ ...expected, history: expected.history.filter(record => !ids.has(record.id)) });
    let compactError: string | undefined;
    try { await driver.compact(); } catch (error) { compactError = error instanceof Error ? error.message : String(error); }
    return { ...result, removed: ids.size, compactError };
  });
}

export function importHistoryArchive(session: VaultSession, expected: VaultData, archive: HistoryArchive) {
  return session.run(expected, async transaction => {
    const generation = session.getGeneration(), preview = previews.get(archive);
    const result = preview?.session === session && preview.expected === expected && preview.generation === generation ? preview.result : await mergeHistoryArchiveAsync(expected.history, archive, archiveCheck(session, expected, generation));
    previews.delete(archive);
    if (result.added) await transaction.save({ ...expected, history: result.history });
    return result;
  });
}
