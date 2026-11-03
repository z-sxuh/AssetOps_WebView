import React from 'react';
import ReactDOM from 'react-dom/client';
import 'antd/dist/reset.css';
import App from './App';
import SearchWindow from './components/SearchWindow';
import AutoHideScrollbars from './components/AutoHideScrollbars';
import FloatingSurfaceMotion from './components/FloatingSurfaceMotion';
import SquircleSurfaces from './components/SquircleSurfaces';
import TableA11yGuard from './components/TableA11yGuard';
import ErrorBoundary from './components/ErrorBoundary';
import { clearLegacyOperationDrafts } from './features/operations/markdownDraft';
import './styles.css';
import './floating-surfaces.css';
import './squircle.css';

try { clearLegacyOperationDrafts(localStorage); } catch { /* 禁用存储时不写入任何草稿。 */ }

// 仅阻止 WebView 外壳菜单；编辑区保留系统剪贴板与拼写菜单。
document.addEventListener('contextmenu', (event) => {
  if (!(event.target instanceof Element) || !event.target.closest('input, textarea, [contenteditable="true"]')) event.preventDefault();
}, true);

const searchWindow = new URLSearchParams(window.location.search).has('searchWindow');

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary scope="工作台">
      <AutoHideScrollbars />
      <FloatingSurfaceMotion />
      <SquircleSurfaces />
      <TableA11yGuard />
      <ErrorBoundary scope={searchWindow ? '全局搜索' : '主界面'}>
        {searchWindow ? <SearchWindow /> : <App />}
      </ErrorBoundary>
    </ErrorBoundary>
  </React.StrictMode>,
);
