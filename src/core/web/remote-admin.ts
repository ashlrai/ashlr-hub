/** Mac-only Unix socket for pairing custody. Never route this through Tunnel. */
import { chmodSync, lstatSync, mkdirSync, unlinkSync } from 'node:fs';
import { createConnection, createServer, type Server } from 'node:net';
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { defaultVerseRoot } from '../verse/preferences.js';
import type { createRemotePairing } from './remote-pairing.js';
import type { RemoteDeviceStore } from './remote-device-store.js';

const SOCKET_NAME = 'remote-admin.sock';
const MAX_COMMAND = 4096;
type Pairing = ReturnType<typeof createRemotePairing>;
type OperatorAction = 'invite' | 'approve' | 'deny' | 'revoke';
export type ConfirmMacOperator = (action: OperatorAction, id: string) => Promise<boolean>;

export function remoteAdminSocketPath(root = defaultVerseRoot()): string { return join(root, SOCKET_NAME); }

function privateDirectory(root: string): void {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const stat = lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0
    || (typeof process.getuid === 'function' && stat.uid !== process.getuid())) {
    throw new Error('Remote operator directory is not private');
  }
}

function existingSocket(path: string) {
  try { return lstatSync(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

/** A killed sidecar leaves its Unix socket pathname behind. Reclaim only a
 * private socket owned by this user after a connection proves no listener is
 * alive; never remove a regular file, symlink, or another process's socket. */
async function clearStaleSocket(root: string, path: string): Promise<void> {
  const before = existingSocket(path);
  if (!before) return;
  if (!before.isSocket() || (before.mode & 0o077) !== 0
    || (typeof process.getuid === 'function' && before.uid !== process.getuid())) {
    throw new Error('Remote admin socket path is not a private owned socket');
  }
  const stale = await new Promise<boolean>((resolve, reject) => {
    const probe = createConnection(path);
    probe.setTimeout(1_000, () => probe.destroy(new Error('Remote admin socket probe timed out')));
    probe.once('connect', () => { probe.destroy(); resolve(false); });
    probe.once('error', (error: NodeJS.ErrnoException) => {
      // A retiring sidecar can unlink its socket between lstat and connect.
      // Recheck below before removing anything; bind still rejects a new listener.
      if (error.code === 'ECONNREFUSED' || error.code === 'ENOENT') resolve(true);
      else reject(error);
    });
  });
  if (!stale) throw new Error('Remote admin socket already has a live listener');
  privateDirectory(root);
  const after = existingSocket(path);
  if (!after) return;
  if (!after.isSocket() || (after.mode & 0o077) !== 0
    || (typeof process.getuid === 'function' && after.uid !== process.getuid())
    || after.ino !== before.ino || after.dev !== before.dev) {
    throw new Error('Remote admin socket changed during stale recovery');
  }
  unlinkSync(path);
}

/** A same-UID agent can reach a user socket, so require a visible Mac choice. */
async function confirmMacOperator(action: OperatorAction, id: string): Promise<boolean> {
  if (process.platform !== 'darwin') return false;
  const message = `${action.toUpperCase()} Ashlr phone access for ${id}? Check the pending device in the Mac terminal first.`;
  const script = `display dialog ${JSON.stringify(message)} buttons {"Cancel", "Approve"} default button "Cancel" cancel button "Cancel" with icon caution`;
  return new Promise((resolve) => {
    execFile('/usr/bin/osascript', ['-e', script], { timeout: 60_000, maxBuffer: 1024 }, (error) => resolve(!error));
  });
}

async function command(pairing: Pairing, devices: RemoteDeviceStore, input: unknown, confirm: ConfirmMacOperator): Promise<unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { error: 'Invalid operator command' };
  const value = input as Record<string, unknown>;
  switch (value.action) {
    case 'invite': {
      if (typeof value.subject !== 'string' || (value.scope !== 'read' && value.scope !== 'act')) return { error: 'Invalid invitation' };
      if (!(await confirm('invite', value.subject))) return { error: 'Mac operator confirmation required' };
      const result = pairing.mac.issueInvitation(value.subject, { read: true, act: value.scope === 'act' });
      return result ?? { error: 'Invitation unavailable' };
    }
    case 'pending': return { approvals: pairing.mac.pendingApprovals() };
    case 'devices': return { devices: devices.list().map((d) => ({ id: d.id, label: d.label, email: d.email,
      subject: d.subject, scopes: d.scopes, createdAt: d.createdAt, revokedAt: d.revokedAt })) };
    case 'approve': {
      if (typeof value.id !== 'string' || !/^[0-9a-f-]{36}$/.test(value.id)) return { error: 'Invalid pairing ID' };
      if (!(await confirm('approve', value.id))) return { error: 'Mac operator confirmation required' };
      const approved = pairing.mac.approvePairing(value.id, { approved: true });
      return approved ? { approved: true, deviceId: approved.id } : { error: 'Pairing unavailable' };
    }
    case 'deny': {
      if (typeof value.id !== 'string' || !/^[0-9a-f-]{36}$/.test(value.id)) return { error: 'Invalid pairing ID' };
      if (!(await confirm('deny', value.id))) return { error: 'Mac operator confirmation required' };
      pairing.mac.denyPairing(value.id); return { denied: true };
    }
    case 'revoke': {
      if (typeof value.id !== 'string' || !/^[0-9a-f-]{36}$/.test(value.id)) return { error: 'Invalid device ID' };
      if (!(await confirm('revoke', value.id))) return { error: 'Mac operator confirmation required' };
      return { revoked: pairing.mac.revokeDevice(value.id) };
    }
    default: return { error: 'Unknown operator command' };
  }
}

/** The socket is mode 0600 in a private directory; no HTTP endpoint exists. */
export async function startRemoteAdminSocket(pairing: Pairing, devices: RemoteDeviceStore, root = defaultVerseRoot(),
  confirmOperator: ConfirmMacOperator = confirmMacOperator) {
  privateDirectory(root);
  const path = remoteAdminSocketPath(root);
  await clearStaleSocket(root, path);
  let confirmationBusy = false;
  const guardedConfirm: ConfirmMacOperator = async (action, id) => {
    if (confirmationBusy) return false;
    confirmationBusy = true;
    try { return await confirmOperator(action, id); }
    finally { confirmationBusy = false; }
  };
  const server: Server = createServer((socket) => {
    let text = '';
    socket.setTimeout(75_000, () => socket.destroy());
    socket.on('data', (chunk: Buffer) => {
      text += chunk.toString('utf8');
      if (Buffer.byteLength(text) > MAX_COMMAND) { socket.destroy(); return; }
      const end = text.indexOf('\n');
      if (end < 0) return;
      socket.removeAllListeners('data');
      void (async () => {
        let answer: unknown;
        try { answer = await command(pairing, devices, JSON.parse(text.slice(0, end)) as unknown, guardedConfirm); }
        catch { answer = { error: 'Invalid operator command' }; }
        socket.end(`${JSON.stringify(answer)}\n`);
      })();
    });
    socket.on('error', () => {});
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(path, resolve);
  });
  const identity = lstatSync(path);
  try {
    chmodSync(path, 0o600);
    const secured = lstatSync(path);
    if (!secured.isSocket() || (secured.mode & 0o077) !== 0
      || secured.ino !== identity.ino || secured.dev !== identity.dev) throw new Error('Remote admin socket is not private');
  } catch (error) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    try {
      const current = lstatSync(path);
      if (current.ino === identity.ino && current.dev === identity.dev) unlinkSync(path);
    } catch { /* a replaced path is never removed */ }
    throw error;
  }
  return {
    path,
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      try {
        const current = lstatSync(path);
        if (current.ino === identity.ino && current.dev === identity.dev) unlinkSync(path);
      } catch { /* preserve a replaced path */ }
    },
  };
}

export async function sendRemoteAdminCommand(input: unknown, root = defaultVerseRoot()): Promise<unknown> {
  privateDirectory(root);
  return new Promise((resolve, reject) => {
    const socket = createConnection(remoteAdminSocketPath(root));
    let text = '';
    socket.setTimeout(75_000, () => socket.destroy(new Error('Remote operator command timed out')));
    socket.on('connect', () => socket.write(`${JSON.stringify(input)}\n`));
    socket.on('data', (chunk: Buffer) => {
      text += chunk.toString('utf8');
      if (Buffer.byteLength(text) > MAX_COMMAND) { socket.destroy(new Error('Remote operator response too large')); return; }
      const end = text.indexOf('\n');
      if (end >= 0) {
        try { resolve(JSON.parse(text.slice(0, end)) as unknown); socket.end(); }
        catch { reject(new Error('Invalid remote operator response')); socket.destroy(); }
      }
    });
    socket.on('error', reject);
    socket.on('close', () => { if (!text.includes('\n')) reject(new Error('Remote operator socket closed')); });
  });
}
