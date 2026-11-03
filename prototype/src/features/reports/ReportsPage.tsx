import { lazy, memo, Suspense, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Alert, Button, Checkbox, DatePicker, Dropdown, Input, Modal, Space, Table, Tabs, Typography, message } from 'antd';
import dayjs from 'dayjs';
import Select from '../../components/AppSelect';
import DateTimeInput from '../../components/DateTimeInput';
import { DeleteOutlined, DownloadOutlined, MoreOutlined, PlusOutlined, UploadOutlined } from '@ant-design/icons';
import type { VaultData } from '../../model';
import { displayPath } from '../../model';
import { id } from '../../model';
import { native } from '../../native';
import { bindEntryScope, chinaDate, chinaTime, entryScopeValue, entryInScope, resolveEntryScope, exportReport, kindNames, newReport, period, reportEntryCount, validDate, workdayCount, type EntryScope } from './reportModel';
import { reportSections, type ReportKind, type ReportsData, type WorkEntry, type WorkReport } from './types';
import WorkCalendarView from './WorkCalendarView';
import ScopeSelect from './ScopeSelect';
import { useTableBodyHeight } from '../../useTableBodyHeight';
import { usePageSize } from '../../usePageSize';
import { exportWorkEntries } from './workEntryTransfer';
import type { WorkEntryImportResponse, WorkEntryImportResult } from './workEntryImport.worker';
import { composingCancel } from '../../composition';
import type { MarkdownEditorHandle } from '../../components/MarkdownEditor';

type Props = { data: VaultData; active?: boolean; embedded?: 'entries' | 'reports'; focusId?: string; onOpenPage?: () => void; onFocusHandled: () => void; onChange: (next: ReportsData) => Promise<void> };
const MarkdownEditor = lazy(() => import('../../components/MarkdownEditor'));
const allScopes = [{ title: '全部单位', value: '', path: '全部单位', scope: {} }];
function ReportsPage({ data, active = true, embedded, focusId, onOpenPage, onFocusHandled, onChange }: Props) {
  const [msg, context] = message.useMessage({ maxCount: 3 });
  const [tab, setTab] = useState<string>(embedded ?? 'entries');
  const [includeRecordTime, setIncludeRecordTime] = useState(false);
  const [kind, setKind] = useState<ReportKind>('week');
  const [date, setDate] = useState(chinaDate());
  const [weekRange, setWeekRange] = useState(() => period('week', chinaDate()));
  const [filterScope, setFilterScope] = useState<EntryScope>({ unitId: data.settings.reportUnitId || undefined });
  useLayoutEffect(() => { if (filterScope.unitId && !entryScopeValue(filterScope, data.units)) setFilterScope({}); }, [filterScope, data.units]);
  const [bindingEntryId, setBindingEntryId] = useState<string>();
  const [entry, setEntry] = useState<WorkEntry>();
  const [entryOpen, setEntryOpen] = useState(false); const [entryEditing, setEntryEditing] = useState(false);
  const [entryTime, setEntryTime] = useState('');
  const entrySession = useRef(0); const entrySavingSession = useRef<number>();
  useEffect(() => () => { entrySession.current++; }, []);
  const [entryTypeOpen, setEntryTypeOpen] = useState(false);
  const [cycleOpen, setCycleOpen] = useState(false);
  const [reportDateOpen, setReportDateOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState<string>();
  useLayoutEffect(() => { if (!active) { setCycleOpen(false); setReportDateOpen(false); setMenuOpen(undefined); } }, [active]);
  useLayoutEffect(() => { if (!active || !entryOpen) setEntryTypeOpen(false); }, [active, entryOpen]);
  const [report, setReport] = useState<WorkReport>();
  const [reportOpen, setReportOpen] = useState(false);
  const [reportText, setReportText] = useState('');
  const reportEditor = useRef<MarkdownEditorHandle>(null);
  const [reportPending, setReportPending] = useState(false);
  const reportSession = useRef(0);
  useEffect(() => () => { reportSession.current++; }, []);
  const [deleteTarget, setDeleteTarget] = useState<{ kind: 'record' | 'report'; id: string; ids?: string[] }>();
  const [selectedReports, setSelectedReports] = useState<string[]>([]);
  useEffect(() => { setSelectedReports((current) => { const remaining = current.filter((reportId) => data.reports.reports.some((report) => report.id === reportId)); return remaining.length === current.length ? current : remaining; }); }, [data.reports.reports]);
  const [selectedEntries, setSelectedEntries] = useState<string[]>([]);
  useEffect(() => { setSelectedEntries((current) => { const remaining = current.filter((id) => data.reports.entries.some((entry) => entry.id === id && entryInScope(entry, filterScope, data.units))); return remaining.length === current.length ? current : remaining; }); }, [data.reports.entries, filterScope, data.units]);
  const [importOpen, setImportOpen] = useState(false); const [importFile, setImportFile] = useState<File>(); const importInput = useRef<HTMLInputElement>(null);
  const [importResult, setImportResult] = useState<WorkEntryImportResult>();
  const [importParsing, setImportParsing] = useState(false);
  const importRequest = useRef(0); const importWorker = useRef<Worker>();
  const importSnapshot = useRef<{ units: VaultData['units']; entries: WorkEntry[] }>();
  const importPreview = importSnapshot.current?.units === data.units && importSnapshot.current.entries === data.reports.entries ? importResult : undefined;
  const closeImport = () => {
    importRequest.current++; importWorker.current?.terminate(); importWorker.current = undefined;
    setImportOpen(false); setImportFile(undefined); setImportResult(undefined); setImportParsing(false);
  };
  useEffect(() => {
    const request = ++importRequest.current;
    setImportResult(undefined); setImportParsing(false);
    if (!importOpen || !importFile) return;
    importSnapshot.current = { units: data.units, entries: data.reports.entries };
    let worker: Worker | undefined;
    try {
      worker = new Worker(new URL('./workEntryImport.worker.ts', import.meta.url), { type: 'module' });
      importWorker.current = worker; setImportParsing(true);
      worker.onmessage = ({ data: response }: MessageEvent<WorkEntryImportResponse>) => {
        if (request !== importRequest.current || response.request !== request) return;
        setImportResult(response.result); setImportParsing(false); worker?.terminate();
        if (importWorker.current === worker) importWorker.current = undefined;
      };
      worker.onerror = (event) => {
        event.preventDefault();
        if (request !== importRequest.current) return;
        setImportResult({ error: '工作记录校验失败，请重新选择文件' }); setImportParsing(false); worker?.terminate();
        if (importWorker.current === worker) importWorker.current = undefined;
      };
      worker.postMessage({ request, file: importFile, units: data.units, existingIds: data.reports.entries.map(entry => entry.id) });
    } catch (error) {
      worker?.terminate(); if (importWorker.current === worker) importWorker.current = undefined;
      setImportResult({ error: error instanceof Error ? error.message : String(error) }); setImportParsing(false);
    }
    return () => { importRequest.current++; worker?.terminate(); if (importWorker.current === worker) importWorker.current = undefined; };
  }, [importOpen, importFile, data.units, data.reports.entries]);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const entrySaving = busy && entrySavingSession.current === entrySession.current;
  const [historyOpen, setHistoryOpen] = useState(false);
  const range = kind === 'week' ? (validDate(weekRange.start) && validDate(weekRange.end) && weekRange.start <= weekRange.end && Date.parse(weekRange.end) - Date.parse(weekRange.start) <= 366 * 86_400_000 ? weekRange : undefined) : validDate(date) ? period(kind, date) : undefined;
  const calendar = data.reports.calendar;
  const archiveSummary = useMemo(() => active && tab === 'reports' && (!embedded || embedded === 'reports') && range ? {
    days: workdayCount(range.start, range.end, calendar), entries: reportEntryCount(data.reports.entries, range, calendar),
  } : undefined, [active, tab, embedded, data.reports.entries, calendar, range?.start, range?.end]);
  const run = async (operation: () => Promise<void>) => { if (busyRef.current) return; busyRef.current = true; setBusy(true); try { await operation(); } catch (error) { msg.error(error instanceof Error ? error.message : String(error)); } finally { busyRef.current = false; setBusy(false); } };
  const openEntry = (value?: WorkEntry) => {
    entrySession.current++; setEntryTypeOpen(false);
    setEntryEditing(Boolean(value)); setEntryOpen(true);
    const at = new Date().toISOString();
    const fresh: WorkEntry = { id: id(), text: '', section: '完成事项', scopeName: '', at, createdAt: at, updatedAt: at };
    const scope = entryScopeValue(filterScope, data.units);
    setEntry(value ?? (scope ? bindEntryScope(fresh, scope, data.units, at) : fresh));
    setEntryTime(chinaTime(value?.at ?? at).replace(' ', 'T'));
  };
  const closeEntry = () => {
    if (entrySavingSession.current === entrySession.current) return;
    entrySession.current++; setEntryOpen(false);
  };
  const saveEntry = async () => {
    if (!entry?.text.trim() || !entryTime) throw new Error('请填写工作内容与时间');
    if (!entry.unitId && !entry.systemId) throw new Error('请选择工作记录所属单位或系统');
    const scope = entryScopeValue(entry, data.units);
    if (!scope) throw new Error('所选目录已不存在，请重新选择');
    const current = data.reports.entries.find((item) => item.id === entry.id);
    if (entryEditing && (!current || current.updatedAt !== entry.updatedAt)) throw new Error('记录已更新，请重新打开');
    const at = new Date(`${entryTime}+08:00`).toISOString();
    const value = { ...bindEntryScope(entry, scope, data.units), text: entry.text.trim(), at };
    const session = entrySession.current;
    entrySavingSession.current = session; setEntryTypeOpen(false);
    try { await onChange({ ...data.reports, entries: [value, ...data.reports.entries.filter((item) => item.id !== value.id)] }); }
    catch (reason) { throw new Error(`工作记录“${value.text.slice(0, 30)}”保存失败：${reason instanceof Error ? reason.message : String(reason)}`); }
    finally { if (entrySavingSession.current === session) entrySavingSession.current = undefined; }
    if (session === entrySession.current) { entrySession.current++; setEntryOpen(false); }
    msg.success(`工作记录“${value.text.slice(0, 30)}”已保存`);
  };
  const openReport = (value: WorkReport) => { reportSession.current++; setReportPending(false); setReport(value); setReportOpen(true); setReportText(value.markdown); setHistoryOpen(false); };
  useEffect(() => {
    if (!focusId) return;
    if (focusId === 'calendar' || focusId === 'entries') { setTab(focusId); onFocusHandled(); return; }
    const foundReport = data.reports.reports.find((item) => item.id === focusId);
    const foundEntry = data.reports.entries.find((item) => item.id === focusId);
    if (foundReport) { setTab('reports'); openReport(foundReport); }
    else if (foundEntry) { setTab('entries'); openEntry(foundEntry); }
    onFocusHandled();
  }, [focusId]);
  const saveReportText = async () => {
    if (!report) return;
    const markdown = reportEditor.current?.flush() ?? reportText;
    const session = reportSession.current;
    const current = data.reports.reports.find((item) => item.id === report.id);
    if (!current || current.updatedAt !== report.updatedAt) throw new Error('报告已更新，请重新打开后编辑');
    if (markdown === current.markdown) return;
    const now = new Date().toISOString();
    const next = { ...current, markdown, updatedAt: now, revisions: [...current.revisions, { id: id(), at: now, markdown: current.markdown, sourceIds: current.sourceIds, reason: '手工编辑前' }] };
    try { await onChange({ ...data.reports, reports: data.reports.reports.map((item) => item.id === next.id ? next : item) }); }
    catch (reason) { throw new Error(`“${next.title}”保存失败：${reason instanceof Error ? reason.message : String(reason)}`); }
    if (session === reportSession.current) setReport(current => current?.id === next.id ? next : current);
    msg.success(`“${next.title}”已保存`);
  };
  const filteredEntries = useMemo(() => data.reports.entries.filter((item) => entryInScope(item, filterScope, data.units)).sort((a, b) => b.at.localeCompare(a.at)), [data.reports.entries, filterScope, data.units]);
  const filteredReports = useMemo(() => [...data.reports.reports].sort((a, b) => b.createdAt.localeCompare(a.createdAt)), [data.reports.reports]);
  const { hostRef, bodyHeight } = useTableBodyHeight([], [embedded, tab, filteredEntries.length], 40);
  const { pageSize, setPageSize, sizeChanger } = usePageSize();
  const exportAndOpen = async (name: string, content: string, extension: 'md' | 'json' = 'md') => {
    const path = await native.exportDocument(name, extension, content);
    msg.success({ content: <Space size={10}><span>{extension === 'json' ? 'JSON' : 'Markdown'} 已导出：{displayPath(path)}</span><Button size="small" type="link" style={{ padding: 0 }} onClick={() => void native.revealInFolder(path)}>打开目录</Button></Space>, duration: 8 });
  };
  const quickBindEntry = async (item: WorkEntry, value: string) => {
    setBindingEntryId(item.id);
    try {
    const current = data.reports.entries.find((entry) => entry.id === item.id);
    if (!current || current.updatedAt !== item.updatedAt) throw new Error('记录已更新，请刷新后重新选择系统');
    const next = bindEntryScope(current, value, data.units);
    await onChange({ ...data.reports, entries: data.reports.entries.map((entry) => entry.id === next.id ? next : entry) });
    } finally { setBindingEntryId(undefined); }
  };
  return <div className={`page-content module-page reports-page${!embedded && (tab === 'entries' || tab === 'reports') ? ' fixed-page work-records-page' : ''}${embedded ? ' embedded-reports' : ''}${embedded === 'entries' ? ' embedded-records' : ''}`}>
    {context}
    <div className="page-heading" onContextMenu={(event) => { if (onOpenPage && event.currentTarget.contains(event.target as Node)) { event.preventDefault(); onOpenPage(); } }}>{!embedded && <div><Typography.Title level={2}>工作报告</Typography.Title></div>}<Space className="report-heading-actions" wrap>
      {tab === 'entries' && <Space wrap>
        <ScopeSelect active={active} unitsOnly label="工作记录查询范围" units={data.units} scope={{}} value={entryScopeValue(filterScope, data.units) ?? ''} disabled={busy} extraNodes={allScopes} onChange={(value) => setFilterScope(resolveEntryScope(value, data.units) ?? {})} />
      </Space>}{tab === 'entries' && <><Button icon={<UploadOutlined />} disabled={busy} onClick={() => { setImportFile(undefined); setImportResult(undefined); setImportOpen(true); }}>导入</Button><Button icon={<DownloadOutlined />} disabled={busy || !selectedEntries.length} onClick={() => void run(() => exportAndOpen('工作记录', exportWorkEntries(filteredEntries.filter((entry) => selectedEntries.includes(entry.id)), data.units), 'json'))}>导出{selectedEntries.length ? `（${selectedEntries.length}）` : ''}</Button></>}{tab === 'entries' && <Button icon={<PlusOutlined />} onClick={() => openEntry()}>新增</Button>}</Space></div>
    <Tabs activeKey={tab} onChange={setTab} tabBarExtraContent={!embedded && <Space className="report-tab-actions">{tab === 'entries' && selectedEntries.length > 0 && <Button danger icon={<DeleteOutlined />} disabled={busy} onClick={() => { setDeleteTarget({ kind: 'record', id: '', ids: [...selectedEntries] }); setDeleteOpen(true); }}>删除</Button>}</Space>} items={[
      { key: 'entries', label: '工作记录', children: <div className={embedded ? 'embedded-record-list' : 'work-record-list'} ref={tab === 'entries' ? hostRef : undefined} style={{ '--report-body-height': `${bodyHeight}px` } as React.CSSProperties}><Table rowKey="id" dataSource={filteredEntries} rowSelection={{ selectedRowKeys: selectedEntries, preserveSelectedRowKeys: true, onChange: (keys) => setSelectedEntries(keys.map(String)), getCheckboxProps: () => ({ disabled: busy }) }} scroll={{ x: 850, y: bodyHeight }} pagination={embedded ? { pageSize: 25 } : { size: 'small', pageSize, showSizeChanger: sizeChanger, showTotal: (count) => `共 ${count} 条工作记录` }} onChange={(pagination) => { if (!embedded) setPageSize(pagination.pageSize ?? 25); }} columns={[
        { title: '时间', width: 175, render: (_, item: WorkEntry) => chinaTime(item.at) },
        { title: '类型', width: 120, dataIndex: 'section' }, { title: '工作内容', dataIndex: 'text', ellipsis: true }, { title: '系统', width: 310, render: (_, item: WorkEntry) => <span aria-busy={bindingEntryId === item.id}><ScopeSelect active={active} units={data.units} scope={item} disabled={busy && !bindingEntryId} onChange={(value) => void run(() => quickBindEntry(item, value))} /></span> },
        { title: '操作', width: 64, fixed: embedded ? 'right' : undefined, render: (_, item: WorkEntry) => <Dropdown placement="bottomRight" autoAdjustOverflow trigger={['click']} open={active && menuOpen === `record:${item.id}`} onOpenChange={(open) => setMenuOpen(open ? `record:${item.id}` : undefined)} menu={{ items: [{ key: 'edit', label: '编辑' }, { key: 'delete', label: '删除', danger: true }], onClick: ({ key }) => { setMenuOpen(undefined); if (key === 'edit') openEntry(item); else { setDeleteTarget({ kind: 'record', id: item.id }); setDeleteOpen(true); } } }}><Button size="small" type="text" aria-label="工作记录操作" icon={<MoreOutlined />} /></Dropdown> },
      ]} /></div> },
      { key: 'reports', label: '报告归档', children: <>
        <div className="module-toolbar report-cycle-toolbar"><Space wrap>
          <Select aria-label="报告周期" open={active && cycleOpen} onOpenChange={setCycleOpen} value={kind} options={Object.entries(kindNames).map(([value, label]) => ({ value, label }))} onChange={setKind} />
          {kind === 'week' ? <Space><DatePicker.RangePicker aria-label="周报日期范围" open={active && reportDateOpen} onOpenChange={setReportDateOpen} value={[dayjs(weekRange.start), dayjs(weekRange.end)]} format="YYYY/MM/DD" allowClear={false} inputReadOnly classNames={{ popup: { root: 'report-date-picker' } }} onChange={(value) => { if (value?.[0] && value[1]) setWeekRange({ start: value[0].format('YYYY-MM-DD'), end: value[1].format('YYYY-MM-DD') }); }} /><Button onClick={() => setWeekRange(period('week', chinaDate()))}>本周</Button></Space> : <DatePicker aria-label="报告日期" open={active && reportDateOpen} onOpenChange={setReportDateOpen} value={dayjs(date)} format="YYYY/MM/DD" allowClear={false} inputReadOnly classNames={{ popup: { root: 'report-date-picker' } }} onChange={(value) => { if (value) setDate(value.format('YYYY-MM-DD')); }} style={{ width: 158 }} />}
          <Checkbox checked={includeRecordTime} onChange={(event) => setIncludeRecordTime(event.target.checked)}>包含工作记录时间</Checkbox>
          <Button type="primary" disabled={busy || !range} onClick={() => void run(async () => { const next = newReport(data, kind, date, includeRecordTime, kind === 'week' ? range : undefined); await onChange({ ...data.reports, reports: [next, ...data.reports.reports] }); setTab('reports'); openReport(next); })}>收集{kindNames[kind]}</Button>
          {selectedReports.length > 0 && <Button danger disabled={busy} onClick={() => { setDeleteTarget({ kind: 'report', id: '', ids: selectedReports }); setDeleteOpen(true); }}>批量删除（{selectedReports.length}）</Button>}
        </Space></div>
        {range && archiveSummary && <div className="module-meta">{kind === 'week' && weekRange.start === period('week', weekRange.start).start && weekRange.end === period('week', weekRange.start).end ? '周五至下周四 · ' : ''}{range.start} 至 {range.end} · 计入 {archiveSummary.days} 天 · 收集 {archiveSummary.entries} 条记录</div>}
        <div className="report-archive-list" ref={tab === 'reports' ? hostRef : undefined} style={{ '--report-body-height': `${bodyHeight}px` } as React.CSSProperties}><Table rowKey="id" dataSource={filteredReports} scroll={embedded ? { x: 600 } : { y: bodyHeight }} rowSelection={{ selectedRowKeys: selectedReports, onChange: (keys) => setSelectedReports(keys.map(String)) }} pagination={{ pageSize: 15 }} columns={[
        { title: '报告', dataIndex: 'title', ellipsis: true }, { title: '更新时间', width: 175, render: (_, item: WorkReport) => chinaTime(item.updatedAt) },
        { title: '操作', width: 64, render: (_, item: WorkReport) => <Dropdown placement="bottomRight" autoAdjustOverflow trigger={['click']} open={active && menuOpen === `report:${item.id}`} onOpenChange={(open) => setMenuOpen(open ? `report:${item.id}` : undefined)} menu={{ items: [{ key: 'open', label: '查看／编辑' }, { key: 'export', label: '导出 Markdown' }, { key: 'delete', label: '删除', danger: true }], onClick: ({ key }) => { setMenuOpen(undefined); if (key === 'open') openReport(item); else if (key === 'export') void run(() => exportAndOpen(item.title, exportReport(item, calendar))); else { setDeleteTarget({ kind: 'report', id: item.id }); setDeleteOpen(true); } } }}><Button size="small" type="text" aria-label="报告操作" icon={<MoreOutlined />} /></Dropdown> },
        ]} /></div>
      </> },
      { key: 'calendar', label: '工作日历', children: <WorkCalendarView data={data} active={active && tab === 'calendar'} onChange={onChange} /> },
    ].filter((item) => !embedded || item.key === embedded)} />
    <Modal title="导入工作记录 JSON" open={active && importOpen} focusTriggerAfterClose={active} onCancel={() => { if (!busy) closeImport(); }} okText="导入" cancelText="取消" confirmLoading={busy} okButtonProps={{ disabled: importParsing || !importPreview || 'error' in importPreview || !importPreview.entries.length }} onOk={() => void run(async () => {
      if (!importPreview || 'error' in importPreview) return;
      await onChange({ ...data.reports, entries: [...importPreview.entries, ...data.reports.entries] }); closeImport(); msg.success(`已导入 ${importPreview.entries.length} 条工作记录，跳过 ${importPreview.skipped} 条重复记录`);
    })}>
      <Space direction="vertical" className="full-width"><Typography.Text>保留原记录时间、类型和完整工作内容，按现有组织目录的 ID 或完整路径匹配单位与系统；相同 ID 的记录跳过。</Typography.Text>
        <Button icon={<UploadOutlined />} disabled={busy} onClick={() => importInput.current?.click()}>选择工作记录 JSON</Button>
        <input ref={importInput} type="file" accept=".json,application/json" hidden onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ''; if (!file) return; if (file.size > 64 * 1024 * 1024) { msg.error('工作记录文件不能超过 64 MB'); return; } setImportFile(file); setImportResult(undefined); }} />
        {importParsing && <Alert type="info" showIcon message="正在读取并校验工作记录…" />}
        {importPreview && ('error' in importPreview ? <Alert type="error" showIcon message={importPreview.error} /> : <Alert type={importPreview.entries.length ? 'info' : 'success'} showIcon message={`将导入 ${importPreview.entries.length} 条工作记录，跳过 ${importPreview.skipped} 条重复记录`} />)}
      </Space>
    </Modal>
    <Modal className="work-entry-modal" title={entryEditing ? '编辑工作记录' : '新增工作记录'} forceRender open={active && entryOpen} focusTriggerAfterClose={active} afterClose={() => { if (entryOpen) return; setEntry(undefined); setEntryTime(''); }} confirmLoading={entrySaving} okButtonProps={{ disabled: busy }} cancelButtonProps={{ disabled: entrySaving }} closable={{ disabled: entrySaving }} keyboard={!entrySaving} maskClosable={!entrySaving} okText="保存" cancelText="取消" onCancel={(event) => { if (!composingCancel(event)) closeEntry(); }} onOk={() => void run(saveEntry)}>{entry && <Space direction="vertical" className="full-width">
      <DateTimeInput active={active && entryOpen && !entrySaving} disabled={entrySaving} aria-label="工作记录时间" className="full-width" value={entryTime} allowClear={false} onChange={setEntryTime} />
      <Select aria-label="工作记录类型" disabled={entrySaving} open={active && entryOpen && !entrySaving && entryTypeOpen} onOpenChange={setEntryTypeOpen} value={entry.section} options={reportSections.map((value) => ({ value, label: value }))} onChange={(section) => setEntry({ ...entry, section })} />
      <ScopeSelect active={active && entryOpen && !entrySaving} disabled={entrySaving} units={data.units} scope={entry} onChange={(value) => setEntry(bindEntryScope(entry, value, data.units, entry.updatedAt))} />
      <div className="work-entry-content"><Input.TextArea aria-label="工作记录内容" disabled={entrySaving} rows={7} maxLength={5000} value={entry.text} onChange={(event) => setEntry({ ...entry, text: event.target.value })} /><Typography.Text className="work-entry-count">{entry.text.length}/5000</Typography.Text></div>
    </Space>}</Modal>
    <Modal className="report-editor" title={report?.title} width={1000} forceRender open={active && tab === 'reports' && reportOpen} focusTriggerAfterClose={active && tab === 'reports'} footer={null} onCancel={(event) => { if (!composingCancel(event)) { try { reportEditor.current?.flush(); reportSession.current++; setReportOpen(false); } catch (error) { msg.error(String(error)); } } }} afterClose={() => { if (reportOpen) return; setReport(undefined); setReportText(''); setHistoryOpen(false); }}>{report && <>
      <div className="module-toolbar"><Button type="primary" disabled={busy || (!reportPending && reportText === report.markdown)} onClick={() => void run(saveReportText)}>保存正文</Button><Button onClick={() => void run(async () => { reportEditor.current?.flush(); setHistoryOpen((value) => !value); })}>修订历史（{report.revisions.length}）</Button><Button icon={<DownloadOutlined />} disabled={reportPending || reportText !== report.markdown} onClick={() => void run(() => exportAndOpen(report.title, exportReport(report, calendar)))}>导出 Markdown</Button></div>
      <Typography.Paragraph type="secondary">{report.sourceIds.length} 条工作记录 · {report.includeRecordTime === false ? '不含工作记录时间' : '包含工作记录时间'}；日历事项随报告存档。</Typography.Paragraph>
      {historyOpen ? <Table rowKey="id" size="small" dataSource={[...report.revisions].reverse()} columns={[{ title: '时间', render: (_, item) => chinaTime(item.at) }, { title: '说明', dataIndex: 'reason' }, { title: '操作', render: (_, item) => <Button onClick={() => { setReportPending(false); setReportText(item.markdown); setHistoryOpen(false); }}>载入到编辑区</Button> }]} /> : <Suspense fallback={<div className="markdown-editor-loading">正在载入编辑器…</div>}><MarkdownEditor ref={reportEditor} onDirtyChange={setReportPending} active={active && tab === 'reports' && reportOpen} key={report.id} label="报告正文" value={reportText} onChange={setReportText} placeholder="在此输入工作报告，可直接使用格式工具栏。" /></Suspense>}
    </>}</Modal>
    <Modal title={deleteTarget?.kind === 'report' ? '删除报告' : '删除工作记录'} open={active && deleteOpen} focusTriggerAfterClose={active} onCancel={() => { if (!busy) setDeleteOpen(false); }} confirmLoading={busy} okText="删除" cancelText="取消" okButtonProps={{ danger: true }} onOk={() => void run(async () => {
      if (deleteTarget?.kind === 'report') { const ids = new Set(deleteTarget.ids ?? [deleteTarget.id]); await onChange({ ...data.reports, reports: data.reports.reports.filter((item) => !ids.has(item.id)) }); setSelectedReports((keys) => keys.filter((key) => !ids.has(key))); }
      if (deleteTarget?.kind === 'record') { const ids = new Set(deleteTarget.ids ?? [deleteTarget.id]); await onChange({ ...data.reports, entries: data.reports.entries.filter((item) => !ids.has(item.id)) }); setSelectedEntries((keys) => keys.filter((key) => !ids.has(key))); }
      setDeleteOpen(false);
    })} afterClose={() => { if (!deleteOpen) setDeleteTarget(undefined); }}>{deleteTarget?.kind === 'report' ? `将删除 ${deleteTarget.ids?.length ?? 1} 份报告及其修订历史，原工作记录继续保留。` : `将删除 ${deleteTarget?.ids?.length ?? 1} 条工作记录，已生成报告中的内容不受影响。`}</Modal>
  </div>;
}

export default memo(ReportsPage);
