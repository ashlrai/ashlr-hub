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
 * logged-in come from the shared CLI probe (core/devin/cli-probe.ts: an
 * async `access()` each, never running the CLI) — the same answer the turns
 * route and the readiness gate below refuse a CLI turn with.
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
import { devinBudgetView } from '../devin/budget.js';
import {
  DEVIN_CLI_LOGIN_HINT,
  defaultDevinCliCandidates,
  devinCliCredentialsPath,
  peekDevinCliProbe,
  probeDevinCli,
  type DevinCliProbe,
  type DevinCliProbeOptions,
} from '../devin/cli-probe.js';
import { DEVIN_CLI_SEAT_ID, DEVIN_CLOUD_SEAT_ID, devinChatGate } from '../devin/chat.js';
import { devinStatus } from '../devin/service.js';
import { listDevinTasks, readDevinBudget } from '../devin/store.js';
import type { DevinStatus } from '../devin/types.js';
import { DEVIN_DEFAULT_MODEL_ID } from './adapters/devin.js';
import type { SeatReadiness } from './health-types.js';
import type { VerseSeatLaunch } from './session-engine.js';
import type { VerseSeatDiscovery } from './seats.js';
import type { VerseModelOption, VerseSeat, VerseSession } from './types.js';

export { DEVIN_CLI_SEAT_ID, DEVIN_CLOUD_SEAT_ID, DEVIN_CLI_LOGIN_HINT, defaultDevinCliCandidates, devinCliCredentialsPath };

export const DEVIN_CONNECT_HINT = 'Connect Devin: `ashlr devin connect`';
export const DEVIN_ENABLE_HINT = 'Turn on Devin: `ashlr devin enable`';

export interface DevinSeatDiscoveryOptions {
  /** Lane status (tests); default: core/devin `devinStatus()` (Keychain presence is cached there). */
  status?: () => Promise<Pick<DevinStatus, 'state' | 'reason'>>;
  /** Paths to look for the CLI at, first executable wins; `[]` = never offer the CLI seat. */
  cliCandidates?: readonly string[];
  /** Where the CLI keeps its login (tests). */
  cliCredentialsPath?: string;
  now?: () => Date;
}

/** The CLI probe with this discovery's paths (tests pin them; production uses the install paths). */
function cliProbeOptions(opts: Pick<DevinSeatDiscoveryOptions, 'cliCandidates' | 'cliCredentialsPath'>): DevinCliProbeOptions {
  return {
    ...(opts.cliCandidates ? { cliCandidates: opts.cliCandidates } : {}),
    ...(opts.cliCredentialsPath ? { cliCredentialsPath: opts.cliCredentialsPath } : {}),
  };
}

/**
 * Before a turn on a CLI chat: the probe (reused for a few seconds), as the
 * readiness the turns route refuses with. Async — the route awaits it, and
 * the engine's synchronous gate (`devinSeatReadiness`) then reads the same
 * answer.
 */
export async function devinCliTurnReadiness(opts: Pick<DevinSeatDiscoveryOptions, 'cliCandidates' | 'cliCredentialsPath'> = {}): Promise<SeatReadiness> {
  return readinessOf(await probeDevinCli(cliProbeOptions(opts)));
}

function readinessOf(probe: DevinCliProbe): SeatReadiness {
  return probe.state === 'ready'
    ? { seatId: DEVIN_CLI_SEAT_ID, ready: true, reason: null, alternatives: [] }
    : { seatId: DEVIN_CLI_SEAT_ID, ready: false, reason: probe.reason, alternatives: [] };
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
    // 3.15 (routing/tiers.ts): a cloud turn spends ACU credits — the router's
    // marginal-cost rule and the Resources card both read this.
    costBasis: 'credits',
    health,
    notes: [
      'Runs in Devin’s own cloud machine on this folder’s GitHub repository (its `origin` remote); Devin manages its own context.',
      'Uses ACUs from your Devin budget. Stop ends (terminates) the Devin session.',
    ],
  };
  seats.push(cloud);
  launches.set(cloud.id, { seat: cloud, launcher: null, ollamaBaseUrl: '', devin: { lane: 'cloud' } });

  // ---- CLI --------------------------------------------------------------
  // Always a fresh probe here (discovery is itself cached by the caller); the
  // answer also refreshes what the turn gate reads.
  const probe = await probeDevinCli({ ...cliProbeOptions(opts), maxAgeMs: 0 });
  const cliPath = probe.cliPath;
  if (cliPath) {
    const loggedIn = probe.state === 'ready';
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
 *
 * CLI seat: the latest CLI probe (the turns route awaits a fresh one before
 * it calls the engine, so on that path this is never stale). With no recent
 * answer — a queued turn long after the last probe — the turn is admitted and
 * a probe starts in the background; the bridge still refuses a logged-out CLI
 * with its own sentence.
 */
export function devinSeatReadiness(seatId: string, session?: Pick<VerseSession, 'nativeSessionId'> | null): SeatReadiness | null {
  if (seatId === DEVIN_CLI_SEAT_ID) {
    const probe = peekDevinCliProbe();
    return probe ? readinessOf(probe) : { seatId, ready: true, reason: null, alternatives: [] };
  }
  if (seatId !== DEVIN_CLOUD_SEAT_ID) return null;
  if (session && session.nativeSessionId) return { seatId, ready: true, reason: null, alternatives: [] };
  const gate = devinChatGate();
  return gate.ok
    ? { seatId, ready: true, reason: null, alternatives: [] }
    : { seatId, ready: false, reason: `Devin budget: ${gate.reason ?? 'a new Devin session would pass the budget'}`, alternatives: [] };
}
