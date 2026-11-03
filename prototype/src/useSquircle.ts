import { useLayoutEffect } from 'react';
import { getSquirclePath, type SquircleRadii } from './squircleGeometry';
export { getSquirclePath } from './squircleGeometry';

const surfaces = [
  '.ant-btn', '.ant-input', '.ant-input-affix-wrapper', '.ant-input-group-wrapper',
  '.ant-input-number', '.ant-input-number-group-wrapper', '.ant-select-selector', '.ant-picker',
  '.ant-tag', '.ant-checkbox-inner', '.sidebar .ant-menu-item',
  '.ant-select-item', '.ant-dropdown-menu-item', '.ant-dropdown-menu-submenu-title', '.ant-select-tree-node-content-wrapper',
  '.search-input-row', '.ant-space-compact', '.ant-card', '.settings-group', '.table-panel', '.tree-panel',
  '.search-result', '.work-calendar-day', '.footer-lock', '.operations-archived button',
  '.topology-edge-colors button', '.gate-password .ant-input-password-icon', '.column-drag-handle',
  '.operations-workspace', '.work-record-list', '.report-archive-list', '.markdown-tiptap', '.markdown-preview', '.topology-viewport', '.topology-properties',
  '.work-calendar-month', '.work-calendar-tasks', '.dashboard-widget', '.dashboard-widget-content', '.system-assets-panel', '.ant-descriptions-view',
  '.project-card', '.markdown-editor-loading',
  '.ant-upload-drag', '.ant-modal-content', '.ant-drawer-content', '.ant-select-dropdown > div',
  '.ant-dropdown-menu', '.ant-table-filter-dropdown', '.ant-popover-inner', '.ant-picker-panel-container',
  '.search-suggestions', '.standalone-search .search-surface', '.topology-context-menu',
  '.ant-alert', '.ant-tooltip-inner', '.ant-message-notice-content', '.ant-notification-notice', '.ant-modal-close',
  '.ant-segmented', '.ant-segmented-item', '.ant-segmented-thumb',
  '.ant-menu-item', '.ant-menu-submenu-title', '.ant-select-multiple .ant-select-selection-item',
  '.ant-pagination-item', '.ant-pagination-item-link', '.ant-pagination-options-quick-jumper input', '.ant-pagination-simple-pager input',
  '.ant-picker-cell-inner', '.ant-picker-time-panel-cell-inner', '.ant-tabs-card .ant-tabs-tab',
  '.brand-mark', '.card-title-icon', '.reminder-key', '.project-icon', '.onboarding-icon', '.coming-icon',
  '.gate-icon', '.search-result-icon', '.activity-icon', 'kbd', '.search-escape', '.search-result-copy mark',
  '.project-chart-row', '.recent-change', '.maintenance-list button', '.tree-all',
  '.topology-controls', '.topology-overview', '.topology-help', '.maintenance-summary > div', '.dashboard-reminder',
  '.column-setting-list', '.markdown-tiptap-content .ProseMirror code', '.markdown-tiptap-content .ProseMirror pre',
  '.basic-markdown code', '.basic-markdown pre', '.dashboard-widget-content > .work-calendar-view',
  '.dashboard-widget-content > .embedded-reports', '.backup-pagination',
  '.fatal-card', '.fatal-mark', '.fatal-actions button', '.fatal-card code', '.search-window-error', '.search-window-error button',
].join(', ');

type SurfaceElement = HTMLElement | SVGSVGElement;

/** 原生连续圆角优先；旧 WebView 用同一条超椭圆路径绘制表面，保留内容、焦点和滚动条。 */
export function useSquircle() {
  useLayoutEffect(() => {
    if (CSS.supports('corner-shape', 'squircle')) return;
    const elements = new Set<SurfaceElement>();
    const pending = new Set<SurfaceElement>();
    const signatures = new WeakMap<SurfaceElement, string>();
    const borders = new WeakMap<SurfaceElement, { widths: string; style: string }>();
    let frame = 0;
    const paint = () => {
      frame = 0;
      // 先集中读取布局，随后写样式，避免逐个读写触发强制布局。
      const updates: Array<[SurfaceElement, string, string, string]> = [];
      const images = new Map<string, string>();
      for (const element of pending) {
        if (!element.isConnected) { resize.unobserve(element); elements.delete(element); continue; }
        const style = getComputedStyle(element);
        const radius = Number.parseFloat(style.getPropertyValue('--squircle-radius'));
        const bounds = element instanceof HTMLElement ? undefined : element.getBoundingClientRect();
        const width = element instanceof HTMLElement ? element.offsetWidth : bounds!.width;
        const height = element instanceof HTMLElement ? element.offsetHeight : bounds!.height;
        if (!radius) {
          if (element.hasAttribute('data-squircle-svg')) {
            updates.push([element, '', '', '']);
          }
          continue;
        }
        if (!width || !height || style.display === 'none') continue;
        let originalBorder = borders.get(element);
        if (!originalBorder) {
          originalBorder = { widths: `${style.borderTopWidth} ${style.borderRightWidth} ${style.borderBottomWidth} ${style.borderLeftWidth}`, style: style.borderTopStyle };
          borders.set(element, originalBorder);
        }
        const border = Number.parseFloat(style.borderTopWidth) || 0;
        const radii: SquircleRadii = [Number.parseFloat(style.borderTopLeftRadius) || 0, Number.parseFloat(style.borderTopRightRadius) || 0,
          Number.parseFloat(style.borderBottomRightRadius) || 0, Number.parseFloat(style.borderBottomLeftRadius) || 0];
        const signature = [width, height, ...radii, border, style.backgroundColor, style.borderTopColor, originalBorder.style].join('|');
        if (signatures.get(element) === signature) continue;
        let image = images.get(signature);
        if (!image) {
          const path = getSquirclePath(width, height, radii);
          const dash = originalBorder.style === 'dashed' ? ' stroke-dasharray="4 3"' : originalBorder.style === 'dotted' ? ' stroke-dasharray="1 2"' : '';
          const stroke = border ? `<path d="${getSquirclePath(width, height, radii, border / 2)}" fill="none" stroke="${style.borderTopColor}" stroke-width="${border}"${dash}/>` : '';
          const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><path d="${path}" fill="${style.backgroundColor}"/>${stroke}</svg>`;
          image = `url("data:image/svg+xml,${encodeURIComponent(svg)}")`; images.set(signature, image);
        }
        updates.push([element, signature, image, originalBorder.widths]);
      }
      pending.clear();
      for (const [element, signature, image, widths] of updates) {
        if (!image) {
          signatures.delete(element); borders.delete(element);
          element.style.removeProperty('--squircle-image'); element.style.removeProperty('--squircle-border-width');
          element.removeAttribute('data-squircle-svg');
          continue;
        }
        signatures.set(element, signature);
        element.style.setProperty('--squircle-image', image);
        element.style.setProperty('--squircle-border-width', widths);
        element.setAttribute('data-squircle-svg', '');
      }
    };
    const schedule = (element: SurfaceElement) => {
      pending.add(element);
      if (!frame) frame = requestAnimationFrame(paint);
    };
    const resize = new ResizeObserver(entries => entries.forEach(entry => schedule(entry.target as SurfaceElement)));
    const scan = (root: Element) => {
      const register = (element: Element) => {
        if (!(element instanceof HTMLElement) && !(element instanceof SVGSVGElement)) return;
        if (!elements.has(element)) { elements.add(element); resize.observe(element); }
        schedule(element);
      };
      if (root.matches(surfaces)) register(root);
      root.querySelectorAll(surfaces).forEach(register);
    };
    const refresh = (event: Event) => {
      if (!(event.target instanceof Element)) return;
      const element = event.target.closest<SurfaceElement>(surfaces);
      if (element) { schedule(element); element.querySelectorAll<SurfaceElement>(surfaces).forEach(schedule); }
    };
    const mutations = new MutationObserver(records => {
      let removed = false;
      for (const record of records) {
        if (record.type === 'childList') {
          record.addedNodes.forEach(node => { if (node instanceof Element) scan(node); });
          removed ||= record.removedNodes.length > 0;
        } else if (record.target instanceof Element) scan(record.target);
      }
      if (removed) for (const element of elements) {
        if (!element.isConnected) { resize.unobserve(element); elements.delete(element); pending.delete(element); }
      }
    });
    scan(document.body);
    cancelAnimationFrame(frame);
    paint();
    mutations.observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ['class', 'style', 'data-theme', 'hidden'] });
    const events = ['pointerover', 'pointerout', 'focusin', 'focusout', 'transitionend'];
    events.forEach(name => document.addEventListener(name, refresh, true));
    return () => {
      resize.disconnect(); mutations.disconnect(); cancelAnimationFrame(frame);
      events.forEach(name => document.removeEventListener(name, refresh, true));
      elements.forEach(element => { element.style.removeProperty('--squircle-image'); element.style.removeProperty('--squircle-border-width'); element.removeAttribute('data-squircle-svg'); });
      elements.clear(); pending.clear();
    };
  }, []);
}
