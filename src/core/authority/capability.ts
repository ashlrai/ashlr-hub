/**
 * Standing capability — V3.10 Track B (unit B-U1).
 *
 * `openStandingSession(cfg)` authorizes a resident `runDaemon`: it verifies
 * the whole standing authority for the code this process runs and records
 * the session in the ledger. `mintStandingTickCapability(session)` then, on
 * EVERY tick:
 *   1. re-verifies everything from scratch and mints a SINGLE-USE
 *      `resident-standing` capability through activation-permit.ts's existing
 *      WeakMap (so `isDaemonActivationCapability` stays the one runtime check
 *      and a structurally forged object is still rejected);
 *   2. takes one rollout step (addendum §1: advance on met criteria, regress
 *      on a breach) inside the ledger lock;
 *   3. ledgers state transitions it saw (expiry, "authority code changed").
 *
 * Sessions are process-local objects this module issued; a look-alike object
 * is refused. They survive a grant rotation (re-approval): every tick
 * verifies whatever grant is installed NOW, and the capability records which
 * grant it was minted under.
 */
import { randomBytes } from 'node:crypto';

import type { AshlrConfig } from '../types.js';
import {
  mintResidentStandingCapability,
  type DaemonActivationCapability,
} from '../daemon/activation-permit.js';
import {
  evaluateStandingAuthority,
  primeStandingPolicyCache,
  recordStandingTransitions,
} from './effective-config.js';
import { appendLedger, withLedgerTransaction } from './ledger.js';
import { stepRolloutUnderLock, type RolloutStepResult } from './rollout.js';
import type { EffectivePolicy } from './types.js';

/** Handle for one resident run. Opaque to callers; B-U1 validates it on every mint. */
export interface StandingSession {
  readonly sessionId: string;
  readonly grantId: string;
  readonly openedAt: string;
}

export type OpenStandingSessionResult =
  | { ok: true; session: StandingSession; policy: EffectivePolicy }
  | { ok: false; reason: string };

export type MintStandingTickResult =
  | { ok: true; capability: DaemonActivationCapability; policy: EffectivePolicy }
  | { ok: false; reason: string };

const openSessions = new WeakSet<object>();

/**
 * Open a resident session under the installed standing grant. Refuses (never
 * throws) whenever there is no live standing authority, so runDaemon falls
 * back to master's path — which refuses too (dark).
 */
export function openStandingSession(cfg: AshlrConfig): OpenStandingSessionResult {
  let evaluation;
  try {
    evaluation = evaluateStandingAuthority({ mode: 'fresh', surface: 'running', config: cfg });
  } catch {
    return { ok: false, reason: 'standing authority could not be evaluated' };
  }
  primeStandingPolicyCache(evaluation);
  try {
    recordStandingTransitions(evaluation);
  } catch {
    // Recording a transition is best effort; the refusal below does not depend on it.
  }
  if (!evaluation.policy || !evaluation.grant) {
    return { ok: false, reason: evaluation.inactiveReason ?? evaluation.grantReason ?? 'no standing authority' };
  }
  const session: StandingSession = Object.freeze({
    sessionId: randomBytes(16).toString('hex'),
    grantId: evaluation.grant.grantId,
    openedAt: evaluation.checkedAt,
  });
  // A session that is not on the record never runs (fail closed).
  const recorded = appendLedger({
    kind: 'note',
    actor: 'daemon',
    grantId: evaluation.grant.grantId,
    repo: null,
    data: { topic: 'standing-session:opened', detail: `session ${session.sessionId} opened by pid ${process.pid} at stage ${evaluation.policy.rollout.stageId}` },
  });
  if (!recorded.ok) return { ok: false, reason: `the ledger refused the session record: ${recorded.reason}` };
  openSessions.add(session);
  return { ok: true, session, policy: evaluation.policy };
}

/** End a session (e.g. daemon shutdown); later mints for it are refused. */
export function closeStandingSession(session: StandingSession): void {
  if (!openSessions.has(session)) return;
  openSessions.delete(session);
  appendLedger({
    kind: 'note',
    actor: 'daemon',
    grantId: session.grantId,
    repo: null,
    data: { topic: 'standing-session:closed', detail: `session ${session.sessionId} closed by pid ${process.pid}` },
  });
}

/** The last rollout step this process took (for tick records / diagnostics). */
let lastRolloutStep: RolloutStepResult | null = null;

export function lastStandingRolloutStep(): RolloutStepResult | null {
  return lastRolloutStep;
}

/** Re-verify everything and mint this tick's single-use capability. */
export function mintStandingTickCapability(session: StandingSession): MintStandingTickResult {
  if (typeof session !== 'object' || session === null || !openSessions.has(session)) {
    return { ok: false, reason: 'unknown or closed standing session' };
  }
  const minted = mintResidentStandingCapability();
  if (minted.evaluation) {
    try {
      recordStandingTransitions(minted.evaluation);
    } catch {
      // best effort — see recordStandingTransitions
    }
  }
  if (!minted.ok) return { ok: false, reason: minted.reason };
  const evaluation = minted.evaluation;
  const grant = evaluation.grant;
  let policy = evaluation.policy!;
  if (grant) {
    const stepped = withLedgerTransaction((tx) => stepRolloutUnderLock(tx, grant, Date.now()));
    if (stepped.ok && stepped.value) {
      lastRolloutStep = stepped.value;
      if (stepped.value.decision !== 'hold') {
        // The ladder moved: re-derive the policy so this tick already runs at
        // the new rung (a regression narrows immediately).
        const after = evaluateStandingAuthority({ mode: 'cached', surface: 'running', config: evaluation.config ?? undefined });
        primeStandingPolicyCache(after);
        if (!after.policy || after.grant?.grantId !== grant.grantId) {
          return { ok: false, reason: after.inactiveReason ?? after.grantReason ?? 'standing authority changed during the tick' };
        }
        policy = after.policy;
      }
    } else if (!stepped.ok) {
      // A ledger that cannot take the rollout row cannot take gate rows either.
      return { ok: false, reason: `rollout step failed: ${stepped.reason}` };
    }
  }
  return { ok: true, capability: minted.capability, policy };
}
