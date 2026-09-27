/**
 * Devin fleet launcher (3.15) — the fleet chooses Devin for suitable backlog
 * work, under the standing grant, one decision per daemon tick.
 *
 * WHAT IT LAUNCHES: well-scoped bug / issue work from the SAME backlog the
 * Claude cloud lane reads (cloud/backlog.ts): the Leader's `work.dispatch`
 * code-change suggestions (area `leader`, vision/leader-cloud.ts) and
 * operator / built-in items whose area names a bounded fix (tests,
 * reliability, a11y, UX, charts, accounts, bug / issue). Open-ended areas
 * (performance, autonomy, security) and long briefs are never handed to a
 * third-party agent by the fleet. Claims span both lanes, so an item a Devin
 * session holds is never also given to a cloud session, and the reverse.
 *
 * WHEN — every one of these, re-checked EVERY tick, in this order (the first
 * that fails is the decision, and nothing is launched):
 *   1. KILL is off (read now, and again right before the launch call);
 *   2. a standing grant is in force (null under Stop / pause / revoke / expiry);
 *   3. `devin.enabled` and Mason's `devin.fleet` opt-in;
 *   4. the grant's CURRENT stage names the `devin` engine and the Devin seat
 *      is an enabled producer (its own engine identity — a Claude, Grok or
 *      Codex authorization never authorizes Devin);
 *   5. a Devin key connection is recorded;
 *   6. the budget mode lets autonomy use Devin (A9 policy clamped to the
 *      grant: `reserve` mode keeps Devin off);
 *   7. the Devin ACU budget's FLEET gate: pause threshold, free ACUs for one
 *      more session's hard cap, the daily ACU cap, sessions per day, overall
 *      concurrency, Mason's ACU reserve, and the fleet's own caps —
 *      concurrency (default 1) and fleet sessions per day (default 3);
 *   8. a suitable, unclaimed item for a repo the grant's stage covers.
 * The launch itself goes through launchDevinTask (service.ts), the ONLY
 * entry point, which re-checks opt-in, grant, repo, Devin authorization and
 * the fleet budget gate synchronously before the `queued` write. Every
 * session carries the per-session hard cap (`max_acu_limit`).
 *
 * LEDGER: every decision is an authority-ledger `note`:
 *   - `devin:fleet-launch`   BEFORE the API call; a refused append means no
 *                            launch (fail closed, like every authority action);
 *   - `devin:fleet-launched` / `devin:fleet-launch-failed` after it;
 *   - `devin:fleet-hold`     why nothing launched — written when the reason
 *                            CHANGES (not every tick: a held lane would
 *                            otherwise write a row every 30 s forever).
 *
 * LANE ADVICE (optional): a decision layer (the Jev lane-choice decision:
 * fleet vs cloud vs devin, with calibrated confidence) may be plugged in as
 * `laneAdvisor`. It can only NARROW: an item the deterministic heuristic
 * refused is never asked about, and a confident "not Devin" skips the item
 * for this tick. No advisor, an advisor that throws / answers nothing, or a
 * low-confidence answer ⇒ the deterministic heuristic alone decides.
 *
 * Nothing here merges: Devin PRs go through the standing intake and gates,
 * and merge only under the two-judge rule (fleet/merge-gates.ts G6).
 *
 * PUBLIC API (stable — the Leader's class-B Devin action and the daemon tick
 * call it): runDevinFleetTick, planDevinFleetLaunch, isDevinFleetWork,
 * devinFleetPrompt. Every launch still goes through service.ts
 * launchDevinTask, which re-checks the grant and the fleet budget gate.
 */
import type { EffectivePolicy, LedgerAppendInput, LedgerAppendResult } from '../authority/types.js';
import type { BacklogClaimTask } from '../cloud/backlog.js';
import type { CloudBacklogItem } from '../cloud/types.js';
import type { BudgetPolicy } from '../routing/types.js';
import type { AshlrConfig } from '../types.js';
import type { DevinInternalLaunch } from './service.js';
import type { DevinBudgetV1, DevinBudgetView, DevinLaunchResponse, DevinTaskV1 } from './types.js';

/**
 * Backlog areas that mean "a bounded fix" — what the fleet may hand Devin.
 * `leader` = the Leader's work.dispatch suggestions (class A/B, already
 * scoped by the Leader to one repo and one change).
 */
export const DEVIN_FLEET_AREAS: ReadonlySet<string> = new Set([
  'leader',
  'bug',
  'bugs',
  'bugfix',
  'fix',
  'issue',
  'issues',
  'tests',
  'reliability',
  'accessibility',
  'ux',
  'charts',
  'accounts',
]);

/** A brief longer than this is not "well-scoped" for an unattended hosted agent. */
export const DEVIN_FLEET_MAX_PROMPT_CHARS = 8_000;

export type DevinFleetHoldCode =
  | 'kill'
  | 'no-grant'
  | 'not-enabled'
  | 'not-opted-in'
  | 'grant'
  | 'not-connected'
  | 'budget-mode'
  | 'budget'
  | 'no-work'
  | 'ledger';

/** A lane decision about one backlog item (same shape the decide layer's lane choice reports). */
export interface DevinLaneAdvice {
  lane: 'fleet' | 'cloud' | 'devin';
  /** Calibrated confidence in `lane`, 0–1. */
  confidence: number;
  reason?: string;
}

export interface DevinLaneQuestion {
  itemId: string;
  title: string;
  area: string;
  repo: string;
  priority: 1 | 2 | 3;
  promptChars: number;
}

export type DevinLaneAdvisor = (question: DevinLaneQuestion) => DevinLaneAdvice | null | Promise<DevinLaneAdvice | null>;

/** A "not Devin" answer below this confidence is ignored (the heuristic stands). */
export const DEVIN_LANE_ADVICE_MIN_CONFIDENCE = 0.6;
/** Candidates the advisor may turn away in one tick before the tick holds. */
export const DEVIN_LANE_ADVICE_MAX_ASKS = 5;

export type DevinFleetDecision =
  | { kind: 'launch'; item: CloudBacklogItem; repo: string }
  | { kind: 'hold'; code: DevinFleetHoldCode; reason: string };

export interface DevinFleetPlanInput {
  section: AshlrConfig['devin'] | undefined;
  killActive: boolean;
  policy: EffectivePolicy | null;
  /** standingAuthorizesDevin(policy) (authority/effective-config.ts). */
  grant: { ok: boolean; reason: string };
  connected: boolean;
  /** A9: may autonomy use the Devin seat in the current (grant-clamped) budget mode? */
  budgetMode: { ok: boolean; reason: string };
  view: Pick<DevinBudgetView, 'canFleetLaunch'>;
  /** The candidate, computed only when every gate above passed. */
  pick: () => { item: CloudBacklogItem; repo: string } | null;
}

const hold = (code: DevinFleetHoldCode, reason: string): DevinFleetDecision => ({ kind: 'hold', code, reason });

/** Is this backlog item well-scoped work the fleet may give Devin, for a repo the stage covers? Pure. */
export function isDevinFleetWork(item: CloudBacklogItem, repo: string, policy: Pick<EffectivePolicy, 'repos'>): boolean {
  if (!DEVIN_FLEET_AREAS.has(item.area.trim().toLowerCase())) return false;
  if (item.prompt.length > DEVIN_FLEET_MAX_PROMPT_CHARS) return false;
  const target = repo.toLowerCase();
  return policy.repos.some((r) => r.nameWithOwner.toLowerCase() === target);
}

/** PURE: the one decision for this tick. The first failing gate wins; `pick` runs last. */
export function planDevinFleetLaunch(input: DevinFleetPlanInput): DevinFleetDecision {
  if (input.killActive) return hold('kill', 'KILL is on: the fleet launches nothing.');
  if (!input.policy) return hold('no-grant', 'No standing grant is in force (switched off, stopped, revoked, paused or expired).');
  if (input.section?.enabled !== true) return hold('not-enabled', 'The Devin lane is turned off.');
  if (input.section?.fleet !== true) return hold('not-opted-in', 'The fleet may not launch Devin sessions (`ashlr devin fleet on`).');
  if (!input.grant.ok) return hold('grant', input.grant.reason);
  if (!input.connected) return hold('not-connected', 'No Devin key is connected.');
  if (!input.budgetMode.ok) return hold('budget-mode', input.budgetMode.reason);
  if (!input.view.canFleetLaunch.ok) return hold('budget', input.view.canFleetLaunch.reason ?? 'The Devin budget refused another fleet session.');
  const picked = input.pick();
  if (!picked) return hold('no-work', 'No unclaimed, well-scoped backlog item targets a repo in the grant\'s current stage.');
  return { kind: 'launch', item: picked.item, repo: picked.repo };
}

/** The brief the fleet sends: the item's own prompt plus why the fleet chose it. The delivery contract is added by service.ts. */
export function devinFleetPrompt(item: CloudBacklogItem): string {
  return [
    item.prompt.trim(),
    `This task was chosen by the Ashlr fleet from its backlog (item ${item.id}, area ${item.area}). `
      + 'Keep the change focused on exactly this; if the premise is wrong or it is already done, report no-change instead of forcing a diff.',
  ].join('\n\n');
}

// ---------------------------------------------------------------------------
// The tick
// ---------------------------------------------------------------------------

export interface DevinFleetTickDeps {
  config(): AshlrConfig['devin'] | undefined;
  killActive(): boolean;
  /** The LIVE standing policy (currentStandingPolicy: null under KILL / Stop / pause / expiry). */
  policy(): EffectivePolicy | null;
  authorizes(policy: EffectivePolicy | null): { ok: boolean; reason: string };
  connected(): boolean;
  /** A9's budget policy, clamped to the grant (clampBudgetPolicy). */
  budgetPolicy(policy: EffectivePolicy): BudgetPolicy;
  seatEnabled(budget: BudgetPolicy): boolean;
  devinTasks(): DevinTaskV1[];
  /** Cloud-lane tasks, for backlog claims across both lanes. */
  cloudTasks(): BacklogClaimTask[];
  budget(): DevinBudgetV1;
  budgetView(tasks: readonly DevinTaskV1[], budget: DevinBudgetV1, now: Date): DevinBudgetView;
  /** Repo an item without its own `repo` targets (the cloud lane's self-improvement repo); null = skip such items. */
  defaultRepo(): string | null;
  nextItem(
    tasks: readonly BacklogClaimTask[],
    now: Date,
    defaultRepo: string | null,
    accept: (item: CloudBacklogItem, repo: string) => boolean,
  ): { item: CloudBacklogItem; repo: string } | null;
  launch(req: DevinInternalLaunch): Promise<DevinLaunchResponse>;
  appendLedger(input: LedgerAppendInput<'note'>): LedgerAppendResult<'note'>;
  now(): Date;
  /** Optional lane advice (see the header); absent = the heuristic alone. */
  laneAdvisor?: DevinLaneAdvisor | null;
}

export interface DevinFleetTickResult {
  outcome: 'launched' | 'held' | 'failed';
  code: DevinFleetHoldCode | 'launched' | 'launch-failed';
  reason: string;
  repo: string | null;
  itemId: string | null;
  taskId: string | null;
}

const DEVIN_FLEET_DEP_KEYS: readonly (keyof DevinFleetTickDeps)[] = [
  'config', 'killActive', 'policy', 'authorizes', 'connected', 'budgetPolicy', 'seatEnabled', 'devinTasks', 'cloudTasks',
  'budget', 'budgetView', 'defaultRepo', 'nextItem', 'launch', 'appendLedger', 'now',
];

/** The last hold written to the ledger (per process): a hold is ledgered when it CHANGES. */
let lastLedgeredHold: string | null = null;

export function resetDevinFleetLauncherForTest(): void {
  lastLedgeredHold = null;
}

function note(deps: DevinFleetTickDeps, policy: EffectivePolicy | null, repo: string | null, topic: string, detail: string): LedgerAppendResult<'note'> {
  try {
    return deps.appendLedger({ kind: 'note', actor: 'daemon', grantId: policy?.grantId ?? null, repo, data: { topic, detail } });
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * One fleet decision. Never throws; at most ONE launch per call (the
 * concurrency cap is enforced by the budget gate, which counts the task this
 * call writes before the next tick can look).
 */
export async function runDevinFleetTick(depsIn?: Partial<DevinFleetTickDeps>): Promise<DevinFleetTickResult> {
  const deps = (DEVIN_FLEET_DEP_KEYS.every((key) => typeof depsIn?.[key] === 'function')
    ? depsIn
    : { ...(await defaultDevinFleetTickDeps()), ...depsIn }) as DevinFleetTickDeps;
  const held = (policy: EffectivePolicy | null, code: DevinFleetHoldCode, reason: string): DevinFleetTickResult => {
    const key = `${code}\0${reason}`;
    // KILL / no grant: the fleet is dark and says so elsewhere; still record
    // the first time so the ledger shows why Devin stopped.
    if (key !== lastLedgeredHold) {
      const row = note(deps, policy, null, 'devin:fleet-hold', `Devin fleet: nothing launched — ${reason}`);
      if (row.ok) lastLedgeredHold = key;
    }
    return { outcome: 'held', code, reason, repo: null, itemId: null, taskId: null };
  };

  let policy: EffectivePolicy | null = null;
  const excluded = new Set<string>();
  let pickCandidate: () => { item: CloudBacklogItem; repo: string } | null = () => null;
  try {
    const now = deps.now();
    const killActive = safeBool(() => deps.killActive(), true);
    policy = killActive ? null : safeValue(() => deps.policy(), null);
    const section = safeValue(() => deps.config(), undefined);
    const tasks = safeValue(() => deps.devinTasks(), null);
    if (tasks === null) return held(policy, 'budget', 'The Devin task store could not be read, so its spend is unknown.');
    const view = deps.budgetView(tasks, deps.budget(), now);
    pickCandidate = () => deps.nextItem(
      [...safeValue(() => deps.cloudTasks(), []), ...tasks],
      now,
      safeValue(() => deps.defaultRepo(), null),
      (item, repo) => !excluded.has(item.id) && isDevinFleetWork(item, repo, policy!),
    );
    const decision = planDevinFleetLaunch({
      section,
      killActive,
      policy,
      grant: deps.authorizes(policy),
      connected: safeBool(() => deps.connected(), false),
      budgetMode: policy
        ? (safeBool(() => deps.seatEnabled(deps.budgetPolicy(policy!)), false)
          ? { ok: true, reason: '' }
          : { ok: false, reason: 'The budget mode keeps autonomy off Devin (reserve mode, or the Devin seat is switched off).' })
        : { ok: false, reason: 'No standing grant is in force.' },
      view,
      pick: () => pickCandidate(),
    });
    if (decision.kind === 'hold') return held(policy, decision.code, decision.reason);
    let chosen: { item: CloudBacklogItem; repo: string } | null = { item: decision.item, repo: decision.repo };
    const advisedAway: string[] = [];
    if (deps.laneAdvisor) {
      // Every candidate launched was either confirmed or left alone by the
      // advisor — never one it was not asked about.
      let settled = false;
      for (let asks = 0; chosen && asks < DEVIN_LANE_ADVICE_MAX_ASKS; asks += 1) {
        const advice = await askAdvisor(deps.laneAdvisor, chosen.item, chosen.repo);
        if (!advice || advice.lane === 'devin' || advice.confidence < DEVIN_LANE_ADVICE_MIN_CONFIDENCE) {
          settled = true;
          break;
        }
        advisedAway.push(chosen.item.id);
        excluded.add(chosen.item.id);
        chosen = pickCandidate();
      }
      if (!settled) chosen = null;
    }
    if (!chosen) {
      return held(policy, 'no-work', `The lane advisor sent the candidates to another lane this tick (${advisedAway.join(', ')}).`);
    }

    // KILL is re-read at the last moment: a Stop pressed while the backlog
    // was read must still win.
    if (safeBool(() => deps.killActive(), true)) return held(null, 'kill', 'KILL is on: the fleet launches nothing.');
    const { item, repo } = chosen;
    const intent = note(deps, policy, repo, 'devin:fleet-launch',
      `Launching a Devin session on ${repo} for backlog item ${item.id} ("${item.title}", area ${item.area}); hard cap ${deps.budget().maxAcuPerSession} ACUs.`);
    if (!intent.ok) {
      // The authority record could not be written: the action does not happen.
      return { outcome: 'held', code: 'ledger', reason: `the launch was not recorded (${intent.reason}), so it did not happen`, repo, itemId: item.id, taskId: null };
    }
    lastLedgeredHold = null;
    const response = await deps.launch({ repo, title: item.title, prompt: devinFleetPrompt(item), origin: 'fleet', backlogItemId: item.id });
    if (response.ok && response.task) {
      note(deps, policy, repo, 'devin:fleet-launched', `Devin task ${response.task.id} launched on ${repo} for backlog item ${item.id}.`);
      return { outcome: 'launched', code: 'launched', reason: `launched ${response.task.id}`, repo, itemId: item.id, taskId: response.task.id };
    }
    const why = response.error ?? 'the launch was refused';
    note(deps, policy, repo, 'devin:fleet-launch-failed', `Devin launch for backlog item ${item.id} on ${repo} did not start: ${why}`);
    return { outcome: 'failed', code: 'launch-failed', reason: why, repo, itemId: item.id, taskId: response.task?.id ?? null };
  } catch (error) {
    return held(policy, 'budget', `the Devin fleet check failed (${error instanceof Error ? error.message : String(error)})`);
  }
}

/** The advisor's answer, or null when it has none, throws or answers nonsense (the heuristic then stands). */
async function askAdvisor(advisor: DevinLaneAdvisor, item: CloudBacklogItem, repo: string): Promise<DevinLaneAdvice | null> {
  try {
    const advice = await advisor({ itemId: item.id, title: item.title, area: item.area, repo, priority: item.priority, promptChars: item.prompt.length });
    if (!advice || (advice.lane !== 'fleet' && advice.lane !== 'cloud' && advice.lane !== 'devin')) return null;
    if (typeof advice.confidence !== 'number' || !Number.isFinite(advice.confidence) || advice.confidence < 0 || advice.confidence > 1) return null;
    return advice;
  } catch {
    return null;
  }
}

/** `fn()`, or `fallback` when it throws (KILL reads fail CLOSED: fallback true). */
function safeBool(fn: () => boolean, fallback: boolean): boolean {
  try {
    return fn() === true;
  } catch {
    return fallback;
  }
}

function safeValue<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

/** Production wiring, loaded lazily so the daemon's static graph stays light. */
export async function defaultDevinFleetTickDeps(): Promise<DevinFleetTickDeps> {
  const [effective, backlog, cloudStore, budgetStore, policyMod, store, budgetMod, service, ledger, sandbox, config] = await Promise.all([
    import('../authority/effective-config.js'),
    import('../cloud/backlog.js'),
    import('../cloud/store.js'),
    import('../routing/budget-store.js'),
    import('../routing/policy.js'),
    import('./store.js'),
    import('./budget.js'),
    import('./service.js'),
    import('../authority/ledger.js'),
    import('../sandbox/policy.js'),
    import('../config.js'),
  ]);
  return {
    config: () => config.loadConfigReadOnly().devin,
    killActive: () => sandbox.killSwitchOn(),
    policy: () => effective.currentStandingPolicy(),
    authorizes: (policy) => effective.standingAuthorizesDevin(policy),
    connected: () => store.readDevinConnection() !== null,
    budgetPolicy: (policy) => effective.clampBudgetPolicy(budgetStore.loadBudgetPolicy(), policy, [policyMod.DEVIN_SEAT_ID]),
    seatEnabled: (budget) => policyMod.effectiveSeatPolicy(budget, policyMod.DEVIN_SEAT_ID, 'devin').enabled,
    devinTasks: () => store.listDevinTasks(Number.MAX_SAFE_INTEGER),
    cloudTasks: () => cloudStore.listCloudTasks(),
    budget: () => store.readDevinBudget(),
    budgetView: (tasks, budget, now) => budgetMod.devinBudgetView(tasks, budget, now),
    defaultRepo: () => cloudStore.readCloudBudget().selfImprove.repo ?? null,
    nextItem: (tasks, now, defaultRepo, accept) => backlog.nextBacklogItemWhere(tasks, now, defaultRepo, accept),
    launch: (req) => service.launchDevinTask(req),
    appendLedger: (input) => ledger.appendLedger(input),
    now: () => new Date(),
  };
}
