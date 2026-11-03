import { useEffect } from 'react';

function patchTables() {
  for (const row of document.querySelectorAll<HTMLElement>('.ant-table-measure-row')) {
    row.inert = true;
    row.setAttribute('aria-hidden', 'true');
    row.querySelectorAll<HTMLElement>('input, button, [tabindex]').forEach((element) => { element.tabIndex = -1; });
  }
  for (const input of document.querySelectorAll<HTMLElement>('.ant-table-thead .ant-table-selection-column input[aria-label="Select all"]')) {
    input.setAttribute('aria-label', '全选当页');
  }
}

// Ant Design 的测量行包含可聚焦复选框；统一移出 Tab 顺序并本地化全选名称。
export default function TableA11yGuard() {
  useEffect(() => {
    let frame = 0;
    const schedule = () => { if (!frame) frame = requestAnimationFrame(() => { frame = 0; patchTables(); }); };
    patchTables();
    const observer = new MutationObserver(schedule);
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['aria-label'] });
    return () => { observer.disconnect(); cancelAnimationFrame(frame); };
  }, []);
  return null;
}
