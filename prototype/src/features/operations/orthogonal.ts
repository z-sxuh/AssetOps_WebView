import type { TopologyNode, TopologyPoint } from './types';

type Box = { left: number; right: number; top: number; bottom: number };
const gap = 18;
const contains = (box: Box, p: TopologyPoint) => p.x > box.left && p.x < box.right && p.y > box.top && p.y < box.bottom;
export const blocksSegment = (box: Box, a: TopologyPoint, b: TopologyPoint) => a.x === b.x
  ? a.x > box.left && a.x < box.right && Math.max(a.y, b.y) > box.top && Math.min(a.y, b.y) < box.bottom
  : a.y > box.top && a.y < box.bottom && Math.max(a.x, b.x) > box.left && Math.min(a.x, b.x) < box.right;
export function simplifyPath(points: TopologyPoint[]) {
  const result: TopologyPoint[] = [];
  for (const p of points) {
    const a = result[result.length - 2]; const b = result[result.length - 1];
    if (b?.x === p.x && b.y === p.y) continue;
    if (a && b && ((a.x === b.x && b.x === p.x && (b.y - a.y) * (p.y - b.y) >= 0) || (a.y === b.y && b.y === p.y && (b.x - a.x) * (p.x - b.x) >= 0))) result.pop();
    result.push(p);
  }
  return result;
}
export function outsidePort(node: TopologyNode, p: TopologyPoint) {
  const width = node.width ?? 260; const height = node.height ?? 132;
  const distances = [Math.abs(p.y - node.y), Math.abs(p.x - node.x - width), Math.abs(p.y - node.y - height), Math.abs(p.x - node.x)];
  const side = distances.indexOf(Math.min(...distances));
  return { x: p.x + (side === 1 ? gap : side === 3 ? -gap : 0), y: p.y + (side === 2 ? gap : side === 0 ? -gap : 0) };
}
export function routingContext(nodes: TopologyNode[]) {
  const boxes = nodes.map((node) => ({ left: node.x - gap, right: node.x + (node.width ?? 260) + gap, top: node.y - gap, bottom: node.y + (node.height ?? 132) + gap }));
  const cells = new Map<string, Set<Box>>(); const cellSize = 320;
  for (const box of boxes) for (let x = Math.floor(box.left / cellSize); x <= Math.floor(box.right / cellSize); x++) for (let y = Math.floor(box.top / cellSize); y <= Math.floor(box.bottom / cellSize); y++) {
    const key = `${x},${y}`; if (!cells.has(key)) cells.set(key, new Set()); cells.get(key)!.add(box);
  }
  const clear = (a: TopologyPoint, b: TopologyPoint) => {
    const left = Math.floor(Math.min(a.x, b.x) / cellSize); const right = Math.floor(Math.max(a.x, b.x) / cellSize); const top = Math.floor(Math.min(a.y, b.y) / cellSize); const bottom = Math.floor(Math.max(a.y, b.y) / cellSize);
    if ((right - left + 1) * (bottom - top + 1) > boxes.length) return !boxes.some((box) => blocksSegment(box, a, b));
    for (let x = left; x <= right; x++) for (let y = top; y <= bottom; y++) for (const box of cells.get(`${x},${y}`) ?? []) if (blocksSegment(box, a, b)) return false;
    return true;
  };
  return { boxes, clear };
}
function route(a: TopologyPoint, b: TopologyPoint, boxes: Box[], clear: ReturnType<typeof routingContext>['clear']): TopologyPoint[] {
  const direct = [{ x: b.x, y: a.y }, { x: a.x, y: b.y }].map((p) => [a, p, b]);
  for (const points of direct) if (clear(points[0], points[1]) && clear(points[1], points[2])) return simplifyPath(points);
  const xs = [...new Set([a.x, b.x, ...boxes.flatMap((box) => [box.left, box.right])])].sort((a, b) => a - b);
  const ys = [...new Set([a.y, b.y, ...boxes.flatMap((box) => [box.top, box.bottom])])].sort((a, b) => a - b);
  const startX = xs.indexOf(a.x); const startY = ys.indexOf(a.y); const endX = xs.indexOf(b.x); const endY = ys.indexOf(b.y);
  type State = { x: number; y: number; direction: number; cost: number; score: number; key: number; parent?: State };
  const heap: State[] = []; const costs = new Map<number, number>();
  const push = (state: State) => { heap.push(state); let i = heap.length - 1; while (i > 0) { const parent = (i - 1) >> 1; if (heap[parent].score <= state.score) break; heap[i] = heap[parent]; i = parent; } heap[i] = state; };
  const pop = () => { const first = heap[0]; const last = heap.pop()!; if (heap.length) { let i = 0; while (i * 2 + 1 < heap.length) { let child = i * 2 + 1; if (child + 1 < heap.length && heap[child + 1].score < heap[child].score) child++; if (heap[child].score >= last.score) break; heap[i] = heap[child]; i = child; } heap[i] = last; } return first; };
  push({ x: startX, y: startY, direction: -1, cost: 0, score: 0, key: -1 });
  let visited = 0;
  while (heap.length && visited++ < 60000) {
    const current = pop(); if (current.cost > (costs.get(current.key) ?? Infinity)) continue;
    if (current.x === endX && current.y === endY) { const result: TopologyPoint[] = []; for (let state: State | undefined = current; state; state = state.parent) result.push({ x: xs[state.x], y: ys[state.y] }); return simplifyPath(result.reverse()); }
    const p = { x: xs[current.x], y: ys[current.y] };
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const x = current.x + dx; const y = current.y + dy; if (x < 0 || y < 0 || x >= xs.length || y >= ys.length) continue;
      const q = { x: xs[x], y: ys[y] }; if (!clear(p, q)) continue;
      const direction = dx ? 0 : 1; const cost = current.cost + Math.abs(p.x - q.x) + Math.abs(p.y - q.y) + (current.direction >= 0 && current.direction !== direction ? 24 : 0);
      const key = (x * ys.length + y) * 2 + direction; if (cost >= (costs.get(key) ?? Infinity)) continue; costs.set(key, cost);
      push({ x, y, direction, key, cost, score: cost + Math.abs(q.x - b.x) + Math.abs(q.y - b.y), parent: current });
    }
  }
  // 重叠节点可能无可用通道；仍保留正交走线，避免生成斜线。
  return direct[0];
}
export function orthogonalPath(from: TopologyNode, to: TopologyNode, start: TopologyPoint, end: TopologyPoint, nodes: TopologyNode[], waypoints: TopologyPoint[] = [], context = routingContext(nodes)) {
  const { boxes, clear } = context;
  const anchors = [outsidePort(from, start), ...waypoints, outsidePort(to, end)];
  const points = [start];
  for (let i = 0; i < anchors.length - 1; i++) {
    const a = anchors[i], b = anchors[i + 1];
    // 用户锚点优先；仅在相邻段收窄对应障碍的留白，保持其它段的避障策略。
    const relaxed = boxes.some(box => contains(box, a) || contains(box, b));
    const local = relaxed ? boxes.map(box => contains(box, a) || contains(box, b) ? { left: box.left + gap, right: box.right - gap, top: box.top + gap, bottom: box.bottom - gap } : box).filter(box => !contains(box, a) && !contains(box, b)) : boxes;
    points.push(...route(a, b, local, relaxed ? (p, q) => !local.some(box => blocksSegment(box, p, q)) : clear));
  }
  points.push(end);
  return simplifyPath(points);
}
