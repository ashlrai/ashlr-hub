/**
 * routes/verse/command/ladder-queries.ts — the shadow-decisions read (3.14).
 *
 *   GET /api/verse/authority/ledger?view=decisions&limit=40   ShadowDecisionsV1
 *
 * Optional like every surface read (surface-data.ts): a server without the
 * view answers 400/404, which is "no decisions in this build", one card's
 * designed state. The server caches the fold by ledger head, so Command's and
 * Fleet's polls (one shared cache key) cost a read only when the fleet wrote.
 *
 * LAZY ONLY: imported by AutonomyStatus and ShadowDecisions, both behind
 * React.lazy — never on the chat first-paint path.
 */
import { optionalQuery } from './surface-data.js';
import { narrowDecisions } from './ladder-model.js';

export const AUTHORITY_DECISIONS_PATH = '/api/verse/authority/ledger?view=decisions&limit=40';

export const DECISIONS_KEY = 'verse-authority-decisions';

/** Decisions change once per fleet tick at most; half a minute keeps both surfaces current. */
export const DECISIONS_POLL_MS = 30_000;

export const decisionsQuery = optionalQuery(DECISIONS_KEY, AUTHORITY_DECISIONS_PATH, 'Shadow decisions', narrowDecisions);
