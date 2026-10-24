import React from 'react'

interface Props {
  name: string
  children: React.ReactNode
}
interface State {
  error: Error | null
}

/** Keeps one broken panel from blanking the whole window and shows what failed. */
export default class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    console.error(`[${this.props.name}] render error`, error, info.componentStack)
  }

  render(): React.ReactNode {
    if (!this.state.error) return this.props.children
    return (
      <div className="panel-error">
        <strong>{this.props.name} failed to render</strong>
        <pre>{this.state.error.message}</pre>
        <div className="perm-actions">
          <button className="btn" onClick={() => this.setState({ error: null })}>
            Retry
          </button>
          <button className="btn" onClick={() => window.desktop.window('reload')}>
            Reload window
          </button>
        </div>
      </div>
    )
  }
}
