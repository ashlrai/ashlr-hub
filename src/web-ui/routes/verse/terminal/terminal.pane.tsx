/**
 * terminal/terminal.pane.tsx — the 3.15 Terminal's registration in the pane
 * registry (panes/README.md). panes/index.ts discovers every `*.pane.tsx`
 * under routes/verse and imports it (after first paint).
 *
 * Id `terminal` REPLACES the first-party stub and inherits what this leaves
 * unsaid: the ⌃` key (dock.terminal), the header toggle, the first place in
 * the panel, `needsSession` (without a chat the dock says "Open a chat to use
 * Terminal") and the stub's description. ⌃⇧` (a new tab) and every
 * `requests.terminal` — Run in terminal, Apps [Launch ▸], a dev-server Start —
 * reach the panel as before.
 *
 * TINY ON PURPOSE: a registration and a lazy import. The panel — xterm, its
 * addons, the block view — is its own chunk, loaded when the pane first shows
 * (terminal-lazy.test.ts).
 *
 * 3.15: it also serves ⌘K "Generate command…" and "Search terminal history…"
 * (catalog ids terminal.generate / terminal.history) — here rather than in
 * ChatSection, so the chat's first paint carries none of it. Both go to Chat
 * and ask the panel for its prompt; the panel does the rest (nothing runs).
 */
import { requestTerminal } from '../dock/dock-store.js';
import { TerminalGlyph } from '../dock/dock-icons.js';
import { lazyPane, registerPane } from '../panes/pane-registry.js';
import { registerCommandHandler } from '../shell/command-bus.js';
import { getVerseUiState, setVerseSection } from '../verse-ui-store.js';

export const TERMINAL_PANE_ID = 'terminal';

registerPane({
  id: TERMINAL_PANE_ID,
  title: 'Terminal',
  icon: TerminalGlyph,
  component: lazyPane(() => import('./TerminalPane.js').then((m) => m.TerminalRegistryPane)),
});

function openTerminalPrompt(request: { assist: true } | { history: true }): void {
  if (getVerseUiState().section !== 'chat') setVerseSection('chat');
  requestTerminal(request);
}
registerCommandHandler('terminal.generate', () => openTerminalPrompt({ assist: true }));
registerCommandHandler('terminal.history', () => openTerminalPrompt({ history: true }));
