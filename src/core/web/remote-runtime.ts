/** Explicit local startup for the dormant phone gateway. No Tunnel/DNS work. */
import { lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseRemoteAccessConfig } from './remote-access.js';
import { createRemoteDeviceStore } from './remote-device-store.js';
import { createRemotePairing } from './remote-pairing.js';
import { startRemoteReadGateway } from './remote-gateway.js';
import { startRemoteAdminSocket } from './remote-admin.js';
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
  const pairing = createRemotePairing(access, devices);
  const gateway = await startRemoteReadGateway({ access, hub: { port: hub.port, readToken: hub.readToken,
    mutationToken: hub.token }, devices, pairing, assetsDir: publicDir, mobileAssetsEnabled: true, port: gatewayPort });
  try {
    const admin = await startRemoteAdminSocket(pairing, devices);
    return { gateway, admin, publicOrigin: access.publicOrigin, async close() {
      await admin.close(); await gateway.close();
    } };
  } catch (error) { await gateway.close(); throw error; }
}
