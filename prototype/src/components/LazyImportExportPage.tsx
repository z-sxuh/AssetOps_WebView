import { Component, lazy, Suspense, type ComponentProps } from 'react';
import { Alert, Button } from 'antd';
import type ImportExportPage from '../features/import-export/ImportExportPage';

const loadPage = () => import('../features/import-export/ImportExportPage');
export default class LazyImportExportPage extends Component<ComponentProps<typeof ImportExportPage>, { failed: boolean; Page: ReturnType<typeof lazy<typeof ImportExportPage>> }> {
  state = { failed: false, Page: lazy(loadPage) };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    if (this.state.failed) return <div className="page-content module-page"><Alert type="error" showIcon message="导入导出页面加载失败" description="请检查连接后重试。已保存的数据会继续保留。" action={<Button onClick={() => this.setState({ failed: false, Page: lazy(loadPage) })}>重试加载</Button>} /></div>;
    const Page = this.state.Page;
    return <Suspense fallback={<div className="page-content module-page" role="status" aria-busy="true">正在载入导入导出…</div>}><Page {...this.props} /></Suspense>;
  }
}
