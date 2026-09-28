/**
 * grant-scope-types.ts — the grant editor's wire types (3.15). BROWSER-SAFE:
 * type-only; the logic is grant-scope.ts.
 */
import type { BudgetMode } from '../routing/types.js';
import type { GrantEngine } from '../fleet/fleet-types.js';
import type { LeaderGrantClass } from './types.js';

/** What the grant editor sends. Every field is optional: absent = keep the draft's. */
export interface GrantScopeEdit {
  /** nameWithOwner, a subset of the draft's repos. */
  repos?: string[];
  engines?: GrantEngine[];
  leaderClasses?: LeaderGrantClass[];
  maxMode?: BudgetMode;
  /** Integer USD/day for metered APIs, 0..STANDING_GRANT_CEILINGS.maxMeteredUsdPerDay. */
  meteredUsdPerDay?: number;
  /** 1..30. */
  days?: number;
  conductorGoals?: boolean;
}

/** What the draft route adds for the editor (AuthorityDraftResponse, 3.15). */
export interface GrantDraftEditable {
  repos: string[];
  engines: string[];
  leaderClasses: string[];
  maxDays: number;
}

/** `wider` raises authority, `narrower` lowers it, `changed` is neither (e.g. a new expiry). */
export type GrantDiffDirection = 'wider' | 'narrower' | 'changed';

export interface GrantDiffLine {
  field: 'repos' | 'repo-stage' | 'engines' | 'leader' | 'spend-mode' | 'metered' | 'expiry' | 'conductor' | 'ladder' | 'merge-caps';
  label: string;
  before: string;
  after: string;
  direction: GrantDiffDirection;
}

