export const reportSections = ['完成事项', '进行中事项', '问题与风险', '下期计划'] as const;
export type ReportSection = typeof reportSections[number];
export type ReportKind = 'day' | 'week' | 'month' | 'year';
export type WorkEntry = {
  id: string; text: string; section: ReportSection; at: string; createdAt: string; updatedAt: string;
  unitId?: string; environmentId?: string; zoneId?: string; systemId?: string; scopeName: string;
};
export type ReportRevision = { id: string; at: string; markdown: string; sourceIds: string[]; reason: string };
export type WorkReport = {
  id: string; kind: ReportKind; start: string; end: string; title: string; markdown: string;
  sourceIds: string[];
  createdAt: string; updatedAt: string; revisions: ReportRevision[];
  effectiveWorkdays?: number;
  includeRecordTime?: boolean;
  calendarEvents?: WorkCalendar['exclusions'];
};
export type WorkReminder = {
  id: string; title: string; note: string; dueAt: string; repeat: 'none' | 'daily' | 'weekly' | 'monthly';
  priority: 'normal' | 'high'; completedAt?: string; notifiedFor?: string; repeatDay?: number; repeatAnchorAt?: string;
  createdAt: string; updatedAt: string;
};
export type WorkCalendar = {
  overrides: Record<string, boolean>;
  exclusions: Array<{ id: string; date: string; part: 'day' | 'am' | 'pm'; reason: string; note?: string; weekly?: { weekdays: number[]; until?: string } }>;
  holidays?: Record<string, { workday: boolean; name: string }>;
  tasks?: WorkReminder[];
};
export type ReportsData = { entries: WorkEntry[]; reports: WorkReport[]; calendar: WorkCalendar };
