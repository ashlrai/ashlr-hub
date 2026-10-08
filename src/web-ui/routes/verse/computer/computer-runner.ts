/**
 * routes/verse/computer/computer-runner.ts — the Verse window's half of the
 * computer-use relay: ONE long-poll loop for every chat, started by
 * ComputerControl only in a desktop shell whose native bridge supports
 * computer use. Pure apart from the api / native / hooks it is handed.
 *
 * WHAT IT DOES WITH EACH COMMAND
 *   - `native` — forwards `command.op` to the shell and posts native's answer
 *     back verbatim (`{ id, ok, data }` or `{ id, ok: false, code, error }`).
 *     Only the ops an AGENT may cause are forwarded: `arm` (clears a KILL),
 *     `resume` (ends the operator's takeover), `open-settings` and
 *     `request-permission` are the operator's alone and are refused here even
 *     though the sidecar is trusted — defence in depth for the two buttons
 *     that give control back. A `no-permission` answer opens the onboarding
 *     sheet.
 *   - `access` / `confirm` — handed to the UI (`onPrompt`), which queues them
 *     (several chats can ask at once) and answers through `answerAccess` /
 *     `answerConfirm` when the operator decides.
 *
 * INVARIANTS
 *   - Never posts twice for one command id (`answered`), and never handles a
 *     re-delivered command twice (`seen`, bounded).
 *   - An access answer can only grant apps the command offered, at most at the
 *     tier it offered, and never an app offered as denied (tier null).
 *   - Polls only while a mutation token is held — answers need one, and a
 *     window that cannot answer must not look present to the sidecar.
 *   - Errors back off 2 s → 30 s; `stop()` aborts the poll at once.
 */
import {
  COMPUTER_COMMAND_ID_RE,
  isComputerTier,
  tierRank,
  type ComputerErrorCode,
  type ComputerGrantWire,
  type ConfirmDecision,
  type NativeComputerOp,
  type VerseComputerAccessApp,
  type VerseComputerCommand,
  type VerseComputerCommandResult,
  type VerseComputerConfirmRequest,
} from '../../../../core/verse/computer-types.js';
import { VerseMutationLockedError } from '../verse-queries.js';
import type { ComputerApi } from './computer-queries.js';
import {
  localRequestId,
  NATIVE_OP_TIMEOUT_MS,
  parsePermissions,
  permissionsMissing,
  type ComputerPermissions,
  type NativeComputer,
  type NativeComputerRequestOp,
} from './native-computer.js';

export const BACKOFF_START_MS = 2_000;
export const BACKOFF_MAX_MS = 30_000;
/** How often to re-check for a mutation token while none is held. */
export const TOKEN_RECHECK_MS = 3_000;
const SEEN_LIMIT = 500;
const RESULT_ATTEMPTS = 3;

/** Ops an agent's command may carry to native (see the header). */
const RELAYABLE_OPS: ReadonlySet<NativeComputerOp['op']> = new Set<NativeComputerOp['op']>([
  'permissions',
  'list-apps',
  'screenshot',
  'zoom',
  'ax-tree',
  'probe',
  'ax-press',
  'click',
  'type',
  'key',
  'scroll',
  'drag',
  'kill',
]);

export type ComputerPrompt =
  | { kind: 'access'; id: string; sessionId: string; apps: VerseComputerAccessApp[]; reason: string; createdAt: string }
  | { kind: 'confirm'; id: string; sessionId: string; confirm: VerseComputerConfirmRequest; createdAt: string };

export interface ComputerRunnerHooks {
  api: ComputerApi;
  native: NativeComputer;
  /** An access sheet or confirmation card the operator must answer. */
  onPrompt(prompt: ComputerPrompt): void;
  /** Screen Recording or Accessibility is missing (status when known). */
  onNeedsPermissions(permissions: ComputerPermissions | null): void;
  /** A poll returned commands (the grants list may have changed). */
  onActivity?(): void;
  /** Injectable for tests. Resolves early (never rejects) when `signal` aborts. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  nativeTimeoutMs?: number;
}

export interface ComputerRunner {
  stop(): void;
  /** `approved` null or empty = the operator declined. */
  answerAccess(id: string, approved: readonly ComputerGrantWire[] | null): Promise<void>;
  answerConfirm(id: string, decision: ConfirmDecision): Promise<void>;
  /** After KILL: the sidecar failed everything waiting, so drop the prompts without answering. */
  forgetPrompts(): string[];
}

export function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done);
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Only commands whose id we could answer are handled; the rest are dropped. */
function commandId(value: unknown): string | null {
  return isRecord(value) && typeof value['id'] === 'string' && COMPUTER_COMMAND_ID_RE.test(value['id']) ? value['id'] : null;
}

function refuse(id: string, code: ComputerErrorCode, error: string): VerseComputerCommandResult {
  return { id, ok: false, code, error };
}

/**
 * The grants an access answer may carry: apps the command offered, not denied,
 * each at most at the offered tier, each once.
 */
export function clampApproved(offered: readonly VerseComputerAccessApp[], approved: readonly ComputerGrantWire[]): ComputerGrantWire[] {
  const byId = new Map(offered.map((app) => [app.bundleId, app] as const));
  const out: ComputerGrantWire[] = [];
  const taken = new Set<string>();
  for (const grant of approved) {
    const app = byId.get(grant.bundleId);
    if (!app || app.tier === null || taken.has(app.bundleId) || !isComputerTier(grant.tier)) continue;
    taken.add(app.bundleId);
    out.push({ bundleId: app.bundleId, tier: tierRank(grant.tier) <= tierRank(app.tier) ? grant.tier : app.tier });
  }
  return out;
}

export function startComputerRunner(hooks: ComputerRunnerHooks): ComputerRunner {
  const { api, native } = hooks;
  const sleep = hooks.sleep ?? defaultSleep;
  const nativeTimeout = hooks.nativeTimeoutMs ?? NATIVE_OP_TIMEOUT_MS;
  const controller = new AbortController();
  const signal = controller.signal;
  const seen = new Set<string>();
  const answered = new Set<string>();
  const pending = new Map<string, ComputerPrompt>();

  function remember(id: string): boolean {
    if (seen.has(id)) return false;
    seen.add(id);
    if (seen.size > SEEN_LIMIT) {
      const oldest = seen.values().next().value;
      if (oldest !== undefined) seen.delete(oldest);
    }
    return true;
  }

  /** Post once per id. A failed post is retried (the relay 404s a duplicate harmlessly). */
  async function post(result: VerseComputerCommandResult): Promise<void> {
    if (answered.has(result.id)) return;
    answered.add(result.id);
    pending.delete(result.id);
    for (let attempt = 1; attempt <= RESULT_ATTEMPTS; attempt++) {
      try {
        await api.result(result);
        return;
      } catch (err) {
        if (err instanceof VerseMutationLockedError || attempt === RESULT_ATTEMPTS) {
          console.warn('[verse] computer result not delivered', err instanceof Error ? err.message : err);
          return;
        }
        await sleep(1_000 * attempt, new AbortController().signal);
      }
    }
  }

  async function checkPermissions(): Promise<void> {
    const answer = await native.request({ op: 'permissions', req: localRequestId() }, nativeTimeout);
    if (!answer.ok) return;
    const permissions = parsePermissions(answer.data);
    if (permissionsMissing(permissions)) hooks.onNeedsPermissions(permissions);
  }

  async function runNative(id: string, op: NativeComputerOp): Promise<void> {
    if (!isRecord(op) || typeof op.op !== 'string' || !RELAYABLE_OPS.has(op.op)) {
      await post(refuse(id, 'invalid', 'The Phantom window does not relay that desktop operation.'));
      return;
    }
    if (!('req' in op)) {
      // `kill` — the only relayable op without an answer.
      const sent = native.send(op);
      await post(sent ? { id, ok: true, data: null } : refuse(id, 'failed', 'The desktop app refused the request.'));
      return;
    }
    const request: NativeComputerRequestOp = typeof op.req === 'string' && op.req ? op : { ...op, req: id };
    const answer = await native.request(request, nativeTimeout);
    if (answer.ok) {
      await post({ id, ok: true, data: answer.data });
      return;
    }
    if (answer.code === 'no-permission') hooks.onNeedsPermissions(null);
    await post({ id, ok: false, code: answer.code, error: answer.error });
  }

  function handle(raw: unknown): void {
    const id = commandId(raw);
    if (!id || !remember(id) || answered.has(id)) return;
    const command = raw as VerseComputerCommand;
    const sessionId = typeof command.sessionId === 'string' ? command.sessionId : '';
    const createdAt = typeof command.createdAt === 'string' ? command.createdAt : '';
    switch (command.kind) {
      case 'native':
        void runNative(id, command.op);
        return;
      case 'access': {
        if (!Array.isArray(command.apps)) {
          void post(refuse(id, 'invalid', 'The access request was malformed.'));
          return;
        }
        const prompt: ComputerPrompt = {
          kind: 'access',
          id,
          sessionId,
          apps: command.apps.filter((app) => isRecord(app) && typeof app.bundleId === 'string'),
          reason: typeof command.reason === 'string' ? command.reason : '',
          createdAt,
        };
        pending.set(id, prompt);
        hooks.onPrompt(prompt);
        return;
      }
      case 'confirm': {
        if (!isRecord(command.confirm)) {
          void post(refuse(id, 'invalid', 'The confirmation request was malformed.'));
          return;
        }
        const prompt: ComputerPrompt = { kind: 'confirm', id, sessionId, confirm: command.confirm, createdAt };
        pending.set(id, prompt);
        hooks.onPrompt(prompt);
        return;
      }
      default:
        void post(refuse(id, 'unsupported', 'This Phantom window does not understand that command. Update Phantom.'));
    }
  }

  async function loop(): Promise<void> {
    let backoff = 0;
    while (!signal.aborted) {
      if (!api.canWrite()) {
        await sleep(TOKEN_RECHECK_MS, signal);
        continue;
      }
      try {
        const response = await api.commands(signal);
        if (signal.aborted) break;
        backoff = 0;
        const commands = isRecord(response) && Array.isArray(response.commands) ? response.commands : [];
        for (const command of commands) handle(command);
        if (commands.length > 0) hooks.onActivity?.();
      } catch (err) {
        if (signal.aborted) break;
        if (err instanceof VerseMutationLockedError) {
          await sleep(TOKEN_RECHECK_MS, signal);
          continue;
        }
        backoff = backoff === 0 ? BACKOFF_START_MS : Math.min(backoff * 2, BACKOFF_MAX_MS);
        await sleep(backoff, signal);
      }
    }
  }

  void loop();

  return {
    stop() {
      controller.abort();
    },
    async answerAccess(id, approved) {
      const prompt = pending.get(id);
      if (!prompt || prompt.kind !== 'access' || answered.has(id)) return;
      const grants = approved ? clampApproved(prompt.apps, approved) : [];
      if (grants.length === 0) {
        await post({ id, ok: false, error: 'The operator declined.' });
        return;
      }
      await post({ id, ok: true, data: { approved: grants } });
      // A fresh grant clears a previous KILL, then make sure macOS will let
      // native do what was just granted.
      native.send({ op: 'arm' });
      await checkPermissions();
    },
    async answerConfirm(id, decision) {
      const prompt = pending.get(id);
      if (!prompt || prompt.kind !== 'confirm' || answered.has(id)) return;
      const safe: ConfirmDecision = decision === 'once' || decision === 'chat' ? decision : 'deny';
      await post({ id, ok: true, data: { decision: safe } });
    },
    forgetPrompts() {
      const ids = [...pending.keys()];
      for (const id of ids) answered.add(id);
      pending.clear();
      return ids;
    },
  };
}
