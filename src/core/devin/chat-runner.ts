/**
 * One Verse turn on the Devin CLOUD seat (3.15): start or message the chat's
 * Devin session, then stream what Devin says back into the transcript until
 * Devin hands the conversation back ("waiting for you"), finishes, sleeps or
 * stops.
 *
 * STREAMING = POLLING. Devin's v3 API has no push channel, so the runner reads
 * `GET …/messages?after=<cursor>` and `GET …/sessions/{id}` on an adaptive
 * clock: every 2 s while things are changing, easing to 5 s while Devin works
 * quietly, and backing off to 10–15 s while the session is starting up or
 * resuming. The cursor and the ids already shown are persisted after every
 * page (chat.ts sidecar), so a restart, a Stop or the next turn never repeats
 * a message.
 *
 * WHEN A TURN ENDS. The turn is the operator's wait, not the session's life:
 *  - waiting_for_user / waiting_for_approval → "waiting for you" (the normal end)
 *  - finished / exit                       → "finished"
 *  - suspended                             → "asleep" with Devin's reason; the
 *                                            next message wakes it (documented)
 *  - error                                 → a failed turn
 * Right after a message is posted the session can still report the PREVIOUS
 * "waiting for you" for a poll or two, so a waiting/finished reading only ends
 * the turn once Devin was seen working, said something new, or a grace period
 * passed.
 *
 * A Stop (SIGINT → `signal`) only stops WATCHING: Devin keeps working in its
 * session. Terminating the session is a separate, confirmed action
 * (chat.ts `terminateDevinChat`).
 *
 * Everything printed is scrubbed (`cog_` keys included) and bounded. The key
 * is read from the Keychain by `connectedClient` and never leaves the client.
 */
import { resolveGitHubOriginAuthorityAsync } from '../git.js';
import { scrubSecrets } from '../util/scrub.js';
import type { VerseRemoteState } from '../verse/types.js';
import {
  DevinApiError,
  devinFailureSentence,
  type DevinClient,
  type DevinSession,
} from './client.js';
import {
  devinChatGate,
  readDevinChatState,
  recordDevinChatSession,
  sendDevinChatMessage,
  writeDevinChatState,
  type DevinChatStateV1,
} from './chat.js';
import { connectedClient, launchDevinTask, type DevinServiceDeps } from './service.js';
import { readDevinTask } from './store.js';
import { DEVIN_PROMPT_MAX_CHARS, DEVIN_TASK_ID_PATTERN } from './types.js';
import type { DevinTurnLine, DevinTurnPayload } from './turn-protocol.js';

export interface DevinTurnIo {
  emit(line: DevinTurnLine): void;
  /** Aborted on Stop / shutdown: stop watching, change nothing on Devin's side. */
  signal: AbortSignal;
  /** Resolves early when `signal` aborts. */
  sleep(ms: number): Promise<void>;
  now(): number;
}

export interface DevinCloudTurnDeps extends DevinServiceDeps {
  /** owner/name of the project's GitHub origin (tests); default: git's own answer, fail closed. */
  resolveRepo?: (projectPath: string) => Promise<string | null>;
  /** A ready client (tests); default: the stored key + recorded org. */
  client?: { client: Pick<DevinClient, 'getSession' | 'listMessages'>; orgId: string } | null;
  /** Poll clock overrides (tests). */
  pollMs?: { fast: number; steady: number; slow: number; idle: number };
  /** How long a stale "waiting for you" is ignored after a message is posted. */
  graceMs?: number;
  /** Hard stop for one turn; the engine's own limit is longer. */
  maxTurnMs?: number;
}

/** Exit codes the adapter's parser understands. */
export const DEVIN_TURN_EXIT = { ok: 0, failed: 1, badInput: 2, stopped: 130 } as const;

const DEFAULT_POLL = { fast: 2_000, steady: 5_000, slow: 10_000, idle: 15_000 };
const DEFAULT_GRACE_MS = 45_000;
/** Just under the engine's Devin turn limit (session-engine VERSE_DEVIN_TURN_TIMEOUT_MS). */
export const DEVIN_CLOUD_MAX_TURN_MS = 3 * 60 * 60 * 1000 + 50 * 60 * 1000;
const QUIET_POLLS_BEFORE_EASING = 3;
const MAX_PAGES_PER_POLL = 10;
const ACU_EMIT_STEP = 0.5;
const ACU_EMIT_EVERY_MS = 60_000;
const MAX_TEXT = 60_000;

const WAITING = new Set(['waiting_for_user', 'waiting_for_approval']);

const SUSPEND_WORDS: Readonly<Record<string, string>> = {
  inactivity: 'Devin went to sleep after a quiet spell. Send a message to wake it.',
  user_request: 'The session was paused from Devin. Send a message to resume it.',
  usage_limit_exceeded: 'Devin stopped: a usage limit was reached.',
  out_of_credits: 'Devin stopped: the account is out of credits.',
  out_of_quota: 'Devin stopped: the plan quota is used up.',
  no_quota_allocation: 'Devin stopped: this user has no quota allocation.',
  payment_declined: 'Devin stopped: a payment was declined.',
  org_usage_limit_exceeded: "Devin stopped: the organization's usage limit was reached.",
  user_usage_limit_exceeded: "Devin stopped: this user's usage limit was reached.",
  total_session_limit_exceeded: 'Devin stopped: the session hit its ACU cap.',
  contract_expired: 'Devin stopped: the contract has expired.',
  error: 'Devin suspended the session after an error. Send a message to try again.',
};

function clean(text: string, max = MAX_TEXT): string {
  const scrubbed = scrubSecrets(text).replace(/\bcog_[A-Za-z0-9_-]+/g, '[REDACTED]');
  return scrubbed.length > max ? `${scrubbed.slice(0, max - 1)}…` : scrubbed;
}

/** Where the session stands, in the transcript's words; `ends` = the turn hands back to the operator. */
export function remoteStateOf(session: Pick<DevinSession, 'status' | 'statusDetail'>): { state: VerseRemoteState; message: string; ends: boolean } {
  const detail = session.statusDetail ?? '';
  switch (session.status) {
    case 'new':
    case 'claimed':
      return { state: 'starting', message: 'Devin is starting up…', ends: false };
    case 'resuming':
      return { state: 'starting', message: 'Devin is waking up…', ends: false };
    case 'running':
      if (WAITING.has(detail)) {
        return {
          state: 'waiting',
          message: detail === 'waiting_for_approval' ? 'Devin is waiting for an approval in its session.' : 'Devin is waiting for you.',
          ends: true,
        };
      }
      if (detail === 'finished') return { state: 'finished', message: 'Devin finished.', ends: true };
      return { state: 'working', message: 'Devin is working…', ends: false };
    case 'suspended':
      return { state: 'suspended', message: SUSPEND_WORDS[detail] ?? 'Devin paused the session. Send a message to resume it.', ends: true };
    case 'exit':
      return { state: 'finished', message: 'The Devin session has ended.', ends: true };
    case 'error':
    default:
      return { state: 'error', message: 'The Devin session ended in an error.', ends: true };
  }
}

function isGithubPr(url: string): boolean {
  return /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/\d+$/.test(url);
}

/**
 * Run one cloud turn. Returns the process exit code (DEVIN_TURN_EXIT). Never
 * throws: every failure is an `error` line plus a non-zero code.
 */
export async function runDevinCloudTurn(payload: DevinTurnPayload, io: DevinTurnIo, deps: DevinCloudTurnDeps = {}): Promise<number> {
  const poll = deps.pollMs ?? DEFAULT_POLL;
  const graceMs = deps.graceMs ?? DEFAULT_GRACE_MS;
  const maxTurnMs = deps.maxTurnMs ?? DEVIN_CLOUD_MAX_TURN_MS;
  const started = io.now();
  const fail = (message: string, code?: string): number => {
    io.emit({ type: 'error', message: clean(message, 2_000), ...(code ? { code } : {}) });
    return DEVIN_TURN_EXIT.failed;
  };

  // ---- 1. bind the chat to a session: start one, or message the one it has
  let taskId = payload.nativeId;
  /** A session this turn just created already said "starting" twice; don't say it a third time. */
  let initialState: VerseRemoteState | null = null;
  if (taskId !== null && !DEVIN_TASK_ID_PATTERN.test(taskId)) {
    // A native id this lane never wrote (a CLI-lane id on a cloud chat): start over.
    taskId = null;
  }
  if (payload.text.length > DEVIN_PROMPT_MAX_CHARS) {
    // Never truncate silently: the first message is Devin's whole brief, a follow-up its whole reply.
    return fail(`Devin accepts messages of up to ${DEVIN_PROMPT_MAX_CHARS.toLocaleString('en-US')} characters; this one has ${payload.text.length.toLocaleString('en-US')}.`);
  }
  if (taskId === null) {
    const gate = devinChatGate(new Date(io.now()));
    if (!gate.ok) return fail(`Devin budget: ${gate.reason ?? 'refused'}`);
    const repo = await (deps.resolveRepo ?? ((path: string) => resolveGitHubOriginAuthorityAsync(path)))(payload.projectPath).catch(() => null);
    if (!repo) {
      return fail('Devin works on a GitHub repository, and this chat’s folder has no GitHub `origin` remote Verse can read. Open the repository’s folder, or check `git remote -v`.');
    }
    io.emit({ type: 'remote-status', state: 'starting', message: `Starting a Devin session on ${repo}…`, url: null, acusConsumed: null, acuCap: null });
    const launched = await launchDevinTask({
      repo,
      prompt: payload.text,
      origin: 'chat',
      contract: 'chat',
      verseSessionId: payload.verseSessionId,
      planOnly: payload.permissionMode === 'plan',
    }, deps);
    if (!launched.ok || !launched.task) {
      return fail(launched.failure === 'budget' ? `Devin budget: ${launched.error ?? 'refused'}` : launched.error ?? devinFailureSentence('unknown'));
    }
    taskId = launched.task.id;
    initialState = 'starting';
    io.emit({ type: 'native-session', id: taskId });
    io.emit({
      type: 'remote-status',
      state: 'starting',
      message: 'Devin session started.',
      url: launched.task.sessionUrl,
      acusConsumed: launched.task.session?.acusConsumed ?? null,
      acuCap: launched.task.maxAcu,
    });
  } else {
    const task = readDevinTask(taskId);
    if (!task || !task.sessionId) {
      return fail('This chat’s Devin session is no longer on record.', 'native-thread-missing');
    }
    io.emit({ type: 'native-session', id: taskId });
    const sent = await sendDevinChatMessage(taskId, payload.text, deps);
    if (!sent.ok) {
      // A session that can no longer take messages: the engine retries ONCE on
      // a new session seeded with this chat's handoff note.
      return fail(sent.error, sent.ended ? 'native-thread-missing' : undefined);
    }
  }

  // ---- 2. watch the session
  const task = readDevinTask(taskId);
  if (!task || !task.sessionId) return fail('This chat’s Devin session is no longer on record.');
  const sessionId = task.sessionId;
  const acuCap = task.maxAcu;
  let client = deps.client ?? null;
  if (!client) {
    const connected = await connectedClient(deps);
    if ('error' in connected) return fail(connected.error);
    client = connected;
  }
  const state: DevinChatStateV1 = readDevinChatState(taskId);
  const seen = new Set(state.seen);
  const prUrls = new Set(state.prUrls);
  const sentAt = io.now();
  let sawProgress = false;
  let lastState: VerseRemoteState | null = initialState;
  let lastAcus: number | null = null;
  let lastAcuEmitAt = 0;
  let quiet = 0;
  let consecutiveFailures = 0;
  let url = task.sessionUrl;

  const persist = (): void => {
    try {
      state.seen = [...seen];
      state.prUrls = [...prUrls];
      writeDevinChatState(state);
    } catch { /* a lost cursor only risks repeating a message after a crash */ }
  };

  while (!io.signal.aborted) {
    if (io.now() - started > maxTurnMs) {
      io.emit({ type: 'remote-status', state: 'working', message: 'Devin is still working. Verse stopped watching this turn; send a message to check in.', url, acusConsumed: lastAcus, acuCap });
      persist();
      return DEVIN_TURN_EXIT.ok;
    }
    let changed = false;
    let session: DevinSession | null = null;
    try {
      // Messages first: a reply that lands with "waiting for you" must be
      // shown before the turn ends on that reading.
      for (let page = 0; page < MAX_PAGES_PER_POLL; page += 1) {
        const got = await client.client.listMessages(client.orgId, sessionId, { after: state.cursor });
        for (const message of got.items) {
          if (seen.has(message.eventId)) continue;
          seen.add(message.eventId);
          if (message.source !== 'devin') continue; // the operator's own words are already in the chat
          const text = clean(message.message).trim();
          if (text === '') continue;
          io.emit({ type: 'assistant-message', text });
          changed = true;
        }
        if (got.endCursor) state.cursor = got.endCursor;
        if (!got.hasNextPage || !got.endCursor) break;
      }
      if (changed) persist();
      session = await client.client.getSession(client.orgId, sessionId);
      consecutiveFailures = 0;
    } catch (error) {
      if (io.signal.aborted) break;
      consecutiveFailures += 1;
      const code = error instanceof DevinApiError ? error.code : 'unknown';
      if (code === 'auth' || code === 'forbidden' || consecutiveFailures >= 5) {
        persist();
        return fail(error instanceof DevinApiError ? error.message : devinFailureSentence('unknown'));
      }
      await io.sleep(poll.slow);
      continue;
    }

    recordDevinChatSession(taskId, session, new Date(io.now()));
    url = session.url;
    for (const pr of session.pullRequests) {
      if (prUrls.has(pr.url) || !isGithubPr(pr.url)) continue;
      prUrls.add(pr.url);
      io.emit({ type: 'remote-pr', url: pr.url, state: pr.state });
      changed = true;
      persist();
    }

    const reading = remoteStateOf(session);
    if (reading.state === 'working') sawProgress = true;
    const acus = session.acusConsumed;
    const acuMoved = acus !== null && (lastAcus === null ? acus > 0 : acus - lastAcus >= ACU_EMIT_STEP || (acus !== lastAcus && io.now() - lastAcuEmitAt >= ACU_EMIT_EVERY_MS));
    const staleWait = reading.ends && reading.state !== 'error' && session.status === 'running'
      && !sawProgress && !changed && io.now() - sentAt < graceMs;
    if (!staleWait && (reading.state !== lastState || acuMoved)) {
      lastState = reading.state;
      lastAcus = acus ?? lastAcus;
      lastAcuEmitAt = io.now();
      io.emit({ type: 'remote-status', state: reading.state, message: reading.message, url, acusConsumed: acus, acuCap });
    }
    if (reading.ends && !staleWait) {
      persist();
      if (reading.state === 'error') return fail(reading.message);
      return DEVIN_TURN_EXIT.ok;
    }

    io.emit({ type: 'progress', phase: reading.state === 'starting' ? 'waiting' : 'tool', tool: 'Devin', elapsedMs: Math.max(0, io.now() - started) });
    quiet = changed ? 0 : quiet + 1;
    const wait = reading.state === 'starting' || session.status === 'suspended'
      ? (quiet > QUIET_POLLS_BEFORE_EASING ? poll.idle : poll.slow)
      : (quiet >= QUIET_POLLS_BEFORE_EASING ? poll.steady : poll.fast);
    await io.sleep(wait);
  }
  persist();
  return DEVIN_TURN_EXIT.stopped;
}
