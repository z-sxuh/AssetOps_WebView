import type { Unit } from './model';

export function filterOrganizationTree(units: Unit[], query: string): { units: Unit[]; expanded: string[] } {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return { units, expanded: [] };
  const expanded = new Set<string>();
  const matches = (name: string) => name.toLocaleLowerCase().includes(needle);
  const filtered = units.flatMap(unit => {
    const environments = unit.environments.flatMap(environment => {
      const parentMatches = matches(unit.name) || matches(environment.name);
      const zones = environment.zones.flatMap(zone => {
        const branchMatches = parentMatches || Boolean(zone.name && matches(zone.name));
        const systems = zone.systems.filter(system => branchMatches || matches(system.name));
        if (!branchMatches && !systems.length) return [];
        if (zone.name && systems.length) expanded.add(zone.id);
        return [{ ...zone, systems }];
      });
      if (!parentMatches && !zones.length) return [];
      if (zones.length) expanded.add(environment.id);
      return [{ ...environment, zones }];
    });
    if (!matches(unit.name) && !environments.length) return [];
    if (environments.length) expanded.add(unit.id);
    return [{ ...unit, environments }];
  });
  return { units: filtered, expanded: [...expanded] };
}
