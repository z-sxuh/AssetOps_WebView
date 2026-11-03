import { defaultFields, emptyVault, normalizeVault, type Asset, type VaultData } from '../src/model';
import { chinaDate, period, shiftDate } from '../src/features/reports/reportModel';

export const demoPassword = 'Prototype@125';

// 全部为虚构演示数据；不读取桌面应用数据库、备份或用户目录。
export function createDemoData(): VaultData {
  const date = chinaDate();
  const at = (days: number, time = '09:30:00') => `${shiftDate(date, days)}T${time}+08:00`;
  const units: VaultData['units'] = [
    { id: 'unit-demo', name: '示例单位', environments: [
      { id: 'env-production', name: '生产环境', zones: [
        { id: 'zone-business', name: '业务区', systems: [{ id: 'system-web', name: '官网平台' }, { id: 'system-office', name: '协同办公' }] },
        { id: 'zone-data', name: '数据区', systems: [{ id: 'system-data', name: '数据服务' }] },
      ] },
      { id: 'env-test', name: '测试环境', zones: [{ id: 'zone-test', name: '测试区', systems: [{ id: 'system-test', name: '集成测试' }] }] },
    ] },
    { id: 'unit-research', name: '示例研发中心', environments: [{ id: 'env-research', name: '研发环境', zones: [{ id: 'zone-research', name: '研发区', systems: [{ id: 'system-research', name: '研发平台' }] }] }] },
  ];
  const specs: Array<[string, string, string, string, Asset['status'], number, number]> = [
    ['system-web', 'Web服务器', 'web-01', '192.0.2.10', '生产', 4, 8],
    ['system-web', '应用服务器', 'app-01', '192.0.2.11', '生产', 8, 16],
    ['system-web', '数据库服务器', 'db-01', '192.0.2.12', '生产', 8, 32],
    ['system-web', '缓存服务器', 'redis-01', '192.0.2.13', '生产', 4, 16],
    ['system-web', '备用应用服务器', 'app-02', '192.0.2.14', '待切换', 8, 16],
    ['system-office', '协同办公服务器', 'office-01', '192.0.2.30', '生产', 8, 16],
    ['system-office', '文件服务器', 'files-01', '192.0.2.31', '生产', 4, 8],
    ['system-data', '数据交换服务器', 'etl-01', '198.51.100.10', '生产', 16, 32],
    ['system-data', '报表数据库', 'report-db', '198.51.100.11', '生产', 8, 32],
    ['system-test', '集成测试服务器', 'test-01', '203.0.113.10', '测试', 4, 8],
    ['system-test', '离线测试节点', 'test-02', '203.0.113.11', '关机', 2, 4],
    ['system-research', '研发构建服务器', 'build-01', '203.0.113.30', '测试', 16, 32],
  ];
  const assets: Asset[] = specs.map(([systemId, name, host, ip, status, cpu, memory], index) => {
    const unit = units.find(unit => unit.environments.some(environment => environment.zones.some(zone => zone.systems.some(system => system.id === systemId))))!;
    const environment = unit.environments.find(environment => environment.zones.some(zone => zone.systems.some(system => system.id === systemId)))!;
    const zone = environment.zones.find(zone => zone.systems.some(system => system.id === systemId))!;
    return {
      id: `asset-demo-${index + 1}`, unitId: unit.id, environmentId: environment.id, zoneId: zone.id, systemId,
      name, host, ip, status, cpu, memory, os: index % 3 === 0 ? 'Oracle Linux 7.9' : 'Rocky Linux 9.4',
      disks: [{ label: '/', capacity: 400, unit: 'G' }, ...(index === 2 ? [{ label: '/data', capacity: 1, unit: 'T' }] : [])],
      accounts: [{ id: `account-${index}`, username: 'root', password: `DemoOnly!${125 + index}`, passwordUpdatedAt: at(index < 2 ? -86 : -18).slice(0, 10) }],
      rotatePassword: index < 3, passwordCycleDays: 90, tags: ['演示数据'], custom: { notes: '虚构样例，仅用于 HTML 原型演示' },
      createdAt: at(-30), updatedAt: at(-index % 7),
    };
  });
  const topology: VaultData['opsSystems'][number]['topology'] = {
    nodes: [
      { id: 'node-firewall', label: '业务防火墙', role: '防火墙', iconKind: 'firewall', x: 320, y: 40, width: 160, height: 100 },
      { id: 'node-switch', label: '核心交换机', role: '交换机', iconKind: 'switch', x: 320, y: 220, width: 160, height: 100 },
      ...assets.slice(0, 4).map((asset, index) => ({ id: `node-${asset.id}`, assetId: asset.id, label: asset.name, role: '服务器', x: 40 + index * 230, y: 440, width: 180, height: 112, regionId: 'region-business' })),
    ],
    edges: [
      { id: 'edge-uplink', from: 'node-firewall', to: 'node-switch', fromPort: 'bottom', toPort: 'top', label: '业务网络', direction: 'forward' },
      ...assets.slice(0, 4).map((asset, index) => ({ id: `edge-${index}`, from: 'node-switch', to: `node-${asset.id}`, fromPort: 'bottom', toPort: 'top', label: index === 2 ? '数据库' : '', direction: 'forward' as const, routing: 'orthogonal' as const })),
    ],
    regions: [{ id: 'region-business', label: '业务服务区', x: 10, y: 390, width: 930, height: 200, color: '#3c8058' }],
  };
  const markdown = '# 官网平台\n\n> 本页面全部内容均为虚构样例，用于原型演示。\n\n## 系统概述\n\n官网平台提供内容发布、站点展示与统一访问服务。\n\n## 部署架构\n\n| 服务 | 主机名 | 内网 IP |\n| --- | --- | --- |\n| Web 服务 | web-01 | 192.0.2.10 |\n| 应用服务 | app-01 | 192.0.2.11 |\n| 数据库 | db-01 | 192.0.2.12 |\n\n## 日常运维\n\n- 检查服务状态和磁盘使用率\n- 检查数据库备份和日志\n- 按计划轮换服务器密码\n\n```bash\nsystemctl status nginx\ndf -h\n```\n';
  const sections = ['完成事项', '进行中事项', '问题与风险', '下期计划'] as const;
  const texts = ['完成官网平台日常巡检，服务运行正常', '核查数据库备份结果并完成恢复演练', '整理官网平台部署资料和网络拓扑', '推进应用服务器补丁更新', '跟进磁盘容量预警并制定扩容计划', '计划更新协同办公系统运维手册', '完成测试环境版本部署验证', '检查服务器密码轮换计划'];
  const entries = texts.map((text, index) => ({ id: `entry-demo-${index}`, text, section: sections[index % 4], at: at(-index, '10:00:00'), createdAt: at(-index), updatedAt: at(-index), unitId: units[0].id, environmentId: 'env-production', zoneId: 'zone-business', systemId: 'system-web', scopeName: '示例单位 / 生产环境 / 业务区 / 官网平台' }));
  const week = period('week', date);
  return normalizeVault({
    ...emptyVault, version: 4, defaultsRevision: 4, units, assets,
    fieldDefs: specs.map(spec => spec[0]).filter((value, index, all) => all.indexOf(value) === index).flatMap(defaultFields),
    fieldTemplates: [{ id: 'template-demo', name: '标准服务器模板', fields: defaultFields('').map(({ id: _id, systemId: _systemId, ...field }) => field), createdAt: at(-30), updatedAt: at(-3) }],
    settings: { ...emptyVault.settings, sidebarCollapsed: false, theme: 'spring', showPlainPassword: true, exportPlainPassword: false, startupBackup: false, reportUnitId: 'unit-demo', reportSystemId: 'system-web' },
    history: assets.slice(0, 8).map((asset, index) => ({ id: `change-demo-${index}`, assetId: asset.id, assetName: asset.name, objectType: 'asset', objectId: asset.id, objectName: asset.name, systemId: asset.systemId, action: index < 3 ? '编辑' : '新增', source: '手动', at: at(-index), note: '虚构演示记录', before: index < 3 ? { ...asset, cpu: 2 } : undefined, after: asset, items: [{ fieldKey: 'cpu', fieldLabel: 'CPU', before: index < 3 ? 2 : null, after: asset.cpu }] })),
    opsSystems: [{ id: 'ops-web', unitId: 'unit-demo', environmentId: 'env-production', zoneId: 'zone-business', systemId: 'system-web', scopeName: '示例单位 / 生产环境 / 业务区 / 官网平台', markdown, topology, assetIds: assets.slice(0, 4).map(asset => asset.id), updatedAt: at(-1), revisions: [
      { id: 'revision-demo-1', at: at(-5), note: '建立系统资料和网络拓扑', markdown, topology, assetIds: assets.slice(0, 3).map(asset => asset.id) },
      { id: 'revision-demo-2', at: at(-1), note: '补充缓存服务器与日常运维说明', markdown, topology, assetIds: assets.slice(0, 4).map(asset => asset.id) },
    ] }],
    reports: { entries, reports: [{ id: 'report-demo', kind: 'week', ...week, title: '系统运维周报（演示）', markdown: '# 系统运维周报\n\n## 完成事项\n\n- 完成官网平台巡检和数据库备份核查\n- 更新系统资料与网络拓扑\n\n## 进行中事项\n\n- 应用服务器补丁更新\n\n## 问题与风险\n\n- 关注数据盘容量增长\n\n## 下期计划\n\n- 完成扩容方案评估\n', sourceIds: entries.slice(0, 4).map(entry => entry.id), createdAt: at(-1), updatedAt: at(-1), revisions: [] }], calendar: { overrides: {}, exclusions: [{ id: 'calendar-demo', date: shiftDate(date, 2), part: 'pm', reason: '计划维护', note: '虚构演示事项' }], holidays: {}, tasks: [{ id: 'task-demo', title: '检查备份恢复演练结果', note: '虚构提醒，仅在原型页面内演示', dueAt: at(2, '16:00:00'), repeat: 'none', priority: 'normal', createdAt: at(-1), updatedAt: at(-1) }] } },
  });
}
