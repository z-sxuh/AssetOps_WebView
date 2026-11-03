import type { Asset, ChangeItem } from './model';

export function assetDiff(before: Asset | undefined, after: Asset | undefined): ChangeItem[] {
  const labels: Array<[keyof Asset, string]> = [
    ['businessSystem', '业务系统'], ['name', '服务器名称'], ['host', '主机名'], ['ip', '主 IP'], ['ip2', '备用 IP'], ['status', '状态'],
    ['systemId', '所属系统'], ['cpu', 'CPU'], ['memory', '内存'], ['os', '操作系统'], ['disks', '硬盘'],
    ['accounts', '账号与密码'], ['rotatePassword', '定期改密'], ['passwordCycleDays', '密码周期'], ['tags', '标签'], ['custom', '自定义字段'],
  ];
  return labels.flatMap(([fieldKey, fieldLabel]) => {
    const left = before?.[fieldKey]; const right = after?.[fieldKey];
    return JSON.stringify(left ?? null) === JSON.stringify(right ?? null) ? [] : [{ fieldKey, fieldLabel, before: left ?? null, after: right ?? null }];
  });
}
