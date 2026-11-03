import { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Button, Dropdown, Input, Modal, Space, Typography, message } from 'antd';
import { ApartmentOutlined, UploadOutlined } from '@ant-design/icons';
import { displayPath, type Unit } from '../../model';
import { native } from '../../native';
import { exportOrganization, mergeOrganization, parseOrganization, type DirectoryUnit } from './organizationDirectory';
import { composingCancel } from '../../composition';

export default function OrganizationTransfer({ active = true, units, disabled, onImport }: { active?: boolean; units: Unit[]; disabled?: boolean; onImport: (incoming: DirectoryUnit[]) => Promise<void> }) {
  const [msg, context] = message.useMessage({ maxCount: 3 }); const [open, setOpen] = useState(false); const [text, setText] = useState(''); const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null); const generation = useRef(0); const running = useRef(false);
  useEffect(() => () => { generation.current++; }, []);
  useEffect(() => { if (!active) { generation.current++; setOpen(false); } }, [active]);
  const preview = useMemo(() => {
    if (!text.trim()) return undefined;
    try { const incoming = parseOrganization(text); return { incoming, count: mergeOrganization(units, incoming).added.length }; }
    catch (error) { return { error: error instanceof Error ? error.message : String(error) }; }
  }, [text, units]);
  const close = () => { if (!running.current) { generation.current++; setOpen(false); } };
  const run = async (operation: () => Promise<void>) => {
    if (running.current) return; running.current = true; setBusy(true);
    try { await operation(); } catch (error) { msg.error(error instanceof Error ? error.message : String(error)); }
    finally { running.current = false; setBusy(false); }
  };
  return <>{context}<Dropdown trigger={['click']} disabled={disabled || busy} menu={{ items: [{ key: 'import', label: '导入组织目录 JSON' }, { key: 'export', label: '导出组织目录 JSON' }], onClick: ({ key }) => {
    if (key === 'import') { generation.current++; setText(''); setOpen(true); }
    else void run(async () => { const path = await native.exportDocument('组织目录', 'json', exportOrganization(units)); msg.success({ content: <Space><span>组织目录已导出：{displayPath(path)}</span><Button type="link" size="small" onClick={() => void native.revealInFolder(path)}>打开目录</Button></Space>, duration: 8 }); });
  } }}><Button size="small" icon={<ApartmentOutlined />} aria-label="导入导出组织目录 JSON" title="导入导出组织目录 JSON" /></Dropdown>
    <Modal title="导入组织目录" open={active && open} focusTriggerAfterClose={active} onCancel={(event) => { if (!composingCancel(event)) close(); }} afterClose={() => setText('')} okText="合并导入" cancelText="取消" confirmLoading={busy} okButtonProps={{ disabled: !preview || 'error' in preview || !preview.count }} onOk={() => void run(async () => { if (!preview || 'error' in preview) return; await onImport(preview.incoming); generation.current++; setOpen(false); msg.success('组织目录已合并导入'); })}>
      <Space direction="vertical" className="full-width"><Typography.Text>按单位／环境／区域／系统完整路径合并，新增系统的字段需导入模板并保存。已有目录、服务器资产和系统资料继续保留。</Typography.Text>
        <Button icon={<UploadOutlined />} disabled={busy} onClick={() => input.current?.click()}>选择组织目录 JSON</Button>
        <input ref={input} type="file" accept=".json,application/json" hidden onChange={(event) => {
          const file = event.target.files?.[0]; event.target.value = ''; if (!file) return;
          const ticket = ++generation.current;
          void run(async () => { if (file.size > 2 * 1024 * 1024) throw new Error('组织目录文件不能超过 2 MB'); const content = await file.text(); if (ticket !== generation.current) return; parseOrganization(content); setText(content); });
        }} />
        <Input.TextArea aria-label="组织目录JSON" rows={10} value={text} disabled={busy} onChange={(event) => { generation.current++; setText(event.target.value); }} placeholder="也可粘贴此前导出的组织目录 JSON" />
        {preview && ('error' in preview ? <Alert type="error" showIcon message={preview.error} /> : <Alert type={preview.count ? 'info' : 'success'} showIcon message={preview.count ? `将新增 ${preview.count} 个目录节点` : '所有目录已存在，无需重复导入'} />)}
      </Space>
    </Modal></>;
}
