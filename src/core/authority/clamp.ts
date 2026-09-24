/**
 * The clamp — V3.10 Track B (unit B-U1).
 *
 * ~/.ashlr/authority/clamp.json holds the Autonomy switch (Off / Propose /
 * Autonomous). This module also owns the other two LOWERING controls, Stop
 * (~/.ashlr/KILL) and Revoke, and the one raising control that needs no Touch
 * ID: raising the switch back up to what the installed grant already allows.
 *
 * MONOTONIC BY CONSTRUCTION (invariant I1):
 *   - lowering (switch down, Stop, Revoke) needs no auth, acts FIRST and
 *     ledgers best-effort — it must work even when the ledger is broken;
 *   - raising is capped at `cap` (maxSwitchWithoutGrant, computed by the
 *     caller from the verified grant), ledgers FIRST and only then writes, so
 *     an unrecorded raise cannot happen. Past the cap the answer is
 *     `grant-required`: only a new Touch ID grant widens authority.
 * Even a raised clamp.json can never exceed the grant: the effective switch
 * is always min(switch, grant) when the policy is computed.
 *
 * A missing clamp.json means `off` (dark by default); an unreadable one also
 * means `off` and is reported, so a corrupted file can only lower authority.
 *
 * STOP and REVOKE (3.10 integration): both arm ~/.ashlr/KILL, abort running
 * agents through U6's execution leases (reporting how many are still live)
 * and revoke every ARMED host merge through U3's revocation protocol. Revoke
 * additionally switches off and burns the grant sequence. Each has an instant
 * variant (a request handler must answer at once) and a draining variant that
 * waits for agents to exit (the CLI).
 */
import { homedir } from 'node:os';
import { join } from 'node:path';

import { countLiveExecutionLeases } from '../sandbox/execution-leases.js';
import { readKillSwitch, setKill, setKillAndDrain } from '../sandbox/policy.js';
import type { FleetActor } from '../fleet/fleet-types.js';
import { canonicalJson } from './canonical-json.js';
import {
  appendLedger,
  authorityDir,
  ensureAuthorityDir,
  ledgerSnapshot,
  readPrivateText,
  writePrivateAtomically,
} from './ledger.js';
import { archiveInstalledGrant, readInstalledGrant } from './standing-grant.js';
import { AUTONOMY_SWITCHES, AUTONOMY_SWITCH_RANK, type AutonomySwitch } from './types.js';
import { scrubSecrets } from '../util/scrub.js';

export function clampPath(): string {
  return join(authorityDir(), 'clamp.json');
}

export interface ClampStateV1 {
  v: 1;
  switch: AutonomySwitch;
  updatedAt: string;
  updatedBy: FleetActor;
  reason: string;
}

export type ClampRead =
  | { state: 'default'; clamp: ClampStateV1 }
  | { state: 'ok'; clamp: ClampStateV1 }
  | { state: 'invalid'; clamp: ClampStateV1; reason: string };

const OFF: ClampStateV1 = Object.freeze({
  v: 1,
  switch: 'off',
  // Epoch: nothing was ever decided.
  updatedAt: new Date(0).toISOString(),
  updatedBy: 'daemon',
  reason: 'no switch set yet',
}) as ClampStateV1;

const REASON_MAX = 300;

function cleanReason(reason: string): string {
  return scrubSecrets(reason.replace(/\s+/g, ' ').trim()).slice(0, REASON_MAX) || 'no reason given';
}

/** The switch as last set. Never throws; anything doubtful reads as `off`. */
export function readClamp(): ClampRead {
  const read = readPrivateText(clampPath(), 16 * 1024);
  if (read.state === 'missing') return { state: 'default', clamp: OFF };
  if (read.state === 'invalid') return { state: 'invalid', clamp: OFF, reason: 'clamp.json is not a private file owned by you' };
  try {
    const value = JSON.parse(read.text) as Record<string, unknown>;
    const sw = value['switch'];
    if (value['v'] !== 1 || typeof sw !== 'string' || !(AUTONOMY_SWITCHES as readonly string[]).includes(sw)) {
      return { state: 'invalid', clamp: OFF, reason: 'clamp.json does not hold a known switch position' };
    }
    return {
      state: 'ok',
      clamp: {
        v: 1,
        switch: sw as AutonomySwitch,
        updatedAt: typeof value['updatedAt'] === 'string' ? value['updatedAt'] : OFF.updatedAt,
        updatedBy: (typeof value['updatedBy'] === 'string' ? value['updatedBy'] : 'daemon') as FleetActor,
        reason: typeof value['reason'] === 'string' ? value['reason'].slice(0, REASON_MAX) : '',
      },
    };
  } catch {
    return { state: 'invalid', clamp: OFF, reason: 'clamp.json is not valid JSON' };
  }
}

function writeClamp(next: ClampStateV1): void {
  ensureAuthorityDir();
  writePrivateAtomically(clampPath(), `${canonicalJson(next)}\n`);
}

export function minSwitch(a: AutonomySwitch, b: AutonomySwitch): AutonomySwitch {
  return AUTONOMY_SWITCH_RANK[a] <= AUTONOMY_SWITCH_RANK[b] ? a : b;
}

export interface SwitchChangeRequest {
  to: AutonomySwitch;
  actor: FleetActor;
  reason: string;
  /** Highest position reachable without a new grant (maxSwitchWithoutGrant). Only consulted when raising. */
  cap: AutonomySwitch;
}

export type SwitchChangeResult =
  | { ok: true; from: AutonomySwitch; to: AutonomySwitch; changed: boolean; ledgered: boolean }
  | { ok: false; code: 'grant-required' | 'ledger' | 'storage' | 'invalid'; reason: string; from: AutonomySwitch; cap: AutonomySwitch };

/**
 * Move the switch. Lowering always succeeds (it acts before it records);
 * raising within `cap` records first; raising past `cap` is `grant-required`.
 */
export function setAutonomySwitch(req: SwitchChangeRequest): SwitchChangeResult {
  const current = readClamp().clamp.switch;
  if (!(AUTONOMY_SWITCHES as readonly string[]).includes(req.to)) {
    return { ok: false, code: 'invalid', reason: `unknown switch position "${String(req.to)}"`, from: current, cap: req.cap };
  }
  const reason = cleanReason(req.reason);
  const next: ClampStateV1 = { v: 1, switch: req.to, updatedAt: new Date().toISOString(), updatedBy: req.actor, reason };
  const lowering = AUTONOMY_SWITCH_RANK[req.to] <= AUTONOMY_SWITCH_RANK[current];
  if (lowering) {
    try {
      writeClamp(next);
    } catch (error) {
      return { ok: false, code: 'storage', reason: `could not write the switch: ${(error as Error).message}`, from: current, cap: req.cap };
    }
    const ledgered = req.to === current
      ? true
      : appendLedger({ kind: 'switch:changed', actor: req.actor, grantId: null, repo: null, data: { from: current, to: req.to, requested: req.to, reason } }).ok;
    return { ok: true, from: current, to: req.to, changed: req.to !== current, ledgered };
  }
  if (AUTONOMY_SWITCH_RANK[req.to] > AUTONOMY_SWITCH_RANK[req.cap]) {
    return {
      ok: false,
      code: 'grant-required',
      reason: req.cap === 'off'
        ? 'No active standing grant allows autonomy — approve a grant with Touch ID first.'
        : `The installed grant allows at most "${req.cap}" — approving more needs a new grant (Touch ID).`,
      from: current,
      cap: req.cap,
    };
  }
  const recorded = appendLedger({ kind: 'switch:changed', actor: req.actor, grantId: null, repo: null, data: { from: current, to: req.to, requested: req.to, reason } });
  if (!recorded.ok) return { ok: false, code: 'ledger', reason: `not raised — the ledger refused the record: ${recorded.reason}`, from: current, cap: req.cap };
  try {
    writeClamp(next);
  } catch (error) {
    return { ok: false, code: 'storage', reason: `could not write the switch: ${(error as Error).message}`, from: current, cap: req.cap };
  }
  return { ok: true, from: current, to: req.to, changed: true, ledgered: true };
}

export interface StopResult {
  ok: boolean;
  /** KILL is durably armed. */
  armed: boolean;
  /** No agent admitted before KILL is still running. */
  quiesced: boolean;
  ledgered: boolean;
  reason: string;
  /**
   * Execution leases (running agents, any process) still live when this
   * returned — 0 when quiesced. Unknown leases count as live (fail closed).
   */
  liveExecutionLeases: number;
  /** How long this call waited for agents to drain (0 for the instant variant). */
  drainWaitedMs: number;
  /**
   * Armed host merges revoked at the protocol level (U3). `null` = the
   * revocation was started but not awaited (the synchronous variant).
   */
  mergesRevoked: number | null;
  /** Armed merges that could not be revoked (they stay blocked by KILL at consume time). */
  mergeRevokeFailures: string[];
}

export interface MergeRevocationOutcome {
  revoked: number;
  failed: string[];
}

/**
 * Revoke every ARMED host merge (fleet/host-merge.ts revokeArmedHostMerges),
 * so a merge another process prepared cannot be consumed after Stop.
 *
 * WHY A DYNAMIC IMPORT: host-merge's static closure is ~210 modules (the
 * inbox, git, GitHub, goals …) while this module's importer
 * effective-config.ts has ~20 — a static import would drag the whole merge
 * stack into every process that merely READS the standing policy (confine.ts,
 * the router, the Verse status route). The literal specifier keeps host-merge
 * inside the authority-surface and Tier-1 closure walks.
 *
 * Never throws: Stop must not fail because the merge module is unavailable —
 * the consume step independently refuses while KILL is on (belt and braces).
 */
export async function revokeArmedMerges(reason: string): Promise<MergeRevocationOutcome> {
  try {
    const { revokeArmedHostMerges } = await import('../fleet/host-merge.js');
    return revokeArmedHostMerges(reason.slice(0, REASON_MAX));
  } catch (error) {
    return { revoked: 0, failed: [`the host-merge module could not be loaded: ${scrubSecrets((error as Error).message).slice(0, 200)}`] };
  }
}

/**
 * Fire-and-forget revocation for the SYNCHRONOUS Stop / Revoke (the Verse
 * route calls those and must answer at once). It runs a few milliseconds
 * later in this same process.
 *
 * WHY THE HOME CHECK: revocation writes merge state and an audit row under
 * ~/.ashlr. If HOME changed between the Stop and the deferred run (a test
 * restoring its isolated HOME, a process that re-targets HOME), writing
 * would land in a DIFFERENT ~/.ashlr than the one Stop was pressed for — so
 * it skips instead. The skipped case is still safe: KILL was armed first and
 * the host-merge consume step refuses while KILL is on or its epoch changed.
 */
function startMergeRevocation(reason: string): void {
  const home = homedir();
  void (async () => {
    try {
      const mod = await import('../fleet/host-merge.js');
      if (homedir() !== home) return;
      mod.revokeArmedHostMerges(reason.slice(0, REASON_MAX));
    } catch {
      // Best effort — see revokeArmedMerges: KILL alone already blocks consume.
    }
  })();
}

function liveLeasesAfter(quiesced: boolean): number {
  if (quiesced) return 0;
  try {
    return countLiveExecutionLeases(null);
  } catch {
    // Unknown is reported as "at least one still running" — never as drained.
    return 1;
  }
}

/**
 * Stop, instant variant (the Verse route; it must answer at once): arm
 * ~/.ashlr/KILL (this process's agents are aborted now, other processes' at
 * their next lease poll), start revoking armed host merges, report how many
 * agents are still running. Lowering: acts first, ledgers after.
 * `waitMs` bounds the synchronous fence wait — 0 from a request handler.
 * Prefer stopAutonomyAndDrain wherever the caller can await.
 */
export function stopAutonomy(opts: { actor: FleetActor; reason: string; waitMs?: number }): StopResult {
  const reason = cleanReason(opts.reason);
  const result = setKill(true, { waitMs: opts.waitMs ?? 0 });
  // setKill arms the sentinel BEFORE it waits for agents to drain; report the
  // durable truth (is KILL on disk?) rather than the outcome of the wait.
  const armed = readKillSwitch().state === 'active';
  startMergeRevocation(reason);
  const ledgered = appendLedger({ kind: 'kill:on', actor: opts.actor, grantId: null, repo: null, data: { reason } }).ok;
  return {
    ok: armed,
    armed,
    quiesced: result.quiesced,
    ledgered,
    reason: result.reason,
    liveExecutionLeases: liveLeasesAfter(result.quiesced),
    drainWaitedMs: 0,
    mergesRevoked: null,
    mergeRevokeFailures: [],
  };
}

/**
 * Stop, draining variant (the CLI; any caller that can await): arm KILL,
 * revoke armed host merges and wait up to `drainMs` (default 30 s, U6's
 * EXECUTION_LEASE_DRAIN_MS) for every running agent's execution lease to be
 * released. `quiesced:true` = no autonomous agent is running and none can start.
 */
export async function stopAutonomyAndDrain(opts: { actor: FleetActor; reason: string; drainMs?: number; waitMs?: number }): Promise<StopResult> {
  const reason = cleanReason(opts.reason);
  // setKillAndDrain installs ~/.ashlr/KILL synchronously, before its first
  // await, so KILL is armed by the time the merge revocation below runs; the
  // order is not load-bearing anyway (consume re-checks KILL under the fence).
  const draining = setKillAndDrain({
    waitMs: opts.waitMs ?? 2_000,
    ...(opts.drainMs !== undefined ? { drainMs: opts.drainMs } : {}),
  });
  const merges = await revokeArmedMerges(reason);
  const drained = await draining;
  const armed = readKillSwitch().state === 'active';
  const ledgered = appendLedger({ kind: 'kill:on', actor: opts.actor, grantId: null, repo: null, data: { reason } }).ok;
  return {
    ok: armed,
    armed,
    quiesced: drained.quiesced,
    ledgered,
    reason: drained.reason,
    liveExecutionLeases: drained.liveExecutionLeases,
    drainWaitedMs: drained.drainWaitedMs,
    mergesRevoked: merges.revoked,
    mergeRevokeFailures: merges.failed,
  };
}

/**
 * Clear Stop (raising — it lets autonomy run again within the grant): the
 * ledger must record it first. It never needs Touch ID: resuming stays inside
 * what the installed grant already allows.
 */
export function clearStop(opts: { actor: FleetActor; reason: string; waitMs?: number }): { ok: boolean; reason: string } {
  const recorded = appendLedger({ kind: 'kill:off', actor: opts.actor, grantId: null, repo: null, data: { reason: cleanReason(opts.reason) } });
  if (!recorded.ok) return { ok: false, reason: `not cleared — the ledger refused the record: ${recorded.reason}` };
  const result = setKill(false, { waitMs: opts.waitMs ?? 0 });
  if (!result.ok) {
    return { ok: false, reason: result.reason.includes('fence') || result.reason.includes('quiesce') ? 'The fleet is still draining — try again in a few seconds.' : `could not clear Stop: ${result.reason}` };
  }
  return { ok: true, reason: 'Stop cleared.' };
}

export interface RevokeResult {
  ok: boolean;
  grantId: string | null;
  /** Grants numbered below this can never act again. */
  minGrantSeq: number;
  archivedAs: string | null;
  ledgered: boolean;
  reason: string;
  /** Revoke also engages Stop (KILL), so running agents halt now (SPEC-310B §8). */
  stopped: boolean;
  liveExecutionLeases: number;
  drainWaitedMs: number;
  /** See StopResult.mergesRevoked. */
  mergesRevoked: number | null;
  mergeRevokeFailures: string[];
}

interface RevokeCore {
  grantId: string | null;
  minGrantSeq: number;
  archivedAs: string | null;
  ledgered: boolean;
  problems: string[];
}

/**
 * The durable half of Revoke: switch off, raise minGrantSeq past every grant
 * accepted so far (so resuming needs a NEW grant — one Touch ID) and move the
 * installed grant aside so it no longer loads even if the ledger were lost.
 * Lowering: every step is attempted even if an earlier one fails.
 */
function revokeCore(actor: FleetActor, reason: string): RevokeCore {
  let switchedOff = true;
  try {
    const current = readClamp().clamp.switch;
    if (current !== 'off') writeClamp({ v: 1, switch: 'off', updatedAt: new Date().toISOString(), updatedBy: actor, reason: `revoked: ${reason}` });
  } catch {
    switchedOff = false;
  }
  const installed = readInstalledGrant();
  const grantId = installed.state === 'ok' ? installed.envelope.payload.grantId : null;
  const grantSeq = installed.state === 'ok' ? installed.envelope.payload.grantSeq : 0;
  const snapshot = ledgerSnapshot('cached');
  const minGrantSeq = Math.max(grantSeq, snapshot.index.maxAcceptedGrantSeq, snapshot.index.minGrantSeq - 1) + 1;
  let archivedAs: string | null = null;
  let archiveError: string | null = null;
  try {
    archivedAs = archiveInstalledGrant('revoked');
  } catch (error) {
    archiveError = (error as Error).message;
  }
  const ledgered = appendLedger({ kind: 'grant:revoked', actor, grantId, repo: null, data: { grantId, minGrantSeq, reason } }).ok;
  const problems = [
    switchedOff ? null : 'the switch could not be written',
    archiveError ? `the grant file could not be moved (${archiveError})` : null,
    ledgered ? null : 'the ledger could not record it',
  ].filter((p): p is string => p !== null);
  return { grantId, minGrantSeq, archivedAs, ledgered, problems };
}

function revokeResult(core: RevokeCore, stop: StopResult): RevokeResult {
  const problems = [...core.problems, ...(stop.armed ? [] : ['Stop could not be engaged'])];
  return {
    ok: problems.length === 0,
    grantId: core.grantId,
    minGrantSeq: core.minGrantSeq,
    archivedAs: core.archivedAs,
    ledgered: core.ledgered,
    reason: problems.length === 0
      ? 'Revoked and stopped. Resuming needs a new grant (Touch ID), then clearing Stop.'
      : `Revoked with problems: ${problems.join('; ')}.`,
    stopped: stop.armed,
    liveExecutionLeases: stop.liveExecutionLeases,
    drainWaitedMs: stop.drainWaitedMs,
    mergesRevoked: stop.mergesRevoked,
    mergeRevokeFailures: stop.mergeRevokeFailures,
  };
}

/**
 * Revoke, instant variant (the Verse route). Also engages Stop: a revoked
 * grant can mint nothing new, but an agent admitted before the revoke would
 * otherwise run to completion — SPEC-310B §8 requires Revoke to halt a
 * running agent within one tick, and U6's lease abort is keyed on KILL.
 * The switch goes off FIRST, so the moment KILL is armed nothing can be
 * re-admitted either way.
 */
export function revokeStanding(opts: { actor: FleetActor; reason: string }): RevokeResult {
  const reason = cleanReason(opts.reason);
  const core = revokeCore(opts.actor, reason);
  const stop = stopAutonomy({ actor: opts.actor, reason: `revoked: ${reason}`, waitMs: 0 });
  return revokeResult(core, stop);
}

/**
 * Revoke, draining variant (the CLI): as revokeStanding, then waits for running
 * agents like stopAutonomyAndDrain. `drainMs` / `waitMs` pass straight through
 * to stopAutonomyAndDrain (same defaults: 30 s drain, 2 s fence wait).
 *
 * WHY waitMs IS OPTIONAL HERE TOO: the Verse Revoke route wants the merge
 * revocation awaited (so its answer can report mergesRevoked) but must answer
 * as instantly as Stop does — drainMs:0 + waitMs:0. Without this option its
 * Stop half always waited up to the 2 s fence default. The grant is archived
 * and KILL armed before any wait either way, so a 0 only skips the waiting.
 */
export async function revokeStandingAndDrain(opts: { actor: FleetActor; reason: string; drainMs?: number; waitMs?: number }): Promise<RevokeResult> {
  const reason = cleanReason(opts.reason);
  const core = revokeCore(opts.actor, reason);
  const stop = await stopAutonomyAndDrain({
    actor: opts.actor,
    reason: `revoked: ${reason}`,
    ...(opts.drainMs !== undefined ? { drainMs: opts.drainMs } : {}),
    ...(opts.waitMs !== undefined ? { waitMs: opts.waitMs } : {}),
  });
  return revokeResult(core, stop);
}
