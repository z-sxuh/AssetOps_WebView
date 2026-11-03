import { Button, Descriptions, Space, Tag, Typography } from 'antd';
import { CopyOutlined } from '@ant-design/icons';
import type { Asset, FieldDef } from '../model';
import { assetFieldValues } from '../assetValidation';
import { accountExpiryDate, rotationEnabled } from '../passwordPolicy';
import { diskCapacityText } from '../disks';
import { ledgerCopyText } from '../ledgerFields';
import BasicMarkdown from './BasicMarkdown';

const dateText = (value: unknown) => { const date = value ? new Date(String(value)) : null; return date && Number.isFinite(date.getTime()) ? date.toLocaleString('zh-CN', { hour12: false }) : '—'; };

export default function AssetDetailsFields({ asset, fields, showPlainPassword, onCopy }: { asset: Asset; fields: FieldDef[]; showPlainPassword: boolean; onCopy: (text: string, label: string) => Promise<void> }) {
  const values = { ...assetFieldValues(asset), created_at: asset.createdAt, updated_at: asset.updatedAt } as Record<string, unknown>;
  const defined = fields.filter(field => field.systemId === asset.systemId && (field.key !== 'pwd_expire_at' || rotationEnabled(asset.rotatePassword))).sort((a, b) => a.sortOrder - b.sortOrder);
  if (!defined.length) return <Typography.Text type="secondary">该系统尚未配置资产字段</Typography.Text>;
  const tagItem = { key: 'asset-tags', label: '标签', children: asset.tags?.length ? <Space wrap size={4}>{asset.tags.map((tag) => <Tag key={tag}>{tag}</Tag>)}</Space> : <Typography.Text type="secondary">—</Typography.Text> };
  const copy = (text: string, label: string) => <Button type="text" size="small" icon={<CopyOutlined />} disabled={!text} aria-label={`复制${label}`} title={`复制${label}`} onClick={() => void onCopy(text, label)} />;
  return <Descriptions className="asset-field-details" bordered size="small" column={1} items={[...defined.map(field => {
    const value = values[field.key]; let text = ledgerCopyText(value), content: React.ReactNode;
    if (field.key === 'password') return { key: field.id, label: field.label, children: asset.accounts.length ? <Space direction="vertical" size={2}>{asset.accounts.map(account => <Space key={account.id ?? account.username} size={3}><Typography.Text>{showPlainPassword ? account.password || '—' : account.password ? '••••••••' : '—'}</Typography.Text>{field.quickCopy && copy(account.password, `${field.label}（${account.username}）`)}</Space>)}</Space> : '—' };
    if (field.key === 'user') { text = asset.accounts.map(account => account.username).join('\n'); content = <span className="asset-detail-lines">{text || '—'}</span>; }
    else if (field.key === 'pwd_expire_at') { text = asset.accounts.map(account => { const date = accountExpiryDate(asset, account); return date ? date.toLocaleDateString('zh-CN') : ''; }).filter(Boolean).join('\n'); content = <span className="asset-detail-lines">{text || '—'}</span>; }
    else if (field.key === 'disks') content = <div className="disk-tags">{asset.disks.length ? asset.disks.map((disk, index) => <Tag key={`${disk.label}-${index}`}>{disk.label} · {diskCapacityText(disk)}</Tag>) : '—'}</div>;
    else if (field.type === 'password') content = showPlainPassword ? text || '—' : text ? '••••••••' : '—';
    else if (field.type === 'textarea') content = text ? <BasicMarkdown text={text} /> : '—';
    else if (['date', 'datetime'].includes(field.type)) content = dateText(value);
    else if (field.key === 'mem') content = value === null || value === undefined ? '—' : `${text} G`;
    else if (field.key === 'cpu') content = value === null || value === undefined ? '—' : `${text} 核`;
    else if (field.type === 'user' && Array.isArray(value)) { text = value.map(account => account.username ?? '').join('\n'); content = <span className="asset-detail-lines">{text || '—'}</span>; }
    else content = text || '—';
    return { key: field.id, label: field.label, children: field.quickCopy ? <Space size={3}>{content}{copy(text, field.label)}</Space> : content };
  }), tagItem]} />;
}
