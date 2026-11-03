import { parseCalendarItems } from './calendarTransfer';
import type { WorkCalendar } from './types';
export type CalendarImportResult = { value: ReturnType<typeof parseCalendarItems> } | { error: string };
const worker = self as unknown as { onmessage: ((event: MessageEvent<{ file: File; existing: Pick<WorkCalendar, 'tasks' | 'exclusions'> }>) => void) | null; postMessage: (result: CalendarImportResult) => void };
worker.onmessage = async ({ data }) => {
  try { worker.postMessage({ value: parseCalendarItems(await data.file.text(), data.existing) }); }
  catch (reason) { worker.postMessage({ error: reason instanceof Error ? reason.message : String(reason) }); }
};
