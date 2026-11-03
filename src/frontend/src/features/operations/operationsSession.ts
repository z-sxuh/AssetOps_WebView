import { id, type Unit } from '../../model';
import { operationScopeKey, operationScopes } from './operationScope';
import { discardMarkdownDraft, markMarkdownDraftSaved, readMarkdownDraft, writeMarkdownDraft } from './markdownDraft';
import { parseTopology, topologyRegions } from './topology';
import { sameTopology, sameTopologyValue } from './topologyEquality';
import type { OpsSystem, SystemRevision } from './types';

export type OperationsContext = { units: Unit[]; systems: OpsSystem[]; scopes?: ReturnType<typeof operationScopes>; persist(systems: OpsSystem[]): Promise<void> };
type EditingSnapshot = { selected: string; draft?: OpsSystem; note: string };
const cleanTopology = (topology: OpsSystem['topology']) => ({ nodes: topology.nodes, edges: topology.edges, regions: topologyRegions(topology) });

export class OperationsSession {
  private snapshot: EditingSnapshot = { selected: '', note: '' };
  private baseline?: OpsSystem;
  private generation = 0;
  private saving = false;
  private listeners = new Set<() => void>();
  constructor(private storage: Storage, private notice: (kind: 'info' | 'warning', text: string) => void = () => {}) {}
  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private publish(value: Partial<EditingSnapshot>) { this.snapshot = { ...this.snapshot, ...value }; for (const listener of this.listeners) listener(); }
  select(selected: string, context: OperationsContext) {
    ++this.generation;
    const options = context.scopes ?? operationScopes(context.units);
    const stored = context.systems.find(item => operationScopeKey(item, context.units, options) === selected);
    const option = options.find(item => item.value === selected);
    const loaded: OpsSystem | undefined = stored ? { ...stored, assetIds: stored.assetIds ?? [], topology: cleanTopology(stored.topology) } : option ? { id: id(), ...option.scope, unitId: option.scope.unitId!, scopeName: option.path, assetIds: [], markdown: '', topology: { nodes: [], edges: [], regions: [] }, revisions: [], updatedAt: '' } : undefined;
    this.baseline = stored;
    try { if (selected) this.storage.setItem('assetops:operations-selected:v1', selected); } catch { /* 编辑时提示草稿保存失败。 */ }
    if (loaded) {
      try { const cached = readMarkdownDraft(this.storage, selected, stored?.markdown ?? ''); if (cached) { loaded.markdown = cached.markdown; this.notice('info', '已恢复本地 Markdown 草稿'); } }
      catch (error) { this.notice('warning', error instanceof Error ? error.message : '读取本地草稿失败'); }
    }
    this.publish({ selected, draft: loaded, note: '' });
  }
  edit(value: Partial<Pick<OpsSystem, 'markdown' | 'topology' | 'assetIds'>>) {
    const draft = this.snapshot.draft; if (!draft) return;
    this.publish({ draft: { ...draft, ...value } });
    if (value.markdown !== undefined) {
      try { writeMarkdownDraft(this.storage, this.snapshot.selected, this.baseline?.markdown ?? '', value.markdown); }
      catch { this.notice('warning', '本地草稿保存失败，请使用“保存并记录版本”保存资料'); }
    }
  }
  setNote(note: string) { this.publish({ note }); }
  discard() { discardMarkdownDraft(this.storage, this.snapshot.selected); }
  isDirty(context: OperationsContext) {
    const draft = this.snapshot.draft;
    const options = context.scopes ?? operationScopes(context.units);
    const current = context.systems.find(item => operationScopeKey(item, context.units, options) === this.snapshot.selected);
    return Boolean(draft && (draft.markdown !== (current?.markdown ?? '') || !sameTopologyValue(draft.assetIds ?? [], current?.assetIds ?? []) || !sameTopology(draft.topology, current?.topology ?? { nodes: [], edges: [], regions: [] })));
  }
  private current(context: OperationsContext) {
    const options = context.scopes ?? operationScopes(context.units);
    const current = context.systems.find(item => operationScopeKey(item, context.units, options) === this.snapshot.selected);
    if ((current?.updatedAt ?? '') !== (this.baseline?.updatedAt ?? '')) throw new Error('系统资料已更新，请切换系统后重新读取');
    return current;
  }
  private async run(operation: () => Promise<void>) {
    if (this.saving) throw new Error('系统资料正在保存，请稍后再操作');
    this.saving = true;
    try { await operation(); } finally { this.saving = false; }
  }
  save(context: OperationsContext) { return this.run(() => this.saveValue(context, this.snapshot.draft, this.snapshot.note)); }
  private async saveValue(context: OperationsContext, value: OpsSystem | undefined, saveNote: string) {
    if (!value) return;
    const options = context.scopes ?? operationScopes(context.units), selected = this.snapshot.selected;
    if (operationScopeKey(value, context.units, options) !== selected) throw new Error('目录选择已变化，请等待资料载入后重试');
    const current = this.current(context), editingSnapshot = this.snapshot.draft, generation = this.generation;
    const selection = options.find(item => item.value === selected), at = new Date().toISOString(), assetIds = value.assetIds ?? [];
    const safeValue = Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'deploymentVersion')) as unknown as OpsSystem;
    const next: OpsSystem = {
      ...safeValue, ...(selection?.scope ?? {}), scopeName: selection?.path ?? value.scopeName, assetIds: [...assetIds], topology: parseTopology(JSON.stringify(value.topology)), updatedAt: at,
      revisions: [...(current?.revisions ?? []).map(revision => ({ id: revision.id, at: revision.at, note: revision.note, markdown: revision.markdown, topology: cleanTopology(revision.topology), assetIds: revision.assetIds ?? [] })),
        { id: id(), at, note: saveNote.trim() || '更新系统资料', markdown: value.markdown, assetIds: [...assetIds], topology: structuredClone(cleanTopology(value.topology)) }],
    };
    await context.persist([...context.systems.filter(item => item.id !== next.id), next]);
    try { markMarkdownDraftSaved(this.storage, selected, next.markdown); }
    catch { this.notice('warning', '资料已保存，但本地草稿更新失败'); }
    if (this.generation === generation) {
      const draft = this.snapshot.draft;
      this.baseline = next;
      this.publish({ draft: draft === editingSnapshot ? next : draft ? { ...draft, revisions: next.revisions, updatedAt: at } : draft, note: this.snapshot.note === saveNote ? '' : this.snapshot.note });
    }
  }
  deleteRevision(context: OperationsContext, revisionId: string) {
    return this.run(async () => {
      const current = this.current(context); if (!current) throw new Error('系统资料已更新，请切换系统后重新读取');
      if (!current.revisions.some(item => item.id === revisionId)) throw new Error('版本记录已不存在');
      const generation = this.generation;
      const next = { ...current, revisions: current.revisions.filter(item => item.id !== revisionId), updatedAt: new Date().toISOString() };
      await context.persist(context.systems.map(item => item.id === next.id ? next : item));
      if (this.generation === generation) {
        this.baseline = next;
        const draft = this.snapshot.draft;
        this.publish({ draft: draft ? { ...draft, revisions: next.revisions, updatedAt: next.updatedAt } : draft });
      }
    });
  }
  rollback(context: OperationsContext, revision: SystemRevision, note: string) {
    return this.run(async () => {
      const current = this.current(context), draft = this.snapshot.draft;
      if (!current?.revisions.some(item => item.id === revision.id)) throw new Error('版本记录已不存在');
      if (draft) await this.saveValue(context, { ...draft, markdown: revision.markdown, assetIds: revision.assetIds ?? [], topology: structuredClone(cleanTopology(revision.topology)) }, note);
    });
  }
}
