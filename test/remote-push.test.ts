import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import webpush from 'web-push';
import { createRemoteDeviceStore, type RemoteDevice } from '../src/core/web/remote-device-store.js';
import { createRemotePush } from '../src/core/web/remote-push.js';

const SUBJECT = '7335d417-61da-459d-899c-0a01c76a2f94';
const DEVICE = '6335d417-61da-459d-899c-0a01c76a2f94';
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); dirs.length = 0; });

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'ashlr-remote-push-'));
  dirs.push(root);
  const devices = createRemoteDeviceStore(root);
  const device: RemoteDevice = { id: DEVICE, label: 'Phone', subject: SUBJECT, email: 'owner@example.com',
    scopes: { read: true, act: true }, credentialId: randomBytes(32).toString('base64url'),
    publicKey: randomBytes(80).toString('base64url'), counter: 0, transports: ['internal'],
    deviceType: 'multiDevice', backedUp: true, createdAt: 1, lastUsedAt: null, revokedAt: null };
  devices.add(device);
  const config = { ...webpush.generateVAPIDKeys(), subject: 'mailto:owner@example.com' };
  const calls: Array<{ payload: string; endpoint: string; options: Record<string, unknown> }> = [];
  let at = Date.now();
  const push = createRemotePush(config, devices, { root, now: () => at,
    send: async (subscription, payload, options) => {
      calls.push({ payload: String(payload), endpoint: subscription.endpoint, options: options as Record<string, unknown> });
      return { statusCode: 201, headers: {}, body: '' };
    } });
  const subscription = { endpoint: 'https://web.push.apple.com/Qabcdefghijklmnopqrstuvwxyz0123456789', expirationTime: null,
    keys: { p256dh: randomBytes(65).toString('base64url'), auth: randomBytes(16).toString('base64url') } };
  return { root, devices, push, calls, subscription, advance: (ms: number) => { at += ms; } };
}

describe('dormant remote Web Push sender', () => {
  it('stores an active credential subscription privately and sends only fixed categories', async () => {
    const f = fixture();
    expect(f.push.subscribe(DEVICE, SUBJECT, f.subscription)).toBe(true);
    const path = join(f.root, 'remote-push.json');
    expect(statSync(path).mode & 0o077).toBe(0);
    expect(readFileSync(path, 'utf8')).toContain('web.push.apple.com');
    expect(await f.push.send('needs-you')).toEqual({ attempted: 1, delivered: 1, retired: 0 });
    expect(f.calls[0]?.payload).toBe('{"kind":"needs-you"}');
    expect(f.calls[0]?.options).toMatchObject({ TTL: 300, urgency: 'high', topic: 'ashlr-needs-you' });
    expect(f.calls[0]?.payload).not.toContain(SUBJECT);
    expect(await f.push.send('needs-you')).toEqual({ attempted: 0, delivered: 0, retired: 0 });
    expect(f.push.subscribe(DEVICE, SUBJECT, f.subscription)).toBe(true);
    expect(await f.push.send('needs-you')).toEqual({ attempted: 1, delivered: 1, retired: 0 });
    f.advance(60_001);
    expect(await f.push.send('completed')).toEqual({ attempted: 1, delivered: 1, retired: 0 });
    expect(f.calls[2]?.payload).toBe('{"kind":"completed"}');
    f.push.close();
  });

  it('rejects unpaired subjects and endpoint SSRF attempts', () => {
    const f = fixture();
    expect(f.push.subscribe(DEVICE, 'other-subject', f.subscription)).toBe(false);
    for (const endpoint of [
      'http://web.push.apple.com/Qtoken', 'https://127.0.0.1/Qtoken',
      'https://web.push.apple.com.evil.example/Qtoken',
      'https://user@web.push.apple.com/Qtoken', 'https://web.push.apple.com:8080/Qtoken',
    ]) expect(f.push.subscribe(DEVICE, SUBJECT, { ...f.subscription, endpoint })).toBe(false);
    expect(f.push.subscribe(DEVICE, SUBJECT, { ...f.subscription, keys: { p256dh: 'bad', auth: 'bad' } })).toBe(false);
    expect(f.push.subscribe(DEVICE, SUBJECT, f.subscription)).toBe(true);
    f.devices.revoke(DEVICE, Date.now());
    expect(readFileSync(join(f.root, 'remote-push.json'), 'utf8')).not.toContain('web.push.apple.com');
    expect(f.push.subscribe(DEVICE, SUBJECT, f.subscription)).toBe(false);
    f.push.close();
  });

  it('retires endpoints the push service marks gone', async () => {
    const f = fixture();
    const gone = createRemotePush({ ...webpush.generateVAPIDKeys(), subject: 'mailto:owner@example.com' }, f.devices,
      { root: f.root, send: async () => { throw Object.assign(new Error('gone'), { statusCode: 410 }); } });
    expect(gone.subscribe(DEVICE, SUBJECT, f.subscription)).toBe(true);
    expect(await gone.send('needs-you')).toEqual({ attempted: 1, delivered: 0, retired: 1 });
    expect(await gone.send('needs-you')).toEqual({ attempted: 0, delivered: 0, retired: 0 });
    gone.close();
    f.push.close();
  });
});
