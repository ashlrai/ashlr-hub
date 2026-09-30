import { afterEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { remoteAdminSocketPath, sendRemoteAdminCommand, startRemoteAdminSocket } from '../src/core/web/remote-admin.js';

vi.mock('node:net', async (original) => {
  const actual = await original<typeof import('node:net')>();
  return { ...actual, createConnection: vi.fn(actual.createConnection) };
});

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const root = mkdtempSync(join(process.platform === 'darwin' ? '/private/tmp' : tmpdir(), 'ashlr-sock-race-'));
  roots.push(root);
  const path = remoteAdminSocketPath(root);
  const killed = spawnSync(process.execPath, ['-e', `
    const net = require('node:net');
    const fs = require('node:fs');
    net.createServer().listen(process.argv[1], () => {
      fs.chmodSync(process.argv[1], 0o600);
      process.kill(process.pid, 'SIGKILL');
    });
  `, path], { timeout: 5_000 });
  expect(killed.signal).toBe('SIGKILL');
  const pairing = { mac: { pendingApprovals: () => [] } } as unknown as Parameters<typeof startRemoteAdminSocket>[0];
  const devices = { list: () => [] } as unknown as Parameters<typeof startRemoteAdminSocket>[1];
  return { root, path, pairing, devices };
}

describe('remote admin socket startup races', () => {
  it('starts when the old sidecar removes its socket between stat and connect', async () => {
    const f = fixture();
    const actual = await vi.importActual<typeof import('node:net')>('node:net');
    vi.mocked(createConnection).mockImplementationOnce(() => {
      unlinkSync(f.path);
      return actual.createConnection(f.path);
    });
    const admin = await startRemoteAdminSocket(f.pairing, f.devices, f.root, async () => false);
    try {
      expect(await sendRemoteAdminCommand({ action: 'pending' }, f.root)).toEqual({ approvals: [] });
    } finally { await admin.close(); }
    expect(existsSync(f.path)).toBe(false);
  });

  it('preserves a file replacing the socket while its connection probe fails', async () => {
    const f = fixture();
    const actual = await vi.importActual<typeof import('node:net')>('node:net');
    vi.mocked(createConnection).mockImplementationOnce(() => {
      unlinkSync(f.path);
      writeFileSync(f.path, 'preserve this file');
      chmodSync(f.path, 0o600);
      const socket = new actual.Socket();
      queueMicrotask(() => socket.destroy(Object.assign(new Error('socket disappeared'), { code: 'ENOENT' })));
      return socket;
    });
    await expect(startRemoteAdminSocket(f.pairing, f.devices, f.root, async () => false))
      .rejects.toThrow('Remote admin socket changed during stale recovery');
    expect(readFileSync(f.path, 'utf8')).toBe('preserve this file');
  });
});
