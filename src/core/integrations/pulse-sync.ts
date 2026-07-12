/**
 * core/integrations/pulse-sync.ts — Phase H (Pulse Map fleet round-trip).
 *
 * The LOCAL orchestrator that makes "cloud orchestrates, local executes" LIVE.
 * It ties together the three already-built primitives in this repo:
 *
 *   1. pulse-exporter.ts — emit fleet activity as OTLP spans + poll/patch the
 *      cloud's `fleet_command` queue (no inbound socket; the daemon PULLS work).
 *   2. dep-parser.ts     — parse a locally-enrolled repo's manifests into a
 *      METADATA-ONLY `depends_on` edge list and ship it as graph metadata.
 *   3. goals/inbox/policy — the LOCAL executors a cloud command resolves to:
 *        assign_goal      → createGoal()           (goals/store.ts)
 *        approve_proposal → setStatus('approved')  (inbox/store.ts)
 *        reject_proposal  → setStatus('rejected')  (inbox/store.ts)
 *        enroll_repo      → enroll()               (sandbox/policy.ts)
 *
 * THE ROUND-TRIP (per daemon tick, all best-effort):
 *   (a) emit a 'tick' span so the cloud graph shows this machine is alive;
 *   (b) GET pending fleet_command rows (read-scoped PAT), CLAIM each one,
 *       execute it LOCALLY, then PATCH the outcome (metadata-only) back;
 *   (c) ship dependency edges for enrolled repos as `deps` spans.
 *
 * SAFETY / PRIVACY (non-negotiable — inherits the daemon's guarantees):
 *   - NEVER throws from any exported function. A Pulse outage, a bad command,
 *     or a hung server must NEVER break the local daemon — every path is
 *     wrapped and returns a typed result object (house style).
 *   - OPT-IN + GATED: a complete no-op unless BOTH a Pulse endpoint AND a PAT
 *     are configured. The endpoint comes from cfg.pulse.endpoint OR the
 *     PULSE_URL env var; the PAT from PULSE_FLEET_PAT / ASHLR_PULSE_* env.
 *     When unset, runPulseSync() returns { enabled:false } and touches nothing.
 *   - METADATA ONLY: spans + command results carry ids, counts, names,
 *     outcomes, branch names, PR urls — NEVER prompts, completions, code,
 *     file contents, or diffs.
 *   - RESPECTS THE DAEMON SAFETY FLOOR: this module performs NO outward git
 *     action of its own. assign_goal only PLANS (createGoal records a
 *     'planning' goal; the daemon's proposal-only swarm path is what advances
 *     it later, behind enrollment + kill-switch). approve_proposal only flips a
 *     proposal's STATUS to 'approved' — it does NOT apply the diff; an explicit
 *     human/daemon apply pass is still required. enroll_repo is purely the
 *     enrollment-registry add. The kill-switch / enrollment / proposal-only
 *     gates elsewhere are never weakened from here.
 */

import type { AshlrConfig } from '../types.js';
import {
  exportFleetEvents,
  shipDepEdges,
  pollFleetCommands,
  patchFleetCommand,
  claimFleetCommand,
  type PulseExporterConfig,
  type FleetCommand,
  type FleetSpanInput,
} from './pulse-exporter.js';
import { parseRepoDeps } from './dep-parser.js';
import { createGoal } from '../goals/store.js';
import { setStatus, loadProposal } from '../inbox/store.js';
import { enroll, listEnrolled } from '../sandbox/policy.js';
import { githubStatus } from '../integrations/github.js';
import { audit } from '../sandbox/audit.js';

// ---------------------------------------------------------------------------
// Env bridge — let the spec's PULSE_URL / PULSE_FLEET_PAT gate this module
// without requiring an on-disk config edit, while staying fully compatible
// with the M89 exporter's cfg.pulse + ASHLR_PULSE_PAT / ASHLR_PULSE_READ_PAT.
// ---------------------------------------------------------------------------

/** Endpoint env var (spec). Falls back to cfg.pulse.endpoint then localhost. */
const PULSE_URL_ENV = 'PULSE_URL';
/** Fleet PAT env var (spec). Forwarded to exporter calls as opts.pat. */
const PULSE_FLEET_PAT_ENV = 'PULSE_FLEET_PAT';
/** Exporter-native PAT env vars (M89) — accepted as fallbacks. */
const ASHLR_PULSE_PAT_ENV = 'ASHLR_PULSE_PAT';
const ASHLR_PULSE_READ_PAT_ENV = 'ASHLR_PULSE_READ_PAT';

/** Per-call cap so a flooded queue can't monopolise a tick. */
const MAX_COMMANDS_PER_TICK = 25;
/** Per-tick cap on repos whose deps we ship (bounds local file I/O per tick). */
const MAX_DEP_REPOS_PER_TICK = 50;

/** Resolve the configured Pulse endpoint (env → cfg → undefined). */
function resolveEndpoint(cfg: AshlrConfig): string | undefined {
  const fromEnv = process.env[PULSE_URL_ENV];
  if (fromEnv && fromEnv.length > 0) return fromEnv;
  const fromCfg = cfg.pulse?.endpoint;
  if (fromCfg && fromCfg.length > 0) return fromCfg;
  return undefined;
}

/** Resolve the fleet PAT (spec env → exporter envs). Null when none present. */
function resolvePat(): string | null {
  const pat =
    process.env[PULSE_FLEET_PAT_ENV] ??
    process.env[ASHLR_PULSE_READ_PAT_ENV] ??
    process.env[ASHLR_PULSE_PAT_ENV];
  return pat && pat.length > 0 ? pat : null;
}

/**
 * Is the fleet→pulse round-trip enabled for this machine?
 * TRUE only when there is BOTH an endpoint AND a PAT, AND either the operator
 * opted in via cfg.pulse.enabled OR the spec's PULSE_URL env is present (env
 * presence is itself an explicit opt-in). Conservative: defaults to disabled.
 */
export function pulseSyncEnabled(cfg: AshlrConfig): boolean {
  const hasEndpoint = !!resolveEndpoint(cfg);
  const hasPat = !!resolvePat();
  const optedIn = cfg.pulse?.enabled === true || !!process.env[PULSE_URL_ENV];
  return hasEndpoint && hasPat && optedIn;
}

/**
 * Build the structural PulseExporterConfig the exporter expects, forcing
 * `enabled:true` (we already gated above) and the resolved endpoint. Keeping
 * the exporter decoupled from the full AshlrConfig tree (its own design).
 */
function exporterConfig(cfg: AshlrConfig): PulseExporterConfig {
  return {
    pulse: { enabled: true, endpoint: resolveEndpoint(cfg) },
    ...(cfg.user ? { user: { id: cfg.user.id, name: cfg.user.name } } : {}),
  };
}

/** The PAT forwarded to every exporter call (so env precedence is uniform). */
function patOpt(): { pat: string } | undefined {
  const pat = resolvePat();
  return pat ? { pat } : undefined;
}

/** A stable per-machine claimant id for command claims + writebacks. */
function claimantId(cfg: AshlrConfig): string {
  return cfg.user?.id ?? cfg.user?.name ?? 'ashlr-fleet';
}

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

/** Outcome of applying ONE fleet command locally. METADATA ONLY. */
export interface CommandApplyResult {
  id: string;
  kind: FleetCommand['kind'];
  /** 'done' when the local action succeeded; 'failed' otherwise; 'skipped' when claimed by another machine or invalid. */
  outcome: 'done' | 'failed' | 'skipped';
  /** Short metadata detail (e.g. goal id, proposal id, reason). NEVER code/diffs. */
  detail: string;
}

/** Aggregate result of a full round-trip pass. */
export interface PulseSyncResult {
  enabled: boolean;
  /** 'tick' span export status. */
  tickEmitted: boolean;
  /** Per-command apply outcomes. */
  commands: CommandApplyResult[];
  /** Number of dependency edges shipped this pass. */
  depEdgesShipped: number;
  /** Human-readable one-liner (never contains the PAT). */
  detail: string;
}

// ---------------------------------------------------------------------------
// (a) tick / event spans
// ---------------------------------------------------------------------------

/**
 * Emit a single fleet event span to Pulse. Thin, gated, no-throw wrapper over
 * the exporter — used by the daemon to surface tick / proposal / merge /
 * decline activity. METADATA ONLY. Returns false on any no-op or failure.
 */
export async function emitFleetEvent(
  cfg: AshlrConfig,
  event: FleetSpanInput,
): Promise<boolean> {
  if (!pulseSyncEnabled(cfg)) return false;
  try {
    const res = await exportFleetEvents(exporterConfig(cfg), [event], patOpt());
    return res.ok && !res.skipped;
  } catch {
    return false;
  }
}

/**
 * Emit the per-tick heartbeat span. `refId` should be the tick ts so re-emits
 * dedup deterministically. Best-effort, no-throw.
 */
export async function emitTick(
  cfg: AshlrConfig,
  tickTs: string,
  outcome = 'tick',
): Promise<boolean> {
  return emitFleetEvent(cfg, { event: 'tick', refId: tickTs, outcome });
}

// ---------------------------------------------------------------------------
// (b) command poll + apply
// ---------------------------------------------------------------------------

/**
 * Apply ONE already-claimed fleet command to the LOCAL executors. Returns a
 * metadata-only outcome; NEVER throws. Performs no outward git action — see the
 * module-level safety note for why each kind is proposal-/registry-only.
 */
function applyCommand(cfg: AshlrConfig, cmd: FleetCommand): CommandApplyResult {
  const base = { id: cmd.id, kind: cmd.kind } as const;
  try {
    switch (cmd.kind) {
      case 'assign_goal': {
        // target/payload may carry the objective + an optional enrolled project.
        const objective =
          (typeof cmd.payload['objective'] === 'string' && cmd.payload['objective']) ||
          (typeof cmd.target === 'string' && cmd.target) ||
          '';
        if (!objective) {
          return { ...base, outcome: 'failed', detail: 'assign_goal: missing objective' };
        }
        const project =
          typeof cmd.payload['project'] === 'string' && cmd.payload['project'].length > 0
            ? cmd.payload['project']
            : null;
        // createGoal only PLANS (status 'planning'); the daemon's proposal-only
        // swarm advances it later behind enrollment + kill-switch. No outward action.
        const goal = createGoal(objective, { project, cfg: { user: cfg.user } });
        return { ...base, outcome: 'done', detail: `goal ${goal.id} created (planning)` };
      }

      case 'approve_proposal':
      case 'reject_proposal': {
        const proposalId =
          (typeof cmd.target === 'string' && cmd.target) ||
          (typeof cmd.payload['proposalId'] === 'string' && cmd.payload['proposalId']) ||
          '';
        if (!proposalId) {
          return { ...base, outcome: 'failed', detail: `${cmd.kind}: missing proposalId` };
        }
        const existing = loadProposal(proposalId);
        if (existing === null) {
          return { ...base, outcome: 'failed', detail: `proposal ${proposalId} not found` };
        }
        const status = cmd.kind === 'approve_proposal' ? 'approved' : 'rejected';
        // setStatus only flips the lifecycle status — it does NOT apply the
        // diff. An explicit apply pass is still required (proposal-only floor).
        if (setStatus(proposalId, status, 'resolved via pulse fleet command') === false) {
          return {
            ...base,
            outcome: 'failed',
            detail: `proposal ${proposalId} could not transition to ${status}`,
          };
        }
        return { ...base, outcome: 'done', detail: `proposal ${proposalId} → ${status}` };
      }

      case 'enroll_repo': {
        const repoPath =
          (typeof cmd.payload['path'] === 'string' && cmd.payload['path']) ||
          (typeof cmd.target === 'string' && cmd.target) ||
          '';
        if (!repoPath) {
          return { ...base, outcome: 'failed', detail: 'enroll_repo: missing repo path' };
        }
        // Enrollment add only — does NOT mutate the repo. The daemon's existing
        // enrollment gate still governs every later sandbox mutation.
        enroll(repoPath);
        return { ...base, outcome: 'done', detail: `enrolled ${repoPath}` };
      }

      default: {
        // Unknown kind — never guess; report and let the cloud decide.
        return { ...base, outcome: 'failed', detail: `unsupported command kind: ${String(cmd.kind)}` };
      }
    }
  } catch {
    return { ...base, outcome: 'failed', detail: 'unexpected error applying command' };
  }
}

/**
 * Poll the cloud fleet_command queue, CLAIM each pending command (so a second
 * machine on the same queue does not double-execute it), execute it locally,
 * and PATCH the outcome (metadata-only) back. Best-effort + no-throw.
 *
 * Claim semantics: the cloud is the authority. A non-2xx claim means another
 * machine won the race — we SKIP that command without executing it.
 */
export async function pollAndApplyCommands(
  cfg: AshlrConfig,
): Promise<CommandApplyResult[]> {
  if (!pulseSyncEnabled(cfg)) return [];
  const out: CommandApplyResult[] = [];
  try {
    const xcfg = exporterConfig(cfg);
    const claimant = claimantId(cfg);
    const poll = await pollFleetCommands(xcfg, {
      ...patOpt(),
      status: 'pending',
      limit: MAX_COMMANDS_PER_TICK,
    });
    if (!poll.ok || poll.commands.length === 0) return out;

    for (const cmd of poll.commands.slice(0, MAX_COMMANDS_PER_TICK)) {
      // 1. Atomically claim — skip if another machine got it first.
      const claim = await claimFleetCommand(xcfg, cmd.id, claimant, patOpt());
      if (!claim.ok) {
        out.push({ id: cmd.id, kind: cmd.kind, outcome: 'skipped', detail: claim.detail });
        continue;
      }

      // 2. Execute locally (never throws).
      const applied = applyCommand(cfg, cmd);
      out.push(applied);

      // 3. Write the outcome back (metadata-only result / error).
      try {
        if (applied.outcome === 'done') {
          await patchFleetCommand(
            xcfg,
            cmd.id,
            { status: 'done', claimedBy: claimant, result: { detail: applied.detail } },
            patOpt(),
          );
        } else {
          await patchFleetCommand(
            xcfg,
            cmd.id,
            { status: 'failed', claimedBy: claimant, error: applied.detail },
            patOpt(),
          );
        }
      } catch {
        // Writeback best-effort — the local action already happened; the cloud
        // can re-derive state from the next tick's spans.
      }

      // 4. Audit every applied command (metadata-only summary).
      try {
        audit({
          action: 'pulse:command',
          repo: null,
          sandboxId: null,
          summary: `fleet command ${cmd.kind} ${applied.outcome}: ${applied.detail}`,
          result: applied.outcome === 'done' ? 'ok' : 'error',
        });
      } catch {
        /* audit best-effort */
      }
    }
  } catch {
    // Whole pass best-effort — never break the daemon on a poll/apply failure.
  }
  return out;
}

// ---------------------------------------------------------------------------
// (c) dependency edge shipping
// ---------------------------------------------------------------------------

/**
 * Parse + ship dependency edges for every enrolled repo as `deps` spans.
 * METADATA ONLY — package names + ranges, never file contents. Returns the
 * total edge count shipped. Best-effort + no-throw.
 */
export async function shipEnrolledRepoDeps(cfg: AshlrConfig): Promise<number> {
  if (!pulseSyncEnabled(cfg)) return 0;
  let shipped = 0;
  try {
    const xcfg = exporterConfig(cfg);
    const repos = listEnrolled().slice(0, MAX_DEP_REPOS_PER_TICK);
    for (const repoPath of repos) {
      try {
        // Resolve a full owner/name when gh is available; dep-parser falls back
        // to the directory basename otherwise (no network dependency).
        let repoFullName: string | null = null;
        try {
          repoFullName = githubStatus(repoPath).repo ?? null;
        } catch {
          repoFullName = null;
        }
        const parsed = parseRepoDeps(repoPath, repoFullName);
        if (parsed.edges.length === 0) continue;
        const res = await shipDepEdges(
          xcfg,
          repoFullName ?? parsed.repoRef,
          parsed.edges,
          patOpt(),
        );
        if (res.ok && !res.skipped) shipped += res.spanCount;
      } catch {
        // One bad repo never aborts the rest.
      }
    }
  } catch {
    // Best-effort.
  }
  return shipped;
}

// ---------------------------------------------------------------------------
// Orchestrator — the single entry point the daemon calls per tick
// ---------------------------------------------------------------------------

/**
 * Run one full fleet→pulse round-trip pass:
 *   (a) emit a 'tick' heartbeat span,
 *   (b) poll + claim + apply + writeback pending fleet commands,
 *   (c) ship enrolled-repo dependency edges.
 *
 * A complete NO-OP (returns { enabled:false }) unless both an endpoint and a
 * PAT are configured. NEVER throws — a Pulse outage leaves the daemon intact.
 *
 * @param tickTs  ISO ts of the tick this pass belongs to (used as the tick
 *                span's dedup ref). Defaults to now.
 */
export async function runPulseSync(
  cfg: AshlrConfig,
  opts?: { tickTs?: string; shipDeps?: boolean },
): Promise<PulseSyncResult> {
  const disabled: PulseSyncResult = {
    enabled: false,
    tickEmitted: false,
    commands: [],
    depEdgesShipped: 0,
    detail: 'pulse-sync disabled (no PULSE_URL/endpoint or no PAT)',
  };
  if (!pulseSyncEnabled(cfg)) return disabled;

  const tickTs = opts?.tickTs ?? new Date().toISOString();
  try {
    // (a) heartbeat — best-effort, independent of the rest.
    const tickEmitted = await emitTick(cfg, tickTs);

    // (b) command round-trip.
    const commands = await pollAndApplyCommands(cfg);

    // (c) dependency edges (opt-out via shipDeps:false for cheap ticks).
    const depEdgesShipped =
      opts?.shipDeps === false ? 0 : await shipEnrolledRepoDeps(cfg);

    const applied = commands.filter((c) => c.outcome === 'done').length;
    return {
      enabled: true,
      tickEmitted,
      commands,
      depEdgesShipped,
      detail: `pulse-sync: tick ${tickEmitted ? 'sent' : 'skipped'}, ${applied}/${commands.length} command(s) applied, ${depEdgesShipped} dep edge(s) shipped`,
    };
  } catch {
    // Should be unreachable (each sub-step is wrapped) — final belt-and-suspenders.
    return { ...disabled, enabled: true, detail: 'pulse-sync: unexpected error (no-op)' };
  }
}
