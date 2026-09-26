/**
 * routes/verse/mcp/mcp-contract.ts — the wire seam for MCP management.
 *
 * Same posture as routes/verse/usage/usage-contract.ts, for the same two
 * reasons:
 *
 *  1. EVERY import from src/core here MUST be type-only. `core/verse/
 *     mcp-seat-view.ts` pulls `node:fs` and `node:os`; a VALUE import of even
 *     one constant drags that graph into the browser bundle and `vite build`
 *     fails. Type-only imports are erased, so the seam guards below cost
 *     nothing at runtime.
 *  2. Nothing is CAST. Every read goes through a structural narrower, so a
 *     field rename in src/core degrades this panel to an honest "unknown"
 *     instead of throwing at render time — and the `WIRE_*_KEYS` blocks make
 *     that rename fail `npm run typecheck:web` here, at the seam, first.
 *
 * SECURITY: the server already redacts every env value to '<set>' via
 * `redactEnv` and publishes config files as home-relative refs. This module
 * is the client-side backstop on top of that: {@link narrowServer} FORCES
 * every env value to '<set>' whatever arrived, so a server that ever
 * regressed could not print a secret through this panel.
 *
 * Pure: no React, no I/O.
 */
import type {
  VerseMcpMachineRegistry,
  VerseMcpSeatView,
  VerseMcpServerView,
  VerseMcpSnapshot,
} from '../../../../core/verse/mcp-seat-view.js';
import type { VerseMcpScope } from '../../../../core/verse/mcp-scope.js';
import type {
  VerseAccountCliHealth,
  VerseCliHealthSnapshot,
} from '../../../../core/verse/mcp-cli-health.js';

// ---------------------------------------------------------------------------
// Seam contract — compile-time only, zero runtime cost.
// ---------------------------------------------------------------------------

const WIRE_SERVER_KEYS = {
  name: 'name',
  command: 'command',
  args: 'args',
  env: 'env',
  sourceRef: 'sourceRef',
} as const satisfies Record<string, keyof VerseMcpServerView>;

const WIRE_SEAT_KEYS = {
  seatId: 'seatId',
  label: 'label',
  engine: 'engine',
  accountId: 'accountId',
  servers: 'servers',
  reason: 'reason',
  configFile: 'configFile',
  configFormat: 'configFormat',
  notes: 'notes',
} as const satisfies Record<string, keyof VerseMcpSeatView>;

const WIRE_MACHINE_KEYS = {
  servers: 'servers',
  configured: 'configured',
  note: 'note',
} as const satisfies Record<string, keyof VerseMcpMachineRegistry>;

const WIRE_SNAPSHOT_KEYS = {
  sampledAt: 'sampledAt',
  seats: 'seats',
  machine: 'machine',
  scope: 'scope',
  notes: 'notes',
} as const satisfies Record<string, keyof VerseMcpSnapshot>;

const WIRE_HEALTH_KEYS = {
  accountId: 'accountId',
  label: 'label',
  provider: 'provider',
  authentication: 'authentication',
  state: 'state',
  planType: 'planType',
  reason: 'reason',
  version: 'version',
  pinnedVersion: 'pinnedVersion',
  versionState: 'versionState',
  usageBlockedByPin: 'usageBlockedByPin',
  notes: 'notes',
} as const satisfies Record<string, keyof VerseAccountCliHealth>;

const WIRE_HEALTH_SNAPSHOT_KEYS = {
  sampledAt: 'sampledAt',
  accounts: 'accounts',
  driftDetected: 'driftDetected',
  notes: 'notes',
} as const satisfies Record<string, keyof VerseCliHealthSnapshot>;

const WIRE_SCOPE_KEYS = {
  available: 'available',
  pinned: 'pinned',
  aliasRef: 'aliasRef',
  tenantRef: 'tenantRef',
  principalRef: 'principalRef',
  reason: 'reason',
} as const satisfies Record<string, keyof VerseMcpScope>;

// ---------------------------------------------------------------------------
// Display shapes
// ---------------------------------------------------------------------------

export interface McpServer {
  name: string;
  command: string;
  args: string[];
  /** Keys only. Every value is '<set>' — forced here, not merely trusted. */
  env: Record<string, string> | null;
  sourceRef: string;
}

export interface McpSeat {
  seatId: string;
  label: string;
  engine: string;
  accountId: string;
  servers: McpServer[];
  reason: string;
  configFile: string | null;
  configFormat: string | null;
  notes: string[];
}

export interface McpScope {
  available: boolean;
  pinned: boolean;
  aliasRef: string | null;
  tenantRef: string | null;
  principalRef: string | null;
  reason: string;
}

export interface McpSnapshot {
  sampledAt: string | null;
  seats: McpSeat[];
  machine: { servers: McpServer[]; configured: boolean; note: string };
  scope: McpScope | null;
  notes: string[];
}

export interface CliHealthRow {
  accountId: string;
  label: string;
  provider: string;
  authentication: string;
  state: string;
  planType: string | null;
  reason: string;
  version: string | null;
  pinnedVersion: string | null;
  versionState: string;
  usageBlockedByPin: boolean;
  notes: string[];
}

export interface CliHealthSnapshot {
  sampledAt: string | null;
  accounts: CliHealthRow[];
  driftDetected: boolean;
  notes: string[];
}

// ---------------------------------------------------------------------------
// Narrowers
// ---------------------------------------------------------------------------

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function flag(value: unknown): boolean {
  return value === true;
}

/**
 * Narrow one server, forcing every env value to '<set>'.
 *
 * The redaction is re-applied rather than trusted. The server already did it;
 * doing it again here means no future server bug can turn this panel into a
 * secret printer, and it costs one map over at most a handful of keys.
 */
export function narrowServer(raw: unknown): McpServer | null {
  const row = record(raw);
  if (row === null) return null;
  const name = text(row[WIRE_SERVER_KEYS.name]);
  const command = text(row[WIRE_SERVER_KEYS.command]);
  if (name === null || command === null) return null;

  let env: Record<string, string> | null = null;
  const rawEnv = record(row[WIRE_SERVER_KEYS.env]);
  if (rawEnv !== null) {
    const keys = Object.keys(rawEnv);
    if (keys.length > 0) {
      env = {};
      for (const key of keys) env[key] = '<set>';
    }
  }

  return {
    name,
    command,
    args: strings(row[WIRE_SERVER_KEYS.args]),
    env,
    sourceRef: text(row[WIRE_SERVER_KEYS.sourceRef]) ?? '(unknown source)',
  };
}

function narrowSeat(raw: unknown): McpSeat | null {
  const row = record(raw);
  if (row === null) return null;
  const seatId = text(row[WIRE_SEAT_KEYS.seatId]);
  if (seatId === null) return null;
  const servers = Array.isArray(row[WIRE_SEAT_KEYS.servers])
    ? (row[WIRE_SEAT_KEYS.servers] as unknown[]).map(narrowServer).filter((s): s is McpServer => s !== null)
    : [];
  return {
    seatId,
    label: text(row[WIRE_SEAT_KEYS.label]) ?? seatId,
    engine: text(row[WIRE_SEAT_KEYS.engine]) ?? 'unknown',
    accountId: text(row[WIRE_SEAT_KEYS.accountId]) ?? seatId,
    servers,
    reason: text(row[WIRE_SEAT_KEYS.reason]) ?? 'unknown',
    configFile: text(row[WIRE_SEAT_KEYS.configFile]),
    configFormat: text(row[WIRE_SEAT_KEYS.configFormat]),
    notes: strings(row[WIRE_SEAT_KEYS.notes]),
  };
}

function narrowScope(raw: unknown): McpScope | null {
  const row = record(raw);
  if (row === null) return null;
  return {
    available: flag(row[WIRE_SCOPE_KEYS.available]),
    pinned: flag(row[WIRE_SCOPE_KEYS.pinned]),
    aliasRef: text(row[WIRE_SCOPE_KEYS.aliasRef]),
    tenantRef: text(row[WIRE_SCOPE_KEYS.tenantRef]),
    principalRef: text(row[WIRE_SCOPE_KEYS.principalRef]),
    reason: text(row[WIRE_SCOPE_KEYS.reason]) ?? 'unknown',
  };
}

/** Narrow GET /api/verse/mcp. Null when the body is not this shape at all. */
export function projectMcpSnapshot(raw: unknown): McpSnapshot | null {
  const row = record(raw);
  if (row === null) return null;
  if (!Array.isArray(row[WIRE_SNAPSHOT_KEYS.seats])) return null;

  const machine = record(row[WIRE_SNAPSHOT_KEYS.machine]);
  const machineServers = machine !== null && Array.isArray(machine[WIRE_MACHINE_KEYS.servers])
    ? (machine[WIRE_MACHINE_KEYS.servers] as unknown[]).map(narrowServer).filter((s): s is McpServer => s !== null)
    : [];

  return {
    sampledAt: text(row[WIRE_SNAPSHOT_KEYS.sampledAt]),
    seats: (row[WIRE_SNAPSHOT_KEYS.seats] as unknown[])
      .map(narrowSeat)
      .filter((s): s is McpSeat => s !== null),
    machine: {
      servers: machineServers,
      configured: machine !== null ? flag(machine[WIRE_MACHINE_KEYS.configured]) : machineServers.length > 0,
      note: (machine !== null ? text(machine[WIRE_MACHINE_KEYS.note]) : null) ?? '',
    },
    scope: narrowScope(row[WIRE_SNAPSHOT_KEYS.scope]),
    notes: strings(row[WIRE_SNAPSHOT_KEYS.notes]),
  };
}

function narrowHealthRow(raw: unknown): CliHealthRow | null {
  const row = record(raw);
  if (row === null) return null;
  const accountId = text(row[WIRE_HEALTH_KEYS.accountId]);
  if (accountId === null) return null;
  return {
    accountId,
    label: text(row[WIRE_HEALTH_KEYS.label]) ?? accountId,
    provider: text(row[WIRE_HEALTH_KEYS.provider]) ?? 'unknown',
    authentication: text(row[WIRE_HEALTH_KEYS.authentication]) ?? 'unknown',
    state: text(row[WIRE_HEALTH_KEYS.state]) ?? 'unknown',
    planType: text(row[WIRE_HEALTH_KEYS.planType]),
    reason: text(row[WIRE_HEALTH_KEYS.reason]) ?? 'unknown',
    // A missing version stays NULL. It is never coerced to a string, because
    // "no reading" and "some version" are different facts.
    version: text(row[WIRE_HEALTH_KEYS.version]),
    pinnedVersion: text(row[WIRE_HEALTH_KEYS.pinnedVersion]),
    versionState: text(row[WIRE_HEALTH_KEYS.versionState]) ?? 'unverified',
    usageBlockedByPin: flag(row[WIRE_HEALTH_KEYS.usageBlockedByPin]),
    notes: strings(row[WIRE_HEALTH_KEYS.notes]),
  };
}

/** Narrow GET /api/verse/mcp/cli-health. */
export function projectCliHealth(raw: unknown): CliHealthSnapshot | null {
  const row = record(raw);
  if (row === null) return null;
  if (!Array.isArray(row[WIRE_HEALTH_SNAPSHOT_KEYS.accounts])) return null;
  const accounts = (row[WIRE_HEALTH_SNAPSHOT_KEYS.accounts] as unknown[])
    .map(narrowHealthRow)
    .filter((a): a is CliHealthRow => a !== null);
  return {
    sampledAt: text(row[WIRE_HEALTH_SNAPSHOT_KEYS.sampledAt]),
    accounts,
    // Derived locally as well as read, so a server that forgot the flag still
    // renders the banner rather than silently hiding a drift.
    driftDetected:
      flag(row[WIRE_HEALTH_SNAPSHOT_KEYS.driftDetected]) ||
      accounts.some((account) => account.versionState === 'drift'),
    notes: strings(row[WIRE_HEALTH_SNAPSHOT_KEYS.notes]),
  };
}

// ---------------------------------------------------------------------------
// Copy for the machine-readable reasons this surface renders
// ---------------------------------------------------------------------------

/**
 * Plain language for each seat reason. The CODE is still shown next to the
 * sentence — it is the thing to search for — but it is never the sentence.
 * Same split `usage/accounts-model.ts` uses for probe reasons.
 */
export const SEAT_REASON_COPY: Record<string, string> = {
  'mcp-seat-isolated-by-adapter':
    'Verse launches every turn on this seat with an empty MCP configuration, so it loads no MCP '
    + 'servers at all — whatever is configured elsewhere on this machine.',
  'mcp-account-config-absent':
    'This account has no MCP configuration file of its own, so it starts with none.',
  'mcp-account-config-not-json':
    'This account keeps its MCP servers in a TOML config that the provider CLI reads directly. '
    + 'Hub does not parse or rewrite it, so it cannot list what is in there.',
  'mcp-account-config-read':
    'Read from this account\'s own private configuration.',
  'mcp-account-config-unreadable':
    'This account\'s configuration could not be read.',
  'mcp-account-profile-unresolved':
    'This account\'s private profile could not be located, so Hub cannot say what it would load.',
};

export const SCOPE_REASON_COPY: Record<string, string> = {
  'mcp-scope-locus-unavailable':
    'Locus is not reachable on this machine, so writes are not attributable to a tenant.',
  'mcp-scope-unpinned':
    'Locus is running but nothing is pinned, so there is no tenant to scope a write to.',
  'mcp-scope-seal-unverified':
    'Locus reports a pin whose seal did not verify. Fix the pin before writing anything.',
  'mcp-scope-expired': 'The Locus pin has expired.',
  'mcp-scope-pinned': 'Writes are attributed to the pinned Locus tenant shown here.',
};

/** Prose for a code, or the caller's own sentence. NEVER the raw code alone. */
export function reasonSentence(
  copy: Record<string, string>,
  reason: string,
  fallback: string,
): string {
  return copy[reason] ?? fallback;
}
