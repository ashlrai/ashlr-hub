/**
 * routes/verse/verse-bootstrap-query.ts — the one read every Verse surface
 * starts from (seats, projects, sessions, dispatchEnabled), on its own.
 *
 * verse-queries.ts re-exports it unchanged. It lives apart so the phone app
 * (routes/verse/mobile/) can probe its session and read `dispatchEnabled` at
 * first paint without downloading every other /api/verse/* helper — its
 * first-paint budget (scripts/check-first-paint-budget.mjs) is 250 KB, and
 * React alone is ~220 KB of that.
 */
import type { VerseBootstrap } from '../../data/api-types.js';
import { apiGet } from '../../data/client.js';
import type { QueryDef } from '../../data/queries.js';

export const VERSE_BOOTSTRAP_KEY = 'verse-bootstrap';

export const verseBootstrapQuery: QueryDef<VerseBootstrap> = {
  key: VERSE_BOOTSTRAP_KEY,
  fetch: (signal) => apiGet<VerseBootstrap>('/api/verse/bootstrap', signal),
};
