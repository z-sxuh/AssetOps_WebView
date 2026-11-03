import type { WorkReminder } from './types';
import { chinaDate, chinaTime, shiftDate, validDate } from './reportModel';
import type { VaultData } from '../../model';
import type { VaultSession } from '../../vaultSession';

function monthlyDate(date: string, day: number, offset = 0) {
  const month = new Date(`${date.slice(0, 7)}-01T00:00:00Z`); month.setUTCMonth(month.getUTCMonth() + offset);
  const year = month.getUTCFullYear(); const index = month.getUTCMonth();
  return `${year}-${String(index + 1).padStart(2, '0')}-${String(Math.min(day, new Date(Date.UTC(year, index + 1, 0)).getUTCDate())).padStart(2, '0')}`;
}

export function reminderDueAt(dateTime: string, repeat: WorkReminder['repeat'], day: number, weekday: number, now = new Date().toISOString()) {
  if (!validDate(dateTime.slice(0, 10)) || !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/.test(dateTime)) throw new Error('请填写有效提醒时间');
  if (repeat === 'none') return new Date(dateTime + '+08:00').toISOString();
  if (repeat === 'monthly' && (!Number.isInteger(day) || day < 1 || day > 31)) throw new Error('请选择每月几号提醒');
  if (repeat === 'weekly' && (!Number.isInteger(weekday) || weekday < 0 || weekday > 6)) throw new Error('请选择星期几提醒');
  const today = chinaDate(now); const time = dateTime.slice(10);
  let date = repeat === 'monthly' ? monthlyDate(today, day) : repeat === 'weekly' ? shiftDate(today, (weekday - new Date(`${today}T00:00:00Z`).getUTCDay() + 7) % 7) : today;
  if (Date.parse(date + time + '+08:00') <= Date.parse(now)) date = repeat === 'monthly' ? monthlyDate(today, day, 1) : shiftDate(date, repeat === 'weekly' ? 7 : 1);
  return new Date(date + time + '+08:00').toISOString();
}

export function dueReminders(tasks: WorkReminder[], now = Date.now()) {
  return tasks.filter((task) => !task.completedAt && Date.parse(task.dueAt) <= now && task.notifiedFor !== task.dueAt).sort((a, b) => a.dueAt.localeCompare(b.dueAt));
}
export function completeReminder(task: WorkReminder, now = new Date().toISOString()): WorkReminder {
  if (task.repeat === 'none') return { ...task, completedAt: now, updatedAt: now };
  const anchor = task.repeatAnchorAt ?? task.dueAt;
  const time = chinaTime(anchor); const repeatDay = task.repeatDay ?? Number(time.slice(8, 10));
  let next: number;
  if (task.repeat === 'monthly') {
    const today = chinaDate(now);
    let offset = Math.max(1, (Number(today.slice(0, 4)) - Number(time.slice(0, 4))) * 12 + Number(today.slice(5, 7)) - Number(time.slice(5, 7)));
    const candidate = () => Date.parse(monthlyDate(time.slice(0, 10), repeatDay, offset) + time.slice(10).replace(' ', 'T') + '+08:00');
    next = candidate();
    if (next <= Date.parse(now)) { offset++; next = candidate(); }
  } else {
    const interval = (task.repeat === 'weekly' ? 7 : 1) * 86400000;
    const start = Date.parse(time.replace(' ', 'T') + '+08:00');
    next = start + Math.max(1, Math.floor((Date.parse(now) - start) / interval) + 1) * interval;
  }
  return { ...task, dueAt: new Date(next).toISOString(), repeatDay, repeatAnchorAt: undefined, completedAt: undefined, notifiedFor: undefined, updatedAt: now };
}

export type ReminderEdit = { task: WorkReminder; editing: boolean; time: string; day: number; weekday: number };
export function editReminder(tasks: WorkReminder[], input: ReminderEdit, now = new Date().toISOString()) {
  const { task, editing, time, day, weekday } = input;
  if (!task.title.trim()) throw new Error('请填写提醒标题');
  const previous = tasks.find(item => item.id === task.id);
  if (editing && (!previous || previous.updatedAt !== task.updatedAt)) throw new Error('提醒事项已更新或删除，请重新打开编辑');
  const previousSchedule = previous?.repeatAnchorAt ?? previous?.dueAt;
  const sameSchedule = previous?.repeat === task.repeat && chinaTime(previousSchedule!).replace(' ', 'T') === time
    && (task.repeat !== 'monthly' || day === (previous.repeatDay ?? Number(chinaDate(previousSchedule!).slice(8))))
    && (task.repeat !== 'weekly' || weekday === new Date(`${chinaDate(previousSchedule!)}T00:00:00Z`).getUTCDay());
  const dueAt = sameSchedule ? previous.dueAt : reminderDueAt(time, task.repeat, day, weekday, now);
  const value = { ...task, title: task.title.trim(), dueAt, repeatDay: day, repeatAnchorAt: sameSchedule ? previous?.repeatAnchorAt : undefined, completedAt: sameSchedule ? previous?.completedAt : undefined, notifiedFor: sameSchedule ? previous?.notifiedFor : undefined, updatedAt: now };
  return { task: value, tasks: [...tasks.filter(item => item.id !== task.id), value] };
}
export function toggleReminder(tasks: WorkReminder[], id: string, now = new Date().toISOString()) {
  if (!tasks.some(task => task.id === id)) throw new Error('提醒事项已更新或删除，请重新打开编辑');
  return tasks.map(task => task.id !== id ? task : task.completedAt ? { ...task, completedAt: undefined, notifiedFor: undefined, updatedAt: now } : completeReminder(task, now));
}
export function completeReminders(tasks: WorkReminder[], ids: ReadonlySet<string>, now = new Date().toISOString()) {
  return tasks.map(task => ids.has(task.id) && !task.completedAt ? completeReminder(task, now) : task);
}
export function snoozeReminders(tasks: WorkReminder[], ids: ReadonlySet<string>, now = new Date().toISOString()) {
  return tasks.map(task => ids.has(task.id) && !task.completedAt ? { ...task, repeatAnchorAt: task.repeat === 'none' ? undefined : task.repeatAnchorAt ?? task.dueAt, dueAt: new Date(Date.parse(now) + 600000).toISOString(), notifiedFor: undefined, updatedAt: now } : task);
}
// 去重标记与其它仓库写入互斥，并且只有成功持久化后才能发通知。
export function notifyDueReminders(session: VaultSession, expected: VaultData, notify: (due: WorkReminder[]) => Promise<void>, now = Date.now()) {
  const due = dueReminders(expected.reports.calendar.tasks ?? [], now);
  if (!due.length) return Promise.resolve();
  return session.run(expected, async transaction => {
    const ids = new Set(due.map(task => task.id));
    const tasks = (expected.reports.calendar.tasks ?? []).map(task => ids.has(task.id) ? { ...task, notifiedFor: task.dueAt } : task);
    await transaction.save({ ...expected, reports: { ...expected.reports, calendar: { ...expected.reports.calendar, tasks } } });
    const current = session.getSnapshot();
    if (current.stage !== 'ready' || !due.every(task => current.data.reports.calendar.tasks?.some(item => item.id === task.id && !item.completedAt && item.dueAt === task.dueAt && item.notifiedFor === task.dueAt))) return;
    await notify(due);
  });
}
