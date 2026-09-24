/**
 * core/verse/turn-queue.ts — follow-ups typed while a turn runs
 * (SPEC-310C §2 "Composer: Queueing"; unit C3).
 *
 * Enter during a running turn does not bounce with "a turn is already
 * running": the message is queued ON THE SERVER, at most VERSE_QUEUE_MAX per
 * chat, and the engine sends the next one the moment the running turn ends
 * CLEANLY. After a failure or a Stop the queue HOLDS instead — the follow-up
 * was written against a reply that did not happen, so sending it blind would
 * spend on a stale instruction — and the chat surfaces a `queue-held` item
 * until the operator sends, edits or clears it.
 *
 * Server-side (not a client timer) because the turn can end while the tab is
 * hidden, reloading or closed, and because two open windows must see one
 * queue. Persisted per chat as `<root>/queues/<sid>.json` (0600) so a reload
 * or a restart never drops typed text; a restart interrupts the running turn,
 * which holds the queue — exactly the failure rule.
 *
 * `sendNow` marks one item to go next even though the turn it waits on is
 * being stopped (⌘⇧Enter "stop and send", the row's [Send now]): the Stop is
 * the operator's own instruction, so it is the one stop that does not hold.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { writePrivateFileAtomically } from './session-store.js';
import {
  VERSE_QUEUE_MAX,
  type VerseQueueResponse,
  type VerseQueuedTurn,
} from './workbench-types.js';

/** Same cap as a turn's own text (VERSE_MAX_TURN_TEXT_BYTES). */
export const VERSE_QUEUE_TEXT_MAX_BYTES = 64 * 1024;

export class VerseQueueError extends Error {
  readonly code: 'VERSE_INVALID' | 'VERSE_TOO_LARGE' | 'VERSE_QUEUE_FULL';
  constructor(code: VerseQueueError['code'], message: string) {
    super(message);
    this.name = 'VerseQueueError';
    this.code = code;
  }
}

interface QueueState {
  items: VerseQueuedTurn[];
  held: boolean;
  heldReason: string | null;
  /** ISO time the queue started holding (the Needs-you item's `since`). */
  heldAt: string | null;
  /** The item to send next even though the turn it waited on was stopped. */
  sendNow: string | null;
}

export interface TurnQueueOptions {
  now?: () => Date;
  randomId?: () => string;
  /** Diagnostic sink for a queue file that could not be written. */
  onWriteError?: (sessionId: string, err: unknown) => void;
}

export interface VerseTurnQueue {
  get(sessionId: string): VerseQueueResponse;
  size(sessionId: string): number;
  /** Validates and appends; `front` puts it first (stop-and-send). Throws VerseQueueError. */
  enqueue(sessionId: string, text: string, opts?: { front?: boolean }): VerseQueuedTurn;
  remove(sessionId: string, queueId: string): boolean;
  /** Remove and return one item (the given id, else the first). */
  take(sessionId: string, queueId?: string): VerseQueuedTurn | null;
  /** Put an item back at the front (a drain that could not start). */
  restore(sessionId: string, item: VerseQueuedTurn): void;
  hold(sessionId: string, reason: string): void;
  release(sessionId: string): void;
  markSendNow(sessionId: string, queueId: string): boolean;
  /** The marked item's id, cleared as it is read. */
  takeSendNow(sessionId: string): string | null;
  /** Forget the chat's queue (chat deleted). */
  drop(sessionId: string): void;
  /** Every chat whose queue is holding (Needs you). Scans the queue directory once, then serves memory. */
  listHeld(): Array<VerseQueueResponse & { heldAt: string }>;
}

function emptyState(): QueueState {
  return { items: [], held: false, heldReason: null, heldAt: null, sendNow: null };
}

function isQueuedTurn(value: unknown, sessionId: string): value is VerseQueuedTurn {
  if (value === null || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return typeof v['id'] === 'string' && /^[0-9a-f]{12}$/.test(v['id'])
    && v['sessionId'] === sessionId
    && typeof v['text'] === 'string' && v['text'].length > 0
    && typeof v['createdAt'] === 'string';
}

/**
 * The one text rule shared with POST .../turns: non-blank, ≤ 64 KB, no NUL
 * (the text rides on argv, where a NUL makes spawn throw after the turn was
 * already recorded).
 */
export function validateQueuedText(text: unknown): string {
  if (typeof text !== 'string' || text.trim().length === 0) throw new VerseQueueError('VERSE_INVALID', 'text is required');
  if (Buffer.byteLength(text, 'utf8') > VERSE_QUEUE_TEXT_MAX_BYTES) {
    throw new VerseQueueError('VERSE_TOO_LARGE', `text exceeds ${VERSE_QUEUE_TEXT_MAX_BYTES} bytes`);
  }
  if (text.includes('\0')) throw new VerseQueueError('VERSE_INVALID', 'text must not contain NUL bytes');
  return text;
}

export function createTurnQueue(root: string, opts: TurnQueueOptions = {}): VerseTurnQueue {
  const dir = join(root, 'queues');
  const now = opts.now ?? (() => new Date());
  const randomId = opts.randomId ?? (() => randomBytes(6).toString('hex'));
  const cache = new Map<string, QueueState>();
  let scanned = false;

  function pathFor(sessionId: string): string {
    return join(dir, `${sessionId}.json`);
  }

  function load(sessionId: string): QueueState {
    const cached = cache.get(sessionId);
    if (cached) return cached;
    let state = emptyState();
    const path = pathFor(sessionId);
    if (existsSync(path)) {
      try {
        const parsed = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
        const items = Array.isArray(parsed['items'])
          ? (parsed['items'] as unknown[]).filter((item) => isQueuedTurn(item, sessionId)).slice(0, VERSE_QUEUE_MAX)
          : [];
        state = {
          items,
          held: parsed['held'] === true && items.length > 0,
          heldReason: typeof parsed['heldReason'] === 'string' ? parsed['heldReason'] : null,
          heldAt: typeof parsed['heldAt'] === 'string' ? parsed['heldAt'] : null,
          // A send-now mark never survives a restart: the stop it rode on is gone.
          sendNow: null,
        };
      } catch {
        state = emptyState();
      }
    }
    cache.set(sessionId, state);
    return state;
  }

  function persist(sessionId: string, state: QueueState): void {
    if (state.items.length === 0) {
      state.held = false;
      state.heldReason = null;
      state.heldAt = null;
      state.sendNow = null;
    }
    try {
      if (state.items.length === 0) {
        rmSync(pathFor(sessionId), { force: true });
        return;
      }
      writePrivateFileAtomically(dir, pathFor(sessionId), `${JSON.stringify({
        items: state.items,
        held: state.held,
        heldReason: state.heldReason,
        heldAt: state.heldAt,
      })}\n`);
    } catch (err) {
      // The in-memory queue is still right for this process; only a restart
      // would lose it. Reported, never thrown into a turn's close handler.
      opts.onWriteError?.(sessionId, err);
    }
  }

  function snapshot(sessionId: string, state: QueueState): VerseQueueResponse {
    return {
      sessionId,
      items: state.items.map((item) => ({ ...item })),
      held: state.held && state.items.length > 0,
      heldReason: state.held && state.items.length > 0 ? state.heldReason : null,
    };
  }

  return {
    get(sessionId) {
      return snapshot(sessionId, load(sessionId));
    },

    size(sessionId) {
      return load(sessionId).items.length;
    },

    enqueue(sessionId, text, enqueueOpts = {}) {
      const clean = validateQueuedText(text);
      const state = load(sessionId);
      if (state.items.length >= VERSE_QUEUE_MAX) {
        throw new VerseQueueError('VERSE_QUEUE_FULL', `up to ${VERSE_QUEUE_MAX} follow-ups can wait at once — send or remove one first`);
      }
      let id = randomId();
      if (!/^[0-9a-f]{12}$/.test(id) || state.items.some((item) => item.id === id)) id = randomBytes(6).toString('hex');
      const item: VerseQueuedTurn = { id, sessionId, text: clean, createdAt: now().toISOString() };
      if (enqueueOpts.front) state.items.unshift(item);
      else state.items.push(item);
      persist(sessionId, state);
      return { ...item };
    },

    remove(sessionId, queueId) {
      const state = load(sessionId);
      const index = state.items.findIndex((item) => item.id === queueId);
      if (index < 0) return false;
      state.items.splice(index, 1);
      if (state.sendNow === queueId) state.sendNow = null;
      persist(sessionId, state);
      return true;
    },

    take(sessionId, queueId) {
      const state = load(sessionId);
      const index = queueId === undefined ? 0 : state.items.findIndex((item) => item.id === queueId);
      if (index < 0 || index >= state.items.length) return null;
      const [item] = state.items.splice(index, 1);
      if (item && state.sendNow === item.id) state.sendNow = null;
      persist(sessionId, state);
      return item ? { ...item } : null;
    },

    restore(sessionId, item) {
      const state = load(sessionId);
      if (state.items.some((existing) => existing.id === item.id)) return;
      state.items.unshift({ ...item });
      // Never more than the cap, even when a restore races an enqueue.
      state.items.splice(VERSE_QUEUE_MAX);
      persist(sessionId, state);
    },

    hold(sessionId, reason) {
      const state = load(sessionId);
      if (state.items.length === 0) return;
      if (!state.held) state.heldAt = now().toISOString();
      state.held = true;
      state.heldReason = reason;
      persist(sessionId, state);
    },

    release(sessionId) {
      const state = load(sessionId);
      if (!state.held) return;
      state.held = false;
      state.heldReason = null;
      state.heldAt = null;
      persist(sessionId, state);
    },

    markSendNow(sessionId, queueId) {
      const state = load(sessionId);
      if (!state.items.some((item) => item.id === queueId)) return false;
      state.sendNow = queueId;
      return true;
    },

    takeSendNow(sessionId) {
      const state = load(sessionId);
      const id = state.sendNow;
      state.sendNow = null;
      return id !== null && state.items.some((item) => item.id === id) ? id : null;
    },

    drop(sessionId) {
      cache.set(sessionId, emptyState());
      try { rmSync(pathFor(sessionId), { force: true }); } catch { /* best effort */ }
    },

    listHeld() {
      if (!scanned) {
        scanned = true;
        try {
          for (const name of readdirSync(dir)) {
            const match = /^([A-Za-z0-9][A-Za-z0-9_-]{0,127})\.json$/.exec(name);
            if (match) load(match[1]!);
          }
        } catch {
          /* no queue directory yet: nothing is held */
        }
      }
      const out: Array<VerseQueueResponse & { heldAt: string }> = [];
      for (const [sessionId, state] of cache) {
        if (!state.held || state.items.length === 0) continue;
        out.push({ ...snapshot(sessionId, state), heldAt: state.heldAt ?? new Date(0).toISOString() });
      }
      return out;
    },
  };
}
