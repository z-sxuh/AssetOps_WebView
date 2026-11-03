import type { Settings } from './model';
import { nextCronAt } from './cron';

type Schedule = Pick<Settings, 'scheduledBackup' | 'scheduledBackupMode' | 'scheduledBackupTime' | 'scheduledBackupIntervalHours'> & { scheduledBackupCron?: string };

// 新计划按 crontab 计算；未保存新计划的旧间隔配置继续保持原有时间语义。
export function nextBackupAt(settings: Schedule, now: Date, lastBackupAt: number | undefined, enabledAt: number): number | null {
  if (!settings.scheduledBackup) return null;
  if (settings.scheduledBackupCron) {
    try { return nextCronAt(settings.scheduledBackupCron, new Date(lastBackupAt ?? enabledAt)); }
    catch { return null; }
  }
  if (settings.scheduledBackupMode === 'interval') {
    return (lastBackupAt ?? enabledAt) + settings.scheduledBackupIntervalHours * 3_600_000;
  }
  const [hour, minute] = settings.scheduledBackupTime.split(':').map(Number);
  const next = new Date(now);
  next.setHours(hour, minute, 0, 0);
  if (lastBackupAt !== undefined && lastBackupAt >= next.getTime()) next.setDate(next.getDate() + 1);
  return next.getTime();
}
