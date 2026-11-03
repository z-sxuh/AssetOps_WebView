import { DownloadOutlined, EyeOutlined, RollbackOutlined, SearchOutlined, UploadOutlined } from '@ant-design/icons';
import { Alert, Button, Card, Checkbox, DatePicker, Descriptions, Drawer, Empty, Input, Modal, Popconfirm, Space, Table, Tag, Typography, message } from 'antd';
import Select from '../../components/AppSelect';
import type { ColumnsType } from 'antd/es/table';
import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import dayjs from 'dayjs';
import { useTableBodyHeight } from '../../useTableBodyHeight';
import { usePageSize } from '../../usePageSize';
import type { ChangeItem, ChangeRecord, ChangeSource, VaultData } from '../../model';
import type { VaultSession } from '../../vaultSession';
import { native } from '../../native';
import { chinaDate, shiftDate } from '../reports/reportModel';
import { archiveHistory, archiveRange, importHistoryArchive, prepareHistoryArchive, recordsInArchiveRange, type ArchivePeriod, type HistoryArchive } from './historyArchive';

const { Text, Title } = Typography;
const sourceColors: Record<ChangeSource, string> = { 手动: 'blue', 批量: 'purple', 导入: 'orange', 回滚: 'red', 恢复: 'green', 系统: 'default' };
const sourceColor = (source: unknown) => typeof source === 'string' && Object.hasOwn(sourceColors, source) ? sourceColors[source as ChangeSource] : 'default';

type Props = {
  active?: boolean;
  data: VaultData;
  session: VaultSession;
  assetFilter?: { id: string; name: string } | null;
  onClearAssetFilter: () => void;
  onRollback: (record: ChangeRecord) => Promise<void> | void;
  onRollbackItem: (record: ChangeRecord, item: ChangeItem) => Promise<void> | void;
  onExport: (includePasswords: boolean) => Promise<void> | void;
};

function valueText(value: unknown, fieldKey?: string): string {
  if (fieldKey === 'accounts' && Array.isArray(value)) return value.map((account) => account && typeof account === 'object' && !Array.isArray(account) ? `${typeof account.username === 'string' ? account.username : account.username == null ? '' : valueText(account.username)}: ${valueText(account.password || '（空）')}` : valueText(account)).join('；');
  if (value === null || value === undefined || value === '') return '—';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function DiffList({ items }: { items: ChangeItem[] }) {
  return items.length ? <div className="diff-list">{items.map((item, index) => <div className="diff-item" key={`${item.fieldKey}-${index}`}>
    <b>{valueText(item.fieldLabel || item.fieldKey)}</b>
    <span className="diff-old">{valueText(item.before, item.fieldKey)}</span><span>→</span><span className="diff-new">{valueText(item.after, item.fieldKey)}</span>
  </div>)}</div> : <Text type="secondary">该旧记录没有字段级差异。</Text>;
}

export function matchesHistoryAsset(record: ChangeRecord, assetId?: string) {
  return !assetId || record.assetId === assetId || (record.objectType === 'asset' && record.objectId === assetId);
}

export default function HistoryPage({ active = true, data, session, assetFilter, onClearAssetFilter, onRollback, onRollbackItem, onExport }: Props) {
  const [msg, context] = message.useMessage({ maxCount: 3 });
  const [archivePeriod, setArchivePeriod] = useState<ArchivePeriod>('month');
  const [archiveDate, setArchiveDate] = useState(chinaDate());
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [auditOpen, setAuditOpen] = useState(false), [auditPasswords, setAuditPasswords] = useState(false), [auditConfirm, setAuditConfirm] = useState(false);
  const [archivePassword, setArchivePassword] = useState('');
  const [imported, setImported] = useState<HistoryArchive>();
  const [importOpen, setImportOpen] = useState(false);
  const [importFile, setImportFile] = useState<File>();
  const [importPassword, setImportPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const importInput = useRef<HTMLInputElement>(null);
  const importRead = useRef<AbortController | null>(null);
  const [readingArchive, setReadingArchive] = useState(false);
  useLayoutEffect(() => { if (!active) { importRead.current?.abort(); setArchivePassword(''); setImportPassword(''); } return () => importRead.current?.abort(); }, [active]);
  const [query, setQuery] = useState('');
  const [source, setSource] = useState<ChangeSource | 'all'>('all');
  const [field, setField] = useState('all');
  const [period, setPeriod] = useState<'all' | 'today' | '7d' | '30d'>('all');
  const [selected, setSelected] = useState<ChangeRecord>();
  const [detailOpen, setDetailOpen] = useState(false);
  const [dateOpen, setDateOpen] = useState(false);
  const [rollbackField, setRollbackField] = useState<string>();
  useLayoutEffect(() => { if (!active) setDateOpen(false); if (!active || !detailOpen) setRollbackField(undefined); }, [active, detailOpen]);
  const { pageSize, setPageSize, sizeChanger } = usePageSize();
  const records = useMemo(() => data.history.filter((record) => {
    if (!matchesHistoryAsset(record, assetFilter?.id)) return false;
    if (source !== 'all' && (record.source ?? '手动') !== source) return false;
    if (field !== 'all' && !(record.items ?? []).some((item) => item.fieldKey === field)) return false;
    if (period !== 'all') {
      const days = period === 'today' ? 1 : period === '7d' ? 7 : 30;
      if (new Date(record.at).getTime() < Date.now() - days * 86_400_000) return false;
    }
    const needle = query.trim().toLowerCase();
    if (!needle) return true;
    return `${record.assetName} ${record.objectName ?? ''} ${record.action} ${record.note ?? ''} ${(record.items ?? []).map((item) => `${item.fieldLabel} ${valueText(item.before, item.fieldKey)} ${valueText(item.after, item.fieldKey)}`).join(' ')}`.toLowerCase().includes(needle);
  }), [data.history, field, period, query, source, assetFilter?.id]);
  const fields = useMemo(() => Array.from(new Map(data.history.flatMap((record) => record.items ?? []).map((item) => [item.fieldKey, valueText(item.fieldLabel || item.fieldKey)])).entries()), [data.history]);
  const range = useMemo(() => archiveRange(archiveDate, archivePeriod), [archiveDate, archivePeriod]);
  const archiveRecords = useMemo(() => recordsInArchiveRange(records, range), [records, range]);
  const rangeLabel = `${range.start.slice(0, 10)} 至 ${shiftDate(range.end.slice(0, 10), -1)}`;
  const run = async (operation: () => Promise<void>) => {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(true);
    try { await operation(); } catch (error) { if (!(error instanceof DOMException && error.name === 'AbortError')) msg.error(error instanceof Error ? error.message : String(error)); }
    finally { busyRef.current = false; setBusy(false); }
  };
  const exportArchive = async () => {
    const result = await archiveHistory(session, data, archiveRecords, range, {
      export: (ids, range) => native.exportHistoryArchive(ids, range, archivePassword),
      compact: native.compactHistoryDatabase,
      backup: data.settings.backupBeforeWrite && native.desktop ? () => native.createBackup('pre-schema') : undefined,
    });
    setArchiveOpen(false);
    if (selected && result.archive.records.some(record => record.id === selected.id)) setDetailOpen(false);
    msg.success({ content: <Space><span>已校验并归档 {result.removed} 条记录：{result.path}</span><Button type="link" size="small" onClick={() => void native.revealInFolder(result.path)}>打开目录</Button></Space>, duration: 8 });
    if (result.compactError) msg.warning(`归档已完成，数据库空间整理未完成：${result.compactError}`);
  };
  const readArchive = async (file: File) => {
    const controller = new AbortController(); importRead.current = controller; setReadingArchive(true);
    try {
      const archive = await native.readHistoryArchive(file, importPassword);
      await prepareHistoryArchive(session, data, archive, controller.signal);
      setImported(archive); setImportPassword(''); setImportOpen(true);
    } finally { if (importRead.current === controller) importRead.current = null; setReadingArchive(false); }
  };
  const saveImported = async () => {
    if (!imported) return;
    const result = await importHistoryArchive(session, data, imported);
    setImportOpen(false);
    msg.success(`已导入 ${result.added} 条记录，跳过 ${result.skipped} 条相同记录`);
  };

  const columns: ColumnsType<ChangeRecord> = [
    { title: '时间', dataIndex: 'at', width: '18%', sorter: (a, b) => a.at.localeCompare(b.at), defaultSortOrder: 'descend', render: (value: string) => new Date(value).toLocaleString('zh-CN', { hour12: false }) },
    { title: '对象', key: 'object', width: '20%', ellipsis: true, render: (_, value) => <div className="asset-name-cell"><b>{valueText(value.objectName || value.assetName)}</b><span>{valueText(value.objectType || 'asset')} · {valueText(value.objectId || value.assetId)}</span></div> },
    { title: '操作', dataIndex: 'action', width: 72, render: (value: string) => <Tag>{valueText(value)}</Tag> },
    { title: '来源', dataIndex: 'source', width: 80, render: (value: ChangeSource | undefined) => <Tag color={sourceColor(value ?? '手动')}>{valueText(value ?? '手动')}</Tag> },
    { title: '变更摘要', key: 'summary', ellipsis: true, render: (_, value) => (value.items ?? []).length ? `${value.items!.length} 个字段：${value.items!.map((item) => valueText(item.fieldLabel || item.fieldKey)).join('、')}` : valueText(value.note) },
    { title: '批次', dataIndex: 'batchId', width: '15%', ellipsis: true, render: (value?: string) => value ? <Text code ellipsis title={valueText(value)}>{valueText(value)}</Text> : '—' },
    { title: '操作', key: 'actions', width: 152, render: (_, value) => <Space size={0}><Button type="link" size="small" icon={<EyeOutlined />} onClick={() => { setSelected(value); setDetailOpen(true); }}>详情</Button><Button type="link" size="small" icon={<RollbackOutlined />} disabled={!value.items?.length || value.action === '回滚'} onClick={() => void onRollback(value)}>回滚</Button></Space> },
  ];

  const { hostRef, bodyHeight } = useTableBodyHeight([".module-toolbar"]);

  return <div className="page-content instant-list-page module-page fixed-page">{context}
    <div className="page-heading"><div><Title level={2}>历史变更</Title></div><Space wrap>
      <Select active={active} aria-label="归档周期" value={archivePeriod} onChange={setArchivePeriod} disabled={busy} options={[{ value: 'week', label: '按周归档' }, { value: 'month', label: '按月归档' }]} style={{ width: 132 }} />
      <DatePicker aria-label="归档日期" open={active && dateOpen} onOpenChange={setDateOpen} picker={archivePeriod} value={dayjs(archiveDate)} allowClear={false} inputReadOnly disabled={busy} format={archivePeriod === 'month' ? 'YYYY年MM月' : 'YYYY/MM/DD'} onChange={date => { if (date) setArchiveDate(date.format('YYYY-MM-DD')); }} />
      <Button icon={<DownloadOutlined />} disabled={busy || !archiveRecords.length} onClick={() => setArchiveOpen(true)}>归档 ZIP（{archiveRecords.length}）</Button>
      <Button icon={<UploadOutlined />} disabled={busy} onClick={() => importInput.current?.click()}>导入 ZIP</Button>
      {readingArchive && <Button onClick={() => importRead.current?.abort()}>取消读取</Button>}
      <Button icon={<DownloadOutlined />} disabled={busy} onClick={() => { setAuditPasswords(false); setAuditOpen(true); }}>导出审计表</Button>
      <input ref={importInput} type="file" accept=".zip" hidden onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; if (file) { setImported(undefined); setImportFile(file); setImportPassword(''); setImportOpen(true); } }} />
    </Space></div>
    {assetFilter && <div className="history-asset-filter"><Tag color="blue" closable onClose={onClearAssetFilter}>服务器：{assetFilter.name}</Tag><Text type="secondary">仅显示此服务器的变更</Text></div>}
    <div className="fixed-table-host" ref={hostRef}><Card className="panel-card fixed-table-card" bordered={false}>
      <div className="module-toolbar"><Space wrap><Input value={query} allowClear prefix={<SearchOutlined />} placeholder="搜索服务器、字段或变更内容" style={{ width: 320 }} onChange={(event) => setQuery(event.target.value)} /><Select active={active} aria-label="变更时间范围" value={period} style={{ width: 120 }} onChange={setPeriod} options={[{ value: 'all', label: '全部时间' }, { value: 'today', label: '最近 24 小时' }, { value: '7d', label: '最近 7 天' }, { value: '30d', label: '最近 30 天' }]} /><Select active={active} aria-label="变更来源" value={source} style={{ width: 125 }} onChange={setSource} options={[{ value: 'all', label: '全部来源' }, ...(['手动', '批量', '导入', '回滚', '恢复', '系统'] as ChangeSource[]).map((value) => ({ value, label: value }))]} /><Select active={active} aria-label="变更字段" value={field} style={{ width: 150 }} onChange={setField} options={[{ value: 'all', label: '全部字段' }, ...fields.map(([value, label]) => ({ value, label }))]} /></Space></div>
      <Table<ChangeRecord> rowKey="id" columns={columns} dataSource={records} className="history-table" tableLayout="fixed" scroll={{ y: bodyHeight }} pagination={{ size: 'small', pageSize, pageSizeOptions: [25, 50, 100], showSizeChanger: sizeChanger, showTotal: (count) => `共 ${count} 条变更` }} onChange={(pagination) => setPageSize(pagination.pageSize ?? 25)} locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有变更记录" /> }} />
    </Card></div>
    <Drawer title="变更详情" width={620} open={active && detailOpen} autoFocus={active} onClose={() => setDetailOpen(false)} afterOpenChange={(open) => { if (!open && !detailOpen) setSelected(undefined); }}>
      {selected && <Space direction="vertical" size={18} style={{ width: '100%' }}>
        <Descriptions bordered size="small" column={1}>
          <Descriptions.Item label="对象">{valueText(selected.objectName || selected.assetName)}</Descriptions.Item>
          <Descriptions.Item label="对象标识">{valueText(selected.objectId || selected.assetId)}</Descriptions.Item>
          <Descriptions.Item label="时间">{new Date(selected.at).toLocaleString('zh-CN', { hour12: false })}</Descriptions.Item>
          <Descriptions.Item label="操作 / 来源"><Tag>{valueText(selected.action)}</Tag><Tag color={sourceColor(selected.source ?? '手动')}>{valueText(selected.source ?? '手动')}</Tag></Descriptions.Item>
          <Descriptions.Item label="批次">{selected.batchId ? <Text code>{valueText(selected.batchId)}</Text> : '—'}</Descriptions.Item>
          <Descriptions.Item label="说明">{valueText(selected.note)}</Descriptions.Item>
        </Descriptions>
        <div><Text strong>字段级差异</Text><div style={{ marginTop: 10 }}><DiffList items={selected.items ?? []} /></div>{Boolean(selected.before && selected.after) && selected.action !== '回滚' && <Space wrap style={{ marginTop: 12 }}>{(selected.items ?? []).map((item, index) => <Popconfirm key={`${item.fieldKey}-${index}`} open={active && detailOpen && rollbackField === `${item.fieldKey}-${index}`} onOpenChange={(open) => setRollbackField(open ? `${item.fieldKey}-${index}` : undefined)} title={`只回滚“${item.fieldLabel || item.fieldKey}”？`} okText="回滚字段" cancelText="取消" onConfirm={() => void onRollbackItem(selected, item)}><Button size="small" icon={<RollbackOutlined />}>回滚 {item.fieldLabel || item.fieldKey}</Button></Popconfirm>)}</Space>}</div>
        {selected.assetId && (() => { const asset = data.assets.find((item) => item.id === selected.assetId); return asset ? <Descriptions title="当前资产" bordered size="small" column={1}><Descriptions.Item label="服务器">{asset.name}</Descriptions.Item><Descriptions.Item label="主机名">{asset.host}</Descriptions.Item><Descriptions.Item label="IP">{asset.ip || '—'}</Descriptions.Item><Descriptions.Item label="状态">{asset.status}</Descriptions.Item></Descriptions> : <Text type="secondary">该资产当前不在台账中。</Text>; })()}
      </Space>}
    </Drawer>
    <Modal title="导出审计表" open={active && auditOpen} focusTriggerAfterClose={active} onCancel={() => { if (!busy) setAuditOpen(false); }} confirmLoading={busy} okText="导出审计表" cancelText="取消" onOk={() => { if (auditPasswords) setAuditConfirm(true); else void run(async () => { await onExport(false); setAuditOpen(false); }); }}>
      <p>密码等敏感字段默认隐藏。</p><Checkbox checked={auditPasswords} onChange={event => setAuditPasswords(event.target.checked)}>包含明文密码</Checkbox>
    </Modal>
    <Modal title="确认导出明文密码？" open={active && auditOpen && auditConfirm} focusTriggerAfterClose={active} onCancel={() => { if (!busy) setAuditConfirm(false); }} confirmLoading={busy} okText="确认导出明文密码" okButtonProps={{ danger: true }} cancelText="取消" onOk={() => void run(async () => { await onExport(true); setAuditConfirm(false); setAuditOpen(false); })}>
      <Alert type="warning" showIcon message="文件将包含历史账号密码" description="请妥善保管导出文件，并在使用后及时删除。" />
    </Modal>
    <Modal title="归档历史变更" open={active && archiveOpen} focusTriggerAfterClose={active} afterClose={() => { if (!archiveOpen) setArchivePassword(''); }} onCancel={() => { if (!busy) setArchiveOpen(false); }} onOk={() => void run(exportArchive)} confirmLoading={busy} okText="校验后归档并移走" okButtonProps={{ disabled: !archivePassword }} cancelText="取消" closable={!busy} maskClosable={!busy} keyboard={!busy} cancelButtonProps={{ disabled: busy }}>
      <p>{rangeLabel}，当前筛选范围内共 {archiveRecords.length} 条记录。</p>
      <Alert type="info" showIcon message="先将记录写入加密 ZIP 并回读校验，再从主数据库移走并整理空间。之后可通过导入 ZIP 恢复这些历史记录。" />
      <Input.Password aria-label="归档当前主密码" autoComplete="current-password" disabled={busy} placeholder="输入当前主密码加密归档" value={archivePassword} onChange={event => setArchivePassword(event.target.value)} style={{ marginTop: 12 }} />
      <Text type="secondary">归档由当前主密码独立加密。以后修改主密码，读取此文件仍需归档时的密码。</Text>
    </Modal>
    <Modal title="导入历史变更" open={active && importOpen} focusTriggerAfterClose={active} onCancel={() => { if (readingArchive) importRead.current?.abort(); if (!busy || readingArchive) setImportOpen(false); }} onOk={() => void run(imported ? saveImported : async () => { if (importFile) await readArchive(importFile); })} afterClose={() => { if (!importOpen) { setImported(undefined); setImportFile(undefined); setImportPassword(''); } }} confirmLoading={busy && !readingArchive} okButtonProps={{ loading: busy, disabled: busy || (!imported && !importFile) }} okText={imported ? '导入记录' : '读取归档'} cancelText="取消" closable={!busy || readingArchive} maskClosable={!busy} keyboard={!busy} cancelButtonProps={{ disabled: busy && !readingArchive }}>
      {!imported && <><p>{importFile?.name}</p><Input.Password aria-label="历史归档主密码" autoComplete="off" disabled={busy} placeholder="归档时使用的主密码（旧版归档可留空）" value={importPassword} onChange={event => setImportPassword(event.target.value)} /></>}
      {imported?.insecureLegacy && <Alert type="warning" showIcon message="此为旧版弱保护归档" description="导入后请使用新版重新归档，核对成功后删除旧归档文件。" />}
      {imported && <><p>{imported.start.slice(0, 10)} 至 {shiftDate(imported.end.slice(0, 10), -1)}，共 {imported.records.length} 条历史记录。</p><Text type="secondary">相同记录会自动跳过；遇到同标识但内容不同的记录会取消导入。</Text></>}
    </Modal>
  </div>;
}
