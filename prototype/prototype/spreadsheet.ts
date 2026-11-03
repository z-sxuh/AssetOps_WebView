import JSZip from 'jszip';
import { defaultFields, type VaultData } from '../src/model';
import { parseDisks } from '../src/disks';
import type { ParsedImport } from '../src/native';

const xml = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[character]!));
const columnName = (index: number): string => index < 26 ? String.fromCharCode(65 + index) : columnName(Math.floor(index / 26) - 1) + String.fromCharCode(65 + index % 26);
export async function workbook(sheets: Array<{ name: string; rows: unknown[][] }>): Promise<Blob> {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${sheets.map((_, index) => `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}</Types>`);
  zip.file('_rels/.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>');
  zip.file('xl/workbook.xml', `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets.map((sheet, index) => `<sheet name="${xml(sheet.name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`).join('')}</sheets></workbook>`);
  zip.file('xl/_rels/workbook.xml.rels', `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, index) => `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`).join('')}</Relationships>`);
  for (const [index, sheet] of sheets.entries()) zip.file(`xl/worksheets/sheet${index + 1}.xml`, `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${sheet.rows.map((row, rowIndex) => `<row r="${rowIndex + 1}">${row.map((value, column) => `<c r="${columnName(column)}${rowIndex + 1}" t="inlineStr"><is><t xml:space="preserve">${xml(value)}</t></is></c>`).join('')}</row>`).join('')}</sheetData></worksheet>`);
  return zip.generateAsync({ type: 'blob', compression: 'DEFLATE', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
}

export function assetSheets(data: VaultData, options: Record<string, any>) {
  const headers = ['单位', '环境', '网络区域', '系统', '服务器名称', '主机名', '内网IP', 'CPU', '内存', '硬盘', '账号', '密码', '操作系统', '服务器状态', '业务系统', '备注'];
  const selected = data.assets.filter(asset => (!options.systemId || asset.systemId === options.systemId) && (!options.assetIds || options.assetIds.includes(asset.id)));
  const groups = new Map<string, { name: string; rows: unknown[][] }>();
  const usedNames = new Set<string>(['字段说明', '历史变更']);
  for (const asset of options.templateOnly ? [] : selected) {
    const unit = data.units.find(unit => unit.id === asset.unitId), environment = unit?.environments.find(environment => environment.id === asset.environmentId), zone = environment?.zones.find(zone => zone.id === asset.zoneId), system = zone?.systems.find(system => system.id === asset.systemId);
    let group = groups.get(asset.systemId);
    if (!group) {
      const base = (system?.name || '资产台账').replace(/[\[\]:*?/\\]/g, '_').slice(0, 24);
      let name = base;
      for (let index = 2; usedNames.has(name); index++) name = `${base}-${index}`;
      usedNames.add(name); group = { name, rows: [headers] }; groups.set(asset.systemId, group);
    }
    group.rows.push([unit?.name, environment?.name, zone?.name, system?.name, asset.name, asset.host, asset.ip, asset.cpu, asset.memory, asset.disks.map(disk => `${disk.label}|${disk.capacity}${disk.unit ?? 'G'}`).join('\n'), asset.accounts.map(account => account.username).join('\n'), asset.accounts.map(account => options.includePasswords ? account.password : '******').join('\n'), asset.os, asset.status, asset.businessSystem, asset.custom?.notes]);
  }
  const sheets = groups.size ? [...groups.values()] : [{ name: '资产台账', rows: [headers] }];
  if (options.includeFieldDescriptions) sheets.push({ name: '字段说明', rows: [['字段', '说明'], ...defaultFields('').map(field => [field.label, field.templateNote])] });
  if (options.includeHistory) sheets.push({ name: '历史变更', rows: auditRows(data, Boolean(options.includePasswords)) });
  return { sheets, count: options.templateOnly ? 0 : selected.length };
}

export function auditRows(data: VaultData, includePasswords = false) {
  const text = (value: unknown, key: string): string => {
    if (/password|accounts/i.test(key) && !includePasswords) return '******';
    if (value && typeof value === 'object') return JSON.stringify(value, (field, item) => !includePasswords && /password/i.test(field) ? '******' : item);
    return String(value ?? '');
  };
  return [['时间', '对象', '动作', '来源', '字段', '变更前', '变更后'], ...data.history.flatMap(record => (record.items?.length ? record.items : [{ fieldKey: 'snapshot', fieldLabel: '快照', before: record.before, after: record.after }]).map(item => [record.at, record.objectName ?? record.assetName, record.action, record.source ?? '手动', item.fieldLabel ?? item.fieldKey, text(item.before, item.fieldKey), text(item.after, item.fieldKey)]))];
}

export async function parseSpreadsheet(bytes: ArrayBuffer, mapping: Record<string, string> = {}, sheetMapping: Record<string, Record<string, string>> = {}): Promise<ParsedImport> {
  if (bytes.byteLength > 64 * 1024 * 1024) throw new Error('Excel 文件不能超过 64 MB');
  const zip = await JSZip.loadAsync(bytes);
  let expanded = 0;
  const read = async (name: string) => {
    const entry = zip.file(name); if (!entry) return '';
    const declaredSize = (entry as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize ?? 0;
    if (declaredSize > 32 * 1024 * 1024 || expanded + declaredSize > 64 * 1024 * 1024) throw new Error('工作簿解压内容过大，请使用小型演示文件');
    const value = await entry.async('string'); expanded += value.length * 2;
    if (expanded > 64 * 1024 * 1024) throw new Error('工作簿内容过大');
    return value;
  };
  const parse = (value: string) => new DOMParser().parseFromString(value, 'application/xml');
  const shared = [...parse(await read('xl/sharedStrings.xml')).getElementsByTagName('si')].map(item => item.textContent ?? '');
  const relationships = new Map([...parse(await read('xl/_rels/workbook.xml.rels')).getElementsByTagName('Relationship')].map(item => [item.getAttribute('Id'), item.getAttribute('Target')!]));
  const sheets = [...parse(await read('xl/workbook.xml')).getElementsByTagName('sheet')];
  if (!sheets.length) throw new Error('HTML 原型支持标准 .xlsx 工作簿，请先将旧版 .xls 另存为 .xlsx');
  const labels: Record<string, string> = { 单位: 'unit', 环境: 'environment', 网络区域: 'zone', 系统: 'system', 服务器名称: 'name', 主机名: 'host', 内网IP: 'ip', 内网ip: 'ip', 外网IP: 'ip2', CPU: 'cpu', cpu: 'cpu', 内存: 'memory', 硬盘: 'disks', 磁盘: 'disks', 账号: 'accounts', 密码: 'passwords', 操作系统: 'os', 服务器状态: 'status', 业务系统: 'businessSystem', 定期修改密码: 'rotatePassword', 密码更新周期: 'passwordCycleDays', 备注: 'notes', 资产标签: 'asset:tags' };
  const aliases: Record<string, string> = { ip_1: 'ip', ip_2: 'ip2', mem: 'memory', user: 'accounts', password: 'passwords', pwd_rotate: 'rotatePassword', pwd_cycle_days: 'passwordCycleDays', business_system: 'businessSystem' };
  const rows: ParsedImport['rows'] = [], errors: ParsedImport['errors'] = [], headers = new Set<string>(), sheetHeaders: Record<string, string[]> = {}, unknown = new Set<string>();
  for (const sheet of sheets) {
    const name = sheet.getAttribute('name') ?? 'Sheet1';
    if (['字段说明', '历史变更'].includes(name)) continue;
    const target = relationships.get(sheet.getAttribute('r:id')) ?? '';
    const fileName = target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\.\//, '')}`;
    const sheetRows = [...parse(await read(fileName)).getElementsByTagName('row')];
    const values = (row: Element) => {
      const cells: string[] = [];
      for (const cell of row.getElementsByTagName('c')) {
        const reference = cell.getAttribute('r')?.match(/^[A-Z]+/)?.[0] ?? columnName(cells.length);
        const index = [...reference].reduce((value, character) => value * 26 + character.charCodeAt(0) - 64, 0) - 1;
        const raw = cell.getElementsByTagName('v')[0]?.textContent ?? '';
        cells[index] = cell.getAttribute('t') === 's' ? shared[Number(raw)] ?? '' : cell.getAttribute('t') === 'inlineStr' ? cell.getElementsByTagName('is')[0]?.textContent ?? '' : raw;
      }
      return cells;
    };
    const labelsRow = sheetRows[0] ? values(sheetRows[0]).map(value => value.trim()) : [];
    sheetHeaders[name] = labelsRow; labelsRow.forEach(header => headers.add(header));
    for (const sheetRow of sheetRows.slice(1)) {
      const cells = values(sheetRow); if (!cells.some(value => value?.trim())) continue;
      const record: ParsedImport['rows'][number] = { rowNumber: Number(sheetRow.getAttribute('r')), sheet: name, presentColumns: [], custom: {} };
      const present = record.presentColumns as string[], custom = record.custom as Record<string, unknown>;
      const seen = new Set<string>();
      for (const [index, header] of labelsRow.entries()) {
        let key = sheetMapping[name]?.[header] ?? mapping[header] ?? '__auto__';
        if (key === '__ignore__') continue;
        if (key === '__auto__') key = labels[header] ?? aliases[header] ?? header;
        if (seen.has(key)) errors.push({ sheet: name, rowNumber: record.rowNumber, column: header, message: '多列映射到同一字段' });
        seen.add(key); present.push(key);
        const value = cells[index] ?? '';
        if (key === 'disks') record.disks = parseDisks(value);
        else if (key === 'notes') custom.notes = value;
        else if (!['unit', 'environment', 'zone', 'system', 'name', 'host', 'ip', 'ip2', 'cpu', 'memory', 'accounts', 'passwords', 'os', 'status', 'businessSystem', 'rotatePassword', 'passwordCycleDays', 'asset:tags', 'passwordUpdatedAt'].includes(key)) { custom[key] = value; unknown.add(header); }
        else record[key === 'asset:tags' ? 'tags' : key] = value;
      }
      const usernames = String(record.accounts ?? '').split(/\r?\n|;/).map(value => value.trim()).filter(Boolean);
      const passwords = String(record.passwords ?? '').split(/\r?\n|;/);
      if (String(record.passwords ?? '') && usernames.length !== passwords.length) errors.push({ sheet: name, rowNumber: record.rowNumber, column: '账号/密码', message: '账号与密码数量不一致' });
      record.accounts = usernames.map((username, index) => ({ username, password: /^\*{3,}$/.test(passwords[index] ?? '') ? '' : passwords[index] ?? '', passwordUpdatedAt: String(record.passwordUpdatedAt ?? '') }));
      rows.push(record); if (rows.length > 10000) throw new Error('HTML 原型每次最多导入 10000 行');
    }
  }
  return { rows, errors, headers: [...headers], sheetHeaders, unmappedHeaders: [...unknown] };
}
