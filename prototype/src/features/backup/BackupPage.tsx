import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Empty,
  Input,
  InputNumber,
  Modal,
  Pagination,
  Popconfirm,
  Space,
  Statistic,
  Table,
  Tag,
  Typography,
  message,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { displayPath } from '../../model';
import { useTableBodyHeight } from '../../useTableBodyHeight';
import { usePageSize } from '../../usePageSize';
import { composingCancel } from '../../composition';
import {
  CloudDownloadOutlined,
  DeleteOutlined,
  SafetyCertificateOutlined,
  SaveOutlined,
  UndoOutlined,
} from '@ant-design/icons';

const { Text, Title } = Typography;

export type BackupKind = string;
export type BackupIntegrity = 'valid' | 'invalid' | 'checking' | 'unchecked';

export interface BackupInfo {
  id: string;
  fileName: string;
  kind: BackupKind;
  sizeBytes: number;
  createdAt: string;
  integrity: BackupIntegrity;
  path?: string;
  databaseVersion?: number;
}

export interface RetentionPolicy {
  recent: number;
  daily: number;
  weekly: number;
  monthly: number;
  yearly: number;
}

export interface BackupPageProps {
  active?: boolean;
  backups: BackupInfo[];
  retentionPolicy: RetentionPolicy;
  scheduledRetentionPolicy: RetentionPolicy;
  nextScheduledAt?: string | null;
  loading?: boolean;
  readReady?: boolean;
  readError?: string;
  onRetry?: () => void | Promise<void>;
  onBackupNow: () => Promise<BackupInfo | void>;
  onRestore: (backupId: string, password?: string) => Promise<void>;
  onDelete: (backupId: string) => Promise<void>;
  onDeleteMany: (backupIds: string[]) => Promise<Array<{ id: string; error: string }>>;
  onSavePolicy: (policy: RetentionPolicy, scheduledPolicy: RetentionPolicy) => Promise<void>;
  onCleanup: (policy: RetentionPolicy, scheduledPolicy: RetentionPolicy) => Promise<number>;
}

const kindMeta: Record<BackupKind, { label: string; color: string }> = {
  manual: { label: '手动', color: 'green' },
  'pre-import': { label: '导入前', color: 'orange' },
  startup: { label: '启动自动', color: 'blue' },
  scheduled: { label: '定时', color: 'magenta' },
  'pre-schema': { label: '结构变更前', color: 'purple' },
  'pre-restore': { label: '恢复前', color: 'cyan' },
  'pre-batch': { label: '批量操作前', color: 'orange' },
  'pre-batch-rollback': { label: '批量回滚前', color: 'purple' },
  'password-change': { label: '改密前', color: 'cyan' },
  reinitialize: { label: '重新初始化前', color: 'orange' },
};

const integrityMeta: Record<BackupIntegrity, { label: string; color: string }> = {
  valid: { label: '校验通过', color: 'green' },
  invalid: { label: '校验失败', color: 'red' },
  checking: { label: '校验中', color: 'processing' },
  unchecked: { label: '恢复时校验', color: 'blue' },
};

const policyFields: Array<{ key: keyof RetentionPolicy; label: string; suffix: string }> = [
  { key: 'recent', label: '保留最近', suffix: '份' },
  { key: 'daily', label: '每日保留', suffix: '份/天' },
  { key: 'weekly', label: '每周保留', suffix: '份/周' },
  { key: 'monthly', label: '每月保留', suffix: '份/月' },
  { key: 'yearly', label: '每年保留', suffix: '份/年' },
];

function errorText(reason: unknown) {
  return reason instanceof Error ? reason.message : String(reason || '未知错误');
}

function formatBytes(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** exponent).toFixed(exponent > 1 ? 1 : 0)} ${units[exponent]}`;
}

function formatDate(value?: string | null) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN', { hour12: false });
}

function samePolicy(left: RetentionPolicy, right: RetentionPolicy) {
  return policyFields.every(({ key }) => left[key] === right[key]);
}

function matchesKind(value: string, backup: BackupInfo) {
  return value === 'change' ? !['manual', 'startup', 'scheduled'].includes(backup.kind) : backup.kind === value;
}

export default function BackupPage({
  active = true,
  backups,
  retentionPolicy,
  scheduledRetentionPolicy,
  nextScheduledAt,
  loading = false,
  readReady = true,
  readError,
  onRetry,
  onBackupNow,
  onRestore,
  onDelete,
  onDeleteMany,
  onSavePolicy,
  onCleanup,
}: BackupPageProps) {
  const [messageApi, messageContext] = message.useMessage({ maxCount: 3 });
  const [modalApi, modalContext] = Modal.useModal();
  const confirmation = useRef<ReturnType<typeof modalApi.confirm>>();
  const [deletingBackup, setDeletingBackup] = useState<string>();
  const [kindOpen, setKindOpen] = useState(false);
  useLayoutEffect(() => { if (!active) { confirmation.current?.destroy(); confirmation.current = undefined; setDeletingBackup(undefined); setKindOpen(false); } }, [active]);
  useEffect(() => () => confirmation.current?.destroy(), []);
  const confirm = (options: Parameters<typeof modalApi.confirm>[0]) => { confirmation.current = modalApi.confirm({ ...options, focusTriggerAfterClose: active }); };
  const [policy, setPolicy] = useState<RetentionPolicy>(retentionPolicy);
  const [scheduledPolicy, setScheduledPolicy] = useState<RetentionPolicy>(scheduledRetentionPolicy);
  const [running, setRunning] = useState('');
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  useEffect(() => setSelectedIds((current) => current.filter((id) => backups.some((backup) => backup.id === id))), [backups]);
  const [savingPolicy, setSavingPolicy] = useState(false);
  const { pageSize, setPageSize, sizeChanger } = usePageSize();
  const [page, setPage] = useState(1);
  const [kindFilter, setKindFilter] = useState<string>();
  const [passwordBackup, setPasswordBackup] = useState<BackupInfo | null>(null);
  const [backupPassword, setBackupPassword] = useState('');
  const [restoreFeedback, setRestoreFeedback] = useState<{ type: 'success' | 'error'; text: string }>();
  const [restorePasswordError, setRestorePasswordError] = useState('');

  useEffect(() => setPolicy(retentionPolicy), [retentionPolicy.recent, retentionPolicy.daily, retentionPolicy.weekly, retentionPolicy.monthly, retentionPolicy.yearly]);
  useEffect(() => setScheduledPolicy(scheduledRetentionPolicy), [scheduledRetentionPolicy.recent, scheduledRetentionPolicy.daily, scheduledRetentionPolicy.weekly, scheduledRetentionPolicy.monthly, scheduledRetentionPolicy.yearly]);

  const sortedBackups = useMemo(() => [...backups].sort((left, right) => (
    new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime()
  )), [backups]);
  const latestBackup = sortedBackups.find((backup) => backup.kind !== 'manual');
  const filteredTotal = sortedBackups.filter((backup) => !kindFilter || matchesKind(kindFilter, backup)).length;
  const visibleBackupIds = useMemo(() => new Set(sortedBackups.filter((backup) => !kindFilter || matchesKind(kindFilter, backup)).map((backup) => backup.id)), [sortedBackups, kindFilter]);
  useEffect(() => setSelectedIds((current) => {
    const remaining = current.filter((id) => visibleBackupIds.has(id));
    return remaining.length === current.length ? current : remaining;
  }), [visibleBackupIds]);
  useEffect(() => setPage((current) => Math.min(current, Math.max(1, Math.ceil(filteredTotal / pageSize)))), [filteredTotal, pageSize]);
  const totalBytes = backups.reduce((sum, backup) => sum + Math.max(0, backup.sizeBytes || 0), 0);
  const policyChanged = !samePolicy(policy, retentionPolicy) || !samePolicy(scheduledPolicy, scheduledRetentionPolicy);

  const backupNow = async () => {
    setRunning('backup');
    try {
      const result = await onBackupNow();
      messageApi.success(result?.fileName ? `备份完成：${result.fileName}` : '备份完成');
    } catch (reason) {
      messageApi.error(`备份失败：${errorText(reason)}`, 6);
    } finally {
      setRunning('');
    }
  };

  const confirmRestore = (backup: BackupInfo) => {
    confirm({
      title: '确认恢复此备份？',
      icon: <UndoOutlined />,
      content: <Space direction="vertical" size={8}>
        <Text>{backup.fileName}</Text>
        <Alert type="warning" showIcon message="恢复前会完整校验备份并自动备份当前库；恢复业务数据时保留当前设置和备份目录。" />
      </Space>,
      okText: '备份当前库并恢复',
      cancelText: '取消',
      okButtonProps: { danger: true },
      onOk: async () => {
        setRestoreFeedback(undefined);
        setRunning(`restore:${backup.id}`);
        try {
          await onRestore(backup.id);
          setRestoreFeedback({ type: 'success', text: '备份已恢复，当前数据已更新；恢复前的数据库也已自动备份。' });
        } catch (reason) {
          if (errorText(reason) === '备份需要原主密码') {
            setPasswordBackup(backup);
            setBackupPassword('');
            setRestorePasswordError('');
            return;
          }
          setRestoreFeedback({ type: 'error', text: `恢复失败：${errorText(reason)}` });
        } finally {
          setRunning('');
        }
      },
    });
  };

  const deleteBackup = async (backup: BackupInfo) => {
    setRunning(`delete:${backup.id}`);
    try {
      await onDelete(backup.id);
      messageApi.success(`备份已移至 Windows 回收站：${backup.fileName}`);
    } catch (reason) {
      messageApi.error(`删除失败：${errorText(reason)}`, 6);
    } finally {
      setRunning('');
    }
  };

  const deleteSelected = () => confirm({
    title: `删除选中的 ${selectedIds.length} 份备份？`, content: '备份文件将移至 Windows 回收站。', okText: '删除', cancelText: '取消', okButtonProps: { danger: true },
    onOk: async () => {
      setRunning('delete-selected');
      try {
        const failures = await onDeleteMany(selectedIds);
        const failed = failures.map(item => item.id);
        for (const item of failures) messageApi.error(`${item.id}：${item.error}`, 6);
        setSelectedIds(failed);
        if (selectedIds.length > failed.length) messageApi.success(`已将 ${selectedIds.length - failed.length} 份备份移至 Windows 回收站`);
      } catch (reason) { messageApi.error(`删除失败：${errorText(reason)}`, 6); }
      finally { setRunning(''); }
    },
  });

  const savePolicy = async () => {
    setSavingPolicy(true);
    try {
      await onSavePolicy(policy, scheduledPolicy);
      messageApi.success('留存策略已保存');
    } catch (reason) {
      messageApi.error(`保存策略失败：${errorText(reason)}`, 6);
    } finally {
      setSavingPolicy(false);
    }
  };

  const cleanup = () => confirm({
    title: '按已保存的留存策略清理备份？', content: '自动备份和定时备份分别按各自的留存规则清理，不符合规则的备份将移至 Windows 回收站；手动备份不会被清理。', okText: '立即清理', cancelText: '取消',
    onOk: async () => {
      setRunning('cleanup');
      try { const count = await onCleanup(retentionPolicy, scheduledRetentionPolicy); messageApi.success(count ? `已清理 ${count} 份备份` : '当前没有需要清理的备份'); }
      catch (reason) { messageApi.error(`清理失败：${errorText(reason)}`, 6); }
      finally { setRunning(''); }
    },
  });

  const columns: ColumnsType<BackupInfo> = [
    {
      title: '文件名', dataIndex: 'fileName', minWidth: 280,
      render: (value: string, backup) => <div><Text code>{value}</Text>{backup.path && <div><Text type="secondary" style={{ fontSize: 11 }}>{displayPath(backup.path)}</Text></div>}</div>,
    },
    {
      title: '类型', dataIndex: 'kind', width: 110, className: 'backup-kind-column',
      filters: [{ text: '手动', value: 'manual' }, { text: '定时', value: 'scheduled' }, { text: '自动', value: 'startup' }, { text: '变更备份', value: 'change' }],
      filterMultiple: false,
      // 展开交给实际表头自身管理，避免隐藏测量行的副本同步打开。
      filterDropdownProps: { open: active && kindOpen ? undefined : false, onOpenChange: setKindOpen },
      filteredValue: kindFilter ? [kindFilter] : null,
      onFilter: (value, backup) => matchesKind(String(value), backup),
      render: (kind: BackupKind) => <Tag color={kindMeta[kind]?.color}>{kindMeta[kind]?.label || '其他自动'}</Tag>,
    },
    { title: '大小', dataIndex: 'sizeBytes', width: 100, render: (value: number) => formatBytes(value) },
    { title: '创建时间', dataIndex: 'createdAt', width: 185, render: (value: string) => formatDate(value) },
    {
      title: '完整性', dataIndex: 'integrity', width: 110,
      render: (integrity: BackupIntegrity) => <Tag icon={integrity === 'valid' ? <SafetyCertificateOutlined /> : undefined} color={integrityMeta[integrity]?.color}>{integrityMeta[integrity]?.label || integrity}</Tag>,
    },
    {
      title: '操作', key: 'actions', width: 150, fixed: 'right',
      render: (_, backup) => <Space size={4}>
        <Button type="link" size="small" icon={<UndoOutlined />} loading={running === `restore:${backup.id}`} disabled={backup.integrity === 'invalid' || backup.integrity === 'checking' || Boolean(running)} onClick={() => confirmRestore(backup)}>恢复</Button>
        <Popconfirm
          open={active && deletingBackup === backup.id}
          onOpenChange={(open) => setDeletingBackup(open ? backup.id : undefined)}
          title="删除此备份？"
          description="备份文件将移至 Windows 回收站。"
          okText="删除"
          cancelText="取消"
          okButtonProps={{ danger: true }}
          onConfirm={() => deleteBackup(backup)}
        >
          <Button type="link" danger size="small" icon={<DeleteOutlined />} loading={running === `delete:${backup.id}`} disabled={Boolean(running)}>删除</Button>
        </Popconfirm>
      </Space>,
    },
  ];

  const { hostRef, bodyHeight } = useTableBodyHeight(['.ant-card-head']);

  return <div className="page-content instant-list-page fixed-page backup-page">
    {messageContext}
    {modalContext}
    <div className="page-heading">
      <div><Title level={2}>系统备份</Title></div>
      <Button type="primary" icon={<CloudDownloadOutlined />} loading={running === 'backup'} disabled={Boolean(running)} onClick={() => void backupNow()}>立即备份</Button>
    </div>

    {restoreFeedback && <Alert className="backup-restore-feedback" showIcon closable type={restoreFeedback.type} message={restoreFeedback.text} onClose={() => setRestoreFeedback(undefined)} />}
    {readError && <Alert className="backup-restore-feedback" type="error" showIcon message="读取备份失败" description={<>{readError}{readReady && '；显示上次成功读取的结果'}</>} action={<Button size="small" loading={loading} onClick={() => void onRetry?.()}>重试</Button>} />}

    <div className="backup-scroll-content"><div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(160px, 1fr))', gap: 12, marginBottom: 16 }}>
      <Card size="small"><Statistic title="备份总数" value={readReady ? backups.length : '—'} /></Card>
      <Card size="small"><Statistic title="占用空间" value={readReady ? formatBytes(totalBytes) : '—'} /></Card>
      <Card size="small"><Statistic title="最近自动备份" value={!readReady ? '—' : latestBackup ? formatDate(latestBackup.createdAt) : '暂无'} valueStyle={{ fontSize: 15, color: 'var(--green)' }} /></Card>
      <Card size="small"><Statistic title="下次定时备份" value={formatDate(nextScheduledAt)} valueStyle={{ fontSize: 15, color: 'var(--blue)' }} /></Card>
    </div>

    <Card
      title="留存策略"
      extra={<Space><Button icon={<DeleteOutlined />} loading={running === 'cleanup'} disabled={policyChanged || savingPolicy || Boolean(running) || loading} onClick={cleanup}>立即清理</Button><Button type="primary" icon={<SaveOutlined />} loading={savingPolicy} disabled={!policyChanged || Boolean(running)} onClick={() => void savePolicy()}>保存策略</Button></Space>}
      className="panel-card"
      bordered={false}
      style={{ marginBottom: 16 }}
    >
      {[{ label: '自动备份留存', value: policy, update: setPolicy }, { label: '定时备份留存', value: scheduledPolicy, update: setScheduledPolicy }].map((group, index) => <div key={group.label} style={{ marginTop: index ? 12 : 0 }} role="group" aria-label={group.label}>
      <Text strong style={{ display: 'block', marginBottom: 8 }}>{group.label}</Text>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, minmax(130px, 1fr))', gap: 12 }}>
        {policyFields.map((field) => <div key={field.key}>
          <Text type="secondary" style={{ display: 'block', marginBottom: 7 }}>{field.label}</Text>
          <Space.Compact block>
            <InputNumber
              aria-label={`${group.label}${field.label}`}
              disabled={savingPolicy}
              min={0}
              max={999}
              precision={0}
              value={group.value[field.key]}
              onChange={(value) => group.update((current) => ({ ...current, [field.key]: Number(value) || 0 }))}
              style={{ width: '100%' }}
            />
            <Button disabled style={{ width: 65 }}>{field.suffix}</Button>
          </Space.Compact>
        </div>)}
      </div>
      </div>)}
    </Card>

    <div className="fixed-table-host" ref={hostRef}><Card title="备份列表" extra={<Button danger icon={<DeleteOutlined />} disabled={!selectedIds.length || Boolean(running) || loading} onClick={deleteSelected}>删除所选（{selectedIds.length}）</Button>} className="panel-card fixed-table-card" bordered={false}>
      <Table<BackupInfo>
        rowKey="id"
        size="small"
        loading={{ spinning: loading, delay: 150 }}
        columns={columns}
        dataSource={sortedBackups}
        rowSelection={{ selectedRowKeys: selectedIds, onChange: (keys) => setSelectedIds(keys.map(String)), getCheckboxProps: () => ({ disabled: Boolean(running) || loading }) }}
        scroll={{ x: 980, y: bodyHeight }}
        pagination={{ current: page, pageSize, position: ['none', 'none'] }}
        onChange={(pagination, filters) => { setPage(pagination.current ?? 1); setKindFilter(filters.kind?.[0] ? String(filters.kind[0]) : undefined); }}
        locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={readError ? '读取备份失败，请重试' : !readReady ? '正在读取备份…' : '还没有备份，建议立即创建第一份备份'} /> }}
      />
    </Card></div></div>
    <Pagination className="backup-pagination" size="small" current={page} pageSize={pageSize} total={filteredTotal} pageSizeOptions={[25, 50, 100]} showSizeChanger={sizeChanger} showTotal={(total) => `共 ${total} 份备份`} onChange={(current, size) => { setPage(current); setPageSize(size); }} />

    <Modal title="输入备份的原主密码" open={active && Boolean(passwordBackup)} focusTriggerAfterClose={active} okText="恢复备份" cancelText="取消"
      confirmLoading={running === `restore:${passwordBackup?.id}`} okButtonProps={{ disabled: !backupPassword }}
      onCancel={(event) => { if (!running && !composingCancel(event)) { setPasswordBackup(null); setBackupPassword(''); } }}
      onOk={async () => {
        if (!passwordBackup || !backupPassword) return;
        setRestorePasswordError('');
        setRestoreFeedback(undefined);
        setRunning(`restore:${passwordBackup.id}`);
        try {
          await onRestore(passwordBackup.id, backupPassword);
          setPasswordBackup(null); setBackupPassword('');
          setRestoreFeedback({ type: 'success', text: '备份已恢复，当前数据已更新，继续使用当前主密码；恢复前的数据库也已自动备份。' });
        } catch (reason) { setRestorePasswordError(`恢复失败：${errorText(reason)}`); }
        finally { setRunning(''); }
      }}>
      <Space direction="vertical" style={{ width: '100%' }}>
        <Text>{passwordBackup?.fileName}</Text>
        <Text type="secondary">此备份使用以前的主密码加密。输入当时的主密码即可恢复，当前主密码保持不变。</Text>
        <Input.Password aria-label="备份原主密码" value={backupPassword} onChange={(event) => setBackupPassword(event.target.value)} placeholder="输入备份创建时的主密码" />
        {restorePasswordError && <Alert type="error" showIcon message={restorePasswordError} />}
      </Space>
    </Modal>

  </div>;
}
