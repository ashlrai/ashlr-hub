/**
 * decide/jev-types.ts — the wire shape of GET /api/verse/jev.
 *
 * BROWSER-SAFE: the Resources "Jev" card and the Usage panel import this —
 * type-only imports and plain consts, nothing that touches node.
 */

import type { DecisionKind, JevStatus } from './types.js';

export const VERSE_JEV_PATH = '/api/verse/jev';
export const VERSE_JEV_CONFIG_PATH = `${VERSE_JEV_PATH}/config`;

export interface JevKindInfo {
  readonly kind: DecisionKind;
  readonly description: string;
  readonly threshold: number;
  readonly safetyAdjacent: boolean;
  readonly labels: readonly string[];
}

export interface JevResponse {
  readonly generatedAt: string;
  readonly status: JevStatus;
  readonly kinds: readonly JevKindInfo[];
  /** Capability-gated operator preference; null means no call-count preference. */
  readonly config?: { readonly dailyCallBudget: number | null };
}
