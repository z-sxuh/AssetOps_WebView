import type { Unit } from '../../model';
import { parseWorkEntries } from './workEntryTransfer';

export type WorkEntryImportRequest = { request: number; file: File; units: Unit[]; existingIds: string[] };
export type WorkEntryImportResult = ReturnType<typeof parseWorkEntries> | { error: string };
export type WorkEntryImportResponse = { request: number; result: WorkEntryImportResult };

const worker = self as unknown as {
  onmessage: ((event: MessageEvent<WorkEntryImportRequest>) => void) | null;
  postMessage: (response: WorkEntryImportResponse) => void;
};
worker.onmessage = async ({ data }) => {
  try {
    const text = await data.file.text();
    const result = parseWorkEntries(text, data.units, data.existingIds.map(id => ({ id })));
    worker.postMessage({ request: data.request, result });
  } catch (error) {
    worker.postMessage({ request: data.request, result: { error: error instanceof Error ? error.message : String(error) } });
  }
};
