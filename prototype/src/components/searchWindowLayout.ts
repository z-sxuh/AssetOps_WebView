// 与原生搜索窗口的 540px 高度上限一致；菜单内边距、边框及底部留白单独计入。
export const searchWindowMaxHeight = 540;
export function searchScopeLayout(contentBottom: number, triggerBottom: number) {
  const gap = 4, chrome = 14, bottomMargin = 16;
  const listHeight = Math.min(280, Math.max(28, Math.floor(searchWindowMaxHeight - triggerBottom - gap - chrome - bottomMargin)));
  const extraHeight = Math.max(0, Math.ceil(triggerBottom + gap + chrome + listHeight + bottomMargin - contentBottom));
  return { listHeight, extraHeight };
}
