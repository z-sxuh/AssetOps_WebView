import { Button, Typography } from 'antd';
import { storageSizeMessage, type StorageSize } from '../storageSizeService';

export default function StorageSizeLabel({ label, state, className, title }: { label: string; state: StorageSize & { retry: () => void }; className: string; title?: string }) {
  return <Typography.Text className={className} type="secondary" title={state.error ?? title}>
    <span role="status" aria-live="polite">{label}{storageSizeMessage(state)}</span>
    {state.error && <Button type="link" size="small" style={{ paddingInline: 4 }} disabled={state.pending} onClick={state.retry}>重试</Button>}
  </Typography.Text>;
}
