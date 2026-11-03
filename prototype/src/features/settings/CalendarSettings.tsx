import { useEffect, useRef, useState } from 'react';
import { Button, Input, Space, message } from 'antd';
import { SaveOutlined } from '@ant-design/icons';
import { defaultSettings } from '../../model';
import { native } from '../../native';
import { parseCalendar } from '../reports/reportModel';
import type { WorkCalendar } from '../reports/types';

type Sources = { holidayCalendarUrl: string };
export default function CalendarSettings({ sources, onSaveSources }: {
  sources: Sources; onSaveSources: (value: Sources, holidays: WorkCalendar['holidays']) => Promise<void>;
}) {
  const [msg, context] = message.useMessage({ maxCount: 3 });
  const [draft, setDraft] = useState(sources);
  const [busy, setBusy] = useState(false);
  const request = useRef(0), running = useRef(false);
  useEffect(() => {
    request.current++; running.current = false; setBusy(false); setDraft(sources);
    return () => { request.current++; running.current = false; };
  }, [sources.holidayCalendarUrl]);
  const run = async (operation: (generation: number) => Promise<void>) => {
    if (running.current) return;
    const generation = ++request.current;
    running.current = true; setBusy(true);
    try { await operation(generation); }
    catch (error) { if (generation === request.current) msg.error(error instanceof Error ? error.message : String(error)); }
    finally { if (generation === request.current) { running.current = false; setBusy(false); } }
  };
  return <section className="settings-group">{context}<div className="settings-group-title">工作日历与节假日</div>
    <div className="settings-row settings-calendar-source"><b>节假日及调休接口</b><Input aria-label="节假日接口地址" value={draft.holidayCalendarUrl} disabled={busy} onChange={(event) => setDraft({ ...draft, holidayCalendarUrl: event.target.value })} />
    <Space><Button disabled={busy} onClick={() => setDraft({ holidayCalendarUrl: defaultSettings.holidayCalendarUrl })}>恢复默认地址</Button><Button type="primary" icon={<SaveOutlined />} loading={busy} disabled={busy} onClick={() => void run(async (generation) => {
      const next = { holidayCalendarUrl: draft.holidayCalendarUrl.trim() };
      let parsed: URL; try { parsed = new URL(next.holidayCalendarUrl); } catch { throw new Error('请输入有效的 HTTP/HTTPS 接口地址'); }
      if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error('接口只支持不含账号密码的 HTTP/HTTPS 地址');
      const imported = parseCalendar(await native.fetchCalendar(next.holidayCalendarUrl));
      if (generation !== request.current) return;
      await onSaveSources(next, imported.holidays);
      if (generation !== request.current) return;
      msg.success('日历接口与数据已保存');
    })}>保存接口</Button></Space></div>
  </section>;
}
