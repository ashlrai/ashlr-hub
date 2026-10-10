/** Public signed-app proof, independent of account/lease/spending admission.
 * Only the physically paired Bun sidecar can select this backend. No publisher
 * toolchain, credentials, PATH-selected host or durable capability is used. */
import { spawn } from 'node:child_process';
import { constants, lstatSync, realpathSync, type BigIntStats } from 'node:fs';
import { open, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { canonicalJson } from '../authority/canonical-json.js';

export const DESKTOP_METADATA_SIGNER = '0EA409C87A3CDE7B6E26015581E575D831698B23';
export const DESKTOP_METADATA_FLAG = '--_phantom-native-metadata-launch';
export const DESKTOP_METADATA_TICKET_ENV = 'PHANTOM_NATIVE_METADATA_TICKET';
export interface DesktopPairBuildIdentity { schemaVersion: 1; revision: string; tree: string; version: string }
export interface DesktopFileStamp { dev: string; ino: string; size: string; mtimeNs: string; ctimeNs: string; mode: string; uid: string; nlink: string }
export interface DesktopImage { path: string; sha256: string; stamp: DesktopFileStamp }
interface Capture { images: readonly DesktopImage[]; directories: readonly { path: string; stamp: DesktopFileStamp }[]; parent: { pid: number; startRef: string; executable: string }; identity: DesktopPairBuildIdentity }
export interface DesktopMetadataBackend { readonly kind: 'signed-desktop'; preflight(signal: AbortSignal): Promise<void>; assertCurrent(): void; image(): DesktopImage; parent(): { pid: number; startRef: string; executable: string } }
export interface DesktopMetadataTrustIO {
  readImage(path: string, signal: AbortSignal): Promise<DesktopImage>;
  readRecord(path: string, signal: AbortSignal): Promise<string>;
  directory(path: string): DesktopFileStamp;
  stamp(path: string): DesktopFileStamp;
  parent(pid: number, signal: AbortSignal): Promise<{ pid: number; startRef: string; executable: string }>;
  inventory(path: string, signal: AbortSignal): Promise<string>;
  metadata(command: string, args: string[], signal: AbortSignal): Promise<string>;
}
const HASH = /^[a-f0-9]{40}$/;
const unavailable = () => new Error('Signed desktop metadata launcher unavailable');
const need = (value: unknown): void => { if (!value) throw unavailable(); };
const equal = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
function exact(value: unknown, keys: string[]): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(value)) &&
    Reflect.ownKeys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key) && 'value' in Object.getOwnPropertyDescriptor(value, key)!);
}
export function parseDesktopPairBuildIdentity(raw: unknown): DesktopPairBuildIdentity | null {
  try {
    if (typeof raw !== 'string') return null;
    const value: unknown = JSON.parse(raw);
    if (!exact(value, ['schemaVersion', 'revision', 'tree', 'version']) || value.schemaVersion !== 1 ||
      typeof value.revision !== 'string' || !HASH.test(value.revision) || typeof value.tree !== 'string' || !HASH.test(value.tree) ||
      typeof value.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(value.version) || JSON.stringify(value) !== raw) return null;
    return Object.freeze(value as unknown as DesktopPairBuildIdentity);
  } catch { return null; }
}
const stampOf = (s: BigIntStats): DesktopFileStamp => ({ dev: String(s.dev), ino: String(s.ino), size: String(s.size),
  mtimeNs: String(s.mtimeNs), ctimeNs: String(s.ctimeNs), mode: String(s.mode), uid: String(s.uid), nlink: String(s.nlink) });
function regular(path: string): BigIntStats {
  const s = lstatSync(path, { bigint: true });
  need(s.isFile() && !s.isSymbolicLink() && s.nlink === 1n && s.size >= 0n && s.size <= 512n * 1024n * 1024n &&
    (s.mode & 0o022n) === 0n && [0n, BigInt(process.getuid!())].includes(s.uid) && realpathSync(path) === path);
  return s;
}
function directory(path: string): DesktopFileStamp {
  const s = lstatSync(path, { bigint: true });
  need(s.isDirectory() && !s.isSymbolicLink() && (s.mode & 0o022n) === 0n && realpathSync(path) === path);
  return stampOf(s);
}
async function readImage(path: string, signal: AbortSignal): Promise<DesktopImage> {
  signal.throwIfAborted(); const before = stampOf(regular(path)); const fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    need(equal(before, stampOf(await fd.stat({ bigint: true }))));
    const hash = createHash('sha256'), buffer = Buffer.alloc(64 * 1024); let offset = 0;
    for (;;) { signal.throwIfAborted(); const { bytesRead } = await fd.read(buffer, 0, buffer.length, offset); if (!bytesRead) break;
      hash.update(buffer.subarray(0, bytesRead)); offset += bytesRead; need(offset <= Number(before.size)); }
    need(offset === Number(before.size) && equal(before, stampOf(await fd.stat({ bigint: true }))) && equal(before, stampOf(regular(path))));
    return Object.freeze({ path, sha256: hash.digest('hex'), stamp: Object.freeze(before) });
  } finally { await fd.close(); }
}
async function metadata(command: string, args: string[], signal: AbortSignal): Promise<string> {
  signal.throwIfAborted();
  return await new Promise((resolveDone, reject) => {
    const child = spawn(command, args, { env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' }, stdio: ['ignore', 'pipe', 'pipe'], signal });
    let output = '', failed = false;
    const timer = setTimeout(() => { failed = true; child.kill('SIGKILL'); }, 5_000);
    child.stdout.on('data', (b: Buffer) => { output += b.toString('utf8'); if (Buffer.byteLength(output) > 16_384) { failed = true; child.kill('SIGKILL'); } });
    // Drain fixed program stderr, but never retain/export it.
    child.stderr.resume(); child.on('error', () => { failed = true; });
    child.once('close', (code) => { clearTimeout(timer); if (failed || code !== 0 || signal.aborted) reject(unavailable()); else resolveDone(output.trim()); });
  });
}
async function inventory(root: string, signal: AbortSignal): Promise<string> {
  const hash = createHash('sha256');
  async function walk(path: string, relative: string): Promise<void> {
    signal.throwIfAborted(); const before = lstatSync(path, { bigint: true }); need(!before.isSymbolicLink());
    if (before.isDirectory()) {
      for (const name of (await readdir(path)).sort()) await walk(join(path, name), relative ? `${relative}/${name}` : name);
    } else { const image = await readImage(path, signal); hash.update(JSON.stringify({ path: relative, sha256: image.sha256, stamp: image.stamp }) + '\n'); }
    need(equal(stampOf(before), stampOf(lstatSync(path, { bigint: true }))));
  }
  await walk(root, ''); return hash.digest('hex');
}
const defaultIO: DesktopMetadataTrustIO = {
  readImage, async readRecord(path, signal) {
    const before = await readImage(path, signal); need(Number(before.stamp.size) <= 4096);
    const fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { need(equal(before.stamp, stampOf(await fd.stat({ bigint: true })))); const bytes = await fd.readFile(); signal.throwIfAborted();
      need(bytes.length <= 4096 && createHash('sha256').update(bytes).digest('hex') === before.sha256 &&
        equal(before.stamp, stampOf(await fd.stat({ bigint: true }))) && equal(before.stamp, stampOf(regular(path)))); return bytes.toString('utf8');
    } finally { await fd.close(); }
  }, directory, stamp: path => stampOf(regular(path)), metadata, inventory,
  async parent(pid, signal) {
    const before = await metadata('/bin/ps', ['-o', 'lstart=', '-p', String(pid)], signal);
    const executable = await metadata('/bin/ps', ['-o', 'comm=', '-p', String(pid)], signal);
    need(await metadata('/bin/ps', ['-o', 'lstart=', '-p', String(pid)], signal) === before);
    const seconds = Math.floor(Date.parse(before) / 1000); need(Number.isSafeInteger(seconds) && seconds > 0);
    return { pid, startRef: BigInt(seconds).toString(16).padStart(64, '0'), executable };
  },
};
/** Injectable metadata ports are for inert qualification, never a caller-selectable production host. */
export function createDesktopMetadataTrust(io: DesktopMetadataTrustIO, context: { sidecar: string; parentPid: number; identity: DesktopPairBuildIdentity }) {
  let cached: string | undefined;
  const sidecar = context.sidecar, app = '/Applications/Phantom.app', native = join(app, 'Contents/MacOS/ashlr-desktop');
  const filePaths = [native, sidecar, join(app, 'Contents/Resources/phantom-release.json'), join(app, 'Contents/Info.plist')];
  const directoryPaths = [app, join(app, 'Contents'), join(app, 'Contents/MacOS'), join(app, 'Contents/Resources')];
  async function capture(signal: AbortSignal): Promise<Capture> {
    signal.throwIfAborted(); need(sidecar === join(app, 'Contents/MacOS/ashlr') && context.parentPid > 1);
    const directories = directoryPaths.map(path => ({ path, stamp: io.directory(path) }));
    const images: DesktopImage[] = []; for (const path of filePaths) images.push(await io.readImage(path, signal));
    const parent = await io.parent(context.parentPid, signal); need(parent.pid === context.parentPid && parent.executable === native && /^[a-f0-9]{64}$/.test(parent.startRef));
    const raw = await io.readRecord(filePaths[2]!, signal), marker: unknown = JSON.parse(raw);
    need(exact(marker, ['schemaVersion', 'version', 'source', 'authoritySurfaceDigest', 'packageSha256']) && marker.schemaVersion === 1 &&
      marker.version === context.identity.version && exact(marker.source, ['revision', 'tree']) && marker.source.revision === context.identity.revision && marker.source.tree === context.identity.tree &&
      typeof marker.authoritySurfaceDigest === 'string' && /^[a-f0-9]{64}$/.test(marker.authoritySurfaceDigest) && typeof marker.packageSha256 === 'string' && /^[a-f0-9]{64}$/.test(marker.packageSha256) && canonicalJson(marker) === raw);
    for (const item of images) need(equal(item.stamp, io.stamp(item.path)));
    for (const item of directories) need(equal(item.stamp, io.directory(item.path)));
    signal.throwIfAborted(); return { images, directories, parent, identity: context.identity };
  }
  async function qualified(signal: AbortSignal): Promise<Capture> {
    const before = await capture(signal), key = JSON.stringify({ ...before, signer: DESKTOP_METADATA_SIGNER });
    if (cached !== key) {
      cached = undefined; const beforeInventory = await io.inventory(app, signal);
      for (const [property, expected] of [['CFBundleIdentifier', 'ai.ashlr.desktop'], ['CFBundleExecutable', 'ashlr-desktop'], ['CFBundleShortVersionString', context.identity.version]])
        need((await io.metadata('/usr/bin/plutil', ['-extract', property!, 'raw', '-o', '-', filePaths[3]!], signal)).trim() === expected);
      await io.metadata('/usr/bin/codesign', ['--verify', '--deep', '--strict', `-R=identifier "ai.ashlr.desktop" and certificate leaf = H"${DESKTOP_METADATA_SIGNER}"`, app], signal);
      need(await io.inventory(app, signal) === beforeInventory && equal(await capture(signal), before)); cached = key;
    }
    return before;
  }
  return async (signal: AbortSignal): Promise<DesktopMetadataBackend> => {
    let observed = await qualified(signal); const initial = JSON.stringify(observed);
    return Object.freeze({ kind: 'signed-desktop' as const,
      async preflight(signal: AbortSignal) { const next = await qualified(signal); need(JSON.stringify(next) === initial); observed = next; },
      assertCurrent() { for (const item of observed.images) need(equal(item.stamp, io.stamp(item.path))); for (const item of observed.directories) need(equal(item.stamp, io.directory(item.path))); },
      parent() { return structuredClone(observed.parent); },
      image() { for (const item of observed.images) need(equal(item.stamp, io.stamp(item.path))); return structuredClone(observed.images[0]!); },
    });
  };
}
let qualifyDefault: ReturnType<typeof createDesktopMetadataTrust> | undefined;
/** Initial async qualification occurs before acquiring a quota collector lease. */
export async function qualifyDesktopMetadataLaunch(signal: AbortSignal): Promise<DesktopMetadataBackend | null> {
  if (process.platform !== 'darwin' || process.versions.bun === undefined) return null;
  const identity = parseDesktopPairBuildIdentity(Reflect.get(globalThis, Symbol.for('phantom.desktop-pair-build.v1')));
  if (!identity) return null;
  try {
    const sidecar = realpathSync(process.execPath); need(resolve(process.execPath) === sidecar);
    qualifyDefault ??= createDesktopMetadataTrust(defaultIO, { sidecar, parentPid: process.ppid, identity });
    return await qualifyDefault(signal);
  } catch { return null; }
}
