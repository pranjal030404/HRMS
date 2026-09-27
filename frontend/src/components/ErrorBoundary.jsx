import React from 'react';

/** Keeps a crashing page from white-screening the whole app. */
class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error) {
    return { error };
  }
  componentDidCatch(error, info) {
    console.error('[UI crash]', error, info?.componentStack);
  }
  render() {
    if (this.state.error) {
      return (
        <div className="card" style={{ padding: 40, margin: 24, textAlign: 'center' }}>
          <h3 style={{ marginBottom: 8 }}>Something went wrong on this page</h3>
          <p style={{ color: 'var(--muted)', fontSize: 13.5, marginBottom: 16 }}>
            {String(this.state.error.message || this.state.error)}
          </p>
          <button className="btn" onClick={() => window.location.assign('/')}>Back to dashboard</button>
        </div>
      );
    }
    return this.props.children;
  }
}

export default ErrorBoundary;
