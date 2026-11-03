import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Alert, Button, Checkbox, DatePicker, Input, List, Modal, Space, Tag, TimePicker, Typography, message } from 'antd';
import dayjs from 'dayjs';
import 'dayjs/locale/zh-cn';
import Select from '../../components/AppSelect';
import DateTimeInput from '../../components/DateTimeInput';
import { LeftOutlined, RightOutlined, PlusOutlined, DeleteOutlined, EditOutlined, DownloadOutlined, UploadOutlined } from '@ant-design/icons';
import type { VaultData } from '../../model';
import { id } from '../../model';
import { calendarEventsOnDate, chinaDate, chinaTime, holidayName, isWorkday, shiftDate, validDate } from './reportModel';
import { calendarLabels, lunarDate } from './calendarLabels';
import { editReminder, toggleReminder } from './reminders';
import type { ReportsData, WorkCalendar, WorkReminder } from './types';
import { composingCancel } from '../../composition';
import { native } from '../../native';
import { calendarFileLimit, exportCalendarItems } from './calendarTransfer';
import type { CalendarImportResult } from './calendarImport.worker';
import type { ComponentRef, KeyboardEvent } from 'react';

const repeatNames = { none: '不重复', daily: '每天', weekly: '每周', monthly: '每月' };
const weekdays = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];
function useCalendarPicker(active: boolean) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const picker = useRef<ComponentRef<typeof DatePicker>>(null);
  useLayoutEffect(() => { if (!active) setOpen(false); }, [active]);
  const closePopup = (event: KeyboardEvent<HTMLElement>) => {
    if (!open || event.key !== 'Escape') return;
    event.stopPropagation(); event.preventDefault();
    if (composingCancel(event)) return;
    setOpen(false); picker.current?.focus();
  };
  return { ref: picker, open: active && open, 'aria-controls': active && open ? panelId : undefined, onOpenChange: setOpen, onKeyDown: closePopup, panelRender: (panel: React.ReactNode) => <div id={panelId} onKeyDown={closePopup}>{panel}</div> };
}
export default function WorkCalendarView({ data, active = true, onOpenPage, onChange }: { data: VaultData; active?: boolean; onOpenPage?: () => void; onChange: (reports: ReportsData) => Promise<void> }) {
  const [msg, context] = message.useMessage({ maxCount: 3 }); const [busy, setBusy] = useState(false);
  const busyRef = useRef(false); const taskSession = useRef(0);
  useEffect(() => () => { taskSession.current++; }, []);
  const [date, setDate] = useState(chinaDate()); const [month, setMonth] = useState(chinaDate().slice(0, 7));
  const monthRef = useRef<HTMLDivElement>(null);
  const [monthScrollable, setMonthScrollable] = useState(false);
  useLayoutEffect(() => {
    const element = monthRef.current;
    if (!active || !element || onOpenPage) return;
    let frame = 0;
    const resize = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const bottom = document.querySelector('.app-footer')?.getBoundingClientRect().top ?? innerHeight;
        const height = Math.max(180, Math.floor(bottom - element.getBoundingClientRect().top - 12));
        element.style.maxHeight = `${height}px`;
        element.style.setProperty('--calendar-day-height', `${Math.max(64, Math.min(96, Math.floor((height - 85) / 6)))}px`);
        setMonthScrollable(element.scrollHeight > element.clientHeight + 1);
      });
    };
    const observer = new ResizeObserver(resize);
    observer.observe(element);
    const viewport = element.closest('.content-area'); if (viewport) observer.observe(viewport);
    window.addEventListener('resize', resize); resize();
    return () => { observer.disconnect(); cancelAnimationFrame(frame); window.removeEventListener('resize', resize); };
  }, [active, month, onOpenPage]);
  const [taskEditing, setTaskEditing] = useState(false);
  const [task, setTask] = useState<WorkReminder>(); const [taskOpen, setTaskOpen] = useState(false); const [taskTime, setTaskTime] = useState('');
  const [taskDay, setTaskDay] = useState(1); const [taskWeekday, setTaskWeekday] = useState(1);
  const [leaveOpen, setLeaveOpen] = useState(false); const [start, setStart] = useState(date); const [end, setEnd] = useState(date);
  const [part, setPart] = useState<'day' | 'am' | 'pm'>('day'); const [reason, setReason] = useState('请假'); const [leaveNote, setLeaveNote] = useState('');
  const [leaveRepeat, setLeaveRepeat] = useState<'none' | 'weekly'>('none');
  const [leaveWeekdays, setLeaveWeekdays] = useState<number[]>([]);
  const [leaveEditing, setLeaveEditing] = useState<string>();
  const monthPicker = useCalendarPicker(active);
  const taskPicker = useCalendarPicker(active && taskOpen && !busy);
  const startPicker = useCalendarPicker(active && leaveOpen);
  const endPicker = useCalendarPicker(active && leaveOpen);
  const [taskPopup, setTaskPopup] = useState<'repeat' | 'weekday' | 'day'>();
  const [leavePopup, setLeavePopup] = useState<'part' | 'reason' | 'repeat'>();
  useLayoutEffect(() => { if (!active || !taskOpen || busy) setTaskPopup(undefined); }, [active, taskOpen, busy]);
  useLayoutEffect(() => { if (!active || !leaveOpen) setLeavePopup(undefined); }, [active, leaveOpen]);
  const calendar = data.reports.calendar; const tasks = calendar.tasks ?? [];
  const [importOpen, setImportOpen] = useState(false), [importParsing, setImportParsing] = useState(false);
  const [importResult, setImportResult] = useState<CalendarImportResult>();
  const importInput = useRef<HTMLInputElement>(null), importWorker = useRef<Worker>();
  const importGeneration = useRef(0);
  const closeImport = () => { importGeneration.current++; importWorker.current?.terminate(); importWorker.current = undefined; setImportOpen(false); setImportResult(undefined); setImportParsing(false); };
  useEffect(() => () => { importGeneration.current++; importWorker.current?.terminate(); }, []);
  const readImport = (file: File) => {
    importGeneration.current++; importWorker.current?.terminate(); setImportResult(undefined);
    if (file.size > calendarFileLimit) { setImportParsing(false); setImportResult({ error: '日历事项文件不能超过 64 MB' }); return; }
    const generation = importGeneration.current;
    try {
      const worker = new Worker(new URL('./calendarImport.worker.ts', import.meta.url), { type: 'module' });
      importWorker.current = worker; setImportParsing(true);
      worker.onmessage = ({ data: result }: MessageEvent<CalendarImportResult>) => { if (generation !== importGeneration.current) return; setImportResult(result); setImportParsing(false); worker.terminate(); importWorker.current = undefined; };
      worker.onerror = event => { event.preventDefault(); if (generation !== importGeneration.current) return; setImportResult({ error: '日历事项校验失败，请重新选择文件' }); setImportParsing(false); worker.terminate(); importWorker.current = undefined; };
      worker.postMessage({ file, existing: { tasks, exclusions: calendar.exclusions } });
    } catch (reason) { setImportParsing(false); setImportResult({ error: String(reason) }); }
  };
  const taskIndex = useMemo(() => {
    const byDate = new Map<string, WorkReminder[]>(); const pending = new Map<string, number>();
    for (const item of calendar.tasks ?? []) {
      const day = chinaDate(item.dueAt); const group = byDate.get(day) ?? [];
      group.push(item); byDate.set(day, group);
      if (!item.completedAt) pending.set(day, (pending.get(day) ?? 0) + 1);
    }
    for (const group of byDate.values()) group.sort((a, b) => Number(Boolean(a.completedAt)) - Number(Boolean(b.completedAt)) || a.dueAt.localeCompare(b.dueAt));
    return { byDate, pending };
  }, [calendar.tasks]);
  const first = `${month}-01`; const offset = (new Date(`${first}T00:00:00Z`).getUTCDay() + 6) % 7;
  const days = useMemo(() => Array.from({ length: 42 }, (_, index) => shiftDate(first, index - offset)), [first, offset]);
  const exclusionsByDate = useMemo(() => {
    const result = new Map<string, typeof calendar.exclusions>();
    for (const day of days) { const items = calendarEventsOnDate(day, calendar); if (items.length) result.set(day, items); }
    return result;
  }, [days, calendar.exclusions]);
  const details = useMemo(() => ({ date,
    tasks: taskIndex.byDate.get(date) ?? [],
    exclusions: exclusionsByDate.get(date) ?? [],
    entries: data.reports.entries.filter((item) => chinaDate(item.at) === date).sort((a, b) => a.at.localeCompare(b.at)),
  }), [date, taskIndex, exclusionsByDate, data.reports.entries]);
  const { tasks: selectedTasks, exclusions, entries: selectedEntries } = details;
  const counts = useMemo(() => { const result = new Map<string, number>(); for (const entry of data.reports.entries) { const day = chinaDate(entry.at); result.set(day, (result.get(day) ?? 0) + 1); } return result; }, [data.reports.entries]);
  const labels = useMemo(() => new Map(days.map((day) => [day, calendarLabels(day)])), [days]);
  const run = async (operation: () => Promise<void>) => { if (busyRef.current) return; busyRef.current = true; setBusy(true); try { await operation(); } catch (error) { msg.error(error instanceof Error ? error.message : String(error)); } finally { busyRef.current = false; setBusy(false); } };
  const saveCalendar = (next: typeof calendar) => onChange({ ...data.reports, calendar: next });
  const selectMonth = (value: string) => { setMonth(value); setDate(`${value}-${String(Math.min(Number(date.slice(8)), dayjs(`${value}-01`).daysInMonth())).padStart(2, '0')}`); };
  const changeMonth = (delta: number) => { const next = new Date(`${month}-01T00:00:00Z`); next.setUTCMonth(next.getUTCMonth() + delta); selectMonth(next.toISOString().slice(0, 7)); };
  const openTask = (item?: WorkReminder) => {
    if (busyRef.current) return;
    taskSession.current++;
    setTaskEditing(Boolean(item));
    const at = new Date().toISOString(); const dueAt = new Date(`${date}T10:00:00+08:00`).toISOString();
    setTask(item ?? { id: id(), title: '', note: '', dueAt, repeat: 'none', priority: 'normal', createdAt: at, updatedAt: at });
    const time = chinaTime(item?.repeatAnchorAt ?? item?.dueAt ?? dueAt);
    setTaskTime(time.replace(' ', 'T')); setTaskDay(item?.repeatDay ?? Number(time.slice(8, 10))); setTaskWeekday(new Date(`${time.slice(0, 10)}T00:00:00Z`).getUTCDay()); setTaskOpen(true);
  };
  const closeTask = () => { if (!busyRef.current) { taskSession.current++; setTaskOpen(false); } };
  const saveTask = async () => {
    if (!task) throw new Error('请填写提醒标题');
    const session = taskSession.current;
    const result = editReminder(tasks, { task, editing: taskEditing, time: taskTime, day: taskDay, weekday: taskWeekday });
    try { await saveCalendar({ ...calendar, tasks: result.tasks }); }
    catch (reason) { throw new Error(`提醒“${result.task.title}”保存失败：${reason instanceof Error ? reason.message : String(reason)}`); }
    if (session === taskSession.current) { setDate(chinaDate(result.task.dueAt)); setMonth(chinaDate(result.task.dueAt).slice(0, 7)); taskSession.current++; setTaskOpen(false); }
  };
  const toggleTask = (item: WorkReminder) => run(() => saveCalendar({ ...calendar, tasks: toggleReminder(tasks, item.id) }));
  const openLeave = (item?: WorkCalendar['exclusions'][number]) => {
    if (busyRef.current) return;
    setLeaveEditing(item?.id); setStart(item?.date ?? date); setEnd(item?.weekly ? item.weekly.until ?? '' : item?.date ?? date);
    setPart(item?.part ?? 'day'); setReason(item?.reason ?? '请假'); setLeaveNote(item?.note ?? '');
    setLeaveRepeat(item?.weekly ? 'weekly' : 'none');
    setLeaveWeekdays(item?.weekly?.weekdays ?? [new Date(`${item?.date ?? date}T00:00:00Z`).getUTCDay()]);
    setLeaveOpen(true);
  };
  const saveLeave = async () => {
    if (!validDate(start) || (end && (!validDate(end) || end < start)) || !reason.trim()
      || (leaveRepeat === 'none' && (!end || Date.parse(end) - Date.parse(start) > 366 * 86400000))) throw new Error('请填写有效起止日期和原因，单次记录范围不超过一年');
    if (leaveEditing && !calendar.exclusions.some(item => item.id === leaveEditing)) throw new Error('记录已删除，请重新打开');
    const note = reason !== '请假' ? leaveNote.trim() : '';
    const next = calendar.exclusions.filter(item => item.id !== leaveEditing);
    if (leaveRepeat === 'weekly') {
      if (!leaveWeekdays.length) throw new Error('请选择至少一个重复星期');
      const weekdays = [...leaveWeekdays].sort((a, b) => a - b), weekly = { weekdays, ...(end ? { until: end } : {}) };
      if (!next.some(item => item.date === start && item.part === part && item.reason === reason && (item.note ?? '') === note && JSON.stringify(item.weekly) === JSON.stringify(weekly))) {
        next.push({ id: leaveEditing ?? id(), date: start, part, reason, ...(note ? { note } : {}), weekly });
      }
    } else {
      for (let day = start; day <= end; day = shiftDate(day, 1)) {
        if (!next.some(item => !item.weekly && item.date === day && item.part === part && item.reason === reason && (item.note ?? '') === note)) next.push({ id: leaveEditing && day === start ? leaveEditing : id(), date: day, part, reason, ...(note ? { note } : {}) });
      }
    }
    await saveCalendar({ ...calendar, exclusions: next }); setLeaveOpen(false);
  };
  return <div className="work-calendar-view">{context}
    <div className="work-calendar-toolbar" onContextMenu={(event) => { if (onOpenPage && event.currentTarget.contains(event.target as Node)) { event.preventDefault(); onOpenPage(); } }}><Space wrap>
      <Button aria-label="上个月" icon={<LeftOutlined />} onClick={() => changeMonth(-1)} /><DatePicker {...monthPicker} aria-label="日历月份" picker="month" value={dayjs(`${month}-01`)} format="YYYY年M月" allowClear={false} inputReadOnly classNames={{ popup: { root: 'work-calendar-month-picker' } }} onChange={(value) => { if (value) selectMonth(value.format('YYYY-MM')); }} style={{ width: 160 }} /><Button aria-label="下个月" icon={<RightOutlined />} onClick={() => changeMonth(1)} />
      <Button onClick={() => { setDate(chinaDate()); setMonth(chinaDate().slice(0, 7)); }}>今天</Button>
    </Space><Space className="work-calendar-actions" wrap><Button className="calendar-transfer" icon={<UploadOutlined />} disabled={busy} onClick={() => { setImportResult(undefined); setImportOpen(true); }}>导入</Button><Button className="calendar-transfer" icon={<DownloadOutlined />} disabled={busy || !tasks.length && !calendar.exclusions.length} onClick={() => void run(async () => { const path = await native.exportDocument('日历事项', 'json', exportCalendarItems(calendar)); msg.success({ content: <Space><span>日历事项已导出</span><Button type="link" size="small" onClick={() => void native.revealInFolder(path)}>打开目录</Button></Space>, duration: 8 }); })}>导出</Button><Button onClick={() => openLeave()}>请假／外出／加班</Button><Button type="primary" icon={<PlusOutlined />} onClick={() => openTask()}>新增提醒事项</Button></Space></div>
    <div className="work-calendar-layout">
      <div ref={monthRef} className="work-calendar-month" aria-label="工作记录热力日历" tabIndex={monthScrollable ? 0 : undefined}>
        {monthScrollable && <div className="calendar-scroll-hint" role="status">向下滚动查看完整月份</div>}
        <div className="work-calendar-weekdays">{['一', '二', '三', '四', '五', '六', '日'].map((day) => <span key={day}>周{day}</span>)}</div>
        <div className="work-calendar-grid">{days.map((day) => {
          const otherMonth = day.slice(0, 7) !== month;
          const count = otherMonth ? 0 : counts.get(day) ?? 0; const workday = isWorkday(day, calendar); const pending = otherMonth ? 0 : taskIndex.pending.get(day) ?? 0;
          const events = otherMonth ? [] : exclusionsByDate.get(day) ?? [];
          return <button key={day} type="button" disabled={otherMonth} className={`work-calendar-day heat-${Math.min(4, count)}${day === date ? ' is-selected' : ''}${otherMonth ? ' is-other-month' : ''}${!workday ? ' is-rest' : ''}`} title={[holidayName(day, calendar), ...(labels.get(day) ?? [])].filter(Boolean).join(' · ')} aria-label={`${day} ${workday ? '工作日' : '休息日'} ${count}条工作记录 ${pending}项提醒`} onClick={() => setDate(day)}>
            <span className="work-calendar-day-main"><span className="work-calendar-date">{Number(day.slice(8))}{day === chinaDate() && <small>今天</small>}</span><span className="work-calendar-lunar">{lunarDate(day)}</span></span>
            <span className="work-calendar-marks">{!otherMonth && <>{holidayName(day, calendar).split(/(?=调休|补班|补休)/).filter(Boolean).map(label => <small key={label}>{label}</small>)}{(labels.get(day) ?? []).filter(label => label !== holidayName(day, calendar)).map(label => <small key={label}>{label}</small>)}</>}</span>
            {count > 0 && <span className="work-calendar-count">{count}</span>}
            <span className="work-calendar-day-events">{pending > 0 && <small>● 提醒 {pending}</small>}{events.map(event => <small key={event.id}>{event.reason} · {({ day: '全天', am: '上午', pm: '下午' })[event.part]}</small>)}{!otherMonth && !workday && <small>休息日</small>}</span>
          </button>;
        })}</div>
      </div>
      <div className="work-calendar-task-slot"><aside className="work-calendar-tasks"><Typography.Title level={4}>{details.date}</Typography.Title>
        {exclusions.map((item) => <div className="calendar-event-detail" key={item.id}><div><b>{item.reason} · {({ day: '整天', am: '上午', pm: '下午' })[item.part]}</b>{item.weekly && <div className="calendar-event-repeat">每周{item.weekly.weekdays.map(day => weekdays[day].replace('星期', '')).join('、')} · {item.date} 起{item.weekly.until ? `，至 ${item.weekly.until}` : '，不设结束日期'}</div>}{item.note && <p>{item.note}</p>}</div>{item.weekly && <Button size="small" type="text" aria-label={`编辑${item.reason}重复记录`} icon={<EditOutlined />} disabled={busy} onClick={() => openLeave(item)} />}<Button size="small" type="text" danger title={item.weekly ? '删除整条每周重复记录' : undefined} aria-label={`删除${item.reason}记录`} icon={<DeleteOutlined />} disabled={busy} onClick={() => void run(() => saveCalendar({ ...calendar, exclusions: calendar.exclusions.filter((value) => value.id !== item.id) }))} /></div>)}
        <Typography.Text className="calendar-reminders-heading" strong>提醒事项</Typography.Text>
        <List locale={{ emptyText: '暂无提醒事项' }} dataSource={selectedTasks} renderItem={(item) => <List.Item className={item.completedAt ? 'reminder-completed' : ''}><div className="reminder-row">
          <Checkbox aria-label={`完成提醒 ${item.title}`} checked={Boolean(item.completedAt)} disabled={busy} onChange={() => void toggleTask(item)} />
          <div className="reminder-body"><b>{item.title}</b><div className="reminder-meta"><span>{chinaTime(item.dueAt).slice(11, 16)} · {repeatNames[item.repeat]}</span>{item.priority === 'high' && <Tag color="orange">重要</Tag>}{!item.completedAt && Date.parse(item.dueAt) < Date.now() && <Tag color="red">已到期</Tag>}</div>{item.note && <p>{item.note}</p>}</div>
          <Button size="small" type="text" icon={<EditOutlined />} aria-label={`编辑提醒 ${item.title}`} onClick={() => openTask(item)} /><Button size="small" type="text" danger icon={<DeleteOutlined />} aria-label={`删除提醒 ${item.title}`} disabled={busy} onClick={() => void run(() => saveCalendar({ ...calendar, tasks: tasks.filter((value) => value.id !== item.id) }))} />
        </div></List.Item>} />
        {selectedEntries.length > 0 && <><Typography.Text className="calendar-records-heading" strong>工作记录（{selectedEntries.length}）</Typography.Text><List className="calendar-work-records" dataSource={selectedEntries} renderItem={(item) => <List.Item><div><div className="calendar-record-meta"><time>{chinaTime(item.at).slice(11, 16)}</time><Tag>{item.section}</Tag></div><p>{item.text}</p>{item.scopeName && <Typography.Text type="secondary">{item.systemId && !item.environmentId ? item.scopeName.replaceAll('_', '/') : item.scopeName}</Typography.Text>}</div></List.Item>} /></>}
      </aside></div>
    </div>
    <div className="work-calendar-details"><Space wrap><Typography.Text strong>{date}</Typography.Text><Tag color={isWorkday(date, calendar) ? 'green' : undefined}>{isWorkday(date, calendar) ? '工作日' : '休息日'}</Tag>
      {[true, false].map((work) => <Button size="small" key={String(work)} disabled={busy} onClick={() => void run(() => saveCalendar({ ...calendar, overrides: { ...calendar.overrides, [date]: work } }))}>{work ? '设为工作日' : '设为休息日'}</Button>)}
      <Button size="small" disabled={busy} onClick={() => void run(async () => { const overrides = { ...calendar.overrides }; delete overrides[date]; await saveCalendar({ ...calendar, overrides }); })}>恢复默认</Button>
    </Space></div>
    <Modal title="导入日历事项 JSON" open={active && importOpen} focusTriggerAfterClose={active} okText="导入" cancelText="取消" confirmLoading={busy} cancelButtonProps={{ disabled: busy }} keyboard={!busy} maskClosable={!busy} closable={{ disabled: busy }} onCancel={event => { if (!busy && !composingCancel(event)) closeImport(); }} okButtonProps={{ disabled: importParsing || !importResult || 'error' in importResult || !importResult.value.tasks.length && !importResult.value.exclusions.length }} onOk={() => void run(async () => {
      if (!importResult || 'error' in importResult) return;
      const taskIds = new Set(tasks.map(item => item.id)), exclusionIds = new Set(calendar.exclusions.map(item => item.id));
      const newTasks = importResult.value.tasks.filter(item => !taskIds.has(item.id)), newExclusions = importResult.value.exclusions.filter(item => !exclusionIds.has(item.id));
      await saveCalendar({ ...calendar, tasks: [...tasks, ...newTasks], exclusions: [...calendar.exclusions, ...newExclusions] }); closeImport(); msg.success(`已导入 ${newTasks.length} 条提醒、${newExclusions.length} 条请假／外出／加班记录`);
    })}><Space direction="vertical" className="full-width"><Typography.Text>迁移提醒的时间、重复规则、完成状态及请假／外出／加班记录。相同 ID 的事项跳过；现有日历设置保留。</Typography.Text><Button disabled={busy || importParsing} icon={<UploadOutlined />} onClick={() => importInput.current?.click()}>选择日历事项 JSON</Button><input ref={importInput} type="file" accept=".json,application/json" hidden onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; if (file) readImport(file); }} />{importParsing && <Alert type="info" showIcon message="正在校验日历事项…" />}{importResult && ('error' in importResult ? <Alert type="error" showIcon message={importResult.error} /> : <Alert type="info" showIcon message={`将导入 ${importResult.value.tasks.length} 条提醒、${importResult.value.exclusions.length} 条请假／外出／加班记录，跳过 ${importResult.value.skipped} 条重复记录`} />)}</Space></Modal>
    <Modal title={taskEditing ? '编辑提醒事项' : '新增提醒事项'} forceRender open={active && taskOpen} focusTriggerAfterClose={active} okText="保存提醒" cancelText="取消" confirmLoading={busy} cancelButtonProps={{ disabled: busy }} closable={{ disabled: busy }} keyboard={!busy} maskClosable={!busy} onCancel={(event) => { if (!composingCancel(event)) closeTask(); }} afterClose={() => { if (!taskOpen) setTask(undefined); }} onOk={() => void run(saveTask)}>{task && <Space direction="vertical" className="full-width">
      <Input aria-label="提醒标题" disabled={busy} placeholder="提醒事项" maxLength={128} value={task.title} onChange={(event) => setTask({ ...task, title: event.target.value })} />
      <Select aria-label="提醒重复规则" disabled={busy} className="full-width" open={active && taskOpen && !busy && taskPopup === 'repeat'} onOpenChange={(open) => setTaskPopup(open ? 'repeat' : undefined)} value={task.repeat} options={Object.entries(repeatNames).map(([value, label]) => ({ value, label }))} onChange={(repeat) => setTask({ ...task, repeat })} />
      {task.repeat === 'none' ? <DateTimeInput active={active && taskOpen && !busy} disabled={busy} aria-label="提醒时间" className="full-width" value={taskTime} seconds={false} allowClear={false} onChange={(value) => { setTaskTime(value); setTaskDay(Number(value.slice(8, 10))); setTaskWeekday(new Date(`${value.slice(0, 10)}T00:00:00Z`).getUTCDay()); }} /> : <div className="reminder-schedule-row">
        {task.repeat === 'weekly' && <Select aria-label="每周提醒星期" disabled={busy} open={active && taskOpen && !busy && taskPopup === 'weekday'} onOpenChange={(open) => setTaskPopup(open ? 'weekday' : undefined)} value={taskWeekday} options={[1, 2, 3, 4, 5, 6, 0].map((value) => ({ value, label: weekdays[value] }))} onChange={setTaskWeekday} />}
        {task.repeat === 'monthly' && <Select aria-label="每月提醒日期" disabled={busy} open={active && taskOpen && !busy && taskPopup === 'day'} onOpenChange={(open) => setTaskPopup(open ? 'day' : undefined)} value={taskDay} options={Array.from({ length: 31 }, (_, index) => ({ value: index + 1, label: `${index + 1} 号` }))} onChange={setTaskDay} />}
        <TimePicker {...taskPicker} disabled={busy} aria-label="重复提醒时间" value={dayjs(`2000-01-01T${taskTime.slice(11)}`)} format="HH:mm" allowClear={false} inputReadOnly onChange={(value) => { if (value) setTaskTime(taskTime.slice(0, 11) + value.format('HH:mm:ss')); }} />
      </div>}
      <Checkbox disabled={busy} checked={task.priority === 'high'} onChange={(event) => setTask({ ...task, priority: event.target.checked ? 'high' : 'normal' })}>重要事项</Checkbox>
      <Input.TextArea aria-label="提醒备注" disabled={busy} placeholder="备注" rows={3} maxLength={2000} value={task.note} onChange={(event) => setTask({ ...task, note: event.target.value })} />
    </Space>}</Modal>
    <Modal title="请假／外出／加班记录" forceRender open={active && leaveOpen} focusTriggerAfterClose={active} okText={leaveEditing ? '保存修改' : '保存记录'} cancelText="取消" confirmLoading={busy} cancelButtonProps={{ disabled: busy }} onCancel={(event) => { if (!busyRef.current && !composingCancel(event)) setLeaveOpen(false); }} onOk={() => void run(saveLeave)}>
      <Space direction="vertical" className="full-width">
        <Select aria-label="记录重复规则" disabled={busy} open={active && leaveOpen && !busy && leavePopup === 'repeat'} onOpenChange={open => setLeavePopup(open ? 'repeat' : undefined)} value={leaveRepeat} className="full-width" options={[{ value: 'none', label: '不重复' }, { value: 'weekly', label: '每周重复' }]} onChange={(value: 'none' | 'weekly') => { setLeaveRepeat(value); setEnd(value === 'weekly' ? '' : start); }} />
        {leaveRepeat === 'weekly' && <Checkbox.Group aria-label="每周重复日期" disabled={busy} value={leaveWeekdays} options={[1, 2, 3, 4, 5, 6, 0].map(value => ({ value, label: weekdays[value].replace('星期', '周') }))} onChange={values => setLeaveWeekdays(values.map(Number))} />}
        <Space wrap>
          <DatePicker {...startPicker} aria-label="请假开始日期" disabled={busy} value={dayjs(start)} format="YYYY/MM/DD" allowClear={false} inputReadOnly classNames={{ popup: { root: 'work-calendar-date-picker' } }} style={{ width: 160 }} onChange={value => { if (value) { const day = value.format('YYYY-MM-DD'); setStart(day); if (end && day > end) setEnd(day); } }} />
          <DatePicker {...endPicker} aria-label="请假结束日期" disabled={busy} value={end ? dayjs(end) : null} placeholder={leaveRepeat === 'weekly' ? '不设结束日期' : '结束日期'} format="YYYY/MM/DD" allowClear={leaveRepeat === 'weekly'} inputReadOnly classNames={{ popup: { root: 'work-calendar-date-picker' } }} style={{ width: 160 }} onChange={value => setEnd(value?.format('YYYY-MM-DD') ?? '')} />
        </Space>
        <Select aria-label="请假时段" disabled={busy} open={active && leaveOpen && !busy && leavePopup === 'part'} onOpenChange={open => setLeavePopup(open ? 'part' : undefined)} value={part} className="full-width" options={[{ value: 'day', label: '整天' }, { value: 'am', label: '上午 08:00–12:00' }, { value: 'pm', label: '下午 14:00–18:00' }]} onChange={setPart} />
        <Select aria-label="请假外出加班类型" disabled={busy} open={active && leaveOpen && !busy && leavePopup === 'reason'} onOpenChange={open => setLeavePopup(open ? 'reason' : undefined)} value={reason} className="full-width" options={['请假', '外出', '加班'].map(value => ({ value, label: value }))} onChange={setReason} />
        {reason !== '请假' && <Input.TextArea aria-label={reason + '备注'} disabled={busy} placeholder={reason + '备注'} rows={3} value={leaveNote} maxLength={2000} onChange={event => setLeaveNote(event.target.value)} />}
        {leaveRepeat === 'weekly' && <Typography.Text type="secondary">按所选星期重复生效；删除记录会移除整条重复规则。</Typography.Text>}
      </Space>
    </Modal>
  </div>;
}
