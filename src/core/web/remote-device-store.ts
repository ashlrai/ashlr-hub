/**
 * Private, durable registry for paired browser credentials. No bearer token or
 * authentication challenge is persisted here. Each read reloads the file so a
 * revocation in another store instance is visible before the next operation.
 */
import { constants, closeSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, rmSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { defaultVerseRoot } from '../verse/preferences.js';
import { writePrivateFileAtomically } from '../verse/session-store.js';

export interface RemoteDevice {
  id: string;
  label: string;
  subject: string;
  email: string;
  scopes: { read: true; act: boolean };
  credentialId: string;
  publicKey: string;
  counter: number;
  transports: string[];
  deviceType: 'singleDevice' | 'multiDevice';
  backedUp: boolean;
  createdAt: number;
  lastUsedAt: number | null;
  revokedAt: number | null;
}

interface Registry { v: 1; devices: RemoteDevice[] }
const FILE = 'remote-devices.json';
const MAX_BYTES = 1_048_576;
const ENCODED = /^[A-Za-z0-9_-]+$/;
const TRANSPORTS = new Set(['ble', 'cable', 'hybrid', 'internal', 'nfc', 'smart-card', 'usb']);

function privatePath(path: string, directory: boolean): void {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile())
    || (stat.mode & 0o077) !== 0 || (typeof process.getuid === 'function' && stat.uid !== process.getuid())) {
    throw new Error('Remote device registry is not private');
  }
}

function validDevice(value: unknown): value is RemoteDevice {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const d = value as Record<string, unknown>;
  const scopes = d.scopes as Record<string, unknown> | undefined;
  return typeof d.id === 'string' && /^[a-f0-9-]{36}$/.test(d.id)
    && typeof d.label === 'string' && d.label.length > 0 && d.label.length <= 80
    && typeof d.subject === 'string' && d.subject.length > 0 && d.subject.length <= 256
    && typeof d.email === 'string' && d.email.length > 0 && d.email.length <= 320
    && scopes?.read === true && typeof scopes.act === 'boolean'
    && typeof d.credentialId === 'string' && d.credentialId.length >= 16 && d.credentialId.length <= 1024 && ENCODED.test(d.credentialId)
    && typeof d.publicKey === 'string' && d.publicKey.length >= 16 && d.publicKey.length <= 8192 && ENCODED.test(d.publicKey)
    && Number.isSafeInteger(d.counter) && (d.counter as number) >= 0
    && Array.isArray(d.transports) && d.transports.every((t: unknown) => typeof t === 'string' && TRANSPORTS.has(t))
    && (d.deviceType === 'singleDevice' || d.deviceType === 'multiDevice') && typeof d.backedUp === 'boolean'
    && Number.isSafeInteger(d.createdAt) && (d.createdAt as number) > 0
    && (d.lastUsedAt === null || Number.isSafeInteger(d.lastUsedAt))
    && (d.revokedAt === null || Number.isSafeInteger(d.revokedAt));
}

function clone(device: RemoteDevice): RemoteDevice {
  return { ...device, scopes: { ...device.scopes }, transports: [...device.transports] };
}

/**
 * The write lock is create-exclusive and never silently stolen. A crash can
 * leave it behind; an operator must inspect/remove it before writes resume.
 * This favors a denied pairing over losing a concurrent revocation.
 */
export function createRemoteDeviceStore(root = defaultVerseRoot()) {
  const path = join(root, FILE);
  const lockPath = `${path}.lock`;
  const revokeListeners = new Set<(id: string) => void>();
  function statOrNull(target: string) {
    try { return lstatSync(target); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }
  function read(): Registry {
    if (!statOrNull(root)) return { v: 1, devices: [] };
    privatePath(root, true);
    if (!statOrNull(path)) return { v: 1, devices: [] };
    privatePath(path, false);
    if (lstatSync(path).size > MAX_BYTES) throw new Error('Remote device registry is too large');
    let data: unknown;
    try { data = JSON.parse(readFileSync(path, 'utf8')) as unknown; }
    catch { throw new Error('Remote device registry is unreadable'); }
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Remote device registry is invalid');
    const registry = data as Record<string, unknown>;
    if (registry.v !== 1 || !Array.isArray(registry.devices) || registry.devices.length > 256
      || !registry.devices.every(validDevice)) throw new Error('Remote device registry is invalid');
    const devices = registry.devices as RemoteDevice[];
    if (new Set(devices.map((d) => d.id)).size !== devices.length
      || new Set(devices.map((d) => d.credentialId)).size !== devices.length) throw new Error('Remote device registry has duplicate credentials');
    return { v: 1, devices };
  }
  function mutate<T>(update: (registry: Registry) => T): T {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    privatePath(root, true);
    const noFollow = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0;
    const fd = openSync(lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow, 0o600);
    try {
      writeSync(fd, `${process.pid}\n`);
      fsyncSync(fd);
      if ((fstatSync(fd).mode & 0o077) !== 0) throw new Error('Remote device registry lock is not private');
      const registry = read();
      const result = update(registry);
      const bytes = `${JSON.stringify(registry)}\n`;
      if (Buffer.byteLength(bytes) > MAX_BYTES) throw new Error('Remote device registry is too large');
      writePrivateFileAtomically(root, path, bytes);
      return result;
    } finally {
      closeSync(fd);
      rmSync(lockPath, { force: true });
    }
  }
  return {
    list(): RemoteDevice[] { return read().devices.map(clone); },
    getActive(id: string, subject: string): RemoteDevice | null {
      const found = read().devices.find((d) => d.id === id && d.subject === subject && d.revokedAt === null);
      return found ? clone(found) : null;
    },
    add(device: RemoteDevice): void {
      if (!validDevice(device) || device.revokedAt !== null) throw new Error('Invalid remote device');
      mutate((registry) => {
        if (registry.devices.some((d) => d.id === device.id || d.credentialId === device.credentialId)) throw new Error('Remote credential already paired');
        registry.devices.push(clone(device));
      });
    },
    revoke(id: string, at: number): boolean {
      if (!Number.isSafeInteger(at) || at <= 0) throw new Error('Invalid revocation time');
      const changed = mutate((registry) => {
        const device = registry.devices.find((d) => d.id === id && d.revokedAt === null);
        if (!device) return false;
        device.revokedAt = at;
        return true;
      });
      if (changed) for (const listener of revokeListeners) {
        try { listener(id); } catch { /* a stream listener cannot undo revocation */ }
      }
      return changed;
    },
    onRevoked(listener: (id: string) => void): () => void {
      revokeListeners.add(listener);
      return () => { revokeListeners.delete(listener); };
    },
    updateCounter(id: string, subject: string, credentialId: string, counter: number, at: number): boolean {
      if (!Number.isSafeInteger(counter) || counter < 0 || !Number.isSafeInteger(at) || at <= 0) return false;
      return mutate((registry) => {
        const device = registry.devices.find((d) => d.id === id && d.subject === subject
          && d.credentialId === credentialId && d.revokedAt === null);
        if (!device || (device.counter > 0 && counter <= device.counter)) return false;
        device.counter = counter;
        device.lastUsedAt = at;
        return true;
      });
    },
  };
}

export type RemoteDeviceStore = ReturnType<typeof createRemoteDeviceStore>;
