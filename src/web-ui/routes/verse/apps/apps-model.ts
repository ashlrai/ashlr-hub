/**
 * routes/verse/apps/apps-model.ts — pure view-model for Apps & Accounts.
 *
 * The page has five groups (SPEC-310C §4), from three kinds of source:
 *   ACCOUNTS       the shared capacity rows (usage/capacity-strip-model.ts)
 *                  plus the actions each seat needs (Reconnect / Fix / Edit budget);
 *   DESKTOP, TERMINAL AGENTS, LOCAL MODELS   GET /api/verse/apps, as served;
 *   MCP SERVERS    GET /api/verse/mcp (what each seat would ACTUALLY load).
 * Everything that decides a word, a tone or whether a control is enabled
 * lives here, so it is unit-tested without a DOM.
 *
 * Pure: no React, no I/O.
 */
import type { VerseAppHealthState, VerseAppRow } from '../../../../core/verse/workbench-types.js';
import { ENGINE_MONOGRAM } from '../../../../core/verse/workbench-types.js';
import type { VerseBootstrap, VerseEngine, VerseSeat } from '../../../data/api-types.js';
import type { HealthTone } from '../health/health-model.js';
import type { McpSeat, McpServer, McpSnapshot } from '../mcp/mcp-contract.js';
import { reasonSentence, SEAT_REASON_COPY } from '../mcp/mcp-contract.js';
import type { CapacityRow } from '../usage/capacity-strip-model.js';

/** SPEC-310C §4 order. */
export const APPS_GROUP_ORDER = ['accounts', 'desktop', 'terminal-agents', 'local-models', 'mcp-servers'] as const;
export type AppsGroupId = (typeof APPS_GROUP_ORDER)[number];

export const APPS_GROUP_TITLE: Readonly<Record<AppsGroupId, string>> = {
  accounts: 'Accounts',
  desktop: 'Desktop',
  'terminal-agents': 'Terminal agents',
  'local-models': 'Local models',
  'mcp-servers': 'MCP servers',
};

const HEALTH_TONE: Readonly<Record<VerseAppHealthState, HealthTone | 'off'>> = {
  ok: 'success',
  warn: 'warning',
  error: 'danger',
  off: 'off',
  unknown: 'neutral',
};

/** A row's dot tone. `off` is its own quiet state (not installed, switched off) — never a fault. */
export function appHealthTone(state: VerseAppHealthState): HealthTone | 'off' {
  return HEALTH_TONE[state];
}

const VERSE_ENGINES: readonly VerseEngine[] = ['claude', 'codex', 'grok', 'local'];

export function asEngine(value: string): VerseEngine | null {
  return (VERSE_ENGINES as readonly string[]).includes(value) ? (value as VerseEngine) : null;
}

// ---------------------------------------------------------------------------
// Launch targets
// ---------------------------------------------------------------------------

export interface LaunchProject {
  path: string;
  name: string;
}

function baseName(path: string): string {
  const trimmed = path.replace(/\/+$/, '');
  const i = trimmed.lastIndexOf('/');
  return i === -1 ? trimmed : trimmed.slice(i + 1) || trimmed;
}

/**
 * Where a Launch may start, most relevant first: the folders of the most
 * recently used chats (the "current project"), then every discovered project.
 * The server re-checks each against the same two sources, so this list is a
 * convenience, never the gate.
 */
export function launchProjects(bootstrap: Pick<VerseBootstrap, 'sessions' | 'projects'> | undefined): LaunchProject[] {
  if (!bootstrap) return [];
  const out: LaunchProject[] = [];
  const seen = new Set<string>();
  const add = (path: string, name?: string) => {
    if (typeof path !== 'string' || path.length === 0 || seen.has(path)) return;
    seen.add(path);
    out.push({ path, name: name ?? baseName(path) });
  };
  const recent = [...bootstrap.sessions].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  for (const s of recent) add(s.projectPath);
  for (const p of bootstrap.projects) add(p.path, p.name);
  return out;
}

/** Ollama tags the local seats run — the model choices for `ollama launch <id> --model`. */
export function localModelTags(seats: readonly VerseSeat[]): string[] {
  const out: string[] = [];
  for (const seat of seats) {
    if (seat.engine !== 'local') continue;
    const tag = seat.models[0]?.id ?? (seat.id.startsWith('local:') ? seat.id.slice('local:'.length) : null);
    if (tag && !out.includes(tag)) out.push(tag);
  }
  return out;
}

export type LaunchVia = 'native' | 'ollama';

export interface LaunchChoice {
  via: LaunchVia;
  model: string | null;
}

/** The argv a launch choice runs, as the operator would type it. */
export function launchCommand(row: VerseAppRow, choice: LaunchChoice): string[] | null {
  if (choice.via === 'ollama') {
    if (!row.ollamaLaunch) return null;
    return choice.model ? [...row.ollamaLaunch, '--model', choice.model] : [...row.ollamaLaunch];
  }
  return row.actions.find((a) => a.kind === 'launch')?.command ?? null;
}

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

export type AccountActionKind = 'reconnect' | 'fix' | 'edit-budget';

export interface AccountAction {
  kind: AccountActionKind;
  label: string;
  /** Fix only: the command the dialog shows. */
  command: string[] | null;
  /** Primary = the one thing this seat needs now. */
  primary: boolean;
}

/**
 * What a seat row offers. Reconnect when the seat is signed out or its
 * sign-in is expiring (the provider's own login, in Terminal); Fix when A2
 * has a command for what is wrong (a re-pin); Edit budget for every paid seat.
 * Local rows need none of these.
 */
export function accountActions(row: CapacityRow): AccountAction[] {
  if (row.kind === 'local') return [];
  const out: AccountAction[] = [];
  const c = row.connection;
  const needsLogin = c !== null && (c.connection === 'signed-out' || c.connection === 'expiring' || c.fixKind === 'reauth');
  if (needsLogin) out.push({ kind: 'reconnect', label: 'Reconnect', command: null, primary: true });
  if (c !== null && c.fixKind !== 'reauth' && c.fixKind !== 'none' && c.fixCommand !== null) {
    out.push({ kind: 'fix', label: 'Fix', command: c.fixCommand, primary: !needsLogin });
  }
  out.push({ kind: 'edit-budget', label: 'Edit budget', command: null, primary: false });
  return out;
}

// ---------------------------------------------------------------------------
// MCP
// ---------------------------------------------------------------------------

export interface McpSeatRow {
  seatId: string;
  label: string;
  engine: VerseEngine | null;
  monogram: string;
  servers: McpServer[];
  /** "loads 2 servers", "loads none — isolated by Verse". */
  loads: string;
  isolated: boolean;
  /** Plain language for the seat's reason; the code rides beside it. */
  sentence: string;
  reason: string;
  notes: string[];
}

export function mcpSeatRows(snapshot: McpSnapshot): McpSeatRow[] {
  return snapshot.seats.map((seat: McpSeat) => {
    const engine = asEngine(seat.engine);
    const isolated = seat.reason === 'mcp-seat-isolated-by-adapter';
    const n = seat.servers.length;
    return {
      seatId: seat.seatId,
      label: seat.label,
      engine,
      monogram: engine ? ENGINE_MONOGRAM[engine] : seat.label.slice(0, 1).toUpperCase(),
      servers: seat.servers,
      loads: n > 0 ? `loads ${n} server${n === 1 ? '' : 's'}` : isolated ? 'loads none — isolated by Verse' : 'loads none',
      isolated,
      sentence: reasonSentence(SEAT_REASON_COPY, seat.reason, 'Hub cannot say what this seat would load.'),
      reason: seat.reason,
      notes: seat.notes,
    };
  });
}

/** Where an Add can write: the hub registry, and each account whose config is JSON. */
export interface McpTargetOption {
  id: string;
  label: string;
  /** Why this target cannot take a write, or null. */
  disabledReason: string | null;
}

export function mcpTargets(snapshot: McpSnapshot | null): McpTargetOption[] {
  const out: McpTargetOption[] = [{ id: 'hub', label: 'Hub gateway registry', disabledReason: null }];
  for (const seat of snapshot?.seats ?? []) {
    if (seat.seatId === 'local') continue;
    // An isolated (Claude) account CAN be written — Claude Code in a terminal
    // reads it — and the form says a Verse chat on it still loads nothing.
    const toml = seat.configFormat === 'toml' || seat.reason === 'mcp-account-config-not-json';
    out.push({
      id: `account:${seat.accountId}`,
      label: `${seat.label} (${seat.engine})`,
      disabledReason: toml ? 'Keeps its MCP servers in TOML, which Hub does not rewrite.' : null,
    });
  }
  return out;
}

/** Split `a "b c" d` into argv the way a shell would, for the Add form's arguments field. */
export function splitArgs(text: string): string[] {
  const out: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let has = false;
  for (const ch of text) {
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      has = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (has || current.length > 0) out.push(current);
      current = '';
      has = false;
      continue;
    }
    current += ch;
  }
  if (has || current.length > 0) out.push(current);
  return out;
}

/** `KEY=value` lines → an env object; the first bad line is reported, never guessed. */
export function parseEnvLines(text: string): { ok: true; env: Record<string, string> } | { ok: false; error: string } {
  const env: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    const key = eq === -1 ? '' : line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return { ok: false, error: `“${line.slice(0, 40)}” is not KEY=value.` };
    env[key] = line.slice(eq + 1);
  }
  return { ok: true, env };
}
