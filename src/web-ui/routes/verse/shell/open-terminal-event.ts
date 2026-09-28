/**
 * routes/verse/shell/open-terminal-event.ts — the name of the "open this
 * terminal tab" window event (3.15), alone in its module: VerseApp (first
 * paint) listens for it, and a module shared with lazy chunks would drag the
 * rest of open-terminal-request.ts into the first-paint chunk with it.
 */
export const VERSE_OPEN_TERMINAL_EVENT = 'ashlr:verse-open-terminal';
