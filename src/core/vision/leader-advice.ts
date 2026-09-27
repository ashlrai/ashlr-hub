/**
 * Jev's advisory second opinion on the Leader's action classes (3.15 follow-up;
 * contract: docs/JEV-INTEGRATION.md, `action-class`).
 *
 * `suggestActionClass` (decide/action-class.ts) asks Jev whether an action the
 * Leader proposed deserves MORE oversight than the class the deterministic
 * policy check gave it. This module is its one production caller, and it is
 * ADVISORY ONLY:
 *
 *   - It runs AFTER `enactLeaderActions` (leader.ts): every class, status and
 *     veto window is already decided, every class-A action already applied or
 *     refused, before any advice is asked for. Nothing here — and nothing that
 *     reads its output — feeds a gate, the grant, the ledger or the action
 *     store. The advice is a label on the memo (`memo.actionAdvice`) and a line
 *     in the memo message Mason reads (leader-thread.ts), so a B he should veto
 *     or an applied A he should undo stands out.
 *   - It can never LOWER a class: the decision kind is escalate-only (Jev's
 *     less-strict answers are refused inside decide()), and `adviseLeaderActions`
 *     drops any advice whose suggestion is below the action's class anyway.
 *   - It never approves anything: it has no path to an approve/apply function.
 *   - Unkeyed, killed (ASHLR_JEV_DISABLE / jev config), over the daily budget,
 *     below the 0.85 threshold, or failing: no advice is recorded and the memo
 *     is exactly what it was. The layer's cache, budget and ledger apply as for
 *     every other kind; this adds no threshold or budget of its own beyond
 *     MAX_ADVISED_ACTIONS_PER_MEMO.
 *
 * The decision module is imported lazily with a LITERAL specifier: the desktop
 * sidecar is `bun build --compile`, which bundles only literal dynamic imports
 * (test/sidecar-literal-imports-315.test.ts).
 */
import type { AshlrConfig } from '../types.js';
import type { LeaderAction, LeaderActionAdvice, LeaderActionClass } from './leader-types.js';

/** At most this many actions are advised per memo (one Jev call each; budget-aware). */
export const MAX_ADVISED_ACTIONS_PER_MEMO = 8;

/** Returns advice only when Jev answered above the gate; null otherwise. Must not throw (it is guarded anyway). */
export type LeaderActionAdvisor = (action: LeaderAction) => Promise<LeaderActionAdvice | null>;

const RANK: Readonly<Record<LeaderActionClass, number>> = { A: 0, B: 1, C: 2 };

/**
 * Worth a second opinion: class A or B (C is already the strictest), and an
 * action that is live or would have been — applied, scheduled, failed, or
 * refused only because this is a dry run. Escalated and policy-refused
 * actions are skipped: there is nothing stricter to flag.
 */
export function isAdvisableAction(action: LeaderAction): boolean {
  if (action.class === 'C') return false;
  if (action.status === 'escalated' || action.status === 'vetoed') return false;
  if (action.status === 'refused') return (action.statusReason ?? '').startsWith('dry run:');
  return true;
}

/** Keep an advisor's answer only when it is well-formed and escalate-only for THIS action. */
function acceptAdvice(action: LeaderAction, advice: LeaderActionAdvice | null): LeaderActionAdvice | null {
  if (!advice || advice.source !== 'jev' || advice.actionId !== action.id) return null;
  if (advice.deterministic !== action.class) return null;
  if (!(advice.suggested in RANK) || RANK[advice.suggested] < RANK[action.class]) return null;
  if (typeof advice.confidence !== 'number' || !Number.isFinite(advice.confidence)) return null;
  return {
    actionId: action.id,
    deterministic: action.class,
    suggested: advice.suggested,
    stricter: RANK[advice.suggested] > RANK[action.class],
    confidence: Math.min(1, Math.max(0, advice.confidence)),
    source: 'jev',
  };
}

/**
 * Advise the memo's actions. NEVER THROWS and never mutates `actions`. Class A
 * first (it applied without a window, so a stricter opinion matters most),
 * then B, in memo order; at most MAX_ADVISED_ACTIONS_PER_MEMO. Returns only
 * accepted advice, in memo order.
 */
export async function adviseLeaderActions(
  actions: readonly LeaderAction[],
  advise: LeaderActionAdvisor,
  opts: { max?: number } = {},
): Promise<LeaderActionAdvice[]> {
  const max = opts.max ?? MAX_ADVISED_ACTIONS_PER_MEMO;
  const picked = actions
    .map((action, index) => ({ action, index }))
    .filter(({ action }) => isAdvisableAction(action))
    .sort((a, b) => RANK[a.action.class] - RANK[b.action.class] || a.index - b.index)
    .slice(0, Math.max(0, max));
  const settled = await Promise.allSettled(picked.map(async ({ action, index }) => {
    const raw = await advise(action);
    return { index, advice: acceptAdvice(action, raw) };
  }));
  return settled
    .flatMap((s) => (s.status === 'fulfilled' && s.value.advice ? [s.value] : []))
    .sort((a, b) => a.index - b.index)
    .map((s) => s.advice!);
}

function actionRepo(action: LeaderAction): string | null {
  const params = action.params as unknown as Record<string, unknown> | null;
  const repo = params && typeof params['repo'] === 'string' ? params['repo'] : null;
  return repo && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo) ? repo : null;
}

/**
 * The production advisor: `suggestActionClass` through the Jev decision layer
 * (fallback = the deterministic class, threshold/cache/budget/kill switches
 * from the layer). Advice is returned only when Jev cleared the gate.
 */
export function defaultLeaderActionAdvisor(cfg: AshlrConfig | null): LeaderActionAdvisor {
  return async (action) => {
    const { suggestActionClass } = await import('../decide/action-class.js');
    const result = await suggestActionClass(
      { kind: action.kind, summary: action.summary, detail: action.why, repo: actionRepo(action) },
      action.class,
      cfg ? { cfg } : {},
    );
    if (result.decision.path !== 'jev') return null;
    return {
      actionId: action.id,
      deterministic: result.deterministic,
      suggested: result.suggested,
      stricter: result.stricter,
      confidence: result.decision.confidence,
      source: 'jev',
    };
  };
}

/** Advice for one action, when recorded and stricter (the memo message shows only these). */
export function stricterAdviceFor(advice: readonly LeaderActionAdvice[] | undefined, actionId: string): LeaderActionAdvice | null {
  const hit = advice?.find((a) => a.actionId === actionId) ?? null;
  return hit && hit.stricter ? hit : null;
}
