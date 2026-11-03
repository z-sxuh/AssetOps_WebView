import { ApartmentOutlined, AppstoreOutlined, CloudServerOutlined, HomeOutlined, SearchOutlined, SettingOutlined, FileTextOutlined, EditOutlined } from '@ant-design/icons';
import { Button, Empty, Input, Tag } from 'antd';
import type { Unit } from '../model';
import ScopeSelect from '../features/reports/ScopeSelect';
import type { QuickEntryInput } from '../features/reports/quickEntry';
import type { InputRef } from 'antd';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { searchScopeLayout } from './searchWindowLayout';

export type SearchItem = {
  id: string;
  type: '服务器' | '系统' | '单位' | '字段' | '设置' | '工作记录' | '报告' | '系统运维';
  name: string;
  meta: string;
  detail?: string;
  page: string;
  targetId?: string;
  searchText: string;
  ipText?: string;
  tagText?: string;
};

type Props = {
  items: SearchItem[];
  units?: Unit[];
  onInsert?: (input: QuickEntryInput) => Promise<void>;
  onScopeOpen?: (extraHeight: number) => Promise<void>;
  open: boolean;
  query: string;
  hotkey: string;
  focusRequest?: number;
  instant?: boolean;
  standalone?: boolean;
  feedback?: ReactNode;
  onHome?: () => void;
  onOpen: (pointer?: boolean) => void;
  onQueryChange: (value: string) => void;
  onClose: () => void;
  onOpenItem: (item: SearchItem) => void;
};

const icons = {
  服务器: <CloudServerOutlined />,
  系统: <AppstoreOutlined />,
  单位: <ApartmentOutlined />,
  字段: <AppstoreOutlined />,
  设置: <SettingOutlined />,
  工作记录: <EditOutlined />,
  报告: <FileTextOutlined />,
  系统运维: <AppstoreOutlined />,
};

function score(item: SearchItem, query: string) {
  const syntax = query.match(/^(ip|字段|tag)\s*:\s*(.*)$/i);
  let scopedText: string | undefined;
  if (syntax) {
    const [, prefix, value] = syntax;
    if (prefix === '字段' && item.type !== '字段') return 0;
    if (prefix.toLowerCase() === 'ip' && item.type !== '服务器') return 0;
    if (prefix.toLowerCase() === 'tag' && item.type !== '服务器') return 0;
    if (prefix.toLowerCase() === 'ip') scopedText = item.ipText ?? '';
    if (prefix.toLowerCase() === 'tag') scopedText = item.tagText ?? '';
    if (!value.trim()) return 10;
    query = value.trim();
  }
  const source = (scopedText ?? `${item.name} ${item.meta} ${item.searchText}`).toLowerCase();
  const needle = query.toLowerCase();
  if (scopedText === undefined && item.name.toLowerCase() === needle) return 100;
  if (scopedText === undefined && item.name.toLowerCase().startsWith(needle)) return 80;
  if (source.includes(needle)) return 40;
  const words = needle.split(/\s+/).filter(Boolean);
  return words.length && words.every((word) => source.includes(word)) ? 20 : 0;
}

function highlightedName(name: string, query: string) {
  const needle = query.replace(/^(ip|字段|tag)\s*:\s*/i, '').trim();
  if (!needle) return name;
  const index = name.toLowerCase().indexOf(needle.toLowerCase());
  if (index < 0) return name;
  return <>{name.slice(0, index)}<mark>{name.slice(index, index + needle.length)}</mark>{name.slice(index + needle.length)}</>;
}

export function GlobalSearch({ items, units = [], onInsert, onScopeOpen, open, query, hotkey, focusRequest, instant = false, standalone = false, feedback, onHome, onOpen, onQueryChange, onClose, onOpenItem }: Props) {
  const inputRef = useRef<InputRef>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(0);
  const [scope, setScope] = useState<string>();
  const [scopeOpen, setScopeOpen] = useState(false);
  const [scopeLayout, setScopeLayout] = useState({ listHeight: 280, extraHeight: 0 });
  const [busy, setBusy] = useState(false); const saving = useRef(false);
  const [error, setError] = useState('');
  const queryRef = useRef(query); queryRef.current = query;
  const openVersion = useRef(0);
  const quick = Boolean(onInsert && query.startsWith('-'));
  useEffect(() => { openVersion.current++; setScope(undefined); setScopeOpen(false); setError(''); return () => { openVersion.current++; }; }, [open, focusRequest, quick]);
  const measureScope = () => {
    const container = containerRef.current;
    const trigger = container?.querySelector('.report-scope-select');
    return container && trigger ? searchScopeLayout(container.getBoundingClientRect().bottom - (scopeOpen ? scopeLayout.extraHeight : 0), trigger.getBoundingClientRect().bottom) : scopeLayout;
  };
  useLayoutEffect(() => {
    if (!standalone || !scopeOpen) return;
    const next = measureScope();
    setScopeLayout(current => current.listHeight === next.listHeight && current.extraHeight === next.extraHeight ? current : next);
  }, [standalone, scopeOpen, query]);
  const changeScopeOpen = async (next: boolean) => {
    const version = ++openVersion.current;
    if (next && scopeOpen) { setScopeOpen(true); return; }
    if (next && standalone) {
      const layout = measureScope(); setScopeLayout(layout);
      if (onScopeOpen) await onScopeOpen(layout.extraHeight);
    }
    if (version === openVersion.current) {
      setScopeOpen(next);
      if (next) containerRef.current?.querySelector<HTMLInputElement>('.report-scope-select input')?.focus();
    }
  };
  const closeScope = () => {
    void changeScopeOpen(false);
    containerRef.current?.querySelector<HTMLInputElement>('.report-scope-select input')?.focus();
  };
  const insert = async () => {
    if (!onInsert || saving.current) return;
    const original = query; const version = openVersion.current;
    saving.current = true; setBusy(true); setError('');
    try {
      await onInsert({ text: original.slice(1), scope });
      if (queryRef.current === original && version === openVersion.current) onQueryChange('');
    } catch (reason) { if (version === openVersion.current) setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { saving.current = false; setBusy(false); }
  };
  const results = useMemo(() => {
    const value = query.trim();
    if (!open || !value || quick) return [];
    const best: Array<{ item: SearchItem; rank: number }> = [];
    for (const item of items) {
      const rank = score(item, value);
      if (rank <= 0) continue;
      let left = 0, right = best.length;
      while (left < right) {
        const middle = (left + right) >>> 1, other = best[middle];
        if (other.rank > rank || other.rank === rank && other.item.name.localeCompare(item.name, 'zh-CN') <= 0) left = middle + 1;
        else right = middle;
      }
      if (left < 12) { best.splice(left, 0, { item, rank }); if (best.length > 12) best.pop(); }
    }
    return best.map(({ item }) => item);
  }, [items, query, quick, open]);

  useEffect(() => {
    if (!open) return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    return () => { if (previousFocus?.isConnected) previousFocus.focus(); };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    setActive(0);
    inputRef.current?.focus({ cursor: 'all' });
  }, [open, focusRequest]);

  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: PointerEvent) => {
      if (event.target instanceof Node && !containerRef.current?.contains(event.target)) onClose();
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.isComposing || event.defaultPrevented) return;
      if (event.key === 'Escape') {
        event.preventDefault(); event.stopPropagation();
        if (scopeOpen) closeScope(); else onClose();
      }
      if (event.key === 'Tab' && !standalone && !quick) onClose();
    };
    document.addEventListener('pointerdown', closeOutside);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', closeOutside);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [open, onClose, standalone, quick, scopeOpen]);

  useEffect(() => setActive((current) => Math.min(current, Math.max(0, results.length - 1))), [results.length]);
  useEffect(() => {
    if (open) containerRef.current?.querySelector(`#search-result-${active}`)?.scrollIntoView({ block: 'nearest' });
  }, [active, open]);

  const hasQuery = Boolean(query.trim());
  const showsResults = hasQuery && !quick;
  return <div className={`header-search${open ? ' is-open' : ''}${standalone ? ' standalone-search' : ''}`} style={standalone ? { '--search-scope-extra-height': `${scopeLayout.extraHeight}px` } as CSSProperties : undefined} data-instant={instant || undefined} ref={containerRef} onKeyDown={(event) => {
    // TreeSelect 关闭菜单时不阻止冒泡；在它刷新 scopeOpen 前消费所属层的 Escape。
    if (scopeOpen && event.key === 'Escape' && !event.nativeEvent.isComposing) {
      event.preventDefault(); event.stopPropagation(); closeScope();
    }
  }}>
    {feedback}
    {!standalone && <Button className="icon-button search-trigger" type="text" icon={<SearchOutlined />} title={hotkey ? `全局搜索（${hotkey}）` : '全局搜索'} aria-label="全局搜索" onClick={(event) => onOpen(event.detail > 0)} />}
    {open && <div className="search-surface">
      <div className="search-input-row">
        <Input
          ref={inputRef}
          value={query}
          className="global-search"
          prefix={<SearchOutlined />}
          aria-label="全局搜索关键词"
          role="combobox"
          aria-expanded={showsResults}
          aria-controls={showsResults ? 'global-search-results' : undefined}
          aria-activedescendant={showsResults && results[active] ? `search-result-${active}` : undefined}
          onChange={(event) => { onQueryChange(event.target.value); setActive(0); }}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing || event.altKey || event.metaKey) return;
            if (quick) {
              if (event.key === 'Enter') { event.preventDefault(); if (!event.repeat) void insert(); }
              if (event.key === 'ArrowDown') { event.preventDefault(); void changeScopeOpen(true).catch((reason) => setError(String(reason))); }
              return;
            }
            if (event.ctrlKey) return;
            if (event.key === 'ArrowDown') { event.preventDefault(); setActive((current) => results.length ? (current + 1) % results.length : 0); }
            if (event.key === 'ArrowUp') { event.preventDefault(); setActive((current) => results.length ? (current - 1 + results.length) % results.length : 0); }
            if (event.key === 'Enter' && results[active]) { event.preventDefault(); onOpenItem(results[active]); }
          }}
        />
        {standalone ? <Button className="search-home" type="text" icon={<HomeOutlined />} aria-label="返回导览页" title="返回导览页" onClick={onHome} /> : <kbd className="search-escape">Esc</kbd>}
      </div>
      {quick && <div className={`search-suggestions search-quick-entry${standalone && scopeOpen ? ' scope-open' : ''}`}>
        <b>新增工作记录</b><p className="search-quick-text">{query.slice(1).trim() || '输入工作内容'}</p>
        <div className="search-quick-controls"><ScopeSelect units={units} scope={{}} extraNodes={[{ title: '未绑定系统', path: '未绑定系统', value: '', scope: {} }]} value={scope} label="快记归属" disabled={busy} open={scopeOpen} listHeight={standalone ? scopeLayout.listHeight : undefined} onDropdownVisibleChange={(next) => void changeScopeOpen(next).catch((reason) => setError(String(reason)))} getPopupContainer={(trigger) => trigger.closest('.header-search') as HTMLElement} onChange={(value) => { setScope(value); setScopeOpen(false); }} /><Button type="primary" loading={busy} disabled={!query.slice(1).trim() || query.slice(1).trim().length > 5000} onClick={() => void insert()}>保存工作记录</Button></div>
        {error && <div role="alert" className="danger-text">{error}</div>}
      </div>}
      {showsResults && <div className="search-suggestions">
        <div className="search-results" id="global-search-results" role="listbox" aria-label="搜索结果">
          {results.length ? results.map((item, index) => <button
            type="button"
            id={`search-result-${index}`}
            role="option"
            aria-selected={index === active}
            tabIndex={-1}
            key={`${item.type}-${item.id}`}
            className={`search-result ${index === active ? 'active' : ''}`}
            onMouseEnter={() => setActive(index)}
            onClick={() => onOpenItem(item)}
          >
            <span className="search-result-icon">{icons[item.type]}</span>
            <span className="search-result-copy"><b>{highlightedName(item.name, query)}</b>{item.meta && <small title={item.meta}>{highlightedName(item.meta, query)}</small>}{item.detail && <small title={item.detail}>{highlightedName(item.detail, query)}</small>}</span>
            <Tag bordered={false}>{item.type}</Tag>
          </button>) : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有找到匹配内容" />}
        </div>
      </div>}
    </div>}
  </div>;
}
