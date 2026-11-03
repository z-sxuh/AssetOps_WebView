import { id, type Unit, type ObjectType } from '../../model';

type DirectorySystem = { name: string };
type DirectoryZone = { name: string; systems: DirectorySystem[] };
type DirectoryEnvironment = { name: string; zones: DirectoryZone[]; systems?: DirectorySystem[] };
export type DirectoryUnit = { name: string; environments: DirectoryEnvironment[] };
type AddedDirectory = { id: string; type: Exclude<ObjectType, 'asset'>; path: string };
const childKeys = ['environments', 'zones', 'systems'] as const;

export function exportOrganization(units: Unit[]) {
  return JSON.stringify({ format: 'workbench-organization', version: 1, units: units.map((unit) => ({ name: unit.name, environments: unit.environments.map((env) => ({ name: env.name, zones: env.zones.filter((zone) => zone.name).map((zone) => ({ name: zone.name, systems: zone.systems.map((system) => ({ name: system.name })) })), ...(env.zones.some((zone) => !zone.name) ? { systems: env.zones.filter((zone) => !zone.name).flatMap((zone) => zone.systems.map((system) => ({ name: system.name }))) } : {}) })) })) }, null, 2);
}

export function parseOrganization(text: string): DirectoryUnit[] {
  if (new TextEncoder().encode(text).byteLength > 2 * 1024 * 1024) throw new Error('组织目录文件不能超过 2 MB');
  const raw = JSON.parse(text);
  if (!raw || raw.format !== 'workbench-organization' || raw.version !== 1 || !Array.isArray(raw.units)) throw new Error('请选择本应用导出的组织目录 JSON（版本 1）');
  let count = 0;
  const read = (items: unknown[], depth: number): unknown[] => {
    const names = new Set<string>(); const key = childKeys[depth];
    return items.map((item) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('目录节点格式无效');
      const value = item as Record<string, unknown>;
      if (typeof value.name !== 'string' || !value.name.trim() || value.name.trim().length > 64 || /[\u0000-\u001f\u007f]/.test(value.name)) throw new Error('目录名称不能为空，最多 64 字，不能包含控制字符');
      const name = value.name.trim();
      if (names.has(name)) throw new Error(`同一层级出现重复目录：${name}`);
      names.add(name);
      if (++count > 20000) throw new Error('组织目录最多包含 20000 个节点');
      if (Object.keys(value).some((property) => property !== 'name' && property !== key && !(depth === 1 && property === 'systems'))) throw new Error(`目录“${name}”包含非目录字段`);
      if (depth === 1 && value.systems !== undefined && !Array.isArray(value.systems)) throw new Error(`目录“${name}”的 systems 必须是列表`);
      const children = depth === 1 && value[key] === undefined && Array.isArray(value.systems) ? [] : value[key];
      if (key && !Array.isArray(children)) throw new Error(`目录“${name}”缺少 ${key} 列表`);
      return key ? { name, [key]: read(children as unknown[], depth + 1), ...(depth === 1 && value.systems !== undefined ? { systems: read(value.systems as unknown[], 3) } : {}) } : { name };
    });
  };
  return read(raw.units, 0) as DirectoryUnit[];
}

// 按完整路径合并；源文件不携带 ID，不能覆盖其他目录的身份或资产关联。
export function mergeOrganization(units: Unit[], incoming: DirectoryUnit[]) {
  const next = structuredClone(units); const added: AddedDirectory[] = [];
  const types = ['unit', 'environment', 'zone', 'system'] as const;
  const merge = (target: Array<{ id: string; name: string }>, source: Array<{ name: string }>, depth: number, parents: string[]) => {
    const key = childKeys[depth];
    const byName = new Map<string, Array<{ id: string; name: string }>>();
    for (const node of target) { const matches = byName.get(node.name); if (matches) matches.push(node); else byName.set(node.name, [node]); }
    for (const item of source) {
      const matches = byName.get(item.name) ?? [];
      if (matches.length > 1) throw new Error(`现有目录存在重名，无法安全合并：${[...parents, item.name].join('/')}`);
      let node = matches[0]; const path = [...parents, item.name];
      if (!node) {
        node = { id: id(), name: item.name, ...(key ? { [key]: [] } : {}) };
        target.push(node); added.push({ id: node.id, type: types[depth], path: path.join('/') });
        byName.set(item.name, [node]);
      }
      if (key) merge((node as unknown as Record<string, Array<{ id: string; name: string }>>)[key], (item as unknown as Record<string, Array<{ name: string }>>)[key], depth + 1, path);
      if (depth === 1 && (item as DirectoryEnvironment).systems?.length) {
        const zones = (node as Unit['environments'][number]).zones;
        const direct = zones.filter((zone) => !zone.name);
        if (direct.length > 1) throw new Error(`现有目录存在重复的无区域分支：${path.join('/')}`);
        const zone = direct[0] ?? { id: id(), name: '', systems: [] };
        if (!direct.length) zones.push(zone);
        merge(zone.systems, (item as DirectoryEnvironment).systems!, 3, path);
      }
    }
  };
  merge(next, incoming, 0, []);
  return { units: next, added };
}
