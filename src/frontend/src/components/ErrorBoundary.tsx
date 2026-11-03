import { Component, type ReactNode } from 'react';

type Props = { children: ReactNode; scope: string };
type State = { errorType?: string; copyMessage?: string };

export default class ErrorBoundary extends Component<Props, State> {
  state: State = {};

  static getDerivedStateFromError(error: unknown): State {
    const name = error instanceof Error ? error.name : 'Error';
    return { errorType: ['Error', 'TypeError', 'RangeError', 'ReferenceError', 'SyntaxError'].includes(name) ? name : 'Error' };
  }

  render() {
    if (!this.state.errorType) return this.props.children;
    const summary = `${this.props.scope}：界面渲染失败（${this.state.errorType}）`;
    return <div className="fatal-screen" role="alert">
      <div className="fatal-card">
        <div className="fatal-mark">!</div>
        <h1>{this.props.scope}遇到未处理错误</h1>
        <p>当前界面无法继续渲染。重新加载不会清除已保存的数据。</p>
        <code>{summary}</code>
        <div className="fatal-actions">
          <button type="button" onClick={() => location.reload()}>重新加载</button>
          <button type="button" className="secondary" onClick={async () => { try { await navigator.clipboard.writeText(summary); this.setState({ copyMessage: '错误信息已复制' }); } catch { this.setState({ copyMessage: '复制失败，请重试' }); } }}>复制错误信息</button>
        </div>
        {this.state.copyMessage && <p role="status">{this.state.copyMessage}</p>}
      </div>
    </div>;
  }
}
