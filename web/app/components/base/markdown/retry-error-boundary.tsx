/**
 * RetryErrorBoundary (MOS web patch P-2, batch 20261016).
 *
 * 长 Markdown 表格 / 长文档（流式渲染中的 streamdown、rehype 管线）偶发渲染异常，
 * 历史上异常会直接冒泡到上层，导致整条消息渲染中断或半截。
 *
 * 本边界捕获子树渲染错误后：
 *   1. 自动重挂子树重试一次（maxRetry，默认 1）；
 *   2. 重试仍失败则显示轻量兜底 UI，并提供「重试」按钮（后续渲染恢复靠 resetKey / 内容更新）。
 */
'use client'
import * as React from 'react'

type RetryErrorBoundaryProps = {
  children: React.ReactNode
  /** 自动重试次数，默认 1 */
  maxRetry?: number
  /** 达到自动重试上限后的兜底 UI */
  fallback?: (retry: () => void) => React.ReactNode
}

type RetryErrorBoundaryState = {
  hasError: boolean
  renderKey: number
  retried: number
}

class RetryErrorBoundary extends React.Component<
  RetryErrorBoundaryProps,
  RetryErrorBoundaryState
> {
  constructor(props: RetryErrorBoundaryProps) {
    super(props)
    this.state = { hasError: false, renderKey: 0, retried: 0 }
  }

  static getDerivedStateFromError(): Partial<RetryErrorBoundaryState> {
    return { hasError: true }
  }

  override componentDidCatch(error: unknown, errorInfo: React.ErrorInfo) {
    console.error('[RetryErrorBoundary] render error:', error, errorInfo)
    const { maxRetry = 1 } = this.props
    const { retried } = this.state

    // 自动重挂子树重试；强制 key 变化确保子组件完全重建
    if (retried < maxRetry) {
      this.setState(prevState => ({
        hasError: false,
        renderKey: prevState.renderKey + 1,
        retried: prevState.retried + 1,
      }))
    }
  }

  manualRetry = () => {
    this.setState(prevState => ({
      hasError: false,
      renderKey: prevState.renderKey + 1,
      retried: 0,
    }))
  }

  override render() {
    const { hasError, renderKey } = this.state
    const { children, fallback } = this.props

    if (hasError) {
      if (fallback)
        return fallback(this.manualRetry)

      return (
        <div className="flex items-center gap-2 rounded-lg border border-state-critical-border bg-state-critical-hover-alt px-3 py-2 system-xs-regular text-text-tertiary">
          <span>内容渲染失败</span>
          <button
            type="button"
            className="rounded-md border border-components-button-secondary-border bg-components-button-secondary-bg px-2 py-0.5 text-components-button-secondary-text hover:bg-components-button-secondary-bg-hover"
            onClick={this.manualRetry}
          >
            重试
          </button>
        </div>
      )
    }

    return <React.Fragment key={renderKey}>{children}</React.Fragment>
  }
}

export default RetryErrorBoundary
