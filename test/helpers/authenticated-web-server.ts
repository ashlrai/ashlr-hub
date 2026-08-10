import type { AshlrConfig, WebServerHandle, WebServerOptions } from '../../src/core/types.js';
import { startServer as startRealServer } from '../../src/core/web/server.js';

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
