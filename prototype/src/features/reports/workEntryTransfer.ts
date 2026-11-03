import type { Unit } from '../../model';
import { scopeTree, scopeValue, type ScopeNode } from './reportModel';
import { reportSections, type WorkEntry } from './types';

const flatten = (node: ScopeNode): ScopeNode[] => [node, ...(node.children ?? []).flatMap(flatten)];
const matchesScope = (node: ScopeNode, entry: WorkEntry) => entry.systemId ? node.scope.systemId === entry.systemId : node.value === scopeValue(entry);

export function exportWorkEntries(entries: WorkEntry[], units: Unit[]) {
  const nodes = scopeTree(units).flatMap(flatten);
  return JSON.stringify({ format: 'workbench-work-entries', version: 1, entries: entries.map((entry) => ({ ...entry, scopeName: nodes.find((node) => matchesScope(node, entry))?.path ?? entry.scopeName })) }, null, 2);
}

export function parseWorkEntries(text: string, units: Unit[], existing: Pick<WorkEntry, 'id'>[]) {
  if (new TextEncoder().encode(text).byteLength > 64 * 1024 * 1024) throw new Error('工作记录文件不能超过 64 MB');
  const raw = JSON.parse(text);
  if (!raw || raw.format !== 'workbench-work-entries' || raw.version !== 1 || !Array.isArray(raw.entries)) throw new Error('请选择本应用导出的工作记录 JSON（版本 1）');
  const nodes = scopeTree(units).flatMap(flatten); const ids = new Set(existing.map((entry) => entry.id));
  const entries: WorkEntry[] = []; let skipped = 0;
  raw.entries.forEach((value: unknown, index: number) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`第 ${index + 1} 条工作记录格式无效`);
    const entry = value as WorkEntry;
    if (typeof entry.id !== 'string' || !entry.id || typeof entry.text !== 'string' || !entry.text.trim() || entry.text.length > 5000 || !reportSections.includes(entry.section) || typeof entry.scopeName !== 'string'
      || [entry.at, entry.createdAt, entry.updatedAt].some((time) => typeof time !== 'string' || Number.isNaN(Date.parse(time)))
      || [entry.unitId, entry.environmentId, entry.zoneId, entry.systemId].some((id) => id !== undefined && typeof id !== 'string')) throw new Error(`第 ${index + 1} 条工作记录的时间、类型或内容无效`);
    if (ids.has(entry.id)) { skipped++; return; }
    const sameId = nodes.find((node) => matchesScope(node, entry));
    const matches = sameId ? [sameId] : nodes.filter((node) => node.path === entry.scopeName);
    if (matches.length !== 1 && (entry.scopeName || scopeValue(entry) !== '[]')) throw new Error(`第 ${index + 1} 条记录的组织路径无法唯一匹配：${entry.scopeName || '未命名目录'}。请先导入对应组织目录`);
    entries.push({ id: entry.id, text: entry.text, section: entry.section, at: entry.at, createdAt: entry.createdAt, updatedAt: entry.updatedAt, scopeName: matches[0]?.path ?? entry.scopeName, ...matches[0]?.scope });
    ids.add(entry.id);
  });
  return { entries, skipped };
}
