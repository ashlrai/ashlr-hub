/**
 * Authority surface + host probes — V3.10 Track B (unit B-U1).
 *
 * A standing grant binds three facts about the machine it runs on. This module
 * is where the running process reads them:
 *
 *   1. CODE — `authoritySurfaceDigest`. `npm run build` runs
 *      scripts/authority-surface.mjs after `tsc`: it walks the RUNTIME import
 *      closure of the authority roots in dist/ and writes
 *      dist/authority-surface.json (every file's sha256, the bare packages it
 *      pulls in with their versions, and a digest over all of it). At runtime
 *      we re-hash every listed file and re-derive the digest. A deploy that
 *      changes any file in the closure changes the digest, which pauses the
 *      grant ("authority code changed — re-approve") until Mason signs again.
 *      Fleet merges never change the running release; only deploys do.
 *   2. HOST — `hostBinding` = sha256(IOPlatformUUID), read from `ioreg`. A
 *      grant copied to another Mac is inert there.
 *   3. CONFINEMENT — no OS sandbox, no standing authority (SPEC-310B §1:
 *      "No confinement means no grant and no ticks"). Standing authority is
 *      macOS-only: the custody key lives in a Secure Enclave.
 *
 * WHICH RELEASE. The daemon verifies the release it is RUNNING (`running`),
 * which is the only honest answer for "may this code act". The Verse server
 * inside the desktop app is a Bun single-file binary whose code is not on
 * disk, and the dev checkout runs TypeScript from src/ — neither has a
 * running surface. For display and for drafting the next grant they use the
 * INSTALLED release the daemon runs (`installed`,
 * ~/.local/share/ashlr/current). Nothing ever AUTHORIZES against `installed`:
 * currentStandingPolicy() and the daemon's per-tick check use `running` only,
 * so source code executed through tsx can never borrow the installed build's
 * approval.
 *
 * NO TRUST FROM FILES. The manifest only lists what to hash; the grant pins
 * the digest. Editing the manifest to drop a file changes the digest, which
 * then no longer matches any signed grant.
 */
import { createHash } from 'node:crypto';
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  type BigIntStats,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { probeAutonomousConfinement } from '../sandbox/confine.js';
import { canonicalJson } from './canonical-json.js';

// ---------------------------------------------------------------------------
// Manifest contract (shared with scripts/authority-surface.mjs)
// ---------------------------------------------------------------------------

/** Where the build writes the manifest, relative to the package root. */
export const AUTHORITY_SURFACE_MANIFEST = 'dist/authority-surface.json';

/** Domain-separates the surface digest from every other sha256 in the system. */
export const AUTHORITY_SURFACE_DIGEST_DOMAIN = 'ashlr:authority-surface:v1\0';

export interface AuthoritySurfaceFile {
  /** Package-root-relative POSIX path, e.g. `dist/core/authority/ledger.js`. */
  path: string;
  sha256: string;
  bytes: number;
}

export interface AuthoritySurfacePackage {
  name: string;
  version: string;
}

export interface AuthoritySurfaceManifestV1 {
  v: 1;
  /** The configured roots, as the build script declares them. */
  roots: string[];
  /** Roots that did not exist at build time (a unit not landed yet). Part of the digest. */
  missingRoots: string[];
  /** Every file in the runtime import closure, sorted by path. */
  files: AuthoritySurfaceFile[];
  /** Bare-specifier packages the closure imports, with the installed version. */
  packages: AuthoritySurfacePackage[];
  /** `from -> specifier` for relative imports that did not resolve. Part of the digest. */
  unresolved: string[];
  digest: string;
}

const MANIFEST_KEYS = ['v', 'roots', 'missingRoots', 'files', 'packages', 'unresolved', 'digest'] as const;
const MAX_MANIFEST_BYTES = 4 * 1024 * 1024;
const MAX_SURFACE_FILES = 5_000;
const MAX_SURFACE_FILE_BYTES = 32 * 1024 * 1024;
const SHA256_RE = /^[a-f0-9]{64}$/u;
/** Relative, POSIX, no `..`/`.` segments, under dist/ or scripts/, a module or JSON file. */
const SURFACE_PATH_RE = /^(?:dist|scripts)\/(?:[A-Za-z0-9_@+-][A-Za-z0-9._@+-]*\/)*[A-Za-z0-9_@+-][A-Za-z0-9._@+-]*\.(?:js|mjs|cjs|json)$/u;
const PACKAGE_NAME_RE = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u;
const PACKAGE_VERSION_RE = /^[0-9A-Za-z.+-]{1,64}$/u;

/**
 * The digest over everything the manifest pins except the digest itself.
 * scripts/authority-surface.mjs carries a byte-identical copy of this and of
 * canonicalJson (it runs before any TypeScript exists); the surface test
 * builds a manifest with the script and verifies it here, so the two cannot
 * drift silently.
 */
export function authoritySurfaceDigest(core: Omit<AuthoritySurfaceManifestV1, 'digest'>): string {
  return createHash('sha256')
    .update(AUTHORITY_SURFACE_DIGEST_DOMAIN + canonicalJson({
      v: core.v,
      roots: core.roots,
      missingRoots: core.missingRoots,
      files: core.files,
      packages: core.packages,
      unresolved: core.unresolved,
    }), 'utf8')
    .digest('hex');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

function stringList(value: unknown, max: number, each: (s: string) => boolean): value is string[] {
  return Array.isArray(value) && value.length <= max && value.every((s) => typeof s === 'string' && s.length <= 512 && each(s));
}

function sortedUnique(values: readonly string[]): boolean {
  for (let i = 1; i < values.length; i += 1) if (!(values[i - 1]! < values[i]!)) return false;
  return true;
}

/** Strict shape check. Returns null when anything is off (the caller fails closed). */
export function parseAuthoritySurfaceManifest(value: unknown): AuthoritySurfaceManifestV1 | null {
  if (!isRecord(value) || !exactKeys(value, MANIFEST_KEYS)) return null;
  if (value['v'] !== 1) return null;
  if (!stringList(value['roots'], 256, (s) => s.length > 0)) return null;
  if (!stringList(value['missingRoots'], 256, (s) => s.length > 0)) return null;
  if (!stringList(value['unresolved'], MAX_SURFACE_FILES, (s) => s.length > 0)) return null;
  const files = value['files'];
  if (!Array.isArray(files) || files.length === 0 || files.length > MAX_SURFACE_FILES) return null;
  for (const file of files) {
    if (!isRecord(file) || !exactKeys(file, ['path', 'sha256', 'bytes'])) return null;
    if (typeof file['path'] !== 'string' || !SURFACE_PATH_RE.test(file['path'])) return null;
    if (file['path'].split('/').some((part) => part === '.' || part === '..')) return null;
    if (typeof file['sha256'] !== 'string' || !SHA256_RE.test(file['sha256'])) return null;
    if (!Number.isSafeInteger(file['bytes']) || (file['bytes'] as number) < 0) return null;
  }
  if (!sortedUnique(files.map((f) => (f as AuthoritySurfaceFile).path))) return null;
  const packages = value['packages'];
  if (!Array.isArray(packages) || packages.length > 256) return null;
  for (const pkg of packages) {
    if (!isRecord(pkg) || !exactKeys(pkg, ['name', 'version'])) return null;
    if (typeof pkg['name'] !== 'string' || !PACKAGE_NAME_RE.test(pkg['name'])) return null;
    if (typeof pkg['version'] !== 'string' || !PACKAGE_VERSION_RE.test(pkg['version'])) return null;
  }
  if (!sortedUnique(packages.map((p) => (p as AuthoritySurfacePackage).name))) return null;
  if (typeof value['digest'] !== 'string' || !SHA256_RE.test(value['digest'])) return null;
  return value as unknown as AuthoritySurfaceManifestV1;
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

export type SurfaceTarget = 'running' | 'installed';

export type SurfaceFailureCode =
  | 'no-running-release'
  | 'no-installed-release'
  | 'manifest-missing'
  | 'manifest-invalid'
  | 'manifest-digest-mismatch'
  | 'file-missing'
  | 'file-unsafe'
  | 'file-changed'
  | 'package-changed';

export type SurfaceVerification =
  | { ok: true; target: SurfaceTarget; packageRoot: string; digest: string; fileCount: number; checkedAt: string }
  | { ok: false; target: SurfaceTarget; packageRoot: string | null; code: SurfaceFailureCode; reason: string; checkedAt: string };

interface StatKey {
  dev: bigint;
  ino: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
}

/** Per absolute path: the stat tuple a hash was taken under (process-local). */
const hashCache = new Map<string, { key: StatKey; sha256: string }>();

function statKey(stat: BigIntStats): StatKey {
  return { dev: stat.dev, ino: stat.ino, size: stat.size, mtimeNs: stat.mtimeNs, ctimeNs: stat.ctimeNs };
}

function sameKey(a: StatKey, b: StatKey): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
}

/** Hash one file through a pinned descriptor; null when it changed while being read. */
function hashRegularFile(path: string): { sha256: string; key: StatKey } | null {
  const noFollow = typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0;
  const fd = openSync(path, fsConstants.O_RDONLY | noFollow);
  try {
    const before = fstatSync(fd, { bigint: true });
    if (!before.isFile() || before.size > BigInt(MAX_SURFACE_FILE_BYTES)) return null;
    const hash = createHash('sha256');
    const chunk = Buffer.allocUnsafe(256 * 1024);
    const total = Number(before.size);
    let offset = 0;
    while (offset < total) {
      const count = readSync(fd, chunk, 0, Math.min(chunk.length, total - offset), offset);
      if (count <= 0) return null;
      hash.update(chunk.subarray(0, count));
      offset += count;
    }
    const after = fstatSync(fd, { bigint: true });
    if (!sameKey(statKey(before), statKey(after))) return null;
    return { sha256: hash.digest('hex'), key: statKey(after) };
  } finally {
    closeSync(fd);
  }
}

function readSmallFile(path: string, maxBytes: number): string | null {
  const noFollow = typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0;
  let fd: number;
  try {
    fd = openSync(path, fsConstants.O_RDONLY | noFollow);
  } catch {
    return null;
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > maxBytes) return null;
    const bytes = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (count <= 0) return null;
      offset += count;
    }
    return bytes.toString('utf8');
  } finally {
    closeSync(fd);
  }
}

function within(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel.length > 0 && !rel.startsWith('..') && !isAbsolute(rel) && !rel.split(sep).includes('..');
}

/**
 * Verify the surface of the release rooted at `packageRoot` (the directory
 * holding dist/ and node_modules/). `fresh` re-hashes every file; otherwise a
 * file whose (dev, ino, size, mtime, ctime) is unchanged since this process
 * last hashed it is not re-read — the daemon's per-tick check is always fresh.
 */
export function verifyAuthoritySurfaceAt(
  requestedRoot: string,
  target: SurfaceTarget,
  opts: { fresh?: boolean; nowMs?: number } = {},
): SurfaceVerification {
  const checkedAt = new Date(opts.nowMs ?? Date.now()).toISOString();
  let packageRoot: string;
  try {
    packageRoot = realpathSync(requestedRoot);
  } catch {
    return { ok: false, target, packageRoot: null, code: 'manifest-missing', reason: 'The release directory does not exist.', checkedAt };
  }
  const fail = (code: SurfaceFailureCode, reason: string): SurfaceVerification =>
    ({ ok: false, target, packageRoot, code, reason, checkedAt });
  const text = readSmallFile(join(packageRoot, AUTHORITY_SURFACE_MANIFEST), MAX_MANIFEST_BYTES);
  if (text === null) {
    return fail('manifest-missing', 'This release has no authority-surface manifest (dist/authority-surface.json) — rebuild it with `npm run build`.');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return fail('manifest-invalid', 'The authority-surface manifest is not valid JSON.');
  }
  const manifest = parseAuthoritySurfaceManifest(parsed);
  if (!manifest) return fail('manifest-invalid', 'The authority-surface manifest does not match the v1 schema.');
  if (authoritySurfaceDigest(manifest) !== manifest.digest) {
    return fail('manifest-digest-mismatch', 'The authority-surface manifest was edited after the build (its digest does not match its contents).');
  }
  for (const file of manifest.files) {
    const absolute = join(packageRoot, ...file.path.split('/'));
    if (!within(packageRoot, absolute)) return fail('file-unsafe', `Surface path escapes the release: ${file.path}`);
    let named: BigIntStats;
    try {
      named = lstatSync(absolute, { bigint: true });
    } catch {
      return fail('file-missing', `Authority file missing from the release: ${file.path}`);
    }
    if (!named.isFile() || named.isSymbolicLink()) return fail('file-unsafe', `Authority file is not a regular file: ${file.path}`);
    // A symlinked DIRECTORY on the way could point outside the release; the
    // O_NOFOLLOW open below only covers the last component.
    try {
      if (!within(packageRoot, realpathSync(absolute))) return fail('file-unsafe', `Authority file resolves outside the release: ${file.path}`);
    } catch {
      return fail('file-missing', `Authority file missing from the release: ${file.path}`);
    }
    const cached = hashCache.get(absolute);
    let sha256: string;
    if (!opts.fresh && cached && sameKey(cached.key, statKey(named))) {
      sha256 = cached.sha256;
    } else {
      let hashed: { sha256: string; key: StatKey } | null;
      try {
        hashed = hashRegularFile(absolute);
      } catch {
        hashed = null;
      }
      if (!hashed) return fail('file-unsafe', `Authority file changed or could not be read while hashing: ${file.path}`);
      hashCache.set(absolute, hashed);
      sha256 = hashed.sha256;
    }
    if (sha256 !== file.sha256) return fail('file-changed', `Authority code changed since the build: ${file.path}`);
  }
  for (const pkg of manifest.packages) {
    const pkgJson = readSmallFile(join(packageRoot, 'node_modules', ...pkg.name.split('/'), 'package.json'), 1024 * 1024);
    let version: unknown = null;
    try {
      version = pkgJson === null ? null : (JSON.parse(pkgJson) as { version?: unknown }).version;
    } catch {
      version = null;
    }
    if (version !== pkg.version) {
      return fail('package-changed', `Package ${pkg.name} is ${typeof version === 'string' ? version : 'missing'}, the build pinned ${pkg.version}.`);
    }
  }
  return { ok: true, target, packageRoot, digest: manifest.digest, fileCount: manifest.files.length, checkedAt };
}

/**
 * The package root this module was loaded from — only when it is a compiled
 * release on disk (`<root>/dist/core/authority/surface.js`). null for the
 * TypeScript source (tsx, vitest) and for a Bun single-file binary.
 */
export function runningPackageRoot(moduleUrl: string = import.meta.url): string | null {
  let file: string;
  try {
    if (!moduleUrl.startsWith('file:')) return null;
    file = realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return null;
  }
  const parts = file.split(sep);
  const n = parts.length;
  if (n < 5 || parts[n - 1] !== 'surface.js' || parts[n - 2] !== 'authority' || parts[n - 3] !== 'core' || parts[n - 4] !== 'dist') {
    return null;
  }
  return dirname(dirname(dirname(dirname(file))));
}

/** The release the resident daemon runs: ~/.local/share/ashlr/current (resolved). */
export function installedPackageRoot(): string | null {
  try {
    const root = realpathSync(join(homedir(), '.local', 'share', 'ashlr', 'current'));
    return lstatSync(root).isDirectory() ? root : null;
  } catch {
    return null;
  }
}

/** Resolve a target to a package root, or explain why there is none. */
export function surfacePackageRoot(target: SurfaceTarget): string | null {
  return target === 'running' ? runningPackageRoot() : installedPackageRoot();
}

/**
 * Verify the authority surface for `target`. `installed` falls back to the
 * running release when no installed release exists (a dev machine that runs
 * dist/ directly) — display and drafting only, never authorization.
 */
export function verifyAuthoritySurface(
  target: SurfaceTarget,
  opts: { fresh?: boolean; nowMs?: number } = {},
): SurfaceVerification {
  const checkedAt = new Date(opts.nowMs ?? Date.now()).toISOString();
  if (target === 'running') {
    const root = runningPackageRoot();
    if (!root) {
      return {
        ok: false,
        target,
        packageRoot: null,
        code: 'no-running-release',
        reason: 'This process is not running a compiled release (TypeScript source or a single-file binary), so it cannot vouch for its own authority code.',
        checkedAt,
      };
    }
    return verifyAuthoritySurfaceAt(root, target, opts);
  }
  const root = installedPackageRoot() ?? runningPackageRoot();
  if (!root) {
    return {
      ok: false,
      target,
      packageRoot: null,
      code: 'no-installed-release',
      reason: 'No installed release at ~/.local/share/ashlr/current and this process is not a compiled release.',
      checkedAt,
    };
  }
  return verifyAuthoritySurfaceAt(root, target, opts);
}

// ---------------------------------------------------------------------------
// Host binding
// ---------------------------------------------------------------------------

let hostBindingCache: { value: string | null } | null = null;

/** Pure: the grant's host binding for an IOPlatformUUID. */
export function hostBindingForPlatformUuid(uuid: string): string {
  return createHash('sha256').update(uuid.trim().toUpperCase(), 'utf8').digest('hex');
}

/** Pure: the IOPlatformUUID in `ioreg -rd1 -c IOPlatformExpertDevice` output; null when absent. */
export function parseIoregPlatformUuid(output: string): string | null {
  const match = /"IOPlatformUUID"\s*=\s*"([0-9A-Fa-f-]{36})"/u.exec(output);
  return match ? match[1]!.toUpperCase() : null;
}

/**
 * sha256(IOPlatformUUID) of this Mac; null anywhere else or when ioreg cannot
 * be read. Read once per process (≈20 ms) from the absolute system path —
 * never from a cache file, which another machine could carry over.
 */
export function currentHostBinding(): string | null {
  if (hostBindingCache) return hostBindingCache.value;
  let value: string | null = null;
  if (process.platform === 'darwin') {
    try {
      const run = spawnSync('/usr/sbin/ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'], {
        encoding: 'utf8',
        timeout: 5_000,
        maxBuffer: 1024 * 1024,
        env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' },
      });
      const uuid = run.status === 0 && typeof run.stdout === 'string' ? parseIoregPlatformUuid(run.stdout) : null;
      value = uuid ? hostBindingForPlatformUuid(uuid) : null;
    } catch {
      value = null;
    }
  }
  hostBindingCache = { value };
  return value;
}

// ---------------------------------------------------------------------------
// Confinement availability
// ---------------------------------------------------------------------------

export type ConfinementProbe = { ok: true } | { ok: false; reason: string };

/**
 * Can autonomous agents be OS-confined here? Standing authority is macOS-only
 * (Secure Enclave custody + sandbox-exec).
 *
 * PROVEN, NOT ASSUMED (3.10 integration, U2's request): this used to check
 * only that /usr/bin/sandbox-exec is executable. It now runs U2's
 * probeAutonomousConfinement() — the REAL autonomous profile applied to a
 * throwaway home, which must be accepted by this macOS, let the worktree be
 * written, kill a read of a ~/.ashlr/authority tripwire and refuse a write
 * elsewhere. A macOS update that silently stops enforcing the profile then
 * darkens autonomy instead of letting agents run unconfined.
 *
 * Cost: the probe is cached for 10 minutes inside confine.ts; a cold call is
 * ~50 ms synchronous (one sandbox-exec spawn). The surface → confine →
 * effective-config → surface import cycle this creates is harmless: nothing
 * in it runs at module-evaluation time.
 */
export function confinementAvailable(): ConfinementProbe {
  if (process.platform !== 'darwin') {
    return { ok: false, reason: `Standing authority needs macOS OS confinement; this is ${process.platform}.` };
  }
  let probe: ReturnType<typeof probeAutonomousConfinement>;
  try {
    probe = probeAutonomousConfinement();
  } catch (error) {
    // The probe is documented not to throw; if it ever does, fail closed.
    return { ok: false, reason: `The confinement self-test could not run: ${(error as Error).message.slice(0, 200)}` };
  }
  return probe.ok ? { ok: true } : { ok: false, reason: `Agents cannot be confined here: ${probe.reason}` };
}

/** Test hook: forget the per-process hash and host caches (never changes a verdict's inputs). */
export function resetSurfaceCachesForTest(): void {
  hashCache.clear();
  hostBindingCache = null;
}

/** For callers that want an absolute manifest path (diagnostics). */
export function surfaceManifestPath(packageRoot: string): string {
  return resolve(packageRoot, AUTHORITY_SURFACE_MANIFEST);
}
