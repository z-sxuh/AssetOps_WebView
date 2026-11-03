export function safeMarkdownUrl(url: string, image = false) {
  if (!url || /[\u0000-\u0020\u007f\\]/.test(url)) return false;
  if (/^[a-z][a-z\d+.-]*:/i.test(url)) return /^https?:\/\//i.test(url) || (!image && /^mailto:/i.test(url));
  return !url.startsWith('//');
}

export function sanitizeMarkdownLinks(text: string) {
  let fence = ''; let length = 0;
  return text.split(/(\r?\n)/).map((line) => {
    const marker = /^\s*(`{3,}|~{3,})([^\r\n]*)$/.exec(line);
    if (fence) { if (marker && marker[1][0] === fence && marker[1].length >= length && !marker[2].trim()) fence = ''; return line; }
    if (marker) { fence = marker[1][0]; length = marker[1].length; return line; }
    return line.replace(/(`+)(.*?)\1|\[([^\]\n]+)\]\(([^)\s]+)\)/g, (match, code: string, _content: string, label: string, href: string) =>
      code || safeMarkdownUrl(href) ? match : label,
    );
  }).join('');
}

export function normalizeCodeBlockLanguages(text: string) {
  let fence = ''; let length = 0;
  return text.replace(/^(\s*)(`{3,}|~{3,})([^\r\n]*)$/gm, (line, indent: string, marker: string, info: string) => {
    if (fence) {
      if (marker[0] === fence && marker.length >= length && !info.trim()) fence = '';
      return line;
    }
    fence = marker[0]; length = marker.length;
    return !info.trim() || info.trim() === 'ash' ? `${indent}${marker}bash` : line;
  });
}

export async function copyMarkdown(text: string) {
  try { await navigator.clipboard.writeText(text); return; } catch { /* WebView 不支持时使用选中文本复制。 */ }
  let written = false;
  const focused = document.activeElement as HTMLElement | null;
  const field = document.createElement('textarea'); field.value = text; field.readOnly = true;
  field.style.cssText = 'position:fixed;left:-10000px;top:0'; field.setAttribute('aria-hidden', 'true');
  document.body.appendChild(field); field.focus({ preventScroll: true }); field.select();
  // 先写入所请求的 Markdown，避免隐藏的富文本选区处理复制并覆盖源码。
  const copy = (event: ClipboardEvent) => { if (event.clipboardData) { event.clipboardData.setData('text/plain', text); event.preventDefault(); event.stopPropagation(); written = true; } };
  document.addEventListener('copy', copy, true);
  try { if (document.execCommand('copy') && written) return; }
  finally { document.removeEventListener('copy', copy, true); field.remove(); if (focused?.isConnected) focused.focus({ preventScroll: true }); }
  throw new Error('剪贴板不可用');
}
