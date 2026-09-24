/**
 * dock/terminal/input-queue.ts — keystrokes to the shell, in order (unit C4).
 *
 * Every keystroke is a POST. Two POSTs in flight at once may arrive in either
 * order, and a shell that receives `sl` for `ls` runs the wrong command. So
 * input is SINGLE-FLIGHT: while one request is out, everything typed after it
 * accumulates and goes as the next request — in order, and coalesced (a burst
 * of typing or a paste becomes one or a few requests, not hundreds). The
 * server takes at most 16 KB per request, so a long paste is sent in 16 KB
 * slices, one after another.
 */
import { VERSE_TERMINAL_INPUT_MAX_BYTES } from '../../../../../core/verse/workbench-types.js';
import { bytesToBase64 } from './terminal-client.js';

export interface InputQueue {
  /** Text as xterm reports it (a JS string — encoded as UTF-8). */
  pushText(text: string): void;
  /** xterm `onBinary` data: one char per byte (0–255). */
  pushBinary(binary: string): void;
  /** Resolves once everything pushed so far has been sent (or dropped on error). */
  idle(): Promise<void>;
  /** Stop sending; anything queued is dropped. */
  dispose(): void;
}

export function createInputQueue(
  send: (dataBase64: string) => Promise<void>,
  opts: { maxBytes?: number; onError?: (err: unknown) => void } = {},
): InputQueue {
  const maxBytes = opts.maxBytes ?? VERSE_TERMINAL_INPUT_MAX_BYTES;
  const encoder = new TextEncoder();
  let pending: Uint8Array[] = [];
  let pendingBytes = 0;
  let running: Promise<void> | null = null;
  let disposed = false;

  const take = (): Uint8Array => {
    const all = new Uint8Array(pendingBytes);
    let offset = 0;
    for (const chunk of pending) {
      all.set(chunk, offset);
      offset += chunk.length;
    }
    const head = all.subarray(0, Math.min(maxBytes, all.length));
    const rest = all.subarray(head.length);
    pending = rest.length > 0 ? [rest] : [];
    pendingBytes = rest.length;
    return head;
  };

  const pump = async (): Promise<void> => {
    while (!disposed && pendingBytes > 0) {
      const slice = take();
      try {
        await send(bytesToBase64(slice));
      } catch (err) {
        // A failed keystroke is not retried: replaying it later, after newer
        // input, is exactly the reordering this queue exists to prevent.
        pending = [];
        pendingBytes = 0;
        opts.onError?.(err);
      }
    }
    running = null;
  };

  const push = (bytes: Uint8Array): void => {
    if (disposed || bytes.length === 0) return;
    pending.push(bytes);
    pendingBytes += bytes.length;
    if (!running) running = pump();
  };

  return {
    pushText(text) {
      push(encoder.encode(text));
    },
    pushBinary(binary) {
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i) & 0xff;
      push(bytes);
    },
    idle() {
      return running ?? Promise.resolve();
    },
    dispose() {
      disposed = true;
      pending = [];
      pendingBytes = 0;
    },
  };
}
