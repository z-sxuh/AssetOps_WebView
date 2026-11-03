import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from 'react';

export function useDragSort(onMove: (source: string, target: string) => void | Promise<void>, active = true) {
  const [draggingKey, setDraggingKey] = useState<string>();
  const [dropKey, setDropKey] = useState<string>();
  const [announcement, setAnnouncement] = useState('');
  const move = useRef(onMove);
  const cleanup = useRef<() => void>();
  const pendingFocus = useRef<HTMLElement>();
  move.current = onMove;
  useEffect(() => () => cleanup.current?.(), []);
  useLayoutEffect(() => {
    if (active) return;
    cleanup.current?.();
    pendingFocus.current = undefined;
    setDraggingKey(undefined);
    setDropKey(undefined);
  }, [active]);
  useLayoutEffect(() => {
    pendingFocus.current?.focus();
    pendingFocus.current = undefined;
  });

  const keyDown = (event: ReactKeyboardEvent<HTMLElement>, source: string, label: string) => {
    if (!active || event.nativeEvent.isComposing || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey
      || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) return;
    const group = event.currentTarget.closest('[data-sort-group]');
    if (!group) return;
    const handles = Array.from(group.querySelectorAll<HTMLElement>('[data-sort-handle]:not(:disabled)'));
    const index = handles.indexOf(event.currentTarget);
    const targetIndex = index + (event.key === 'ArrowUp' ? -1 : 1);
    const target = handles[targetIndex]?.closest('[data-sort-key]')?.getAttribute('data-sort-key');
    event.preventDefault();
    if (index < 0 || !target) return;
    pendingFocus.current = event.currentTarget;
    void move.current(source, target);
    setAnnouncement(`${label}已移至第 ${targetIndex + 1} 项，共 ${handles.length} 项`);
  };

  const start = (event: ReactPointerEvent<HTMLElement>, source: string) => {
    if (!active || event.button !== 0) return;
    const group = event.currentTarget.closest('[data-sort-group]');
    if (!group) return;
    event.preventDefault();
    cleanup.current?.();
    setDraggingKey(source);
    let target: string | undefined;
    const point = (next: PointerEvent) => {
      if (next.pointerId !== event.pointerId) return;
      const row = document.elementFromPoint(next.clientX, next.clientY)?.closest('[data-sort-key]');
      target = row && group.contains(row) ? row.getAttribute('data-sort-key') ?? undefined : undefined;
      setDropKey(target);
    };
    const cancel = (next?: Event) => { if (next && 'pointerId' in next && next.pointerId !== event.pointerId) return; cleanup.current?.(); setDraggingKey(undefined); setDropKey(undefined); };
    const finish = (next: PointerEvent) => {
      if (next.pointerId !== event.pointerId) return;
      point(next);
      cancel();
      if (target && target !== source) void move.current(source, target);
    };
    document.addEventListener('pointermove', point);
    document.addEventListener('pointerup', finish);
    document.addEventListener('pointercancel', cancel);
    window.addEventListener('blur', cancel);
    cleanup.current = () => {
      document.removeEventListener('pointermove', point);
      document.removeEventListener('pointerup', finish);
      document.removeEventListener('pointercancel', cancel);
      window.removeEventListener('blur', cancel);
      cleanup.current = undefined;
    };
  };
  return { start, keyDown, announcement, clearAnnouncement: () => setAnnouncement(''), draggingKey, dropKey };
}
