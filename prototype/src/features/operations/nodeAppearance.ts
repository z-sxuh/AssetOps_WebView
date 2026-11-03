import type { Asset, Unit } from '../../model';
import type { TopologyNode } from './types';

export const iconKinds = { application: '应用服务器', file: '文件服务器', database: '数据库服务器', switch: '交换机', firewall: '防火墙' };
const drawings = {
  application: '<rect x="10" y="7" width="28" height="34" rx="4"/><path d="M16 15h16M16 23h16M16 31h10"/><circle cx="31" cy="31" r="1"/>',
  file: '<path d="M5 16h15l5-6h16v30H5z"/><path d="M5 20h36M14 28h18M14 34h12"/>',
  database: '<ellipse cx="24" cy="10" rx="16" ry="6"/><path d="M8 10v28c0 8 32 8 32 0V10M8 20c0 8 32 8 32 0M8 29c0 8 32 8 32 0"/>',
  switch: '<rect x="4" y="15" width="40" height="22" rx="4"/><path d="M10 23h6v7h-6zM21 23h6v7h-6zM32 23h6v7h-6zM14 8h20M30 4l4 4-4 4"/>',
  firewall: '<path d="M6 14h36v28H6zM6 24h36M6 33h36M17 14v10M30 14v10M12 24v9M25 24v9M36 24v9M18 33v9M31 33v9M20 12c-4-7 4-7 4-11 6 5 9 9 5 12"/>',
};
export function defaultIcon(node: TopologyNode) {
  if (node.iconKind && Object.hasOwn(iconKinds, node.iconKind)) return node.iconKind;
  const name = `${node.role} ${node.label}`;
  return /数据库|database|mysql|postgres|oracle|redis/i.test(name) ? 'database' : /防火墙|firewall/i.test(name) ? 'firewall' : /交换机|switch/i.test(name) ? 'switch' : /文件|file|nas/i.test(name) ? 'file' : node.assetId || /服务器|应用|server|web/i.test(name) ? 'application' : 'firewall';
}
const iconValidation = new Map<string, boolean>();
const builtinIcons = new Map<keyof typeof iconKinds, string>();
export function validIcon(value: string) {
  if (value.length > 190000) return false;
  const cached = iconValidation.get(value); if (cached !== undefined) return cached;
  const valid = validateIcon(value);
  if (iconValidation.size >= 1000) iconValidation.delete(iconValidation.keys().next().value!);
  iconValidation.set(value, valid);
  return valid;
}
function validateIcon(value: string) {
  if (value.length > 190000 || !/^data:image\/(png|jpeg|webp|svg\+xml);base64,[a-z\d+/]+=*$/i.test(value)) return false;
  try {
    const decoded = atob(value.slice(value.indexOf(',') + 1));
    if (/^data:image\/svg\+xml/i.test(value) && (!/<svg\b/i.test(decoded) || /<\s*(?:script|foreignObject|iframe|object|embed|image|use|a)\b|\bon\w+\s*=|(?:href|src)\s*=|url\s*\(\s*[^#]/i.test(decoded))) return false;
    return true;
  } catch { return false; }
}
export function nodeIcon(node: TopologyNode) {
  if (node.customIcon && validIcon(node.customIcon)) return node.customIcon;
  const kind = defaultIcon(node);
  if (!builtinIcons.has(kind)) builtinIcons.set(kind, `data:image/svg+xml;base64,${btoa(`<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 48 48" fill="none" stroke="#448364" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">${drawings[kind]}</svg>`)}`);
  return builtinIcons.get(kind)!;
}
export function nodeDetailsIndex(assets: Asset[], units: Unit[]) {
  const assetsById = new Map<string, Asset>();
  for (const asset of assets) if (!assetsById.has(asset.id)) assetsById.set(asset.id, asset);
  const environments = new Map<string, Map<string, string>>();
  for (const unit of units) {
    if (environments.has(unit.id)) continue;
    const names = new Map<string, string>();
    for (const environment of unit.environments) if (!names.has(environment.id)) names.set(environment.id, environment.name);
    environments.set(unit.id, names);
  }
  return { assetsById, environments };
}
export function nodeDetails(node: TopologyNode, assets: Asset[] | ReturnType<typeof nodeDetailsIndex>, units: Unit[] = []) {
  const asset = node.assetId ? Array.isArray(assets) ? assets.find((item) => item.id === node.assetId) : assets.assetsById.get(node.assetId) : undefined;
  const environment = Array.isArray(assets) ? units.find((unit) => unit.id === asset?.unitId)?.environments.find((env) => env.id === asset?.environmentId)?.name : asset && assets.environments.get(asset.unitId)?.get(asset.environmentId);
  return { name: asset?.name ?? node.label, host: asset?.host ?? node.host ?? '', ip: asset?.ip ?? node.ip ?? '', environment: environment ?? node.environment ?? '', tags: node.tags ?? asset?.tags ?? [], missing: Boolean(node.assetId && !asset) };
}

const textCache = new Map<string, string>();
let textContext: CanvasRenderingContext2D | null | undefined;
export function fitNodeText(text: string, width: number, size: number, bold = false) {
  const key = JSON.stringify([text, width, size, bold]);
  const cached = textCache.get(key); if (cached !== undefined) return cached;
  if (textContext === undefined) textContext = typeof document === 'undefined' ? null : document.createElement('canvas').getContext('2d');
  if (textContext) textContext.font = `${bold ? 700 : 400} ${size}px 'Microsoft YaHei UI','Microsoft YaHei','Segoe UI',sans-serif`;
  const measure = (value: string) => textContext ? textContext.measureText(value).width : Array.from(value).reduce((sum, char) => sum + (char.codePointAt(0)! > 255 ? size : size * .65), 0);
  let result = text;
  if (measure(text) > width) {
    const chars = Array.from(text); let left = 0; let right = chars.length;
    while (left < right) { const middle = Math.ceil((left + right) / 2); if (measure(chars.slice(0, middle).join('') + '…') <= width) left = middle; else right = middle - 1; }
    result = measure('…') <= width ? chars.slice(0, left).join('') + '…' : '';
  }
  if (textCache.size >= 4000) textCache.delete(textCache.keys().next().value!);
  textCache.set(key, result);
  return result;
}

type LayoutCacheEntry = { width: number; height: number; note: string; tags: string[]; layout: ReturnType<typeof layoutNode> };
const layoutCache = new Map<string, LayoutCacheEntry>();
export function nodeLayout(node: TopologyNode, tags: string[]) {
  const width = node.width ?? 260; const height = node.height ?? 132;
  const note = node.note ?? ''; const cached = layoutCache.get(node.id);
  if (cached && cached.width === width && cached.height === height && cached.note === note && cached.tags.length === Math.min(3, tags.length) && cached.tags.every((tag, index) => tag === tags[index])) return cached.layout;
  const layout = layoutNode(width, height, note, tags);
  if (layoutCache.size >= 2000 && !layoutCache.has(node.id)) layoutCache.delete(layoutCache.keys().next().value!);
  layoutCache.set(node.id, { width, height, note, tags: tags.slice(0, 3), layout });
  return layout;
}
function layoutNode(width: number, height: number, note: string, tags: string[]) {
  const tagCount = Math.min(3, tags.length);
  const maxChars = Math.max(4, Math.floor((width - 92) / 10)); const maxLines = Math.max(0, Math.floor((height - 72 - tagCount * 14) / 14));
  const notes: string[] = []; let line = ''; let count = 0; let offset = 0;
  if (maxLines) for (const char of note) {
    offset += char.length;
    if (char === '\r' && note[offset] === '\n') continue;
    if (char === '\n') { if (line) notes.push(line); line = ''; count = 0; continue; }
    if (notes.length === maxLines) { notes[maxLines - 1] = `${Array.from(notes[maxLines - 1]).slice(0, -1).join('')}…`; break; }
    line += char; count++;
    if (count === maxChars) { notes.push(line); line = ''; count = 0; }
  }
  if (line) notes.push(line);
  const iconY = (height - 48) / 2;
  const textY = (height - (58 + tagCount * 14 + notes.length * 14)) / 2 + 14;
  const badges = tags.slice(0, 3).map((tag) => {
    const label = tag.slice(0, Math.max(3, Math.floor((width - 90) / 9)));
    return { label, width: Array.from(label).reduce((size, char) => size + (char.charCodeAt(0) > 255 ? 9 : 5.5), 8) };
  });
  return { iconY, tagY: textY + 58, noteY: textY + 58 + tagCount * 14, textY, notes, badges };
}
