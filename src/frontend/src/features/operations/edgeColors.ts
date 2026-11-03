import type { TopologyEdge } from './types';
export const edgeColors = [
  { value: '#8a9c88', label: '灰绿' }, { value: '#287a54', label: '绿色' },
  { value: '#397fc2', label: '蓝色' }, { value: '#c94c4c', label: '红色' },
  { value: '#d47b30', label: '橙色' }, { value: '#b59a27', label: '黄色' },
  { value: '#8763bb', label: '紫色' }, { value: '#249b9b', label: '青色' },
  { value: '#c76899', label: '粉色' }, { value: '#8c684e', label: '棕色' },
];
export const validEdgeColor = (color: unknown): color is string => typeof color === 'string' && /^#[\da-f]{6}$/i.test(color);
export const edgeColor = (edge: TopologyEdge) => validEdgeColor(edge.color) ? edge.color.toLowerCase() : edgeColors[0].value;
