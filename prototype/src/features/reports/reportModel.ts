import type { Unit, VaultData } from '../../model';
import type { ReportKind, WorkCalendar, WorkEntry, WorkReport } from './types';
import { reportSections } from './types';

export const kindNames: Record<ReportKind, string> = { day: '日报', week: '周报', month: '月报', year: '年报' };
const datePattern = /^\d{4}-\d{2}-\d{2}$/;
const chinaTimeFormatter = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
export function validDate(value: string) { return datePattern.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value; }
export const shiftDate = (value: string, days: number) => new Date(Date.parse(`${value}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
export function chinaTime(value: string | Date = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return chinaTimeFormatter.format(date);
}
export const chinaDate = (value: string | Date = new Date()) => chinaTime(value).slice(0, 10);
export const holidayName = (date: string, calendar: WorkCalendar) => calendar.holidays?.[date]?.name ?? '';
export function period(kind: ReportKind, value: string) {
  if (!validDate(value)) throw new Error('请选择有效日期');
  if (kind === 'day') return { start: value, end: value };
  if (kind === 'week') {
    const day = new Date(`${value}T00:00:00Z`).getUTCDay();
    const start = shiftDate(value, -((day + 2) % 7));
    return { start, end: shiftDate(start, 6) };
  }
  const year = Number(value.slice(0, 4)); const month = Number(value.slice(5, 7));
  return kind === 'year' ? { start: `${year}-01-01`, end: `${year}-12-31` }
    : { start: `${value.slice(0, 7)}-01`, end: new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10) };
}
export function isWorkday(date: string, calendar: WorkCalendar) {
  if (!validDate(date)) return false;
  if (typeof calendar.overrides[date] === 'boolean') return calendar.overrides[date];
  if (calendar.holidays?.[date]) return calendar.holidays[date].workday;
  const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
  return weekday > 0 && weekday < 6;
}
export function calendarEventsOnDate(date: string, calendar: WorkCalendar) {
  const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
  return calendar.exclusions.filter(item => item.weekly
    ? date >= item.date && (!item.weekly.until || date <= item.weekly.until) && item.weekly.weekdays.includes(weekday)
    : item.date === date);
}
export function calendarEventsInRange(start: string, end: string, calendar: WorkCalendar) {
  const result: WorkCalendar['exclusions'] = [];
  for (let date = start; date <= end; date = shiftDate(date, 1)) {
    for (const { weekly: _weekly, ...event } of calendarEventsOnDate(date, calendar)) result.push({ ...event, date });
  }
  return result;
}
export function includedHalf(date: string, part: 'am' | 'pm', calendar: WorkCalendar) {
  const events = calendarEventsOnDate(date, calendar).filter(item => item.part === 'day' || item.part === part);
  return events.some((item) => item.reason === '加班') || (isWorkday(date, calendar) && !events.some((item) => item.reason === '请假'));
}
export function workdayCount(start: string, end: string, calendar: WorkCalendar) {
  let halves = 0;
  for (let date = start; date <= end; date = shiftDate(date, 1)) halves += Number(includedHalf(date, 'am', calendar)) + Number(includedHalf(date, 'pm', calendar));
  return halves / 2;
}
export function scopeOptions(units: Unit[]) {
  return units.flatMap((unit) => unit.environments.flatMap((env) => env.zones.flatMap((zone) => zone.systems.map((system) => ({
    value: system.id, unitId: unit.id, systemName: system.name, pathLabel: [unit.name, env.name, zone.name, system.name].filter(Boolean).join('/'), label: [unit.name, env.name, zone.name, system.name].filter(Boolean).join('_'),
  })))));
}
export function scopeName(data: VaultData, unitId?: string, systemId?: string) {
  return scopeOptions(data.units).find((item) => item.value === systemId)?.label ?? data.units.find((unit) => unit.id === unitId)?.name ?? (unitId || systemId ? '已删除的关联' : '未绑定资产系统');
}
export function bindEntrySystem(entry: WorkEntry, systemId: string, units: Unit[], updatedAt = new Date().toISOString()): WorkEntry {
  const selection = scopeIndex(units).bySystemId.get(systemId);
  if (!selection) throw new Error('所选系统已不存在，请刷新列表');
  return bindEntryScope(entry, selection.value, units, updatedAt);
}
export type EntryScope = Pick<WorkEntry, 'unitId' | 'environmentId' | 'zoneId' | 'systemId'>;
export type ScopeNode = { title: string; value: string; scope: EntryScope; path: string; children?: ScopeNode[] };
export const scopeValue = (scope: EntryScope) => JSON.stringify([scope.unitId, scope.environmentId, scope.zoneId, scope.systemId].filter(Boolean));
const flattenScope = (node: ScopeNode): ScopeNode[] => [node, ...(node.children ?? []).flatMap(flattenScope)];
function buildScopeTree(units: Unit[]): ScopeNode[] {
  const node = (title: string, names: string[], scope: EntryScope, children?: ScopeNode[]): ScopeNode => ({ title, path: names.filter(Boolean).join('/'), value: scopeValue(scope), scope, children });
  const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name, 'zh-CN', { sensitivity: 'base', numeric: true });
  return [...units].sort(byName).map((unit) => node(unit.name, [unit.name], { unitId: unit.id }, [...unit.environments].sort(byName).map((env) => node(env.name, [unit.name, env.name], { unitId: unit.id, environmentId: env.id }, [...env.zones].sort(byName).flatMap((zone) => {
    const systems = [...zone.systems].sort(byName).map((system) => node(system.name, [unit.name, env.name, zone.name, system.name], { unitId: unit.id, environmentId: env.id, zoneId: zone.id, systemId: system.id }));
    return zone.name ? [node(zone.name, [unit.name, env.name, zone.name], { unitId: unit.id, environmentId: env.id, zoneId: zone.id }, systems)] : systems;
  })))));
}
type ScopeIndex = { tree: ScopeNode[]; byValue: Map<string, ScopeNode>; bySystemId: Map<string, ScopeNode> };
const scopeIndexes = new WeakMap<Unit[], ScopeIndex>();
export function scopeIndex(units: Unit[]): ScopeIndex {
  let cached = scopeIndexes.get(units);
  if (cached) return cached;
  const tree = buildScopeTree(units), byValue = new Map<string, ScopeNode>(), bySystemId = new Map<string, ScopeNode>();
  for (const node of tree.flatMap(flattenScope)) {
    if (!byValue.has(node.value)) byValue.set(node.value, node);
    if (node.scope.systemId && !bySystemId.has(node.scope.systemId)) bySystemId.set(node.scope.systemId, node);
  }
  cached = { tree, byValue, bySystemId }; scopeIndexes.set(units, cached); return cached;
}
export const scopeTree = (units: Unit[]) => scopeIndex(units).tree;
export function entryScopeValue(entry: EntryScope, units: Unit[]) {
  if (!entry.unitId && !entry.environmentId && !entry.zoneId && !entry.systemId) return;
  const index = scopeIndex(units);
  return (entry.systemId ? index.bySystemId.get(entry.systemId) : index.byValue.get(scopeValue(entry)))?.value;
}
export const resolveEntryScope = (value: string, units: Unit[]) => value ? scopeIndex(units).byValue.get(value)?.scope : undefined;
export function entryInScope(entry: EntryScope, scope: EntryScope, units: Unit[]) {
  const needsOwner = entry.systemId && (['unitId', 'environmentId', 'zoneId'] as const).some(key => scope[key] && !entry[key]);
  const actual = needsOwner ? scopeIndex(units).bySystemId.get(entry.systemId!)?.scope ?? entry : entry;
  return (['unitId', 'environmentId', 'zoneId', 'systemId'] as const).every(key => !scope[key] || actual[key] === scope[key]);
}
export function bindEntryScope(entry: WorkEntry, value: string, units: Unit[], updatedAt = new Date().toISOString()): WorkEntry {
  const selected = scopeIndex(units).byValue.get(value);
  if (!selected) throw new Error('所选目录已不存在，请刷新列表');
  return { ...entry, unitId: undefined, environmentId: undefined, zoneId: undefined, systemId: undefined, ...selected.scope, scopeName: selected.path, updatedAt };
}
function reportMatcher(report: Pick<WorkReport, 'start' | 'end'>, calendar: WorkCalendar) {
  const halves = new Map<string, boolean>();
  return (entry: WorkEntry) => {
    const time = chinaTime(entry.at), date = time.slice(0, 10);
    if (!validDate(date) || date < report.start || date > report.end) return false;
    const part = Number(time.slice(11, 13)) < 14 ? 'am' : 'pm', key = `${date}:${part}`;
    if (!halves.has(key)) halves.set(key, includedHalf(date, part, calendar));
    return halves.get(key)!;
  };
}
export function reportEntryCount(entries: WorkEntry[], report: Pick<WorkReport, 'start' | 'end'>, calendar: WorkCalendar) {
  const matches = reportMatcher(report, calendar);
  return entries.reduce((count, entry) => count + Number(matches(entry)), 0);
}
export function reportEntries(data: VaultData, report: Pick<WorkReport, 'start' | 'end'>) {
  const unitOrder = new Map([...data.units].sort((a, b) => a.name.localeCompare(b.name, 'zh-CN', { sensitivity: 'base', numeric: true })).map((unit, index) => [unit.id, index]));
  const systemUnits = new Map(scopeOptions(data.units).map((scope) => [scope.value, scope.unitId]));
  const order = (entry: WorkEntry) => unitOrder.get(entry.unitId ?? systemUnits.get(entry.systemId ?? '') ?? '') ?? data.units.length;
  return data.reports.entries.filter(reportMatcher(report, data.reports.calendar)).sort((a, b) => order(a) - order(b) || a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
}
export function reportBody(entries: WorkEntry[], includeTime = true) {
  return reportSections.map((section) => `## ${section}\n\n${entries.filter((entry) => (reportSections.includes(entry.section) ? entry.section : '完成事项') === section).map((entry) => {
    const scope = entry.systemId && !entry.environmentId ? entry.scopeName?.replaceAll('_', '/') : entry.scopeName;
    const details = [includeTime ? chinaTime(entry.at) : '', scope ? `\`${scope.replaceAll('`', '｀')}\`` : ''].filter(Boolean).join(' · ');
    return `- ${entry.text.replace(/\r?\n/g, '\n  ')}${details ? `（${details}）` : ''}`;
  }).join('\n') || '- 暂无记录'}`).join('\n\n');
}
export function calendarEventsBody(events: WorkCalendar['exclusions']) {
  return events.length ? `\n\n## 请假、外出与加班记录\n\n${[...events].sort((a, b) => a.date.localeCompare(b.date)).map((event) => `- ${event.date} · ${{ day: '整天', am: '上午', pm: '下午' }[event.part]} · ${[event.reason, event.note].filter(Boolean).join(' · ').replace(/\r?\n/g, ' ')}`).join('\n')}` : '';
}
export function newReport(data: VaultData, kind: ReportKind, date: string, includeRecordTime = true, customRange?: { start: string; end: string }): WorkReport {
  const range = kind === 'week' && customRange ? customRange : period(kind, date);
  if (!validDate(range.start) || !validDate(range.end) || range.start > range.end || Date.parse(range.end) - Date.parse(range.start) > 366 * 86_400_000) throw new Error('请选择有效的报告日期范围，最多 367 天');
  const entries = reportEntries(data, range); const now = new Date().toISOString();
  const calendarEvents = calendarEventsInRange(range.start, range.end, data.reports.calendar);
  return { id: crypto.randomUUID(), kind, ...range, title: `${kindNames[kind]} ${range.start} — ${range.end}`, markdown: reportBody(entries, includeRecordTime) + calendarEventsBody(calendarEvents), includeRecordTime, calendarEvents, sourceIds: entries.map((entry) => entry.id), effectiveWorkdays: workdayCount(range.start, range.end, data.reports.calendar), createdAt: now, updatedAt: now, revisions: [] };
}
export function exportReport(report: WorkReport, calendar: WorkCalendar) {
  return `# ${report.title}\n\n周期：${report.start} 至 ${report.end} · 计入工作日：${report.effectiveWorkdays ?? workdayCount(report.start, report.end, calendar)} 天\n\n更新时间：${chinaTime(report.updatedAt)}\n\n${report.markdown}\n`;
}
export function parseCalendar(text: string): WorkCalendar {
  const raw = JSON.parse(text);
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.dates) || !raw.dates.length) throw new Error('节假日 JSON 需要非空 dates 列表');
  const holidays: NonNullable<WorkCalendar['holidays']> = {};
  for (const day of raw.dates) {
    if (!day || !validDate(day.date) || !['public_holiday', 'transfer_workday'].includes(day.type) || typeof (day.name_cn ?? day.name) !== 'string') throw new Error('节假日 dates 需要有效日期、节假日名称和 public_holiday／transfer_workday 类型');
    holidays[day.date] = { workday: day.type === 'transfer_workday', name: day.name_cn ?? day.name };
  }
  return { overrides: {}, holidays, exclusions: [] };
}
