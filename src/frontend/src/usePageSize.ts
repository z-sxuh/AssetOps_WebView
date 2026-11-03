import { useMemo, useState } from 'react';
import type { SelectProps } from 'antd';

export function usePageSize() {
  const [pageSize, setPageSize] = useState(25);
  const [search, setSearch] = useState('');
  const sizeChanger = useMemo<SelectProps>(() => {
    const custom = /^\d+$/.test(search) && Number.isSafeInteger(Number(search)) && Number(search) > 0 ? Number(search) : undefined;
    return {
      showSearch: true, 'aria-label': '每页条数，可输入自定义数量', filterOption: false,
      searchValue: search, onSearch: setSearch, onOpenChange: (open) => { if (!open) setSearch(''); }, onChange: () => setSearch(''),
      options: (search ? (custom ? [custom] : []) : Array.from(new Set([25, 50, 100, pageSize]))).map((value) => ({ value, label: `${value} 条/页` })),
    };
  }, [search, pageSize]);
  return { pageSize, setPageSize, sizeChanger };
}
