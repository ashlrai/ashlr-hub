/** Explicit local startup for the dormant phone gateway. No Tunnel/DNS work. */
import { lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseRemoteAccessConfig } from './remote-access.js';
import { createRemoteDeviceStore } from './remote-device-store.js';
import { startRemoteReadGateway } from './remote-gateway.js';
import { startRemoteAdminSocket } from './remote-admin.js';
import { createRemotePush } from './remote-push.js';
import { createRemotePushWatcher } from './remote-push-watcher.js';
import { loadOrCreateRemoteVapid } from './remote-push-vapid.js';
import { assetsDir } from './server.js';

function readConfig(path: string) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0
    || (typeof process.getuid === 'function' && stat.uid !== process.getuid()) || stat.size > 8192) {
    throw new Error('Remote gateway config must be a private 0600 file owned by this user');
  }
  const value: unknown = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid remote gateway config');
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => key !== 'access' && key !== 'gatewayPort')) throw new Error('Invalid remote gateway config');
  const access = parseRemoteAccessConfig(record.access);
  const gatewayPort = record.gatewayPort;
  if (!access || !Number.isInteger(gatewayPort) || (gatewayPort as number) < 1 || (gatewayPort as number) > 65535) {
    throw new Error('Remote gateway Access config or port is invalid');
  }
  return { access, gatewayPort: gatewayPort as number };
}

/** Must be called only from an explicit Mac operator command. */
export async function startRemoteRuntime(configPath: string, hub: { port: number; readToken: string; token: string }) {
  const { access, gatewayPort } = readConfig(configPath);
  if (gatewayPort === hub.port) throw new Error('Remote gateway must use a separate loopback port');
  const publicDir = assetsDir();
  const shell = lstatSync(join(publicDir, 'next', 'index.html'));
  if (!shell.isFile() || shell.isSymbolicLink()) throw new Error('Phone shell assets are unavailable');
  const devices = createRemoteDeviceStore();
  // Bun's compiled sidecar can evaluate tsyringe before SimpleWebAuthn's
  // transitive polyfill import. Finish this import before loading pairing.
  await import('reflect-metadata');
  const { createRemotePairing } = await import('./remote-pairing.js');
  const pairing = createRemotePairing(access, devices);
  // Explicit remote startup creates a stable private VAPID identity once.
  // Only its public half is exposed by the authenticated gateway route.
  const push = createRemotePush(loadOrCreateRemoteVapid(access.publicOrigin), devices);
  let gateway: Awaited<ReturnType<typeof startRemoteReadGateway>>;
  try {
    gateway = await startRemoteReadGateway({ access, hub: { port: hub.port, readToken: hub.readToken,
      mutationToken: hub.token }, devices, pairing, push, assetsDir: publicDir, mobileAssetsEnabled: true, port: gatewayPort });
  } catch (error) { push.close(); throw error; }
  let admin: Awaited<ReturnType<typeof startRemoteAdminSocket>> | null = null;
  try {
    admin = await startRemoteAdminSocket(pairing, devices);
    const watcher = createRemotePushWatcher({
      read: async (since) => {
        const target = `/api/verse/activity${since ? `?since=${encodeURIComponent(since)}` : ''}`;
        const response = await fetch(`http://127.0.0.1:${hub.port}${target}`, {
          headers: { 'x-ashlr-token': hub.readToken }, redirect: 'manual', signal: AbortSignal.timeout(5_000),
        });
        if (response.status !== 200 || !response.headers.get('content-type')?.startsWith('application/json') || !response.body) {
          throw new Error('Local activity unavailable');
        }
        const reader = response.body.getReader();
        const chunks: Uint8Array[] = [];
        let size = 0;
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > 1024 * 1024) { await reader.cancel(); throw new Error('Local activity too large'); }
            chunks.push(value);
          }
        } finally { reader.releaseLock(); }
        return JSON.parse(Buffer.concat(chunks.map((part) => Buffer.from(part)), size).toString('utf8')) as unknown;
      },
      send: (kind) => push.send(kind),
    });
    watcher.start();
    const activeAdmin = admin;
    return { gateway, admin: activeAdmin, publicOrigin: access.publicOrigin, async close() {
      watcher.stop();
      try { await activeAdmin.close(); }
      finally { await gateway.close(); push.close(); }
    } };
  } catch (error) {
    try { await admin?.close(); }
    finally { await gateway.close(); push.close(); }
    throw error;
  }
}
