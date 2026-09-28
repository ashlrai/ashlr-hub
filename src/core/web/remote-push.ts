/**
 * Dormant, per-credential Web Push sender for the phone gateway. No app data,
 * agent text, repository name, or identifier is sent to a push service.
 * The service worker renders one of two fixed notifications after delivery.
 */
import { constants, closeSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, rmSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import webpush, { type PushSubscription } from 'web-push';
import { defaultVerseRoot } from '../verse/preferences.js';
import { writePrivateFileAtomically } from '../verse/session-store.js';
import type { RemoteDeviceStore } from './remote-device-store.js';

const FILE = 'remote-push.json';
const MAX_FILE_BYTES = 262_144;
const COALESCE_MS = 60_000;
const MAX_SUBSCRIPTIONS = 32;
const ENCODED = /^[A-Za-z0-9_-]+$/;
export type RemotePushKind = 'needs-you' | 'completed';

interface Entry { deviceId: string; subject: string; subscription: PushSubscription; createdAt: number }
interface Registry { v: 1; entries: Entry[] }

export interface RemotePushConfig {
  publicKey: string;
  privateKey: string;
  /** A stable HTTPS or mailto contact for VAPID, never localhost. */
  subject: string;
}

function privatePath(path: string, directory: boolean): void {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile())
    || (stat.mode & 0o077) !== 0 || (typeof process.getuid === 'function' && stat.uid !== process.getuid())) {
    throw new Error('Remote push store is not private');
  }
}

function validEndpoint(value: unknown): value is string {
  if (typeof value !== 'string' || value.length < 30 || value.length > 2048 || !value.startsWith('https://')) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.hash && !url.port
      && url.hostname.endsWith('.push.apple.com') && url.pathname.length > 1;
  } catch { return false; }
}

function validSubscription(value: unknown): value is PushSubscription {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (!Object.keys(record).every((key) => ['endpoint', 'expirationTime', 'keys'].includes(key))
    || !validEndpoint(record.endpoint)) return false;
  if (record.expirationTime !== undefined && record.expirationTime !== null
    && (!Number.isSafeInteger(record.expirationTime) || (record.expirationTime as number) <= Date.now())) return false;
  if (!record.keys || typeof record.keys !== 'object' || Array.isArray(record.keys)) return false;
  const keys = record.keys as Record<string, unknown>;
  return Object.keys(keys).length === 2 && typeof keys.p256dh === 'string' && typeof keys.auth === 'string'
    && ENCODED.test(keys.p256dh) && ENCODED.test(keys.auth)
    && Buffer.from(keys.p256dh, 'base64url').length === 65 && Buffer.from(keys.auth, 'base64url').length === 16;
}

function validConfig(value: RemotePushConfig): boolean {
  if (!value || typeof value !== 'object' || typeof value.publicKey !== 'string'
    || typeof value.privateKey !== 'string' || typeof value.subject !== 'string') return false;
  if (!ENCODED.test(value.publicKey) || !ENCODED.test(value.privateKey)
    || Buffer.from(value.publicKey, 'base64url').length !== 65
    || Buffer.from(value.privateKey, 'base64url').length !== 32) return false;
  if (value.subject.startsWith('mailto:')) return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value.subject.slice(7));
  try {
    const url = new URL(value.subject);
    return url.protocol === 'https:' && url.origin === value.subject && url.hostname.includes('.')
      && url.hostname !== 'localhost' && !url.hostname.endsWith('.localhost');
  } catch { return false; }
}

function validEntry(value: unknown): value is Entry {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  return typeof entry.deviceId === 'string' && /^[a-f0-9-]{36}$/.test(entry.deviceId)
    && typeof entry.subject === 'string' && /^[A-Za-z0-9_-]{8,256}$/.test(entry.subject)
    && validSubscription(entry.subscription) && Number.isSafeInteger(entry.createdAt)
    && (entry.createdAt as number) > 0;
}

/** The caller mounts HTTP routes only after Access, device-session and CSRF checks. */
export function createRemotePush(config: RemotePushConfig, devices: RemoteDeviceStore,
  options: { root?: string; now?: () => number; send?: typeof webpush.sendNotification } = {}) {
  if (!validConfig(config)) throw new Error('Invalid remote Web Push configuration');
  const root = options.root ?? defaultVerseRoot();
  const path = join(root, FILE);
  const lockPath = `${path}.lock`;
  const now = options.now ?? Date.now;
  const send = options.send ?? webpush.sendNotification;
  const lastSent = new Map<string, number>();
  const offRevoke = devices.onRevoked((id) => { try { removeDevice(id); } catch { /* fail closed at send-time */ } });

  function exists(target: string): boolean {
    try { lstatSync(target); return true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
  }
  function read(): Registry {
    if (!exists(root)) return { v: 1, entries: [] };
    privatePath(root, true);
    if (!exists(path)) return { v: 1, entries: [] };
    privatePath(path, false);
    if (lstatSync(path).size > MAX_FILE_BYTES) throw new Error('Remote push store is too large');
    let data: unknown;
    try { data = JSON.parse(readFileSync(path, 'utf8')) as unknown; }
    catch { throw new Error('Remote push store is unreadable'); }
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Remote push store is invalid');
    const registry = data as Record<string, unknown>;
    if (registry.v !== 1 || !Array.isArray(registry.entries) || registry.entries.length > MAX_SUBSCRIPTIONS
      || !registry.entries.every(validEntry)) throw new Error('Remote push store is invalid');
    const entries = registry.entries as Entry[];
    if (new Set(entries.map((entry) => entry.deviceId)).size !== entries.length) throw new Error('Remote push store has duplicate devices');
    return { v: 1, entries };
  }
  function mutate<T>(update: (registry: Registry) => T): T {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    privatePath(root, true);
    const noFollow = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0;
    const fd = openSync(lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow, 0o600);
    try {
      writeSync(fd, `${process.pid}\n`);
      fsyncSync(fd);
      if ((fstatSync(fd).mode & 0o077) !== 0) throw new Error('Remote push lock is not private');
      const registry = read();
      const result = update(registry);
      const bytes = `${JSON.stringify(registry)}\n`;
      if (Buffer.byteLength(bytes) > MAX_FILE_BYTES) throw new Error('Remote push store is too large');
      writePrivateFileAtomically(root, path, bytes);
      return result;
    } finally { closeSync(fd); rmSync(lockPath, { force: true }); }
  }
  function removeDevice(deviceId: string): void {
    mutate((registry) => { registry.entries = registry.entries.filter((entry) => entry.deviceId !== deviceId); });
    lastSent.delete(`${deviceId}:needs-you`);
    lastSent.delete(`${deviceId}:completed`);
  }
  return {
    publicKey: config.publicKey,
    subscribe(deviceId: string, subject: string, subscription: unknown): boolean {
      if (!devices.getActive(deviceId, subject) || !validSubscription(subscription)) return false;
      const entry: Entry = { deviceId, subject,
        subscription: { endpoint: subscription.endpoint, keys: { ...subscription.keys } }, createdAt: now() };
      mutate((registry) => {
        registry.entries = registry.entries.filter((existing) => existing.deviceId !== deviceId);
        if (registry.entries.length >= MAX_SUBSCRIPTIONS) throw new Error('Remote push subscriptions are full');
        registry.entries.push(entry);
      });
      return true;
    },
    unsubscribe(deviceId: string, subject: string): boolean {
      if (!devices.getActive(deviceId, subject)) return false;
      removeDevice(deviceId);
      return true;
    },
    async send(kind: RemotePushKind): Promise<{ attempted: number; delivered: number; retired: number }> {
      if (kind !== 'needs-you' && kind !== 'completed') throw new Error('Invalid push kind');
      let attempted = 0;
      let delivered = 0;
      let retired = 0;
      for (const entry of read().entries) {
        if (!devices.getActive(entry.deviceId, entry.subject)) { removeDevice(entry.deviceId); retired++; continue; }
        const last = lastSent.get(`${entry.deviceId}:${kind}`) ?? 0;
        if (now() - last < COALESCE_MS) continue;
        attempted++;
        // Bound delivery attempts as well as successes during a provider outage.
        lastSent.set(`${entry.deviceId}:${kind}`, now());
        try {
          await send(entry.subscription, JSON.stringify({ kind }), { vapidDetails: config, TTL: 300,
            timeout: 5_000, urgency: kind === 'needs-you' ? 'high' : 'normal', topic: `ashlr-${kind}` });
          delivered++;
        } catch (error) {
          const status = (error as { statusCode?: unknown }).statusCode;
          if (status === 404 || status === 410) { removeDevice(entry.deviceId); retired++; }
        }
      }
      return { attempted, delivered, retired };
    },
    close(): void { offRevoke(); },
  };
}
