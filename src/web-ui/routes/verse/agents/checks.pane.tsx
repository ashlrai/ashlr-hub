/**
 * routes/verse/agents/checks.pane.tsx — the chat dock's "Checks" pane: the
 * open chat's git status, PR, CI, review comments, Auto-fix CI and
 * Auto-merge (3.16 agents). Only the registration lives here — panes/index.ts
 * imports every `*.pane.tsx` eagerly after first paint — and the body is its
 * own lazy chunk (ChecksPanel.tsx).
 */
import type { PaneProps } from '../panes/pane-registry.js';
import { lazyPane, registerPane } from '../panes/pane-registry.js';

function ChecksGlyph({ size = 16 }: { size?: number }) {
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d="M3 4.5 4.5 6 7 3.5M3 10.5 4.5 12 7 9.5M9 5h4.5M9 11h4.5" />
    </svg>
  );
}

registerPane({
  id: 'checks',
  title: 'Checks',
  icon: ChecksGlyph,
  order: 55,
  description: 'Git status, the PR, each CI check and review comments — with Auto-fix CI and Auto-merge for an agent.',
  component: lazyPane(() =>
    import('./ChecksPanel.js').then((m) => function ChecksPane(props: PaneProps) {
      return <m.ChecksDockPane sessionId={props.sessionId} visible={props.visible} host={props.host} />;
    }),
  ),
});
