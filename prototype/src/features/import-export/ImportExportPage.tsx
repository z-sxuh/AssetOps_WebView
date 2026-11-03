import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Key } from 'react';
import {
  Alert,
  Button,
  Card,
  Checkbox,
  Descriptions,
  Modal,
  Radio,
  Result,
  Segmented,
  Space,
  Statistic,
  Steps,
  Table,
  Tag,
  Typography,
  Upload,
  message,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { native } from '../../native';
import { composingCancel } from '../../composition';
import Select from '../../components/AppSelect';
import OrganizationSelect from '../../components/OrganizationSelect';
import type { FieldTemplate, FieldTemplateField, VaultData } from '../../model';
import { chooseImportConflict, confirmedImportMapping, importPreviewCurrent, resolveImportRows, selectableImportRow, type ImportOptions, type ImportPreview, type ImportRowStatus, type ImportSelection, type NormalizedImportRow } from './importWorkflow';
import { defaultFields, displayPath } from '../../model';
import { importFieldOptions } from './importFields';
import {
  DownloadOutlined,
  FileExcelOutlined,
  InboxOutlined,
  ReloadOutlined,
  UploadOutlined,
  UndoOutlined,
} from '@ant-design/icons';

const { Dragger } = Upload;
const { Text, Title } = Typography;

export type ExportScope = 'project' | 'unit' | 'system' | 'selected';

export interface ExportOptions {
  includePlaintextPasswords: boolean;
  includeFieldDefinitions: boolean;
  includeHistory: boolean;
}

export interface ExportRequest {
  scope: ExportScope;
  unitId: string | null;
  systemId: string | null;
  selectedIds: string[];
  options: ExportOptions;
}

export interface ImportExportPageProps {
  active?: boolean;
  data: VaultData;
  activeSystemId: string | null;
  parseImport: (
    file: File,
    context: ImportOptions,
  ) => Promise<ImportPreview>;
  exportAssets: (request: ExportRequest) => Promise<string | { path?: string } | void>;
  onImport: (selection: ImportSelection, batchId: string) => Promise<void> | void;
  onRollbackBatch: (batchId: string) => Promise<boolean>;
  onExportReport: (rows: Array<{ sheet: string; line: number; status: string; host: string; message: string }>) => Promise<string>;
  onExportTemplate: (fields: FieldTemplateField[]) => Promise<string>;
}

type SystemLike = { id: string; name?: string };
type ZoneLike = { id: string; name?: string; systems?: SystemLike[] };
type EnvironmentLike = { id: string; name?: string; zones?: ZoneLike[] };
type UnitLike = { id: string; name?: string; environments?: EnvironmentLike[] };
type AssetLike = { id: string; name?: string; host?: string; ip?: string; unitId?: string; systemId?: string };

const statusMeta: Record<ImportRowStatus, { label: string; color: string }> = {
  add: { label: '新增', color: 'green' },
  update: { label: '更新', color: 'blue' },
  same: { label: '无变化', color: 'default' },
  conflict: { label: '冲突', color: 'orange' },
  error: { label: '错误', color: 'red' },
};

const defaultExportOptions: ExportOptions = {
  includePlaintextPasswords: false,
  includeFieldDefinitions: false,
  includeHistory: false,
};

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? value as T[] : [];
}

function errorText(reason: unknown) {
  return reason instanceof Error ? reason.message : String(reason || '未知错误');
}

function exportSheetName(name: string, used: Set<string>) {
  const base = Array.from(name.replace(/[\[\]:*?/\\]/g, '_')).slice(0, 31).join('').trim().replace(/^'+|'+$/g, '').trim() || '资产';
  let candidate = base;
  for (let suffix = 2; used.has(candidate.toLowerCase()); suffix++) {
    const marker = `-${suffix}`;
    candidate = Array.from(base).slice(0, 31 - marker.length).join('') + marker;
  }
  used.add(candidate.toLowerCase());
  return candidate;
}

function createBatchId() {
  const time = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
  const suffix = typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID().slice(0, 8)
    : Math.random().toString(36).slice(2, 10);
  return `IMP-${time}-${suffix}`;
}

export default function ImportExportPage({
  active = true,
  data,
  activeSystemId,
  parseImport,
  exportAssets,
  onImport,
  onRollbackBatch,
  onExportReport,
  onExportTemplate,
}: ImportExportPageProps) {
  const [messageApi, messageContext] = message.useMessage({ maxCount: 3 });
  const [modalApi, modalContext] = Modal.useModal();
  const exportConfirmation = useRef<ReturnType<typeof modalApi.confirm>>();
  const cancelExportConfirmation = useRef<() => void>();
  useLayoutEffect(() => { if (!active) { cancelExportConfirmation.current?.(); exportConfirmation.current?.destroy(); exportConfirmation.current = undefined; } }, [active]);
  useEffect(() => () => { cancelExportConfirmation.current?.(); exportConfirmation.current?.destroy(); }, []);
  const notifySaved = (label: string, path: string) => messageApi.success({ content: <Space size={10}><span>{label}：{displayPath(path)}</span><Button size="small" type="link" style={{ padding: 0 }} onClick={() => void native.revealInFolder(path)}>打开目录</Button></Space>, duration: 8 });
  const [mode, setMode] = useState<'import' | 'export'>('import');
  const [importStep, setImportStep] = useState(0);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [mappingOpen, setMappingOpen] = useState(false);
  const [sheetColumnMapping, setSheetColumnMapping] = useState<Record<string, Record<string, string>>>({});
  const [sheetTargets, setSheetTargets] = useState<Record<string, string>>({});
  const [resolvedConflicts, setResolvedConflicts] = useState<Record<string, string>>({});
  const [selectedRowIds, setSelectedRowIds] = useState<Key[]>([]);
  const [parseError, setParseError] = useState('');
  const [parsing, setParsing] = useState(false);
  const previewRequest = useRef(0);
  useEffect(() => () => { previewRequest.current++; }, []);
  const [importing, setImporting] = useState(false);
  const importingRef = useRef(false);
  const [completedBatchId, setCompletedBatchId] = useState('');
  const [completedImport, setCompletedImport] = useState<{ count: number; rows: NormalizedImportRow[] }>();
  const [undoDeadline, setUndoDeadline] = useState(0);
  const [undoing, setUndoing] = useState(false);
  const [exportScope, setExportScope] = useState<ExportScope>('project');
  const [exportUnitId, setExportUnitId] = useState<string | null>(null);
  const [exportSystemId, setExportSystemId] = useState<string | null>(null);
  const [exportAssetIds, setExportAssetIds] = useState<string[]>([]);
  const [exportOptions, setExportOptions] = useState<ExportOptions>(() => ({ ...defaultExportOptions, includePlaintextPasswords: Boolean(data?.settings?.exportPlainPassword) }));
  const [exporting, setExporting] = useState(false);
  const [templateSource, setTemplateSource] = useState(activeSystemId && data.fieldDefs.some(field => field.systemId === activeSystemId) ? `system:${activeSystemId}` : 'default');
  const [templateExporting, setTemplateExporting] = useState(false);

  const units = asArray<UnitLike>(data?.units);
  const assets = asArray<AssetLike>(data?.assets);
  const allSystems = units.flatMap((unit) => asArray<EnvironmentLike>(unit.environments).flatMap((environment) => asArray<ZoneLike>(environment.zones).flatMap((zone) => asArray<SystemLike>(zone.systems).map((system) => ({ unit, environment, zone, system })))));
  const templateUnits = useMemo(() => data.units.map(unit => ({ ...unit, environments: unit.environments.map(environment => ({ ...environment, zones: environment.zones.map(zone => ({ ...zone, systems: zone.systems.filter(system => data.fieldDefs.some(field => field.systemId === system.id)) })) })) })), [data.units, data.fieldDefs]);
  useEffect(() => {
    const systemIds = new Set(allSystems.map(({ system }) => system.id));
    setSheetTargets((current) => {
      const entries = Object.entries(current).filter(([, target]) => systemIds.has(target));
      return entries.length === Object.keys(current).length ? current : Object.fromEntries(entries);
    });
    if (exportSystemId && !systemIds.has(exportSystemId)) setExportSystemId(null);
    if (exportUnitId && !units.some((unit) => unit.id === exportUnitId)) setExportUnitId(null);
    if (templateSource.startsWith('system:') && !systemIds.has(templateSource.slice(7))) setTemplateSource('default');
    if (templateSource.startsWith('system:') && !data.fieldDefs.some(field => field.systemId === templateSource.slice(7))) setTemplateSource('default');
    if (preview?.rows.some((row) => row.record.targetSystemId && !systemIds.has(row.record.targetSystemId))) {
      setPreview(null); setImportStep(0); setMappingOpen(false); setSelectedRowIds([]);
      setParseError('导入目标系统已删除，请重新预检并选择当前系统');
    }
  }, [data?.units, data.fieldDefs, preview, exportSystemId, exportUnitId, templateSource]);
  const mappingOptionsBySheet = useMemo(() => Object.fromEntries((preview?.sourceSheets ?? []).map(sheet => {
    const ids = sheetTargets[sheet] ? [sheetTargets[sheet]] : [...new Set(preview?.rows.filter(row => row.sheet === sheet).map(row => row.record.targetSystemId).filter((id): id is string => Boolean(id)))];
    const options = ids.map(id => importFieldOptions(data, id));
    return [sheet, options[0]?.filter(option => options.every(list => list.some(item => item.value === option.value))) ?? []];
  })), [preview, sheetTargets, data.fieldDefs]);
  const rows = useMemo(() => resolveImportRows(preview, resolvedConflicts), [preview, resolvedConflicts]);

  const counts = useMemo(() => Object.fromEntries(
    (Object.keys(statusMeta) as ImportRowStatus[]).map((status) => [status, rows.filter((row) => row.status === status).length]),
  ) as Record<ImportRowStatus, number>, [rows]);

  const selectedRows = useMemo(() => {
    const keys = new Set(selectedRowIds.map(String));
    return rows.filter((row) => keys.has(row.id));
  }, [rows, selectedRowIds]);

  const scopeAssets = useMemo(() => {
    if (exportScope === 'unit') return assets.filter((asset) => asset.unitId === exportUnitId);
    if (exportScope === 'system') return assets.filter((asset) => asset.systemId === exportSystemId);
    if (exportScope === 'selected') {
      const ids = new Set(exportAssetIds);
      return assets.filter((asset) => ids.has(asset.id));
    }
    return assets;
  }, [exportSystemId, exportUnitId, assets, exportScope, exportAssetIds]);

  useEffect(() => {
    if (!undoDeadline) return;
    const timeout = window.setTimeout(() => setUndoDeadline(0), Math.max(0, undoDeadline - Date.now()));
    return () => window.clearTimeout(timeout);
  }, [undoDeadline]);

  const sheetRows = useMemo(() => {
    const systemIds = new Set(scopeAssets.map((asset) => asset.systemId).filter(Boolean));
    const used = new Set(['_meta', '_columns', '_systems', '_lists', '字段说明', '变更历史']);
    return allSystems
      .filter(({ system }) => systemIds.has(system.id))
      .sort((left, right) => {
        const a = `${left.system.name ?? ''}\0${left.system.id}`, b = `${right.system.name ?? ''}\0${right.system.id}`;
        return a < b ? -1 : a > b ? 1 : 0;
      })
      .map(({ unit, environment, zone, system }) => ({
        id: system.id,
        name: exportSheetName([environment.name, zone.name, system.name].filter(Boolean).join('-') || system.id, used),
        unit: unit.name || unit.id,
        count: scopeAssets.filter((asset) => asset.systemId === system.id).length,
      }));
  }, [allSystems, scopeAssets]);

  const resetImport = () => {
    if (importingRef.current) return;
    previewRequest.current++;
    setParsing(false);
    setImportStep(0);
    setFile(null);
    setPreview(null);
    setMappingOpen(false);
    setSheetColumnMapping({});
    setSheetTargets({});
    setResolvedConflicts({});
    setSelectedRowIds([]);
    setParseError('');
    setCompletedBatchId('');
    setCompletedImport(undefined);
    setUndoDeadline(0);
  };

  useEffect(() => {
    if (!preview || importingRef.current || completedBatchId || importPreviewCurrent(preview, data)) return;
    previewRequest.current++; setParsing(false); setPreview(null); setMappingOpen(false); setSelectedRowIds([]); setImportStep(0);
    setParseError('资产、字段或组织目录已变化，请重新选择文件并预检');
  }, [data.assets, data.fieldDefs, data.units, preview, completedBatchId]);

  const selectFile = async (nextFile: File) => {
    if (importingRef.current) return;
    resetImport();
    const request = ++previewRequest.current;
    setFile(nextFile);
    if (!nextFile.name.toLowerCase().endsWith('.xlsx')) {
      setParseError('文件格式不正确：请选择扩展名为 .xlsx 的 Excel 工作簿。');
      return;
    }
    if (!nextFile.size) {
      setParseError('文件为空，无法执行预检。');
      return;
    }
    setParsing(true);
    try {
      const result = await parseImport(nextFile, { defaultSystemId: templateSource.startsWith('system:') ? templateSource.slice(7) : undefined });
      if (request !== previewRequest.current) return;
      if (!result || !Array.isArray(result.rows)) throw new Error('解析结果缺少 rows 列表');
      setPreview(result);
      setSheetTargets(result.suggestedSheetTargets ?? {});
      const normalized = resolveImportRows(result);
      setSelectedRowIds(normalized.filter(selectableImportRow).map((row) => row.id));
      if (result.requiresMapping) setMappingOpen(true);
      else setImportStep(1);
    } catch (reason) {
      if (request === previewRequest.current) setParseError(`预检失败：${errorText(reason)}`);
    } finally {
      if (request === previewRequest.current) setParsing(false);
    }
  };

  const applyMapping = async () => {
    if (!file || importingRef.current) return;
    const request = ++previewRequest.current;
    setParsing(true);
    try {
      const mappings = Object.fromEntries(Object.entries(sheetColumnMapping).map(([sheet, values]) => {
        const mapping = confirmedImportMapping(values), allowed = new Set(mappingOptionsBySheet[sheet]?.map(option => option.value));
        if (Object.values(mapping).some(value => !allowed.has(value))) throw new Error(`工作表“${sheet}”的字段已变化，请重新选择映射`);
        return [sheet, mapping];
      }));
      const result = await parseImport(file, { sheetColumnMapping: mappings, sheetTargets, defaultSystemId: templateSource.startsWith('system:') ? templateSource.slice(7) : undefined, mappingConfirmed: true });
      if (request !== previewRequest.current) return;
      setPreview(result);
      setResolvedConflicts({});
      setSelectedRowIds(resolveImportRows(result).filter(selectableImportRow).map(row => row.id));
      setMappingOpen(false);
      setImportStep(1);
    } catch (reason) {
      if (request === previewRequest.current) messageApi.error(`列映射失败：${errorText(reason)}`);
    } finally { if (request === previewRequest.current) setParsing(false); }
  };

  const commitImport = async () => {
    if (importingRef.current || !preview || !selectedRows.length) return;
    if (!importPreviewCurrent(preview, data)) { messageApi.error('资产、字段或组织目录已变化，请重新预检'); return; }
    const batchId = createBatchId();
    const submitted = { count: selectedRows.length, rows: [...rows] };
    const input = { preview, selectedIds: selectedRowIds.map(String), conflicts: { ...resolvedConflicts } };
    importingRef.current = true;
    setImporting(true);
    try {
      await onImport(input, batchId);
      setCompletedImport(submitted);
      setCompletedBatchId(batchId);
      setUndoDeadline(Date.now() + 600_000);
      messageApi.success(`已导入 ${submitted.count} 条记录`);
    } catch (reason) {
      messageApi.error(`导入失败：${errorText(reason)}`, 6);
    } finally {
      importingRef.current = false;
      setImporting(false);
    }
  };

  const undoImport = async () => {
    if (!completedBatchId || Date.now() > undoDeadline) return messageApi.warning('10 分钟撤销窗口已结束，可到历史变更检查批次');
    setUndoing(true);
    try {
      if (await onRollbackBatch(completedBatchId)) {
        setUndoDeadline(0);
        messageApi.success('本次导入已撤销');
      }
    } catch (reason) { messageApi.error(`撤销失败：${errorText(reason)}`); }
    finally { setUndoing(false); }
  };

  const exportReport = async () => {
    try {
      const path = await onExportReport((completedImport?.rows ?? rows).map((row) => ({
        sheet: row.sheet ?? '', line: row.line, status: statusMeta[row.status].label,
        host: row.host ?? '', message: row.message ?? '',
      })));
      notifySaved('导入报告已保存', path);
    } catch (reason) { messageApi.error(`报告导出失败：${errorText(reason)}`); }
  };

  const resolveConflict = (row: NormalizedImportRow) => {
    if (!preview) return;
    const next = chooseImportConflict({ preview, conflicts: resolvedConflicts, selectedIds: selectedRowIds.map(String) }, row.id);
    setResolvedConflicts(next.conflicts); setSelectedRowIds(next.selectedIds);
  };

  const runExport = async () => {
    if (exportScope === 'unit' && !exportUnitId) return messageApi.warning('请选择要导出的单位');
    if (exportScope === 'system' && !exportSystemId) return messageApi.warning('请选择要导出的系统');
    if (exportScope === 'selected' && !exportAssetIds.length) return messageApi.warning('请选择要导出的服务器');
    if (exportOptions.includePlaintextPasswords) {
      const confirmed = await new Promise<boolean>((resolve) => { cancelExportConfirmation.current = () => { cancelExportConfirmation.current = undefined; resolve(false); }; exportConfirmation.current = modalApi.confirm({
        title: '确认导出明文密码？',
        content: `本次导出的 ${scopeAssets.length} 台服务器账号密码会写入未加密的 Excel 文件。`,
        okText: '确认导出', cancelText: '取消', okButtonProps: { danger: true },
        focusTriggerAfterClose: active,
        onOk: () => { cancelExportConfirmation.current = undefined; resolve(true); }, onCancel: () => cancelExportConfirmation.current?.(),
      }); });
      if (!confirmed) return;
    }
    setExporting(true);
    try {
      const result = await exportAssets({
        scope: exportScope,
        unitId: exportUnitId,
        systemId: exportSystemId,
        selectedIds: scopeAssets.map((asset) => asset.id),
        options: exportOptions,
      });
      const path = typeof result === 'string' ? result : result?.path;
      if (path) notifySaved('导出完成', path); else messageApi.success('导出完成');
    } catch (reason) {
      messageApi.error(`导出失败：${errorText(reason)}`, 6);
    } finally {
      setExporting(false);
    }
  };

  const exportTemplate = async () => {
    const fields = templateSource === 'default' ? defaultFields('__default__')
      : templateSource.startsWith('system:') ? asArray<FieldTemplateField & { systemId: string }>(data.fieldDefs).filter((field) => field.systemId === templateSource.slice(7))
      : asArray<FieldTemplate>(data.fieldTemplates).find((template) => template.id === templateSource.slice(9))?.fields ?? [];
    if (!fields.length) { messageApi.warning('所选系统还没有保存字段，请先配置字段模板'); return; }
    setTemplateExporting(true);
    try { notifySaved('空模板已保存', await onExportTemplate(fields)); }
    catch (reason) { messageApi.error(`空模板导出失败：${errorText(reason)}`, 6); }
    finally { setTemplateExporting(false); }
  };

  const previewColumns: ColumnsType<NormalizedImportRow> = [
    { title: '工作表', dataIndex: 'sheet', width: 130, ellipsis: true },
    { title: '行号', dataIndex: 'line', width: 72 },
    {
      title: '状态', dataIndex: 'status', width: 90,
      render: (status: ImportRowStatus) => <Tag color={statusMeta[status]?.color}>{statusMeta[status]?.label || status}</Tag>,
    },
    { title: '服务器名称', dataIndex: 'name', width: 170, render: (value?: string) => value || <Text type="secondary">—</Text> },
    { title: '主机名', dataIndex: 'host', width: 160, render: (value?: string) => value || <Text type="secondary">—</Text> },
    { title: '目标位置', dataIndex: 'systemName', width: 280, render: (value?: string) => value || <Text type="danger">未匹配</Text> },
    {
      title: '差异 / 说明', key: 'message', width: 320,
      render: (_, row) => {
        const details = row.differences?.length ? row.differences.join('；') : row.message;
        return <Text type={row.status === 'error' ? 'danger' : row.status === 'conflict' ? 'warning' : undefined}>{details || '无字段差异'}</Text>;
      },
    },
    { title: '冲突裁决', key: 'resolve', width: 110, render: (_, row) => row.conflictGroup && row.status !== 'error'
      ? <Button type="link" size="small" onClick={() => resolveConflict(row)}>{resolvedConflicts[row.conflictGroup] === row.id ? '取消选用' : '选用此行'}</Button>
      : null },
  ];

  const statusSummary = <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, minmax(100px, 1fr))', gap: 12, marginBottom: 16 }}>
    {(Object.keys(statusMeta) as ImportRowStatus[]).map((status) => <Card key={status} size="small">
      <Statistic title={statusMeta[status].label} value={counts[status]} valueStyle={{ color: status === 'error' ? 'var(--coral)' : status === 'conflict' ? 'var(--amber)' : undefined, fontSize: 24 }} />
    </Card>)}
  </div>;

  const importBody = completedBatchId ? <Result
    status="success"
    title="导入完成"
    subTitle={`已写入 ${completedImport?.count ?? 0} 条记录，批次号 ${completedBatchId}`}
    extra={<Space><Button icon={<DownloadOutlined />} onClick={() => void exportReport()}>导出报告</Button><Button icon={<UndoOutlined />} onClick={() => void undoImport()} disabled={!undoDeadline} loading={undoing}>10 分钟内撤销本批</Button><Button type="primary" icon={<ReloadOutlined />} onClick={resetImport}>继续导入</Button></Space>}
  /> : <>
    <Steps
      current={importStep}
      items={[
        { title: '选择文件' },
        { title: '预检记录' },
        { title: '勾选记录' },
        { title: '确认写入' },
      ]}
      style={{ marginBottom: 22 }}
    />
    {parseError && <Alert type="error" showIcon message="无法读取导入文件" description={parseError} closable onClose={() => setParseError('')} style={{ marginBottom: 16 }} />}
    {importStep === 0 && <Card className="panel-card import-file-card" bordered={false}>
      <Space wrap style={{ marginBottom: 16 }}><Text type="secondary">选择字段来源下载空模板：</Text>
        <OrganizationSelect active={active} label="字段模板来源" units={templateUnits} level="systemId" placeholder="选择字段模板" value={templateSource.startsWith('system:') ? templateSource.slice(7) : templateSource} style={{ width: 320 }} options={[{ value: 'default', label: '默认模板' }, ...asArray<FieldTemplate>(data.fieldTemplates).map((template) => ({ value: `template:${template.id}`, label: `模板：${template.name}` }))]} onChange={(value) => { if (value) setTemplateSource(value === 'default' || value.startsWith('template:') ? value : `system:${value}`); }} />
        <Button icon={<DownloadOutlined />} loading={templateExporting} onClick={() => void exportTemplate()}>导出空模板</Button>
      </Space>
      <Dragger
        accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        maxCount={1}
        showUploadList={false}
        disabled={parsing || importing}
        beforeUpload={(nextFile) => { void selectFile(nextFile); return Upload.LIST_IGNORE; }}
      >
        <p className="ant-upload-drag-icon"><InboxOutlined /></p>
        <p className="ant-upload-text">拖放或点击选择 Excel 工作簿</p>
        <p className="ant-upload-hint">仅支持 .xlsx；上传后交给应用解析。</p>
        {parsing && <Text type="secondary">正在解析并预检…</Text>}
      </Dragger>
    </Card>}
    {importStep > 0 && preview && <>
      <Alert
        type={counts.error ? 'warning' : 'success'}
        showIcon
        message={file?.name || '已选择文件'}
        description={preview.metadata || `${rows.length} 行已完成预检${preview.projectName ? ` · ${preview.projectName}` : ''}`}
        style={{ marginBottom: 16 }}
      />
      {preview.warnings?.map((warning) => <Alert key={warning} type="warning" showIcon message={warning} style={{ marginBottom: 8 }} />)}
      {statusSummary}
      {importStep === 3 ? <Card title="确认导入" className="panel-card" bordered={false}>
        <Alert type="warning" showIcon message={importing ? '正在写入，请稍候' : '写入前请确认'} description="系统会先创建导入前备份，再一次性写入所选记录。未裁决的冲突和错误行不会进入本批次。" style={{ marginBottom: 16 }} />
        <Descriptions bordered size="small" column={1}>
          <Descriptions.Item label="文件">{file?.name}</Descriptions.Item>
          <Descriptions.Item label="写入数量">{selectedRows.length} 条</Descriptions.Item>
          <Descriptions.Item label="其中新增 / 更新 / 无变化">{selectedRows.filter((row) => row.status === 'add').length} / {selectedRows.filter((row) => row.status === 'update').length} / {selectedRows.filter((row) => row.status === 'same').length}</Descriptions.Item>
          <Descriptions.Item label="已排除">冲突 {counts.conflict} 条，错误 {counts.error} 条</Descriptions.Item>
        </Descriptions>
      </Card> : <Card
        title={importStep === 1 ? '差异预览' : `选择要导入的记录（已选 ${selectedRows.length} 条）`}
        className="panel-card"
        bordered={false}
      >
        <Table<NormalizedImportRow>
          rowKey="id"
          size="small"
          columns={previewColumns}
          dataSource={rows}
          pagination={{ pageSize: 10, showSizeChanger: false }}
          tableLayout="fixed"
          scroll={{ x: 1364 }}
          rowSelection={importStep === 2 ? {
            selectedRowKeys: selectedRowIds,
            onChange: setSelectedRowIds,
            getCheckboxProps: (row) => ({
              disabled: !selectableImportRow(row),
              title: row.status === 'conflict' ? '请先选用该冲突组中的一行' : row.status === 'error' ? '错误行修正后才能导入' : undefined,
            }),
          } : undefined}
        />
      </Card>}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 16 }}>
        <Text type="secondary">重复主机名可在表中逐组选用一行；错误行须修正文件后重新预检。</Text>
        <Space>
          <Button icon={<DownloadOutlined />} onClick={() => void exportReport()}>导出预检报告</Button>
          <Button disabled={importing} onClick={resetImport}>取消</Button>
          {importStep > 1 && <Button disabled={importing} onClick={() => { if (!importingRef.current) setImportStep((step) => step - 1); }}>上一步</Button>}
          {importStep < 3 && <Button type="primary" onClick={() => setImportStep((step) => step + 1)} disabled={importStep === 2 && !selectedRows.length}>
            {importStep === 1 ? '开始勾选' : `确认选择（${selectedRows.length} 条）`}
          </Button>}
          {importStep === 3 && <Button type="primary" icon={<UploadOutlined />} loading={importing} disabled={!selectedRows.length} onClick={() => void commitImport()}>
            确认导入
          </Button>}
        </Space>
      </div>
    </>}
  </>;

  const systemLabels = new Map(allSystems.map(({ unit, environment, zone, system }) => [system.id, [unit.name, environment.name, zone.name, system.name].filter(Boolean).join(' / ')]));
  const scopeOptions: Array<{ value: ExportScope; title: string; description: string }> = [
    { value: 'project', title: '整个项目', description: `${assets.length} 台服务器，每个系统一个 Sheet` },
    { value: 'unit', title: '指定单位', description: '在本页选择单位，每个系统一个 Sheet' },
    { value: 'system', title: '指定系统', description: '在本页选择系统，单个 Sheet' },
    { value: 'selected', title: '指定服务器', description: '在本页选择服务器，可跨单位与系统' },
  ];

  const exportBody = <Space direction="vertical" size={16} style={{ width: '100%' }}>
    <Card title="导出范围" className="panel-card" bordered={false}>
      <Radio.Group value={exportScope} onChange={(event) => setExportScope(event.target.value as ExportScope)} style={{ width: '100%' }}>
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          {scopeOptions.map((option) => <Radio key={option.value} value={option.value} style={{ alignItems: 'flex-start' }}>
            <div><Text strong>{option.title}</Text><br /><Text type="secondary">{option.description}</Text></div>
          </Radio>)}
        </Space>
      </Radio.Group>
      {exportScope !== 'project' && <div style={{ marginTop: 16, width: 'min(100%, 640px)' }}>
        {exportScope === 'unit' && <OrganizationSelect active={active} label="导出单位" units={data.units} level="unitId" allowClear placeholder="选择要导出的单位" value={exportUnitId ?? undefined} onChange={(value) => setExportUnitId(value ?? null)} />}
        {exportScope === 'system' && <OrganizationSelect active={active} label="导出系统" units={data.units} level="systemId" allowClear placeholder="选择要导出的系统" value={exportSystemId ?? undefined} onChange={(value) => setExportSystemId(value ?? null)} />}
        {exportScope === 'selected' && <Select active={active} aria-label="导出服务器" mode="multiple" showSearch optionFilterProp="label" allowClear maxTagCount="responsive" placeholder="选择要导出的服务器" value={exportAssetIds} style={{ width: '100%' }} options={assets.map((asset) => ({ value: asset.id, label: `${asset.name || asset.host || asset.id} · ${asset.host || asset.ip || ''} · ${systemLabels.get(asset.systemId || '') || ''}` }))} onChange={setExportAssetIds} />}
      </div>}
    </Card>
    <Card title={`Sheet 预览 · ${sheetRows.length} 个 Sheet / ${scopeAssets.length} 行`} className="panel-card" bordered={false}>
      <Table
        rowKey="id"
        size="small"
        pagination={false}
        dataSource={sheetRows}
        columns={[
          { title: 'Sheet 名', dataIndex: 'name' },
          { title: '来源单位', dataIndex: 'unit' },
          { title: '行数', dataIndex: 'count', width: 100 },
          { title: '状态', width: 100, render: () => <Tag color="green">就绪</Tag> },
        ]}
        locale={{ emptyText: '当前范围没有可导出的服务器' }}
      />
    </Card>
    <Card title="导出选项" className="panel-card" bordered={false}>
      <Space wrap size={[24, 12]}>
        <Checkbox checked={exportOptions.includePlaintextPasswords} onChange={(event) => setExportOptions((value) => ({ ...value, includePlaintextPasswords: event.target.checked }))}>包含密码明文</Checkbox>
        <Checkbox checked={exportOptions.includeFieldDefinitions} onChange={(event) => setExportOptions((value) => ({ ...value, includeFieldDefinitions: event.target.checked }))}>包含字段说明 Sheet</Checkbox>
        <Checkbox checked={exportOptions.includeHistory} onChange={(event) => setExportOptions((value) => ({ ...value, includeHistory: event.target.checked }))}>包含变更历史 Sheet</Checkbox>
      </Space>
      {exportOptions.includePlaintextPasswords && <Alert type="warning" showIcon message="导出文件将包含明文密码，请妥善保管并及时删除。" style={{ marginTop: 16 }} />}
    </Card>
    <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
      <Button type="primary" icon={<DownloadOutlined />} loading={exporting} disabled={!scopeAssets.length} onClick={() => void runExport()}>导出 Excel</Button>
    </div>
  </Space>;

  return <div className="page-content exchange-page">
    {messageContext}
    {modalContext}
    <Modal className="import-mapping-modal" style={{ top: 24 }} title="确认列与工作表映射" open={active && mappingOpen} focusTriggerAfterClose={active} width={740} okText="重新预检" cancelText="取消导入" okButtonProps={{ loading: parsing }} onCancel={event => { if (!composingCancel(event)) resetImport(); }} onOk={() => void applyMapping()}>
      <Text type="secondary">系统（组织归属）列用于确认每行的完整路径；业务系统作为普通字段保存。工作表目标用于未填写归属的行或确认重名。未识别的列可指定字段或明确忽略。</Text>
      <div style={{ marginTop: 18, marginBottom: 16 }}><Text strong>工作表归属</Text>
        {(preview?.sourceSheets ?? []).map((sheet) => <div key={sheet} style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 10 }}><Text style={{ width: 200 }} ellipsis>{sheet}</Text><OrganizationSelect active={active && mappingOpen} label={`工作表${sheet}的目标系统`} units={data.units} level="systemId" value={sheetTargets[sheet] || undefined} placeholder="选择目标系统" style={{ flex: 1 }} disabled={parsing} onChange={(systemId) => { if (systemId) { setSheetTargets((current) => ({ ...current, [sheet]: systemId })); setSheetColumnMapping(current => ({ ...current, [sheet]: {} })); } }} /></div>)}
      </div>
      <Text strong>源列对应字段</Text>
      <div><Text type="secondary">选项来自目标系统已保存的字段，台账隐藏列也可导入。缺少备注等字段时，请先在字段定义中保存对应模板，或明确忽略该列。</Text></div>
      <div className="import-mapping-columns">{(preview?.sourceSheets ?? []).map(sheet => <section key={sheet} data-import-sheet={sheet}>
        {(preview?.sourceSheets?.length ?? 0) > 1 && <Text strong>{sheet}</Text>}
        {!sheetTargets[sheet] && <Text type="secondary">{mappingOptionsBySheet[sheet]?.length ? '本表按源数据归属逐行导入，可映射各系统共有的字段' : '请先选择该工作表的目标系统'}</Text>}
        {sheetTargets[sheet] && !data.fieldDefs.some(field => field.systemId === sheetTargets[sheet]) && <Text type="warning">该系统尚未配置字段，请先在字段定义中保存模板</Text>}
        {(preview?.sheetHeaders?.[sheet] ?? preview?.sourceHeaders ?? []).map(header => <div key={header} className="import-mapping-row"><Text ellipsis>{header}</Text><Select active={active && mappingOpen} aria-label={`${sheet}的${header}对应字段`} showSearch optionFilterProp="label" disabled={parsing || !mappingOptionsBySheet[sheet]?.length} value={sheetColumnMapping[sheet]?.[header] ?? '__auto__'} options={mappingOptionsBySheet[sheet] ?? []} listHeight={200} onChange={target => setSheetColumnMapping(current => ({ ...current, [sheet]: { ...current[sheet], [header]: target } }))} /></div>)}
      </section>)}</div>
    </Modal>
    <div className="page-heading">
      <div><Title level={2}>导入导出</Title></div>
      <Segmented
        disabled={importing}
        value={mode}
        onChange={(value) => setMode(value as 'import' | 'export')}
        options={[
          { label: '导入', value: 'import', icon: <FileExcelOutlined /> },
          { label: '导出', value: 'export', icon: <DownloadOutlined /> },
        ]}
      />
    </div>
    {mode === 'import' ? importBody : exportBody}
  </div>;
}
