import { forwardRef, useEffect, useId, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { BoldOutlined, CodeOutlined, CodeSandboxOutlined, CopyOutlined, EditOutlined, FileMarkdownOutlined, FullscreenExitOutlined, FullscreenOutlined, ItalicOutlined, OrderedListOutlined, StrikethroughOutlined, TableOutlined, UndoOutlined, UnorderedListOutlined } from '@ant-design/icons';
import { Button, Dropdown, Input, Modal, Space, message } from 'antd';
import { createPortal } from 'react-dom';
import { EditorContent, useEditor, useEditorState } from '@tiptap/react';
import { basicMarkdownExtensions } from './markdownExtensions';
import { copyMarkdown, normalizeCodeBlockLanguages, sanitizeMarkdownLinks } from './markdownText';
import { composingCancel } from '../composition';

export type MarkdownEditorHandle = { flush(): string };
const MarkdownEditor = forwardRef<MarkdownEditorHandle, { value: string; onChange: (value: string) => void; onDirtyChange?: (dirty: boolean) => void; label: string; placeholder?: string; allowSource?: boolean; active?: boolean }>(function MarkdownEditor({ value, onChange, onDirtyChange, label, placeholder, allowSource = false, active = true }, ref) {
  const lastValue = useRef(value);
  const pendingChange = useRef(false), changeTimer = useRef<ReturnType<typeof setTimeout>>();
  const disposed = useRef(false);
  const flushChange = useRef<() => string>(() => lastValue.current);
  const callbacks = useRef({ onChange, onDirtyChange }); callbacks.current = { onChange, onDirtyChange };
  const markChanged = () => {
    if (!pendingChange.current) { pendingChange.current = true; callbacks.current.onDirtyChange?.(true); }
    clearTimeout(changeTimer.current);
    changeTimer.current = setTimeout(() => { if (!composing.current && !editor?.view.composing) flushChange.current(); }, 120);
  };
  const pendingValue = useRef<string>(); const composing = useRef(false); const compositionStart = useRef('');
  const [msg, context] = message.useMessage();
  const [codeOpen, setCodeOpen] = useState(false);
  const [codeLanguage, setCodeLanguage] = useState('bash');
  const [fullscreenOpen, setFullscreen] = useState(false); const fullscreen = active && fullscreenOpen;
  const [toolbarMenu, setToolbarMenu] = useState<'heading' | 'table'>();
  const [sourceMode, setSourceMode] = useState(false); const [sourceValue, setSourceValue] = useState(value);
  const sourceStart = useRef(value); const modeScroll = useRef({ rich: 0, source: 0 });
  const slot = useRef<HTMLDivElement>(null); const scrollPosition = useRef(0); const inlineHeight = useRef(0);
  const [host] = useState(() => { const node = document.createElement('div'); node.className = 'markdown-editor-host'; return node; });
  const editorId = useId();
  const activePane = () => host.querySelector<HTMLElement>('.markdown-tiptap-content:not([hidden])');
  const changeFullscreen = (next: boolean) => {
    if (composing.current) return;
    scrollPosition.current = activePane()?.scrollTop ?? 0;
    if (next) inlineHeight.current = slot.current?.getBoundingClientRect().height ?? 0;
    setFullscreen(next);
  };
  useLayoutEffect(() => () => host.remove(), [host]);
  useLayoutEffect(() => { if (!active) { setFullscreen(false); setToolbarMenu(undefined); setCodeOpen(false); } }, [active]);
  useLayoutEffect(() => {
    const focused = document.activeElement; const restoreFocus = focused instanceof HTMLElement && host.contains(focused);
    const owner = fullscreen ? slot.current?.closest<HTMLElement>('.ant-modal-wrap') : null;
    const previousOwner = owner?.dataset.editorOwner;
    const backgrounds = fullscreen ? [...document.querySelectorAll<HTMLElement>('[data-editor-background]'), ...(owner ? [owner] : [])].map(element => ({ element, inert: element.inert })) : [];
    if (fullscreen) { host.dataset.editorFullscreen = ''; host.dataset.editorOwner = editorId; if (owner) owner.dataset.editorOwner = editorId; backgrounds.forEach(({ element }) => { element.inert = true; }); }
    if (!active) scrollPosition.current = activePane()?.scrollTop ?? 0;
    (fullscreen ? document.body : slot.current)?.appendChild(host);
    if (restoreFocus) { if (active) focused.focus({ preventScroll: true }); else focused.blur(); }
    const pane = activePane(); if (pane) pane.scrollTop = scrollPosition.current;
    return () => {
      backgrounds.forEach(({ element, inert }) => { element.inert = inert; });
      delete host.dataset.editorFullscreen; delete host.dataset.editorOwner;
      if (owner) { if (previousOwner === undefined) delete owner.dataset.editorOwner; else owner.dataset.editorOwner = previousOwner; }
    };
  }, [fullscreen, host, active, editorId]);
  useLayoutEffect(() => { const pane = activePane(); if (pane) pane.scrollTop = scrollPosition.current; }, [sourceMode, host]);
  const editor = useEditor({
    extensions: basicMarkdownExtensions(),
    autofocus: false,
    content: normalizeCodeBlockLanguages(sanitizeMarkdownLinks(value)),
    contentType: 'markdown',
    onUpdate: () => {
      markChanged();
    },
    editorProps: { attributes: { role: 'textbox', 'aria-multiline': 'true', 'aria-label': label, spellcheck: 'true', ...(placeholder ? { 'data-placeholder': placeholder } : {}) },
      handleDOMEvents: {
        compositionstart: () => { composing.current = true; compositionStart.current = editor ? normalizeCodeBlockLanguages(editor.getMarkdown()) : lastValue.current; return false; },
        compositionend: (view) => {
          composing.current = false;
          // 等原生输入提交；不在 compositionend 中改写 contentEditable 或补写字符。
          window.setTimeout(() => {
            if (disposed.current || view.isDestroyed || view.composing || composing.current) return;
            if (pendingValue.current !== undefined) {
              const next = pendingValue.current; pendingValue.current = undefined;
              if (editor && normalizeCodeBlockLanguages(editor.getMarkdown()) === compositionStart.current) editor.commands.setContent(normalizeCodeBlockLanguages(sanitizeMarkdownLinks(next)), { contentType: 'markdown', emitUpdate: false });
            }
            if (editor) markChanged();
          }, 0);
          return false;
        },
      },
    },
  });
  const flush = () => {
    if (composing.current || editor?.view.composing) throw new Error('请先完成输入法组词');
    clearTimeout(changeTimer.current);
    const next = sourceMode ? sourceValue : editor ? normalizeCodeBlockLanguages(editor.getMarkdown()) : lastValue.current;
    if (next !== lastValue.current) { lastValue.current = next; callbacks.current.onChange(next); }
    if (pendingChange.current) { pendingChange.current = false; callbacks.current.onDirtyChange?.(false); }
    return next;
  };
  flushChange.current = flush;
  useImperativeHandle(ref, () => ({ flush }));
  useLayoutEffect(() => { if (!active && !composing.current && !editor?.view.composing) flushChange.current(); }, [active]);
  useLayoutEffect(() => { disposed.current = false; return () => { disposed.current = true; clearTimeout(changeTimer.current); }; }, []);
  const inTable = useEditorState({ editor, selector: ({ editor: current }) => current?.isActive('table') ?? false });

  useEffect(() => {
    if (!editor || value === lastValue.current) return;
    if (composing.current || editor.view.composing) { pendingValue.current = value; return; }
    clearTimeout(changeTimer.current);
    if (pendingChange.current) { pendingChange.current = false; callbacks.current.onDirtyChange?.(false); }
    lastValue.current = value;
    if (sourceMode) { setSourceValue(value); return; }
    editor.commands.setContent(normalizeCodeBlockLanguages(sanitizeMarkdownLinks(value)), { contentType: 'markdown', emitUpdate: false });
  }, [editor, value, sourceMode]);
  useEffect(() => { editor?.setEditable(!sourceMode, false); }, [editor, sourceMode]);

  const changeSource = (next: string) => {
    setSourceValue(next);
    if (composing.current || next === lastValue.current) return;
    lastValue.current = next; onChange(next);
  };
  const changeSourceMode = () => {
    if (!editor || composing.current || editor.view.composing) return;
    flush();
    modeScroll.current[sourceMode ? 'source' : 'rich'] = activePane()?.scrollTop ?? 0;
    if (sourceMode) {
      if (sourceValue !== sourceStart.current) editor.commands.setContent(normalizeCodeBlockLanguages(sanitizeMarkdownLinks(sourceValue)), { contentType: 'markdown', emitUpdate: false });
      scrollPosition.current = modeScroll.current.rich;
    } else { sourceStart.current = lastValue.current; setSourceValue(lastValue.current); scrollPosition.current = modeScroll.current.source; }
    setToolbarMenu(undefined);
    setSourceMode(!sourceMode);
  };

  useLayoutEffect(() => {
    if (!fullscreen) return;
    const overflow = document.body.style.overflow; document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = overflow; };
  }, [fullscreen]);

  const action = (labelText: string, run: () => void, icon?: ReactNode, disabled = sourceMode) => <Button key={labelText} size="small" aria-label={labelText} title={labelText} icon={icon} disabled={disabled} onClick={run}>{icon ? undefined : labelText}</Button>;
  const content = <div className={`markdown-tiptap${fullscreen ? ' is-fullscreen' : ''}`} onKeyDown={(event) => {
    if (fullscreen && event.key === 'Tab') event.stopPropagation();
    if (event.key !== 'Escape' || composing.current || composingCancel(event)) return;
    if (toolbarMenu) {
      event.preventDefault(); event.stopPropagation(); setToolbarMenu(undefined);
      host.querySelector<HTMLButtonElement>(`button[aria-label="${toolbarMenu === 'heading' ? '标题级别' : '表格'}"]`)?.focus({ preventScroll: true });
    } else if (fullscreen && !codeOpen) { event.preventDefault(); event.stopPropagation(); changeFullscreen(false); }
  }}>
    {context}
    <Space className="markdown-tiptap-toolbar" size={6} wrap>
      {action('撤销', () => editor?.chain().focus().undo().run(), <UndoOutlined />)}
      <Dropdown disabled={sourceMode} open={toolbarMenu === 'heading'} onOpenChange={(open) => setToolbarMenu(open ? 'heading' : undefined)} trigger={['click']} overlayStyle={{ zIndex: 1200 }} menu={{ items: [{ key: '0', label: '正文' }, ...[1, 2, 3, 4, 5, 6].map((level) => ({ key: String(level), label: `${level} 级标题` }))], onClick: ({ key }) => { setToolbarMenu(undefined); const chain = editor?.chain().focus(); if (!chain) return; if (key === '0') chain.setParagraph().run(); else chain.setHeading({ level: Number(key) as 1 | 2 | 3 | 4 | 5 | 6 }).run(); } }}><Button disabled={sourceMode} size="small" aria-label="标题级别" title="标题级别">标题</Button></Dropdown>
      {action('加粗', () => editor?.chain().focus().toggleBold().run(), <BoldOutlined />)}
      {action('斜体', () => editor?.chain().focus().toggleItalic().run(), <ItalicOutlined />)}
      {action('删除线', () => editor?.chain().focus().toggleStrike().run(), <StrikethroughOutlined />)}
      {action('引用', () => editor?.chain().focus().toggleBlockquote().run())}
      {action('无序列表', () => editor?.chain().focus().toggleBulletList().run(), <UnorderedListOutlined />)}
      {action('有序列表', () => editor?.chain().focus().toggleOrderedList().run(), <OrderedListOutlined />)}
      {action('行内代码', () => editor?.chain().focus().toggleCode().run(), <CodeOutlined />)}
      {action('代码块', () => { setCodeLanguage(editor?.getAttributes('codeBlock').language || 'bash'); setCodeOpen(true); }, <CodeSandboxOutlined />)}
      <Dropdown disabled={sourceMode} open={toolbarMenu === 'table'} onOpenChange={(open) => setToolbarMenu(open ? 'table' : undefined)} trigger={['click']} overlayStyle={{ zIndex: 1200 }} menu={{ items: [{ key: 'insert', label: '插入表格' }, ...[{ key: 'row', label: '增加行' }, { key: 'column', label: '增加列' }, { key: 'deleteRow', label: '删除行' }, { key: 'deleteColumn', label: '删除列' }, { key: 'delete', label: '删除表格' }].map((item) => ({ ...item, disabled: !inTable }))], onClick: ({ key }) => {
        setToolbarMenu(undefined); const chain = editor?.chain().focus(); if (!chain) return;
        if (key === 'insert') chain.insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run();
        else if (key === 'row') chain.addRowAfter().run(); else if (key === 'column') chain.addColumnAfter().run();
        else if (key === 'deleteRow') chain.deleteRow().run(); else if (key === 'deleteColumn') chain.deleteColumn().run(); else chain.deleteTable().run();
      } }}><Button disabled={sourceMode} size="small" aria-label="表格" title="表格" icon={<TableOutlined />} /></Dropdown>
      {action('复制 Markdown', () => { if (editor && !composing.current && !editor.view.composing) void copyMarkdown(flush()).then(() => msg.success('Markdown 已复制'), () => msg.error('复制失败，请使用 Ctrl+C 复制所选内容')); }, <CopyOutlined />, false)}
      {allowSource && <Button size="small" aria-label={sourceMode ? '切换富文本模式' : '切换 Markdown 源码模式'} title={sourceMode ? '富文本模式' : 'Markdown 源码模式'} aria-pressed={sourceMode} type={sourceMode ? 'primary' : 'default'} icon={sourceMode ? <EditOutlined /> : <FileMarkdownOutlined />} onClick={changeSourceMode} />}
      <Button size="small" aria-label={fullscreen ? '退出全屏' : '全屏编辑'} title={fullscreen ? '退出全屏' : '全屏编辑'} icon={fullscreen ? <FullscreenExitOutlined /> : <FullscreenOutlined />} onClick={() => changeFullscreen(!fullscreen)} />
    </Space>
    <EditorContent editor={editor} hidden={sourceMode} className="markdown-tiptap-content" />
    {sourceMode && <textarea className="markdown-tiptap-content markdown-source" aria-label={`${label}源码`} spellCheck={false} value={sourceValue} onChange={(event) => changeSource(event.target.value)}
      onCompositionStart={(event) => { composing.current = true; compositionStart.current = event.currentTarget.value; }}
      onCompositionEnd={(event) => {
        composing.current = false; let next = event.currentTarget.value;
        if (pendingValue.current !== undefined) { if (next === compositionStart.current) next = pendingValue.current; pendingValue.current = undefined; }
        changeSource(next);
      }} />}
    <Modal title="代码块语言" zIndex={1200} open={codeOpen} focusTriggerAfterClose={active} okText="应用" cancelText="取消" onCancel={(event) => { if (!composingCancel(event)) setCodeOpen(false); }} onOk={() => { editor?.chain().focus().setCodeBlock({ language: codeLanguage.trim() || 'bash' }).run(); setCodeOpen(false); }}>
      <Input autoFocus aria-label="代码块语言" value={codeLanguage} maxLength={64} placeholder="bash" onChange={(event) => setCodeLanguage(event.target.value)} />
    </Modal>
  </div>;
  return <><div ref={slot} className="markdown-editor-slot" style={{ height: fullscreen ? inlineHeight.current : undefined }} />{createPortal(content, host)}</>;
});
export default MarkdownEditor;
