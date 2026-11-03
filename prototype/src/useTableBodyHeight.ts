import { useLayoutEffect, useRef, useState } from 'react';

// 固定面板 + 表格内部滚动：测量宿主高度，扣除表头、分页与额外占位，得到表体可用高度。
export function useTableBodyHeight(extraSelectors: string[] = [], deps: unknown[] = [], minBodyHeight = 100) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [bodyHeight, setBodyHeight] = useState(240);
  useLayoutEffect(() => {
    const panel = hostRef.current;
    if (!panel) return;
    const resize = () => {
      const panelHeight = panel.clientHeight;
      if (panelHeight <= 0) return;
      const header = panel.querySelector('.ant-table-header')?.getBoundingClientRect().height ?? 46;
      const pagination = panel.querySelector('.ant-pagination') as HTMLElement | null;
      const occupiedHeight = (element: Element | null) => {
        if (!element) return 0;
        const style = getComputedStyle(element);
        return element.getBoundingClientRect().height + (parseFloat(style.marginTop) || 0) + (parseFloat(style.marginBottom) || 0);
      };
      const paginationHeight = occupiedHeight(pagination);
      const extra = extraSelectors.reduce((sum, selector) => sum + occupiedHeight(panel.querySelector(selector)), 0);
      setBodyHeight(Math.max(minBodyHeight, Math.floor(panelHeight - header - paginationHeight - extra)));
    };
    const observer = new ResizeObserver(resize);
    observer.observe(panel);
    for (const selector of ['.ant-table-header', '.ant-pagination', ...extraSelectors]) {
      const element = panel.querySelector(selector); if (element) observer.observe(element);
    }
    resize();
    return () => observer.disconnect();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [minBodyHeight, ...deps]);
  return { hostRef, bodyHeight };
}
