// 仅保留旧布局配置的读取兼容；导览已改为固定布局。
export const dashboardModules = {
  stats: { title: '资产统计', w: 12, h: 3, minW: 6, minH: 3 },
  status: { title: '服务器状态分布', w: 4, h: 5, minW: 4, minH: 5 },
  systems: { title: '各单位服务器数量', w: 8, h: 5, minW: 4, minH: 5 },
  history: { title: '最近变更', w: 6, h: 5, minW: 4, minH: 4 },
  maintenance: { title: '密码维护', w: 3, h: 5, minW: 3, minH: 5 },
  backup: { title: '备份状态', w: 3, h: 5, minW: 3, minH: 5 },
  calendar: { title: '工作日历', w: 12, h: 12, minW: 7, minH: 8 },
  records: { title: '工作记录', w: 12, h: 7, minW: 6, minH: 5 },
  reports: { title: '报告归档', w: 12, h: 7, minW: 6, minH: 5 },
  reminders: { title: '提醒事项', w: 6, h: 5, minW: 3, minH: 3 },
} as const;
export type DashboardModule = keyof typeof dashboardModules;
export type DashboardItem = { id: DashboardModule; x: number; y: number; w: number; h: number };
export const defaultDashboardLayout: DashboardItem[] = [
  { id: 'stats', x: 0, y: 0, w: 12, h: 3 }, { id: 'status', x: 0, y: 3, w: 4, h: 5 }, { id: 'systems', x: 4, y: 3, w: 8, h: 5 },
  { id: 'history', x: 0, y: 8, w: 6, h: 5 }, { id: 'maintenance', x: 6, y: 8, w: 3, h: 5 }, { id: 'backup', x: 9, y: 8, w: 3, h: 5 },
];
const overlap = (a: DashboardItem, b: DashboardItem) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
const integer = (value: unknown, fallback: number) => typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : fallback;
export function normalizeDashboardLayout(value: unknown): DashboardItem[] {
  if (!Array.isArray(value)) return defaultDashboardLayout.map((item) => ({ ...item }));
  const result: DashboardItem[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== 'object' || !Object.hasOwn(dashboardModules, raw.id) || result.some((item) => item.id === raw.id)) continue;
    const spec = dashboardModules[raw.id as DashboardModule];
    const w = Math.max(spec.minW, Math.min(12, integer(raw.w, spec.w)));
    const item: DashboardItem = { id: raw.id, x: Math.max(0, Math.min(12 - w, integer(raw.x, 0))), y: Math.max(0, Math.min(200, integer(raw.y, 0))), w, h: Math.max(spec.minH, Math.min(24, integer(raw.h, spec.h))) };
    while (result.some((other) => overlap(item, other))) item.y = Math.max(...result.filter((other) => overlap(item, other)).map((other) => other.y + other.h));
    result.push(item);
  }
  return result;
}
