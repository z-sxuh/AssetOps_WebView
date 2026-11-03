import { lazy, memo, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Alert, Button, Card, Checkbox, Dropdown, Empty, Input, List, Modal, Space, Table, Tabs, Typography, message } from 'antd';
import { FolderOpenOutlined, SaveOutlined } from '@ant-design/icons';
import Select from '../../components/AppSelect';
import type { VaultData } from '../../model';
import { displayPath } from '../../model';
import BasicMarkdown from '../../components/BasicMarkdown';
import { systemMarkdown } from './systemExport';
import { native } from '../../native';
import { chinaTime } from '../reports/reportModel';
import OrgTreePanel from '../../components/OrgTreePanel';
import { assetsInScope, operationFocusKey, operationScopeKey, operationScopes } from './operationScope';
import type { OpsSystem, SystemRevision, Topology } from './types';
import { parseTopology, topologyHtml, topologyPng, topologySvg, type TopologyExportOptions } from './topology';
import { OperationsSession, type OperationsContext } from './operationsSession';
import { createOperationDraftStorage } from './markdownDraft';
import { composingCancel } from '../../composition';
import type { ReactNode } from 'react';
import type { StructureTarget } from '../structure/StructureManager';
import type { MarkdownEditorHandle } from '../../components/MarkdownEditor';

const MarkdownEditor = lazy(() => import('../../components/MarkdownEditor'));
const TopologyCanvas = lazy(() => import('./TopologyCanvas'));

function OperationsPage({ data, active = true, focusId, onFocusHandled, onChange, onAsset, onCreateDirectory, onManageDirectory, directoryTransfer, directoryDisabled }: { data: VaultData; active?: boolean; focusId?: string; onFocusHandled: () => void; onChange: (systems: OpsSystem[]) => Promise<void>; onAsset: (id: string) => void; onCreateDirectory: (scope?: { unitId?: string; environmentId?: string; zoneId?: string }) => void; onManageDirectory: (target: StructureTarget) => void; directoryTransfer: ReactNode; directoryDisabled: boolean }) {
  const [msg, context] = message.useMessage({ maxCount: 3 }); const options = useMemo(() => operationScopes(data.units), [data.units]);
  const [initialSelected] = useState(() => {
    return (focusId && operationFocusKey(focusId, data.units, data.opsSystems)) || '';
  });
  const [editing] = useState(() => new OperationsSession(createOperationDraftStorage(), (kind, content) => { void msg[kind]({ key: 'markdown-draft', content }); }));
  const { selected, draft, note } = useSyncExternalStore(editing.subscribe, editing.getSnapshot);
  const markdownEditor = useRef<MarkdownEditorHandle>(null);
  const [markdownPending, setMarkdownPending] = useState(false);
  const editingContext: OperationsContext = useMemo(() => ({ units: data.units, systems: data.opsSystems, scopes: options, persist: onChange }), [data.units, data.opsSystems, options, onChange]);
  const [revealPath, setRevealPath] = useState<{ ids: string[]; token: number } | null>(null);
  const setSelected = useCallback((value: string, reveal = false) => {
    if (value !== editing.getSnapshot().selected) { setMarkdownPending(false); editing.select(value, editingContext); }
    if (reveal) {
      const target = options.find(item => item.value === value);
      setRevealPath(current => target ? { ids: [target.scope.unitId, target.scope.environmentId, target.scope.zoneId].filter((id): id is string => Boolean(id)), token: (current?.token ?? 0) + 1 } : null);
    }
  }, [editing, editingContext, options]);
  const [busy, setBusy] = useState(false);
  const [editingEmpty, setEditingEmpty] = useState(false);
  const busyRef = useRef(false);
  const [rollback, setRollback] = useState<SystemRevision>(); const [rollbackOpen, setRollbackOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<SystemRevision>(); const [deleteOpen, setDeleteOpen] = useState(false);
  const [importText, setImportText] = useState(''); const [importOpen, setImportOpen] = useState(false); const [tab, setTab] = useState('info'); const [pendingSelect, setPendingSelectState] = useState<{ value: string; reveal?: boolean }>();
  const pendingSelectRef = useRef<typeof pendingSelect>();
  const setPendingSelect = useCallback((value: typeof pendingSelect) => { pendingSelectRef.current = value; setPendingSelectState(value); }, []);
  useEffect(() => () => { pendingSelectRef.current = undefined; }, []);
  const [exportKind, setExportKind] = useState<'system' | 'png' | 'html' | 'svg'>(); const [exportRevision, setExportRevision] = useState<SystemRevision>(); const [exportOptions, setExportOptions] = useState<TopologyExportOptions>({ background: '#ffffff', grid: false });
  const [exportOpen, setExportOpen] = useState(false);
  const [includeTopology, setIncludeTopology] = useState(true);
  const [topologyMenuOpen, setTopologyMenuOpen] = useState(false);
  const [directoryOpen, setDirectoryOpen] = useState(false);
  const [directoryFloating, setDirectoryFloating] = useState(false);
  const directoryToggle = useRef<HTMLButtonElement>(null);
  const toggleDirectory = useCallback(() => { setDirectoryFloating(value => !value); setDirectoryOpen(false); }, []);
  useLayoutEffect(() => { if (directoryFloating) directoryToggle.current?.focus({ preventScroll: true }); }, [directoryFloating]);
  const [backgroundOpen, setBackgroundOpen] = useState(false);
  useLayoutEffect(() => { if (!active) { setTopologyMenuOpen(false); setDirectoryOpen(false); } if (!active || !exportOpen) setBackgroundOpen(false); }, [active, exportOpen]);
  const selection = options.find((item) => item.value === selected);
  const current = data.opsSystems.find((item) => operationScopeKey(item, data.units, options) === selected);
  const assetScope = selection?.scope ?? current;
  const availableAssets = useMemo(() => assetsInScope(data.assets, assetScope ?? {}), [data.assets, assetScope]);
  useLayoutEffect(() => { setSelected(initialSelected, true); }, [editing]);
  useEffect(() => { setRollback(undefined); setRollbackOpen(false); setDeleteOpen(false); setEditingEmpty(false); }, [selected]);
  const run = async (operation: () => Promise<void>) => { if (busyRef.current) return; busyRef.current = true; setBusy(true); try { await operation(); } catch (error) { msg.error(error instanceof Error ? error.message : String(error)); } finally { busyRef.current = false; setBusy(false); } };
  const currentAssetIds = draft?.assetIds ?? [];
  const dirty = useMemo(() => markdownPending || editing.isDirty(editingContext), [markdownPending, draft, data.opsSystems, data.units]);
  useEffect(() => {
    if (!dirty) return;
    const protect = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', protect);
    return () => window.removeEventListener('beforeunload', protect);
  }, [dirty]);
  const selectDirectory = useCallback((value: string) => { if (busy || value === selected) return; if (dirty) setPendingSelect({ value }); else setSelected(value); }, [busy, selected, dirty, setSelected]);
  const selectTreeDirectory = useCallback((unit: string | null, environment: string | null, zone?: string | null, system?: string | null) => {
    const target = options.find(item => system ? item.scope.systemId === system : zone ? item.scope.zoneId === zone && !item.scope.systemId : environment ? item.scope.environmentId === environment && !item.scope.zoneId : item.scope.unitId === unit && !item.scope.environmentId);
    if (target) selectDirectory(target.value);
  }, [options, selectDirectory]);
  const createTreeDirectory = useCallback(() => onCreateDirectory(selection?.scope), [onCreateDirectory, selection]);
  const editMarkdown = useCallback((markdown: string) => editing.edit({ markdown }), [editing]);
  const editTopology = useCallback((topology: Topology) => editing.edit({ topology }), [editing]);
  useEffect(() => { if (focusId) { const target = operationFocusKey(focusId, data.units, data.opsSystems); if (target) { if (target !== selected && dirty) setPendingSelect({ value: target, reveal: true }); else { setPendingSelect(undefined); setSelected(target, true); } } onFocusHandled(); } }, [focusId]);
  const save = async () => {
    markdownEditor.current?.flush();
    if (!editing.isDirty(editingContext)) return;
    await editing.save(editingContext);
    msg.success('系统资料与拓扑已保存，版本记录已生成');
  };
  const saveAndSwitch = async () => {
    const request = pendingSelectRef.current;
    if (!request) return;
    await save();
    if (pendingSelectRef.current !== request) return;
    setSelected(request.value, request.reveal); setPendingSelect(undefined);
  };
  const discardAndSwitch = () => {
    const request = pendingSelectRef.current;
    if (busyRef.current || !request) return;
    try { editing.discard(); setSelected(request.value, request.reveal); setPendingSelect(undefined); }
    catch { msg.error('移除本地草稿失败，修改已保留'); }
  };
  const deleteRevision = async (revision: SystemRevision) => {
    await editing.deleteRevision(editingContext, revision.id);
    setDeleteOpen(false); msg.success('版本记录已删除');
  };
  const exportTopology = async (format: 'png' | 'html' | 'svg' | 'json') => {
    if (!draft) return;
    const content = format === 'png' ? await topologyPng(draft.topology, data.assets, data.units, exportOptions) : format === 'html' ? topologyHtml(draft.scopeName, draft.topology, data.assets, data.units, exportOptions) : format === 'svg' ? topologySvg(draft.topology, data.assets, data.units, exportOptions) : JSON.stringify(draft.topology, null, 2);
    const path = await native.exportDocument(`${draft.scopeName}-网络拓扑`, format, content);
    msg.success({ content: <Space size={10}><span>{format.toUpperCase()} 已导出：{displayPath(path)}</span><Button size="small" type="link" style={{ padding: 0 }} onClick={() => void native.revealInFolder(path)}>打开目录</Button></Space>, duration: 8 });
  };
  const exportSystem = async (revision?: SystemRevision) => {
    markdownEditor.current?.flush();
    if (!draft) return;
    const latest = editing.getSnapshot().draft ?? draft;
    const value = revision ? { ...latest, markdown: revision.markdown, topology: revision.topology, assetIds: revision.assetIds ?? [] } : latest;
    const name = `${value.scopeName}${revision ? '-版本-' + chinaTime(revision.at).replace(/[: ]/g, '-') : '-系统运维'}`;
    const imagePath = includeTopology ? await native.exportDocument(`${name}-网络拓扑`, 'png', await topologyPng(value.topology, data.assets, data.units, exportOptions)) : undefined;
    const path = await native.exportDocument(name, 'md', systemMarkdown(value, data, imagePath?.split(/[\\/]/).pop(), revision));
    msg.success({ content: <Space><span>{includeTopology ? 'Markdown 与拓扑图片' : 'Markdown'}已导出：{displayPath(path)}</span><Button size="small" type="link" onClick={() => void native.revealInFolder(path)}>打开目录</Button></Space>, duration: 8 });
  };
  const extraOptions = useMemo(() => data.opsSystems.filter((item) => operationScopeKey(item, data.units, options).startsWith('archived:')).map((item) => ({ value: operationScopeKey(item, data.units, options), title: `${item.scopeName}（关联已删除）`, path: `${item.scopeName}（关联已删除）`, scope: item })), [data.opsSystems, data.units, options]);
  const archivedFooter = useMemo(() => extraOptions.length > 0 && <div className="operations-archived"><Typography.Text type="secondary">已删除目录的资料</Typography.Text>{extraOptions.map(item => <button key={item.value} type="button" disabled={busy} aria-pressed={selected === item.value} onClick={() => selectDirectory(item.value)}>{item.title}</button>)}</div>, [extraOptions, busy, selected, selectDirectory]);
  return <div className={`page-content module-page operations-page${tab === 'topology' ? ' topology-page' : tab === 'info' ? ' info-page' : ''}`} data-exit-dirty={dirty || undefined}>{context}
    <div className="page-heading"><div><Typography.Title level={2}>系统运维</Typography.Title></div><Button type="primary" icon={<SaveOutlined />} loading={busy} disabled={!draft || !dirty} onClick={() => void run(() => save())}>保存并记录版本</Button></div>
    <div className={`operations-layout${directoryFloating ? ' has-floating-directory' : ''}`} data-organization-workspace="" onKeyDown={event => {
      if (event.key === 'Escape' && directoryOpen && !event.nativeEvent.isComposing && event.keyCode !== 229) {
        event.preventDefault(); event.stopPropagation(); setDirectoryOpen(false); directoryToggle.current?.focus();
      }
    }}>
      <div id="operations-directory" className="operations-directory" hidden={directoryFloating && !directoryOpen}><OrgTreePanel data={data} active={active && (!directoryFloating || directoryOpen)} commitPendingSelection={active} activeUnit={selection?.scope.unitId ?? null} activeEnvironment={selection?.scope.environmentId ?? null} activeZone={selection?.scope.zoneId ?? null} activeSystem={selection?.scope.systemId ?? null} revealPath={revealPath} disabled={busy || directoryDisabled} onSelect={selectTreeDirectory} onCreate={createTreeDirectory} onManage={onManageDirectory} onToggleDirectory={toggleDirectory} directoryCollapsed={directoryFloating} transfer={directoryTransfer} footer={archivedFooter} /></div>
      <section className="operations-workspace workspace-surface" aria-label="运维资料工作区">
    <div className="module-toolbar">{directoryFloating && <Button ref={directoryToggle} className="ops-directory-toggle" aria-controls="operations-directory" aria-label={directoryOpen ? '收起组织目录' : '展开组织目录'} aria-expanded={directoryOpen} icon={<FolderOpenOutlined />} onClick={() => setDirectoryOpen(v => !v)}>目录</Button>}<Typography.Text className="ops-current-scope" title={selection?.path ?? current?.scopeName}>{selection?.path ?? current?.scopeName ?? '请选择单位'}</Typography.Text><Input aria-label="本次更新说明" placeholder="本次资料／拓扑修改说明" disabled={!draft} maxLength={500} value={note} onChange={(event) => editing.setNote(event.target.value)} />{dirty && <Typography.Text type="warning">有未保存修改</Typography.Text>}<Space wrap size={8} className="ops-export-buttons"><Button disabled={busy || !draft} onClick={() => { setExportRevision(undefined); setExportKind('system'); setExportOpen(true); }}>导出系统资料</Button><Dropdown trigger={['click']} open={active && topologyMenuOpen} onOpenChange={setTopologyMenuOpen} disabled={busy || !draft} menu={{ items: [{ key: 'import', label: '导入拓扑 JSON' }, { type: 'divider' }, ...(['png', 'html', 'svg', 'json'] as const).map((format) => ({ key: format, label: `导出 ${format.toUpperCase()}` }))], onClick: ({ key }) => { setTopologyMenuOpen(false); if (key === 'import') { setImportText(''); setImportOpen(true); } else if (key === 'json') void run(() => exportTopology('json')); else { setExportKind(key as 'png' | 'html' | 'svg'); setExportOpen(true); } } }}><Button>拓扑图导入／导出 ▾</Button></Dropdown></Space></div>
    {!draft ? <Empty description="请选择单位" /> : <>
      {!selection && <Alert type="warning" showIcon message="关联的资产目录已删除，历史资料保留；节点只按原资产 ID 跳转。" />}
      <Tabs activeKey={tab} onChange={setTab} items={[
        { key: 'info', label: '系统信息', children: !current && !dirty && !editingEmpty ? <Empty description="无数据"><Button onClick={() => setEditingEmpty(true)}>编辑系统信息</Button></Empty> : <div className="system-info-layout">
          <Suspense fallback={<div className="markdown-editor-loading">正在载入编辑器…</div>}><MarkdownEditor ref={markdownEditor} onDirtyChange={setMarkdownPending} active={active && tab === 'info'} allowSource key={selected} label="系统Markdown信息" value={draft.markdown} onChange={editMarkdown} placeholder="直接输入 Markdown：标题、列表、引用、代码和表格……" /></Suspense>
          <Card title="关联服务器资产" size="small" className="system-assets-panel">
            <Select aria-label="绑定服务器资产" mode="multiple" allowClear maxTagCount="responsive" className="full-width" placeholder="选择当前目录下的服务器" value={currentAssetIds} options={availableAssets.map((asset) => ({ value: asset.id, label: `${asset.name} · ${asset.ip || asset.host}` }))} onChange={(assetIds) => editing.edit({ assetIds })} />
            <List size="small" locale={{ emptyText: '尚未绑定服务器资产' }} dataSource={availableAssets.filter((asset) => currentAssetIds.includes(asset.id))} renderItem={(asset) => <List.Item actions={[<Button key="open" size="small" type="link" onClick={() => onAsset(asset.id)}>打开台账</Button>]}><List.Item.Meta title={asset.name} description={`${asset.ip || asset.host} · ${asset.status}`} /></List.Item>} />
          </Card>
        </div> },
        { key: 'topology', label: '网络拓扑', children: <div className="ops-topology-pane">
          <Suspense fallback={<div className="markdown-editor-loading">正在载入拓扑编辑器…</div>}><TopologyCanvas active={active && tab === 'topology'} key={selected} value={draft.topology} assets={data.assets} units={data.units} selectableAssets={availableAssets} onChange={editTopology} onAsset={onAsset} /></Suspense>
        </div> },
        { key: 'versions', label: `版本记录（${current?.revisions.length ?? 0}）`, children: <Table className="operations-version-table" rowKey="id" tableLayout="fixed" scroll={{ x: 960 }} dataSource={[...(current?.revisions ?? [])].reverse()} columns={[{ title: '时间', width: 180, render: (_, item) => chinaTime(item.at) }, { title: '说明', dataIndex: 'note', width: 250, render: (note: string) => <span className="operation-version-note" title={note}>{note || '—'}</span> }, { title: '关联服务器', width: 110, render: (_, item) => (item.assetIds ?? []).length }, { title: '拓扑', width: 160, render: (_, item) => `${item.topology.nodes.length} 节点／${item.topology.edges.length} 连接` }, { title: '操作', width: 260, fixed: 'right', render: (_, item) => <Space><Button disabled={busy || dirty} onClick={() => { setRollback(item); setRollbackOpen(true); }}>查看／回滚</Button><Button disabled={busy} onClick={() => { setExportRevision(item); setExportKind('system'); setExportOpen(true); }}>导出</Button><Button danger disabled={busy} onClick={() => { setDeleteTarget(item); setDeleteOpen(true); }}>删除</Button></Space> }]} /> },
      ]} />
    </>}
      </section>
    </div>
    <Modal title="删除版本记录" forceRender open={active && deleteOpen} focusTriggerAfterClose={active} afterClose={() => { if (!deleteOpen) setDeleteTarget(undefined); }} okText="删除" cancelText="取消" okButtonProps={{ danger: true, style: { width: 88 } }} confirmLoading={busy} onCancel={() => { if (!busy) setDeleteOpen(false); }} onOk={() => void run(async () => { if (deleteTarget) await deleteRevision(deleteTarget); })}><Typography.Paragraph>确认删除这条版本记录？当前系统资料与未保存修改会继续保留。</Typography.Paragraph><Typography.Text type="secondary">{deleteTarget && `${chinaTime(deleteTarget.at)} · ${deleteTarget.note}`}</Typography.Text></Modal>
    <Modal title="查看版本与回滚" width={1000} forceRender open={active && rollbackOpen} focusTriggerAfterClose={active} afterClose={() => { if (!rollbackOpen) setRollback(undefined); }} okText="回滚并生成新版本" confirmLoading={busy} cancelText="关闭" onCancel={() => setRollbackOpen(false)} onOk={() => void run(async () => { if (!rollback || !draft) return; await editing.rollback(editingContext, rollback, `回滚至 ${chinaTime(rollback.at)}：${rollback.note}`); setRollbackOpen(false); })}>{rollback && <><Alert type="info" message="回滚仅还原系统资料和拓扑；全部历史继续保留。" /><Typography.Paragraph>{rollback.note} · {(rollback.assetIds ?? []).length} 台关联服务器 · {rollback.topology.nodes.length} 个拓扑节点</Typography.Paragraph><div className="markdown-editor-grid"><div className="markdown-preview"><b>当前资料</b><BasicMarkdown text={current?.markdown ?? ''} /></div><div className="markdown-preview"><b>选中版本</b><BasicMarkdown text={rollback.markdown} /></div></div></>}</Modal>
    <Modal title={exportKind === 'system' ? exportRevision ? '导出版本资料' : '导出系统资料' : `导出拓扑 ${exportKind?.toUpperCase()}`} forceRender open={active && exportOpen} focusTriggerAfterClose={active} okText="导出" cancelText="取消" confirmLoading={busy} onCancel={() => setExportOpen(false)} afterClose={() => { if (!exportOpen) { setExportKind(undefined); setExportRevision(undefined); } }} onOk={() => void run(async () => { if (exportKind === 'system') await exportSystem(exportRevision); else if (exportKind) await exportTopology(exportKind); setExportOpen(false); })}>
      {exportKind === 'system' && <Checkbox checked={includeTopology} onChange={(event) => setIncludeTopology(event.target.checked)}>导出拓扑图</Checkbox>}
      {(exportKind !== 'system' || includeTopology) && <Space direction="vertical" className="full-width"><Typography.Text>拓扑图片背景</Typography.Text><Select open={active && exportOpen && backgroundOpen} onOpenChange={setBackgroundOpen} aria-label="拓扑导出背景" className="full-width" value={['#ffffff', '#eaf4e8', '#f3efe5'].includes(exportOptions.background) ? exportOptions.background : 'custom'} options={[{ value: '#ffffff', label: '纯白色' }, { value: '#eaf4e8', label: '淡绿色' }, { value: '#f3efe5', label: '暖灰色' }, { value: 'custom', label: '自定义颜色' }]} onChange={(background) => setExportOptions({ ...exportOptions, background: background === 'custom' ? '#dce8ef' : background })} /><label className="topology-color-picker">背景颜色 <input aria-label="导出自定义背景颜色" type="color" value={exportOptions.background} onInput={(event) => setExportOptions({ ...exportOptions, background: event.currentTarget.value })} /></label><Checkbox checked={exportOptions.grid} onChange={(event) => setExportOptions({ ...exportOptions, grid: event.target.checked })}>包含方格背景</Checkbox>{exportKind === 'system' && <Typography.Paragraph type="secondary">Markdown 与拓扑 PNG 存在同一目录，请一起保留。</Typography.Paragraph>}</Space>}
    </Modal>
    <Modal title="导入可编辑拓扑" forceRender open={active && importOpen} focusTriggerAfterClose={active} afterClose={() => { if (!importOpen) setImportText(''); }} okText="载入画布" cancelText="取消" onCancel={(event) => { if (!composingCancel(event)) setImportOpen(false); }} onOk={() => { try { if (!draft) return; editing.edit({ topology: parseTopology(importText) }); setImportOpen(false); } catch (error) { msg.error(error instanceof Error ? error.message : String(error)); } }}><Input.TextArea aria-label="拓扑JSON" rows={12} value={importText} onChange={(event) => setImportText(event.target.value)} placeholder="粘贴此前导出的拓扑 JSON" /></Modal>
    <Modal title="当前系统有未保存修改" open={active && pendingSelect !== undefined} focusTriggerAfterClose={active} okText="保存后切换" cancelText="继续编辑" onCancel={(event) => { if (!composingCancel(event)) setPendingSelect(undefined); }} footer={<Space><Button onClick={() => setPendingSelect(undefined)}>继续编辑</Button><Button disabled={busy} onClick={discardAndSwitch}>放弃修改并切换</Button><Button type="primary" icon={<SaveOutlined />} loading={busy} onClick={() => void run(saveAndSwitch)}>保存后切换</Button></Space>} />
  </div>;
}

export default memo(OperationsPage);
