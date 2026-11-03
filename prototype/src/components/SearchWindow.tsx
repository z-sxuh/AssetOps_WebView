import { ConfigProvider } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import { createAppTheme } from '../appTheme';
import { emitTo, listen } from '@tauri-apps/api/event';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { GlobalSearch, type SearchItem } from './GlobalSearch';
import { native } from '../native';
import type { Settings, Unit } from '../model';
import type { QuickEntryInput, SearchInsertResult } from '../features/reports/quickEntry';

export type SearchSnapshot = { items: SearchItem[]; units: Unit[]; query: string; theme: Exclude<Settings['theme'], 'system'>; hotkey: string; request: number };

export default function SearchWindow() {
  const [snapshot, setSnapshot] = useState<SearchSnapshot>();
  const [error, setError] = useState('');
  const [insertStatus, setInsertStatus] = useState('');
  const [retry, setRetry] = useState(0);
  const errorAction = useRef<'connect' | 'close'>('connect');
  const appTheme = useMemo(() => createAppTheme(snapshot?.theme ?? 'light'), [snapshot?.theme]);
  const contentRef = useRef<HTMLDivElement>(null);
  const sessionRef = useRef({ request: -1, closed: true });
  const pending = useRef<{ token: string; request: number; timer: number; resolve: () => void; reject: (reason: Error) => void }>();
  const clear = useCallback(() => {
    sessionRef.current.closed = true;
    if (pending.current) { window.clearTimeout(pending.current.timer); pending.current.reject(new Error('搜索已关闭')); }
    pending.current = undefined; setInsertStatus(''); setSnapshot(undefined); errorAction.current = 'connect';
  }, []);
  const insert = (input: QuickEntryInput) => new Promise<void>((resolve, reject) => {
    const session = sessionRef.current;
    if (session.closed || pending.current) { reject(new Error('搜索已关闭或正在保存')); return; }
    const token = crypto.randomUUID();
    const timer = window.setTimeout(() => { if (pending.current?.token === token) setInsertStatus('保存结果尚未确认，请核对保存结果；也可关闭后到工作记录核对，请勿重复新增。'); }, 8000);
    pending.current = { token, request: session.request, timer, resolve, reject };
    void emitTo('main', 'assetops-search-insert', { ...input, request: session.request, token }).catch(() => { if (pending.current?.token === token) setInsertStatus('无法确认保存结果，请核对保存结果；也可关闭后到工作记录核对，请勿重复新增。'); });
  });
  const checkInsert = () => {
    const current = pending.current;
    if (!current || sessionRef.current.closed) return;
    setInsertStatus('正在核对保存结果；若仍未确认，可再次核对，或关闭后到工作记录核对。');
    void emitTo('main', 'assetops-search-insert', { request: current.request, token: current.token, statusOnly: true }).catch(() => {
      if (pending.current === current) setInsertStatus('无法核对保存结果，请重试核对，或关闭后到工作记录核对，请勿重复新增。');
    });
  };
  const close = useCallback(() => {
    const request = sessionRef.current.request;
    clear();
    void native.closeSearchWindow().then(() => { if (sessionRef.current.request === request && sessionRef.current.closed) setError(''); }).catch(() => {
      if (sessionRef.current.request === request && sessionRef.current.closed) { errorAction.current = 'close'; setError('无法关闭搜索窗口，请重试关闭或按 Esc 重试'); }
    });
  }, [clear]);
  useLayoutEffect(() => {
    document.body.classList.add('search-window');
    return () => document.body.classList.remove('search-window');
  }, []);
  useEffect(() => {
    let disposed = false;
    const releases: Array<() => void> = [];
    const attach = async <T,>(name: string, handler: (event: { payload: T }) => void) => {
      const release = await listen<T>(name, handler);
      if (disposed) release(); else releases.push(release);
    };
    const subscribe = async () => {
      await attach<number>('assetops-search-begin', ({ payload }) => {
        if (payload > sessionRef.current.request) { clear(); sessionRef.current = { request: payload, closed: false }; }
      });
      await attach<SearchSnapshot>('assetops-search-state', ({ payload }) => {
        const session = sessionRef.current;
        if (payload.request !== session.request || session.closed) return;
        setError('');
        setSnapshot((current) => current?.request === payload.request ? { ...payload, query: current.query } : payload);
      });
      await attach<number | null>('assetops-search-clear', ({ payload }) => {
        if (payload !== null && typeof payload === 'number') {
          if (payload < sessionRef.current.request) return;
          sessionRef.current.request = payload;
        }
        clear();
      });
      await attach<SearchInsertResult>('assetops-search-insert-result', ({ payload }) => {
        const current = pending.current;
        if (!current || payload.token !== current.token || payload.request !== current.request) return;
        window.clearTimeout(current.timer); setInsertStatus('');
        pending.current = undefined;
        if (payload.error) current.reject(new Error(payload.error)); else current.resolve();
      });
      if (!disposed) await emitTo('main', 'assetops-search-ready');
    };
    void subscribe().catch(() => { if (!disposed) { clear(); setError('搜索服务连接失败，请重试'); } releases.splice(0).forEach((release) => release()); });
    return () => { disposed = true; releases.forEach((release) => release()); if (pending.current) { window.clearTimeout(pending.current.timer); pending.current.reject(new Error('搜索已关闭')); } pending.current = undefined; };
  }, [clear, retry]);
  useLayoutEffect(() => {
    if (!snapshot) return;
    document.documentElement.dataset.theme = snapshot.theme;
  }, [snapshot?.theme]);
  useLayoutEffect(() => {
    const content = contentRef.current;
    if (!snapshot || !content) return;
    let disposed = false;
    const fail = (text: string) => { if (!disposed && !sessionRef.current.closed) setError(text); };
    let height = Math.ceil(content.getBoundingClientRect().height);
    void native.showSearchWindow(height).catch(() => fail('无法显示搜索窗口，请重试'));
    const observer = new ResizeObserver(() => {
      const next = Math.ceil(content.getBoundingClientRect().height);
      if (next === height) return;
      height = next;
      void native.resizeSearchWindow(height).catch(() => fail('无法调整搜索窗口，请重试'));
    });
    observer.observe(content);
    return () => { disposed = true; observer.disconnect(); };
  }, [snapshot?.request, retry]);
  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (error && event.key === 'Escape' && !event.isComposing) { event.preventDefault(); close(); return; }
      if (snapshot) void emitTo('main', 'assetops-search-activity');
    };
    window.addEventListener('keydown', handleKey, true);
    return () => window.removeEventListener('keydown', handleKey, true);
  }, [snapshot?.request, error, close]);
  return <ConfigProvider locale={zhCN} wave={{ disabled: true }} theme={appTheme}>
    <div ref={contentRef}>{error ? <div className="search-window-error" role="alert"><span>{error}</span><button type="button" onClick={() => { if (errorAction.current === 'close') close(); else { setError(''); setRetry((value) => value + 1); } }}>重试</button><button type="button" onClick={close}>关闭</button></div> : snapshot && <GlobalSearch standalone feedback={insertStatus && <div className="search-window-error" role="status"><span>{insertStatus}</span><button type="button" onClick={checkInsert}>核对保存结果</button><button type="button" onClick={close}>关闭</button></div>} items={snapshot.items} units={snapshot.units} onInsert={insert} onScopeOpen={async (extraHeight) => { const height = contentRef.current?.getBoundingClientRect().height ?? 220; const request = sessionRef.current.request; await native.resizeSearchWindow(Math.ceil(height + extraHeight)).catch(() => { if (sessionRef.current.request === request && !sessionRef.current.closed) setError('无法调整搜索窗口，请重试'); }); }} open query={snapshot.query} hotkey={snapshot.hotkey} focusRequest={snapshot.request} onOpen={() => {}} onClose={close} onHome={() => { void emitTo('main', 'assetops-search-home'); close(); }}
      onQueryChange={(query) => { setSnapshot((current) => current ? { ...current, query } : current); void emitTo('main', 'assetops-search-query', query); }}
      onOpenItem={(item) => { void emitTo('main', 'assetops-search-select', { id: item.id, type: item.type }); close(); }} />}</div>
  </ConfigProvider>;
}
