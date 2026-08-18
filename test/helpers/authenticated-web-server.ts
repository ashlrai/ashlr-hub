import type { AshlrConfig, WebServerHandle, WebServerOptions } from '../../src/core/types.js';
import { startServer as startRealServer } from '../../src/core/web/server.js';
import { randomBytes } from 'node:crypto';
import { request } from 'node:http';
import type { ClientRequest } from 'node:http';

const tokensByPort = new Map<number, string>();

/**
 * Real server wrapper for legacy integration tests whose subject is the route
 * behind the read-auth boundary, rather than the boundary itself. Security
 * regressions use startRealServer directly and make unauthenticated requests.
 */
export async function startServer(
  cfg: AshlrConfig,
  opts: WebServerOptions,
): Promise<WebServerHandle> {
  const handle = await startRealServer(cfg, opts);
  tokensByPort.set(handle.port, handle.readToken);
  const close = handle.close.bind(handle);
  return {
    ...handle,
    async close(): Promise<void> {
      tokensByPort.delete(handle.port);
      await close();
    },
  };
}

export function readAuthHeaders(port: number): Record<string, string> {
  const token = tokensByPort.get(port);
  return token ? { 'x-ashlr-token': token } : {};
}

/** Mint the same cookie + query-proof pair used by the browser EventSource. */
export function readSseAuth(
  handle: Pick<WebServerHandle, 'port' | 'readToken'>,
): Promise<{ query: string; headers: Record<string, string> }> {
  const clientProof = randomBytes(32).toString('hex');
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      req.setTimeout(0);
      req.destroy();
      reject(error);
    };
    const req: ClientRequest = request({
      hostname: '127.0.0.1',
      port: handle.port,
      path: '/api/session',
      method: 'POST',
      headers: {
        Host: `127.0.0.1:${handle.port}`,
        'x-ashlr-token': handle.readToken,
        'x-ashlr-read-client': clientProof,
      },
    }, (res) => {
      res.once('aborted', () => fail(new Error('read session exchange response aborted')));
      res.once('error', (error) => fail(error));
      res.once('close', () => {
        if (!res.complete) fail(new Error('read session exchange response closed early'));
      });
      res.resume();
      res.once('end', () => {
        if (settled) return;
        const setCookie = res.headers['set-cookie'];
        const cookie = setCookie?.[0]?.split(';', 1)[0] ?? '';
        if (res.statusCode !== 204 || !cookie.startsWith('ashlr_read_session=')) {
          fail(new Error(`read session exchange failed with status ${res.statusCode ?? 0}`));
          return;
        }
        settled = true;
        req.setTimeout(0);
        resolve({
          query: `?client=${encodeURIComponent(clientProof)}`,
          headers: { Cookie: cookie },
        });
      });
    });
    req.setTimeout(10_000, () => fail(new Error('read session exchange timed out')));
    req.once('error', (error) => fail(error));
    req.end();
  });
}
