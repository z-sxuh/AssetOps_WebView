import { Alert, Button, Card, Form, Input, InputNumber, Modal, Space, Switch, Tag, Typography } from 'antd';
import { CloudDownloadOutlined } from '@ant-design/icons';
import Select from '../../components/AppSelect';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { KeyboardEvent } from 'react';

import { displayPath } from '../../model';
import type { Settings, VaultData } from '../../model';
import { hotkeyFromEvent } from '../../hotkeys';
import CalendarSettings from './CalendarSettings';
import type { WorkCalendar } from '../reports/types';
import { composingCancel } from '../../composition';
import { validateBackupCron } from '../../cron';
import { native } from '../../native';

const { Text, Title } = Typography;

const technologyStack = [
  '桌面框架：Rust · Tauri 2',
  '前端界面：React 18 · TypeScript 5 · Ant Design 5 · Ant Design Icons',
  '拓扑图：AntV X6 3.1.8',
  '富文本编辑：Tiptap 3 · ProseMirror · Markdown',
  '数据存储：SQLite · rusqlite',
  '加密与校验：AES-256-GCM · Argon2id · SHA-256 · hash-wasm · Web Crypto API',
  'Excel 处理：Calamine · rust_xlsxwriter',
  '日期与日历：Day.js · chinese-days',
  '数据与网络：Serde · serde_json · Reqwest',
  '压缩归档：ZIP · DEFLATE（zip · flate2）',
  '构建工具：Vite 6 · pnpm',
];

export type SettingsModel = {
  autoLockMinutes: 0 | 5 | 15 | 30 | 60;
  closeBehavior: 'tray' | 'exit';
  passwordWarningDays: number;
  searchHotkey: string;
  exportDirectory: string;
  holidayCalendarUrl: string;
  showPlainPasswords: boolean;
  exportPlainPasswords: boolean;
  theme: Settings['theme'];
  keepSearchQuery: boolean;
  startupBackup: boolean;
  beforeWriteBackup: boolean;
  backupDirectory: string;
  sidebarCollapsed: boolean;
  ledgerOnlySystem: boolean;
};

export type AppInfo = {
  version: string;
  dataDirectory: string;
  databasePath: string;
  backupDirectory?: string;
  exportDirectory?: string;
  databaseSize: number;
  journalMode: string;
  schemaVersion?: number;
  unlocked?: boolean;
};

type Props = {
  active?: boolean;
  snapshot: VaultData;
  value: SettingsModel;
  schedule: Pick<Settings, 'scheduledBackup' | 'scheduledBackupCron' | 'scheduledBackupIntervalHours'>;
  onSaveSchedule: (enabled: boolean, cron: string) => Promise<void>;
  info?: AppInfo;
  infoError?: string;
  infoLoading?: boolean;
  onRetryInfo: () => Promise<void>;
  onChange: (value: Partial<SettingsModel>) => void | Promise<void>;
  onSaveCalendarSources: (sources: Pick<SettingsModel, 'holidayCalendarUrl'>, holidays: WorkCalendar['holidays']) => Promise<void>;
  onChangePassword: (currentPassword: string, newPassword: string) => Promise<void>;
  onReinitialize: (newPassword: string) => Promise<void>;
  onBackupNow: () => Promise<void>;
  onChangeBackupDirectory: (newDirectory: string) => Promise<string>;
  onOpenDataDirectory: () => Promise<void>;
  onOpenBackupDirectory: () => Promise<void>;
  onOpenExportDirectory: () => Promise<void>;
};

export function SettingsPage({ active = true, snapshot, value: persistedValue, schedule, onSaveSchedule, info, infoError, infoLoading, onRetryInfo, onChange, onSaveCalendarSources, onChangePassword, onReinitialize, onBackupNow, onChangeBackupDirectory, onOpenDataDirectory, onOpenBackupDirectory, onOpenExportDirectory }: Props) {
  const [autostart, setAutostart] = useState<boolean>();
  const [autostartBusy, setAutostartBusy] = useState(false);
  const [autostartError, setAutostartError] = useState('');
  const autostartRequest = useRef(0);
  const syncAutostart = useCallback(async (enabled?: boolean) => {
    const request = ++autostartRequest.current;
    setAutostartBusy(true); setAutostartError('');
    try {
      const actual = await (enabled === undefined ? native.autostartEnabled() : native.setAutostart(enabled));
      if (request === autostartRequest.current) setAutostart(actual);
    } catch (reason) {
      if (request === autostartRequest.current) setAutostartError(reason instanceof Error ? reason.message : String(reason));
    } finally { if (request === autostartRequest.current) setAutostartBusy(false); }
  }, []);
  useEffect(() => {
    if (active && native.desktop) void syncAutostart();
    return () => { autostartRequest.current++; };
  }, [active, syncAutostart]);
  const [pendingSettings, setPendingSettings] = useState<Partial<SettingsModel>>({});
  const hasPendingSettings = Object.keys(pendingSettings).length > 0;
  const footerSlot = active && hasPendingSettings ? document.getElementById('footer-storage-slot') : null;
  const value = { ...persistedValue, ...pendingSettings };
  const pendingPatch = useRef<Partial<SettingsModel>>({});
  const patchTimer = useRef<ReturnType<typeof setTimeout>>();
  const patchRunning = useRef(false);
  const [patchSaving, setPatchSaving] = useState(false);
  const [patchError, setPatchError] = useState('');
  const changeRef = useRef(onChange); changeRef.current = onChange;
  useEffect(() => () => clearTimeout(patchTimer.current), []);
  const flushPatch = async () => {
    if (patchRunning.current || !Object.keys(pendingPatch.current).length) return;
    const next = pendingPatch.current; pendingPatch.current = {};
    patchRunning.current = true; setPatchSaving(true); setPatchError('');
    try {
      await changeRef.current(next);
      setPendingSettings({ ...pendingPatch.current });
    } catch (reason) {
      pendingPatch.current = {}; setPendingSettings({});
      setPatchError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      patchRunning.current = false; setPatchSaving(false);
      if (Object.keys(pendingPatch.current).length) void flushPatch();
    }
  };
  const [feedback, setFeedback] = useState<{ type: 'error' | 'success'; title: string; content: string }>();
  const [passwordForm] = Form.useForm<{ currentPassword: string; newPassword: string; confirmPassword: string }>();
  const passwordSaving = useRef(false);
  const [passwordOpen, setPasswordOpen] = useState(false);
  const [resetOpen, setResetOpen] = useState(false);
  const [backingUp, setBackingUp] = useState(false);
  const [backupSnapshot, setBackupSnapshot] = useState<VaultData>();
  const resetSession = useRef(0);
  useEffect(() => () => { resetSession.current++; }, []);
  const backupDone = backupSnapshot === snapshot;
  const backupStale = Boolean(backupSnapshot && !backupDone);
  const [resetPassword, setResetPassword] = useState('');
  const [dangerText, setDangerText] = useState('');
  const [backupDirectoryOpen, setBackupDirectoryOpen] = useState(false);
  const [backupPath, setBackupPath] = useState('');
  const [busy, setBusy] = useState(false);
  const [exportDirectoryOpen, setExportDirectoryOpen] = useState(false);
  const [exportPath, setExportPath] = useState('');
  const [hotkeyField, setHotkeyField] = useState<'searchHotkey' | null>(null);
  const [hotkeyDraft, setHotkeyDraft] = useState('');
  const [hotkeyError, setHotkeyError] = useState('');
  const [savingHotkey, setSavingHotkey] = useState(false);
  const [warningDays, setWarningDays] = useState<number | null>(value.passwordWarningDays);
  const warningBaseline = useRef(value.passwordWarningDays);
  const warningSaving = useRef(false);
  const [savingWarning, setSavingWarning] = useState(false);
  const [warningError, setWarningError] = useState('');
  useEffect(() => {
    const previous = warningBaseline.current; warningBaseline.current = value.passwordWarningDays;
    setWarningDays(current => current === previous ? value.passwordWarningDays : current);
  }, [value.passwordWarningDays]);
  const saveWarningDays = async () => {
    if (warningSaving.current || warningDays === value.passwordWarningDays) return;
    if (warningDays === null || !Number.isInteger(warningDays) || warningDays < 1 || warningDays > 365) { setWarningError('请输入1–365之间的整数'); return; }
    warningSaving.current = true; setSavingWarning(true); setWarningError('');
    try { await onChange({ passwordWarningDays: warningDays }); }
    catch (reason) { setWarningError(reason instanceof Error ? reason.message : String(reason)); }
    finally { warningSaving.current = false; setSavingWarning(false); }
  };
  const [scheduleEnabled, setScheduleEnabled] = useState(schedule.scheduledBackup);
  const [cron, setCron] = useState(schedule.scheduledBackupCron || '0 */8 * * *');
  const [savingSchedule, setSavingSchedule] = useState(false);
  const scheduleSaving = useRef(false);
  const [scheduleError, setScheduleError] = useState('');
  const [settingsPopup, setSettingsPopup] = useState<'lock' | 'close'>();
  useLayoutEffect(() => { if (!active) setSettingsPopup(undefined); }, [active]);
  useEffect(() => { setScheduleEnabled(schedule.scheduledBackup); setCron(schedule.scheduledBackupCron || '0 */8 * * *'); }, [schedule.scheduledBackup, schedule.scheduledBackupCron]);
  const saveSchedule = async (enabled: boolean) => {
    if (scheduleSaving.current || (enabled === schedule.scheduledBackup && cron.trim() === schedule.scheduledBackupCron)) return;
    let expression: string;
    try { expression = validateBackupCron(cron); }
    catch (reason) { setScheduleError(reason instanceof Error ? reason.message : String(reason)); return; }
    const previous = scheduleEnabled;
    scheduleSaving.current = true; setSavingSchedule(true); setScheduleError(''); setScheduleEnabled(enabled);
    try { await onSaveSchedule(enabled, expression); setCron(expression); }
    catch (reason) { setScheduleEnabled(previous); setScheduleError(reason instanceof Error ? reason.message : String(reason)); }
    finally { scheduleSaving.current = false; setSavingSchedule(false); }
  };
  const showError = (reason: unknown) => { setFeedback({ type: 'error', title: '操作失败', content: reason instanceof Error ? reason.message : String(reason) }); };
  const openReset = () => { resetSession.current++; setBackupSnapshot(undefined); setBackingUp(false); setResetOpen(true); };
  const closeReset = () => { resetSession.current++; setResetOpen(false); setBackupSnapshot(undefined); };
  const backupBeforeReset = async () => {
    const request = resetSession.current; const expected = snapshot;
    setBackingUp(true);
    try { await onBackupNow(); if (request === resetSession.current) setBackupSnapshot(expected); }
    catch (reason) { if (request === resetSession.current) showError(reason); }
    finally { if (request === resetSession.current) setBackingUp(false); }
  };
  const savePassword = async (values: { currentPassword: string; newPassword: string }) => {
    if (passwordSaving.current) return;
    passwordSaving.current = true; setBusy(true);
    try { await onChangePassword(values.currentPassword, values.newPassword); setPasswordOpen(false); }
    catch (reason) { showError(reason); }
    finally { passwordSaving.current = false; setBusy(false); }
  };
  const patch = (next: Partial<SettingsModel>) => { pendingPatch.current = { ...pendingPatch.current, ...next }; setPendingSettings((current) => ({ ...current, ...next })); clearTimeout(patchTimer.current); patchTimer.current = setTimeout(() => void flushPatch(), 150); };
  const recordHotkey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Tab') return;
    event.preventDefault();
    event.stopPropagation();
    if (event.key === 'Backspace' || event.key === 'Delete') { setHotkeyDraft(''); setHotkeyError(''); return; }
    if (['Control', 'Shift', 'Alt', 'Meta', 'Escape'].includes(event.key)) return;
    const combination = hotkeyFromEvent(event);
    if (!combination) { setHotkeyError('支持单独的 F1–F24，或 Ctrl、Alt、Win 加字母、数字、方向键等组合。'); return; }
    setHotkeyDraft(combination);
    setHotkeyError('');
  };
  const formatBytes = (bytes = 0) => bytes < 1024 ? `${Math.max(0, bytes)} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;

  return <div className="page-content module-page settings-page" data-exit-dirty={hasPendingSettings || undefined}>
    <div className="page-heading"><div><Title level={2}>系统设置</Title></div></div>
    {infoError && <Alert type="warning" showIcon message="应用信息读取失败" description={infoError} action={<Button size="small" loading={infoLoading} onClick={() => void onRetryInfo()}>重试读取信息</Button>} />}

    {patchError && <Alert type="error" showIcon message="设置未保存" description={patchError} />}
    {footerSlot && createPortal(<Text type="secondary" role="status">正在保存设置…</Text>, footerSlot)}
    <section className="settings-group"><div className="settings-group-title">启动与安全</div>
      <div className="settings-row"><b>开机自启动</b><div className="settings-row-copy"><span>{native.desktop ? '登录 Windows 后自动启动工作台' : '仅支持 Windows 桌面应用'}</span>{autostartError && <Text type="danger" role="alert">{autostartError} <Button type="link" size="small" disabled={autostartBusy} onClick={() => void syncAutostart()}>重试读取</Button></Text>}</div><Switch aria-label="开机自启动" checked={autostart ?? false} loading={autostartBusy} disabled={!native.desktop || autostartBusy || autostart === undefined || busy} onChange={enabled => void syncAutostart(enabled)} /></div>
      <div className="settings-row"><b>自动锁屏</b><div className="settings-row-copy"><span>空闲超过设定时间后清除解锁密钥</span></div><Select disabled={patchSaving} aria-label="自动锁屏" open={active && settingsPopup === 'lock'} onOpenChange={(open) => setSettingsPopup(open ? 'lock' : undefined)} value={value.autoLockMinutes} className="settings-select" options={[0, 5, 15, 30, 60].map((minutes) => ({ value: minutes, label: minutes ? `${minutes} 分钟` : '关闭' }))} onChange={(autoLockMinutes) => patch({ autoLockMinutes })} /></div>
      <div className="settings-row"><b>关闭按钮行为</b><div className="settings-row-copy"><span>关闭主窗口时退出应用或隐藏到系统托盘</span></div><Select disabled={patchSaving} aria-label="关闭按钮行为" open={active && settingsPopup === 'close'} onOpenChange={(open) => setSettingsPopup(open ? 'close' : undefined)} value={value.closeBehavior} className="settings-select" options={[{ value: 'exit', label: '退出应用' }, { value: 'tray', label: '隐藏到托盘' }]} onChange={(closeBehavior) => patch({ closeBehavior })} /></div>
      <div className="settings-row"><b>修改主密码</b><div className="settings-row-copy"><span>当前数据和可用当前密码打开的备份将用新密码重新加密</span></div><Button className="settings-security-action" onClick={() => setPasswordOpen(true)}>修改</Button></div>
      <div className="settings-row"><b>重新初始化</b><div className="settings-row-copy"><span>清空当前数据并创建新的加密数据仓库</span></div><Button className="settings-security-action" danger onClick={openReset}>重新初始化</Button></div>
    </section>

    <section className="settings-group"><div className="settings-group-title">资产台账</div>
      <div className="settings-row"><b>仅显示系统级资产</b><div className="settings-row-copy"><span>关闭后可在单位、环境和网络区域汇总查看下属资产</span></div><Switch disabled={patchSaving} aria-label="仅显示系统级资产" checked={value.ledgerOnlySystem} onChange={(ledgerOnlySystem) => patch({ ledgerOnlySystem })} /></div>
    </section>
    <section className="settings-group"><div className="settings-group-title">密码与搜索</div>
      <div className="settings-row"><b>明文显示密码</b><div className="settings-row-copy"><span>在台账密码列直接显示当前账号密码</span></div><Switch disabled={patchSaving} aria-label="明文显示密码" checked={value.showPlainPasswords} onChange={(showPlainPasswords) => patch({ showPlainPasswords })} /></div>
      <div className="settings-row"><b>导出包含明文</b><div className="settings-row-copy"><span>作为资产导出的默认选项；关闭时运维资料的账号密码与自定义字段值均遮蔽</span></div><Switch disabled={patchSaving} aria-label="导出包含明文" checked={value.exportPlainPasswords} onChange={(exportPlainPasswords) => patch({ exportPlainPasswords })} /></div>
      <div className="settings-row"><b>密码到期提醒</b><div className="settings-row-copy"><span>提前指定天数在首页显示账号密码提醒</span>{warningError && <Text type="danger" role="alert">{warningError}</Text>}</div><Space size={6}><InputNumber aria-label="密码到期提醒天数" className="settings-number" min={1} max={365} precision={0} addonAfter="天" disabled={savingWarning} value={warningDays} onChange={days => { setWarningDays(days); setWarningError(''); }} onKeyDown={event => { if (event.key === 'Enter' && !composingCancel(event)) { event.preventDefault(); void saveWarningDays(); } }} /><Button aria-label="保存密码到期提醒天数" loading={savingWarning} disabled={warningDays === value.passwordWarningDays} onClick={() => void saveWarningDays()}>保存</Button></Space></div>
      <div className="settings-row"><b>保留搜索词</b><div className="settings-row-copy"><span>关闭应用内搜索后保留上次查询；桌面搜索每次唤起从空白开始</span></div><Switch disabled={patchSaving} aria-label="保留搜索词" checked={value.keepSearchQuery} onChange={(keepSearchQuery) => patch({ keepSearchQuery })} /></div>
      <div className="settings-row"><b>快捷键</b><div className="settings-row-copy"><span>搜索支持 Windows 桌面与托盘唤起；</span></div><div className="settings-hotkeys"><label>全局搜索<Button className="settings-hotkey" aria-label="修改搜索快捷键" onClick={() => { setHotkeyField('searchHotkey'); setHotkeyDraft(value.searchHotkey); setHotkeyError(''); }}>{value.searchHotkey || '未启用'} <span>修改</span></Button></label></div></div>
    </section>

    <section className="settings-group"><div className="settings-group-title">备份策略</div>
      <div className="settings-row settings-schedule-row"><b>定时备份</b><div className="settings-row-copy"><span>格式为cron表达式</span>{!schedule.scheduledBackupCron && <small>当前沿用每 {schedule.scheduledBackupIntervalHours} 小时间隔，修改后采用 cron</small>}{scheduleError && <Text type="danger" role="alert">{scheduleError}</Text>}</div><div className="settings-schedule-controls" onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) void saveSchedule(scheduleEnabled); }}>
        <Input className="settings-cron-input" aria-label="定时备份crontab" value={cron} disabled={savingSchedule} status={scheduleError ? 'error' : undefined} maxLength={160} placeholder="0 */8 * * *" onChange={(event) => { setCron(event.target.value); setScheduleError(''); }} onPressEnter={(event) => { if (!composingCancel(event)) { event.preventDefault(); void saveSchedule(scheduleEnabled); } }} />
        <Switch disabled={patchSaving} aria-label="启用定时备份" checked={scheduleEnabled} loading={savingSchedule} onChange={(enabled) => void saveSchedule(enabled)} />
      </div></div>
      <div className="settings-row"><b>启动时备份</b><div className="settings-row-copy"><span>每天首次解锁后创建一份启动备份</span></div><Switch disabled={patchSaving} aria-label="启动时备份" checked={value.startupBackup} onChange={(startupBackup) => patch({ startupBackup })} /></div>
      <div className="settings-row"><b>重要写操作前备份</b><div className="settings-row-copy"><span>导入、结构变更和批量操作前自动备份</span></div><Switch disabled={patchSaving} aria-label="重要写操作前备份" checked={value.beforeWriteBackup} onChange={(beforeWriteBackup) => patch({ beforeWriteBackup })} /></div>
      <div className="settings-row"><b>备份目录</b><div className="settings-row-copy"><span className="mono">{info?.backupDirectory ? displayPath(info.backupDirectory) : '桌面应用启动后显示'}</span></div><Space className="settings-directory-actions"><Button onClick={() => void onOpenBackupDirectory().catch(showError)}>打开</Button><Button onClick={() => { setBackupPath(''); setBackupDirectoryOpen(true); }}>更改</Button></Space></div>
    </section>

    <CalendarSettings sources={{ holidayCalendarUrl: value.holidayCalendarUrl }} onSaveSources={onSaveCalendarSources} />

    <section className="settings-group"><div className="settings-group-title">数据与关于</div>
      <div className="settings-row"><b>导出目录</b><div className="settings-row-copy"><span className="mono">{displayPath(value.exportDirectory || info?.exportDirectory || '当前用户的下载目录')}</span></div><Space><Button onClick={() => void onOpenExportDirectory().catch(showError)}>打开</Button><Button onClick={() => { setExportPath(value.exportDirectory); setExportDirectoryOpen(true); }}>更改</Button></Space></div>
      <div className="settings-row"><b>数据目录</b><div className="settings-row-copy"><span className="mono">{info?.dataDirectory ? displayPath(info.dataDirectory) : '桌面应用启动后显示'}</span></div><Button onClick={() => void onOpenDataDirectory().catch(showError)}>打开</Button></div>
      <div className="settings-row settings-row-database"><b>数据库</b><div className="settings-row-copy settings-row-database-copy"><span className="mono">{info?.databasePath ? displayPath(info.databasePath) : infoLoading ? '读取中…' : '—'}</span><Space size={6}><Tag color="green">{info?.databaseSize === undefined ? '—' : formatBytes(info.databaseSize)}</Tag><Tag color="green">AES-256-GCM</Tag></Space></div></div>
      <div className="settings-row settings-row-about"><b>版本与运行环境</b><div className="settings-row-copy"><Tag color="green" className="app-version-tag">工作台 {info?.version ?? (infoLoading ? '读取中…' : '—')}</Tag><Tag color="green" className="app-version-tag">Windows x64</Tag><Tag color="green" className="app-version-tag">WebView2</Tag></div></div>
      <div className="settings-row settings-row-about"><b>技术栈</b><div className="settings-row-copy">{technologyStack.map(technology => <Tag key={technology} color="green" className="app-version-tag">{technology}</Tag>)}</div></div>
    </section>

    <Modal title="修改搜索快捷键" open={active && Boolean(hotkeyField)} focusTriggerAfterClose={active} okText="保存" cancelText="取消" confirmLoading={savingHotkey} onCancel={(event) => { if (!savingHotkey && !composingCancel(event)) setHotkeyField(null); }} onOk={async () => {
      if (!hotkeyField) return;
      setSavingHotkey(true);
      try { await onChange({ [hotkeyField]: hotkeyDraft }); setHotkeyField(null); }
      catch (reason) { setHotkeyError(reason instanceof Error ? reason.message : String(reason)); }
      finally { setSavingHotkey(false); }
    }}>
      <Space direction="vertical" style={{ width: '100%' }} size={12}>
        <Text type="secondary">点击输入框，按下 F1–F24 或新的组合键。Backspace／Delete 可清空，保存空值后禁用。</Text>
        <Input key={hotkeyField} autoFocus readOnly disabled={savingHotkey} aria-label="录入快捷键" data-hotkey-recorder value={hotkeyDraft} placeholder="按下功能键或组合键" onKeyDown={recordHotkey} />
        <Button size="small" disabled={savingHotkey} onClick={() => { setHotkeyDraft(''); setHotkeyError(''); }}>清空快捷键</Button>
        {hotkeyError && <Alert type="error" showIcon message={hotkeyError} />}
      </Space>
    </Modal>

    <Modal title="更改导出目录" open={active && exportDirectoryOpen} focusTriggerAfterClose={active} confirmLoading={busy} okText="保存" cancelText="取消" onCancel={(event) => { if (!busy && !composingCancel(event)) setExportDirectoryOpen(false); }} onOk={async () => { setBusy(true); try { await onChange({ exportDirectory: exportPath.trim() }); setExportDirectoryOpen(false); } catch (reason) { showError(reason); } finally { setBusy(false); } }}>
      <Text type="secondary">所有文件导出使用此目录。留空恢复当前用户的下载目录。</Text><Input aria-label="导出目录" value={exportPath} onChange={(event) => setExportPath(event.target.value)} placeholder="文件夹的完整绝对路径" style={{ marginTop: 14 }} /><Button style={{ marginTop: 12 }} onClick={() => setExportPath('')}>恢复下载目录</Button>
    </Modal>

    <Modal className="settings-modal" title="更改备份目录" open={active && backupDirectoryOpen} focusTriggerAfterClose={active} confirmLoading={busy} okText="复制并切换" cancelText="取消" okButtonProps={{ disabled: !backupPath.trim() }} onCancel={(event) => { if (!busy && !composingCancel(event)) setBackupDirectoryOpen(false); }} onOk={async () => {
      setBusy(true); try { const path = await onChangeBackupDirectory(backupPath.trim()); setBackupDirectoryOpen(false); setBackupPath(''); setFeedback({ type: 'success', title: '备份目录已切换', content: `后续备份存放于 ${displayPath(path)}。原目录中的文件已保留。` }); } catch (reason) { showError(reason); } finally { setBusy(false); }
    }}>
      <Text type="secondary">请输入目标文件夹的完整绝对路径；已有备份会复制并校验后切换。</Text>
      <Input value={backupPath} onChange={(event) => setBackupPath(event.target.value)} style={{ marginTop: 14 }} />
    </Modal>

    <Modal className="settings-modal" title="修改主密码" open={active && passwordOpen} focusTriggerAfterClose={active} confirmLoading={busy} okText="重新加密" cancelText="取消" onCancel={(event) => { if (!busy && !composingCancel(event)) setPasswordOpen(false); }} afterClose={() => { if (!passwordOpen) passwordForm.resetFields(); }} onOk={() => passwordForm.submit()}>
      <Form form={passwordForm} layout="vertical" onFinish={savePassword} onFinishFailed={({ errorFields }) => passwordForm.getFieldInstance(errorFields[0]?.name)?.focus()} onKeyDown={(event) => { if (event.key === 'Enter' && !composingCancel(event)) { event.preventDefault(); passwordForm.submit(); } }}>
        <Form.Item name="currentPassword" label="当前主密码" rules={[{ required: true, message: '请输入当前主密码' }]}><Input.Password autoComplete="current-password" /></Form.Item>
        <Form.Item name="newPassword" label="新主密码" rules={[{ required: true, message: '请输入新主密码' }]}><Input.Password autoComplete="new-password" /></Form.Item>
        <Form.Item name="confirmPassword" label="再次输入新主密码" dependencies={['newPassword']} rules={[{ required: true, message: '请再次输入新主密码' }, ({ getFieldValue }) => ({ validator: (_, value) => !value || getFieldValue('newPassword') === value ? Promise.resolve() : Promise.reject(new Error('两次输入必须一致。')) })]}><Input.Password autoComplete="new-password" /></Form.Item>
      </Form>
    </Modal>

    <Modal className="settings-modal" title="重新初始化数据仓库" open={active && resetOpen} focusTriggerAfterClose={active} confirmLoading={busy} okText="清空并重新初始化" okButtonProps={{ danger: true, disabled: dangerText !== '重新初始化' || !resetPassword }} cancelText="取消" onCancel={(event) => { if (!busy && !composingCancel(event)) closeReset(); }} onOk={async () => {
      setBusy(true); try { await onReinitialize(resetPassword); closeReset(); setDangerText(''); setResetPassword(''); } catch (reason) { showError(reason); } finally { setBusy(false); }
    }}>
      <Card size="small"><Text type="danger">全部单位、系统、资产、历史、工作报告与运维资料都会被清空。已有备份保留原文件与原主密码，不会改写或删除。</Text></Card>
      <div style={{ marginTop: 10 }}><Button size="small" icon={<CloudDownloadOutlined />} loading={backingUp} disabled={backupDone} onClick={() => void backupBeforeReset()}>{backupDone ? '已备份 ✓' : '先创建一份备份'}</Button>{backupStale && <Text type="warning" role="status"> 数据已更新，请重新备份</Text>}</div>
      <Space direction="vertical" className="full-width" style={{ marginTop: 12 }}><Input value={dangerText} onChange={(event) => setDangerText(event.target.value)} placeholder="输入“重新初始化”确认" /><Input.Password value={resetPassword} onChange={(event) => setResetPassword(event.target.value)} placeholder="设置新的主密码" /><Text type="warning" style={{ fontSize: 12 }}>应用不强制密码强度，建议使用复杂密码并妥善保管。</Text></Space>
    </Modal>
    <Modal title={feedback?.title} open={active && Boolean(feedback)} focusTriggerAfterClose={active} onCancel={() => setFeedback(undefined)} footer={<Button type="primary" onClick={() => setFeedback(undefined)}>知道了</Button>}><Alert showIcon type={feedback?.type} message={feedback?.content} /></Modal>
  </div>;
}
