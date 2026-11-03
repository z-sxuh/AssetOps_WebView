import { Extension, InputRule, type JSONContent } from '@tiptap/core';
import { Plugin, TextSelection, type EditorState } from '@tiptap/pm/state';
import StarterKit from '@tiptap/starter-kit';
import Image from '@tiptap/extension-image';
import { TableKit } from '@tiptap/extension-table';
import { Markdown } from '@tiptap/markdown';
import { normalizeCodeBlockLanguages, safeMarkdownUrl, sanitizeMarkdownLinks } from './markdownText';

const safeImageUrl = (url: string) => safeMarkdownUrl(url, true);
const MarkdownImage = Image.extend({
  parseHTML() { return [{ tag: 'img[src]', getAttrs: (element) => safeImageUrl(element.getAttribute('src') ?? '') ? {} : false }]; },
  parseMarkdown(token, helpers) { return safeImageUrl(token.href ?? '') ? helpers.createNode('image', { src: token.href, alt: token.text, title: token.title }) : helpers.createTextNode(token.text ?? ''); },
  addInputRules() {
    return [new InputRule({ find: /(?:^|\s)(!\[([^\]\n]*)\]\((\S+?)(?:\s+"([^"]*)")?\))$/,
      handler: ({ state, range, match }) => {
        if (!safeImageUrl(match[3])) return null;
        // 当前版本的输入规则已插入触发字符，不再重复补写最后一个右括号。
        state.tr.replaceWith(range.from + match[0].indexOf(match[1]), range.to, this.type.create({ src: match[3], alt: match[2], title: match[4] ?? null })).scrollIntoView();
      },
    })];
  },
}).configure({ inline: true, allowBase64: false });

// 只转换顶层的两行基础表格；组词期间由 ProseMirror 保持原始输入。
export function markdownTableTransaction(state: EditorState, parse: (text: string) => JSONContent) {
  const { $from, empty } = state.selection;
  if (!empty || $from.depth !== 1 || $from.parent.type.name !== 'paragraph' || $from.parentOffset !== $from.parent.content.size || $from.index(0) === 0) return null;
  const separator = $from.parent.textContent;
  if (!/^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(separator)) return null;
  const header = state.doc.child($from.index(0) - 1);
  if (header.type.name !== 'paragraph') return null;
  const parsed = parse(`${header.textContent}\n${separator}`);
  if (parsed.content?.length !== 1 || parsed.content[0].type !== 'table') return null;
  const table = parsed.content[0]; const cells = table.content?.[0].content;
  if (!cells?.length) return null;
  table.content!.push({ type: 'tableRow', content: cells.map(() => ({ type: 'tableCell', content: [{ type: 'paragraph' }] })) });
  const node = state.schema.nodeFromJSON(table);
  const start = $from.before() - header.nodeSize;
  const tr = state.tr.replaceWith(start, $from.after(), node);
  return tr.setSelection(TextSelection.near(tr.doc.resolve(start + node.child(0).nodeSize + 4))).scrollIntoView();
}

const MarkdownInput = Extension.create({
  name: 'basicMarkdownInput', priority: 1100,
  addInputRules() {
    return [new InputRule({ find: /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|\s*$/,
      handler: ({ state }) => { if (!this.editor.markdown || !markdownTableTransaction(state, (text) => this.editor.markdown!.parse(text))) return null; },
    })];
  },
  addProseMirrorPlugins() {
    const editor = this.editor;
    return [new Plugin({ props: {
      handleKeyDown(view, event) {
        if (view.composing || event.isComposing || event.keyCode === 229 || event.key !== 'Enter' || !editor.markdown) return false;
        const tr = markdownTableTransaction(view.state, (text) => editor.markdown!.parse(text));
        if (!tr) return false;
        view.dispatch(tr); return true;
      },
      handlePaste(view, event) {
        const text = event.clipboardData?.getData('text/plain');
        if (view.composing || !text) return false;
        return editor.commands.insertContent(normalizeCodeBlockLanguages(sanitizeMarkdownLinks(text)), { contentType: 'markdown' });
      },
      clipboardTextSerializer(slice) {
        return normalizeCodeBlockLanguages(editor.markdown!.serialize({ type: 'doc', content: slice.content.toJSON() }));
      },
    } })];
  },
});

export function basicMarkdownExtensions() {
  return [StarterKit.configure({ underline: false, codeBlock: { defaultLanguage: 'bash' },
    link: { markdownLinks: true, openOnClick: false, isAllowedUri: (url) => safeMarkdownUrl(url) },
  }), MarkdownImage, TableKit.configure({ table: { resizable: false } }), Markdown, MarkdownInput];
}
