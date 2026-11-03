import type { Environment, NetworkZone, System, Unit } from '../../model';

export type ImportTarget = { unit: Unit; environment: Environment; zone: NetworkZone; system: System };
export type SystemChoice = { label: string; systemId: string };

export const importTargetPath = (item: ImportTarget) => [item.unit.name, item.environment.name, item.zone.name, item.system.name].filter(Boolean).join(' / ');

export function resolveImportSystem(
  row: Record<string, unknown>, targets: ImportTarget[], choices: SystemChoice[] = [],
  sheetTarget?: string, confirmedSheetTarget?: string,
): { target?: ImportTarget; error?: string } {
  const value = String(row.system ?? '').trim();
  if (!value) {
    const present = Array.isArray(row.presentColumns) && row.presentColumns.includes('system');
    const target = targets.find((item) => item.system.id === (present ? confirmedSheetTarget : sheetTarget));
    return target ? { target } : { error: present ? '业务系统为空，请填写或明确选择工作表目标系统' : '请选择工作表目标系统' };
  }
  const mapped = choices.filter((choice) => choice.label.trim().toLowerCase() === value.toLowerCase());
  if (mapped.length) {
    if (new Set(mapped.map((choice) => choice.systemId)).size !== 1) return { error: `业务系统“${value}”映射不唯一` };
    const target = targets.find((item) => item.system.id === mapped[0].systemId);
    return target ? { target } : { error: `业务系统“${value}”对应的系统已不存在，请重新选择` };
  }
  const unit = String(row.unit ?? '').trim();
  const environment = String(row.environment ?? '').trim();
  const zone = String(row.zone ?? '').trim();
  const matches = targets.filter((item) =>
    (!unit || item.unit.name === unit || item.unit.id === unit)
    && (!environment || item.environment.id === environment || item.environment.name.toLowerCase() === environment.toLowerCase())
    && (!zone || item.zone.id === zone || item.zone.name.toLowerCase() === zone.toLowerCase())
    && [item.system.id, item.system.name, importTargetPath(item)].some((name) => name.toLowerCase() === value.toLowerCase()));
  if (matches.length === 1) return { target: matches[0] };
  if (matches.length > 1) {
    const confirmed = matches.find((item) => item.system.id === confirmedSheetTarget);
    return confirmed ? { target: confirmed } : { error: `业务系统“${value}”有重名，请补充单位 / 环境 / 网络区域或明确选择目标` };
  }
  return { error: `业务系统“${value}”不存在，请填写实际系统` };
}
