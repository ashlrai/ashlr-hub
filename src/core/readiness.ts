/**
 * readiness.ts — SHARED, READ-ONLY first-activation readiness model (H7).
 *
 * Single source of truth consumed by BOTH `ashlr preflight` (src/cli/preflight.ts)
 * AND the five new read-only `ashlr doctor` probes (src/core/doctor.ts), so there
 * is no drift and no double maintenance. See docs/contracts/CONTRACT-H7.md
 * (BUILD ITEM 1 + BUILD ITEM 2).
 *
 * H7 ABSOLUTE RULES (proven by test/h7.*):
 *  - READ-ONLY: composes only read-only primitives — probeEndpoint (local GET,
 *    never throws), listEnrolled, killSwitchOn, loadDaemonState (H5 self-heal),
 *    listSandboxes. It MUTATES NOTHING and adds NO outward capability.
 *  - The ONE write is the `~/.ashlr` writeable probe — it writes then UNLINKS a
 *    private sentinel under the (HOME-relative, isolated-in-tests) ~/.ashlr dir;
 *    it touches no repo, no enrollment, no kill, no daemon state, and leaves no
 *    persistent artifact.
 *  - NEVER throws — every facet degrades to a typed result on error.
 *  - No new runtime deps; node builtins + existing core modules only.
 *
 * NOTE: paths are resolved at CALL TIME via homedir() (matching policy.ts /
 * daemon/state.ts) so a test that relocates process.env.HOME gets an ISOLATED
 * ~/.ashlr — never the real one. (config.ts CONFIG_DIR is captured at import
 * time, so we do NOT use it here for the writeable sentinel.)
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, unlinkSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { AshlrConfig } from './types.js';
import { probeEndpoint } from './providers.js';
import { listEnrolled, killSwitchOn } from './sandbox/policy.js';
import { loadDaemonState, daemonStatePath } from './daemon/state.js';
import { listSandboxes, ORPHAN_STALE_MS } from './sandbox/worktree.js';
import { getPhantomStatus } from './phantom.js';
import { discoverMcpServers } from './mcp-registry.js';
import type { PhantomStatus } from './types.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Severity of a single readiness finding. */
export type ReadinessSeverity = 'blocker' | 'warning' | 'info';

/** One readiness finding (model/enrollment/kill/daemon/writeable/sandbox/git/phantom). */
export interface ReadinessFinding {
  /** Stable facet id, e.g. 'model' | 'enrollment' | 'kill-switch' | 'daemon' |
   *  'ashlr-writeable' | 'sandbox' | 'git' | 'phantom'. */
  id: string;
  /** Severity. 'blocker' forces ready=false; 'warning'/'info' do not. */
  severity: ReadinessSeverity;
  /** Human-readable detail line (metadata only — never a secret). */
  detail: string;
  /** Optional remediation hint. */
  fix?: string;
}

export interface ReadinessPhantomSnapshot {
  installed: boolean;
  version: string | null;
  initialized: boolean;
  secretCount: number;
  valueMode: PhantomStatus['capability']['valueMode'];
  knownFleetSecrets: {
    total: number;
    presentCount: number;
    missingCount: number;
    pulsePatPresent: boolean;
    pulseTokenPresent: boolean;
    pulseCredentialPresent: boolean;
  };
  capabilities: PhantomStatus['capability']['modes'];
  commands: PhantomStatus['capability']['commands'];
  mcp: {
    configured: boolean;
    source: string | null;
  };
  error?: string;
}

/** Full readiness report. `ready` is true iff there are zero 'blocker' findings. */
export interface ReadinessReport {
  /** True iff no finding has severity 'blocker'. */
  ready: boolean;
  /** Findings that BLOCK a safe first activation (ready=false). */
  blockers: ReadinessFinding[];
  /** Non-blocking warnings (surfaced, do not block). */
  warnings: ReadinessFinding[];
  /** Informational notes (e.g. empty-enrollment on a fresh install — fine). */
  info: ReadinessFinding[];
  /** Values-free Phantom capability snapshot, if the facet could be evaluated. */
  phantom?: ReadinessPhantomSnapshot;
  /** ISO timestamp the report was built. */
  generatedAt: string;
}

// ---------------------------------------------------------------------------
// Internal: call-time ~/.ashlr resolution (HOME-relative, isolated in tests)
// ---------------------------------------------------------------------------

/** Call-time ~/.ashlr dir (matches policy.ts / daemon/state.ts — NOT config.ts). */
function ashlrDir(): string {
  return join(homedir(), '.ashlr');
}

/** Orphan-sandbox count threshold at/above which sandbox health warns. */
export const SANDBOX_ORPHAN_WARN_THRESHOLD = 3;

// ---------------------------------------------------------------------------
// Per-facet read-only helpers (each NEVER throws)
// ---------------------------------------------------------------------------

/**
 * READ-ONLY writeable probe for ~/.ashlr. Writes then immediately UNLINKS a
 * private sentinel under the (call-time, HOME-relative) ~/.ashlr dir. Returns
 * true when writeable, false otherwise. Leaves NO persistent artifact. Never
 * throws.
 */
export function checkAshlrWriteable(): boolean {
  const dir = ashlrDir();
  // A unique sentinel name so concurrent probes never collide and a leftover
  // (should an unlink ever be skipped) is unmistakably transient.
  const sentinel = join(dir, `.ashlr-preflight-${process.pid}-${Date.now()}.tmp`);
  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(sentinel, '', 'utf8');
    return true;
  } catch {
    return false;
  } finally {
    // ALWAYS attempt to remove the sentinel — leave no persistent artifact.
    try {
      if (existsSync(sentinel)) unlinkSync(sentinel);
    } catch {
      /* idempotent — never throw from the cleanup */
    }
  }
}

/** READ-ONLY enrollment snapshot: { count } via listEnrolled(). Never throws. */
export function readEnrollmentState(): { count: number } {
  try {
    return { count: listEnrolled().length };
  } catch {
    return { count: 0 };
  }
}

/** READ-ONLY kill-switch snapshot: { on } via killSwitchOn(). Never throws. */
export function readKillState(): { on: boolean } {
  try {
    return { on: killSwitchOn() };
  } catch {
    return { on: false };
  }
}

/**
 * READ-ONLY daemon-health snapshot via loadDaemonState() (which applies the H5
 * reconcileDaemonState self-heal at the load chokepoint). Returns whether the
 * daemon is reported running, its recorded pid, and whether the recorded pid is
 * still alive (a still-running flag with a live pid is a healthy live daemon; a
 * dead-pid running flag is already self-healed to running:false by the load).
 * Never throws.
 */
export function readDaemonHealth(): {
  running: boolean;
  pid: number | null;
  selfHealed: boolean;
  pidAlive: boolean;
} {
  try {
    // Peek at the RAW persisted flag BEFORE loadDaemonState() applies the H5
    // reconcileDaemonState self-heal, so we can report whether a stale dead-pid
    // `running:true` flag was healed at the load chokepoint. This peek is a pure
    // read — it never writes.
    let rawRunning = false;
    let rawPid: number | null = null;
    try {
      const p = daemonStatePath();
      if (existsSync(p)) {
        const parsed = JSON.parse(readFileSync(p, 'utf8')) as unknown;
        if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
          const obj = parsed as Record<string, unknown>;
          rawRunning = obj['running'] === true;
          rawPid = typeof obj['pid'] === 'number' ? obj['pid'] : null;
        }
      }
    } catch {
      rawRunning = false;
      rawPid = null;
    }

    // loadDaemonState() applies the self-heal: a dead-pid running flag becomes
    // running:false. The post-load `running` is therefore the truthful state.
    const state = loadDaemonState();

    // selfHealed iff the RAW file claimed running with a pid that is NOT alive
    // and the post-load state is now stopped (the reconcile flipped it).
    let selfHealed = false;
    if (rawRunning && !state.running) {
      let rawPidAlive = false;
      if (typeof rawPid === 'number' && rawPid > 0) {
        try {
          process.kill(rawPid, 0);
          rawPidAlive = true;
        } catch {
          rawPidAlive = false;
        }
      }
      selfHealed = !rawPidAlive;
    }

    // pidAlive: whether the POST-load (self-healed) running flag is backed by a
    // live pid — a healthy live daemon. (A dead-pid flag is already healed to
    // running:false above, so this is only true for a genuinely live daemon.)
    let pidAlive = false;
    if (state.running && typeof state.pid === 'number' && state.pid > 0) {
      try {
        process.kill(state.pid, 0);
        pidAlive = true;
      } catch {
        pidAlive = false;
      }
    }

    return { running: state.running, pid: state.pid, selfHealed, pidAlive };
  } catch {
    return { running: false, pid: null, selfHealed: false, pidAlive: false };
  }
}

/**
 * READ-ONLY sandbox-health snapshot via listSandboxes(): total on-disk sandboxes
 * + an orphan estimate. A sandbox is counted as an orphan when its owner pid is
 * no longer alive AND it is older than ORPHAN_STALE_MS (mirrors the sweep's two
 * guards — a LIVE owner pid is NEVER counted as an orphan regardless of age).
 * Read-only; removes NOTHING. Never throws.
 */
export function readSandboxHealth(): { total: number; orphans: number } {
  try {
    const sandboxes = listSandboxes();
    const now = Date.now();
    let orphans = 0;
    for (const sb of sandboxes) {
      // Guard 1 — POSITIVE liveness: a live owner pid is never an orphan.
      const pid = sb.ownerPid;
      if (typeof pid === 'number' && Number.isInteger(pid) && pid > 0) {
        let alive = false;
        try {
          process.kill(pid, 0);
          alive = true;
        } catch {
          alive = false;
        }
        if (alive) continue;
      }
      // Guard 2 — AGE fallback: no usable live owner; count only when stale.
      const created = Date.parse(sb.createdAt);
      if (Number.isFinite(created) && now - created >= ORPHAN_STALE_MS) {
        orphans++;
      }
    }
    return { total: sandboxes.length, orphans };
  } catch {
    return { total: 0, orphans: 0 };
  }
}

/** READ-ONLY presence check for git (`git --version`). Never throws. */
function gitPresent(): boolean {
  try {
    const r = spawnSync('git', ['--version'], { encoding: 'utf8', timeout: 5000 });
    return !r.error && r.status === 0;
  } catch {
    return false;
  }
}

function phantomMcpRegistration(): ReadinessPhantomSnapshot['mcp'] {
  try {
    const registry = discoverMcpServers();
    const server = registry.servers.find((candidate) =>
      candidate.name === 'phantom-secrets' ||
      (candidate.command === 'phantom' && candidate.args[0] === 'mcp')
    );
    return {
      configured: server !== undefined,
      source: normalizeMcpSourceForDisplay(server?.source),
    };
  } catch {
    return { configured: false, source: null };
  }
}

function normalizeMcpSourceForDisplay(source: string | undefined): string | null {
  if (!source) return null;
  const home = homedir();
  return source === home || source.startsWith(`${home}/`)
    ? `~${source.slice(home.length)}`
    : source;
}

function readinessPhantomSnapshot(status: PhantomStatus): ReadinessPhantomSnapshot {
  const known = status.capability.knownFleetSecrets;
  return {
    installed: status.installed,
    version: status.version,
    initialized: status.initialized,
    secretCount: status.capability.secretCount,
    valueMode: status.capability.valueMode,
    knownFleetSecrets: {
      total: known.names.length,
      presentCount: known.present.length,
      missingCount: known.missing.length,
      pulsePatPresent: known.pulsePatPresent,
      pulseTokenPresent: known.pulseTokenPresent,
      pulseCredentialPresent: known.pulseCredentialPresent,
    },
    capabilities: status.capability.modes,
    commands: status.capability.commands,
    mcp: phantomMcpRegistration(),
    ...(status.error ? { error: status.error } : {}),
  };
}

// ---------------------------------------------------------------------------
// buildReadiness — composes the facets into a ReadinessReport
// ---------------------------------------------------------------------------

/**
 * Build the full first-activation readiness report (READ-ONLY).
 *
 * Composes (all read-only, all degrade gracefully):
 *  - local model reachable via probeEndpoint (down => WARNING, never a blocker)
 *  - enrollment count via readEnrollmentState (0 => INFO, never a blocker)
 *  - kill-switch via readKillState (on => WARNING)
 *  - daemon not stuck via readDaemonHealth (self-heal already applied)
 *  - ~/.ashlr writeable via checkAshlrWriteable (not writeable => BLOCKER)
 *  - sandbox health via readSandboxHealth (high orphan count => WARNING)
 *  - git present (absent => BLOCKER); phantom present (absent => WARNING)
 *
 * `ready` is true iff blockers.length === 0. Never throws.
 *
 * MUST NOT mutate any enrollment/kill/daemon/sandbox/repo state; the ONLY write
 * is the self-cleaning sentinel inside checkAshlrWriteable.
 */
export async function buildReadiness(cfg: AshlrConfig): Promise<ReadinessReport> {
  const blockers: ReadinessFinding[] = [];
  const warnings: ReadinessFinding[] = [];
  const info: ReadinessFinding[] = [];

  // -- local model reachable (down => warning, never a blocker, never throws) --
  {
    const models = cfg?.models;
    const lmUrl = typeof models?.lmstudio === 'string' ? models.lmstudio : '';
    const olUrl = typeof models?.ollama === 'string' ? models.ollama : '';
    const probes: Array<Promise<{ id: string; up: boolean; error?: string; url: string }>> = [];
    if (lmUrl) probes.push(probeEndpoint('lmstudio', lmUrl));
    if (olUrl) probes.push(probeEndpoint('ollama', olUrl));

    if (probes.length === 0) {
      warnings.push({
        id: 'model',
        severity: 'warning',
        detail: 'no local model endpoint configured (cfg.models.lmstudio / cfg.models.ollama)',
        fix: 'Configure a local model in ~/.ashlr/config.json or run `ashlr models`.',
      });
    } else {
      let anyUp = false;
      const downDetails: string[] = [];
      // probeEndpoint never throws, but stay defensive — a single rejection must
      // not abort the whole readiness report.
      const results = await Promise.allSettled(probes);
      for (const r of results) {
        if (r.status === 'fulfilled') {
          if (r.value.up) anyUp = true;
          else downDetails.push(`${r.value.id} down (${r.value.error ?? 'no response'})`);
        } else {
          downDetails.push('probe failed');
        }
      }
      if (anyUp) {
        info.push({
          id: 'model',
          severity: 'info',
          detail: 'local model reachable',
        });
      } else {
        warnings.push({
          id: 'model',
          severity: 'warning',
          detail: `local model unreachable — ${downDetails.join('; ')}`,
          fix: 'Start LM Studio / Ollama, or proceed (autonomy needs a local model to run).',
        });
      }
    }
  }

  // -- enrollment state (empty is FINE — info, never a blocker) ---------------
  {
    const { count } = readEnrollmentState();
    if (count === 0) {
      info.push({
        id: 'enrollment',
        severity: 'info',
        detail: 'no repos enrolled yet (a fresh install is legitimately empty)',
        fix: 'Run `ashlr onboard` to safely enroll your first repo.',
      });
    } else {
      info.push({
        id: 'enrollment',
        severity: 'info',
        detail: `${count} repo(s) enrolled`,
      });
    }
  }

  // -- kill-switch (on => warning: nothing will run) --------------------------
  {
    const { on } = readKillState();
    if (on) {
      warnings.push({
        id: 'kill-switch',
        severity: 'warning',
        detail: 'kill switch is ON — all autonomy is paused (nothing will run)',
        fix: 'Clear it with `ashlr kill off` when you are ready to resume.',
      });
    } else {
      info.push({
        id: 'kill-switch',
        severity: 'info',
        detail: 'kill switch is OFF',
      });
    }
  }

  // -- daemon not stuck (H5 self-heal already applied at load) -----------------
  {
    const { running, pid, selfHealed } = readDaemonHealth();
    if (selfHealed) {
      info.push({
        id: 'daemon',
        severity: 'info',
        detail: 'daemon stopped (a stale dead-pid running flag was self-healed)',
      });
    } else if (running) {
      info.push({
        id: 'daemon',
        severity: 'info',
        detail: `daemon running (pid ${pid ?? '?'})`,
      });
    } else {
      info.push({
        id: 'daemon',
        severity: 'info',
        detail: 'daemon not running',
      });
    }
  }

  // -- ~/.ashlr writeable (not writeable => BLOCKER — nothing can persist) -----
  {
    if (checkAshlrWriteable()) {
      info.push({
        id: 'ashlr-writeable',
        severity: 'info',
        detail: '~/.ashlr is writeable',
      });
    } else {
      blockers.push({
        id: 'ashlr-writeable',
        severity: 'blocker',
        detail: '~/.ashlr is NOT writeable — no state can be persisted',
        fix: 'Fix permissions on ~/.ashlr (e.g. `chmod u+rwx ~/.ashlr`).',
      });
    }
  }

  // -- sandbox health (high orphan count => warning; never a blocker) ---------
  {
    const { total, orphans } = readSandboxHealth();
    if (orphans >= SANDBOX_ORPHAN_WARN_THRESHOLD) {
      warnings.push({
        id: 'sandbox',
        severity: 'warning',
        detail: `${orphans} orphaned sandbox(es) of ${total} on disk`,
        fix: 'Reclaim them with `ashlr sandbox gc`.',
      });
    } else {
      info.push({
        id: 'sandbox',
        severity: 'info',
        detail: total === 0 ? 'no sandboxes on disk' : `${total} sandbox(es) on disk, ${orphans} orphan(s)`,
      });
    }
  }

  // -- git present (absent => BLOCKER) ----------------------------------------
  {
    if (gitPresent()) {
      info.push({ id: 'git', severity: 'info', detail: 'git is installed' });
    } else {
      blockers.push({
        id: 'git',
        severity: 'blocker',
        detail: 'git not found on PATH — the autonomous chain cannot run',
        fix: 'Install git: https://git-scm.com',
      });
    }
  }

  // -- phantom present (optional; absent => warning) --------------------------
  let phantom: ReadinessPhantomSnapshot | undefined;
  {
    let status: PhantomStatus | undefined;
    try {
      status = getPhantomStatus();
      phantom = readinessPhantomSnapshot(status);
    } catch {
      status = undefined;
      phantom = undefined;
    }
    if (status?.installed && status.initialized) {
      const pulse = status.capability.knownFleetSecrets.pulseCredentialPresent
        ? 'pulse credential present'
        : 'pulse credential missing';
      const mcp = phantom?.mcp.configured ? 'mcp configured' : 'mcp not configured';
      const agent = status.capability.commands.agentAvailable ? 'agent command present' : 'agent command absent';
      info.push({
        id: 'phantom',
        severity: 'info',
        detail:
          `phantom ${status.version ?? 'unknown'} initialized; ` +
          `${status.capability.secretCount} secret name(s); ${pulse}; ${mcp}; ${agent}; values hidden`,
      });
    } else if (status?.installed) {
      const agent = status.capability.commands.agentAvailable ? 'agent command present' : 'agent command absent';
      warnings.push({
        id: 'phantom',
        severity: 'warning',
        detail: `phantom ${status.version ?? 'unknown'} installed but not initialized; ${agent}`,
        fix: 'Run `phantom init` to enable fleet secret resolution.',
      });
    } else {
      warnings.push({
        id: 'phantom',
        severity: 'warning',
        detail: 'phantom not installed (optional — secret scrubbing still applies)',
      });
    }
  }

  return {
    ready: blockers.length === 0,
    blockers,
    warnings,
    info,
    ...(phantom ? { phantom } : {}),
    generatedAt: new Date().toISOString(),
  };
}
