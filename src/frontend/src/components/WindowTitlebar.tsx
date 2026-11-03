import { useEffect, useState } from 'react';
import { CloseOutlined, MinusOutlined, BorderOutlined, CopyOutlined } from '@ant-design/icons';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { native } from '../native';

export default function WindowTitlebar({ collapsed, sidebar = false, onError }: {
  collapsed?: boolean; sidebar?: boolean; onError: (reason: unknown) => void;
}) {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    if (!native.desktop) return;
    const appWindow = getCurrentWindow();
    let disposed = false;
    let unlisten: (() => void) | undefined;
    const update = () => { void appWindow.isMaximized().then((value) => { if (!disposed) setMaximized(value); }).catch(onError); };
    update();
    void appWindow.onResized(update).then((stop) => { if (disposed) stop(); else unlisten = stop; }).catch(onError);
    return () => { disposed = true; unlisten?.(); };
  }, [onError]);

  const run = (action: 'minimize' | 'toggleMaximize' | 'close') => {
    if (native.desktop) void getCurrentWindow()[action]().catch(onError);
  };

  return <div className={`window-titlebar${collapsed ? ' is-collapsed' : ''}${sidebar ? '' : ' is-gate'}`}>
    {sidebar && <div className="window-titlebar-sidebar" data-tauri-drag-region />}
    <div className="window-titlebar-main"><div className="window-titlebar-drag" data-tauri-drag-region />
    <div className="window-controls">
      <button type="button" aria-label="最小化" title="最小化" onClick={() => run('minimize')}><MinusOutlined /></button>
      <button type="button" aria-label={maximized ? '还原窗口' : '最大化'} title={maximized ? '还原窗口' : '最大化'} onClick={() => run('toggleMaximize')}>{maximized ? <CopyOutlined /> : <BorderOutlined />}</button>
      <button type="button" className="window-close" aria-label="关闭窗口" title="关闭窗口" onClick={() => run('close')}><CloseOutlined /></button>
    </div></div>
  </div>;
}
