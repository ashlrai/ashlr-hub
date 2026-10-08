/**
 * core/verse/computer-bridge.ts — the sidecar's half of desktop control
 * (3.15, agent-tools P4): per-chat app grants, the per-turn "read untrusted
 * content" flag, and the command relay to the Verse window.
 *
 * WHO EXECUTES. Never the sidecar. A seat's `computer_*` tool call
 * (verse-mcp-computer.ts) becomes a command queued here; the Verse WINDOW —
 * one poller for every chat — long-polls for it, shows the operator any sheet
 * or card it needs, hands native ops to the desktop shell (computer.rs) and
 * posts the answer back. No window polling → the tool fails at once. An agent
 * therefore never acts on the desktop while Verse is closed, and every action
 * passes the always-on-top HUD and the takeover watch native keeps.
 *
 * WHAT IS HELD. Memory only, on purpose: a restart, deleting the chat, KILL
 * (button or Esc) revokes every grant. Nothing here touches the disk.
 *
 * GRANTS are per chat and per app, at a tier (computer-types.ts) the operator
 * approved in the access sheet, never above the app's ceiling. They travel
 * with each native op so native can clamp them again; native is the last
 * word on the denylist, tiers, secure fields and takeover.
 *
 * No node:fs, no child processes: pure state plus node:crypto.
 */
import { randomBytes } from 'node:crypto';

import {
  computerAppPolicy,
  isComputerTier,
  minTier,
  tierRank,
  type ComputerErrorCode,
  type ComputerFrame,
  type ComputerGrantWire,
  type ComputerTier,
  type ConfirmReason,
  type NativeComputerOp,
  type VerseComputerAccessApp,
  type VerseComputerChatGrant,
  type VerseComputerCommand,
  type VerseComputerCommandResult,
  type VerseComputerConfirmRequest,
  type VerseComputerState,
} from './computer-types.js';

/** A window that has not polled for this long is treated as closed. */
export const COMPUTER_WINDOW_STALE_MS = 30_000;
/** A queued command nobody claims within this long fails ("is Verse open?"). */
export const COMPUTER_CLAIM_TIMEOUT_MS = 8_000;
/** A claimed native op without an answer within this long fails. */
export const COMPUTER_NATIVE_RESULT_TIMEOUT_MS = 60_000;
/** How long the operator has to answer an access sheet or a confirmation card. */
export const COMPUTER_OPERATOR_TIMEOUT_MS = 5 * 60_000;
/** The window's long-poll is answered after at most this long. */
export const COMPUTER_POLL_MAX_WAIT_MS = 20_000;
const MAX_QUEUE = 16;
const MAX_GRANTS_PER_CHAT = 32;

export type ComputerOutcome =
  | { ok: true; data: unknown }
  | { ok: false; code: ComputerErrorCode | 'window-not-open' | 'declined'; message: string };

/** A native op as the tools build it: everything but the relay's `req`. */
export type NativeOpInput = NativeComputerOp extends infer T ? (T extends { req: string } ? Omit<T, 'req'> : never) : never;

type CommandBody =
  | { kind: 'native'; op: NativeOpInput }
  | { kind: 'access'; apps: VerseComputerAccessApp[]; reason: string }
  | { kind: 'confirm'; confirm: VerseComputerConfirmRequest };

interface PendingCommand {
  command: VerseComputerCommand;
  settle: (outcome: ComputerOutcome) => void;
  timer: ReturnType<typeof setTimeout> | null;
  resultMs: number;
}

interface ChatComputerState {
  grants: Map<string, VerseComputerChatGrant>;
  allowedForChat: Set<ConfirmReason>;
  /** This turn captured a window whose content is someone else's words. */
  turnReadUntrusted: boolean;
  /** The last screenshot's geometry — what the agent's coordinates mean. */
  frame: ComputerFrame | null;
  /** Access requests shown and not answered yet, by command id → the apps offered. */
  offered: Map<string, VerseComputerAccessApp[]>;
}

const chats = new Map<string, ChatComputerState>();
let queue: PendingCommand[] = [];
const inflight = new Map<string, PendingCommand>();
const wakers = new Set<() => void>();
let activePolls = 0;
let windowSeenAt: number | null = null;
let clock: () => number = Date.now;

function stateFor(sessionId: string): ChatComputerState {
  let state = chats.get(sessionId);
  if (!state) {
    state = { grants: new Map(), allowedForChat: new Set(), turnReadUntrusted: false, frame: null, offered: new Map() };
    chats.set(sessionId, state);
  }
  return state;
}

function grantKey(bundleId: string): string {
  return bundleId.toLowerCase();
}

// ---------------------------------------------------------------------------
// Grants
// ---------------------------------------------------------------------------

export function computerState(): VerseComputerState {
  const out: VerseComputerState['chats'] = [];
  for (const [sessionId, state] of chats) {
    if (state.grants.size === 0 && state.allowedForChat.size === 0) continue;
    out.push({ sessionId, grants: [...state.grants.values()].map((g) => ({ ...g })), allowedForChat: [...state.allowedForChat] });
  }
  return { windowPresent: computerWindowPresent(), chats: out };
}

/** The chat's grants in the wire form native re-validates. */
export function computerGrantsFor(sessionId: string): ComputerGrantWire[] {
  return [...(chats.get(sessionId)?.grants.values() ?? [])].map((g) => ({ bundleId: g.bundleId, tier: g.tier }));
}

/**
 * The tier this chat holds for an app, clamped to the app's ceiling again
 * (defence in depth: a grant can never outrank the policy), or null.
 */
export function effectiveComputerTier(sessionId: string, bundleId: string | null | undefined, executablePath?: string | null): ComputerTier | null {
  if (typeof bundleId !== 'string') return null;
  const grant = chats.get(sessionId)?.grants.get(grantKey(bundleId));
  if (!grant) return null;
  const ceiling = computerAppPolicy(bundleId, executablePath).ceiling;
  return ceiling === null ? null : minTier(grant.tier, ceiling);
}

export function computerGrantedApp(sessionId: string, bundleIdOrName: string): VerseComputerChatGrant | null {
  const state = chats.get(sessionId);
  if (!state) return null;
  const direct = state.grants.get(grantKey(bundleIdOrName));
  if (direct) return { ...direct };
  const lower = bundleIdOrName.trim().toLowerCase();
  for (const grant of state.grants.values()) if (grant.name.toLowerCase() === lower) return { ...grant };
  return null;
}

/**
 * Record the operator's answer to an access sheet. Only apps that sheet
 * offered are accepted, never above the tier it offered (itself clamped to
 * the ceiling); a denied app is dropped whatever the answer says. Returns
 * the grants actually made.
 */
export function applyComputerAccessDecision(sessionId: string, offered: readonly VerseComputerAccessApp[], approved: unknown): VerseComputerChatGrant[] {
  if (!Array.isArray(approved)) return [];
  const state = stateFor(sessionId);
  const made: VerseComputerChatGrant[] = [];
  for (const entry of approved.slice(0, MAX_GRANTS_PER_CHAT)) {
    if (typeof entry !== 'object' || entry === null) continue;
    const bundleId = (entry as Record<string, unknown>)['bundleId'];
    const tier = (entry as Record<string, unknown>)['tier'];
    if (typeof bundleId !== 'string' || !isComputerTier(tier)) continue;
    const offer = offered.find((o) => grantKey(o.bundleId) === grantKey(bundleId));
    if (!offer || offer.tier === null) continue;
    const ceiling = computerAppPolicy(offer.bundleId).ceiling;
    if (ceiling === null) continue;
    const granted = minTier(minTier(tier, offer.tier), ceiling);
    if (!state.grants.has(grantKey(offer.bundleId)) && state.grants.size >= MAX_GRANTS_PER_CHAT) break;
    const grant: VerseComputerChatGrant = { bundleId: offer.bundleId, name: offer.name, tier: granted, grantedAt: new Date(clock()).toISOString() };
    state.grants.set(grantKey(offer.bundleId), grant);
    made.push({ ...grant });
  }
  return made;
}

/** Revoke one app (or every app) of one chat. */
export function revokeComputerGrants(sessionId: string, bundleId?: string): VerseComputerState {
  const state = chats.get(sessionId);
  if (state) {
    if (bundleId === undefined) {
      state.grants.clear();
      state.allowedForChat.clear();
      state.frame = null;
    } else {
      state.grants.delete(grantKey(bundleId));
    }
    if (state.grants.size === 0) failWhere((p) => p.command.sessionId === sessionId, { ok: false, code: 'not-granted', message: 'The operator revoked desktop access for this chat.' });
  }
  return computerState();
}

/**
 * KILL (the Verse button or Esc on the HUD): every grant of every chat goes,
 * every "allow for chat" goes, and everything waiting fails as stopped.
 */
export function killComputer(): VerseComputerState {
  for (const state of chats.values()) {
    state.grants.clear();
    state.allowedForChat.clear();
    state.frame = null;
    state.offered.clear();
  }
  failWhere(() => true, { ok: false, code: 'stopped', message: 'The operator stopped desktop control (KILL). Every desktop grant was revoked.' });
  return computerState();
}

// ---------------------------------------------------------------------------
// Turn state
// ---------------------------------------------------------------------------

/**
 * A turn ended (verse-api.ts `verseTurnHooks().afterTurn`): the next turn
 * starts without the previous one's "read untrusted content" mark. Seats only
 * call tools inside a turn, so clearing at the end equals clearing at the
 * start of the next.
 */
export function endComputerTurn(sessionId: string): void {
  const state = chats.get(sessionId);
  if (state) state.turnReadUntrusted = false;
}

/** This turn read content that is someone else's words (mail, chat, the web). */
export function noteComputerUntrustedRead(sessionId: string): void {
  stateFor(sessionId).turnReadUntrusted = true;
}

export function computerTurnReadUntrusted(sessionId: string): boolean {
  return chats.get(sessionId)?.turnReadUntrusted === true;
}

export function allowComputerReasonForChat(sessionId: string, reason: ConfirmReason): void {
  stateFor(sessionId).allowedForChat.add(reason);
}

export function computerAllowedForChat(sessionId: string): ReadonlySet<ConfirmReason> {
  return new Set(chats.get(sessionId)?.allowedForChat ?? []);
}

export function setComputerFrame(sessionId: string, frame: ComputerFrame | null): void {
  stateFor(sessionId).frame = frame;
}

export function computerFrameFor(sessionId: string): ComputerFrame | null {
  return chats.get(sessionId)?.frame ?? null;
}

// ---------------------------------------------------------------------------
// The relay
// ---------------------------------------------------------------------------

export function computerWindowPresent(): boolean {
  if (activePolls > 0) return true;
  return windowSeenAt !== null && clock() - windowSeenAt < COMPUTER_WINDOW_STALE_MS;
}

function wake(): void {
  for (const waker of [...wakers]) waker();
}

function failWhere(match: (p: PendingCommand) => boolean, outcome: ComputerOutcome): void {
  const hit = [...queue, ...inflight.values()].filter(match);
  for (const pending of hit) {
    if (pending.timer) clearTimeout(pending.timer);
    queue = queue.filter((p) => p !== pending);
    inflight.delete(pending.command.id);
    pending.settle(outcome);
  }
}

const WINDOW_NOT_OPEN =
  'The Phantom window is not open in the desktop app, so there is nothing to act through. Ask the operator to open Phantom (desktop app, macOS), then try again.';

function newCommandId(): string {
  return `cc_${randomBytes(9).toString('base64url')}`;
}

/**
 * Queue one command for the Verse window and wait for its answer. Resolves —
 * never rejects — with the window's result or a refusal the agent can act on.
 */
export function runComputerCommand(
  sessionId: string,
  body: CommandBody,
  timeouts: { claimMs?: number; resultMs?: number; signal?: AbortSignal } = {},
): Promise<ComputerOutcome> {
  const REVOKED: ComputerOutcome = { ok: false, code: 'stopped', message: 'This turn\'s tools were revoked (the turn ended, was stopped, or the operator pressed KILL).' };
  if (timeouts.signal?.aborted) return Promise.resolve(REVOKED);
  if (!computerWindowPresent()) return Promise.resolve({ ok: false, code: 'window-not-open', message: WINDOW_NOT_OPEN });
  if (queue.length + inflight.size >= MAX_QUEUE) {
    return Promise.resolve({ ok: false, code: 'busy', message: 'Too many desktop requests are already waiting; wait for them to finish.' });
  }
  const id = newCommandId();
  const createdAt = new Date(clock()).toISOString();
  let command: VerseComputerCommand;
  let resultMs: number;
  if (body.kind === 'native') {
    command = { id, sessionId, kind: 'native', op: { ...body.op, req: id } as NativeComputerOp, createdAt };
    resultMs = timeouts.resultMs ?? COMPUTER_NATIVE_RESULT_TIMEOUT_MS;
  } else if (body.kind === 'access') {
    command = { id, sessionId, kind: 'access', apps: body.apps.map((a) => ({ ...a })), reason: body.reason, createdAt };
    stateFor(sessionId).offered.set(id, body.apps.map((a) => ({ ...a })));
    resultMs = timeouts.resultMs ?? COMPUTER_OPERATOR_TIMEOUT_MS;
  } else {
    command = { id, sessionId, kind: 'confirm', confirm: { ...body.confirm }, createdAt };
    resultMs = timeouts.resultMs ?? COMPUTER_OPERATOR_TIMEOUT_MS;
  }
  const claimMs = timeouts.claimMs ?? COMPUTER_CLAIM_TIMEOUT_MS;
  return new Promise<ComputerOutcome>((resolve) => {
    let settled = false;
    const onAbort = (): void => {
      if (pending.timer) clearTimeout(pending.timer);
      queue = queue.filter((p) => p !== pending);
      inflight.delete(id);
      pending.settle(REVOKED);
    };
    const pending: PendingCommand = {
      command,
      timer: null,
      resultMs,
      settle: (outcome) => {
        if (settled) return;
        settled = true;
        timeouts.signal?.removeEventListener('abort', onAbort);
        chats.get(sessionId)?.offered.delete(id);
        resolve(outcome);
      },
    };
    timeouts.signal?.addEventListener('abort', onAbort, { once: true });
    pending.timer = setTimeout(() => {
      queue = queue.filter((p) => p !== pending);
      pending.settle({ ok: false, code: 'window-not-open', message: WINDOW_NOT_OPEN });
    }, claimMs);
    queue.push(pending);
    wake();
  });
}

function claimQueued(): VerseComputerCommand[] {
  const taken = queue.splice(0, queue.length);
  for (const pending of taken) {
    if (pending.timer) clearTimeout(pending.timer);
    pending.timer = setTimeout(() => {
      inflight.delete(pending.command.id);
      pending.settle(
        pending.command.kind === 'native'
          ? { ok: false, code: 'timeout', message: 'The desktop did not answer in time.' }
          : { ok: false, code: 'declined', message: 'The operator did not answer in time, so nothing was allowed.' },
      );
    }, pending.resultMs);
    inflight.set(pending.command.id, pending);
  }
  return taken.map((p) => p.command);
}

/**
 * The Verse window's long-poll: the commands waiting (for every chat), or an
 * empty list after `waitMs`. Every poll counts as "the window is open".
 */
export function claimComputerCommands(opts: { waitMs: number; signal?: AbortSignal }): Promise<VerseComputerCommand[]> {
  windowSeenAt = clock();
  if (queue.length > 0 || opts.waitMs <= 0) return Promise.resolve(claimQueued());
  activePolls += 1;
  return new Promise((resolve) => {
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      wakers.delete(onWake);
      opts.signal?.removeEventListener('abort', onAbort);
      activePolls = Math.max(0, activePolls - 1);
      windowSeenAt = clock();
    };
    const onWake = (): void => {
      finish();
      resolve(claimQueued());
    };
    const onAbort = (): void => {
      finish();
      resolve([]);
    };
    const timer = setTimeout(() => {
      finish();
      resolve([]);
    }, Math.min(opts.waitMs, COMPUTER_POLL_MAX_WAIT_MS));
    wakers.add(onWake);
    if (opts.signal?.aborted) onAbort();
    else opts.signal?.addEventListener('abort', onAbort, { once: true });
  });
}

const ERROR_CODES: ReadonlySet<string> = new Set<ComputerErrorCode>([
  'no-permission', 'operator-took-over', 'stopped', 'not-granted', 'tier', 'denied', 'secure-field', 'out-of-bounds',
  'not-found', 'stale-ref', 'unsupported', 'invalid', 'busy', 'timeout', 'failed',
]);

/**
 * The window's answer. False when no such command is waiting (late, or never
 * issued). An `access` answer is applied here — the grants exist before the
 * tool call that asked resolves.
 */
export function completeComputerCommand(result: VerseComputerCommandResult): boolean {
  const pending = inflight.get(result.id);
  if (!pending) return false;
  inflight.delete(result.id);
  if (pending.timer) clearTimeout(pending.timer);
  windowSeenAt = clock();
  const command = pending.command;
  if (!result.ok) {
    const message = typeof result.error === 'string' && result.error.trim() ? result.error.trim().slice(0, 500) : 'The desktop could not do that.';
    if (command.kind !== 'native') {
      pending.settle({ ok: false, code: 'declined', message });
      return true;
    }
    const code = typeof result.code === 'string' && ERROR_CODES.has(result.code) ? (result.code as ComputerErrorCode) : 'failed';
    pending.settle({ ok: false, code, message });
    return true;
  }
  if (command.kind === 'access') {
    const offered = chats.get(command.sessionId)?.offered.get(command.id) ?? command.apps;
    const data = typeof result.data === 'object' && result.data !== null ? (result.data as Record<string, unknown>) : {};
    const made = applyComputerAccessDecision(command.sessionId, offered, data['approved']);
    pending.settle({ ok: true, data: { granted: made } });
    return true;
  }
  if (command.kind === 'confirm') {
    const data = typeof result.data === 'object' && result.data !== null ? (result.data as Record<string, unknown>) : {};
    const decision = data['decision'] === 'once' || data['decision'] === 'chat' ? data['decision'] : 'deny';
    if (decision === 'chat') allowComputerReasonForChat(command.sessionId, command.confirm.reason);
    pending.settle({ ok: true, data: { decision } });
    return true;
  }
  pending.settle({ ok: true, data: result.data });
  return true;
}

/**
 * A deleted chat: revoke its grants, fail everything it still has waiting and
 * drop its state. Idempotent.
 */
export function forgetComputerChat(sessionId: string): void {
  if (!chats.has(sessionId)) return;
  failWhere((p) => p.command.sessionId === sessionId, { ok: false, code: 'not-granted', message: 'This chat was deleted.' });
  chats.delete(sessionId);
}

/** Does any chat hold a grant right now? (The window shows KILL while one does.) */
export function anyComputerGrant(): boolean {
  for (const state of chats.values()) if (state.grants.size > 0) return true;
  return false;
}

/** Highest tier any chat holds for an app (for diagnostics). */
export function highestComputerTier(bundleId: string): ComputerTier | null {
  let best: ComputerTier | null = null;
  for (const state of chats.values()) {
    const grant = state.grants.get(grantKey(bundleId));
    if (grant && (best === null || tierRank(grant.tier) > tierRank(best))) best = grant.tier;
  }
  return best;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

/** Test hygiene: forget every chat (pending commands fail), release polls, restore the clock. */
export function resetComputerBridgeForTest(): void {
  failWhere(() => true, { ok: false, code: 'stopped', message: 'reset' });
  for (const waker of [...wakers]) waker();
  chats.clear();
  queue = [];
  inflight.clear();
  activePolls = 0;
  windowSeenAt = null;
  clock = Date.now;
}

export function setComputerBridgeClockForTest(next: (() => number) | null): void {
  clock = next ?? Date.now;
}

/** Test hook: mark the Verse window as present (as a poll would). */
export function markComputerWindowSeenForTest(): void {
  windowSeenAt = clock();
}
