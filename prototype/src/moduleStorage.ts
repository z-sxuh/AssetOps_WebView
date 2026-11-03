import type { VaultData } from './model';
import type { StorageModule } from './storageSizeService';

const names: Record<StorageModule, string> = {
  home: '系统导览', ledger: '资产台账', operations: '系统运维', reports: '工作报告', fields: '字段定义',
  import: '导入导出', history: '历史变更', backup: '系统备份', settings: '系统设置',
};
const scopes: Record<StorageModule, string> = {
  home: '汇总视图不另存业务数据；资产和报告分别计入所属模块，布局配置计入系统设置。',
  ledger: '只统计已保存资产记录，不包含共享组织目录、字段定义和模板。',
  operations: '统计已保存系统资料、拓扑、关联和版本记录。',
  reports: '统计已保存工作记录、归档报告、日历和提醒事项。',
  fields: '统计字段定义和字段模板，不包含资产记录。',
  import: '本页不另存独立业务数据；导入结果计入资产、字段等所属模块，导出文件不计入主库。',
  history: '统计主库中的变更记录；外部归档文件不计入。',
  backup: '本页不在主库另存业务数据；备份文件大小见备份列表，备份配置计入系统设置。',
  settings: '统计已保存的偏好设置和布局配置。',
};

export function moduleStorage(key: StorageModule, data: VaultData) {
  const payloads: Record<StorageModule, object | undefined> = {
    home: undefined, ledger: data.assets.length ? data.assets : undefined,
    operations: data.opsSystems.length ? data.opsSystems : undefined, reports: data.reports,
    fields: data.fieldDefs.length || data.fieldTemplates.length ? { fieldDefs: data.fieldDefs, fieldTemplates: data.fieldTemplates } : undefined,
    import: undefined, history: data.history.length ? data.history : undefined, backup: undefined, settings: data.settings,
  };
  return { label: names[key], payload: payloads[key], title: `${scopes[key]}按已保存数据的 JSON UTF-8 字节统计，不含加密及 SQLite 公共页开销；无独立记录时为 0 B。` };
}
