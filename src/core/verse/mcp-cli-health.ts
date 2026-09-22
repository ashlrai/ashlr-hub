/**
 * core/verse/mcp-cli-health.ts — per-account CLI health, and version drift.
 *
 * docs/VERSE-WORKSPACES.md §3: "Per-account CLI health is nearly free: the
 * probes already report auth state, plan and CLI version per account. A
 * version drift is worth surfacing loudly, because the Claude usage probe is
 * pinned to an exact CLI version and fails closed when it moves."
 *
 * ── One correction to that premise, found in the source ─────────────────────
 *
 * Auth state and plan ARE already reported per account, on
 * `VerseAccountRecord` (`state` / `authentication` / `planType`). The CLI
 * VERSION is not. Nothing caches it:
 *
 *   - `probeClaudeAccountUsage` runs `--version`, COMPARES it to an inline
 *     literal, and throws the string away — it keeps only the verdict, as the
 *     verbatim reason `usage-version-unsupported`
 *     (src/core/resources/claude-account-usage.ts:99).
 *   - `checkResourceLauncherCompatibility` DOES return a recognised numeric
 *     `version` (src/core/resources/launcher-compatibility.ts:163-165), but it
 *     is only ever reached from the `ashlr resources launcher check` CLI
 *     command. No route, collector or snapshot calls it.
 *
 * So this module splits the two honestly:
 *
 *   1. {@link buildVerseCliHealth} is PURE and free. It derives drift from
 *      what the collector already has: the verbatim probe reason plus the
 *      pinned-version constant. When the probe is failing closed on the pin,
 *      that is stated as a FACT, loudly, with the pin quoted — not as a
 *      generic "unknown".
 *   2. {@link probeVerseAccountCliVersions} gets the actual installed version
 *      number, and it SPAWNS the provider CLI to do it. It is therefore not
 *      wired to a GET. A read route that silently launches four vendor
 *      binaries is a side effect wearing a read's clothes.
 *
 * ── What may leave this module ──────────────────────────────────────────────
 *
 * Never a launcher argv, never a private absolute path. The probe result
 * shape carries id / provider / version / status / reason and nothing else;
 * `ResourceLauncherCompatibilityResult` itself never echoes the command.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import {
  checkResourceLauncherCompatibility,
  type ResourceLauncherCompatibilityResult,
} from '../resources/launcher-compatibility.js';
import {
  VERSE_CLAUDE_USAGE_PINNED_VERSION,
  VERSE_CLAUDE_VERSION_REASON,
  type VerseAccountProvider,
  type VerseAccountRecord,
} from './accounts.js';

// ---------------------------------------------------------------------------
// Transport shapes
// ---------------------------------------------------------------------------

export type VerseCliVersionState =
  /** A probe ran and the installed version is the pinned one. */
  | 'matches-pin'
  /** The usage probe is failing closed because the installed CLI is not the pin. */
  | 'drift'
  /** A probe ran and reported a version, but nothing pins this provider. */
  | 'reported'
  /** No version has been read. This is the default, and it is not a fault. */
  | 'unverified';

export interface VerseAccountCliHealth {
  accountId: string;
  label: string;
  provider: VerseAccountProvider;
  /** Straight off the collector's record — already surfaced, just not here. */
  authentication: VerseAccountRecord['authentication'];
  state: VerseAccountRecord['state'];
  health: VerseAccountRecord['health'];
  planType: string | null;
  observedAt: string | null;
  /** Verbatim probe reason. Never rewritten into prose. */
  reason: string;
  /** The installed CLI version, when something actually read it. Never guessed. */
  version: string | null;
  /** The version this hub's usage probe requires. Null when nothing is pinned. */
  pinnedVersion: string | null;
  versionState: VerseCliVersionState;
  /**
   * TRUE when the usage probe is refusing to read this account's quota
   * BECAUSE of the version pin. This is the loud bit: it is a one-line
   * constant bump, not an outage, and a silent "unknown" would hide it.
   */
  usageBlockedByPin: boolean;
  notes: string[];
}

export interface VerseCliHealthSnapshot {
  sampledAt: string;
  accounts: VerseAccountCliHealth[];
  /** TRUE when any account is blocked by the pin. Drives the loud banner. */
  driftDetected: boolean;
  notes: string[];
}

// ---------------------------------------------------------------------------
// Notes
// ---------------------------------------------------------------------------

export function verseCliPinNote(pinned: string): string {
  return (
    `The Claude usage probe only runs against Claude Code ${pinned} and fails closed on any ` +
    'other build, so this account has no quota reading until the installed CLI matches the ' +
    'pin or the pin is moved. This is a version pin, not an outage.'
  );
}

export const VERSE_CLI_VERSION_UNREAD_NOTE =
  'No CLI version has been read for this account. Nothing in the collector records one; ' +
  'the version check is an explicit action because it launches the provider CLI.';

/**
 * The pinned version is stored TWICE, and the two copies are never compared:
 * the enforcing check is an inline literal in the usage probe, and
 * `VERSE_CLAUDE_USAGE_PINNED_VERSION` is a mirror kept for display. They can
 * drift silently. `test/verse-mcp-cli-health.test.ts` compares them.
 */
export const VERSE_CLI_PIN_SOURCE = 'src/core/resources/claude-account-usage.ts';

// ---------------------------------------------------------------------------
// Pure derivation — free, and the default
// ---------------------------------------------------------------------------

/** Providers whose usage probe is pinned to an exact CLI build. */
const PINNED_VERSION: Partial<Record<VerseAccountProvider, string>> = {
  claude: VERSE_CLAUDE_USAGE_PINNED_VERSION,
};

/** One measured version reading. The only shape the probe is allowed to emit. */
export interface VerseCliVersionReading {
  /** Recognised numeric version, or null when the output was not recognised. */
  version: string | null;
  status: ResourceLauncherCompatibilityResult['status'];
  reason: ResourceLauncherCompatibilityResult['reason'];
}

function deriveOne(
  record: VerseAccountRecord,
  reading: VerseCliVersionReading | undefined,
): VerseAccountCliHealth {
  const pinnedVersion = PINNED_VERSION[record.provider] ?? null;

  // The collector's verbatim reason is the free drift signal: the usage probe
  // emits exactly this code when `--version` did not match the pin.
  const usageBlockedByPin =
    pinnedVersion !== null && record.reason === VERSE_CLAUDE_VERSION_REASON;

  const version = reading?.version ?? null;

  const versionState: VerseCliVersionState =
    usageBlockedByPin ? 'drift'
      : version === null ? 'unverified'
        : pinnedVersion === null ? 'reported'
          : version === pinnedVersion ? 'matches-pin'
            : 'drift';

  const notes: string[] = [];
  if (usageBlockedByPin || (pinnedVersion !== null && version !== null && version !== pinnedVersion)) {
    notes.push(verseCliPinNote(pinnedVersion!));
  }
  if (version === null) notes.push(VERSE_CLI_VERSION_UNREAD_NOTE);

  return {
    accountId: record.id,
    label: record.label,
    provider: record.provider,
    authentication: record.authentication,
    state: record.state,
    health: record.health,
    planType: record.planType,
    observedAt: record.observedAt,
    reason: record.reason,
    version,
    pinnedVersion,
    versionState,
    usageBlockedByPin,
    notes,
  };
}

/**
 * Per-account CLI health from what the collector already knows.
 *
 * PURE. No filesystem, no subprocess. `readings` is optional and only present
 * after an operator has explicitly run the version probe.
 */
export function buildVerseCliHealth(options: {
  accounts: readonly VerseAccountRecord[];
  readings?: ReadonlyMap<string, VerseCliVersionReading>;
  now?: () => Date;
}): VerseCliHealthSnapshot {
  const readings = options.readings;
  const accounts = options.accounts.map((record) => deriveOne(record, readings?.get(record.id)));
  const drifted = accounts.filter((account) => account.versionState === 'drift');

  const notes: string[] = [];
  if (drifted.length > 0) {
    notes.push(
      `${drifted.length} account${drifted.length === 1 ? '' : 's'} ` +
      `${drifted.length === 1 ? 'is' : 'are'} running a CLI the usage probe does not accept. ` +
      `The pin lives in ${VERSE_CLI_PIN_SOURCE}.`,
    );
  }

  return {
    sampledAt: (options.now ?? (() => new Date()))().toISOString(),
    accounts,
    driftDetected: drifted.length > 0,
    notes,
  };
}

// ---------------------------------------------------------------------------
// The version probe — spawns, so it is never a GET
// ---------------------------------------------------------------------------

/**
 * Per-account launcher argv + private cwd. NEVER serialized, never logged.
 *
 * Exported only so the injection seam below can be typed by a caller (and so
 * declaration emit does not have to name a private type). Producing one of
 * these is reading an account's identity; publishing one is a leak.
 */
export interface VerseCliAccountLaunch {
  id: string;
  provider: VerseAccountProvider;
  command: string[];
  cwd: string;
}

/**
 * Read the launcher argv and private state directory for each account.
 *
 * Both are the account's identity and stay inside this process. The returned
 * value is consumed by {@link probeVerseAccountCliVersions} and never leaves.
 */
function readAccountLaunches(accountsRoot: string): VerseCliAccountLaunch[] {
  let parsed: unknown;
  try {
    const raw = readFileSync(join(accountsRoot, 'connections.json'), 'utf8');
    if (raw.length > 1024 * 1024) return [];
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return [];
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return [];
  const accounts = (parsed as Record<string, unknown>)['accounts'];
  if (!Array.isArray(accounts)) return [];

  const out: VerseCliAccountLaunch[] = [];
  for (const entry of accounts) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const row = entry as Record<string, unknown>;
    const id = row['id'];
    const provider = row['provider'];
    const command = row['command'];
    if (typeof id !== 'string' || id.length === 0) continue;
    if (provider !== 'codex' && provider !== 'claude' && provider !== 'grok') continue;
    if (!Array.isArray(command) || !command.every((part) => typeof part === 'string')) continue;

    const launcher = (command as string[]).find((part) => part.endsWith('launcher.mjs'));
    if (launcher === undefined) continue;

    let cwd: string | null = null;
    try {
      const manifest = JSON.parse(readFileSync(join(dirname(launcher), 'profile.json'), 'utf8')) as unknown;
      if (manifest !== null && typeof manifest === 'object' && !Array.isArray(manifest)) {
        const value = (manifest as Record<string, unknown>)['nativeStatePath'];
        if (typeof value === 'string' && value.length > 0) cwd = value;
      }
    } catch {
      cwd = null;
    }
    if (cwd === null) continue;

    out.push({ id, provider, command: command as string[], cwd });
    if (out.length >= 8) break;
  }
  return out;
}

/** Injection seam so tests never spawn a provider CLI. */
export type VerseCliCompatibilityCheck = typeof checkResourceLauncherCompatibility;

export interface VerseCliProbeOptions {
  accountsRoot: string;
  /** Per-account deadline. The underlying check makes up to four invocations. */
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Injected compatibility check (tests). Defaults to the real one. */
  check?: VerseCliCompatibilityCheck;
  /** Injected launch reader (tests). Defaults to reading connections.json. */
  readLaunches?: (accountsRoot: string) => VerseCliAccountLaunch[];
}

export const VERSE_CLI_PROBE_DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Run the real `--version` / `--help` compatibility check per account.
 *
 * SPAWNS the provider CLI (help/version arguments only — no login, no prompt,
 * no quota read; see launcher-compatibility.ts's own contract). Sequential on
 * purpose: four concurrent native CLIs is exactly the burst that starves other
 * probes on this machine.
 *
 * Returns ONLY the reading. The launcher argv and the private cwd that were
 * needed to produce it are dropped here and never reach a caller.
 */
export async function probeVerseAccountCliVersions(
  options: VerseCliProbeOptions,
): Promise<Map<string, VerseCliVersionReading>> {
  const check = options.check ?? checkResourceLauncherCompatibility;
  const read = options.readLaunches ?? readAccountLaunches;
  const timeoutMs = options.timeoutMs ?? VERSE_CLI_PROBE_DEFAULT_TIMEOUT_MS;

  const out = new Map<string, VerseCliVersionReading>();
  for (const launch of read(options.accountsRoot)) {
    if (options.signal?.aborted) break;
    try {
      const result = await check({
        provider: launch.provider,
        command: launch.command,
        cwd: launch.cwd,
        timeoutMs,
        ...(options.signal ? { signal: options.signal } : {}),
      });
      out.set(launch.id, {
        version: result.version,
        status: result.status,
        reason: result.reason,
      });
    } catch {
      // A refused configuration is a reading of "unavailable", not a crash.
      out.set(launch.id, { version: null, status: 'unavailable', reason: 'launcher-process-failed' });
    }
  }
  return out;
}
