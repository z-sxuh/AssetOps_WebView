import { useEffect, useLayoutEffect, useId, useMemo, useRef, useState } from 'react';
import { Tooltip } from 'antd';
import type { Asset, AssetStatus } from '../../model';
import type { WorkEntry } from '../reports/types';
import { chinaDate, shiftDate } from '../reports/reportModel';

export const statuses: AssetStatus[] = ['生产', '测试', '关机', '待切换'];
export const colors: Record<AssetStatus, string> = { 生产: 'var(--green)', 测试: 'var(--blue)', 关机: 'var(--neutral)', 待切换: 'var(--amber)' };
const overviewStatuses: AssetStatus[] = ['生产', '测试', '待切换', '关机'];

export function recentWorkCounts(entries: WorkEntry[], today = chinaDate()) {
  const days = Array.from({ length: 14 }, (_, index) => ({ date: shiftDate(today, index - 13), count: 0 }));
  const counts = new Map(days.map((day) => [day.date, day]));
  for (const entry of entries) { const day = counts.get(chinaDate(entry.at)); if (day) day.count += 1; }
  return days;
}

export default function StatusOverview({ visible, assets, entries }: { visible: boolean; assets: Asset[]; entries: WorkEntry[] }) {
  const root = useRef<HTMLDivElement>(null); const maskId = useId().replaceAll(':', '');
  const [active, setActive] = useState<number>();
  const wasVisible = useRef(false);
  const counts = useMemo(() => overviewStatuses.map((status) => assets.filter((asset) => asset.status === status).length), [assets]);
  const days = useMemo(() => recentWorkCounts(entries), [entries]);
  const points = useMemo(() => {
    const max = Math.max(10, ...days.map((day) => day.count));
    const values = days.map((day, index) => ({ ...day, x: 14 + index * 1072 / 13, y: 208 - day.count / max * 180, progress: 0 }));
    const distances = values.map((point, index) => index ? Math.hypot(point.x - values[index - 1].x, point.y - values[index - 1].y) : 0);
    const length = distances.reduce((sum, distance) => sum + distance, 0); let drawn = 0;
    return values.map((point, index) => { drawn += distances[index]; return { ...point, progress: index === 13 ? 1 : drawn / length }; });
  }, [days]);
  const statistics = `${counts.join(',')}|${points.map((point) => `${point.date}:${point.count}`).join(',')}`;
  useLayoutEffect(() => {
    const entering = visible && !wasVisible.current; wasVisible.current = visible;
    const element = root.current; if (!visible || !element) return;
    const sweep = element.querySelector('[data-sweep]'); const line = element.querySelector('[data-trend-line]');
    const segments = element.querySelector('[data-segments]'); const labels = element.querySelectorAll<HTMLElement>('[data-number]');
    const nodes = element.querySelectorAll<SVGGElement>('.overview-point');
    const render = (progress: number, trendProgress: number) => {
      sweep?.setAttribute('stroke-dashoffset', String(1 - progress)); line?.setAttribute('stroke-dashoffset', String(1 - trendProgress));
      segments?.setAttribute('opacity', String(.25 + .75 * progress));
      segments?.setAttribute('mask', progress === 1 ? 'none' : `url(#${maskId})`);
      labels.forEach((label) => { const value = Number(label.dataset.number) * progress; const text = label.dataset.percent === undefined ? String(Math.round(value)) : `${Math.round(value)}%`; if (label.textContent !== text) label.textContent = text; });
      nodes.forEach((node, index) => node.setAttribute('visibility', trendProgress >= points[index].progress ? 'visible' : 'hidden'));
    };
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)'); let frame = 0;
    const motionChanged = () => { if (reduced.matches) { cancelAnimationFrame(frame); frame = 0; render(1, 1); } };
    reduced.addEventListener('change', motionChanged);
    const cleanup = () => { cancelAnimationFrame(frame); reduced.removeEventListener('change', motionChanged); };
    if (!entering || reduced.matches) { render(1, 1); return cleanup; }
    render(0, 0); setActive(undefined); const start = performance.now();
    const tick = (now: number) => { const elapsed = now - start; const progress = Math.min(elapsed / 900, 1); render(Math.min(elapsed / 250, 1), progress); if (progress < 1) frame = requestAnimationFrame(tick); };
    frame = requestAnimationFrame(tick);
    return cleanup;
  }, [visible, statistics, maskId]);
  useEffect(() => {
    const hide = () => setActive(undefined); const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') hide(); };
    window.addEventListener('resize', hide); window.addEventListener('keydown', escape);
    return () => { window.removeEventListener('resize', hide); window.removeEventListener('keydown', escape); };
  }, []);
  let offset = 0;
  return <div ref={root} className="status-overview" onPointerDown={(event) => { if (!(event.target as Element).closest('.overview-point')) setActive(undefined); }}>
    <div className="overview-status-body">
      <div className="overview-donut">
        <svg viewBox="0 0 240 240" role="img" aria-label={`共 ${assets.length} 台资产`}>
          <defs><mask id={maskId}><circle data-sweep cx="120" cy="120" r="88" fill="none" stroke="white" strokeWidth="38" pathLength="1" strokeDasharray="1 1" transform="rotate(-90 120 120)" /></mask></defs>
          <circle cx="120" cy="120" r="88" fill="none" stroke="var(--inset)" strokeWidth="32" />
          <g data-segments mask={`url(#${maskId})`}>{overviewStatuses.map((status, index) => {
            const portion = assets.length ? counts[index] / assets.length : 0; if (!portion) return null;
            const segment = <Tooltip key={status} title={`${status}：${counts[index]} 台 · ${Math.round(portion * 100)}%`} trigger={['hover', 'focus']}><g className="overview-donut-segment" transform="rotate(-90 120 120)" tabIndex={0} role="img" aria-label={`${status}，${counts[index]}台，${Math.round(portion * 100)}%`}><circle className="overview-donut-fill" cx="120" cy="120" r="88" fill="none" stroke={colors[status]} strokeWidth="32" pathLength="1" strokeDasharray={portion === 1 ? undefined : `${portion} ${1 - portion}`} strokeDashoffset={-offset} /><circle aria-hidden="true" cx="120" cy="120" r="88" fill="none" stroke="transparent" strokeWidth="44" pathLength="1" strokeDasharray={portion === 1 ? undefined : `${portion} ${1 - portion}`} strokeDashoffset={-offset} /></g></Tooltip>;
            offset += portion; return segment;
          })}</g>
        </svg>
        <div className="overview-donut-center"><b data-number={assets.length}>{assets.length}</b><span>台资产</span></div>
      </div>
      <div className="overview-status-list" aria-label="服务器状态明细">{overviewStatuses.map((status, index) => {
        const percent = assets.length ? counts[index] / assets.length * 100 : 0;
        return <div className="overview-status-row" key={status}><span className="overview-status-name"><i className="status-dot" style={{ background: colors[status] }} />{status}</span><span className="overview-status-count" style={{ color: colors[status] }}><b data-number={counts[index]}>{counts[index]}</b><small>台</small></span><span className="overview-status-percent" style={{ color: colors[status] }} data-number={percent} data-percent>{Math.round(percent)}%</span></div>;
      })}</div>
    </div>
    <div className="overview-trend" role="region" aria-label="近14天每日工作记录数量">
      <svg viewBox="0 0 1100 230" preserveAspectRatio="none" role="group" aria-label="近14天每日工作记录数量折线图">
        <path data-trend-line className="overview-trend-line" pathLength="1" strokeDasharray="1 1" d={points.map((point, index) => `${index ? 'L' : 'M'} ${point.x} ${point.y}`).join(' ')} />
        {points.map((point, index) => <Tooltip key={point.date} title={<>{point.date}<br /><b>{point.count} 条工作记录</b></>} trigger={[]} open={active === index}><g className="overview-point" data-active={active === index || undefined} tabIndex={0} role="img" aria-label={`${point.date}，${point.count}条工作记录`} onClick={() => setActive(index)} onFocus={() => setActive(index)} onBlur={() => setActive(undefined)} onPointerEnter={(event) => { if (event.pointerType === 'mouse') setActive(index); }} onPointerLeave={(event) => { if (!event.currentTarget.contains(document.activeElement)) setActive(undefined); }}><circle className="overview-trend-node" cx={point.x} cy={point.y} r="3.5" /><circle className="overview-node-hit" cx={point.x} cy={point.y} r="15" /></g></Tooltip>)}
      </svg>
    </div>
  </div>;
}
