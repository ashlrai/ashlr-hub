/**
 * Devin seats for Verse chat (3.15): "Devin (cloud)" — a remote session per
 * chat through the v3 API — and "Devin (CLI)" — the local `devin` agent over
 * ACP. Both are the operator's own chats.
 *
 * DELIBERATELY NOT PART OF `discoverSeats`. That list also feeds routing, the
 * budget router and the leader seat (fleet machinery); a Devin chat seat must
 * never become a fleet dispatch target — the fleet's Devin lane is its own
 * (core/devin launch with origin `fleet`, the reserve, the grant). Only the
 * Verse chat API merges these in (verse-api `cachedSeats`).
 *
 * Cloud seat states (always listed, so the operator can see how to turn it on):
 *   lane off / no key  → health `unavailable`, summary "Connect Devin: …" /
 *                        "Turn on Devin: …" — the picker shows it disabled
 *   key refused        → `degraded` with the reason (turns still try)
 *   ready              → `ready`, summary = today's ACUs and the per-chat cap
 * CLI seat: listed only when the `devin` binary is found; `unavailable`
 * ("Log in: `devin auth login`") until its credentials file exists. Found /
 * logged-in are read from disk (a stat each) — never by running the CLI.
 *
 * Context window: none. Devin manages its own context remotely, so the
 * seat's window is null and the UI says "remote".
 *
 * Readiness (`devinSeatReadiness`): a chat that has no Devin session yet is
 * refused, with the budget's own sentence, when starting one would pass the
 * daily cap / pause threshold / concurrency (the operator's gate — never the
 * fleet reserve). A chat that already has its session is admitted: its
 * session's own ACU cap bounds it.
 */
import { access, constants as fsConstants } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { devinBudgetView } from '../devin/budget.js';
import { DEVIN_CLI_SEAT_ID, DEVIN_CLOUD_SEAT_ID, devinChatGate } from '../devin/chat.js';
import { devinStatus } from '../devin/service.js';
import { listDevinTasks, readDevinBudget } from '../devin/store.js';
import type { DevinStatus } from '../devin/types.js';
import { DEVIN_DEFAULT_MODEL_ID } from './adapters/devin.js';
import type { SeatReadiness } from './health-types.js';
import type { VerseSeatLaunch } from './session-engine.js';
import type { VerseSeatDiscovery } from './seats.js';
import type { VerseModelOption, VerseSeat, VerseSession } from './types.js';

export { DEVIN_CLI_SEAT_ID, DEVIN_CLOUD_SEAT_ID };

export const DEVIN_CONNECT_HINT = 'Connect Devin: `ashlr devin connect`';
export const DEVIN_ENABLE_HINT = 'Turn on Devin: `ashlr devin enable`';
export const DEVIN_CLI_LOGIN_HINT = 'Log in: `devin auth login`';

/** Where the documented installers put the binary (brew cask, curl installer). */
export function defaultDevinCliCandidates(home: string = homedir()): string[] {
  return ['/opt/homebrew/bin/devin', '/usr/local/bin/devin', join(home, '.local', 'bin', 'devin')];
}

/** `$XDG_DATA_HOME/devin/credentials.toml`, else `~/.local/share/devin/credentials.toml` (docs.devin.ai/cli/enterprise/devin-auth). */
export function devinCliCredentialsPath(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  const xdg = env['XDG_DATA_HOME'];
  return join(xdg && xdg.startsWith('/') ? xdg : join(home, '.local', 'share'), 'devin', 'credentials.toml');
}

export interface DevinSeatDiscoveryOptions {
  /** Lane status (tests); default: core/devin `devinStatus()` (Keychain presence is cached there). */
  status?: () => Promise<Pick<DevinStatus, 'state' | 'reason'>>;
  /** Paths to look for the CLI at, first executable wins; `[]` = never offer the CLI seat. */
  cliCandidates?: readonly string[];
  /** Where the CLI keeps its login (tests). */
  cliCredentialsPath?: string;
  now?: () => Date;
}

async function executable(path: string): Promise<boolean> {
  try {
    await access(path, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

const unknownWindows: VerseSeat['health']['windows'] = [];

function acu(n: number): string {
  const rounded = Math.round(n * 10) / 10;
  return `${rounded} ACU${rounded === 1 ? '' : 's'}`;
}

function cloudModel(unavailableReason: string | null): VerseModelOption {
  return {
    id: DEVIN_DEFAULT_MODEL_ID,
    label: 'Devin',
    contextWindow: null,
    windowSource: 'fallback',
    ...(unavailableReason ? { unavailableReason } : {}),
  };
}

/**
 * The CLI's model families. The docs say these short names "always resolve to
 * the latest version in that model family" (docs.devin.ai/cli/models), so the
 * list never goes stale; `devin` = the CLI's own default.
 */
const CLI_MODELS: ReadonlyArray<{ id: string; label: string }> = [
  { id: DEVIN_DEFAULT_MODEL_ID, label: 'Devin default' },
  { id: 'opus', label: 'Claude Opus (latest)' },
  { id: 'sonnet', label: 'Claude Sonnet (latest)' },
  { id: 'swe', label: 'SWE (latest)' },
  { id: 'codex', label: 'Codex (latest)' },
  { id: 'gemini', label: 'Gemini (latest)' },
];

export async function discoverDevinSeats(opts: DevinSeatDiscoveryOptions = {}): Promise<{ seats: VerseSeat[]; launches: Map<string, VerseSeatLaunch> }> {
  const seats: VerseSeat[] = [];
  const launches = new Map<string, VerseSeatLaunch>();
  const now = (opts.now ?? (() => new Date()))();

  // ---- cloud ------------------------------------------------------------
  let status: Pick<DevinStatus, 'state' | 'reason'>;
  try {
    status = await (opts.status ?? (() => devinStatus()))();
  } catch {
    status = { state: 'not-connected', reason: DEVIN_CONNECT_HINT };
  }
  let health: VerseSeat['health'];
  let unavailable: string | null = null;
  if (status.state === 'disabled' || status.state === 'not-connected') {
    // "Not set up" and "key missing" both need a connect; a connected-but-off lane needs enable.
    const hint = status.state === 'disabled' && /connected, but/i.test(status.reason) ? DEVIN_ENABLE_HINT : DEVIN_CONNECT_HINT;
    unavailable = hint;
    health = { state: 'unavailable', summary: hint, windows: unknownWindows, observedAt: now.toISOString() };
  } else {
    let summary: string | null = null;
    try {
      const view = devinBudgetView(listDevinTasks(Number.MAX_SAFE_INTEGER), readDevinBudget(), now);
      summary = `${acu(view.acuToday)} of ${acu(view.budget.maxAcuPerDay)} today · up to ${acu(view.budget.maxAcuPerSession)} per chat`;
      if (!view.canLaunch.ok && view.canLaunch.reason) summary = `${summary} · new chats paused: ${view.canLaunch.reason}`;
    } catch {
      summary = null;
    }
    health = status.state === 'unreachable'
      ? { state: 'degraded', summary: status.reason, windows: unknownWindows, observedAt: now.toISOString() }
      : { state: 'ready', summary, windows: unknownWindows, observedAt: now.toISOString() };
  }
  const cloud: VerseSeat = {
    id: DEVIN_CLOUD_SEAT_ID,
    engine: 'devin',
    label: 'Devin (cloud)',
    accountId: DEVIN_CLOUD_SEAT_ID,
    models: [cloudModel(unavailable)],
    contextWindow: null,
    health,
    notes: [
      'Runs in Devin’s own cloud machine on this folder’s GitHub repository (its `origin` remote); Devin manages its own context.',
      'Uses ACUs from your Devin budget. Stop ends (terminates) the Devin session.',
    ],
  };
  seats.push(cloud);
  launches.set(cloud.id, { seat: cloud, launcher: null, ollamaBaseUrl: '', devin: { lane: 'cloud' } });

  // ---- CLI --------------------------------------------------------------
  let cliPath: string | null = null;
  for (const candidate of opts.cliCandidates ?? defaultDevinCliCandidates()) {
    if (candidate.startsWith('/') && await executable(candidate)) {
      cliPath = candidate;
      break;
    }
  }
  if (cliPath) {
    const loggedIn = await exists(opts.cliCredentialsPath ?? devinCliCredentialsPath());
    const reason = loggedIn ? null : DEVIN_CLI_LOGIN_HINT;
    const cli: VerseSeat = {
      id: DEVIN_CLI_SEAT_ID,
      engine: 'devin',
      label: 'Devin (CLI)',
      accountId: DEVIN_CLI_SEAT_ID,
      models: CLI_MODELS.map((m) => ({ id: m.id, label: m.label, contextWindow: null, windowSource: 'fallback', ...(reason ? { unavailableReason: reason } : {}) })),
      contextWindow: null,
      health: loggedIn
        ? { state: 'ready', summary: 'Local Devin agent in this folder; usage counts against your Devin plan.', windows: unknownWindows, observedAt: now.toISOString() }
        : { state: 'unavailable', summary: DEVIN_CLI_LOGIN_HINT, windows: unknownWindows, observedAt: now.toISOString() },
      notes: ['Runs the local `devin` agent in this folder (over ACP). Devin manages its own context.'],
    };
    seats.push(cli);
    launches.set(cli.id, { seat: cli, launcher: null, ollamaBaseUrl: '', devin: { lane: 'cli', cliPath } });
  }
  return { seats, launches };
}

/** `discovery` plus the Devin seats (never replacing a seat id discovery already has). */
export function mergeDevinSeats(discovery: VerseSeatDiscovery, devin: { seats: VerseSeat[]; launches: ReadonlyMap<string, VerseSeatLaunch> }): VerseSeatDiscovery {
  const launches = new Map(discovery.launches);
  const seats = [...discovery.seats];
  for (const seat of devin.seats) {
    if (launches.has(seat.id) || seats.some((s) => s.id === seat.id)) continue;
    const launch = devin.launches.get(seat.id);
    if (!launch) continue;
    seats.push(seat);
    launches.set(seat.id, launch);
  }
  return { seats, launches, localRuntime: discovery.localRuntime };
}

/**
 * The engine's admission answer for a Devin seat, or null for any other seat
 * (the caller then asks the ordinary readiness gate). Sync — see the header.
 */
export function devinSeatReadiness(seatId: string, session?: Pick<VerseSession, 'nativeSessionId'> | null): SeatReadiness | null {
  if (seatId !== DEVIN_CLOUD_SEAT_ID) return seatId === DEVIN_CLI_SEAT_ID ? { seatId, ready: true, reason: null, alternatives: [] } : null;
  if (session && session.nativeSessionId) return { seatId, ready: true, reason: null, alternatives: [] };
  const gate = devinChatGate();
  return gate.ok
    ? { seatId, ready: true, reason: null, alternatives: [] }
    : { seatId, ready: false, reason: `Devin budget: ${gate.reason ?? 'a new Devin session would pass the budget'}`, alternatives: [] };
}
