/**
 * The local Devin CLI as a FLEET PRODUCER (3.15) — engine / lane `devin-cli`.
 *
 * WHAT IT IS. The same headless shape the fleet uses for Codex and Claude
 * Code: `devin -p --model <m> --permission-mode smart
 * --respect-workspace-trust false -- <goal>` runs inside the run's sandbox
 * worktree (run/engine-registry.ts owns the argv; run/sandboxed-engine.ts
 * captures the diff as a PENDING proposal, exactly like every other CLI
 * engine). The default model is SWE-2, which is FREE on the Devin plan
 * (`devin models list`: swe-2-high / swe-2-medium / swe-2-max, 262K context)
 * — high-quality autonomous capacity that costs $0 next to the local models.
 *
 * WHAT IT IS NOT. It is not the Devin cloud launcher (devin/fleet-launcher.ts,
 * hosted sessions metered in ACUs). The two share ONE authorization: the
 * grant engine `devin` with a producer-only Devin seat, and Mason's
 * `devin.enabled` + `devin.fleet` opt-in. A grant can never name `devin-cli`
 * on its own (fleet-types.ts grantEngineOfLane), so the CLI inherits every
 * Devin rule — producer only, never a judge (reviewer-independence.ts
 * isFrontierJudgeId refuses every `devin*` id) — rather than getting a new,
 * separately signable identity.
 *
 * PERMISSION MODE — `smart`, and why. `devin --help` (3000.11.3) lists four:
 *   auto          read-only tools only — an edit is never approved, and print
 *                 mode has no one to ask, so the run could change nothing;
 *   accept-edits  workspace edits, but no shell: it could not run the tests
 *                 the fleet's verification expects it to have run;
 *   smart         edits, plus shell actions a fast model judges safe —
 *                 measured: an edit followed by `cat … && ls` completed in
 *                 print mode (swe-2-medium, 5 s);
 *   dangerous     every tool, no judgement.
 * `smart` is the least-permissive mode that can edit the workspace AND run
 * tests. `dangerous` is never used: the other CLI engines only skip their
 * approvals because they run under OS confinement, and the Devin CLI runs
 * under the SAME confinement (an autonomous run is forced to `mode: 'os'` —
 * worktree-only writes, ephemeral HOME/XDG homes, credentials stripped) —
 * so `smart` is defense in depth on top of it, not instead of it.
 * `--sandbox` (Devin's own seatbelt, "research preview") is NOT passed: a
 * seatbelt profile cannot be applied inside the sandbox-exec profile the run
 * already has (the reason Codex bypasses its own sandbox the same way).
 * `--respect-workspace-trust false` is required: print mode cannot show the
 * trust prompt and fails in an untrusted directory, and every run's worktree
 * is new. It means repo-level Devin config in the worktree is honoured — the
 * same trust every other CLI engine extends to the repos Mason enrolled, and
 * bounded by the same confinement.
 *
 * SPEND. SWE-2 is free: runs and minutes are counted like any run, cost $0.
 * Any OTHER model (`devin.fleetModel`) is billed by Devin per token, and this
 * build cannot read that spend back (the CLI prints no usage) — so the lane
 * HOLDS for a non-free model instead of pretending a budget gate metered it.
 * A paid Devin CLI model is for Mason's own runs until spend is observable.
 *
 * PURE: no I/O here. The readiness probe (cli-probe.ts) is awaited by the
 * tick (fleet/tick-hooks-live.ts) and handed in.
 */
import type { AshlrConfig } from '../types.js';
import type { DevinCliProbeState } from './cli-probe.js';

/** Registry engine id and fleet lane id (they coincide, like `grok-cli`). */
export const DEVIN_CLI_ENGINE_ID = 'devin-cli' as const;

/**
 * The fleet's model when `devin.fleetModel` names none. The model catalog
 * (devin/models.ts, owned by the Devin seat work) is deliberately NOT read
 * here: the fleet's default is a compiled constant so a catalog change can
 * never move autonomous work onto a billed model.
 */
export const DEVIN_CLI_FLEET_DEFAULT_MODEL = 'swe-2-high';

/**
 * The Devin models that are free on the plan (`devin models list`, 3000.11.3:
 * "262K context, Free"). Exact ids only — an alias (`swe`, `swe-2`) is not
 * proof of which model runs, and the recorded `devin-cli:<model>` must name
 * the model that actually ran.
 */
export const DEVIN_CLI_FREE_MODELS: readonly string[] = Object.freeze(['swe-2-high', 'swe-2-medium', 'swe-2-max']);

/** `--permission-mode` for every fleet run (see the header). */
export const DEVIN_CLI_PERMISSION_MODE = 'smart';

/** SWE-2's context window (`devin models list`: 262K). */
export const DEVIN_CLI_CONTEXT_TOKENS = 262_144;

/**
 * Lane width. A neutral default — one run at a time — until the router's
 * resource-parity work sets it from measured throughput.
 */
export const DEVIN_CLI_LANE_DEFAULT_SLOTS = 1;

/**
 * Idle-stall floor for a Devin CLI spawn. Print mode writes NOTHING to stdout
 * until the final answer (measured), so the shared 3-minute idle window
 * (run-monitor.ts) would kill every real run mid-work. The 2-hour wall-clock
 * backstop (sandboxed-engine DEFAULT_TIMEOUT_MS) still bounds a hung run.
 */
export const DEVIN_CLI_STALL_IDLE_MS = 30 * 60_000;

const MODEL_ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/** Is `model` one of the free SWE-2 models (exact id)? */
export function isDevinCliFreeModel(model: unknown): boolean {
  return typeof model === 'string' && DEVIN_CLI_FREE_MODELS.includes(model);
}

/**
 * The model a fleet run uses: a well-formed `override` (per run), else
 * `devin.fleetModel`, else DEVIN_CLI_FLEET_DEFAULT_MODEL. A malformed value
 * (spaces, a leading dash, uppercase, over 64 chars) is ignored rather than
 * passed to `--model`. Pure.
 */
export function resolveDevinCliFleetModel(section: AshlrConfig['devin'] | undefined, override?: string | null): string {
  for (const candidate of [override, section?.fleetModel]) {
    if (typeof candidate !== 'string') continue;
    const trimmed = candidate.trim();
    if (MODEL_ID_RE.test(trimmed)) return trimmed;
  }
  return DEVIN_CLI_FLEET_DEFAULT_MODEL;
}

export interface DevinCliLaneInput {
  /** cfg.devin. */
  section: AshlrConfig['devin'] | undefined;
  /** standingAuthorizesDevin(policy) — the grant names `devin` with a producer-only Devin seat. */
  grant: { ok: boolean; reason: string };
  /**
   * A9: does the (grant-clamped) budget mode let autonomy use the Devin seat
   * (`effectiveSeatPolicy(budget, 'devin', 'devin').enabled`)? null = the
   * budget could not be read (closed).
   */
  budgetAllowsDevin: boolean | null;
  /** The budget mode, for the refusal sentence. */
  budgetMode: string | null;
  /** The CLI readiness probe (cli-probe.ts); null = not probed (closed). */
  probe: { state: DevinCliProbeState; reason: string | null } | null;
  /** The model the lane would run (resolveDevinCliFleetModel). */
  model: string;
}

export interface DevinCliLaneVerdict {
  ok: boolean;
  /** Why the lane is closed (one sentence, with the fix when there is one); the open sentence otherwise. */
  reason: string;
}

/**
 * May the fleet run the Devin CLI this tick? Every check, first failure
 * wins, in the order Mason would fix them. PURE.
 *
 *   1. `devin.enabled` and the `devin.fleet` opt-in — the SAME switches the
 *      cloud launcher reads (devin/service.ts devinEnabled / devinFleetOptIn);
 *   2. the grant: its current stage names `devin` and the Devin seat is an
 *      enabled producer (never judge, never Leader);
 *   3. the budget mode lets autonomy use the Devin seat (reserve mode does not);
 *   4. the model is a free SWE-2 model (a billed model's spend is unreadable);
 *   5. the CLI is installed and logged in.
 */
export function devinCliLaneVerdict(input: DevinCliLaneInput): DevinCliLaneVerdict {
  if (input.section?.enabled !== true) {
    return { ok: false, reason: 'The Devin lane is turned off (`ashlr devin enable`).' };
  }
  if (input.section?.fleet !== true) {
    return { ok: false, reason: 'The fleet may not use Devin — the Devin fleet opt-in is off (`ashlr devin fleet on`).' };
  }
  if (!input.grant.ok) return { ok: false, reason: input.grant.reason };
  if (input.budgetAllowsDevin !== true) {
    return {
      ok: false,
      reason: input.budgetAllowsDevin === null
        ? 'The budget could not be read, so the Devin seat is not used.'
        : `The ${input.budgetMode ?? 'current'} budget mode keeps the Devin seat off for autonomy.`,
    };
  }
  if (!isDevinCliFreeModel(input.model)) {
    return {
      ok: false,
      reason: `devin.fleetModel "${input.model}" is billed by Devin and its spend cannot be read back, so autonomy holds it — use a free SWE-2 model (${DEVIN_CLI_FREE_MODELS.join(', ')}).`,
    };
  }
  if (!input.probe) return { ok: false, reason: 'The Devin CLI has not been checked yet.' };
  if (input.probe.state !== 'ready') {
    return { ok: false, reason: input.probe.reason ?? 'The Devin CLI is not ready.' };
  }
  return { ok: true, reason: `The Devin CLI runs ${input.model} (free) as a producer under the grant's Devin authorization.` };
}
