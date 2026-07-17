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

import { AsyncLocalStorage } from 'node:async_hooks';
import { lstatSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
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
import {
  acquireProposalMutationLock,
  releaseProposalMutationLock,
  type ProposalMutationLock,
} from '../inbox/proposal-mutation-lock.js';
import { enroll, listEnrolled } from '../sandbox/policy.js';
import { githubStatus } from '../integrations/github.js';
import { audit } from '../sandbox/audit.js';
import {
  acquireOutwardMutationFence,
  ownsOutwardMutationFence,
  releaseOutwardMutationFence,
  type OutwardMutationFence,
} from '../sandbox/mutation-fence.js';

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
/** A crashed/paused claimant cannot strand a command beyond this default lease. */
const DEFAULT_COMMAND_CLAIM_LEASE_MS = 5 * 60_000;
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

function requestOpts(
  authority: OutwardMutationFence,
  signal?: AbortSignal,
): { pat?: string; signal?: AbortSignal; authority: OutwardMutationFence } {
  return { ...patOpt(), ...(signal ? { signal } : {}), authority };
}

/** A stable per-machine claimant id for command claims + writebacks. */
function claimantId(cfg: AshlrConfig): string {
  return cfg.user?.id ?? cfg.user?.name ?? 'ashlr-fleet';
}

function commandClaimLeaseMs(cfg: AshlrConfig): number {
  const configured = cfg.fleet?.sharedQueue?.leaseMs;
  return typeof configured === 'number' && Number.isFinite(configured) && configured > 0
    ? Math.min(24 * 60 * 60_000, Math.max(1_000, Math.trunc(configured)))
    : DEFAULT_COMMAND_CLAIM_LEASE_MS;
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

export interface PulseSyncOptions {
  tickTs?: string;
  shipDeps?: boolean;
  signal?: AbortSignal;
}

function aborted(signal?: AbortSignal): boolean {
  return signal?.aborted === true;
}

export type PulseAuthorityFailure = 'aborted' | 'kill-switch' | 'fence-unavailable' | 'fence-lost';

export interface PulseAuthority {
  fence: OutwardMutationFence;
  signal?: AbortSignal;
  pending: Set<Promise<unknown>>;
}

const pulseAuthorityStorage = new AsyncLocalStorage<PulseAuthority>();

/** Match policy.killSwitchOn(): only a proven ENOENT is permissive. */
function globalKillSwitchOn(): boolean {
  try {
    lstatSync(join(homedir(), '.ashlr', 'KILL'));
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ENOENT';
  }
}

function combineSignals(first?: AbortSignal, second?: AbortSignal): AbortSignal | undefined {
  if (!first) return second;
  if (!second || first === second) return first;
  return AbortSignal.any([first, second]);
}

function authorityFailure(
  authority: PulseAuthority,
  signal?: AbortSignal,
): PulseAuthorityFailure | null {
  if (!ownsOutwardMutationFence(authority.fence)) return 'fence-lost';
  if (globalKillSwitchOn()) return 'kill-switch';
  if (aborted(authority.signal) || aborted(signal)) return 'aborted';
  return null;
}

async function drainNestedPulseEffects(authority: PulseAuthority): Promise<void> {
  while (authority.pending.size > 0) {
    await Promise.allSettled([...authority.pending]);
  }
}

export async function withPulseAuthority<T>(
  signal: AbortSignal | undefined,
  blocked: (reason: PulseAuthorityFailure) => T,
  operation: (authority: PulseAuthority, signal?: AbortSignal) => Promise<T>,
): Promise<T> {
  const inherited = pulseAuthorityStorage.getStore();
  if (inherited) {
    const effectiveSignal = combineSignals(inherited.signal, signal);
    const failure = authorityFailure(inherited, effectiveSignal);
    if (failure) return blocked(failure);

    // Proposal lifecycle writes can start detached Pulse events. Register nested
    // work synchronously so the outer authority drains it before releasing.
    const pending = operation(inherited, effectiveSignal);
    inherited.pending.add(pending);
    try {
      return await pending;
    } finally {
      inherited.pending.delete(pending);
    }
  }

  if (aborted(signal)) return blocked('aborted');

  let fence: OutwardMutationFence | null = null;
  let authority: PulseAuthority | undefined;
  try {
    fence = acquireOutwardMutationFence();
    if (!fence || !ownsOutwardMutationFence(fence)) return blocked('fence-unavailable');

    // KILL is checked only after entering the global serialization boundary so
    // a concurrent resume/pause cannot race this decision.
    if (globalKillSwitchOn()) return blocked('kill-switch');
    if (aborted(signal)) return blocked('aborted');

    const activeAuthority: PulseAuthority = { fence, signal, pending: new Set() };
    authority = activeAuthority;
    const result = await pulseAuthorityStorage.run(
      activeAuthority,
      () => operation(activeAuthority, signal),
    );
    return result;
  } catch {
    return blocked(fence ? 'fence-lost' : 'fence-unavailable');
  } finally {
    if (authority) await drainNestedPulseEffects(authority);
    releaseOutwardMutationFence(fence);
  }
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
  opts?: Pick<PulseSyncOptions, 'signal'>,
): Promise<boolean> {
  if (aborted(opts?.signal) || !pulseSyncEnabled(cfg)) return false;
  return withPulseAuthority(opts?.signal, () => false, (authority, signal) =>
    emitFleetEventWithAuthority(cfg, event, authority, signal));
}

async function emitFleetEventWithAuthority(
  cfg: AshlrConfig,
  event: FleetSpanInput,
  authority: PulseAuthority,
  signal?: AbortSignal,
): Promise<boolean> {
  try {
    if (authorityFailure(authority, signal)) return false;
    const res = await exportFleetEvents(
      exporterConfig(cfg),
      [event],
      requestOpts(authority.fence, signal),
    );
    if (authorityFailure(authority, signal)) return false;
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
  opts?: Pick<PulseSyncOptions, 'signal'>,
): Promise<boolean> {
  return emitFleetEvent(cfg, { event: 'tick', refId: tickTs, outcome }, opts);
}

// ---------------------------------------------------------------------------
// (b) command poll + apply
// ---------------------------------------------------------------------------

/**
 * Apply ONE already-claimed fleet command to the LOCAL executors. Returns a
 * metadata-only outcome; NEVER throws. Performs no outward git action — see the
 * module-level safety note for why each kind is proposal-/registry-only.
 */
function applyNonProposalCommand(
  cfg: AshlrConfig,
  cmd: FleetCommand,
  outwardFence: OutwardMutationFence,
): CommandApplyResult {
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
        const enrollment = enroll(repoPath, { borrowedFence: outwardFence });
        // Production policy always returns a result; `undefined` only preserves
        // compatibility with older void-returning test doubles.
        if (enrollment !== undefined && (!enrollment.ok || !enrollment.quiesced)) {
          return {
            ...base,
            outcome: 'failed',
            detail: `could not enroll ${repoPath}: ${enrollment.reason}`,
          };
        }
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

interface ClaimedCommandExecution {
  result: CommandApplyResult;
  /** Retryable commands retain their claimed cloud state and receive no terminal PATCH. */
  retryable: boolean;
}

interface AuthorityAttempt<T> {
  granted: boolean;
  value?: T;
  reason?: PulseAuthorityFailure;
}

function retryableClaimedCommand(
  cmd: FleetCommand,
  reason: PulseAuthorityFailure | 'proposal-lock-unavailable',
): ClaimedCommandExecution {
  return {
    result: {
      id: cmd.id,
      kind: cmd.kind,
      outcome: 'skipped',
      detail: `claimed command remains retryable: ${reason}`,
    },
    retryable: true,
  };
}

async function underPulseAuthority<T>(
  signal: AbortSignal | undefined,
  operation: (authority: PulseAuthority, effectiveSignal?: AbortSignal) => Promise<T>,
): Promise<AuthorityAttempt<T>> {
  return withPulseAuthority<AuthorityAttempt<T>>(
    signal,
    (reason) => ({ granted: false, reason }),
    async (authority, effectiveSignal) => ({
      granted: true,
      value: await operation(authority, effectiveSignal),
    }),
  );
}

function proposalIdForCommand(cmd: FleetCommand): string {
  return (
    (typeof cmd.target === 'string' && cmd.target) ||
    (typeof cmd.payload['proposalId'] === 'string' && cmd.payload['proposalId']) ||
    ''
  );
}

function setPulseProposalStatus(
  proposalId: string,
  status: 'approved' | 'rejected',
  proposalLock: ProposalMutationLock,
): boolean {
  // Keep compatibility with legacy injected stores/test doubles that predate
  // the owner-capability parameter. The production store advertises and receives
  // the lock, preserving proposal -> outward order without a nested acquisition.
  return setStatus.length >= 5
    ? setStatus(
        proposalId,
        status,
        'resolved via pulse fleet command',
        undefined,
        proposalLock,
      ) !== false
    : setStatus(proposalId, status, 'resolved via pulse fleet command') !== false;
}

async function applyClaimedProposalCommand(
  cmd: FleetCommand,
  signal?: AbortSignal,
): Promise<ClaimedCommandExecution> {
  const base = { id: cmd.id, kind: cmd.kind } as const;
  const proposalId = proposalIdForCommand(cmd);
  if (!proposalId) {
    return {
      result: { ...base, outcome: 'failed', detail: `${cmd.kind}: missing proposalId` },
      retryable: false,
    };
  }

  let proposalLock: ProposalMutationLock | null = null;
  try {
    // Global order: proposal mutation lock, then outward authority. Never wait
    // for a proposal lock while excluding pause/resume from the outward fence.
    proposalLock = acquireProposalMutationLock(proposalId);
    if (!proposalLock) return retryableClaimedCommand(cmd, 'proposal-lock-unavailable');

    const mutation = await underPulseAuthority(signal, async () => {
      const existing = loadProposal(proposalId);
      if (existing === null) {
        return {
          result: { ...base, outcome: 'failed', detail: `proposal ${proposalId} not found` },
          retryable: false,
        } satisfies ClaimedCommandExecution;
      }

      const status = cmd.kind === 'approve_proposal' ? 'approved' : 'rejected';
      // This is status-only Pulse authority. Manual desktop apply remains on its
      // existing path and is deliberately not broadened here.
      if (!setPulseProposalStatus(proposalId, status, proposalLock!)) {
        return {
          result: {
            ...base,
            outcome: 'failed',
            detail: `proposal ${proposalId} could not transition to ${status}`,
          },
          retryable: false,
        } satisfies ClaimedCommandExecution;
      }
      return {
        result: { ...base, outcome: 'done', detail: `proposal ${proposalId} → ${status}` },
        retryable: false,
      } satisfies ClaimedCommandExecution;
    });

    return mutation.granted
      ? mutation.value!
      : retryableClaimedCommand(cmd, mutation.reason ?? 'fence-lost');
  } catch {
    return retryableClaimedCommand(cmd, 'fence-lost');
  } finally {
    releaseProposalMutationLock(proposalLock);
  }
}

async function applyClaimedCommand(
  cfg: AshlrConfig,
  cmd: FleetCommand,
  signal?: AbortSignal,
): Promise<ClaimedCommandExecution> {
  if (cmd.kind === 'approve_proposal' || cmd.kind === 'reject_proposal') {
    return applyClaimedProposalCommand(cmd, signal);
  }

  const applied = await underPulseAuthority(signal, async (authority) => ({
    result: applyNonProposalCommand(cfg, cmd, authority.fence),
    retryable: false,
  } satisfies ClaimedCommandExecution));
  return applied.granted
    ? applied.value!
    : retryableClaimedCommand(cmd, applied.reason ?? 'fence-lost');
}

function claimExpired(cmd: FleetCommand, nowMs: number, leaseMs: number): boolean {
  if (!cmd.claimedAt) return false;
  const claimedAtMs = Date.parse(cmd.claimedAt);
  return Number.isFinite(claimedAtMs) && claimedAtMs <= nowMs - leaseMs;
}

async function recoverExpiredClaimedCommands(
  cfg: AshlrConfig,
  xcfg: PulseExporterConfig,
  claimant: string,
  signal?: AbortSignal,
): Promise<void> {
  const claimed = await underPulseAuthority(signal, (authority, effectiveSignal) =>
    pollFleetCommands(xcfg, {
      ...requestOpts(authority.fence, effectiveSignal),
      status: 'claimed',
      limit: MAX_COMMANDS_PER_TICK,
    }));
  if (!claimed.granted || !claimed.value?.ok) return;

  const nowMs = Date.now();
  const leaseMs = commandClaimLeaseMs(cfg);
  for (const cmd of claimed.value.commands.slice(0, MAX_COMMANDS_PER_TICK)) {
    if (aborted(signal) || globalKillSwitchOn()) return;
    if (cmd.status !== 'claimed' || cmd.claimedBy !== claimant ||
      !claimExpired(cmd, nowMs, leaseMs)) continue;

    const recovered = await underPulseAuthority(signal, (authority, effectiveSignal) =>
      patchFleetCommand(
        xcfg,
        cmd.id,
        { status: 'pending', claimedBy: claimant },
        requestOpts(authority.fence, effectiveSignal),
      ));
    if (!recovered.granted) return;
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
  opts?: Pick<PulseSyncOptions, 'signal'>,
): Promise<CommandApplyResult[]> {
  const signal = opts?.signal;
  if (aborted(signal) || !pulseSyncEnabled(cfg)) return [];
  return pollAndApplyCommandsWithAuthority(cfg, signal);
}

async function pollAndApplyCommandsWithAuthority(
  cfg: AshlrConfig,
  signal?: AbortSignal,
): Promise<CommandApplyResult[]> {
  const out: CommandApplyResult[] = [];
  try {
    const xcfg = exporterConfig(cfg);
    const claimant = claimantId(cfg);
    // Recovery is bounded by both the queue limit and a time lease. It runs
    // before pending polling so a command abandoned when pause won can be
    // re-claimed on the same resumed/restarted pass without a false failure.
    await recoverExpiredClaimedCommands(cfg, xcfg, claimant, signal);
    if (aborted(signal) || globalKillSwitchOn()) return out;
    const polled = await underPulseAuthority(signal, (authority, effectiveSignal) =>
      pollFleetCommands(xcfg, {
        ...requestOpts(authority.fence, effectiveSignal),
        status: 'pending',
        limit: MAX_COMMANDS_PER_TICK,
      }));
    if (!polled.granted || !polled.value) return out;
    const poll = polled.value;
    if (!poll.ok || poll.commands.length === 0) return out;

    for (const cmd of poll.commands.slice(0, MAX_COMMANDS_PER_TICK)) {
      if (aborted(signal) || globalKillSwitchOn()) break;
      // 1. Atomically claim — skip if another machine got it first.
      const claimed = await underPulseAuthority(signal, (authority, effectiveSignal) =>
        claimFleetCommand(
          xcfg,
          cmd.id,
          claimant,
          requestOpts(authority.fence, effectiveSignal),
        ));
      if (!claimed.granted || !claimed.value) break;
      const claim = claimed.value;
      if (!claim.ok) {
        out.push({ id: cmd.id, kind: cmd.kind, outcome: 'skipped', detail: claim.detail });
        continue;
      }

      // 2. Execute locally (never throws).
      const execution = await applyClaimedCommand(cfg, cmd, signal);
      const applied = execution.result;
      out.push(applied);
      if (execution.retryable) continue;

      // 3. Write the outcome back (metadata-only result / error).
      try {
        const written = await underPulseAuthority(signal, (authority, effectiveSignal) =>
          applied.outcome === 'done'
            ? patchFleetCommand(
                xcfg,
                cmd.id,
                { status: 'done', claimedBy: claimant, result: { detail: applied.detail } },
                requestOpts(authority.fence, effectiveSignal),
              )
            : patchFleetCommand(
                xcfg,
                cmd.id,
                { status: 'failed', claimedBy: claimant, error: applied.detail },
                requestOpts(authority.fence, effectiveSignal),
              ));
        if (!written.granted) break;
      } catch {
        // Writeback best-effort — the local action already happened; the cloud
        // can re-derive state from the next tick's spans.
      }

      // 4. Audit every applied command (metadata-only summary).
      if (aborted(signal) || globalKillSwitchOn()) break;
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
export async function shipEnrolledRepoDeps(
  cfg: AshlrConfig,
  opts?: Pick<PulseSyncOptions, 'signal'>,
): Promise<number> {
  const signal = opts?.signal;
  if (aborted(signal) || !pulseSyncEnabled(cfg)) return 0;
  return withPulseAuthority(signal, () => 0, (authority, effectiveSignal) =>
    shipEnrolledRepoDepsWithAuthority(cfg, authority, effectiveSignal));
}

async function shipEnrolledRepoDepsWithAuthority(
  cfg: AshlrConfig,
  authority: PulseAuthority,
  signal?: AbortSignal,
): Promise<number> {
  let shipped = 0;
  try {
    const xcfg = exporterConfig(cfg);
    if (authorityFailure(authority, signal)) return shipped;
    const repos = listEnrolled().slice(0, MAX_DEP_REPOS_PER_TICK);
    for (const repoPath of repos) {
      if (authorityFailure(authority, signal)) break;
      try {
        // Resolve a full owner/name when gh is available; dep-parser falls back
        // to the directory basename otherwise (no network dependency).
        let repoFullName: string | null = null;
        try {
          repoFullName = githubStatus(repoPath).repo ?? null;
        } catch {
          repoFullName = null;
        }
        if (authorityFailure(authority, signal)) break;
        const parsed = parseRepoDeps(repoPath, repoFullName);
        if (authorityFailure(authority, signal)) break;
        if (parsed.edges.length === 0) continue;
        if (authorityFailure(authority, signal)) break;
        const res = await shipDepEdges(
          xcfg,
          repoFullName ?? parsed.repoRef,
          parsed.edges,
          requestOpts(authority.fence, signal),
        );
        if (authorityFailure(authority, signal)) break;
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
  opts?: PulseSyncOptions,
): Promise<PulseSyncResult> {
  const disabled: PulseSyncResult = {
    enabled: false,
    tickEmitted: false,
    commands: [],
    depEdgesShipped: 0,
    detail: 'pulse-sync disabled (no PULSE_URL/endpoint or no PAT)',
  };
  if (aborted(opts?.signal)) {
    return { ...disabled, detail: 'pulse-sync aborted before start' };
  }
  if (!pulseSyncEnabled(cfg)) return disabled;

  const tickTs = opts?.tickTs ?? new Date().toISOString();
  const gate = await underPulseAuthority(opts?.signal, async () => true);
  if (!gate.granted) {
    const reason = gate.reason ?? 'fence-unavailable';
    return {
      ...disabled,
      enabled: true,
      detail: reason === 'aborted'
        ? 'pulse-sync aborted before remote effect'
        : reason === 'kill-switch'
          ? 'pulse-sync blocked by global KILL'
          : `pulse-sync blocked: outward mutation authority ${reason === 'fence-lost' ? 'was lost' : 'unavailable'}`,
    };
  }

  try {
    // Each phase obtains only the authority it needs. In particular, command
    // polling never carries outward authority into a proposal-lock acquisition.
    const tickEmitted = await emitFleetEvent(
      cfg,
      { event: 'tick', refId: tickTs, outcome: 'tick' },
      { signal: opts?.signal },
    );
    if (aborted(opts?.signal)) {
      return { ...disabled, enabled: true, detail: 'pulse-sync aborted after tick export' };
    }
    if (globalKillSwitchOn()) {
      return { ...disabled, enabled: true, tickEmitted, detail: 'pulse-sync blocked by global KILL' };
    }

    const commands = await pollAndApplyCommands(cfg, { signal: opts?.signal });
    if (aborted(opts?.signal)) {
      return {
        ...disabled,
        enabled: true,
        tickEmitted,
        commands,
        detail: 'pulse-sync aborted during command sync',
      };
    }
    if (globalKillSwitchOn()) {
      return {
        ...disabled,
        enabled: true,
        tickEmitted,
        commands,
        detail: 'pulse-sync blocked by global KILL during command sync',
      };
    }

    const depEdgesShipped = opts?.shipDeps === false
      ? 0
      : await shipEnrolledRepoDeps(cfg, { signal: opts?.signal });
    if (aborted(opts?.signal)) {
      return {
        enabled: true,
        tickEmitted,
        commands,
        depEdgesShipped,
        detail: 'pulse-sync aborted during dependency shipping',
      };
    }
    if (globalKillSwitchOn()) {
      return {
        enabled: true,
        tickEmitted,
        commands,
        depEdgesShipped,
        detail: 'pulse-sync blocked by global KILL during dependency shipping',
      };
    }

    const applied = commands.filter((c) => c.outcome === 'done').length;
    return {
      enabled: true,
      tickEmitted,
      commands,
      depEdgesShipped,
      detail: `pulse-sync: tick ${tickEmitted ? 'sent' : 'skipped'}, ${applied}/${commands.length} command(s) applied, ${depEdgesShipped} dep edge(s) shipped`,
    };
  } catch {
    return { ...disabled, enabled: true, detail: 'pulse-sync: unexpected error (no-op)' };
  }
}
