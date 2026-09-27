/**
 * terminal/TerminalPane.tsx — the adapters (3.15): the Terminal panel behind
 * the pane registry's PaneProps (what ./terminal.pane.tsx registers) and
 * behind the dock's 3.10 slot contract (TerminalPaneProps), so either host
 * mounts it with no change to the panel.
 *
 * Loaded lazily (terminal.pane.tsx `lazyPane`), in the panel's own chunk.
 */
import { EmptyState } from '../../../components/primitives/EmptyState.js';
import type { PaneProps } from '../panes/pane-registry.js';
import type { TerminalPaneProps } from '../shell/slots.js';
import { TerminalGlyph } from '../dock/terminal/terminal-icons.js';
import { TerminalPanel, type TerminalPanelProps } from './TerminalPanel.js';

/**
 * The registry's pane body. The registry hands a unit's pane
 * `sessionId: null` when no chat is open: the terminal belongs to a chat
 * (its tabs, layout and Agent tab are the chat's), so it says so instead.
 */
export function TerminalRegistryPane({ sessionId, roots, requests, host, visible }: PaneProps) {
  if (!sessionId) {
    return (
      <EmptyState compact icon={<TerminalGlyph size={20} />} title="Open a chat to use the terminal"
        body="Each chat has its own shells, command blocks and a read-only view of what its agents ran." />
    );
  }
  return (
    <TerminalPanel
      sessionId={sessionId}
      roots={roots}
      request={requests.terminal}
      onSendToChat={host.sendToChat}
      visible={visible}
    />
  );
}

/** The dock slot's contract (shell/slots.tsx SLOTS['terminal-pane']), plus the optional turn hook. */
export function TerminalPane(props: TerminalPaneProps & Pick<TerminalPanelProps, 'onAskChat'>) {
  return <TerminalPanel {...props} />;
}
