/**
 * core/routing/readiness.ts — "is this resource ready for chat, and for the
 * fleet — and if not, exactly why and what fixes it?" (3.14).
 *
 * Serves `GET /api/verse/budget/readiness` (readiness-types.ts). Nothing here
 * decides anything new: every verdict is an EXISTING gate, asked the same way
 * its owner asks it, so the drawer can never disagree with the system it
 * describes.
 *
 *   Chat   `seatReadiness` (core/verse/seat-readiness.ts) — the session
 *          engine's own admission gate, fail-open on missing evidence — plus
 *          the seat's runnable models.
 *   Fleet  the daemon's order (fleet/tick-hooks-live.ts): the standing grant
 *          and its current rollout stage (`evaluateStandingAuthority`),
 *          `clampBudgetPolicy`, the Leader's Codex directive (applied exactly
 *          as `applyCodexDirective` does), then `assessSeat` against the
 *          CAPACITY SNAPSHOT the daemon routes on (~/.ashlr/routing/
 *          capacity.json) — not this server's in-memory view, because the
 *          fleet does not read that.
 *
 * `buildResourceReadiness` is PURE (all inputs injected) and is what the
 * tests exercise; `gatherResourceReadiness` reads the live sources. Reading is
 * read-only: no probe is started, no lease is taken, nothing is written.
 */
import type { AshlrConfig } from '../types.js';
import type { VerseSeat } from '../verse/types.js';
import type { SeatHealthReport } from '../verse/health-types.js';
import type { VerseAccountRecord } from '../verse/accounts.js';
import type { EffectivePolicy, StandingGrantSeat } from '../authority/types.js';
import type { BudgetPolicy, SeatBudgetPolicy } from './types.js';
import { seatReadiness } from '../verse/seat-readiness.js';
import { clampBudgetPolicy, fleetEngineOfSeat, standingSeatFor } from '../authority/effective-config.js';
import { effectiveSeatPolicy, engineOfSeatId } from './policy.js';
import { assessSeat, type SeatCapacity } from './headroom.js';
import type {
  FleetReadinessVerdict,
  ReadinessFix,
  ReadinessTone,
  ReadinessVerdict,
  ResourceReading,
  ResourceReadinessResponse,
  ResourceReadinessRow,
} from './readiness-types.js';

// ---------------------------------------------------------------------------
// Commands (literal, secret-free, home-relative)
// ---------------------------------------------------------------------------

/** The one command that creates the cloud lane's `claude-a` native profile. */
export const CLOUD_SEAT_SETUP_COMMAND =
  'ashlr resources profile prepare --provider claude --directory ~/.ashlr/native-profiles/claude-a --executable "$(realpath "$(command -v claude)")"';

/** Installs and verifies a standing grant (Touch ID) — the only way autonomy turns on. */
export const AUTHORITY_SETUP_COMMAND = 'ashlr authority setup';

/** Starts the Ollama app, which serves the local seats. */
export const OLLAMA_START_COMMAND = 'open -a Ollama';

const LANE_NAME: Readonly<Record<string, string>> = {
  local: 'local',
  'grok-cli': 'Grok',
  'claude-cli': 'Claude',
  codex: 'Codex',
};

const MODE_WORD: Readonly<Record<BudgetPolicy['mode'], string>> = {
  'all-in': 'all-in',
  balanced: 'balanced',
  reserve: 'reserve',
};

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

export type ReadinessAccount = Pick<VerseAccountRecord,
  'id' | 'label' | 'provider' | 'state' | 'observedAt' | 'lastReadingAt' | 'reason'>;

export interface ReadinessStanding {
  /** The effective policy in force; null = no standing autonomy right now. */
  policy: Pick<EffectivePolicy, 'spend' | 'engines' | 'rollout'> | null;
  /** Why autonomy is off (null when active). */
  inactiveReason: string | null;
  /** True when NO grant is installed at all (the fix is `ashlr authority setup`). */
  noGrant: boolean;
  /** The installed grant's own seats, engines and stage ladder; null when none is installed. */
  grant: {
    seats: Readonly<Record<string, StandingGrantSeat>>;
    engines: readonly string[];
    stages: ReadonlyArray<{ id: string; engines: readonly string[] }>;
  } | null;
}

export interface ReadinessCloud {
  seatReady: boolean;
  seatReason: string | null;
  /** The account id whose profile the cloud lane launches through, when that account is signed out. */
  signedOutSeatId: string | null;
  canLaunch: { ok: boolean; reason: string | null };
  canSelfImprove: { ok: boolean; reason: string | null };
  selfImprove: { enabled: boolean; maxPerDay: number; reserveUsd: number };
  remainingUsd: number;
  totalUsd: number;
}

export interface ReadinessInput {
  nowMs: number;
  seats: readonly VerseSeat[];
  reports: readonly SeatHealthReport[] | null;
  /** The account roster, in connections.json order. */
  accounts: readonly ReadinessAccount[];
  /** The fleet's capacity snapshot seats; null when there is no snapshot. */
  capacity: readonly SeatCapacity[] | null;
  capacitySnapshotAt: string | null;
  standing: ReadinessStanding;
  budget: BudgetPolicy;
  /** The Leader's `codexEnabled`, already clamped to the grant's engines. */
  codexDirective: boolean;
  local: { reachable: boolean | null; baseUrl: string };
  cloud: ReadinessCloud | null;
}

// ---------------------------------------------------------------------------
// Small builders
// ---------------------------------------------------------------------------

function verdict(ready: boolean, tone: ReadinessTone, word: string, detail: string, fix: ReadinessFix | null = null): ReadinessVerdict {
  return { ready, tone, word, detail, fix };
}

function fleet(v: ReadinessVerdict, roles: readonly string[] = [], reservePercent: number | null = null): FleetReadinessVerdict {
  return { ...v, roles: [...roles], reservePercent };
}

function reconnect(seatId: string): ReadinessFix {
  return { kind: 'reconnect', label: 'Reconnect', seatId };
}

function command(label: string, line: string): ReadinessFix {
  return { kind: 'command', label, command: line };
}

function usd(value: number): string {
  const v = Math.max(0, value);
  return v >= 100 || Number.isInteger(v) ? `$${Math.round(v)}` : `$${v.toFixed(2)}`;
}

/** Why an account has no live reading, from its machine reason — one sentence, never the code. */
const READING_NOTE: Readonly<Record<string, string>> = {
  'connection-polling-paused':
    'Polling is paused because nothing has asked for account data recently; it resumes the moment Verse is looked at.',
  'connection-reading-expired': 'The last reading expired before the next check landed.',
  'connection-not-checked': 'No check has run yet in this server.',
  'collector-owned': 'Another Ashlr process holds the metadata lease; readings arrive when it publishes them.',
  'collector-not-running': 'No account collector runs in this server.',
  'collector-unavailable': 'Account polling stopped in this server.',
  'baseline-historical': 'Only an old operator-seeded reading exists.',
  'native-account-unavailable': 'The last check marked this account unavailable.',
};

function readingOf(account: ReadinessAccount | null): ResourceReading {
  if (account && account.state === 'observed' && account.observedAt !== null) {
    return { state: 'live', at: account.observedAt, note: null };
  }
  const note = account ? READING_NOTE[account.reason] ?? 'The latest check did not return a usable reading.' : 'Not in the account roster.';
  if (account?.lastReadingAt) return { state: 'last', at: account.lastReadingAt, note };
  return { state: 'none', at: null, note };
}

function reportFor(reports: readonly SeatHealthReport[] | null, seatId: string): SeatHealthReport | null {
  return reports?.find((r) => r.seatId === seatId) ?? null;
}

function hasRunnableModel(seat: VerseSeat): boolean {
  return seat.models.some((m) => !m.unavailableReason);
}

function rolesText(roles: readonly string[]): string {
  if (roles.length === 0) return '';
  const names = roles.map((r) => (r === 'producer' ? 'builds' : r === 'judge' ? 'judges' : r === 'leader' ? 'leads' : r));
  return ` Roles: ${names.join(', ')}.`;
}

// ---------------------------------------------------------------------------
// Chat
// ---------------------------------------------------------------------------

function paidChat(seat: VerseSeat | null, account: ReadinessAccount | null, input: ReadinessInput): ReadinessVerdict {
  if ((seat?.id ?? account?.id)?.toLowerCase() === 'claude-api') {
    return verdict(false, 'blocked', 'Not commissioned', 'Claude API is not commissioned in the signed grant.');
  }
  if (seat === null) {
    return verdict(false, 'blocked', 'Not found', "Verse did not discover this account's pinned profile, so no chat can start on it.");
  }
  const admission = seatReadiness(seat.id, input.seats, input.reports, input.nowMs);
  const report = reportFor(input.reports, seat.id);
  if (!admission.ready) {
    const signedOut = report?.connection === 'signed-out' || seat.capacity?.usability === 'signed-out';
    if (signedOut) return verdict(false, 'blocked', 'Signed out', admission.reason ?? '', reconnect(seat.id));
    const alternatives = admission.alternatives
      .map((id) => input.seats.find((s) => s.id === id)?.label)
      .filter((label): label is string => typeof label === 'string')
      .slice(0, 2);
    const tail = alternatives.length > 0 ? ` Try ${alternatives.join(' or ')}.` : '';
    return verdict(false, 'blocked', 'Out of usage', `${admission.reason ?? ''}${tail}`.trim());
  }
  if (!hasRunnableModel(seat)) {
    const repin = report?.fix.kind === 'repin' && report.fix.command ? command('Re-pin the CLI', report.fix.command.join(' ')) : null;
    return verdict(false, 'blocked', 'No runnable model', seat.notes?.[0] ?? "None of this seat's models can run on its pinned CLI.", repin);
  }
  if (report?.connection === 'expiring') {
    return verdict(true, 'warn', 'Ready', 'Its sign-in expires soon — reconnect before it lapses.', reconnect(seat.id));
  }
  if (report?.connection === 'binary-skew' && report.fix.kind === 'repin' && report.fix.command) {
    return verdict(true, 'warn', 'Ready', 'Pinned to an older CLI build than the newest installed one.', command('Re-pin the CLI', report.fix.command.join(' ')));
  }
  if (seat.capacity?.usability === 'tight') {
    return verdict(true, 'warn', 'Ready · tight', seat.capacity.binding ? 'A usage window is near its limit.' : 'Some usage is near its limit.');
  }
  if (!account || account.state !== 'observed') {
    return verdict(true, 'warn', 'Ready', 'No current usage reading — the provider decides at send time.',
      { kind: 'check-again', label: 'Check again', seatId: seat.id });
  }
  return verdict(true, 'ok', 'Ready', '');
}

// ---------------------------------------------------------------------------
// Fleet
// ---------------------------------------------------------------------------

function stageSentence(standing: ReadinessStanding, lane: string): string {
  const policy = standing.policy!;
  const position = policy.rollout;
  const here = `The rollout is at stage ${position.stageIndex + 1} of ${position.stageCount} (${position.stageId})`;
  const name = LANE_NAME[lane] ?? lane;
  const grantHasLane = standing.grant?.engines.includes(lane) ?? false;
  const opens = grantHasLane
    ? standing.grant!.stages.findIndex((stage, index) => index > position.stageIndex && stage.engines.includes(lane))
    : -1;
  if (opens < 0) return `${here}; this grant never opens the ${name} lane.`;
  return `${here}; the ${name} lane opens at stage ${opens + 1} (${standing.grant!.stages[opens]!.id}).`;
}

/**
 * The daemon's seat policy for `seatId`: the budget clamped to the grant, then
 * the Leader's Codex directive — `applyCodexDirective` in tick-hooks-live.ts,
 * restated for one seat.
 */
function fleetSeatPolicy(input: ReadinessInput, seatId: string): SeatBudgetPolicy {
  const policy = input.standing.policy!;
  const known = [...new Set([...(input.capacity ?? []).map((s) => s.seatId), seatId])];
  const clamped = clampBudgetPolicy(input.budget, policy, known);
  const engine = engineOfSeatId(seatId);
  const current = effectiveSeatPolicy(clamped, seatId, engine);
  if (current.enabled || engine !== 'codex' || !input.codexDirective || !policy.engines.includes('codex')) return current;
  const granted = standingSeatFor(policy.spend, seatId);
  if (!granted?.enabled) return current;
  return { ...current, enabled: true, reservePercent: Math.max(current.reservePercent, granted.reserveFloorPercent) };
}

/** Everything before the capacity check: grant, stage, budget. Null = passes. */
function fleetGate(input: ReadinessInput, seatId: string): { gate: FleetReadinessVerdict | null; roles: string[] } {
  const { standing } = input;
  if (standing.policy === null) {
    const fix = standing.noGrant ? command('Set up autonomy', AUTHORITY_SETUP_COMMAND) : null;
    return { gate: fleet(verdict(false, 'off', 'Autonomy off', standing.inactiveReason ?? 'No standing grant is active.', fix)), roles: [] };
  }
  const granted = standing.grant ? standingSeatFor({ seats: standing.grant.seats }, seatId) : null;
  if (!granted) {
    return { gate: fleet(verdict(false, 'off', 'Not in the grant', "The standing grant doesn't include this seat, so the fleet never uses it.")), roles: [] };
  }
  const roles = [...granted.roles];
  if (!granted.enabled) {
    return { gate: fleet(verdict(false, 'off', 'Off in the grant', 'The standing grant lists this seat but switches it off.'), roles), roles };
  }
  const lane = fleetEngineOfSeat(seatId);
  if (lane === null) {
    return { gate: fleet(verdict(false, 'blocked', 'Not commissioned', 'Claude API is not commissioned in the signed grant.'), roles), roles };
  }
  if (!standing.policy.engines.includes(lane as never)) {
    return { gate: fleet(verdict(false, 'off', 'Not in this stage', `${stageSentence(standing, lane)}`), roles), roles };
  }
  return { gate: null, roles };
}

const BLOCKER_WORD: Readonly<Record<string, { word: string; tone: ReadinessTone }>> = {
  'unknown-usage': { word: 'No reading', tone: 'blocked' },
  'signed-out': { word: 'Signed out', tone: 'blocked' },
  spent: { word: 'Spent', tone: 'warn' },
  reserve: { word: 'Reserve reached', tone: 'warn' },
  'session-ceiling': { word: 'Session ceiling', tone: 'warn' },
  'spend-cap': { word: 'Spend cap', tone: 'warn' },
  unreachable: { word: 'Not answering', tone: 'blocked' },
  'switched-off': { word: 'Switched off', tone: 'off' },
};

function paidFleet(input: ReadinessInput, seatId: string): FleetReadinessVerdict {
  const { gate, roles } = fleetGate(input, seatId);
  if (gate) return gate;
  const seatPolicy = fleetSeatPolicy(input, seatId);
  const engine = engineOfSeatId(seatId);
  if (!seatPolicy.enabled) {
    const detail = engine === 'codex'
      ? `Codex autonomy stays off in ${MODE_WORD[input.budget.mode]} mode until the Leader turns the Codex lanes on.`
      : 'Autonomy is switched off for this seat in the budget.';
    return fleet(verdict(false, 'off', engine === 'codex' ? `Off in ${MODE_WORD[input.budget.mode]}` : 'Switched off', detail), roles, seatPolicy.reservePercent);
  }
  const capacity = input.capacity?.find((c) => c.seatId === seatId) ?? null;
  if (capacity === null) {
    return fleet(verdict(false, 'blocked', 'No reading',
      input.capacity === null
        ? 'The fleet has no capacity snapshot yet, so it treats every paid seat as unknown usage.'
        : "The fleet's capacity snapshot has no entry for this seat yet."), roles, seatPolicy.reservePercent);
  }
  const assessment = assessSeat(capacity, seatPolicy, { nowMs: input.nowMs });
  const reserve = seatPolicy.reservePercent;
  if (assessment.headroom.eligibleForAutonomy) {
    // The reserve itself is carried as data (`reservePercent`) and worded by
    // the UI beside "Ready"; the sentence says what is LEFT for the fleet.
    const left = assessment.headroom.autonomyHeadroomPercent;
    const binding = assessment.headroom.bindingWindow === 'session' ? '5-hour window' : 'weekly window';
    const head = left === null ? 'Headroom available.' : `${left}% of the ${binding} is left for the fleet.`;
    return fleet(verdict(true, 'ok', 'Ready', `${head}${rolesText(roles)}`), roles, reserve);
  }
  const index = assessment.details.findIndex((d) => d.kind !== 'headroom' && d.kind !== 'model-window');
  const blocker = index >= 0 ? assessment.details[index]! : null;
  const sentence = index >= 0 ? assessment.headroom.reasons[index] ?? blocker!.text : 'Not eligible for autonomy right now.';
  const shape = (blocker && BLOCKER_WORD[blocker.kind]) ?? { word: 'Not eligible', tone: 'blocked' as ReadinessTone };
  const fix = blocker?.kind === 'signed-out' ? reconnect(seatId) : null;
  return fleet(verdict(false, shape.tone, shape.word, sentence, fix), roles, reserve);
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

function paidRow(account: ReadinessAccount, input: ReadinessInput): ResourceReadinessRow {
  const seat = input.seats.find((s) => s.engine !== 'local' && (s.accountId === account.id || s.id === account.id)) ?? null;
  return {
    id: account.id,
    label: account.label,
    engine: account.provider,
    kind: 'subscription',
    reading: readingOf(account),
    chat: paidChat(seat, account, input),
    fleet: paidFleet(input, seat?.id ?? account.id),
  };
}

function localRow(input: ReadinessInput): ResourceReadinessRow {
  const localSeats = input.seats.filter((s) => s.engine === 'local');
  const runnable = localSeats.filter(hasRunnableModel);
  const reachable = input.local.reachable === true || localSeats.length > 0;
  const down = !reachable;
  const reading: ResourceReading = down
    ? { state: 'none', at: null, note: `Ollama isn't answering at ${input.local.baseUrl}.` }
    : { state: 'live', at: new Date(input.nowMs).toISOString(), note: null };

  let chat: ReadinessVerdict;
  if (down) {
    chat = verdict(false, 'blocked', 'Not answering', `Ollama isn't answering at ${input.local.baseUrl}, so no local model can take a chat.`,
      command('Start Ollama', OLLAMA_START_COMMAND));
  } else if (runnable.length === 0) {
    chat = verdict(false, 'blocked', 'No agentic model', 'No installed Ollama model supports tools with a usable context window, so none can drive a chat.');
  } else {
    const names = runnable.slice(0, 3).map((s) => s.models[0]?.label ?? s.label);
    const more = runnable.length > names.length ? ` and ${runnable.length - names.length} more` : '';
    chat = verdict(true, 'ok', 'Ready', `${names.join(', ')}${more}.`);
  }

  // The fleet treats local as ONE seat (tick-hooks-live `localSeat`), gated by
  // the grant's `local` entry and reachability only.
  const probeId = runnable[0]?.id ?? localSeats[0]?.id ?? 'local';
  const { gate, roles } = fleetGate(input, probeId);
  let fleetVerdict: FleetReadinessVerdict;
  if (gate) {
    fleetVerdict = gate;
  } else {
    const seatPolicy = fleetSeatPolicy(input, probeId);
    const capacity: SeatCapacity = {
      seatId: probeId, engine: 'local', label: 'Local', free: true, windows: [], signedOut: false,
      reachable: down ? false : true, contextWindow: null, observedAt: null, spentTodayUsd: null,
    };
    const assessment = assessSeat(capacity, seatPolicy, { nowMs: input.nowMs });
    fleetVerdict = assessment.headroom.eligibleForAutonomy
      ? fleet(verdict(true, 'ok', 'Ready', `Free — no usage window to protect.${rolesText(roles)}`), roles, null)
      : fleet(down
        ? verdict(false, 'blocked', 'Not answering', 'The local runtime is not reachable.', command('Start Ollama', OLLAMA_START_COMMAND))
        : verdict(false, 'off', 'Switched off', 'Autonomy is switched off for local models in the budget.'), roles, null);
  }
  return { id: 'local', label: 'Local models', engine: 'local', kind: 'local', reading, chat, fleet: fleetVerdict };
}

function cloudRow(input: ReadinessInput): ResourceReadinessRow {
  const cloud = input.cloud;
  if (cloud === null) {
    const off = verdict(false, 'off', 'Not available', 'This build has no cloud lane.');
    return { id: 'cloud', label: 'Claude cloud', engine: 'claude', kind: 'cloud',
      reading: { state: 'none', at: null, note: 'No cloud lane in this build.' }, chat: off, fleet: fleet(off) };
  }
  const credits = `About ${usd(cloud.remainingUsd)} of ${usd(cloud.totalUsd)} in estimated credits left.`;
  let chat: ReadinessVerdict;
  if (!cloud.seatReady) {
    chat = verdict(false, 'blocked', 'Not set up',
      `${cloud.seatReason ?? "The Claude seat isn't set up on this Mac."} Create the claude-a profile, then sign it in with the command it prints.`,
      command('Set up the Claude seat', CLOUD_SEAT_SETUP_COMMAND));
  } else if (cloud.signedOutSeatId !== null) {
    chat = verdict(false, 'blocked', 'Signed out', 'The claude-a profile the cloud lane launches through is signed out.', reconnect(cloud.signedOutSeatId));
  } else if (!cloud.canLaunch.ok) {
    chat = verdict(false, 'warn', 'Budget', cloud.canLaunch.reason ?? 'The cloud budget does not allow another launch right now.');
  } else {
    chat = verdict(true, 'ok', 'Ready', `Run in cloud from any chat. ${credits}`);
  }

  let fleetVerdict: FleetReadinessVerdict;
  if (!cloud.selfImprove.enabled) {
    fleetVerdict = fleet(verdict(false, 'off', 'Off', 'Self-improvement is off — cloud sessions run only when you launch them.'));
  } else if (!chat.ready) {
    fleetVerdict = fleet({ ...chat, detail: `Self-improvement is on but cannot launch: ${chat.detail}` });
  } else if (!cloud.canSelfImprove.ok) {
    fleetVerdict = fleet(verdict(false, 'warn', 'Paused', cloud.canSelfImprove.reason ?? 'Self-improvement is paused by its budget.'));
  } else {
    fleetVerdict = fleet(verdict(true, 'ok', 'Ready',
      `Self-improvement: up to ${cloud.selfImprove.maxPerDay} a day; stops below ${usd(cloud.selfImprove.reserveUsd)} estimated.`));
  }
  return {
    id: 'cloud', label: 'Claude cloud', engine: 'claude', kind: 'cloud',
    reading: { state: 'live', at: new Date(input.nowMs).toISOString(), note: credits },
    chat, fleet: fleetVerdict,
  };
}

function autonomyLine(standing: ReadinessStanding): ResourceReadinessResponse['autonomy'] {
  if (standing.policy === null) {
    return { active: false, stage: null, detail: standing.inactiveReason ?? 'No standing grant is active — autonomy is dark.' };
  }
  const { stageId, stageIndex, stageCount } = standing.policy.rollout;
  return { active: true, stage: stageId, detail: `Stage ${stageIndex + 1} of ${stageCount} · ${stageId}` };
}

/** PURE. One row per paid account (roster order), then Local, then Cloud. */
export function buildResourceReadiness(input: ReadinessInput): ResourceReadinessResponse {
  return {
    v: 1,
    checkedAt: new Date(input.nowMs).toISOString(),
    autonomy: autonomyLine(input.standing),
    capacitySnapshotAt: input.capacitySnapshotAt,
    resources: [
      ...input.accounts.map((account) => paidRow(account, input)),
      localRow(input),
      cloudRow(input),
    ],
  };
}

// ---------------------------------------------------------------------------
// Live gathering (node)
// ---------------------------------------------------------------------------

async function ollamaAnswers(baseUrl: string, timeoutMs = 1_500): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl}/api/version`, { signal: AbortSignal.timeout(timeoutMs) });
    await res.arrayBuffer().catch(() => undefined);
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Read every live source and build the response. Never throws for one missing
 * source: each degrades to the honest "unknown" its builder already words.
 */
export async function gatherResourceReadiness(cfg: AshlrConfig, nowMs: number = Date.now()): Promise<ResourceReadinessResponse> {
  const [seatsMod, accountsMod, healthMod, storeMod, authorityMod, leaderMod] = await Promise.all([
    import('../verse/seats.js'),
    import('../verse/accounts.js'),
    import('../verse/account-health.js'),
    import('./budget-store.js'),
    import('../authority/effective-config.js'),
    import('../vision/leader-apply.js'),
  ]);
  const accountsRoot = seatsMod.resolveAccountsRoot(cfg);

  // Seats + health: the health service's fused view when it runs (the same
  // one the engine's admission gate reads), else a fresh discovery.
  let seats: VerseSeat[] = [];
  let reports: SeatHealthReport[] | null = null;
  const health = healthMod.getVerseHealthService();
  try {
    if (health) {
      const current = health.current();
      seats = current.seats;
      reports = current.reports;
    } else {
      seats = (await seatsMod.discoverSeats(cfg)).seats;
    }
  } catch {
    seats = [];
  }

  let accounts: ReadinessAccount[] = [];
  try {
    accounts = accountsMod.buildVerseAccountsSnapshot({ accountsRoot, collector: accountsMod.getVerseAccountCollector() }).accounts;
  } catch {
    accounts = [];
  }

  let standing: ReadinessStanding = { policy: null, inactiveReason: 'Autonomy status could not be read.', noGrant: false, grant: null };
  try {
    const ev = authorityMod.evaluateStandingAuthority({ mode: 'cached', surface: authorityMod.displaySurfaceTarget(), nowMs });
    standing = {
      policy: ev.policy,
      inactiveReason: ev.policy ? null : ev.inactiveReason ?? ev.grantReason,
      noGrant: ev.grantState === 'none',
      grant: ev.grant
        ? {
          seats: ev.grant.spend.seats,
          engines: ev.grant.engines,
          stages: ev.grant.rollout.stages.map((stage) => ({ id: stage.id, engines: stage.engines })),
        }
        : null,
    };
  } catch {
    // Stays "could not be read" — the fleet itself fails closed the same way.
  }

  let budget: BudgetPolicy;
  try {
    budget = storeMod.loadBudgetPolicy();
  } catch {
    budget = (await import('./policy.js')).defaultBudgetPolicy();
  }

  let codexDirective = false;
  try {
    codexDirective = standing.policy?.engines.includes('codex') === true && leaderMod.readLeaderDirectives()?.codexEnabled === true;
  } catch {
    codexDirective = false;
  }

  let capacity: SeatCapacity[] | null = null;
  let capacitySnapshotAt: string | null = null;
  try {
    const snapshot = storeMod.readCapacitySnapshot();
    if (snapshot) {
      capacity = snapshot.seats;
      capacitySnapshotAt = snapshot.publishedAt;
    }
  } catch {
    capacity = null;
  }

  const baseUrl = seatsMod.resolveOllamaBaseUrl(cfg);
  const localReachable = seats.some((s) => s.engine === 'local') ? true : await ollamaAnswers(baseUrl);

  let cloud: ReadinessCloud | null = null;
  try {
    const { cloudOverview } = await import('../cloud/service.js');
    const overview = await cloudOverview();
    // The cloud lane launches through the `claude-a` native profile. When an
    // account in the roster uses that same profile, its live sign-in state is
    // the cloud seat's too — the one thing `cloudSeatStatus` deliberately
    // does not check (it costs a process).
    let signedOutSeatId: string | null = null;
    try {
      const native = healthMod.readNativeAccounts(accountsRoot);
      const sharing = native.find((a) => a.provider === 'claude' && a.command.some((arg) => /[\\/]native-profiles[\\/]claude-a[\\/]/.test(arg)));
      const record = sharing ? accounts.find((a) => a.id === sharing.id) : undefined;
      if (record?.state === 'signed-out') signedOutSeatId = record.id;
    } catch {
      signedOutSeatId = null;
    }
    const si = overview.budget.budget.selfImprove;
    cloud = {
      seatReady: overview.seat.ready,
      seatReason: overview.seat.reason,
      signedOutSeatId,
      canLaunch: overview.budget.canLaunch,
      canSelfImprove: overview.budget.canSelfImprove,
      selfImprove: { enabled: si.enabled, maxPerDay: si.maxPerDay, reserveUsd: si.reserveUsd },
      remainingUsd: overview.budget.estimatedRemainingUsd,
      totalUsd: overview.budget.creditsTotalUsd,
    };
  } catch {
    cloud = null;
  }

  return buildResourceReadiness({
    nowMs,
    seats,
    reports,
    accounts,
    capacity,
    capacitySnapshotAt,
    standing,
    budget,
    codexDirective,
    local: { reachable: localReachable, baseUrl },
    cloud,
  });
}
