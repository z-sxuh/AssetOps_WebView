import { useEffect } from 'react';

// 定位外壳不参与动效；内容过渡从当前呈现状态接续。
export default function FloatingSurfaceMotion() {
  useEffect(() => {
    const selector = '.ant-modal, .ant-popover, .ant-select-dropdown, .ant-dropdown, .ant-picker-dropdown';
    const pending = new Map<Element, number>();
    const closed = new WeakSet<Element>();
    const focusedModals = new WeakSet<Element>();
    const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
    let keyboard = false;
    const keyDown = (event: KeyboardEvent) => { if (!event.isComposing) keyboard = true; };
    const pointerDown = () => { keyboard = false; };
    const active = (element: Element) => /-(enter|appear)-active\b/.test(element.className);
    const stop = (element: Element) => {
      const frame = pending.get(element);
      if (frame !== undefined) cancelAnimationFrame(frame);
      pending.delete(element);
      element.removeAttribute('data-position-pending');
      element.removeAttribute('data-motion-origin');
    };
    const settle = (element: Element) => {
      let previous = '';
      const measure = () => {
        if (!element.isConnected || !active(element)) { stop(element); return; }
        const rect = element.getBoundingClientRect();
        const geometry = [rect.x, rect.y, rect.width, rect.height].map((value) => Math.round(value * 10)).join(',');
        if (geometry === previous && rect.width > 0 && rect.height > 0) {
          element.setAttribute('data-motion-origin', '');
          element.setAttribute('data-motion-ready', '');
          element.removeAttribute('data-position-pending');
          element.removeAttribute('data-position-closed');
          pending.set(element, requestAnimationFrame(() => { element.removeAttribute('data-motion-origin'); pending.delete(element); }));
        } else { previous = geometry; pending.set(element, requestAnimationFrame(measure)); }
      };
      pending.set(element, requestAnimationFrame(measure));
    };
    const mark = (element: Element) => {
      if (!element.matches(selector)) return;
      if (/-(enter|appear)-(prepare|start)\b/.test(element.className)) {
        if (keyboard || reducedMotion.matches) element.setAttribute('data-motion-instant', '');
        else element.removeAttribute('data-motion-instant');
      }
      if (element.matches('.ant-select-dropdown, .ant-popover, .ant-dropdown')) {
        if (/-hidden\b/.test(element.className)) { stop(element); element.setAttribute('data-position-closed', ''); return; }
        if (/-(enter|appear)-(prepare|start)\b/.test(element.className) && (!element.hasAttribute('data-motion-ready') || element.hasAttribute('data-position-closed'))) element.setAttribute('data-motion-origin', '');
        if (active(element)) {
          element.setAttribute('data-motion-ready', '');
          element.removeAttribute('data-position-closed');
          element.removeAttribute('data-motion-origin');
        }
        return;
      }
      if (element.matches('.ant-modal')) {
        const wrapper = element.closest<HTMLElement>('.ant-modal-wrap');
        if (wrapper?.style.display === 'none') { element.setAttribute('data-position-closed', ''); focusedModals.delete(element); }
        if (/-(enter|appear)-(prepare|start)\b/.test(element.className)) focusedModals.delete(element);
        if (active(element)) {
          element.setAttribute('data-motion-ready', ''); element.removeAttribute('data-position-closed');
          if (wrapper && element.matches('.asset-editor-modal, .column-settings-modal, .asset-notes-editor') && !focusedModals.has(element)) {
            const top = [...document.querySelectorAll<HTMLElement>('.ant-modal-wrap')].filter(item => item.style.display !== 'none').sort((a, b) => (Number(getComputedStyle(a).zIndex) || 0) - (Number(getComputedStyle(b).zIndex) || 0)).at(-1);
            if (top === wrapper) {
              // 沿用 rc-dialog 的首个焦点哨兵，保持其正反向 Tab 循环。
              if (!wrapper.contains(document.activeElement)) element.querySelector<HTMLElement>(':scope > [tabindex="0"]')?.focus({ preventScroll: true });
              if (wrapper.contains(document.activeElement)) focusedModals.add(element);
            }
          }
        }
        return;
      }
      if (/-hidden\b/.test(element.className)) { stop(element); closed.add(element); element.setAttribute('data-position-closed', ''); return; }
      if (/-(enter|appear)-(prepare|start)\b/.test(element.className) && (closed.has(element) || !element.hasAttribute('data-motion-ready'))) {
        // 内容显示前先等待外壳定位稳定。
        element.setAttribute('data-position-pending', ''); closed.delete(element);
      }
      if (active(element) && (element.hasAttribute('data-position-pending') || !element.hasAttribute('data-motion-ready'))) {
        // rc-trigger 的 prepare promise 已完成对齐，active 阶段可安全显示即时浮层。
        if (element.hasAttribute('data-motion-instant')) {
          stop(element);
          element.setAttribute('data-motion-ready', '');
          element.removeAttribute('data-position-closed');
        } else if (!pending.has(element)) settle(element);
      }
    };
    const scan = (element: Element) => { mark(element); element.querySelectorAll(selector).forEach(mark); };
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        if (record.type === 'attributes') { const target = record.target as Element; if (target.matches('.ant-modal-wrap')) scan(target); else mark(target); }
        else record.addedNodes.forEach((node) => { if (node instanceof Element) scan(node); });
      }
    });
    scan(document.body);
    document.addEventListener('keydown', keyDown, true);
    document.addEventListener('pointerdown', pointerDown, true);
    observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['class', 'style'] });
    return () => { observer.disconnect(); pending.forEach(cancelAnimationFrame); pending.clear(); document.removeEventListener('keydown', keyDown, true); document.removeEventListener('pointerdown', pointerDown, true); };
  }, []);
  return null;
}
