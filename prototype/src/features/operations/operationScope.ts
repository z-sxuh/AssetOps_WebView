import type { Asset, Unit } from '../../model';
import { scopeValue, scopeTree, type EntryScope, type ScopeNode } from '../reports/reportModel';
import type { OpsSystem } from './types';

export const operationScopes = (units: Unit[]) => {
  const flatten = (node: ScopeNode): ScopeNode[] => [node, ...(node.children ?? []).flatMap(flatten)];
  return scopeTree(units).flatMap(flatten);
};
export const operationScopeKey = (system: OpsSystem, units: Unit[], nodes = operationScopes(units)) => nodes.find((node) => system.systemId ? node.scope.systemId === system.systemId : node.value === scopeValue(system))?.value ?? `archived:${system.id}`;
export function operationFocusKey(focusId: string, units: Unit[], systems: OpsSystem[]) {
  const scopes = operationScopes(units);
  const scope = scopes.find((node) => node.value === focusId || node.scope.systemId === focusId);
  const stored = systems.find((system) => system.id === focusId || system.systemId === focusId || operationScopeKey(system, units, scopes) === focusId);
  return scope?.value ?? (stored ? operationScopeKey(stored, units, scopes) : undefined);
}
export function assetsInScope(assets: Asset[], scope: EntryScope) {
  if (!scope.unitId) return [];
  return assets.filter((asset) => asset.unitId === scope.unitId && (!scope.environmentId || asset.environmentId === scope.environmentId) && (!scope.zoneId || asset.zoneId === scope.zoneId) && (!scope.systemId || asset.systemId === scope.systemId));
}
