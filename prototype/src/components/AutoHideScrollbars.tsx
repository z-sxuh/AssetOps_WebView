import { useEffect } from 'react';

export default function AutoHideScrollbars() {
  useEffect(installAutoHideScrollbars, []);
  return null;
}

export function installAutoHideScrollbars() {
  type Bar = { element: HTMLElement; axis: 'x' | 'y'; track: HTMLDivElement; thumb: HTMLDivElement; timer?: number; travel: number; range: number };
  const bars = new Map<HTMLElement, Bar[]>();
  let frame = 0;
  let drag: { bar: Bar; pointer: number; start: number; scroll: number } | undefined;
  const measure = () => {
    frame = 0;
    const modalPanel = [...document.querySelectorAll<HTMLElement>('.ant-modal-wrap, .ant-drawer-open')].filter((panel) => getComputedStyle(panel).display !== 'none').at(-1);
    const fullscreenEditor = document.querySelector<HTMLElement>('[data-editor-fullscreen]');
    const floatingPanel = fullscreenEditor && (!modalPanel || modalPanel.dataset.editorOwner === fullscreenEditor.dataset.editorOwner) ? fullscreenEditor : modalPanel;
    const popupSelector = '.ant-select-dropdown, .ant-picker-dropdown, .ant-dropdown, .ant-tree-select-dropdown, .ant-cascader-dropdown, .ant-popover, .ant-tooltip';
    const ownedPopups = new Set<Element>();
    for (const trigger of floatingPanel?.querySelectorAll<HTMLElement>('[aria-controls], [aria-owns]') ?? []) {
      const ids = `${trigger.getAttribute('aria-controls') ?? ''} ${trigger.getAttribute('aria-owns') ?? ''}`.trim().split(/\s+/);
      for (const id of ids) { const popup = document.getElementById(id)?.closest(popupSelector); if (popup) ownedPopups.add(popup); }
    }
    const removed: HTMLElement[] = [];
    const updates: Array<{ bar: Bar; hidden: boolean; range: number; travel?: number; track?: Partial<CSSStyleDeclaration>; thumb?: Partial<CSSStyleDeclaration> }> = [];
    for (const [element, tracks] of bars) {
      if (!element.isConnected) { removed.push(element); continue; }
      if (!element.getClientRects().length) { tracks.forEach((bar) => updates.push({ bar, hidden: true, range: 0 })); continue; }
      const popup = element.closest(popupSelector);
      const blocked = floatingPanel && !floatingPanel.contains(element) && (!popup || !ownedPopups.has(popup));
      const rect = element.getBoundingClientRect();
      let zIndex = Math.max(900, Number(getComputedStyle(element).zIndex) || 0);
      let left = Math.max(0, rect.left + element.clientLeft), top = Math.max(0, rect.top + element.clientTop);
      let right = Math.min(window.innerWidth, rect.left + element.clientLeft + element.clientWidth), bottom = Math.min(window.innerHeight, rect.top + element.clientTop + element.clientHeight);
      for (let parent = element.parentElement; parent; parent = parent.parentElement) {
        const style = getComputedStyle(parent); const bounds = parent.getBoundingClientRect();
        zIndex = Math.max(zIndex, Number(style.zIndex) || 0);
        if (/auto|scroll|hidden|clip/.test(style.overflowX)) { left = Math.max(left, bounds.left); right = Math.min(right, bounds.right); }
        if (/auto|scroll|hidden|clip/.test(style.overflowY)) { top = Math.max(top, bounds.top); bottom = Math.min(bottom, bounds.bottom); }
      }
      for (const bar of tracks) {
        const vertical = bar.axis === 'y'; const viewport = vertical ? element.clientHeight : element.clientWidth;
        const total = vertical ? element.scrollHeight : element.scrollWidth;
        const length = (vertical ? bottom - top : right - left) - 6;
        const range = Math.max(0, total - viewport);
        const hidden = !range || length <= 0 || rect.width <= 0 || rect.height <= 0 || Boolean(blocked);
        if (hidden) { updates.push({ bar, hidden, range }); continue; }
        const thumbSize = Math.min(length, Math.max(24, length * viewport / total));
        const travel = length - thumbSize;
        updates.push({ bar, hidden, range, travel,
          track: { left: `${vertical ? right - 10 : left + 3}px`, top: `${vertical ? top + 3 : bottom - 10}px`, width: `${vertical ? 10 : length}px`, height: `${vertical ? length : 10}px`, zIndex: String(zIndex + 1) },
          thumb: { width: `${vertical ? 10 : thumbSize}px`, height: `${vertical ? thumbSize : 10}px`, transform: `translate${vertical ? 'Y' : 'X'}(${travel * (vertical ? element.scrollTop : element.scrollLeft) / range}px)` },
        });
      }
    }
    // 所有容器先读完几何信息，再写入；滚动、侧栏和弹层变化只触发一轮布局测量。
    removed.forEach((element) => { observer.unobserve(element); bars.get(element)?.forEach((bar) => { window.clearTimeout(bar.timer); bar.track.remove(); }); bars.delete(element); });
    updates.forEach(({ bar, hidden, range, travel, track, thumb }) => {
      bar.range = range;
      // Setting an unchanged hidden attribute retriggers our MutationObserver every frame.
      if (bar.track.hidden !== hidden) bar.track.hidden = hidden;
      if (hidden) return;
      bar.travel = travel!; Object.assign(bar.track.style, track); Object.assign(bar.thumb.style, thumb);
    });
  };
  const schedule = () => { if (!frame) frame = requestAnimationFrame(measure); };
  const observer = new ResizeObserver(schedule);
  const reveal = (bar: Bar) => {
    window.clearTimeout(bar.timer); bar.track.classList.add('is-visible');
    bar.timer = window.setTimeout(() => { if (drag?.bar !== bar && !bar.track.matches(':hover')) bar.track.classList.remove('is-visible'); else reveal(bar); }, 800);
  };
  const register = (element: HTMLElement) => {
    let tracks = bars.get(element);
    const style = getComputedStyle(element);
    for (const axis of ['x', 'y'] as const) {
      if (tracks?.some((bar) => bar.axis === axis)) continue;
      if (!/auto|scroll/.test(axis === 'y' ? style.overflowY : style.overflowX)) continue;
      if (axis === 'y' ? element.scrollHeight <= element.clientHeight : element.scrollWidth <= element.clientWidth) continue;
      const track = document.createElement('div'), thumb = document.createElement('div');
      track.className = 'floating-scrollbar'; track.dataset.axis = axis; thumb.className = 'floating-scrollbar-thumb'; track.append(thumb); document.body.append(track);
      const bar: Bar = { element, axis, track, thumb, travel: 0, range: 0 };
      track.addEventListener('pointerdown', (event) => {
        if (event.button !== 0 || !bar.travel || !bar.range) return;
        event.preventDefault(); event.stopPropagation();
        const coordinate = axis === 'y' ? event.clientY : event.clientX;
        if (event.target !== thumb) {
          const bounds = track.getBoundingClientRect();
          const thumbSize = axis === 'y' ? thumb.offsetHeight : thumb.offsetWidth;
          const value = (coordinate - (axis === 'y' ? bounds.top : bounds.left) - thumbSize / 2) / bar.travel * bar.range;
          if (axis === 'y') element.scrollTop = value; else element.scrollLeft = value;
        }
        drag = { bar, pointer: event.pointerId, start: coordinate, scroll: axis === 'y' ? element.scrollTop : element.scrollLeft };
        track.setPointerCapture(event.pointerId); reveal(bar); schedule();
      });
      if (!tracks) { tracks = []; bars.set(element, tracks); observer.observe(element); }
      tracks.push(bar);
    }
    tracks?.forEach(reveal); schedule();
  };
  const hover = (event: PointerEvent) => {
    if (!(event.target instanceof HTMLElement)) return;
    if (event.target.closest('.floating-scrollbar')) return;
    for (let element: HTMLElement | null = event.target; element; element = element.parentElement) register(element);
  };
  const scroll = (event: Event) => {
    const element = event.target === document ? document.scrollingElement : event.target;
    if (element instanceof HTMLElement) register(element);
    schedule();
  };
  const move = (event: PointerEvent) => {
    if (!drag || drag.pointer !== event.pointerId) return;
    event.preventDefault();
    const { bar } = drag;
    if (!bar.travel || !bar.range || !bar.element.isConnected) { drag = undefined; return; }
    const value = drag.scroll + ((bar.axis === 'y' ? event.clientY : event.clientX) - drag.start) / bar.travel * bar.range;
    if (bar.axis === 'y') bar.element.scrollTop = value; else bar.element.scrollLeft = value;
    reveal(bar); schedule();
  };
  const release = (event: PointerEvent) => { if (drag?.pointer === event.pointerId) { reveal(drag.bar); drag = undefined; } };
  document.addEventListener('scroll', scroll, true); document.addEventListener('pointerover', hover, true);
  window.addEventListener('resize', schedule); window.addEventListener('pointermove', move); window.addEventListener('pointerup', release); window.addEventListener('pointercancel', release);
  const mutations = new MutationObserver(schedule);
  mutations.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden', 'aria-hidden', 'aria-controls', 'aria-owns', 'data-editor-fullscreen', 'data-editor-owner', 'inert'] });
  return () => {
    observer.disconnect(); mutations.disconnect(); cancelAnimationFrame(frame);
    document.removeEventListener('scroll', scroll, true); document.removeEventListener('pointerover', hover, true);
    window.removeEventListener('resize', schedule); window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', release); window.removeEventListener('pointercancel', release);
    bars.forEach((tracks) => tracks.forEach((bar) => { window.clearTimeout(bar.timer); bar.track.remove(); })); bars.clear(); drag = undefined;
  };
}
