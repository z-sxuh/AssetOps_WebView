import { emit } from './event';
const appWindow = {
  label: 'main',
  async isMaximized() { return Boolean(document.fullscreenElement); },
  async onResized(handler: () => void) { window.addEventListener('resize', handler); return () => window.removeEventListener('resize', handler); },
  async minimize() { throw new Error('HTML 原型在浏览器中运行，请使用浏览器窗口的最小化按钮'); },
  async toggleMaximize() { if (document.fullscreenElement) await document.exitFullscreen(); else await document.documentElement.requestFullscreen(); },
  async close() { await emit('assetops-exit-request'); },
};
export function getCurrentWindow() { return appWindow; }
