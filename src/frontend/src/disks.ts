import type { Disk } from './model';

export function parseDisks(value: string): Disk[] {
  return value.split(/[;；\r\n]/).map((line) => line.trim()).filter(Boolean).map((line) => {
    const [label, capacityText] = line.split(/[:|]/, 2).map((part) => part.trim());
    const match = capacityText?.match(/^(\d+(?:\.\d+)?)\s*([a-zA-Z]*)$/);
    const unit = match?.[2].toUpperCase() ?? '';
    if (!label || !match || Number(match[1]) <= 0 || !/^(?:[KMGTPE](?:I?B)?|B)?$/.test(unit)) throw new Error(`硬盘“${line}”格式无效，请填写如 sda|500G 或 /data|1T`);
    return { label, capacity: Number(match[1]), unit };
  });
}

export function diskCapacityText(disk: Disk) {
  return `${disk.capacity}${disk.unit ?? 'G'}`;
}
