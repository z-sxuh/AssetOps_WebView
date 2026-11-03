import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Button, Layout, Menu, type MenuProps } from 'antd';
import { MenuFoldOutlined, MenuUnfoldOutlined } from '@ant-design/icons';
import WindowTitlebar from './WindowTitlebar';

export default function WorkbenchLayout({ storedCollapsed, saving, page, items, brandIcon, onNavigate, onCollapsedChange, onWindowError, children }: {
  storedCollapsed: boolean; saving: boolean; page: string; items: MenuProps['items']; brandIcon: string;
  onNavigate: (page: string, pointer?: boolean) => void; onCollapsedChange: (collapsed: boolean) => Promise<void>;
  onWindowError: (error: unknown) => void; children: ReactNode;
}) {
  const [collapsed, setCollapsed] = useState(storedCollapsed);
  const desired = useRef(storedCollapsed);
  const savedByUs = useRef<boolean>();
  const pending = useRef(false);
  const mounted = useRef(true);
  const latest = useRef({ storedCollapsed, saving, onCollapsedChange }); latest.current = { storedCollapsed, saving, onCollapsedChange };
  const sidebarRef = useRef<HTMLDivElement>(null);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    if (savedByUs.current === storedCollapsed) { savedByUs.current = undefined; return; }
    desired.current = storedCollapsed; setCollapsed(storedCollapsed);
  }, [storedCollapsed]);
  useEffect(() => {
    if (saving || collapsed === storedCollapsed) return;
    // 先完成侧栏过渡，再保存偏好；反复点击只保存最后一次选择。
    const timer = window.setTimeout(async () => {
      if (latest.current.saving || pending.current) return;
      pending.current = true; savedByUs.current = collapsed;
      try { await latest.current.onCollapsedChange(collapsed); }
      catch {
        savedByUs.current = undefined;
        if (mounted.current && desired.current === collapsed) { desired.current = latest.current.storedCollapsed; setCollapsed(desired.current); }
      } finally { pending.current = false; }
    }, 450);
    return () => window.clearTimeout(timer);
  }, [collapsed, storedCollapsed, saving]);
  useEffect(() => {
    const sidebar = sidebarRef.current; if (!sidebar) return;
    const markClosing = (event: TransitionEvent) => { if (event.target === sidebar && event.propertyName === 'width' && sidebar.classList.contains('ant-layout-sider-collapsed')) sidebar.dataset.sidebarMotion = 'closing'; };
    const clear = () => { delete sidebar.dataset.sidebarMotion; };
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
    sidebar.addEventListener('transitionrun', markClosing); reduced.addEventListener('change', clear);
    return () => { sidebar.removeEventListener('transitionrun', markClosing); reduced.removeEventListener('change', clear); clear(); };
  }, []);
  const toggle = () => { desired.current = !desired.current; setCollapsed(desired.current); };
  return <>
    <WindowTitlebar sidebar collapsed={collapsed} onError={onWindowError} />
    <Layout className="app-shell" data-editor-background="">
      <Layout.Sider ref={sidebarRef} width={164} collapsedWidth={72} collapsed={collapsed} collapsible trigger={null} className="sidebar" theme="light"
        onTransitionEnd={(event) => { if (event.target === event.currentTarget && event.propertyName === 'width') delete event.currentTarget.dataset.sidebarMotion; }}>
        <div className="brand"><span className="brand-mark brand-image"><img src={brandIcon} alt="" /></span><div className="brand-copy"><b>工作台</b></div></div>
        <Menu mode="inline" inlineCollapsed={false} selectedKeys={[page]} items={items} onClick={({ key, domEvent }) => onNavigate(key, domEvent.detail > 0)} />
        <div className="sidebar-bottom"><Button className="collapse-button" type="text" title={collapsed ? '展开侧边栏' : '折叠侧边栏'} aria-label={collapsed ? '展开侧边栏' : '折叠侧边栏'}
          icon={collapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />} onClick={toggle} /></div>
      </Layout.Sider>
      <Layout className="main-layout" style={{ marginLeft: collapsed ? 72 : 164 }}>{children}</Layout>
    </Layout>
  </>;
}
