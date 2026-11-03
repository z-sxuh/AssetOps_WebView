import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  Alert, Button, Card, Checkbox, Empty, Form, Input, InputNumber, Modal, Popconfirm,
  Space, Switch, Table, Tag, Typography, message,
} from 'antd';
import Select from '../../components/AppSelect';
import OrganizationSelect from '../../components/OrganizationSelect';
import type { ColumnsType } from 'antd/es/table';
import {
  DeleteOutlined, DownloadOutlined, UploadOutlined,
  EditOutlined, OrderedListOutlined, PlusOutlined, SaveOutlined,
} from '@ant-design/icons';
import FieldOrderModal from '../../components/FieldOrderModal';
import type { FieldDef, FieldTemplateField, FieldType, VaultData } from '../../model';
import { defaultFields, id } from '../../model';
import { passwordPolicyDefaults, rotationEnabled } from '../../passwordPolicy';
import { useTableBodyHeight } from '../../useTableBodyHeight';
import { composingCancel } from '../../composition';
import { native } from '../../native';
import { exportFieldTemplates, fieldTemplateImportPlan, mergeFieldTemplates, parseFieldTemplates, templateFileLimit, type TransferTemplate } from './templateTransfer';
import { builtInFieldType, checkedFieldDefinition } from './fieldDefinition';

const { Text, Title } = Typography;
const DEFAULT_TEMPLATE = '__default__';

const fieldTypeOptions: { value: FieldType; label: string }[] = [
  { value: 'text', label: '单行文本' },
  { value: 'textarea', label: '多行文本' },
  { value: 'ip', label: 'IP 地址' },
  { value: 'integer', label: '整数' },
  { value: 'disk', label: '硬盘组' },
  { value: 'user', label: '用户组' },
  { value: 'password', label: '密码' },
  { value: 'boolean', label: '单选（是 / 否）' },
  { value: 'date', label: '日期' },
  { value: 'datetime', label: '日期时间' },
  { value: 'url', label: '网址' },
  { value: 'email', label: '邮箱' },
  { value: 'phone', label: '电话' },
  { value: 'path', label: '文件路径' },
];

type FieldFormValues = {
  label: string;
  templateNote?: string;
  key: string;
  type: FieldType;
  required: boolean;
  unique: boolean;
  quickCopy: boolean;
  defaultValue?: string | number | boolean;
  options?: string;
  min?: number;
  max?: number;
  maxLength?: number;
  showInList: boolean;
};

export type FieldsPageProps = {
  active?: boolean;
  data: VaultData;
  systemId?: string | null;
  onSystemChange?: (systemId: string | null) => void;
  onChange: (nextData: VaultData, options?: { orderOnly?: boolean }) => void | Promise<void>;
};

function toTemplateField(value: FieldDef): FieldTemplateField {
  return {
    key: value.key,
    label: value.label,
    templateNote: value.templateNote,
    type: value.type,
    required: value.required,
    unique: value.unique,
    quickCopy: value.quickCopy,
    defaultValue: value.defaultValue,
    options: [...value.options],
    validation: { ...value.validation },
    width: value.width,
    showInList: value.showInList,
    sortOrder: value.sortOrder,
    systemField: value.systemField,
    readOnly: value.readOnly,
  };
}

function displayDefault(value: unknown): string {
  if (value === undefined || value === null || value === '') return '—';
  return typeof value === 'string' ? value : JSON.stringify(value);
}

export default function FieldsPage({ active = true, data, systemId, onSystemChange, onChange }: FieldsPageProps) {
  const [modalApi, modalContext] = Modal.useModal();
  const confirmation = useRef<ReturnType<typeof modalApi.confirm>>();
  const [deletingField, setDeletingField] = useState<string>();
  useLayoutEffect(() => { if (!active) { confirmation.current?.destroy(); confirmation.current = undefined; setDeletingField(undefined); } }, [active]);
  useEffect(() => () => confirmation.current?.destroy(), []);
  const [messageApi, messageContext] = message.useMessage({ maxCount: 3 });
  const [fieldForm] = Form.useForm<FieldFormValues>();
  const formKey = Form.useWatch('key', fieldForm);
  const formType = Form.useWatch('type', fieldForm);
  const systems = useMemo(() => data.units.flatMap((unit) => unit.environments.flatMap((environment) => environment.zones.flatMap((zone) => zone.systems.map((system) => ({
    value: system.id,
    label: [unit.name, environment.name, zone.name, system.name].filter(Boolean).join(' / '),
  }))))), [data.units]);
  const [selectedSystemId, setSelectedSystemId] = useState(systemId ?? '');
  const [stagedFields, setStagedFields] = useState<FieldDef[]>();
  const draftBase = useRef('');
  const [editingField, setEditingField] = useState<FieldDef | null>(null);
  const [fieldModalOpen, setFieldModalOpen] = useState(false);
  const [fieldSystemId, setFieldSystemId] = useState('');
  const [templateModalOpen, setTemplateModalOpen] = useState(false);
  const [templateName, setTemplateName] = useState('');
  const [fieldOrderOpen, setFieldOrderOpen] = useState(false);
  const [selectedTemplateId, setSelectedTemplateId] = useState<string>();
  const [saving, setSaving] = useState(false);
  const fieldSession = useRef(0);
  const [importOpen, setImportOpen] = useState(false), [importReading, setImportReading] = useState(false);
  const [importTemplates, setImportTemplates] = useState<TransferTemplate[]>(), [importError, setImportError] = useState('');
  const [overwriteTemplates, setOverwriteTemplates] = useState(false);
  const templateInput = useRef<HTMLInputElement>(null), importGeneration = useRef(0);
  const importPlan = useMemo(() => fieldTemplateImportPlan(data.fieldTemplates, importTemplates ?? [], overwriteTemplates), [data.fieldTemplates, importTemplates, overwriteTemplates]);
  const closeImport = () => { importGeneration.current++; setImportOpen(false); setImportReading(false); setImportTemplates(undefined); setImportError(''); };
  useEffect(() => () => { importGeneration.current++; }, []);
  const defaultView = !selectedSystemId;
  const templates = [{ id: DEFAULT_TEMPLATE, name: '默认模板', fields: defaultFields(DEFAULT_TEMPLATE).map(toTemplateField) }, ...data.fieldTemplates];

  useEffect(() => {
    if (fieldModalOpen) return;
    const next = systemId && systems.some((item) => item.value === systemId)
      ? systemId
      : systems.some((item) => item.value === selectedSystemId) ? selectedSystemId : '';
    if (next !== selectedSystemId) setSelectedSystemId(next);
  }, [selectedSystemId, systemId, systems, fieldModalOpen]);

  useEffect(() => { setStagedFields(undefined); setSelectedTemplateId(undefined); }, [selectedSystemId]);
  const fields = useMemo(() => stagedFields ?? data.fieldDefs
    .filter((item) => item.systemId === selectedSystemId)
    .sort((left, right) => left.sortOrder - right.sortOrder), [data.fieldDefs, selectedSystemId, stagedFields]);

  const rotationDefault = passwordPolicyDefaults(fields).rotatePassword;
  const emit = async (nextData: VaultData, success: string) => {
    setSaving(true);
    try {
      await onChange(nextData);
      messageApi.success(success);
      return true;
    } catch (reason) {
      messageApi.error(reason instanceof Error ? reason.message : '保存失败');
      return false;
    } finally {
      setSaving(false);
    }
  };

  const selectSystem = (value: string) => {
    setSelectedSystemId(value);
    onSystemChange?.(value);
  };

  const saveFieldOrder = async (orderedFields: FieldDef[]) => {
    if (!selectedSystemId) return;
    setSaving(true);
    try {
      if (orderedFields.length !== fields.length || orderedFields.some((field) => JSON.stringify(fields.find((current) => current.id === field.id)) !== JSON.stringify(field))) throw new Error('字段已更新，请重新打开字段排序');
      const fieldDefs = data.fieldDefs.filter((field) => field.systemId !== selectedSystemId)
        .concat(orderedFields.map((field, sortOrder) => ({ ...field, sortOrder })));
      if (stagedFields) setStagedFields(orderedFields.map((field, sortOrder) => ({ ...field, sortOrder })));
      else await onChange({ ...data, fieldDefs }, { orderOnly: true });
      setFieldOrderOpen(false);
      messageApi.success('字段顺序已保存');
    } catch (reason) {
      messageApi.error(reason instanceof Error ? reason.message : '保存失败');
    } finally { setSaving(false); }
  };

  const openCreate = () => {
    fieldSession.current++;
    setFieldSystemId(selectedSystemId);
    setEditingField(null);
    fieldForm.resetFields();
    fieldForm.setFieldsValue({
      label: '', key: '', type: 'text', required: false, unique: false, quickCopy: false,
      defaultValue: '', options: '', templateNote: '', showInList: true,
    });
    setFieldModalOpen(true);
  };

  const openEdit = (value: FieldDef) => {
    fieldSession.current++;
    setFieldSystemId(value.systemId);
    setEditingField(value);
    fieldForm.resetFields();
    fieldForm.setFieldsValue({
      label: value.label,
      templateNote: value.templateNote ?? '',
      key: value.key,
      type: value.type,
      required: value.required,
      unique: value.unique,
      quickCopy: Boolean(value.quickCopy),
      defaultValue: value.type === 'boolean' ? rotationEnabled(value.defaultValue) : value.key === 'pwd_cycle_days' ? Number(value.defaultValue) || undefined : displayDefault(value.defaultValue) === '—' ? '' : displayDefault(value.defaultValue),
      options: value.options.join('\n'),
      min: value.validation.min,
      max: value.validation.max,
      maxLength: value.validation.maxLength,
      showInList: value.showInList,
    });
    setFieldModalOpen(true);
  };

  const saveField = async (values: FieldFormValues) => {
    if (saving) return;
    const session = fieldSession.current;
    if (!fieldSystemId || fieldSystemId !== selectedSystemId || !systems.some(system => system.value === fieldSystemId)) {
      messageApi.error('所属系统已删除或改变，草稿已保留，请重新选择系统后编辑'); return;
    }
    if (editingField && JSON.stringify(fields.find((item) => item.id === editingField.id)) !== JSON.stringify(editingField)) {
      messageApi.error('字段已更新或删除，请重新打开编辑'); return;
    }
    const normalizedKey = values.key.trim();
    const duplicate = fields.some((item) => item.key === normalizedKey && item.id !== editingField?.id);
    if (duplicate) {
      fieldForm.setFields([{ name: 'key', errors: ['当前系统中已有相同键名'] }]);
      return;
    }
    let nextField: FieldDef = {
      id: editingField?.id ?? id(),
      systemId: fieldSystemId,
      key: normalizedKey,
      label: values.label.trim(),
      templateNote: values.templateNote?.trim() ?? '',
      type: values.type,
      required: values.required,
      unique: values.unique,
      quickCopy: Boolean(values.quickCopy),
      defaultValue: normalizedKey === 'pwd_expire_at' ? undefined : values.type === 'boolean' ? rotationEnabled(values.defaultValue) : normalizedKey === 'pwd_cycle_days' ? Number(values.defaultValue) || undefined : String(values.defaultValue ?? '').trim() || undefined,
      options: (values.options ?? '').split(/\r?\n|,/).map((item) => item.trim()).filter(Boolean),
      validation: {
        min: values.min,
        max: values.max,
        maxLength: values.maxLength,
        pattern: editingField?.validation.pattern,
      },
      width: editingField?.width ?? 120,
      showInList: values.showInList,
      sortOrder: editingField?.sortOrder ?? fields.length,
      systemField: editingField?.systemField ?? false,
      readOnly: editingField?.readOnly,
    };
    try { nextField = checkedFieldDefinition(nextField, editingField ?? undefined); }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      fieldForm.setFields([{ name: 'min', errors: [message] }]); messageApi.error(message); return;
    }
    if (stagedFields) {
      setStagedFields(editingField ? fields.map(item => item.id === nextField.id ? nextField : item) : [...fields, nextField]);
      setFieldModalOpen(false); return;
    }
    const fieldDefs = editingField
      ? data.fieldDefs.map((item) => item.id === nextField.id ? nextField : item)
      : [...data.fieldDefs, nextField];
    if (!await emit({ ...data, fieldDefs }, editingField ? '字段已更新' : '字段已新增')) return;
    if (session === fieldSession.current) setFieldModalOpen(false);
  };

  const removeField = async (value: FieldDef) => {
    if (value.systemField) return;
    const remaining = fields.filter((item) => item.id !== value.id).map((item, index) => ({ ...item, sortOrder: index }));
    if (stagedFields) { setStagedFields(remaining); return; }
    const fieldDefs = data.fieldDefs
      .filter((item) => item.systemId !== selectedSystemId)
      .concat(remaining);
    await emit({ ...data, fieldDefs }, '字段已删除');
  };

  const saveTemplate = async () => {
    const name = templateName.trim();
    if (!name) return;
    const now = new Date().toISOString();
    const existing = data.fieldTemplates.find((item) => item.name === name);
    const template = {
      id: existing?.id ?? id(),
      name,
      fields: fields.map(toTemplateField),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    const fieldTemplates = existing
      ? data.fieldTemplates.map((item) => item.id === existing.id ? template : item)
      : [...data.fieldTemplates, template];
    if (!await emit({ ...data, fieldTemplates }, existing ? '模板已更新' : '模板已保存')) return;
    setTemplateName('');
    setTemplateModalOpen(false);
  };

  const readTemplates = async (file: File) => {
    const generation = ++importGeneration.current;
    setImportTemplates(undefined); setImportError(''); setImportReading(true);
    try {
      if (file.size > templateFileLimit) throw new Error('字段模板文件不能超过 8 MB');
      const content = await file.text();
      if (generation !== importGeneration.current) return;
      setImportTemplates(parseFieldTemplates(content));
    } catch (reason) {
      if (generation === importGeneration.current) setImportError(reason instanceof Error ? reason.message : '读取模板失败');
    } finally { if (generation === importGeneration.current) setImportReading(false); }
  };
  const importTemplateFile = async () => {
    if (!importTemplates || saving || importReading || !importPlan.added && !importPlan.updated) return;
    const fieldTemplates = mergeFieldTemplates(data.fieldTemplates, importTemplates, overwriteTemplates);
    if (await emit({ ...data, fieldTemplates }, `已导入 ${importPlan.added + importPlan.updated} 个字段模板`)) closeImport();
  };
  const exportTemplates = async () => {
    if (saving || !data.fieldTemplates.length) return;
    setSaving(true);
    try {
      const path = await native.exportDocument('字段模板', 'json', exportFieldTemplates(data.fieldTemplates));
      messageApi.success({ content: <Space><span>字段模板已导出</span><Button type="link" size="small" onClick={() => void native.revealInFolder(path)}>打开目录</Button></Space>, duration: 8 });
    } catch (reason) { messageApi.error(reason instanceof Error ? reason.message : '导出失败'); }
    finally { setSaving(false); }
  };

  const chooseTemplate = (value: string) => {
    const template = templates.find(item => item.id === value);
    if (!template || !selectedSystemId) return;
    try { template.fields.forEach(field => checkedFieldDefinition(field)); }
    catch (error) { messageApi.error(error instanceof Error ? error.message : String(error)); return; }
    draftBase.current = JSON.stringify(data.fieldDefs.filter(field => field.systemId === selectedSystemId));
    setSelectedTemplateId(value);
    setStagedFields(template.fields.map((item, sortOrder) => ({ ...item, id: id(), systemId: selectedSystemId, sortOrder, options: [...item.options], validation: { ...item.validation } })));
  };
  const deleteTemplate = () => {
    const template = data.fieldTemplates.find(item => item.id === selectedTemplateId);
    if (!template || saving) return;
    confirmation.current = modalApi.confirm({
      title: `删除字段模板“${template.name}”？`,
      content: '已应用到系统的字段将保留，当前模板预览将关闭。',
      okText: '删除', cancelText: '取消', okButtonProps: { danger: true },
      onOk: async () => {
        if (!await emit({ ...data, fieldTemplates: data.fieldTemplates.filter(item => item.id !== template.id) }, '字段模板已删除')) throw new Error('删除失败，可重试');
        setSelectedTemplateId(undefined); setStagedFields(undefined);
      },
    });
  };
  const applyTemplate = () => {
    const template = templates.find((item) => item.id === selectedTemplateId);
    if (!template || !selectedSystemId || !stagedFields) return;
    confirmation.current = modalApi.confirm({
      title: '保存系统字段？',
      content: `将保存调整后的 ${stagedFields.length} 个字段到当前系统。`,
      okText: '保存字段',
      cancelText: '取消',
      onOk: async () => {
        if (draftBase.current !== JSON.stringify(data.fieldDefs.filter(field => field.systemId === selectedSystemId))) throw new Error('字段已更新，请重新选择模板');
        const applied = stagedFields.map((item, index) => checkedFieldDefinition({
          ...item,
          id: id(),
          systemId: selectedSystemId,
          sortOrder: index,
          options: [...item.options],
          validation: { ...item.validation },
        }));
        const saved = await emit({
          ...data,
          fieldDefs: data.fieldDefs.filter((item) => item.systemId !== selectedSystemId).concat(applied),
        }, '字段模板已应用');
        if (!saved) throw new Error('字段模板未保存，可重试');
        setStagedFields(undefined); setSelectedTemplateId(undefined);
      },
    });
  };

  const columns: ColumnsType<FieldDef> = [
    { title: '显示名', dataIndex: 'label' },
    { title: '键名', dataIndex: 'key', render: (value: string, fieldValue) => <Space className="field-key"><Text code>{value}</Text>{fieldValue.systemField && <Tag color="blue">系统</Tag>}</Space> },
    { title: '类型', dataIndex: 'type', render: (value: FieldType) => fieldTypeOptions.find((item) => item.value === value)?.label ?? value },
    { title: '必填', dataIndex: 'required', align: 'center', render: (value: boolean) => value ? '✓' : '—' },
    { title: '唯一', dataIndex: 'unique', align: 'center', render: (value: boolean) => value ? '✓' : '—' },
    { title: '快速复制', dataIndex: 'quickCopy', align: 'center', render: (value: boolean) => value ? '✓' : '—' },
    { title: '默认值', dataIndex: 'defaultValue', render: (value, field) => field.key === 'pwd_expire_at' ? '自动计算' : field.type === 'boolean' ? rotationEnabled(value) ? '是' : '否' : field.key === 'pwd_cycle_days' && !rotationDefault ? <Text type="secondary">未启用</Text> : field.key === 'pwd_cycle_days' && value ? `${value} 天` : displayDefault(value) },
    {
      title: '校验 / 可选值', key: 'validation',
      render: (_, value) => {
        if (value.key === 'pwd_rotate') return '是 / 否';
        if (value.key === 'pwd_cycle_days') return '选“是”后填写更新间隔（天）';
        if (value.key === 'pwd_expire_at') return '密码创建／修改日期 + 更新周期，自动计算';
        const rules = [
          value.options.length ? value.options.join(' / ') : '',
          value.validation.min !== undefined ? `最小 ${value.validation.min}` : '',
          value.validation.max !== undefined ? `最大 ${value.validation.max}` : '',
          value.validation.maxLength !== undefined ? `长度 ≤ ${value.validation.maxLength}` : '',
          value.validation.pattern ? `正则 ${value.validation.pattern}` : '',
        ].filter(Boolean);
        return rules.length ? rules.join(' · ') : <Text type="secondary">—</Text>;
      },
    },
    { title: '模板填写说明', dataIndex: 'templateNote', width: 220, ellipsis: true, render: (value?: string) => value || '/' },
    { title: '列表显示', dataIndex: 'showInList', align: 'center', render: (value: boolean) => value ? '✓' : '—' },
    {
      title: '操作', key: 'actions',
      render: (_, value) => <Space size={0}>
        <Button disabled={defaultView} type="link" size="small" icon={<EditOutlined />} onClick={() => openEdit(value)}>编辑</Button>
        {value.systemField
          ? <Button type="link" size="small" disabled>受保护</Button>
          : <Popconfirm open={active && deletingField === value.id} onOpenChange={(open) => setDeletingField(open ? value.id : undefined)} title="删除该字段？" description="已有资产的对应值将无法再显示。" okText="删除" cancelText="取消" okButtonProps={{ danger: true }} onConfirm={() => void removeField(value)}>
            <Button disabled={defaultView} type="link" size="small" danger icon={<DeleteOutlined />}>删除</Button>
          </Popconfirm>}
      </Space>,
    },
  ];

  const { hostRef, bodyHeight } = useTableBodyHeight(['.table-toolbar'], [defaultView, Boolean(stagedFields)]);

  return <div className="page-content instant-list-page fixed-page">
    {modalContext}
    {messageContext}
    <Space direction="vertical" size={16} style={{ width: '100%', flex: '0 0 auto' }}>
      <div className="page-heading fields-page-heading">
        <div>
          <Title level={2}>字段定义</Title>
        </div>
        <Space wrap>
          <Button aria-label="导入模板" disabled={saving} icon={<UploadOutlined />} onClick={() => { closeImport(); setOverwriteTemplates(false); setImportOpen(true); }}>导入模板</Button>
          <Button aria-label="导出模板" disabled={saving || !data.fieldTemplates.length} title="导出全部已保存模板" icon={<DownloadOutlined />} onClick={() => void exportTemplates()}>导出模板</Button>
          {!defaultView && <>
            <Space size={6}><Select active={active} aria-label="字段模板" style={{ minWidth: 180 }} placeholder="导入字段模板" disabled={saving} value={selectedTemplateId} onChange={chooseTemplate} options={templates.map((item) => ({ value: item.id, label: `${item.name} (${item.fields.length})` }))} />{data.fieldTemplates.some(item => item.id === selectedTemplateId) && <Button danger icon={<DeleteOutlined />} disabled={saving} aria-label="删除模板" title="删除模板" onClick={deleteTemplate} />}</Space>
            <Button disabled={!stagedFields || saving} onClick={applyTemplate}>保存字段</Button>
            <Button disabled={!fields.length || saving} icon={<SaveOutlined />} onClick={() => setTemplateModalOpen(true)}>保存为模板</Button>
          </>}
          <OrganizationSelect active={active} label="字段定义系统" units={data.units} level="systemId" style={{ minWidth: 250 }} placeholder="选择系统" value={selectedSystemId || undefined} disabled={!systems.length || saving} onChange={(value) => { if (value) selectSystem(value); }} />
          <Button disabled={defaultView || saving} icon={<OrderedListOutlined />} onClick={() => setFieldOrderOpen(true)}>字段排序</Button>
          <Button type="primary" disabled={defaultView || saving} icon={<PlusOutlined />} onClick={openCreate}>新增字段</Button>
        </Space>
      </div>

    </Space>

      <div className="fixed-table-host" ref={hostRef}><Card className="fixed-table-card fields-table-card" bordered={false} bodyStyle={{ padding: 0 }}>
        {stagedFields && <div className="table-toolbar"><Text type="warning">当前为未保存字段，可调整后点击保存字段。</Text></div>}
        {defaultView ? <Empty className="fields-empty" image={Empty.PRESENTED_IMAGE_SIMPLE} description="请选择系统" /> : <Table<FieldDef> className="fields-table"
          rowKey="id"
          columns={columns}
          dataSource={fields}
          loading={saving}
          pagination={false}
          tableLayout="auto"
          scroll={{ x: 'max-content', y: bodyHeight }}
          locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="当前系统还没有字段，请从上方导入模板" /> }}
        />}
      </Card></div>

    <FieldOrderModal active={active} open={fieldOrderOpen} fields={fields} saving={saving} onClose={() => setFieldOrderOpen(false)} onSave={saveFieldOrder} />

    <Modal title="导入字段模板" open={active && importOpen} focusTriggerAfterClose={active} okText="导入模板" cancelText="取消" confirmLoading={saving}
      cancelButtonProps={{ disabled: saving }} keyboard={!saving} maskClosable={!saving} closable={{ disabled: saving }}
      onCancel={event => { if (!saving && !composingCancel(event)) closeImport(); }}
      okButtonProps={{ disabled: importReading || !importTemplates || !importPlan.added && !importPlan.updated }} onOk={() => void importTemplateFile()}>
      <Space direction="vertical" className="full-width">
        <Text>导入已保存的字段模板。默认跳过同名模板，不会直接修改系统字段或资产。</Text>
        <Button disabled={saving || importReading} icon={<UploadOutlined />} onClick={() => templateInput.current?.click()}>选择字段模板 JSON</Button>
        <input ref={templateInput} type="file" accept=".json,application/json" aria-label="字段模板文件" hidden onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void readTemplates(file); }} />
        <Checkbox disabled={saving} checked={overwriteTemplates} onChange={event => setOverwriteTemplates(event.target.checked)}>覆盖同名模板</Checkbox>
        {importReading && <Alert type="info" showIcon message="正在校验字段模板…" />}
        {importError && <Alert type="error" showIcon message={importError} />}
        {importTemplates && <><Alert type="info" showIcon message={`新增 ${importPlan.added} 个 · 覆盖 ${importPlan.updated} 个 · 跳过 ${importPlan.skipped} 个`} />
          <div style={{ maxHeight: 220, overflowY: 'auto' }}>{importTemplates.map(template => <div key={template.name}>{template.name} · {template.fields.length} 个字段</div>)}</div></>}
      </Space>
    </Modal>

    <Modal
      title={editingField ? '编辑字段' : '新增字段'}
      open={active && fieldModalOpen}
      focusTriggerAfterClose={active}
      afterClose={() => { if (!fieldModalOpen) { fieldForm.resetFields(); setFieldSystemId(''); } }}
      onCancel={(event) => { if (!saving && !composingCancel(event)) { fieldSession.current++; setFieldModalOpen(false); } }}
      onOk={() => fieldForm.submit()}
      okText="保存"
      cancelText="取消"
      confirmLoading={saving}
      closable={!saving}
      maskClosable={!saving}
      keyboard={!saving}
      cancelButtonProps={{ disabled: saving }}
      width={720}
    >
      <Text type="secondary">所属系统：{systems.find(system => system.value === fieldSystemId)?.label ?? '原系统已删除'}</Text>
      {editingField && <Text type="secondary">已有字段的存储键不可修改，显示名仍可调整。内置字段类型须与资产模型一致。</Text>}
      <Form disabled={saving} form={fieldForm} layout="vertical" onFinish={(values) => void saveField(values)} style={{ marginTop: 16 }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0 16px' }}>
          <Form.Item name="label" label="显示名" rules={[{ required: true, whitespace: true, message: '请输入显示名' }]}><Input maxLength={64} /></Form.Item>
          <Form.Item name="key" label="键名" rules={[
            { required: true, whitespace: true, message: '请输入键名' },
            { pattern: /^[A-Za-z_][A-Za-z0-9_]*$/, message: '仅支持字母、数字和下划线，且不能以数字开头' },
          ]}><Input disabled={Boolean(editingField)} /></Form.Item>
          <Form.Item name="type" label="类型" rules={[{ required: true }]}><Select active={active && fieldModalOpen} disabled={editingField?.systemField} options={builtInFieldType(formKey) ? fieldTypeOptions.filter(option => option.value === builtInFieldType(formKey)) : fieldTypeOptions} /></Form.Item>
          {formKey === 'pwd_expire_at' ? <Form.Item label="计算规则"><Input readOnly disabled value="密码创建／修改日期 + 更新周期" /></Form.Item> : <Form.Item name="defaultValue" label={formKey === 'pwd_cycle_days' ? '默认更新周期' : '默认值'} extra={formKey === 'pwd_cycle_days' && !rotationDefault ? '先将本系统“定期修改密码”的默认值设为“是”，再填写周期。' : undefined} rules={formKey === 'pwd_cycle_days' ? [{ validator: (_, value) => !rotationDefault || value === undefined || value === '' || (Number.isInteger(value) && value >= 1 && value <= 3650) ? Promise.resolve() : Promise.reject(new Error('请输入 1–3650 天的整数')) }] : []}>
            {formType === 'boolean' ? <Select active={active && fieldModalOpen} options={[{ value: true, label: '是' }, { value: false, label: '否' }]} /> : formKey === 'pwd_cycle_days' ? <InputNumber disabled={!rotationDefault} min={1} max={3650} precision={0} placeholder="填写多少天更新一次" addonAfter="天" style={{ width: '100%' }} /> : <Input disabled={editingField?.readOnly} />}
          </Form.Item>}
          <Form.Item name="options" label="可选值（逗号或换行分隔）"><Input.TextArea rows={2} /></Form.Item>
          <Form.Item name="min" label="最小值"><InputNumber style={{ width: '100%' }} /></Form.Item>
          <Form.Item name="max" label="最大值"><InputNumber style={{ width: '100%' }} /></Form.Item>
          <Form.Item name="maxLength" label="最大长度"><InputNumber min={1} style={{ width: '100%' }} /></Form.Item>
          <Form.Item name="templateNote" label="模板填写说明" style={{ gridColumn: '1 / -1' }}><Input.TextArea rows={2} placeholder="导出模板第二行的说明，支持换行；留空显示 /" /></Form.Item>
        </div>
        <Space size={24} wrap>
          <Form.Item name="required" valuePropName="checked" noStyle><Checkbox disabled={editingField?.systemField}>必填</Checkbox></Form.Item>
          <Form.Item name="unique" valuePropName="checked" noStyle><Checkbox disabled={editingField?.systemField}>唯一</Checkbox></Form.Item>
          <Form.Item name="quickCopy" valuePropName="checked" noStyle><Checkbox>快速复制</Checkbox></Form.Item>
          <Form.Item name="showInList" valuePropName="checked" noStyle><Switch checkedChildren="列表显示" unCheckedChildren="列表隐藏" /></Form.Item>
        </Space>
      </Form>
    </Modal>

    <Modal title="保存字段模板" open={active && templateModalOpen} focusTriggerAfterClose={active} onCancel={(event) => { if (!composingCancel(event)) setTemplateModalOpen(false); }} onOk={() => void saveTemplate()} okText="保存" cancelText="取消" okButtonProps={{ disabled: !templateName.trim() }} confirmLoading={saving}>
      <Text type="secondary">同名模板会被当前字段集更新。</Text>
      <Input style={{ marginTop: 16 }} value={templateName} onChange={(event) => setTemplateName(event.target.value)} placeholder="模板名称" maxLength={64} />
    </Modal>
  </div>;
}
