import { getLunarDate, getSolarTerms } from 'chinese-days';

export function calendarLabels(date: string): string[] {
  const supported = date >= '1900-01-31' && date <= '2100-12-31';
  return supported ? getSolarTerms(date).map((term) => term.name) : [];
}
export function lunarDate(date: string) {
  if (date < '1900-01-31' || date > '2100-12-31') return '';
  const lunar = getLunarDate(date);
  return `${lunar.isLeap ? '闰' : ''}${lunar.lunarMonCN}${lunar.lunarDayCN}`;
}
