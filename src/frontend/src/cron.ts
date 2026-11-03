type CronField = { values: number[]; star: boolean };
export type Cron = { minute: CronField; hour: CronField; day: CronField; month: CronField; week: CronField };

function field(text: string, min: number, max: number, name: string, sunday = false): CronField {
  const values = new Set<number>();
  for (const part of text.split(',')) {
    if (!/^(?:\*|\d+(?:-\d+)?)(?:\/\d+)?$/.test(part)) throw new Error(`${name}格式无效，支持数字、*、范围、逗号和 / 步长`);
    const [range, stepText] = part.split('/'); const step = stepText === undefined ? 1 : Number(stepText);
    const [start, end] = range === '*' ? [min, max] : range.includes('-') ? range.split('-').map(Number) : [Number(range), stepText ? max : Number(range)];
    if (step < 1 || step > max - min + 1 || start < min || end > max || start > end) throw new Error(`${name}范围应为 ${min}–${max}，步长必须为有效正整数`);
    for (let value = start; value <= end; value += step) values.add(sunday && value === 7 ? 0 : value);
  }
  return { values: [...values].sort((a, b) => a - b), star: text.startsWith('*') };
}

export function parseCron(expression: string): Cron {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error('请输入五段 crontab：分 时 日 月 周');
  return { minute: field(parts[0], 0, 59, '分钟'), hour: field(parts[1], 0, 23, '小时'), day: field(parts[2], 1, 31, '日期'), month: field(parts[3], 1, 12, '月份'), week: field(parts[4], 0, 7, '星期', true) };
}

// 使用本机时区；日与周都有限制时取并集，与 Linux crontab 一致。
export function nextCronAt(expression: string, after: Date): number | null {
  const cron = parseCron(expression); const since = after.getTime();
  if (!Number.isFinite(since)) return null;
  const date = new Date(after.getFullYear(), after.getMonth(), after.getDate());
  for (let count = 0; count < 366 * 8; count++, date.setDate(date.getDate() + 1)) {
    if (!cron.month.values.includes(date.getMonth() + 1)) continue;
    const day = cron.day.values.includes(date.getDate()); const week = cron.week.values.includes(date.getDay());
    if (!(cron.day.star || cron.week.star ? day && week : day || week)) continue;
    for (const hour of cron.hour.values) for (const minute of cron.minute.values) {
      const candidate = new Date(date.getFullYear(), date.getMonth(), date.getDate(), hour, minute);
      // 夏令时跳过的本地时间不能偏移到另一小时执行。
      if (candidate.getHours() === hour && candidate.getMinutes() === minute && candidate.getTime() > since) return candidate.getTime();
    }
  }
  return null;
}

export function validateBackupCron(expression: string) {
  const normalized = expression.trim().replace(/\s+/g, ' ');
  if (nextCronAt(normalized, new Date()) === null) throw new Error('此 crontab 没有有效执行日期，请检查日期与月份');
  return normalized;
}
