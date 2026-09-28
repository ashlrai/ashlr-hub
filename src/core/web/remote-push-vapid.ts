/** Stable, private VAPID identity for an explicitly started phone gateway. */
import { constants, closeSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, rmSync, writeSync } from 'node:fs';
import { isIP } from 'node:net';
import { join } from 'node:path';
import webpush from 'web-push';
import { defaultVerseRoot } from '../verse/preferences.js';
import { writePrivateFileAtomically } from '../verse/session-store.js';
import type { RemotePushConfig } from './remote-push.js';

const FILE = 'remote-push-vapid.json';
const MAX_BYTES = 2_048;
const ENCODED = /^[A-Za-z0-9_-]+$/;
interface Stored extends RemotePushConfig { v: 1 }

function privatePath(path: string, directory: boolean): void {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile())
    || (stat.mode & 0o077) !== 0 || (typeof process.getuid === 'function' && stat.uid !== process.getuid())) {
    throw new Error('Remote push VAPID path is not private');
  }
}

function exists(path: string): boolean {
  try { lstatSync(path); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}

function validOrigin(subject: string): boolean {
  try {
    const url = new URL(subject);
    return url.protocol === 'https:' && url.origin === subject && url.hostname.includes('.') && isIP(url.hostname) === 0
      && url.hostname !== 'localhost' && !url.hostname.endsWith('.localhost');
  } catch { return false; }
}

function validKey(value: unknown, length: number): value is string {
  return typeof value === 'string' && ENCODED.test(value) && Buffer.from(value, 'base64url').length === length;
}

function read(path: string, subject: string): RemotePushConfig {
  privatePath(path, false);
  if (lstatSync(path).size > MAX_BYTES) throw new Error('Remote push VAPID file is too large');
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown; }
  catch { throw new Error('Remote push VAPID file is unreadable'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Remote push VAPID file is invalid');
  const row = parsed as Record<string, unknown>;
  if (row.v !== 1 || row.subject !== subject || Object.keys(row).length !== 4
    || !validKey(row.publicKey, 65) || !validKey(row.privateKey, 32)) {
    throw new Error('Remote push VAPID file is invalid or belongs to another origin');
  }
  return { publicKey: row.publicKey, privateKey: row.privateKey, subject };
}

/**
 * Called only after explicit --remote-config startup. A missing file gets one
 * identity, atomically; a malformed or mismatched file fails closed and is
 * never silently rotated (existing browser subscriptions depend on this key).
 */
export function loadOrCreateRemoteVapid(subject: string, root = defaultVerseRoot()): RemotePushConfig {
  if (!validOrigin(subject)) throw new Error('Remote push VAPID subject must be a public HTTPS origin');
  mkdirSync(root, { recursive: true, mode: 0o700 });
  privatePath(root, true);
  const path = join(root, FILE);
  if (exists(path)) return read(path, subject);
  const lockPath = `${path}.lock`;
  const noFollow = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0;
  const fd = openSync(lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow, 0o600);
  try {
    writeSync(fd, `${process.pid}\n`);
    fsyncSync(fd);
    if ((fstatSync(fd).mode & 0o077) !== 0) throw new Error('Remote push VAPID lock is not private');
    if (exists(path)) return read(path, subject);
    const keys = webpush.generateVAPIDKeys();
    const value: Stored = { v: 1, publicKey: keys.publicKey, privateKey: keys.privateKey, subject };
    if (!validKey(value.publicKey, 65) || !validKey(value.privateKey, 32)) throw new Error('Remote push VAPID generation failed');
    writePrivateFileAtomically(root, path, `${JSON.stringify(value)}\n`);
    return read(path, subject);
  } finally { closeSync(fd); rmSync(lockPath, { force: true }); }
}
