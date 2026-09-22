/**
 * core/verse/mcp-seat-view.ts — which MCP servers each Verse seat would load.
 *
 * READ-ONLY. Nothing in this file writes, installs, enables or disables
 * anything. docs/VERSE-WORKSPACES.md §3 asks for exactly one thing first:
 * "Surface which servers each seat would load, since a server configured for
 * one account should not silently apply to another."
 *
 * ── The finding this module exists to make visible ──────────────────────────
 *
 * `discoverMcpServers()` scans HOME-level JSON configs (see
 * `knownConfigPaths()`): ~/.claude.json, ~/.claude/settings.json, ~/.mcp.json,
 * ~/.ashlrcode/settings.json, ~/.ashlr-workbench/settings.json,
 * ~/.aw/settings.json, ~/.ashlr/settings.json.
 *
 * NO VERSE SEAT READS ANY OF THEM. Verified against the adapters and the
 * launcher, not recalled:
 *
 *   - CLAUDE and LOCAL seats: `buildClaudeLaunch` (src/core/verse/adapters/
 *     claude.ts) puts `--strict-mcp-config --mcp-config '{"mcpServers":{}}'`
 *     in every turn's argv, for both engines. That is a complete override:
 *     the seat loads ZERO MCP servers, whatever any config file says.
 *   - CODEX and GROK seats: their adapters add no MCP flag, so each loads its
 *     OWN native config — and the account is pinned by a private per-account
 *     state directory (`CODEX_HOME` / `GROK_HOME` / `CLAUDE_CONFIG_DIR` =
 *     `<profile>/native-state`, src/core/resources/native-profile.ts:72-78,
 *     :108). That directory is per ACCOUNT, so two Codex accounts already
 *     cannot share a server by accident. Their config is `config.toml` —
 *     TOML, which `discoverMcpServers()` (JSON only) cannot read.
 *
 * Reporting a machine-wide server list as "what this seat runs" would
 * therefore be a lie in every direction at once: it would show servers no
 * seat loads, and hide the per-account TOML that Codex and Grok actually do.
 * So this module reports the two things separately and names the reason for
 * each, and reports EMPTY rather than guessing.
 *
 * ── What may leave this module ──────────────────────────────────────────────
 *
 * Never: a launcher argv, an absolute native-profile path, a home-anchored
 * absolute path, or a real env value. Config files are identified by their
 * path RELATIVE TO $HOME (`.claude.json`, `.ashlr/settings.json`), which
 * names the file precisely and carries no username. Every spec crosses the
 * boundary through `redactEnv()`, whose whole reason for existing is that
 * these specs carry secrets.
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative, isAbsolute, sep } from 'node:path';

import { discoverMcpServers, redactEnv } from '../mcp-registry.js';
import type { McpServerSpec } from '../types.js';
import type { VerseEngine } from './types.js';
import { readVerseAccountIdentities, type VerseAccountIdentity, type VerseAccountProvider } from './accounts.js';
import { readVerseMcpScope, type VerseMcpScope } from './mcp-scope.js';

// ---------------------------------------------------------------------------
// Verified facts about the adapters, encoded once
// ---------------------------------------------------------------------------

/**
 * Engines whose adapter argv pins an EMPTY `--mcp-config` under
 * `--strict-mcp-config`, so the seat can load nothing at all.
 *
 * Both entries come from one function: `buildClaudeLaunch` serves engine
 * 'claude' and engine 'local' alike (the latter is the same `claude` binary
 * with ANTHROPIC_BASE_URL pointed at Ollama).
 *
 * If that argv ever loses those two flags this constant becomes a lie, which
 * is why `test/verse-mcp-seat-view.test.ts` asserts the flags are still in the
 * adapter's real output rather than trusting this list.
 */
export const VERSE_MCP_ISOLATED_ENGINES: readonly VerseEngine[] = ['claude', 'local'];

/** The two argv flags that make an isolated seat isolated. Asserted in tests. */
export const VERSE_MCP_ISOLATION_FLAGS: readonly string[] = ['--strict-mcp-config', '--mcp-config'];

/**
 * Per-account native config file, relative to that account's private state
 * directory. Claude's is listed for completeness even though a Claude seat is
 * isolated by its adapter before the file is ever consulted.
 */
const NATIVE_CONFIG_FILE: Record<VerseAccountProvider, { file: string; format: 'json' | 'toml' }> = {
  codex: { file: 'config.toml', format: 'toml' },
  grok: { file: 'config.toml', format: 'toml' },
  claude: { file: '.claude.json', format: 'json' },
};

// ---------------------------------------------------------------------------
// Transport shapes
// ---------------------------------------------------------------------------

/** Why a seat loads what it loads. Machine-readable, verbatim, never prose. */
export type VerseMcpSeatReason =
  /** The adapter pins an empty --mcp-config: this seat loads nothing. */
  | 'mcp-seat-isolated-by-adapter'
  /** The account's private config file does not exist. */
  | 'mcp-account-config-absent'
  /** The config exists but is TOML, which this JSON-only discovery does not parse. */
  | 'mcp-account-config-not-json'
  /** The config exists, is JSON, and was read. */
  | 'mcp-account-config-read'
  /** The config exists but could not be read or parsed. */
  | 'mcp-account-config-unreadable'
  /** The account's private state directory could not be resolved. */
  | 'mcp-account-profile-unresolved';

/**
 * One MCP server, safe to serialize.
 *
 * `command` and `args` are shown IN FULL and verbatim: docs/VERSE-WORKSPACES.md
 * §3 requires the operator to read what they are about to run. `env` keys are
 * shown; every env VALUE is the literal `'<set>'` from `redactEnv`.
 */
export interface VerseMcpServerView {
  name: string;
  command: string;
  args: string[];
  /** Keys only — every value is `'<set>'`. Null when the spec sets no env. */
  env: Record<string, string> | null;
  /** Config file path RELATIVE TO $HOME. Never absolute, never a username. */
  sourceRef: string;
}

/** What one seat would load, and why. */
export interface VerseMcpSeatView {
  seatId: string;
  label: string;
  engine: VerseEngine;
  accountId: string;
  /** Servers this seat would actually load. Empty is a real answer. */
  servers: VerseMcpServerView[];
  reason: VerseMcpSeatReason;
  /**
   * The account config file this seat reads, named relative to the account's
   * own private state directory (e.g. `config.toml`). The directory itself is
   * private and is never published.
   */
  configFile: string | null;
  configFormat: 'json' | 'toml' | null;
  /** Plain facts the UI must show rather than implying a fault. */
  notes: string[];
}

/** Servers configured on this machine that no Verse seat reads. */
export interface VerseMcpMachineRegistry {
  servers: VerseMcpServerView[];
  /**
   * TRUE when at least one server is configured machine-wide. Combined with
   * every seat reporting none, that is the fact worth surfacing loudly.
   */
  configured: boolean;
  note: string;
}

export interface VerseMcpSnapshot {
  sampledAt: string;
  seats: VerseMcpSeatView[];
  machine: VerseMcpMachineRegistry;
  scope: VerseMcpScope;
  notes: string[];
}

// ---------------------------------------------------------------------------
// Notes (plain language, no machine codes)
// ---------------------------------------------------------------------------

export const VERSE_MCP_ISOLATED_NOTE =
  'Every turn on this seat is launched with --strict-mcp-config and an empty --mcp-config, ' +
  'so it loads no MCP servers at all regardless of what any config file holds.';

export const VERSE_MCP_TOML_NOTE =
  'This account keeps its MCP servers in a TOML config, which is read by the provider CLI ' +
  'itself and is not parsed here. Hub cannot list or change it without rewriting the ' +
  "operator's TOML, which it deliberately does not do.";

export const VERSE_MCP_PER_ACCOUNT_NOTE =
  'This account runs against its own private state directory, so a server configured for ' +
  'another account does not reach it.';

export const VERSE_MCP_MACHINE_UNUSED_NOTE =
  'These servers are configured in this machine\'s home-level configs. No Verse seat reads ' +
  'them: Claude and local seats are launched with an empty --mcp-config, and Codex and Grok ' +
  'seats read their own per-account config instead.';

export const VERSE_MCP_MACHINE_EMPTY_NOTE =
  'No MCP servers are configured in this machine\'s home-level configs.';

// ---------------------------------------------------------------------------
// Path handling — nothing absolute crosses the boundary
// ---------------------------------------------------------------------------

/**
 * Name a config file by its path relative to $HOME (`.claude.json`,
 * `.ashlr/settings.json`). Precise enough to act on, and free of the username
 * that an absolute path would carry.
 *
 * A path outside $HOME is reported as `(outside home)` — its basename alone
 * would be ambiguous and its full path is not ours to publish.
 */
export function homeRelativeSourceRef(path: string, home: string = homedir()): string {
  if (!isAbsolute(path)) return path;
  const rel = relative(home, path);
  if (rel.length === 0 || rel.startsWith('..') || isAbsolute(rel)) return '(outside home)';
  return rel.split(sep).join('/');
}

/** Project one discovered spec for transport, env values redacted. */
export function projectMcpServerView(spec: McpServerSpec, home: string = homedir()): VerseMcpServerView {
  const safe = redactEnv(spec);
  return {
    name: safe.name,
    command: safe.command,
    args: [...safe.args],
    env: safe.env && Object.keys(safe.env).length > 0 ? { ...safe.env } : null,
    sourceRef: homeRelativeSourceRef(safe.source, home),
  };
}

// ---------------------------------------------------------------------------
// Per-account private state directory
// ---------------------------------------------------------------------------

/**
 * Resolve an account's private native state directory WITHOUT publishing it.
 *
 * connections.json carries each account's launcher argv. That argv is the
 * account's identity and never leaves the server (src/core/verse/seats.ts:9).
 * We read it here only to locate `<profile>/profile.json`, whose
 * `nativeStatePath` is the directory the provider CLI is pinned to
 * (`CODEX_HOME` / `GROK_HOME` / `CLAUDE_CONFIG_DIR`).
 *
 * Returns null rather than guessing when anything is missing.
 */
export function resolveAccountStateRoots(accountsRoot: string): Map<string, string> {
  const out = new Map<string, string>();
  let parsed: unknown;
  try {
    const raw = readFileSync(join(accountsRoot, 'connections.json'), 'utf8');
    if (raw.length > 1024 * 1024) return out;
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return out;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return out;
  const accounts = (parsed as Record<string, unknown>)['accounts'];
  if (!Array.isArray(accounts)) return out;

  for (const entry of accounts) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const row = entry as Record<string, unknown>;
    const id = row['id'];
    const command = row['command'];
    if (typeof id !== 'string' || id.length === 0 || !Array.isArray(command)) continue;

    const launcher = command.find(
      (part): part is string => typeof part === 'string' && part.endsWith('launcher.mjs'),
    );
    if (launcher === undefined) continue;

    // profile.json is the launcher's own manifest (ResourceNativeProfile). It
    // also carries the argv, so only `nativeStatePath` is lifted out of it.
    let stateRoot: string | null = null;
    try {
      const manifest = JSON.parse(readFileSync(join(dirname(launcher), 'profile.json'), 'utf8')) as unknown;
      if (manifest !== null && typeof manifest === 'object' && !Array.isArray(manifest)) {
        const value = (manifest as Record<string, unknown>)['nativeStatePath'];
        if (typeof value === 'string' && value.length > 0) stateRoot = value;
      }
    } catch {
      stateRoot = null;
    }
    if (stateRoot !== null) out.set(id, stateRoot);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Per-seat derivation
// ---------------------------------------------------------------------------

/** The minimum a seat must carry for this view. Keeps tests free of fixtures. */
export interface VerseMcpSeatInput {
  id: string;
  label: string;
  engine: VerseEngine;
  accountId: string;
}

/**
 * Read one account's private JSON MCP registry.
 *
 * Only ever called for a JSON-format config. TOML is refused upstream rather
 * than half-parsed.
 */
function readAccountJsonServers(
  stateRoot: string,
  file: string,
  home: string,
): { servers: VerseMcpServerView[]; ok: boolean } {
  const path = join(stateRoot, file);
  if (!existsSync(path)) return { servers: [], ok: true };
  // discoverMcpServers takes injected paths and never throws; a malformed
  // config comes back as an empty registry, which we cannot distinguish from
  // a config with no servers. That ambiguity is acceptable here because both
  // render identically ("this seat loads nothing from its own config").
  try {
    const registry = discoverMcpServers([path]);
    return { servers: registry.servers.map((spec) => projectMcpServerView(spec, home)), ok: true };
  } catch {
    return { servers: [], ok: false };
  }
}

/**
 * Derive what one seat would load.
 *
 * `stateRoots` maps accountId -> private state directory (from
 * {@link resolveAccountStateRoots}). A seat whose account is absent from it
 * reports `mcp-account-profile-unresolved` rather than falling back to a
 * machine-wide list.
 */
export function deriveVerseMcpSeatView(
  seat: VerseMcpSeatInput,
  stateRoots: ReadonlyMap<string, string>,
  home: string = homedir(),
): VerseMcpSeatView {
  const base = { seatId: seat.id, label: seat.label, engine: seat.engine, accountId: seat.accountId };

  // 1. Adapter isolation wins over every config on disk. Checking it FIRST is
  //    the point: a Claude seat with a fully populated ~/.claude.json still
  //    loads nothing, and saying otherwise is the exact lie this file avoids.
  if (VERSE_MCP_ISOLATED_ENGINES.includes(seat.engine)) {
    return {
      ...base,
      servers: [],
      reason: 'mcp-seat-isolated-by-adapter',
      configFile: null,
      configFormat: null,
      notes: [VERSE_MCP_ISOLATED_NOTE],
    };
  }

  // 2. Native seats read their own per-account config.
  const provider = seat.engine as VerseAccountProvider;
  const config = NATIVE_CONFIG_FILE[provider];
  if (config === undefined) {
    return {
      ...base,
      servers: [],
      reason: 'mcp-account-profile-unresolved',
      configFile: null,
      configFormat: null,
      notes: [],
    };
  }

  const stateRoot = stateRoots.get(seat.accountId);
  if (stateRoot === undefined) {
    return {
      ...base,
      servers: [],
      reason: 'mcp-account-profile-unresolved',
      configFile: config.file,
      configFormat: config.format,
      notes: [VERSE_MCP_PER_ACCOUNT_NOTE],
    };
  }

  const exists = existsSync(join(stateRoot, config.file));
  if (!exists) {
    return {
      ...base,
      servers: [],
      reason: 'mcp-account-config-absent',
      configFile: config.file,
      configFormat: config.format,
      notes: [VERSE_MCP_PER_ACCOUNT_NOTE],
    };
  }

  if (config.format === 'toml') {
    return {
      ...base,
      servers: [],
      reason: 'mcp-account-config-not-json',
      configFile: config.file,
      configFormat: 'toml',
      notes: [VERSE_MCP_TOML_NOTE, VERSE_MCP_PER_ACCOUNT_NOTE],
    };
  }

  const read = readAccountJsonServers(stateRoot, config.file, home);
  return {
    ...base,
    servers: read.servers,
    reason: read.ok ? 'mcp-account-config-read' : 'mcp-account-config-unreadable',
    configFile: config.file,
    configFormat: 'json',
    notes: [VERSE_MCP_PER_ACCOUNT_NOTE],
  };
}

// ---------------------------------------------------------------------------
// Snapshot
// ---------------------------------------------------------------------------

/** The machine-wide registry, and the fact that no seat reads it. */
export function buildVerseMcpMachineRegistry(
  paths?: string[],
  home: string = homedir(),
): VerseMcpMachineRegistry {
  const registry = discoverMcpServers(paths);
  const servers = registry.servers.map((spec) => projectMcpServerView(spec, home));
  return {
    servers,
    configured: servers.length > 0,
    note: servers.length > 0 ? VERSE_MCP_MACHINE_UNUSED_NOTE : VERSE_MCP_MACHINE_EMPTY_NOTE,
  };
}

export interface VerseMcpSnapshotOptions {
  accountsRoot: string;
  /** Seats to describe. Callers pass `discoverSeats()`'s public seat list. */
  seats: readonly VerseMcpSeatInput[];
  /** Injected machine config paths (tests). Defaults to knownConfigPaths(). */
  machineConfigPaths?: string[];
  /** Injected scope read (tests). Defaults to the real Locus shell-out. */
  scope?: VerseMcpScope;
  /** Injected home (tests). */
  home?: string;
}

/**
 * The read-only answer to "which MCP servers would each seat load".
 *
 * Deliberately does no discovery of its own beyond the two registries: it
 * never enables, disables or reorders anything, and it never reports a server
 * against a seat that would not load it.
 */
export function buildVerseMcpSnapshot(options: VerseMcpSnapshotOptions): VerseMcpSnapshot {
  const home = options.home ?? homedir();
  const stateRoots = resolveAccountStateRoots(options.accountsRoot);
  const seats = options.seats.map((seat) => deriveVerseMcpSeatView(seat, stateRoots, home));
  const machine = buildVerseMcpMachineRegistry(options.machineConfigPaths, home);
  const scope = options.scope ?? readVerseMcpScope();

  const notes: string[] = [];
  if (machine.configured && seats.every((seat) => seat.servers.length === 0)) {
    notes.push(
      `${machine.servers.length} MCP server${machine.servers.length === 1 ? ' is' : 's are'} configured ` +
      'on this machine and no Verse seat loads any of them.',
    );
  }

  return { sampledAt: new Date().toISOString(), seats, machine, scope, notes };
}

/** Account identities, re-exported so a caller needs one import for the view. */
export function verseMcpAccountIdentities(accountsRoot: string): VerseAccountIdentity[] {
  return readVerseAccountIdentities(accountsRoot);
}
