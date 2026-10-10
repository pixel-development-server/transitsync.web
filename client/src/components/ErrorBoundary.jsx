import { Component } from 'react';

import { EmptyState } from './ui.jsx';

/**
 * Catches render-time errors thrown by a page so a single broken screen shows a
 * recoverable message instead of unmounting the whole console to a blank page.
 *
 * The shell remounts this boundary (via `key`) on navigation, which clears the
 * error; "Try again" clears it in place for a transient failure.
 */
export default class ErrorBoundary extends Component {
  state = { error: null };

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    // Keep the failure diagnosable without taking the UI down.
    console.error('TransitSync page error:', error, info?.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="card">
        <EmptyState
          icon="alert"
          title="This view hit an error"
          message={error?.message ? String(error.message) : 'An unexpected error occurred while rendering this page.'}
          className="min-h-[50vh]"
        />
        <div className="grid place-items-center pb-6">
          <button type="button" className="btn btn-ghost" onClick={() => this.setState({ error: null })}>
            Try again
          </button>
        </div>
      </div>
    );
  }
}
