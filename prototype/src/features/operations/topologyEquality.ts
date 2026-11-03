import type { Topology } from './types';

// 编辑快照共享未变更的节点与图标；相同引用直接跳过，回到原值仍能解除未保存状态。
export function sameTopologyValue(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((value, index) => sameTopologyValue(value, right[index]));
  }
  const a = left as Record<string, unknown>, b = right as Record<string, unknown>;
  const keys = Object.keys(a).filter((key) => a[key] !== undefined);
  return keys.length === Object.keys(b).filter((key) => b[key] !== undefined).length
    && keys.every((key) => Object.hasOwn(b, key) && sameTopologyValue(a[key], b[key]));
}

export function sameTopology(left: Topology, right: Topology): boolean {
  return left === right || sameTopologyValue(left.nodes, right.nodes)
    && sameTopologyValue(left.edges, right.edges) && sameTopologyValue(left.regions ?? [], right.regions ?? []);
}
