import { useRef, useState } from 'react';
import { Button, Popover, Tooltip } from 'antd';
import { CheckOutlined, DesktopOutlined, MoonOutlined, SunOutlined } from '@ant-design/icons';
import type { Settings } from '../model';

const themes = [
  { value: 'system', label: '系统', icon: <DesktopOutlined /> },
  { value: 'spring', label: '早春', icon: <svg viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 21v-8M12 16C5 16 3 12 3 6c6 0 9 3 9 10ZM12 13c0-6 3-10 9-10 0 6-3 10-9 10Z" /></svg> },
  { value: 'light', label: '晨雾', icon: <SunOutlined /> },
  { value: 'dark', label: '浅夜', icon: <MoonOutlined /> },
] as const;

export default function ThemeSwitcher({ value, disabled, onChange }: { value: Settings['theme']; disabled: boolean; onChange: (value: Settings['theme']) => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const current = themes.find((item) => item.value === value) ?? themes[0];
  const close = () => { setOpen(false); trigger.current?.focus(); };

  return <Popover trigger="click" placement="topRight" arrow={false} open={open} onOpenChange={setOpen} rootClassName="theme-switch-popover" content={
    <div className="theme-options" role="group" aria-label="选择主题" onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); close(); } }}>
      {themes.map(item => <Button key={item.value} type="text" className="theme-option" data-theme-option={item.value} aria-label={item.label} aria-pressed={item.value === value} disabled={disabled} onClick={() => { close(); if (item.value !== value) void onChange(item.value).catch(() => undefined); }}>
        <span className="theme-option-icon" aria-hidden="true">{item.icon}</span><span className="theme-option-label">{item.label}</span><span className="theme-option-check" aria-hidden="true">{item.value === value && <CheckOutlined />}</span>
      </Button>)}

    </div>
  }>
    <Tooltip title={open ? null : current.label} trigger={['hover', 'focus']}>
      <Button ref={trigger} className="footer-theme" type="text" size="small" aria-label={`切换主题，当前：${current.label}`} aria-expanded={open} disabled={disabled} onKeyDown={(event) => { if (event.key === 'Escape') close(); }} icon={
        <span className="theme-current-icon" aria-hidden="true">{themes.map((item) => <span key={item.value} className="theme-icon-layer" data-active={item.value === value}>{item.icon}</span>)}</span>
      } />
    </Tooltip>
  </Popover>;
}
