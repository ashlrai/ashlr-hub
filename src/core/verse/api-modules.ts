/**
 * API handler modules — V3.10 contract (unit A0, frozen once written).
 *
 * Every new route family (health, reasoning, fleet history, budget) is a
 * module its owning unit exports; verse-api.ts (unit A10) mounts them in a
 * fixed order. Same contract as `handleVerseApi`: return true when a response
 * was written (including error responses), false when `path` is not this
 * module's route so the next module / handleApi's own 404 can run.
 *
 * NODE-ONLY (node:http types). Type-only imports, so importing this from
 * verse-api.ts creates no runtime cycle.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { VerseApiContext } from './verse-api.js';

export type ApiModule = (
  ctx: VerseApiContext,
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  method: string,
) => Promise<boolean>;
