import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadOrCreateRemoteVapid } from '../src/core/web/remote-push-vapid.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); dirs.length = 0; });
function root(): string { const path = mkdtempSync(join(tmpdir(), 'ashlr-vapid-')); dirs.push(path); return path; }

describe('remote push VAPID identity', () => {
  it('creates one private key and reloads it without rotation', () => {
    const path = root();
    const first = loadOrCreateRemoteVapid('https://remote.ashlr.ai', path);
    const second = loadOrCreateRemoteVapid('https://remote.ashlr.ai', path);
    expect(second).toEqual(first);
    expect(statSync(join(path, 'remote-push-vapid.json')).mode & 0o077).toBe(0);
    expect(readFileSync(join(path, 'remote-push-vapid.json'), 'utf8')).toContain(first.privateKey);
    expect(() => loadOrCreateRemoteVapid('https://different.example', path)).toThrow(/another origin/);
  });

  it('fails closed on malformed, public, and locked key files', () => {
    const path = root();
    const file = join(path, 'remote-push-vapid.json');
    writeFileSync(file, '{"v":1}', { mode: 0o600 });
    expect(() => loadOrCreateRemoteVapid('https://remote.ashlr.ai', path)).toThrow(/invalid/);
    chmodSync(file, 0o644);
    expect(() => loadOrCreateRemoteVapid('https://remote.ashlr.ai', path)).toThrow(/private/);
    rmSync(file);
    writeFileSync(`${file}.lock`, 'busy', { mode: 0o600 });
    expect(() => loadOrCreateRemoteVapid('https://remote.ashlr.ai', path)).toThrow();
    expect(() => statSync(file)).toThrow();
  });
});
