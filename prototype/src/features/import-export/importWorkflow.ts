import { id, normalizeVault, type Account, type Asset, type AssetStatus, type ChangeRecord, type VaultData } from '../../model';
import { createAssetValidationContext, optionalNumber, validateAsset } from '../../assetValidation';
import { assetDiff } from '../../assetChanges';
import { passwordPolicyDefaults, rotationEnabled } from '../../passwordPolicy';
import type { ParsedImport } from '../../native';
import type { VaultSession } from '../../vaultSession';
import { resolveImportSystem, type ImportTarget } from './importRouting';
import { importFieldKey } from './importFields';
import { assetFieldDefaults } from '../../assetDefaults';

export type ImportRecord = Record<string, unknown> & { targetSystemId?: string; custom?: Record<string, unknown> };
export type ImportOptions = { columnMapping?: Record<string, string>; sheetColumnMapping?: Record<string, Record<string, string>>; sheetTargets?: Record<string, string>; mappingConfirmed?: boolean; defaultSystemId?: string };
export function confirmedImportMapping(mapping: Record<string, string>) {
  const selected = Object.values(mapping).filter(value => value !== '__auto__' && value !== '__ignore__');
  if (new Set(selected).size !== selected.length) throw new Error('两列不能映射到同一个字段');
  return Object.fromEntries(Object.entries(mapping).filter(([, value]) => value !== '__auto__'));
}
const statusList: AssetStatus[] = ['生产', '测试', '关机', '待切换'];
const stamp = () => new Date().toISOString();
const today = () => { const date = new Date(); return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`; };
const importTargets = (data: VaultData) => data.units.flatMap(unit => unit.environments.flatMap(environment => environment.zones.flatMap(zone => zone.systems.map(system => ({ unit, environment, zone, system })))));
const assetHostKey = (systemId: string, host: string) => JSON.stringify([systemId, host.toLowerCase()]);
const importedTags = (value: unknown) => (Array.isArray(value) ? value : String(value ?? '').split(/[,，;；\n]/)).map((tag) => String(tag).trim()).filter(Boolean);
const yieldImportTask = () => {
  const scheduler = (globalThis as { scheduler?: { yield?: () => Promise<void> } }).scheduler;
  if (scheduler?.yield) return scheduler.yield();
  return new Promise<void>(resolve => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => { channel.port1.close(); channel.port2.close(); resolve(); };
    channel.port2.postMessage(null);
  });
};

export type ImportRowStatus = 'add' | 'update' | 'same' | 'conflict' | 'error';

export interface ImportPreviewRow {
  id?: string;
  line: number;
  sheet?: string;
  status: ImportRowStatus;
  name?: string;
  host?: string;
  systemName?: string;
  message?: string;
  differences?: string[];
  conflictGroup?: string;
  resolvedStatus?: 'add' | 'update' | 'same';
  record: ImportRecord;
}

export interface ImportPreview {
  rows: ImportPreviewRow[];
  basis?: Pick<VaultData, 'assets' | 'fieldDefs' | 'units'>;
  projectName?: string;
  metadata?: string;
  warnings?: string[];
  sourceHeaders?: string[];
  sheetHeaders?: Record<string, string[]>;
  sourceSheets?: string[];
  suggestedSheetTargets?: Record<string, string>;
  requiresMapping?: boolean;
}

async function fieldFingerprint(fields: VaultData['fieldDefs']) {
  const normalized = [...fields]
    .sort((left, right) => left.sortOrder - right.sortOrder)
    .map((field) => ({ key: field.key, required: field.required, sortOrder: field.sortOrder, type: field.type, unique: field.unique }));
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(normalized)));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export const importedAsset = (data: VaultData, record: Record<string, unknown>, target: ImportTarget, existing?: Asset, fields = data.fieldDefs.filter((field) => field.systemId === target.system.id)): Asset => {
    const present = new Set(Array.isArray(record.presentColumns) ? record.presentColumns as string[] : []);
    const host = String(record.host ?? '').trim();
    const importedAccounts = Array.isArray(record.accounts) ? record.accounts as Account[] : [];
    if (present.has('passwords') && !present.has('accounts') && importedAccounts.some(account => account.password !== '')) throw new Error('密码列有值但缺少账号列，请补充明确的账号后重新预检');
    const accounts = present.has('accounts') && importedAccounts.length ? importedAccounts.map((account) => {
      const previous = existing?.accounts.find((item) => item.username.trim().toLowerCase() === account.username.trim().toLowerCase());
      const password = account.password || previous?.password || '';
      return { ...account, id: previous?.id ?? id(), password,
        passwordUpdatedAt: previous && password === previous.password ? previous.passwordUpdatedAt || today() : today() };
    }) : existing?.accounts ?? [];
    const value = (key: string, fallback: unknown) => present.has(key) && record[key] !== null && record[key] !== undefined && !(typeof record[key] === 'string' && !String(record[key]).trim()) ? record[key] : fallback;
    const policyDefaults = passwordPolicyDefaults(fields);
    const defaults = assetFieldDefaults(fields);
    return {
      id: existing?.id ?? id(), unitId: target.unit.id, environmentId: target.environment.id, zoneId: target.zone.id, systemId: target.system.id,
      businessSystem: String(value('businessSystem', existing?.businessSystem ?? defaults.businessSystem ?? '') ?? ''),
      name: String(value('name', existing?.name ?? defaults.name ?? host) || host), host,
      ip: String(value('ip', existing?.ip ?? defaults.ip ?? '') ?? ''), ip2: String(value('ip2', existing?.ip2 ?? defaults.ip2 ?? '') ?? ''),
      status: statusList.includes(record.status as AssetStatus) ? record.status as AssetStatus : existing?.status ?? '生产',
      cpu: optionalNumber(value('cpu', existing ? existing.cpu : defaults.cpu ?? null)), memory: optionalNumber(value('memory', existing ? existing.memory : defaults.memory ?? null)),
      os: String(value('os', existing?.os ?? defaults.os ?? '') ?? ''),
      disks: present.has('disks') && Array.isArray(record.disks) && record.disks.length ? record.disks as Asset['disks'] : existing?.disks ?? [],
      accounts,
      rotatePassword: rotationEnabled(value('rotatePassword', existing?.rotatePassword ?? policyDefaults.rotatePassword)),
      passwordCycleDays: Number(value('passwordCycleDays', existing?.passwordCycleDays ?? policyDefaults.passwordCycleDays) ?? existing?.passwordCycleDays ?? policyDefaults.passwordCycleDays) || 0,
      custom: { ...(existing ? existing.custom : defaults.custom), ...Object.fromEntries(Object.entries(record.custom && typeof record.custom === 'object' ? record.custom : {}).filter(([, value]) => value !== null && value !== undefined && !(typeof value === 'string' && !value.trim()))) },
      tags: present.has('asset:tags') ? importedTags(record.tags) : existing?.tags ?? [], createdAt: existing?.createdAt ?? stamp(), updatedAt: stamp(),
    };
  };

export const previewImport = async (data: VaultData, parsed: ParsedImport, options: ImportOptions = {}): Promise<ImportPreview> => {
    const systemOptions = importTargets(data);
    if (!systemOptions.length) throw new Error('请先创建目标系统');
    const validation = createAssetValidationContext(data.assets, data);
    const existingByHost = new Map<string, Asset>();
    for (const asset of data.assets) {
      const key = assetHostKey(asset.systemId, asset.host);
      if (!existingByHost.has(key)) existingByHost.set(key, asset);
    }
    const sheets = Array.from(new Set(parsed.rows.map((record) => String(record.sheet ?? ''))));
    const targetBySheet = Object.fromEntries(sheets.map((sheet) => {
      const source = parsed.metadata?.systems?.find((item) => item.sheetName === sheet)
        ?? parsed.metadata?.systems?.find((item) => item.system === sheet);
      const sheetMatches = systemOptions.filter((item) => item.system.name === sheet);
      const sourceMatches = systemOptions.filter((item) => item.unit.name === source?.unit && item.system.name === source?.system);
      const target = systemOptions.find((item) => item.system.id === options.sheetTargets?.[sheet])
        ?? systemOptions.find((item) => item.system.id === options.defaultSystemId)
        ?? systemOptions.find((item) => item.system.id === source?.systemId)
        ?? (sourceMatches.length === 1 ? sourceMatches[0] : undefined)
        ?? (sheetMatches.length === 1 ? sheetMatches[0] : undefined);
      return [sheet, target?.system.id ?? ''];
    }));
    const errorsByRow = new Map<string, string[]>();
    for (const error of parsed.errors) {
      const key = `${error.sheet}:${error.rowNumber}`;
      errorsByRow.set(key, [...(errorsByRow.get(key) ?? []), `${error.column}：${error.message}`]);
    }
    const routing = parsed.rows.map((record) => { const sheet = String(record.sheet ?? ''); return resolveImportSystem(record, systemOptions, parsed.metadata?.systemChoices, targetBySheet[sheet], options.sheetTargets?.[sheet]); });
    const hostCounts = parsed.rows.reduce((counts, record, index) => {
      const host = String(record.host ?? '').trim().toLowerCase();
      const targetId = routing[index].target?.system.id;
      if (host && targetId) { const key = `${targetId}:${host}`; counts.set(key, (counts.get(key) ?? 0) + 1); }
      return counts;
    }, new Map<string, number>());
    const unknownHeaders = new Set<string>();
    const candidates: Array<Asset | undefined> = [];
    const candidateGroups = new Map<string, number[]>();
    const fieldsByHeader = new Map<string, { keys: Map<string, VaultData['fieldDefs'][number]>; labels: Map<string, VaultData['fieldDefs'][number] | null> }>();
    const rows: ImportPreviewRow[] = [];
    for (let index = 0; index < parsed.rows.length; index++) {
      const record = parsed.rows[index];
      if (parsed.rows.length > 1000 && index && index % 250 === 0) await yieldImportTask();
      const sheet = String(record.sheet ?? '');
      const { target, error: routingError } = routing[index];
      const existing = target ? existingByHost.get(assetHostKey(target.system.id, String(record.host ?? '').trim())) : undefined;
      const rowErrors = [...(errorsByRow.get(`${sheet}:${Number(record.rowNumber ?? index + 2)}`) ?? [])];
      const targetFields = validation.fieldsBySystem.get(target?.system.id ?? '') ?? [];
      let fieldHeaders = fieldsByHeader.get(target?.system.id ?? '');
      if (!fieldHeaders) {
        fieldHeaders = { keys: new Map(), labels: new Map() };
        for (const field of targetFields) {
          const key = field.key.toLowerCase(), label = field.label.toLowerCase();
          if (!fieldHeaders.keys.has(key)) fieldHeaders.keys.set(key, field);
          fieldHeaders.labels.set(label, fieldHeaders.labels.has(label) ? null : field);
        }
        fieldsByHeader.set(target?.system.id ?? '', fieldHeaders);
      }
      const present = new Set(Array.isArray(record.presentColumns) ? record.presentColumns as string[] : []);
      const builtIn: Record<string, unknown> = {};
      const custom = Object.fromEntries(Object.entries(record.custom && typeof record.custom === 'object' ? record.custom as Record<string, unknown> : {}).flatMap(([header, fieldValue]) => {
        const key = header.trim().toLowerCase();
        const field = fieldHeaders.keys.get(key) ?? fieldHeaders.labels.get(key);
        if (!field) {
          unknownHeaders.add(header);
          if (target && fieldValue !== '') rowErrors.push(`目标系统“${target.system.name}”没有唯一对应的字段“${header}”，请映射或明确忽略此列`);
          return [];
        }
        const value = field.type === 'integer' && fieldValue !== '' ? Number(fieldValue)
          : field.type === 'boolean' && ['true', '是', '1', 'false', '否', '0'].includes(String(fieldValue).toLowerCase()) ? ['true', '是', '1'].includes(String(fieldValue).toLowerCase()) : fieldValue;
        const targetKey = importFieldKey(field.key);
        // 显示名回退匹配也要还原资产内置键，避免有值的 IP 被误存进 custom 后报必填。
        if (['name', 'ip_1', 'ip_2', 'cpu', 'mem', 'os', 'status', 'business_system', 'pwd_rotate', 'pwd_cycle_days'].includes(field.key)) {
          if (present.has(targetKey)) { unknownHeaders.add(header); rowErrors.push(`多列对应字段“${field.label}”，请映射或忽略重复列`); }
          else { builtIn[targetKey] = value; present.add(targetKey); }
          return [];
        }
        return [[field.key, value]];
      }));
      const normalizedRecord = { ...record, ...builtIn, presentColumns: [...present], custom, targetSystemId: target?.system.id };
      const line = Number(record.rowNumber ?? index + 2);
      const host = String(record.host ?? '').trim();
      if (routingError) rowErrors.push(routingError);
      if (target && !targetFields.length) rowErrors.push('目标系统还没有保存字段，请先配置字段模板');
      let candidate: Asset | undefined;
      try { candidate = target ? importedAsset(data, normalizedRecord, target, existing, targetFields) : undefined; }
      catch (error) { rowErrors.push(error instanceof Error ? error.message : String(error)); }
      candidates[index] = candidate;
      if (candidate) {
        validation.add(candidate);
        const key = assetHostKey(candidate.systemId, candidate.host);
        const group = candidateGroups.get(key) ?? [];
        group.push(index); candidateGroups.set(key, group);
      }
      const differences = existing && candidate ? assetDiff(existing, candidate).map((item) => ['accounts', 'custom'].includes(item.fieldKey)
        ? `${item.fieldLabel}: 有变更`
        : `${item.fieldLabel}: ${String(item.before ?? '—')} → ${String(item.after ?? '—')}`) : [];
      const duplicate = (hostCounts.get(`${target?.system.id}:${host.toLowerCase()}`) ?? 0) > 1;
      const resolvedStatus = existing ? (differences.length ? 'update' : 'same') : 'add';
      const status = rowErrors.length || !host ? 'error' : duplicate ? 'conflict' : resolvedStatus;
      rows.push({ id: `${sheet}-${line}-${host}`, line, sheet, status, name: candidate?.name ?? String(record.name ?? ''), host, systemName: target ? [target.unit.name, target.environment.name, target.zone.name, target.system.name].filter(Boolean).join(' / ') : String(record.system ?? ''),
        message: rowErrors.join('；') || (duplicate ? '工作簿中同一系统存在重复主机名，请选用一行' : ''),
        conflictGroup: duplicate ? `${target?.system.id}:${host.toLowerCase()}` : undefined,
        resolvedStatus: duplicate ? resolvedStatus : undefined,
        differences, record: normalizedRecord });
    }
    let validated = 0;
    for (const group of candidateGroups.values()) {
      if (parsed.rows.length > 1000 && ++validated % 250 === 0) await yieldImportTask();
      // 同主机名候选交给冲突裁决；原库记录仍参与校验。
      for (const index of group) validation.remove(candidates[index]!);
      for (const index of group) {
        const errors = validateAsset(candidates[index]!, data.assets, data, validation);
        if (errors.length) rows[index] = { ...rows[index], status: 'error', message: [rows[index].message, ...new Set(errors)].filter(Boolean).join('；') };
      }
      for (const index of group) validation.add(candidates[index]!);
    }
    const warnings: string[] = [];
    if (parsed.errors.length) warnings.push('错误行不会写入，请修正列映射或源文件。');
    if (unknownHeaders.size) warnings.push(`待处理列：${Array.from(unknownHeaders).join('、')}。`);
    for (const sheet of sheets) {
      const target = systemOptions.find((item) => item.system.id === targetBySheet[sheet]);
      const source = parsed.metadata?.systems?.find((item) => item.sheetName === sheet || item.system === sheet);
      if (source && target && source.fieldFingerprint !== await fieldFingerprint(validation.fieldsBySystem.get(target.system.id) ?? [])) {
        warnings.push(`工作表“${sheet}”字段定义与导出时不同，请检查列映射。`);
      }
    }
    const requiresMapping = !options.mappingConfirmed && ((!parsed.metadata?.systems?.length && !parsed.metadata?.systemChoices?.length) || (parsed.unmappedHeaders?.length ?? 0) > 0 || unknownHeaders.size > 0 || warnings.some((warning) => warning.includes('字段定义')) || routing.some((item) => !item.target));
    return { rows, basis: { assets: data.assets, fieldDefs: data.fieldDefs, units: data.units }, metadata: `共 ${rows.length} 行 · ${rows.filter((row) => row.status === 'error').length} 个错误行 · ${sheets.length} 个工作表`, warnings,
      sourceHeaders: parsed.headers, sheetHeaders: parsed.sheetHeaders, sourceSheets: sheets, suggestedSheetTargets: targetBySheet, requiresMapping };
  };

export const buildImport = (data: VaultData, records: ImportRecord[], batchId: string) => {
    const systemOptions = importTargets(data), hosts = new Set<string>();
    const targetsById = new Map<string, ImportTarget>();
    for (const target of systemOptions) if (!targetsById.has(target.system.id)) targetsById.set(target.system.id, target);
    const assets = [...data.assets], changes: ChangeRecord[] = [];
    const validation = createAssetValidationContext(assets, data);
    const positionsByHost = new Map<string, Set<number>>(), positionsById = new Map<string, number[]>();
    const indexHost = (asset: Asset, position: number) => {
      const key = assetHostKey(asset.systemId, asset.host), positions = positionsByHost.get(key) ?? new Set<number>();
      positions.add(position); positionsByHost.set(key, positions);
    };
    assets.forEach((asset, position) => {
      indexHost(asset, position);
      const positions = positionsById.get(asset.id) ?? [];
      positions.push(position); positionsById.set(asset.id, positions);
    });
    for (const record of records) {
      const target = targetsById.get(record.targetSystemId ?? '');
      if (!target) throw new Error('导入记录缺少目标系统，请重新预检');
      const fields = validation.fieldsBySystem.get(target.system.id) ?? [];
      if (!fields.length) throw new Error('目标系统还没有保存字段，请先配置字段模板');
      const host = String(record.host ?? '').trim();
      const duplicateKey = `${target.system.id}:${host.toLowerCase()}`;
      if (hosts.has(duplicateKey)) throw new Error('同一系统的重复主机名只能选用一行');
      hosts.add(duplicateKey);
      let firstPosition = Infinity;
      for (const position of positionsByHost.get(assetHostKey(target.system.id, host)) ?? []) firstPosition = Math.min(firstPosition, position);
      const existing = assets[firstPosition];
      const next = importedAsset(data, record, target, existing, fields);
      const validationErrors = validateAsset(next, assets, data, validation);
      if (validationErrors.length) throw new Error(`资产 ${next.name}：${validationErrors.join('；')}`);
      const items = assetDiff(existing, next);
      if (items.length) {
        const positions = existing ? positionsById.get(existing.id)! : [assets.length];
        for (const position of positions) {
          const previous = assets[position];
          if (previous) {
            validation.remove(previous);
            positionsByHost.get(assetHostKey(previous.systemId, previous.host))?.delete(position);
          }
          assets[position] = next; validation.add(next); indexHost(next, position);
        }
        if (!existing) {
          const previous = positionsById.get(next.id) ?? [];
          positionsById.set(next.id, [...previous, ...positions]);
        }
        changes.push({ id: id(), at: stamp(), assetName: next.name, objectName: next.name, action: existing ? '编辑' : '新增', assetId: next.id, systemId: next.systemId, objectType: 'asset', objectId: next.id, source: '导入', batchId, before: existing, after: next, items });
      }
    }
    return { next: normalizeVault({ ...data, assets, history: [...changes, ...data.history] }), changes: changes.length };
  };

export type NormalizedImportRow = ImportPreviewRow & { id: string };
export type ImportSelection = { preview: ImportPreview; selectedIds: string[]; conflicts: Record<string, string> };
export const selectableImportRow = (row: ImportPreviewRow) => ['add', 'update', 'same'].includes(row.status);
export function resolveImportRows(preview: ImportPreview | null, conflicts: Record<string, string> = {}): NormalizedImportRow[] {
  return (preview?.rows ?? []).map((row, index) => {
    const id = row.id || `${row.line || index + 2}-${index}`;
    const chosen = row.status === 'conflict' && row.conflictGroup && conflicts[row.conflictGroup] === id;
    return { ...row, id, status: chosen ? row.resolvedStatus ?? 'add' : row.status, message: chosen ? '已选用此行，其余同主机名行将跳过' : row.message };
  });
}
export function chooseImportConflict(selection: ImportSelection, rowId: string): ImportSelection {
  const rows = resolveImportRows(selection.preview, selection.conflicts), row = rows.find(item => item.id === rowId);
  if (!row?.conflictGroup || row.status === 'error') return selection;
  const conflicts = { ...selection.conflicts }, selected = conflicts[row.conflictGroup] === rowId;
  if (selected) delete conflicts[row.conflictGroup]; else conflicts[row.conflictGroup] = rowId;
  const group = new Set(rows.filter(item => item.conflictGroup === row.conflictGroup).map(item => item.id));
  const remaining = selection.selectedIds.filter(id => !group.has(id));
  return { ...selection, conflicts, selectedIds: selected ? remaining : [...remaining, rowId] };
}
export function selectedImportRecords(selection: ImportSelection) {
  if (selection.preview.requiresMapping) throw new Error('请先确认列映射和目标系统');
  const keys = new Set(selection.selectedIds), rows = resolveImportRows(selection.preview, selection.conflicts).filter(row => keys.has(row.id));
  if (rows.length !== keys.size || rows.some(row => !selectableImportRow(row))) throw new Error('导入选择已失效，请重新预检或裁决冲突');
  return rows.map(row => row.record);
}
export function importPreviewCurrent(preview: ImportPreview, data: Pick<VaultData, 'assets' | 'fieldDefs' | 'units'>) {
  return !preview.basis || (['assets', 'fieldDefs', 'units'] as const).every(key => preview.basis![key] === data[key] || JSON.stringify(preview.basis![key]) === JSON.stringify(data[key]));
}
export function importAssets(session: VaultSession, expected: VaultData, selection: ImportSelection, batchId: string, backup?: () => Promise<unknown>) {
  return session.run(expected, async transaction => {
    if (!importPreviewCurrent(selection.preview, expected)) throw new Error('资产、字段或组织目录已变化，请重新预检后确认导入');
    const plan = buildImport(expected, selectedImportRecords(selection), batchId);
    if (plan.changes && backup) await backup();
    await transaction.save(plan.next);
  }, true);
}
