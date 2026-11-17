import { Component, type ErrorInfo, type ReactNode } from 'react'
import { AlertOctagon } from 'lucide-react'

interface Props {
  children: ReactNode
  /** 切换该值时自动重试（用于页面切换后恢复） */
  resetKey?: string
}

interface State {
  error: Error | null
}

/**
 * 页面级错误边界：单个页面渲染失败时不拖垮整个应用外壳，
 * 并把错误信息直接展示出来，便于定位（尤其是自检截图场景）。
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[renderer] page crashed', error, info.componentStack)
  }

  componentDidUpdate(prev: Props): void {
    if (prev.resetKey !== this.props.resetKey && this.state.error) {
      this.setState({ error: null })
    }
  }

  render(): ReactNode {
    const { error } = this.state
    if (!error) return this.props.children

    return (
      <div className="glass flex flex-col gap-3 p-6">
        <div className="flex items-center gap-2 text-state-danger">
          <AlertOctagon size={16} />
          <span className="text-body font-medium">该页面渲染失败</span>
        </div>
        <pre className="num max-h-[320px] overflow-auto rounded-lg border border-state-danger/20 bg-state-danger/[0.06] p-3 text-[11px] leading-5 text-fg-mid">
{error.message}
          {error.stack ? `\n\n${error.stack}` : ''}
        </pre>
        <button
          type="button"
          onClick={() => this.setState({ error: null })}
          className="btn w-fit text-caption"
        >
          重试渲染
        </button>
      </div>
    )
  }
}
