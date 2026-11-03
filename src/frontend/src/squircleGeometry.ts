export type SquircleRadii = readonly [number, number, number, number];
const paths = new Map<string, string>();

// 四角依次为左上、右上、右下、左下；局部采样保留长条直边与拼接处的方角。
export function getSquirclePath(width: number, height: number, radius: number | SquircleRadii, inset = 0): string {
  const radii = typeof radius === 'number' ? [radius, radius, radius, radius] : radius;
  const key = [width, height, ...radii, inset].join(',');
  const cached = paths.get(key);
  if (cached) return cached;
  const w = Math.max(0, width - inset * 2), h = Math.max(0, height - inset * 2);
  const [tl, tr, br, bl] = radii.map(value => Math.max(0, Math.min(value - inset, w / 2, h / 2)));
  const point = (x: number, y: number) => `${(x + inset).toFixed(3)} ${(y + inset).toFixed(3)}`;
  let path = `M ${point(tl, 0)}`;
  for (const [cx, cy, r, start] of [[w - tr, tr, tr, -Math.PI / 2], [w - br, h - br, br, 0], [bl, h - bl, bl, Math.PI / 2], [tl, tl, tl, Math.PI]]) {
    for (let i = 0; i <= 24; i++) {
      const angle = start + Math.PI / 2 * i / 24;
      const cos = Math.cos(angle), sin = Math.sin(angle);
      const distance = r / Math.pow(cos ** 4 + sin ** 4, .25);
      path += ` L ${point(cx + distance * cos, cy + distance * sin)}`;
    }
  }
  if (paths.size >= 256) paths.delete(paths.keys().next().value!);
  const result = `${path} Z`;
  paths.set(key, result);
  return result;
}
