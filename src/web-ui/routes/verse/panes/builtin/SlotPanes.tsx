/**
 * routes/verse/panes/builtin/SlotPanes.tsx — the first-party Terminal,
 * Browser and Changes panes: thin adapters from PaneProps to the C0 slot
 * each renders through (shell/slots.tsx), so xterm, the page preview and the
 * diff viewer stay in their owners' lazy chunks.
 *
 * A unit replacing one of these (the Terminal, Browser or Harness agent)
 * registers its own component under the same id — see ../README.md — and
 * this adapter simply stops being used.
 */
import type { PaneProps } from '../pane-registry.js';
import { DiffPaneSlot, PreviewPaneSlot, TerminalPaneSlot } from '../../shell/slots.js';

export function TerminalPaneBody({ sessionId, roots, requests, host, visible }: PaneProps) {
  return <TerminalPaneSlot sessionId={sessionId ?? ''} roots={roots} request={requests.terminal} onSendToChat={host.sendToChat} visible={visible} />;
}

export function BrowserPaneBody({ sessionId, roots, requests, host, visible }: PaneProps) {
  // Dev-server Start: Terminal opens BELOW the browser, so the page appears
  // on top when its port answers (SPEC-310C acceptance step 3).
  return <PreviewPaneSlot sessionId={sessionId ?? ''} roots={roots} request={requests.preview} visible={visible} onOpenTerminal={host.openTerminalBelow} />;
}

export function ChangesPaneBody({ sessionId, roots, requests, turnFiles, host, visible }: PaneProps) {
  return <DiffPaneSlot sessionId={sessionId ?? ''} roots={roots} request={requests.diff} turnFiles={turnFiles} onAddToMessage={host.addToMessage} visible={visible} />;
}
