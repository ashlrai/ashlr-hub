/**
 * decide/jev-api.ts — GET /api/verse/jev: the read model behind the Resources
 * (⌘.) "Jev" card and the Usage "Jev" panel.
 *
 * Read-only: today's decision ledger rolled up (decisions by kind, average
 * confidence, fallback rate, est. cost, latency), whether Jev is keyed and
 * enabled, and each kind's effective threshold. Never calls the TypeSafe API,
 * never returns the key or any classified text. Answers false for every path
 * it does not own (api-modules.ts contract).
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AshlrConfig } from '../types.js';
import type { ApiModule } from '../verse/api-modules.js';
import { sendJson } from '../web/api.js';
import { effectiveThreshold } from './decide.js';
import { ALL_DECISION_KINDS, DECISION_KINDS } from './registry.js';
import { jevStatus } from './status.js';
import { VERSE_JEV_PATH, type JevResponse } from './jev-types.js';

/** A few seconds: the card polls while visible; the ledger is append-only. */
const CACHE_MS = 5_000;
let cached: { at: number; body: JevResponse } | null = null;

export function buildJevResponse(cfg: AshlrConfig): JevResponse {
  return {
    generatedAt: new Date().toISOString(),
    status: jevStatus(cfg),
    kinds: ALL_DECISION_KINDS.map((kind) => {
      const spec = DECISION_KINDS[kind];
      return {
        kind,
        description: spec.description,
        threshold: effectiveThreshold(kind),
        safetyAdjacent: spec.safetyAdjacent,
        labels: spec.labels,
      };
    }),
  };
}

export const handleJevApi: ApiModule = async (ctx, _req: IncomingMessage, res: ServerResponse, path, method) => {
  if (path !== VERSE_JEV_PATH && !path.startsWith(`${VERSE_JEV_PATH}/`)) return false;
  if (path !== VERSE_JEV_PATH || method !== 'GET') {
    sendJson(res, 404, { error: `not found: ${method} ${path}` });
    return true;
  }
  try {
    const now = Date.now();
    if (!cached || now - cached.at > CACHE_MS) cached = { at: now, body: buildJevResponse(ctx.cfg) };
    sendJson(res, 200, cached.body);
  } catch {
    // A fixed message, like every other Verse module: error text can carry file paths
    // (the ledger lives under ~/.ashlr) and this route is read-only-cookie reachable.
    sendJson(res, 500, { error: 'jev status unavailable' });
  }
  return true;
};

/** Test seam. */
export function resetJevApiCacheForTests(): void {
  cached = null;
}
