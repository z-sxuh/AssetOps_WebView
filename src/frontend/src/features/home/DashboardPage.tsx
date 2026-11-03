import { memo, useCallback, useLayoutEffect, useMemo, useRef } from 'react';
import { Card, Empty, Tooltip, Typography } from 'antd';
import WorkCalendarView from '../reports/WorkCalendarView';
import ReportsPage from '../reports/ReportsPage';
import type { ReportsData } from '../reports/types';
import type { Asset, AssetStatus, Unit, VaultData } from '../../model';
import { accountExpiryDate } from '../../passwordPolicy';
import StatusOverview, { colors, statuses } from './StatusOverview';
const MemoizedWorkCalendarView = memo(WorkCalendarView);
type Props = { visible: boolean; data: VaultData; onUnit: (unit: Unit) => void; onOpenReports: (tab: 'entries' | 'calendar') => void; onReportsChange: (reports: ReportsData) => Promise<void> };
export function maintenanceAccounts(assets: Asset[], warningDays: number, now = new Date()) {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  return assets.flatMap((asset) => asset.accounts.flatMap((account, index) => {
    const expiry = accountExpiryDate(asset, account);
    if (!expiry) return [];
    const days = Math.ceil((expiry.getTime() - start) / 86_400_000);
    return days <= warningDays ? [{ asset, account, index, days }] : [];
  })).sort((left, right) => left.days - right.days);
}

export function maintenanceServers(assets: Asset[], warningDays: number, now = new Date()) {
  const servers = new Map<string, { asset: Asset; days: number }>();
  for (const { asset, days } of maintenanceAccounts(assets, warningDays, now)) {
    if (!servers.has(asset.id)) servers.set(asset.id, { asset, days });
  }
  return [...servers.values()];
}


function DashboardPage({ visible, data, onUnit, onOpenReports, onReportsChange }: Props) {
  const unitChartRef = useRef<HTMLDivElement>(null);
  const openEntries = useCallback(() => onOpenReports('entries'), [onOpenReports]);
  const openCalendar = useCallback(() => onOpenReports('calendar'), [onOpenReports]);
  const handleFocus = useCallback(() => {}, []);
  const unitStats = useMemo(() => data.units.map((unit) => { const assets = data.assets.filter((asset) => asset.unitId === unit.id); return { unit, assets, counts: Object.fromEntries(statuses.map((status) => [status, assets.filter((asset) => asset.status === status).length])) as Record<AssetStatus, number> }; }).filter((item) => item.assets.length > 0).sort((left, right) => right.assets.length - left.assets.length || left.unit.name.localeCompare(right.unit.name, 'zh-CN')), [data.units, data.assets]);
  useLayoutEffect(() => {
    const chart = unitChartRef.current; if (!chart) return;
    const context = document.createElement('canvas').getContext('2d'); if (!context) return;
    const resize = () => {
      const captions = Array.from(chart.querySelectorAll<HTMLElement>('.project-chart-label b')).map((text) => {
        const name = text.dataset.name ?? ''; context.font = getComputedStyle(text).font;
        const chars = Array.from(name); const caption = context.measureText(name).width > text.clientWidth && chars.length > 3 ? `${chars.slice(0, 2).join('')}..${chars.at(-1)}` : name;
        return { text, caption };
      });
      captions.forEach(({ text, caption }) => { if (text.textContent !== caption) text.textContent = caption; });
    };
    const observer = new ResizeObserver(resize); observer.observe(chart); resize();
    return () => observer.disconnect();
  }, [unitStats]);
  const maxCount = Math.max(...unitStats.map((item) => item.assets.length), 1);
  const scale = Math.max(4, Math.ceil(maxCount / 4) * 4);
  return <div className="page-content dashboard-page modular-dashboard">
    <div className="page-heading"><Typography.Title level={2}>系统导览</Typography.Title></div>
    <div className="dashboard-grid-layout">
      <section className="dashboard-widget" data-module="status" aria-label="服务器状态分布"><div className="dashboard-widget-content"><Card className="panel-card status-panel" bordered={false}>
        <StatusOverview visible={visible} assets={data.assets} entries={data.reports.entries} />
      </Card></div></section>
      <section className="dashboard-widget" data-module="systems" aria-label="各单位服务器数量"><div className="dashboard-widget-content"><Card className="panel-card project-chart-panel" bordered={false}>
        <div className="project-chart-toolbar">{unitStats.length > 0 && <div className="project-chart-legend">{statuses.map((status) => <span key={status}><i className="status-dot" style={{ background: colors[status] }} />{status}</span>)}</div>}</div>
        {unitStats.length ? <div className="dashboard-chart"><div className="chart-plot"><div ref={unitChartRef} className="project-chart">{unitStats.map(({ unit, assets, counts: unitCounts }) => {
          return <div key={unit.id} className="project-chart-column"><div className="project-chart-stack"><Tooltip title={`${unit.name}：${assets.length} 台 · ${statuses.map((status) => `${status} ${unitCounts[status]}`).join(' / ')}`}><button type="button" className="project-chart-bar" aria-label={`${unit.name}：${assets.length} 台服务器`} style={{ height: `${assets.length / scale * 100}%` }} onClick={() => onUnit(unit)}><div className="project-chart-fill" aria-hidden="true">{statuses.map((status) => <i key={status} style={{ height: `${assets.length ? unitCounts[status] / assets.length * 100 : 0}%`, background: colors[status] }} />)}</div></button></Tooltip></div><span className="project-chart-label"><b data-name={unit.name} title={unit.name}>{unit.name}</b></span></div>;
        })}</div></div></div> : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="添加资产后显示单位统计" />}
      </Card></div></section>
      <section className="dashboard-widget" data-module="records" aria-label="工作记录"><div className="dashboard-widget-content"><ReportsPage data={data} active={visible} embedded="entries" onOpenPage={openEntries} onFocusHandled={handleFocus} onChange={onReportsChange} /></div></section>
      <section className="dashboard-widget" data-module="calendar" aria-label="工作日历"><div className="dashboard-widget-content"><MemoizedWorkCalendarView data={data} active={visible} onOpenPage={openCalendar} onChange={onReportsChange} /></div></section>
    </div>
  </div>;
}

export default memo(DashboardPage);
