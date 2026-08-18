/**
 * components/primitives/RouteErrorBoundary.tsx — the last line of defense
 * against a view crashing on real-world data that doesn't match its
 * expected shape (see SwarmsView.tsx's `plan?.tasks` guard for a concrete
 * example: 2 of 80 real swarm records on this machine predate the `plan`
 * field entirely).
 *
 * React error boundaries can only be class components — there is no hook
 * equivalent. Wraps `<Outlet/>` in Shell.tsx, not the whole app: if one
 * routed view throws during render, the sidebar/topbar/command palette
 * survive and the operator can navigate to a working view instead of being
 * stuck on a permanently blank screen (DESIGN.md §11 point 4 — "never a
 * full-page error, the shell stays usable" — extended here to cover
 * uncaught render exceptions, not just query-status `'error'`).
 */
import { Component, type ErrorInfo, type ReactNode } from 'react';
import styles from './RouteErrorBoundary.module.css';

interface Props {
  children: ReactNode;
  /** Identity that, when changed, resets the boundary — pass the route pathname. */
  resetKey: string;
}

interface State {
  error: Error | null;
}

export class RouteErrorBoundary extends Component<Props, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[ashlr] view crashed while rendering', error, info.componentStack);
  }

  override componentDidUpdate(prevProps: Props) {
    if (this.state.error && prevProps.resetKey !== this.props.resetKey) {
      this.setState({ error: null });
    }
  }

  override render() {
    if (this.state.error) {
      return (
        <div className={styles.wrap} role="alert">
          <p className={styles.title}>This view hit an error and couldn&apos;t render.</p>
          <p className={styles.detail}>
            {this.state.error.message || 'Unknown error.'} — the rest of ashlr is still working; pick another view
            from the sidebar, or retry this one.
          </p>
          <button type="button" className={styles.retry} onClick={() => this.setState({ error: null })}>
            Retry this view
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
