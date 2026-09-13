/** Bounded reads of the mission-owned console, never an alternate worker transport. */
import type { ResourceConsoleServerHandle } from '../web/resource-console-server.js';

export class MissionConsoleRequestError extends Error {}
export async function requestEngineeringMissionConsole<T>(options: {
  handle: ResourceConsoleServerHandle; path: string; body?: unknown; signal: AbortSignal;
  remainingMs(): number; assertActive(): void; wait(): Promise<void>;
}): Promise<T> {
  const { handle, path, body } = options;
  const origin = new URL(handle.url);
  if (origin.protocol !== 'http:' || origin.hostname !== '127.0.0.1' || origin.origin !== handle.url ||
      !path.startsWith('/api/resources') || new URL(path, origin).origin !== origin.origin) {
    throw new MissionConsoleRequestError('Mission console unavailable');
  }
  for (;;) {
    options.assertActive();
    const remaining = options.remainingMs();
    if (!Number.isFinite(remaining) || remaining <= 0) throw new MissionConsoleRequestError('Mission execution stopped');
    const response = await fetch(handle.url + path, { method: body === undefined ? 'GET' : 'POST', redirect: 'error',
      headers: { 'x-ashlr-token': body === undefined ? handle.readToken : handle.controlToken!, origin: handle.url, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.any([options.signal,
        AbortSignal.timeout(Math.max(1, Math.floor(Math.min(60_000, remaining))))]) });
    // Snapshots may be unavailable while a worker publishes evidence. Retry only
    // observation, within the original mission clock. Never replay a mutation,
    // authentication refusal, quota denial or malformed successful response.
    if (body === undefined && response.status === 503) {
      await response.body?.cancel(); options.assertActive(); await options.wait(); continue;
    }
    if (!response.ok || !response.body) {
      await response.body?.cancel(); throw new MissionConsoleRequestError('Mission console request refused');
    }
    const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
    try {
      for (;;) {
        const item = await reader.read(); if (item.done) break; size += item.value.byteLength;
        if (size > 2 * 1024 * 1024) throw new MissionConsoleRequestError('Mission console response exceeds bound');
        chunks.push(item.value);
      }
    } finally { await reader.cancel().catch(() => {}); }
    options.assertActive(); return JSON.parse(Buffer.concat(chunks).toString('utf8')) as T;
  }
}
