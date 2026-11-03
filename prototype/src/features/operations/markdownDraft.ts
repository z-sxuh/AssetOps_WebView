export type MarkdownDraft = { base: string; markdown: string };
export const markdownDraftKey = (scope: string) => `assetops:operations-markdown:v1:${scope}`;

export function createOperationDraftStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() { return values.size; },
    key: index => [...values.keys()][index] ?? null,
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
    removeItem: key => { values.delete(key); },
    clear: () => values.clear(),
  };
}

export function clearLegacyOperationDrafts(storage: Storage) {
  const keys = Array.from({ length: storage.length }, (_, index) => storage.key(index));
  for (const key of keys) if (key?.startsWith('assetops:operations-markdown:')) storage.removeItem(key);
}

function parseDraft(value: string): MarkdownDraft {
  let draft: unknown;
  try { draft = JSON.parse(value); } catch { throw new Error('本地 Markdown 草稿格式异常，原内容已保留'); }
  if (!draft || typeof draft !== 'object' || !('base' in draft) || !('markdown' in draft) || typeof draft.base !== 'string' || typeof draft.markdown !== 'string') throw new Error('本地 Markdown 草稿格式异常，原内容已保留');
  return draft as MarkdownDraft;
}

export function readMarkdownDraft(storage: Storage, scope: string, base: string): MarkdownDraft | undefined {
  const value = storage.getItem(markdownDraftKey(scope)); if (!value) return;
  const draft = parseDraft(value);
  if (draft.markdown === base) { storage.removeItem(markdownDraftKey(scope)); return; }
  if (draft.base !== base) throw new Error('已保存的系统信息发生变化，本地旧草稿已保留，未覆盖当前资料');
  return draft;
}

export function writeMarkdownDraft(storage: Storage, scope: string, base: string, markdown: string) {
  if (markdown === base) storage.removeItem(markdownDraftKey(scope));
  else storage.setItem(markdownDraftKey(scope), JSON.stringify({ base, markdown } satisfies MarkdownDraft));
}

export function discardMarkdownDraft(storage: Storage, scope: string) { storage.removeItem(markdownDraftKey(scope)); }

export function markMarkdownDraftSaved(storage: Storage, scope: string, saved: string) {
  const value = storage.getItem(markdownDraftKey(scope)); if (!value) return;
  // 编辑事件同步写入缓存；保存完成时以缓存里的最新内容为准，保留保存期间继续输入的文字。
  writeMarkdownDraft(storage, scope, saved, parseDraft(value).markdown);
}
