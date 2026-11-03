import { validDate } from './reportModel';
import type { WorkCalendar, WorkReminder } from './types';

export const calendarFileLimit = 64 * 1024 * 1024;
export function exportCalendarItems(calendar: WorkCalendar) {
  return JSON.stringify({ format: 'workbench-calendar-items', version: calendar.exclusions.some(item => item.weekly) ? 2 : 1, tasks: calendar.tasks ?? [], exclusions: calendar.exclusions }, null, 2);
}

const text = (value: unknown, max: number, required = false): value is string => typeof value === 'string' && value.length <= max && (!required || Boolean(value.trim()));
const time = (value: unknown): value is string => text(value, 64, true) && Number.isFinite(Date.parse(value));
export function parseCalendarItems(content: string, existing: Pick<WorkCalendar, 'tasks' | 'exclusions'>) {
  if (new TextEncoder().encode(content).byteLength > calendarFileLimit) throw new Error('日历事项文件不能超过 64 MB');
  const raw = JSON.parse(content);
  if (!raw || raw.format !== 'workbench-calendar-items' || ![1, 2].includes(raw.version) || !Array.isArray(raw.tasks) || !Array.isArray(raw.exclusions)) throw new Error('请选择本应用导出的日历事项 JSON（版本 1 或 2）');
  const taskIds = new Set(existing.tasks?.map(item => item.id)), exclusionIds = new Set(existing.exclusions.map(item => item.id));
  const tasks: WorkReminder[] = [], exclusions: WorkCalendar['exclusions'] = []; let skipped = 0;
  raw.tasks.forEach((item: WorkReminder, index: number) => {
    if (!item || !text(item.id, 256, true) || !text(item.title, 128, true) || !text(item.note, 2000)
      || !['none', 'daily', 'weekly', 'monthly'].includes(item.repeat) || !['normal', 'high'].includes(item.priority)
      || ![item.dueAt, item.createdAt, item.updatedAt].every(time) || (item.completedAt !== undefined && !time(item.completedAt))
      || (item.notifiedFor !== undefined && !time(item.notifiedFor))
      || (item.repeatAnchorAt !== undefined && !time(item.repeatAnchorAt))
      || (item.repeatDay !== undefined && (!Number.isInteger(item.repeatDay) || item.repeatDay < 1 || item.repeatDay > 31))) throw new Error(`第 ${index + 1} 条提醒的内容或时间无效`);
    if (taskIds.has(item.id)) { skipped++; return; }
    tasks.push({ id: item.id, title: item.title, note: item.note, dueAt: item.dueAt, repeat: item.repeat, priority: item.priority, createdAt: item.createdAt, updatedAt: item.updatedAt,
      ...(item.completedAt ? { completedAt: item.completedAt } : {}), ...(item.notifiedFor ? { notifiedFor: item.notifiedFor } : {}), ...(item.repeatDay !== undefined ? { repeatDay: item.repeatDay } : {}),
      ...(item.repeatAnchorAt ? { repeatAnchorAt: item.repeatAnchorAt } : {}),
    }); taskIds.add(item.id);
  });
  raw.exclusions.forEach((item: WorkCalendar['exclusions'][number], index: number) => {
    if (!item || !text(item.id, 256, true) || !text(item.date, 10, true) || !validDate(item.date) || !['day', 'am', 'pm'].includes(item.part) || !text(item.reason, 128, true) || (item.note !== undefined && !text(item.note, 2000))
      || (item.weekly !== undefined && (!item.weekly || !Array.isArray(item.weekly.weekdays) || !item.weekly.weekdays.length || item.weekly.weekdays.length > 7
        || item.weekly.weekdays.some(day => !Number.isInteger(day) || day < 0 || day > 6) || new Set(item.weekly.weekdays).size !== item.weekly.weekdays.length
        || (item.weekly.until !== undefined && (!text(item.weekly.until, 10, true) || !validDate(item.weekly.until) || item.weekly.until < item.date))))) throw new Error(`第 ${index + 1} 条请假／外出／加班记录无效`);
    if (exclusionIds.has(item.id)) { skipped++; return; }
    exclusions.push({ id: item.id, date: item.date, part: item.part, reason: item.reason, ...(item.note ? { note: item.note } : {}),
      ...(item.weekly ? { weekly: { weekdays: [...item.weekly.weekdays], ...(item.weekly.until ? { until: item.weekly.until } : {}) } } : {}),
    }); exclusionIds.add(item.id);
  });
  return { tasks, exclusions, skipped };
}
