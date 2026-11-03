import type { Asset, VaultData } from '../../model';
import type { OpsSystem, SystemRevision } from './types';
import { chinaTime, scopeOptions } from '../reports/reportModel';
import { diskCapacityText } from '../../disks';
import { normalizeCodeBlockLanguages } from '../../components/markdownText';

function serverText(asset: Asset, data: VaultData) {
  const plain = data.settings.exportPlainPassword; const fields = data.fieldDefs.filter((field) => field.systemId === asset.systemId);
  const path = scopeOptions(data.units).find((scope) => scope.value === asset.systemId)?.pathLabel ?? '';
  const hardware = [asset.os, [asset.cpu == null ? '' : `${asset.cpu}v`, asset.memory == null ? '' : `${asset.memory}G`].filter(Boolean).join(',')].filter(Boolean).join(' - ');
  const lines = [`## ${asset.name}`, `ip-1：${asset.ip || '未设置'}`, ...(asset.ip2 ? [`ip-2：${asset.ip2}`] : []),
    ...(asset.host ? [`  - ${asset.host}`] : []), ...(path ? [`  - ${path} · ${asset.status}`] : [`  - ${asset.status}`]),
    ...(asset.businessSystem ? [`  - ${asset.businessSystem}`] : []),
    ...asset.accounts.map((account) => `  - ${account.username} / ${plain ? account.password : '******'}${asset.rotatePassword ? `（改密 ${chinaTime(account.passwordUpdatedAt)}，周期 ${asset.passwordCycleDays} 天）` : ''}`),
    ...(hardware ? [`  - ${hardware}`] : []), ...asset.disks.map((disk, index) => `  - disk-${index + 1}：[${disk.label}] - ${diskCapacityText(disk)}`),
    ...(asset.tags?.length ? [`  - ${asset.tags.join(' / ')}`] : []),
    ...Object.entries(asset.custom ?? {}).flatMap(([key, value]) => {
      const field = fields.find((item) => item.key === key);
      const text = !plain ? '******' : typeof value === 'object' ? JSON.stringify(value) : String(value ?? '');
      if (key !== 'notes' && !/[\r\n]/.test(text)) return [`  - ${field?.label ?? key}：${text}`];
      const lines = text.replace(/\r\n?/g, '\n').split('\n');
      if (key === 'notes' && lines[0] && !/^\s*#/.test(lines[0])) lines[0] = `# ${lines[0]}`;
      return [`  - ${field?.label ?? (key === 'notes' ? '备注' : key)}：`, ...lines.map((line) => `    ${line}`)];
    }), `  - 创建 ${chinaTime(asset.createdAt)} / 更新 ${chinaTime(asset.updatedAt)}`,
  ];
  return lines.join('\n');
}

export function systemMarkdown(system: OpsSystem, data: VaultData, topologyFile?: string, revision?: SystemRevision) {
  const ids = new Set([...(system.assetIds ?? []), ...system.topology.nodes.flatMap((node) => node.assetId ? [node.assetId] : [])]);
  const assets = data.assets.filter((asset) => ids.has(asset.id));
  const version = revision ?? system.revisions?.[system.revisions.length - 1];
  const title = (scopeOptions(data.units).find((scope) => scope.value === system.systemId)?.pathLabel || system.scopeName).replace(/[\r\n]+/g, ' ');
  const properties = [['导出时间', chinaTime()], ['版本时间', chinaTime(version?.at || system.updatedAt)], ['更新说明', version?.note || '—']].map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join('\n');
  const missing = [...ids].filter((id) => !assets.some((asset) => asset.id === id));
  const text = assets.map((asset) => serverText(asset, data)).join('\n\n--------------------------------------------------\n\n');
  // Keep passwords and notes containing backticks inside the single code block.
  let fenceLength = 3;
  for (const match of text.matchAll(/`+/g)) fenceLength = Math.max(fenceLength, match[0].length + 1);
  const fence = '`'.repeat(fenceLength);
  const imageLink = topologyFile ? encodeURIComponent(topologyFile).replace(/[()]/g, (char) => char === '(' ? '%28' : '%29') : '';
  return `---\n${properties}\n---\n\n# ${title}\n\n## 系统信息\n\n${normalizeCodeBlockLanguages(system.markdown) || '暂无系统信息。'}\n\n## 服务器信息\n\n${fence}bash\n${text || '未绑定服务器资产。'}\n${fence}\n${missing.length ? `\n关联已删除的资产：${missing.join('、')}\n` : ''}${imageLink ? `\n## 网络拓扑\n\n![网络拓扑](${imageLink})\n` : ''}`;
}
