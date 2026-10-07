/**
 * Devin lane orchestration (3.15): connection status, connect / disconnect,
 * launch, overview, messages. The ONLY entry point other code uses to start a
 * Devin session.
 *
 * Launch order: validate → enabled + connected → (fleet: opt-in + standing
 * grant + reserve) → budget gate → persist `queued` → create the session with
 * a hard max_acu_limit → persist `running` (or `failed` with a plain reason).
 * The gate check and the `queued` write happen in one synchronous stretch, so
 * two launches racing in this process cannot both pass a gate with room for
 * one.
 *
 * The v3 API has no idempotency key, so a create whose outcome is unknown (the
 * connection dropped after sending) is never retried blind: the service looks
 * for a session carrying this task's tag and adopts it, and otherwise records
 * a failure whose spend counts the full cap until the operator checks
 * app.devin.ai (budget.ts, fail closed).
 */
import { clampBudgetPolicy, currentStandingPolicy, currentStandingPolicyReadiness, standingAuthorizesDevin, type StandingPolicyReadiness } from '../authority/effective-config.js';
import type { EffectivePolicy } from '../authority/types.js';
import { isSafeBranchName } from '../cloud/checkout.js';
import { CLOUD_REPO_PATTERN } from '../cloud/store.js';
import { defaultCloudGh } from '../cloud/tracker.js';
import { loadConfigReadOnly, saveConfig, loadConfig } from '../config.js';
import { repoPolicyFor } from '../fleet/merge-gates.js';
import type { FleetReadinessVerdict, ReadinessFix, ReadinessVerdict } from '../routing/readiness-types.js';
import { loadBudgetPolicy } from '../routing/budget-store.js';
import { DEVIN_SEAT_ID, effectiveSeatPolicy } from '../routing/policy.js';
import { killSwitchOn } from '../sandbox/policy.js';
import type { AshlrConfig } from '../types.js';
import { acquireLocalStoreLock, releaseLocalStoreLock } from '../fleet/local-store-lock.js';
import { join } from 'node:path';
import { scrubSecrets } from '../util/scrub.js';
import { devinBudgetView, DEVIN_ACCOUNTING_UNAVAILABLE } from './budget.js';
import { devinTaskDiagnostics } from './create-recovery.js';
import { stateFromSession } from './session-state.js';
import { DevinApiError, DevinClient, devinFailureSentence, type DevinFetch, type DevinSession } from './client.js';
import { buildDevinPrompt, DEVIN_REPORT_SCHEMA } from './delivery-contract.js';
import { playbookForLaunch } from '../playbooks/lanes.js';
import { probeDevinCli, type DevinCliProbe } from './cli-probe.js';
import { buildDevinChatPrompt } from './chat-contract.js';
import { getDevinModelCatalog, summarizeDevinModels, type DevinModelCatalog } from './models.js';
import { hasDevinKey, readDevinKey, removeDevinKey, storeDevinKey, type DevinKeyStoreDeps } from './secret.js';
import { DevinConsumptionCache, type DevinConsumptionSnapshot } from './consumption.js';
import {
  clearDevinConnection,
  devinHome, ensureDevinDirectory, devinConsumptionConnectionUnconfirmed, writeDevinConsumptionConnectionState,
  readDevinTaskInventory,
  newDevinTaskId,
  readDevinBudget,
  readDevinConnection,
  readDevinTask,
  writeDevinConnection,
  writeDevinTask,
} from './store.js';
import {
  DEVIN_BRANCH_PREFIX,
  DEVIN_ORG_ID_PATTERN,
  DEVIN_PR_TITLE_PREFIX,
  DEVIN_PROMPT_MAX_CHARS,
  DEVIN_SESSION_TAG,
  DEVIN_TASK_SCHEMA_VERSION,
  type DevinFailureCode,
  type DevinGate,
  type DevinLaunchRequest,
  type DevinLaunchResponse,
  type DevinOverviewResponse,
  type DevinSessionSnapshot,
  type DevinStatus,
  type DevinTaskOrigin,
  type DevinTaskV1,
} from './types.js';

export type DevinMode = NonNullable<NonNullable<AshlrConfig['devin']>['mode']>;
const DEVIN_MODES: readonly DevinMode[] = ['normal', 'fast', 'lite', 'ultra'];

export interface DevinServiceDeps {
  keyStore?: DevinKeyStoreDeps;
  fetch?: DevinFetch;
  baseUrl?: string;
  /** Backoff sleeper for the client (tests pass a no-op). */
  sleep?: (ms: number) => Promise<void>;
  gh?: (args: string[]) => Promise<{ ok: boolean; stdout: string; stderr: string }>;
  now?: () => Date;
  /** The `devin` config section (default: read ~/.ashlr/config.json, read-only). */
  config?: () => AshlrConfig['devin'] | undefined;
  /** The live standing policy (default: currentStandingPolicy). */
  policy?: () => EffectivePolicy | null;
  /** Fleet Stop, re-read before each create attempt; manual use does not require standing authority. */
  killActive?: () => boolean;
  /** Display diagnostics for an injected policy; never used to authorize a launch. */
  policyReadiness?: () => Pick<StandingPolicyReadiness, 'grantState' | 'reason'>;
  /** The local CLI's state for the overview (tests; default: the shared cli-probe). */
  cliProbe?: () => Promise<Pick<DevinCliProbe, 'state'> & { cliPath?: string | null }>;
  /** The CLI's model catalog for the overview (tests; default: models.ts, never listing on the request). */
  modelCatalog?: () => Promise<DevinModelCatalog>;
}

/** Internal launches from the fleet carry their work item. */
export type DevinInternalLaunch = Omit<DevinLaunchRequest, 'origin'> & { origin: 'fleet'; backlogItemId?: string | null };
/**
 * 3.15: the first message of a Verse chat on the Devin seat. Same gates, same
 * budget (the operator's gate, never the fleet's), same task record — but the
 * chat contract (chat-contract.ts) instead of the task contract, and no
 * structured report: a chat may end without any pull request.
 */
export type DevinChatLaunch = Omit<DevinLaunchRequest, 'origin'> & { origin: 'chat'; contract: 'chat'; verseSessionId: string; planOnly?: boolean };

export const DEVIN_TITLE_MAX_CHARS = 80;
const OVERVIEW_TASK_LIMIT = 100;
const FALLBACK_BASE_BRANCH = 'main';
const REF_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
/** A session found by tag after an ambiguous create must have been created this recently. */
const RECOVERY_LIST_SIZE = 50;

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

function readConfig(deps: DevinServiceDeps): AshlrConfig['devin'] | undefined {
  try {
    return (deps.config ?? (() => loadConfigReadOnly().devin))();
  } catch {
    return undefined;
  }
}

export function devinEnabled(section: AshlrConfig['devin'] | undefined): boolean {
  return section?.enabled === true;
}

export function devinFleetOptIn(section: AshlrConfig['devin'] | undefined): boolean {
  return section?.fleet === true;
}

export function devinModeOf(section: AshlrConfig['devin'] | undefined): DevinMode {
  const mode = section?.mode;
  return typeof mode === 'string' && (DEVIN_MODES as readonly string[]).includes(mode) ? mode : 'normal';
}

/** Persist a change to the `devin` config section (CLI only — the web never writes config). */
export function updateDevinConfig(patch: Partial<NonNullable<AshlrConfig['devin']>>): NonNullable<AshlrConfig['devin']> {
  const cfg = loadConfig();
  const next = { ...(cfg.devin ?? {}), ...patch };
  saveConfig({ ...cfg, devin: next });
  return next;
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

/** Presence of the Keychain item, cached briefly: every overview poll would otherwise spawn `security`. */
let keyPresence: { at: number; present: boolean } | null = null;
const KEY_PRESENCE_TTL_MS = 60_000;
/** The last auth failure the API reported (401/403), so the card says "reconnect" instead of "ready". */
let lastAuthFailure: { at: number; code: DevinFailureCode } | null = null;

export function resetDevinStatusCacheForTest(): void {
  keyPresence = null;
  lastAuthFailure = null;
}

function noteApiFailure(error: unknown): void {
  if (error instanceof DevinApiError && (error.code === 'auth' || error.code === 'forbidden')) {
    lastAuthFailure = { at: Date.now(), code: error.code };
  }
}

function noteApiSuccess(): void {
  lastAuthFailure = null;
}

async function keyPresent(deps: DevinServiceDeps): Promise<boolean> {
  if (keyPresence && Date.now() - keyPresence.at < KEY_PRESENCE_TTL_MS) return keyPresence.present;
  const present = await hasDevinKey(deps.keyStore);
  keyPresence = { at: Date.now(), present };
  return present;
}

const commandFix = (label: string, command: string): ReadinessFix => ({ kind: 'command', label, command });

/**
 * 3.15: Devin is a chat seat ("Devin (cloud)" in New chat) when the lane is on
 * and connected. New sessions also need the existing operator budget gate;
 * this verdict does not govern continuation of an existing Devin session.
 */
export function devinChatVerdict(state: DevinStatus['state'], newSessionGate?: DevinGate): ReadinessVerdict {
  if (state === 'ready') {
    if (newSessionGate && !newSessionGate.ok) {
      return { ready: false, tone: 'warn', word: 'New chats paused', detail: newSessionGate.reason ?? 'The Devin budget refused another session.', fix: null } as ReadinessVerdict;
    }
    return { ready: true, tone: 'ok', word: 'Ready', detail: 'Pick “Devin (cloud)” in New chat. Each chat is one Devin session.', fix: null } as ReadinessVerdict;
  }
  if (state === 'unreachable') {
    return { ready: false, tone: 'blocked', word: 'Key refused', detail: 'Devin refused the key; reconnect to chat with it.', fix: commandFix('Reconnect Devin', 'ashlr devin connect') } as ReadinessVerdict;
  }
  return state === 'disabled'
    ? { ready: false, tone: 'off', word: 'Off', detail: 'Turn the Devin lane on to chat with Devin.', fix: commandFix('Turn on the Devin lane', 'ashlr devin enable') } as ReadinessVerdict
    : { ready: false, tone: 'off', word: 'Off', detail: 'Connect Devin to chat with it.', fix: commandFix('Connect Devin', 'ashlr devin connect') } as ReadinessVerdict;
}

/** @deprecated 3.15 — kept for importers; the live answer is `devinChatVerdict(state)`. */
export const DEVIN_CHAT_VERDICT: ReadinessVerdict = Object.freeze(devinChatVerdict('not-connected'));

/**
 * The fleet verdict: why the fleet may or may not launch Devin sessions now.
 * Ready needs the lane on, a key, Mason's opt-in, a live standing grant whose
 * current stage names the `devin` engine with a producer-only Devin seat
 * (3.15 — its own engine identity; see authority/effective-config.ts
 * standingAuthorizesDevin) and the budget's reserve and fleet caps. Devin PRs
 * then merge only under the two-judge rule (merge-gates.ts G6) — or, 3.15,
 * on green tests alone when Devin ran an elite model (SWE-2, GPT-6) under an
 * elite-direct grant (authority/elite-models.ts).
 */
export function devinFleetVerdict(input: {
  enabled: boolean;
  connected: boolean;
  optIn: boolean;
  policy: EffectivePolicy | null;
  authority?: Pick<StandingPolicyReadiness, 'grantState' | 'reason'> | null;
  fleetGate: { ok: boolean; reason: string | null };
}): FleetReadinessVerdict {
  const v = (ready: boolean, tone: ReadinessVerdict['tone'], word: string, detail: string, fix: ReadinessFix | null = null): FleetReadinessVerdict =>
    ({ ready, tone, word, detail, fix, roles: ready ? ['producer'] : [], reservePercent: null });
  if (!input.connected) return v(false, 'off', 'Off', 'Connect Devin first.', commandFix('Connect Devin', 'ashlr devin connect'));
  if (!input.enabled) return v(false, 'off', 'Off', 'The Devin lane is turned off.', commandFix('Turn on the Devin lane', 'ashlr devin enable'));
  if (!input.optIn) {
    return v(false, 'off', 'Off', 'The fleet may not launch Devin sessions; you can still run them yourself.', commandFix('Let the fleet use Devin', 'ashlr devin fleet on'));
  }
  if (!input.policy) {
    if (input.authority?.grantState === 'none') return v(false, 'warn', 'Waiting', 'No standing grant is installed.');
    return v(false, 'warn', 'Waiting', input.authority?.reason
      ? `The effective standing policy is held: ${input.authority.reason}`
      : 'The effective standing policy is unavailable; grant readiness is unconfirmed.');
  }
  const granted = standingAuthorizesDevin(input.policy);
  if (!granted.ok) {
    return v(false, 'warn', 'Not in the grant', `${granted.reason} Draft a new grant (or re-approve) with the Devin fleet opt-in on.`,
      commandFix('Draft a grant that includes Devin', 'ashlr authority draft'));
  }
  if (!input.fleetGate.ok) return v(false, 'warn', 'Paused', input.fleetGate.reason ?? 'The Devin budget refused another fleet session.');
  return v(true, 'ok', 'Ready', 'The fleet may launch Devin on well-scoped backlog work. Its PRs pass every standing gate; on an elite model (SWE-2, GPT-6) under an elite-direct grant they land on green tests, otherwise they merge only when two judges from different families ship them.');
}

/** "Fleet: Ready — …" for the CLI. */
export function devinFleetLine(verdict: FleetReadinessVerdict): string {
  return verdict.detail ? `Fleet: ${verdict.word} — ${verdict.detail}` : `Fleet: ${verdict.word}`;
}

function safePolicy(deps: DevinServiceDeps): EffectivePolicy | null {
  try {
    return (deps.policy ?? currentStandingPolicy)();
  } catch {
    return null;
  }
}

export async function devinStatus(deps: DevinServiceDeps = {}, tasks?: readonly DevinTaskV1[], sourceState?: import('./types.js').DevinTaskSourceState): Promise<DevinStatus> {
  const inventory = tasks === undefined ? readDevinTaskInventory() : { tasks, sourceState: sourceState ?? 'ready' };
  const section = readConfig(deps);
  const enabled = devinEnabled(section);
  const connection = readDevinConnection();
  const present = connection ? await keyPresent(deps) : false;
  const connected = connection !== null && present;
  const view = devinBudgetView(inventory.tasks, readDevinBudget(), (deps.now ?? (() => new Date()))(), inventory.sourceState);
  let readiness: StandingPolicyReadiness = { policy: null, grantState: null, reason: null };
  if (enabled && connected && devinFleetOptIn(section)) {
    if (deps.policy) {
      readiness.policy = safePolicy(deps);
      try {
        const diagnostic = deps.policyReadiness?.();
        readiness.grantState = diagnostic?.grantState ?? null;
        readiness.reason = diagnostic?.reason ?? null;
      } catch { /* Unknown display evidence stays unknown. */ }
    } else {
      readiness = currentStandingPolicyReadiness();
    }
  }
  const fleet = devinFleetVerdict({ enabled, connected, optIn: devinFleetOptIn(section), policy: readiness.policy, authority: readiness, fleetGate: view.canFleetLaunch });
  let state: DevinStatus['state'] = 'ready';
  let reason = 'Connected. Devin sessions deliver pull requests through the standing gates.';
  if (!enabled) {
    state = 'disabled';
    reason = connected ? 'Connected, but the Devin lane is turned off (`ashlr devin enable`).' : 'Not set up. Run `ashlr devin connect` to add your Devin API key.';
  } else if (!connected) {
    state = 'not-connected';
    reason = connection ? 'The Devin key is missing from the Keychain. Run `ashlr devin connect` again.' : 'No Devin API key yet. Run `ashlr devin connect`.';
  } else if (lastAuthFailure) {
    state = 'unreachable';
    reason = devinFailureSentence(lastAuthFailure.code);
  }
  const chat = devinChatVerdict(state, view.canLaunch);
  return {
    enabled,
    connected,
    state,
    reason,
    orgId: connection?.orgId ?? null,
    principal: connection?.principal ?? null,
    principalName: connection?.principalName ?? null,
    keyStore: connection?.keyStore ?? null,
    ...(connection?.selfIdentity ? { selfIdentity: {
      source: connection.selfIdentity.source, observedAt: connection.selfIdentity.observedAt,
      principal: connection.selfIdentity.principal,
      hasServiceUserId: connection.selfIdentity.serviceUserId !== null,
      hasUserId: connection.selfIdentity.userId !== null,
      hasApiKeyId: connection.selfIdentity.apiKeyId !== null,
      hasOrgId: connection.selfIdentity.orgId !== null,
      hasDevinSessionsOrgId: connection.selfIdentity.devinSessionsOrgId !== null,
    } } : {}),
    chatLine: state === 'ready'
      ? chat.ready ? 'Chat: ready — pick “Devin (cloud)” in New chat' : `Chat: new sessions paused — ${chat.detail}`
      : `Chat: off — ${chat.detail}`,
    fleetLine: devinFleetLine(fleet),
    fleetReady: fleet.ready && state === 'ready',
    chat,
    fleet: state === 'unreachable' ? { ...fleet, ready: false, tone: 'blocked', word: 'Key refused', detail: reason, fix: commandFix('Reconnect Devin', 'ashlr devin connect'), roles: [] } : fleet,
  };
}

// ---------------------------------------------------------------------------
// Connect / disconnect (CLI)
// ---------------------------------------------------------------------------

export interface DevinConnectResult {
  orgId: string;
  principal: 'service_user' | 'pat_user' | 'other';
  principalName: string | null;
}

/**
 * Verify the key against GET /v3/self BEFORE storing it, pick the org id (the
 * API's for PATs / enterprise users, else the one given), store the key in the
 * Keychain, record the non-secret connection, and turn the lane on.
 */
export async function connectDevin(input: { key: string; orgId?: string | null }, deps: DevinServiceDeps = {}): Promise<DevinConnectResult> {
  const key = typeof input.key === 'string' ? input.key.trim() : '';
  const client = new DevinClient({ apiKey: key, ...clientOptions(deps) });
  const self = await client.getSelf();
  const given = typeof input.orgId === 'string' && input.orgId.trim() !== '' ? input.orgId.trim() : null;
  if (given !== null && !DEVIN_ORG_ID_PATTERN.test(given)) throw new DevinApiError('invalid-request', 'The organization id must look like org-… (Settings > Devin API).');
  if (given && self.orgId && given !== self.orgId) {
    throw new DevinApiError('invalid-request', `This key belongs to ${self.orgId}, not ${given}.`);
  }
  const orgId = given ?? self.orgId;
  if (!orgId) {
    throw new DevinApiError('invalid-request', 'Devin did not say which organization this key belongs to. Pass it with --org org-… (shown at the top of Settings > Devin API).');
  }
  // One read of an org-scoped route proves the key works in that org before anything is stored.
  await client.listSessions(orgId, { first: 1 });
  return consumptionConnectionTransition(async () => {
    await storeDevinKey(key, deps.keyStore);
    const now = (deps.now ?? (() => new Date()))().toISOString();
    writeDevinConnection({ orgId, principal: self.principal, principalName: self.name, keyStore: 'keychain', connectedAt: now,
      ...(self.identity ? { selfIdentity: { ...self.identity, source: 'devin-v3-self', observedAt: now } } : {}) });
    keyPresence = null;
    noteApiSuccess();
    return { orgId, principal: self.principal, principalName: self.name };
  });
}

export async function disconnectDevin(deps: DevinServiceDeps = {}): Promise<{ removedKey: boolean }> {
  return consumptionConnectionTransition(async () => {
    const removedKey = await removeDevinKey(deps.keyStore);
    clearDevinConnection();
    if (readDevinConnection() !== null) throw new Error('The Devin connection removal could not be confirmed.');
    keyPresence = null;
    lastAuthFailure = null;
    return { removedKey };
  });
}

function clientOptions(deps: DevinServiceDeps): { fetch?: DevinFetch; baseUrl?: string; sleep?: (ms: number) => Promise<void> } {
  return {
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
    ...(deps.baseUrl ? { baseUrl: deps.baseUrl } : {}),
    ...(deps.sleep ? { sleep: deps.sleep } : {}),
  };
}

/** A client with the stored key and the recorded org, or why there is none. */
export async function connectedClient(deps: DevinServiceDeps = {}): Promise<{ client: DevinClient; orgId: string } | { error: string; failure: DevinFailureCode }> {
  const connection = readDevinConnection();
  if (!connection) return { error: devinFailureSentence('not-connected'), failure: 'not-connected' };
  const key = await readDevinKey(deps.keyStore);
  if (!key) return { error: 'The Devin key is missing from the Keychain. Run `ashlr devin connect` again.', failure: 'not-connected' };
  return { client: new DevinClient({ apiKey: key, ...clientOptions(deps) }), orgId: connection.orgId };
}

const consumptionCache = new DevinConsumptionCache();
let consumptionConnectionTransitions = 0;

/** The old recorded organization must never be paired with a replacement Keychain key. */
async function consumptionConnectionTransition<T>(run: () => Promise<T>): Promise<T> {
  ensureDevinDirectory();
  const lock = acquireLocalStoreLock(join(devinHome(), '.consumption-connection.lock'), 0);
  if (!lock) throw new Error('A Devin connection change is already in progress or its private lock is unavailable.');
  consumptionConnectionTransitions += 1;
  consumptionCache.reset();
  try {
    writeDevinConsumptionConnectionState('pending');
    const result = await run();
    writeDevinConsumptionConnectionState('settled');
    return result;
  } finally {
    // Failure leaves the durable pending marker intact, including after a reader restart.
    consumptionConnectionTransitions -= 1;
    consumptionCache.reset();
    releaseLocalStoreLock(lock);
  }
}

function consumptionIdentity(): string | null {
  if (consumptionConnectionTransitions > 0 || devinConsumptionConnectionUnconfirmed()) return null;
  const connection = readDevinConnection();
  return connection ? JSON.stringify([connection.orgId, connection.principal, connection.principalName, connection.connectedAt]) : null;
}

/** Cache-only: neither provider nor Keychain reads occur on this projection. */
export function peekDevinConsumption(now: Date = new Date()): DevinConsumptionSnapshot {
  const snapshot = consumptionCache.peek(consumptionIdentity(), now);
  return devinConsumptionConnectionUnconfirmed() ? { ...snapshot, state: 'unavailable', error: {
    code: 'not-connected', reason: 'The cloud connection change is unconfirmed. Reconnect Devin before reading organization consumption.',
  } } : snapshot;
}

export function resetDevinConsumptionForTest(): void { consumptionCache.reset(); }

/** A metadata read, separately permission-qualified; failures never change session readiness. */
export function refreshDevinConsumption(deps: DevinServiceDeps = {}, force = false): Promise<DevinConsumptionSnapshot> {
  if (devinConsumptionConnectionUnconfirmed()) return Promise.resolve(peekDevinConsumption((deps.now ?? (() => new Date()))()));
  return consumptionCache.refresh({
    identity: consumptionIdentity, now: deps.now, force,
    read: async (stillCurrent) => {
      const connected = await connectedClient(deps);
      if (!stillCurrent()) throw new DevinApiError('not-connected', 'The cloud connection changed before the metadata read.');
      if ('error' in connected) throw new DevinApiError(connected.failure, connected.error);
      return connected.client.getDailyConsumption(connected.orgId, stillCurrent);
    },
  });
}

// ---------------------------------------------------------------------------
// Launch
// ---------------------------------------------------------------------------

export function deriveDevinTitle(text: string): string {
  const line = (text.split(/\r?\n/).find((l) => l.trim() !== '') ?? '').replace(/\s+/g, ' ').trim();
  if (line.length <= DEVIN_TITLE_MAX_CHARS) return line;
  const room = line.slice(0, DEVIN_TITLE_MAX_CHARS - 1);
  const space = room.lastIndexOf(' ');
  return `${(space >= DEVIN_TITLE_MAX_CHARS / 2 ? room.slice(0, space) : room).trimEnd()}…`;
}

const refusal = (error: string, failure: DevinFailureCode | null = null): DevinLaunchResponse => ({ ok: false, task: null, error, failure });

async function defaultBranchOf(repo: string, deps: DevinServiceDeps): Promise<string | null> {
  try {
    const res = await (deps.gh ?? defaultCloudGh)(['repo', 'view', repo, '--json', 'defaultBranchRef', '--jq', '.defaultBranchRef.name']);
    const name = res.ok ? res.stdout.trim() : '';
    return isSafeBranchName(name) ? name : null;
  } catch {
    return null;
  }
}

export function devinSessionTaskTag(taskId: string): string {
  return `ashlr-task-${taskId}`;
}

export function snapshotOf(session: DevinSession, now: Date): DevinSessionSnapshot {
  return {
    status: session.status,
    statusDetail: session.statusDetail,
    acusConsumed: session.acusConsumed,
    prUrls: session.pullRequests.map((pr) => pr.url).slice(0, 10),
    readAt: now.toISOString(),
  };
}

const ORIGINS: readonly DevinTaskOrigin[] = ['chat', 'operator', 'cli', 'fleet'];

export async function launchDevinTask(req: DevinLaunchRequest | DevinInternalLaunch | DevinChatLaunch, deps: DevinServiceDeps = {}): Promise<DevinLaunchResponse> {
  const clock = deps.now ?? (() => new Date());

  // --- validate ---------------------------------------------------------
  if (!req || typeof req !== 'object') return refusal('The launch request is empty.');
  const repo = typeof req.repo === 'string' ? req.repo.trim() : '';
  if (!CLOUD_REPO_PATTERN.test(repo)) return refusal('The repo must look like owner/name, for example ashlrai/ashlr-hub.');
  if (!ORIGINS.includes(req.origin)) return refusal('The launch came from an unknown place.');
  const origin = req.origin;
  const rawPrompt = typeof req.prompt === 'string' ? req.prompt.replace(/\0/g, '').trim() : '';
  if (rawPrompt === '') return refusal('Describe the task before launching it.');
  const prompt = rawPrompt.slice(0, DEVIN_PROMPT_MAX_CHARS);
  const givenTitle = typeof req.title === 'string' ? req.title.trim() : '';
  const title = deriveDevinTitle(givenTitle !== '' ? givenTitle : prompt);
  const givenBase = typeof req.baseBranch === 'string' ? req.baseBranch.trim() : '';
  if (givenBase !== '' && !isSafeBranchName(givenBase)) return refusal(`"${givenBase.slice(0, 80)}" isn't a branch name the Devin lane accepts.`);
  const internal = req as Partial<DevinInternalLaunch>;
  const chatLaunch = origin === 'chat' && (req as Partial<DevinChatLaunch>).contract === 'chat';
  const planOnly = chatLaunch && (req as Partial<DevinChatLaunch>).planOnly === true;
  const backlogItemId = typeof internal.backlogItemId === 'string' && REF_ID_RE.test(internal.backlogItemId) ? internal.backlogItemId : null;

  // --- lane gates (no network) --------------------------------------------
  const section = readConfig(deps);
  if (!devinEnabled(section)) return refusal(devinFailureSentence('not-enabled') + ' Turn it on with `ashlr devin enable`.', 'not-enabled');
  const connection = readDevinConnection();
  if (!connection) return refusal(devinFailureSentence('not-connected'), 'not-connected');
  const connectionIdentity = consumptionIdentity();
  if (connectionIdentity === null) return refusal('The Devin connection change is not confirmed, so nothing was launched.', 'not-connected');
  if (origin === 'fleet') {
    if (!devinFleetOptIn(section)) return refusal('The fleet may not launch Devin sessions (`ashlr devin fleet on`).', 'not-enabled');
    const policy = safePolicy(deps);
    if (!policy) return refusal('No standing grant is in force, so the fleet may not launch Devin sessions.', 'not-enabled');
    if (!repoPolicyFor(policy, repo)) return refusal(`${repo} is not in the standing grant.`, 'not-enabled');
    // 3.15: Devin's own engine identity — the grant must name `devin` in its
    // current stage AND give the Devin seat the producer role. A grant that
    // authorizes Claude (or anything else) never authorizes Devin.
    const granted = standingAuthorizesDevin(policy);
    if (!granted.ok) return refusal(granted.reason, 'not-enabled');
  }
  const connected = await connectedClient(deps);
  if ('error' in connected) return refusal(connected.error, connected.failure);
  const baseBranch = givenBase !== '' ? givenBase : (await defaultBranchOf(repo, deps)) ?? FALLBACK_BASE_BRANCH;
  // 3.15: the playbook (named, `!macro` in the text, or auto-matched). A named one that does not exist refuses.
  const resolvedPlaybook = await playbookForLaunch({ explicit: req.playbook, title, prompt, repo });
  if (!resolvedPlaybook.ok) return refusal(resolvedPlaybook.error);
  // A chat is a conversation: it runs a playbook only when the operator typed
  // its `!macro` (or named one) — never one auto-matched from the wording.
  const playbook = chatLaunch && resolvedPlaybook.match === 'auto'
    ? { ...resolvedPlaybook, ref: null, match: null, block: '' }
    : resolvedPlaybook;

  // --- budget gate + persist queued (no await between them) ----------------
  const now = clock();
  const budget = readDevinBudget();
  const inventory = readDevinTaskInventory();
  if (inventory.sourceState === 'unavailable') return refusal(DEVIN_ACCOUNTING_UNAVAILABLE, 'budget');
  // Missing first-use storage can create a queued record, never contact Devin yet.
  const view = devinBudgetView(inventory.tasks, budget, now);
  const verdict = origin === 'fleet' ? view.canFleetLaunch : view.canLaunch;
  if (!verdict.ok) return refusal(verdict.reason ?? 'The Devin budget refused this launch.', 'budget');
  const id = newDevinTaskId(now);
  const createdAt = now.toISOString();
  const task: DevinTaskV1 = {
    v: DEVIN_TASK_SCHEMA_VERSION,
    id,
    repo,
    baseBranch,
    branch: `${DEVIN_BRANCH_PREFIX}${id}`,
    title,
    prompt,
    origin,
    requestedBy: origin === 'fleet' ? 'fleet' : 'mason',
    sessionId: null,
    launchOrgId: connected.orgId,
    sessionUrl: null,
    state: 'queued',
    stateReason: 'Starting a Devin session.',
    failure: null,
    createdAt,
    launchedAt: null,
    updatedAt: createdAt,
    session: null,
    maxAcu: budget.maxAcuPerSession,
    devinMode: devinModeOf(section),
    pr: null,
    headSha: null,
    report: null,
    backlogItemId,
    ...(playbook.ref ? { playbookRef: playbook.ref } : {}),
    ...(chatLaunch && typeof (req as DevinChatLaunch).verseSessionId === 'string' ? { verseSessionId: (req as DevinChatLaunch).verseSessionId } : {}),
  };
  try {
    writeDevinTask(task);
  } catch {
    return refusal("Couldn't save the Devin task, so it wasn't launched.", 'unknown');
  }
  let ownedTaskRecord = JSON.stringify(task);

  const fail = (failure: DevinFailureCode, reason: string): DevinLaunchResponse => {
    // An operator or another process may have changed the row during a 429 wait.
    // A refused stale launch must not resurrect or overwrite that actor's state.
    const current = readDevinTask(id);
    if (!current || JSON.stringify(current) !== ownedTaskRecord) return { ok: false, task: current, error: reason, failure };
    Object.assign(task, { state: 'failed', failure, stateReason: reason });
    try { writeDevinTask(task); } catch { /* the response still carries the failure */ }
    return { ok: false, task, error: reason, failure };
  };
  const adopt = (session: DevinSession): DevinLaunchResponse => {
    const mapped = stateFromSession(task, session);
    Object.assign(task, {
      state: mapped?.state ?? task.state,
      sessionId: session.sessionId,
      sessionUrl: session.url,
      launchedAt: clock().toISOString(),
      session: snapshotOf(session, clock()),
      stateReason: mapped?.reason ?? 'Devin created the session; its work state is unconfirmed.',
      failure: mapped?.failure ?? null,
    });
    writeDevinTask(task);
    return { ok: true, task, error: null, failure: null };
  };

  const { client, orgId } = connected;
  const tag = devinSessionTaskTag(id);
  const beforeContact = (): void => {
    const sectionNow = readConfig(deps);
    if (!devinEnabled(sectionNow)) throw new DevinApiError('not-enabled', 'The Devin lane was turned off before launch.');
    if (consumptionIdentity() !== connectionIdentity || orgId !== connection.orgId) {
      throw new DevinApiError('not-connected', 'The Devin connection changed before launch. Recheck it before trying again.');
    }
    const current = readDevinTask(id);
    if (!current || JSON.stringify(current) !== ownedTaskRecord || current.state !== 'launching' || current.sessionId !== null) {
      throw new DevinApiError('not-enabled', 'This Devin task changed before launch, so the stale create was refused.');
    }
    if (origin === 'fleet') {
      if ((deps.killActive ?? killSwitchOn)()) throw new DevinApiError('not-enabled', 'Stop is on, so the fleet launches nothing.');
      if (!devinFleetOptIn(sectionNow)) throw new DevinApiError('not-enabled', 'The Devin fleet opt-in was turned off before launch.');
      const policy = safePolicy(deps);
      if (!policy || !repoPolicyFor(policy, repo)) throw new DevinApiError('not-enabled', 'The current standing grant no longer authorizes this Devin repo.');
      const granted = standingAuthorizesDevin(policy);
      if (!granted.ok) throw new DevinApiError('not-enabled', granted.reason);
      const clamped = clampBudgetPolicy(loadBudgetPolicy(), policy, [DEVIN_SEAT_ID]);
      if (!effectiveSeatPolicy(clamped, DEVIN_SEAT_ID, 'devin').enabled) throw new DevinApiError('budget', 'The current budget policy keeps autonomy off Devin.');
    }
    const budgetNow = readDevinBudget();
    if (task.maxAcu > budgetNow.maxAcuPerSession) throw new DevinApiError('budget', 'The Devin session cap was lowered before launch.');
    // Check the actual outgoing cap against current limits, excluding exactly
    // this unchanged reservation. Every other task and unknown hold still counts.
    const inventoryNow = readDevinTaskInventory();
    if (inventoryNow.sourceState !== 'ready' || !inventoryNow.tasks.some(row => row.id === id && JSON.stringify(row) === ownedTaskRecord)) {
      throw new DevinApiError('budget', DEVIN_ACCOUNTING_UNAVAILABLE);
    }
    const viewNow = devinBudgetView(inventoryNow.tasks.filter(row => row.id !== id),
      { ...budgetNow, maxAcuPerSession: task.maxAcu }, clock());
    const verdictNow = origin === 'fleet' ? viewNow.canFleetLaunch : viewNow.canLaunch;
    if (!verdictNow.ok) throw new DevinApiError('budget', verdictNow.reason ?? 'The current Devin budget refused this launch.');
  };
  try {
    Object.assign(task, { state: 'launching' });
    writeDevinTask(task);
    ownedTaskRecord = JSON.stringify(task);
    const session = await client.createSession(orgId, {
      prompt: chatLaunch ? buildDevinChatPrompt(task, { planOnly, playbook: playbook.block }) : buildDevinPrompt(task, playbook.block),
      title: `${DEVIN_PR_TITLE_PREFIX} ${title}`,
      repos: [repo],
      tags: [DEVIN_SESSION_TAG, tag],
      maxAcuLimit: task.maxAcu,
      ...(chatLaunch ? {} : {
        structuredOutputSchema: DEVIN_REPORT_SCHEMA as Record<string, unknown>,
        structuredOutputRequired: false,
      }),
      devinMode: task.devinMode,
    }, beforeContact);
    noteApiSuccess();
    return adopt(session);
  } catch (error) {
    noteApiFailure(error);
    const code: DevinFailureCode = error instanceof DevinApiError ? error.code : 'unknown';
    if (code === 'network' || code === 'unparsed') {
      // Ambiguous: the session may exist. Look for this task's tag before giving up.
      try {
        const page = await client.listSessions(orgId, { first: RECOVERY_LIST_SIZE });
        const found = page.items.find((s) => s.tags.includes(tag));
        if (found) return adopt(found);
      } catch { /* fall through to the recorded failure */ }
      return fail(code, 'Devin may or may not have started this session — the connection dropped before it answered. Check app.devin.ai; until then its full ACU cap counts against the budget.');
    }
    const message = error instanceof DevinApiError ? error.message : devinFailureSentence('unknown');
    return fail(code, scrubSecrets(message).slice(0, 400));
  }
}

// ---------------------------------------------------------------------------
// Overview / messages
// ---------------------------------------------------------------------------

/** Cheap: reads disk (+ a cached Keychain presence check). No Devin API call. */
export async function devinOverview(deps: DevinServiceDeps = {}): Promise<DevinOverviewResponse> {
  const now = (deps.now ?? (() => new Date()))();
  // Admission uses every tracked session; only the response history is bounded.
  const inventory = readDevinTaskInventory();
  const tasks = inventory.tasks;
  const probe: Pick<DevinCliProbe, 'state'> & { cliPath?: string | null } = await (deps.cliProbe ?? (() => probeDevinCli()))();
  let models: DevinOverviewResponse['models'];
  if (probe.state !== 'missing') {
    try {
      // At once: memory / disk / the SWE-2 fallback; a due listing runs in the background.
      const catalog = await (deps.modelCatalog ?? (() => getDevinModelCatalog({ cliPath: probe.state === 'ready' ? probe.cliPath ?? null : null })))();
      models = summarizeDevinModels(catalog, readConfig(deps));
    } catch {
      models = undefined;
    }
  }
  return {
    generatedAt: now.toISOString(),
    consumption: peekDevinConsumption(now),
    taskDiagnostics: devinTaskDiagnostics(inventory),
    status: await devinStatus(deps, tasks, inventory.sourceState),
    budget: devinBudgetView(tasks, readDevinBudget(), now, inventory.sourceState),
    tasks: tasks.slice(0, OVERVIEW_TASK_LIMIT),
    cli: { state: probe.state, usage: 'not-reported' },
    ...(models ? { models } : {}),
  };
}

export type DevinMessageResult = { ok: true; task: DevinTaskV1 } | { ok: false; status: 404 | 409 | 502; error: string };

/**
 * Reply to a session that is waiting (POST …/messages — the docs say a
 * suspended session is resumed automatically). Only for tasks Verse launched
 * that still have a live session.
 */
export async function messageDevinTask(taskId: string, message: string, deps: DevinServiceDeps = {}): Promise<DevinMessageResult> {
  const task = readDevinTask(taskId);
  if (!task) return { ok: false, status: 404, error: 'No Devin task with that id.' };
  if (!task.sessionId || ['merged', 'closed', 'failed', 'expired'].includes(task.state)) {
    return { ok: false, status: 409, error: 'This Devin task has no live session to message.' };
  }
  const text = typeof message === 'string' ? message.replace(/\0/g, '').trim() : '';
  if (text === '' || text.length > 4000) return { ok: false, status: 409, error: 'Write a message of at most 4000 characters.' };
  const connected = await connectedClient(deps);
  if ('error' in connected) return { ok: false, status: 409, error: connected.error };
  if (task.launchOrgId !== undefined && task.launchOrgId !== connected.orgId) {
    return { ok: false, status: 409, error: 'This Devin session belongs to a different organization. Restore its original connection before replying.' };
  }
  try {
    await connected.client.sendMessage(connected.orgId, task.sessionId, text);
    noteApiSuccess();
  } catch (error) {
    noteApiFailure(error);
    return { ok: false, status: 502, error: error instanceof DevinApiError ? error.message : devinFailureSentence('unknown') };
  }
  const current = readDevinTask(taskId) ?? task;
  // 3.15: count what Verse sent (the evidence timeline shows it); never the text.
  const counted: DevinTaskV1 = { ...current, messagesSent: (current.messagesSent ?? 0) + 1 };
  const next: DevinTaskV1 = counted.state === 'blocked'
    ? { ...counted, state: 'running', stateReason: 'You replied; Devin is working again.' }
    : counted;
  try {
    writeDevinTask(next);
  } catch { /* the message went; the tracker catches up */ }
  return { ok: true, task: next };
}

/** For the tracker: record an API outcome in the status cache. */
export function recordDevinApiOutcome(error: unknown | null): void {
  if (error === null) noteApiSuccess();
  else noteApiFailure(error);
}
