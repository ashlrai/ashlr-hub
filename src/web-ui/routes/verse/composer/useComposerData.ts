/**
 * routes/verse/composer/useComposerData.ts — the composer's three live
 * resources, one hook each (unit C3):
 *
 *   useSessionControls  model / effort / permission for this chat + options
 *   useFollowUpQueue    the server-side queue of follow-ups
 *   useAttachmentDrafts files attached to the message being written
 *
 * None of them polls. Controls and the queue are re-read when the chat's
 * turn starts or ends (`running` flips) — the only moments the server changes
 * them on its own — and after each of the composer's own writes. A chat that
 * is not open costs nothing.
 *
 * Every write goes through the caller's token gate (`run`): with no mutation
 * token held, the gate asks for one and resolves null if dismissed, so a
 * refused unlock reads as "not done", never as an error.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  VerseAttachment,
  VerseQueueResponse,
  VerseSessionControlsResponse,
  VerseSessionControlsUpdate,
} from '../../../../core/verse/workbench-types.js';
import { VERSE_ATTACHMENT_MAX_BYTES } from '../../../../core/verse/workbench-types.js';
import { describeContextError } from '../context/use-token-gate.js';
import {
  deleteAttachment,
  enqueueFollowUp,
  fetchQueue,
  fetchSessionControls,
  removeFollowUp,
  sendFollowUpNow,
  updateSessionControls,
  uploadAttachment,
  type VerseQueueSendResult,
} from './composer-queries.js';
import { formatBytes, readFileAsBase64 } from './composer-text.js';

export type GateRun = <T>(reason: string, action: () => Promise<T>) => Promise<T | null>;

// ---------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------

export interface SessionControlsState {
  view: VerseSessionControlsResponse | null;
  /** True until the first read answered (or failed). */
  loading: boolean;
  /** Why the last read or write failed, in the server's words. */
  error: string | null;
  pending: boolean;
  update: (update: VerseSessionControlsUpdate, reason: string) => Promise<boolean>;
}

export function useSessionControls(sessionId: string | null, running: boolean, run: GateRun): SessionControlsState {
  const [view, setView] = useState<VerseSessionControlsResponse | null>(null);
  const [loading, setLoading] = useState(sessionId !== null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    if (!sessionId) {
      setView(null);
      setLoading(false);
      return undefined;
    }
    const abort = new AbortController();
    fetchSessionControls(sessionId, abort.signal)
      .then((next) => { setView(next); setError(null); })
      .catch((err: unknown) => {
        if (abort.signal.aborted) return;
        // An older server (no route) leaves the pickers hidden rather than broken.
        setView(null);
        setError(describeContextError(err));
      })
      .finally(() => { if (!abort.signal.aborted) setLoading(false); });
    return () => abort.abort();
    // `running` is a dependency on purpose: `appliesNextTurn` flips with it.
  }, [sessionId, running]);

  const update = useCallback(async (change: VerseSessionControlsUpdate, reason: string): Promise<boolean> => {
    if (!sessionId) return false;
    setPending(true);
    setError(null);
    try {
      const next = await run(reason, () => updateSessionControls(sessionId, change));
      if (!next) return false;
      setView(next);
      return true;
    } catch (err) {
      setError(describeContextError(err));
      return false;
    } finally {
      setPending(false);
    }
  }, [sessionId, run]);

  return { view, loading, error, pending, update };
}

// ---------------------------------------------------------------------------
// Queue
// ---------------------------------------------------------------------------

/**
 * The queue as the composer may trust it. The route is C3's and additive, so
 * a server mid-upgrade (or a stub answering `{}`) can send a body without
 * `items`; reading `queue.items.length` off that crashed the whole composer.
 * Anything malformed reads as "no queue" (the 3.9 behaviour), a partial body
 * keeps only well-formed items, and `held` is true only when it says so.
 */
export function normalizeQueue<T extends VerseQueueResponse>(raw: unknown): T | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const body = raw as Partial<Record<keyof VerseQueueResponse | 'sentTurnId', unknown>>;
  if (!Array.isArray(body.items)) return null;
  const items = body.items.filter((item): item is VerseQueueResponse['items'][number] => {
    if (item === null || typeof item !== 'object') return false;
    const i = item as Record<string, unknown>;
    return typeof i['id'] === 'string' && typeof i['text'] === 'string';
  });
  return {
    ...(body as object),
    sessionId: typeof body.sessionId === 'string' ? body.sessionId : '',
    items,
    held: body.held === true,
    heldReason: typeof body.heldReason === 'string' ? body.heldReason : null,
  } as T;
}

export interface FollowUpQueueState {
  queue: VerseQueueResponse | null;
  error: string | null;
  /** Queue (or, when nothing runs, send) a follow-up. Null when not done. */
  enqueue: (text: string, opts?: { sendNow?: boolean }) => Promise<VerseQueueSendResult | null>;
  remove: (queueId: string) => Promise<boolean>;
  sendNow: (queueId: string) => Promise<boolean>;
  refresh: () => void;
  clearError: () => void;
}

export function useFollowUpQueue(sessionId: string | null, running: boolean, run: GateRun): FollowUpQueueState {
  const [queue, setQueue] = useState<VerseQueueResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (!sessionId) {
      setQueue(null);
      return undefined;
    }
    const abort = new AbortController();
    fetchQueue(sessionId, abort.signal)
      .then((next) => { if (!abort.signal.aborted) setQueue(normalizeQueue(next)); })
      // No route (older server) = no queue; the composer then behaves as 3.9.
      .catch(() => { if (!abort.signal.aborted) setQueue(null); });
    return () => abort.abort();
  }, [sessionId, running, nonce]);

  const write = useCallback(async <T extends VerseQueueResponse>(reason: string, action: () => Promise<T>): Promise<T | null> => {
    setError(null);
    try {
      const raw = await run(reason, action);
      if (raw === null) return null;
      // A write that answered with no readable queue still happened: keep
      // the queue we had rather than blanking it, and report it done.
      const result = normalizeQueue<T>(raw);
      if (result) setQueue(result);
      return result ?? raw;
    } catch (err) {
      setError(describeContextError(err));
      return null;
    }
  }, [run]);

  const enqueue = useCallback((text: string, opts: { sendNow?: boolean } = {}) => {
    if (!sessionId) return Promise.resolve(null);
    return write(opts.sendNow ? 'Stop the running turn and send this next.' : 'Queue this message to send when the turn ends.',
      () => enqueueFollowUp(sessionId, text, opts));
  }, [sessionId, write]);

  const remove = useCallback(async (queueId: string) => {
    if (!sessionId) return false;
    return (await write('Remove this queued message.', () => removeFollowUp(sessionId, queueId))) !== null;
  }, [sessionId, write]);

  const sendNow = useCallback(async (queueId: string) => {
    if (!sessionId) return false;
    return (await write('Send this queued message now.', () => sendFollowUpNow(sessionId, queueId))) !== null;
  }, [sessionId, write]);

  const refresh = useCallback(() => setNonce((n) => n + 1), []);
  const clearError = useCallback(() => setError(null), []);

  return { queue, error, enqueue, remove, sendNow, refresh, clearError };
}

// ---------------------------------------------------------------------------
// Attachments
// ---------------------------------------------------------------------------

export interface AttachmentDraft {
  /** Client id (stable across the upload). */
  key: string;
  name: string;
  mime: string;
  bytes: number;
  status: 'uploading' | 'ready' | 'error';
  /** Object URL for an image thumbnail; revoked when the chip goes. */
  previewUrl: string | null;
  error: string | null;
  attachment: VerseAttachment | null;
}

export interface AttachmentDraftsState {
  drafts: AttachmentDraft[];
  /** Upload files; `onReady` fires once per file with its `@path` token. */
  add: (files: readonly File[], onReady: (ref: string) => void) => void;
  remove: (key: string) => Promise<string | null>;
  /** Forget the chips (after a send) without deleting the files, which the sent message names. */
  reset: () => void;
  uploading: boolean;
}

let draftCounter = 0;

export function useAttachmentDrafts(sessionId: string | null, run: GateRun): AttachmentDraftsState {
  const [drafts, setDrafts] = useState<AttachmentDraft[]>([]);
  const urls = useRef(new Set<string>());

  // Every object URL is released with the component (a chat switch unmounts it).
  useEffect(() => () => {
    for (const url of urls.current) URL.revokeObjectURL(url);
    urls.current.clear();
  }, []);

  const patch = useCallback((key: string, change: Partial<AttachmentDraft>) => {
    setDrafts((list) => list.map((d) => (d.key === key ? { ...d, ...change } : d)));
  }, []);

  const add = useCallback((files: readonly File[], onReady: (ref: string) => void) => {
    if (!sessionId) return;
    for (const file of files) {
      draftCounter += 1;
      const key = `att-${draftCounter}`;
      const image = file.type.startsWith('image/');
      let previewUrl: string | null = null;
      if (image && typeof URL.createObjectURL === 'function') {
        previewUrl = URL.createObjectURL(file);
        urls.current.add(previewUrl);
      }
      const name = file.name || (image ? 'pasted-image.png' : 'attachment');
      const mime = file.type || 'application/octet-stream';
      const draft: AttachmentDraft = { key, name, mime, bytes: file.size, status: 'uploading', previewUrl, error: null, attachment: null };
      setDrafts((list) => [...list, draft]);
      if (file.size > VERSE_ATTACHMENT_MAX_BYTES) {
        patch(key, { status: 'error', error: `${formatBytes(file.size)} — each file must be ${formatBytes(VERSE_ATTACHMENT_MAX_BYTES)} or smaller` });
        continue;
      }
      if (file.size === 0) {
        patch(key, { status: 'error', error: 'The file is empty.' });
        continue;
      }
      void (async () => {
        try {
          const dataBase64 = await readFileAsBase64(file);
          const saved = await run('Attach this file to the chat.', () => uploadAttachment(sessionId, { name, mime, dataBase64 }));
          if (!saved) {
            patch(key, { status: 'error', error: 'Not attached — the chat is locked.' });
            return;
          }
          patch(key, { status: 'ready', attachment: saved, name: saved.name });
          onReady(saved.ref);
        } catch (err) {
          patch(key, { status: 'error', error: describeContextError(err) });
        }
      })();
    }
  }, [sessionId, run, patch]);

  const remove = useCallback(async (key: string): Promise<string | null> => {
    const draft = drafts.find((d) => d.key === key);
    if (!draft) return null;
    setDrafts((list) => list.filter((d) => d.key !== key));
    if (draft.previewUrl) {
      URL.revokeObjectURL(draft.previewUrl);
      urls.current.delete(draft.previewUrl);
    }
    if (draft.attachment && sessionId) {
      const attachment = draft.attachment;
      try {
        await run('Remove this attachment.', () => deleteAttachment(sessionId, attachment.id));
      } catch {
        // Already gone on the server: the chip's removal is what matters.
      }
      return attachment.ref;
    }
    return null;
  }, [drafts, sessionId, run]);

  const reset = useCallback(() => {
    setDrafts((list) => {
      for (const d of list) {
        if (d.previewUrl) {
          URL.revokeObjectURL(d.previewUrl);
          urls.current.delete(d.previewUrl);
        }
      }
      return [];
    });
  }, []);

  return { drafts, add, remove, reset, uploading: drafts.some((d) => d.status === 'uploading') };
}
