import { DatePicker } from 'antd';
import dayjs from 'dayjs';
import type { ComponentRef, CSSProperties, KeyboardEvent } from 'react';
import { useId, useLayoutEffect, useRef, useState } from 'react';
import { composingCancel } from '../composition';

// 保持表单和仓库中的日期为字符串，避免将 Dayjs 对象写入资产字段。
export default function DateTimeInput({ value, onChange, dateOnly = false, seconds = true, allowClear = true, active = true, ...props }: {
  value?: string; onChange?: (value: string) => void; dateOnly?: boolean; seconds?: boolean; allowClear?: boolean; active?: boolean;
  id?: string; 'aria-label'?: string; className?: string; style?: CSSProperties; disabled?: boolean;
}) {
  const [popupOpen, setPopupOpen] = useState(false);
  const panelId = useId();
  const picker = useRef<ComponentRef<typeof DatePicker>>(null);
  useLayoutEffect(() => { if (!active) setPopupOpen(false); }, [active]);
  const closePopup = (event: KeyboardEvent<HTMLElement>) => {
    if (!popupOpen || event.key !== 'Escape') return;
    event.stopPropagation(); event.preventDefault();
    if (composingCancel(event)) return;
    setPopupOpen(false); picker.current?.focus();
  };
  const date = value && dayjs(value).isValid() ? dayjs(value) : null;
  return <DatePicker {...props} ref={picker} value={date} allowClear={allowClear} inputReadOnly
    open={active && popupOpen} aria-controls={active && popupOpen ? panelId : undefined} onOpenChange={setPopupOpen} onKeyDown={closePopup} panelRender={(panel) => <div id={panelId} onKeyDown={closePopup}>{panel}</div>}
    format={dateOnly ? 'YYYY/MM/DD' : seconds ? 'YYYY/MM/DD HH:mm:ss' : 'YYYY/MM/DD HH:mm'}
    showTime={dateOnly ? undefined : { format: seconds ? 'HH:mm:ss' : 'HH:mm' }}
    onChange={(next) => onChange?.(next ? next.format(dateOnly ? 'YYYY-MM-DD' : 'YYYY-MM-DDTHH:mm:ss') : '')} />;
}
