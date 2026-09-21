/**
 * "Can we bind this port right now?" — one answer, shared by both supervisors.
 *
 * This lived in supervisor.ts and was moved here verbatim when the Anthropic
 * proxy grew a supervisor of its own: proxy-supervisor.ts needs the same
 * question answered, and supervisor.ts already imports proxy-supervisor.ts, so
 * leaving it where it was would have made the two modules import each other.
 * supervisor.ts still re-exports it, so nothing downstream moved.
 */

import { createServer } from 'node:net';

/**
 * Can we bind this port right now?
 *
 * A dead process is not the same as a released port: a socket in TIME_WAIT, or
 * a descendant still holding the listener, both keep the port busy while the
 * pid we killed is gone. `stop` reports the port free only when this says so.
 */
export function isPortFree(host: string, port: number, timeoutMs = 1_000): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    let settled = false;
    const finish = (free: boolean): void => {
      if (settled) return;
      settled = true;
      try {
        server.close();
      } catch {
        // Already closed.
      }
      resolve(free);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
    server.once('error', () => {
      clearTimeout(timer);
      finish(false);
    });
    server.listen({ host, port, exclusive: true }, () => {
      clearTimeout(timer);
      finish(true);
    });
  });
}
