import { StrictMode, Component } from 'react'
import type { ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'

class ErrorBoundary extends Component<{children: ReactNode}, {error: string | null}> {
  state = { error: null };
  static getDerivedStateFromError(error: any) {
    return { error: error.message || String(error) };
  }
  render() {
    if (this.state.error) {
      return <div style={{ color: 'red', padding: '20px', background: 'black' }}><h2>Runtime Error:</h2><pre>{this.state.error}</pre></div>;
    }
    return this.props.children;
  }
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
)
