/**
 * routes/verse/changes/changes-pane.tsx — the adapter that lets a pane host
 * mount the Changes pane without knowing its internals.
 *
 * The workbench pane registry (routes/verse/panes/**, owned by the layout
 * work) had not landed when this shipped, and the dock/shell files that list
 * panes today belong to other owners. So this module exposes ONE descriptor
 * a registry can take as-is — id, title, a lazily loaded component and the
 * props it needs — and registering the pane is a one-line change for the
 * host's owner:
 *
 *   registerPane(CHANGES_PANE)          // or: DOCK_PANES entry + a slot case
 *
 * The component itself is self-contained (only a chat id), so it also works
 * in a section, a sheet, or a test harness.
 */
import { lazy, Suspense } from 'react';
import { EmptyState } from '../../../components/primitives/EmptyState.js';
import { SkeletonLine } from '../../../components/primitives/Skeleton.js';

/** What any host knows about the chat on screen. */
export interface ChangesPaneHostProps {
  /** The chat in view; null when none is open. */
  sessionId: string | null;
  /** The pane is on screen (a background tab fetches nothing). */
  visible: boolean;
}

const LazyChangesPanel = lazy(() => import('./ChangesPanel.js').then((m) => ({ default: m.ChangesPanel })));

export function ChangesPaneAdapter({ sessionId, visible }: ChangesPaneHostProps) {
  if (!sessionId) {
    return <EmptyState compact title="No chat open" body="Open a chat to review what its agent changed." />;
  }
  return (
    <Suspense fallback={<SkeletonLine />}>
      <LazyChangesPanel key={sessionId} sessionId={sessionId} visible={visible} />
    </Suspense>
  );
}

export interface PaneDescriptor<P> {
  id: string;
  title: string;
  description: string;
  /** Keyboard hint a host may bind (it owns the binding). */
  shortcutHint: string | null;
  component: (props: P) => React.ReactNode;
}

export const CHANGES_PANE: PaneDescriptor<ChangesPaneHostProps> = {
  id: 'changes',
  title: 'Changes',
  description: 'Every turn’s changes, with accept/reject per file or hunk, Undo turn, Redo, Commit and Open PR.',
  shortcutHint: null,
  component: ChangesPaneAdapter,
};
