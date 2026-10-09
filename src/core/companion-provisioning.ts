/** Offline provisioning plans only: no download, extraction, execution or installation authority. */
import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, opendirSync, readSync, type Stats } from 'node:fs';
import { isAbsolute, join, parse, resolve, sep } from 'node:path';
import { COMPANION_RELEASES, type CompanionId } from './companion-inventory.js';

const MAX_MANIFEST_BYTES = 256 * 1024;
const MAX_ARTIFACT_BYTES = 512 * 1024 * 1024;
const MAX_FILES = 256;
const SHA256 = /^[a-f0-9]{64}$/u;
const PLATFORMS = new Set(['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64', 'win32-arm64', 'win32-x64']);

export interface CompanionArtifactManifest {
  schemaVersion: 1;
  tool: CompanionId;
  version: string;
  sourceCommit: string;
  releaseUrl: string;
  platform: string;
  format: 'expanded-file-set';
  /** This declaration is trusted only when the caller independently pins the complete manifest hash. */
  qualification: 'qualified' | 'unqualified' | 'unsupported';
  entrypoint: string;
  files: Array<{ path: string; sha256: string; bytes: number; mode: 0o644 | 0o755 }>;
}

export interface CompanionProvisioningOptions {
  /** Existing explicit roots. Neither HOME, PATH nor user config is consulted. */
  artifactRoot: string;
  destinationRoot: string;
  manifestPath: string;
  /** Must come from an independently reviewed release record, never from the downloaded manifest itself. */
  trustedManifestSha256: string;
  /** Inspection target only; this function never runs the target artifact. */
  platform?: string;
}

export interface CompanionProvisioningFilePlan {
  path: string;
  source: string;
  destination: string;
  sha256: string;
  bytes: number;
  mode: 0o644 | 0o755;
  action: 'create' | 'replace' | 'retain';
  /** Existing files remain untouched; hashes describe before images, not a rollback backup. */
  beforeImage: { state: 'absent' } | { state: 'present'; sha256: string; bytes: number; mode: number };
}

export interface CompanionProvisioningPlan {
  schemaVersion: 1;
  status: 'verified-plan' | 'blocked';
  installed: false;
  runtimeCapability: 'not-inspected';
  effects: [];
  blockers: string[];
  manifestSha256: string | null;
  artifact: { tool: CompanionId; version: string; sourceCommit: string; platform: string; entrypoint: string } | null;
  destination: string | null;
  files: CompanionProvisioningFilePlan[];
  /** A future authorized installer must revalidate bytes and before images immediately before applying effects. */
  requiresRevalidationBeforeApply: true;
}

class Blocked extends Error {}
function refuse(reason: string): never { throw new Blocked(reason); }
function keys(value: unknown, expected: string[]): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).sort().join('\0') === [...expected].sort().join('\0');
}

function relativePath(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 1024 &&
    value.split('/').every(part => /^[A-Za-z0-9_.-]+$/u.test(part) && part !== '.' && part !== '..' &&
      !part.endsWith('.') && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(part));
}

function manifest(value: unknown, platform: string): CompanionArtifactManifest {
  if (!keys(value, ['schemaVersion', 'tool', 'version', 'sourceCommit', 'releaseUrl', 'platform', 'format',
    'qualification', 'entrypoint', 'files']) || value.schemaVersion !== 1 || value.format !== 'expanded-file-set') {
    refuse('invalid-manifest-schema');
  }
  const release = COMPANION_RELEASES.find(item => item.id === value.tool);
  if (!release || value.version !== release.version || value.sourceCommit !== release.sourceCommit ||
    value.releaseUrl !== release.releaseUrl) refuse('unreviewed-release-identity');
  if (!PLATFORMS.has(platform) || value.platform !== platform) refuse('unsupported-platform');
  if (!['qualified', 'unqualified', 'unsupported'].includes(value.qualification as string)) refuse('invalid-qualification');
  if (value.qualification !== 'qualified') refuse('artifact-not-qualified');
  if (!relativePath(value.entrypoint) || !Array.isArray(value.files) || value.files.length === 0 ||
    value.files.length > MAX_FILES) refuse('invalid-file-set');
  const paths = new Set<string>();
  let totalBytes = 0;
  for (const file of value.files) {
    if (!keys(file, ['path', 'sha256', 'bytes', 'mode']) || !relativePath(file.path) ||
      typeof file.sha256 !== 'string' || !SHA256.test(file.sha256) || !Number.isSafeInteger(file.bytes) ||
      (file.bytes as number) < 0 || ![0o644, 0o755].includes(file.mode as number)) refuse('invalid-file-record');
    const path = file.path.toLowerCase();
    if (paths.has(path)) refuse('duplicate-file-path');
    paths.add(path);
    totalBytes += file.bytes as number;
    if (totalBytes > MAX_ARTIFACT_BYTES) refuse('artifact-size-limit');
  }
  for (const path of paths) {
    const parts = path.split('/');
    for (let i = 1; i < parts.length; i++) if (paths.has(parts.slice(0, i).join('/'))) refuse('file-directory-conflict');
  }
  const entrypoint = value.files.find(file => file.path === value.entrypoint);
  if (!entrypoint || entrypoint.mode !== 0o755 || entrypoint.bytes === 0) refuse('invalid-entrypoint');
  return value as unknown as CompanionArtifactManifest;
}

function stat(path: string): Stats | null {
  try { return lstatSync(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    refuse('filesystem-inspection-failed');
  }
}

/** Reject symlinks at every existing component, including roots and their ancestors. */
function safeDirectory(path: string, allowMissing: boolean): void {
  if (!isAbsolute(path) || resolve(path) !== path) refuse('roots-must-be-canonical-absolute');
  const root = parse(path).root;
  let current = root;
  for (const part of path.slice(root.length).split(sep).filter(Boolean)) {
    current = join(current, part);
    const info = stat(current);
    if (!info) {
      if (allowMissing) return;
      refuse('root-directory-missing');
    }
    if (info.isSymbolicLink() || !info.isDirectory()) refuse('unsafe-directory-component');
  }
}

function unchanged(a: Stats, b: Stats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mode === b.mode &&
    a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs && a.nlink === b.nlink;
}

function snapshot(root: string, path: string, limit: number, capture = false):
  { sha256: string; bytes: number; mode: number; contents: Buffer | null } | null {
  const parts = path.split('/');
  safeDirectory(join(root, ...parts.slice(0, -1)), true);
  const absolute = join(root, ...parts);
  const before = stat(absolute);
  if (!before) return null;
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) refuse('unsafe-file');
  if (before.size > limit) refuse('artifact-size-limit');
  let fd: number | undefined;
  try {
    fd = openSync(absolute, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    if (!unchanged(before, fstatSync(fd))) refuse('file-changed-during-inspection');
    const hash = createHash('sha256');
    const buffer = Buffer.alloc(64 * 1024);
    const chunks: Buffer[] = [];
    let bytes = 0;
    for (;;) {
      const count = readSync(fd, buffer, 0, buffer.length, null);
      if (count === 0) break;
      bytes += count;
      if (bytes > limit) refuse('artifact-size-limit');
      hash.update(buffer.subarray(0, count));
      if (capture) chunks.push(Buffer.from(buffer.subarray(0, count)));
    }
    const after = stat(absolute);
    if (bytes !== before.size || !after || !unchanged(before, after) || !unchanged(before, fstatSync(fd))) {
      refuse('file-changed-during-inspection');
    }
    return { sha256: hash.digest('hex'), bytes, mode: before.mode & 0o777, contents: capture ? Buffer.concat(chunks) : null };
  } finally { if (fd !== undefined) closeSync(fd); }
}

/** Existing destination contents outside the manifest would survive an overlay: refuse that ambiguity. */
function checkDestinationContents(destination: string, files: Set<string>): void {
  let count = 0;
  function visit(directory: string, prefix: string): void {
    if (!stat(directory)) return;
    safeDirectory(directory, false);
    const handle = opendirSync(directory);
    try {
      for (let entry = handle.readSync(); entry !== null; entry = handle.readSync()) {
        if (++count > MAX_FILES * 4) refuse('destination-size-limit');
        const path = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (!relativePath(path)) refuse('unsafe-destination-path');
        const info = stat(join(directory, entry.name));
        if (!info || info.isSymbolicLink()) refuse('unsafe-file');
        if (info.isDirectory()) {
          if (![...files].some(file => file.startsWith(`${path}/`))) refuse('unexpected-destination-content');
          visit(join(directory, entry.name), path);
        } else if (!info.isFile() || !files.has(path)) refuse('unexpected-destination-content');
      }
    } finally { handle.closeSync(); }
  }
  visit(destination, '');
}

export function planCompanionProvisioning(options: CompanionProvisioningOptions): CompanionProvisioningPlan {
  const plan: CompanionProvisioningPlan = { schemaVersion: 1, status: 'blocked', installed: false,
    runtimeCapability: 'not-inspected', effects: [], blockers: [], manifestSha256: null, artifact: null,
    destination: null, files: [], requiresRevalidationBeforeApply: true };
  try {
    if (!SHA256.test(options.trustedManifestSha256)) refuse('trusted-manifest-digest-required');
    if (!relativePath(options.manifestPath)) refuse('unsafe-manifest-path');
    safeDirectory(options.artifactRoot, false);
    safeDirectory(options.destinationRoot, false);
    const source = snapshot(options.artifactRoot, options.manifestPath, MAX_MANIFEST_BYTES, true);
    if (!source) refuse('manifest-missing');
    plan.manifestSha256 = source.sha256;
    if (source.sha256 !== options.trustedManifestSha256) refuse('manifest-digest-mismatch');
    let parsed: unknown;
    try { parsed = JSON.parse(source.contents!.toString('utf8')); }
    catch { refuse('invalid-manifest-json'); }
    const record = manifest(parsed, options.platform ?? `${process.platform}-${process.arch}`);
    if (record.files.some(file => file.path === options.manifestPath)) refuse('manifest-cannot-be-payload');
    const destination = join(options.destinationRoot, `${record.tool}-${record.version}-${record.platform}`);
    safeDirectory(destination, true);
    checkDestinationContents(destination, new Set(record.files.map(file => file.path)));
    const files: CompanionProvisioningFilePlan[] = [];
    let beforeBytes = 0;
    for (const file of record.files) {
      const artifact = snapshot(options.artifactRoot, file.path, file.bytes);
      if (!artifact || artifact.bytes !== file.bytes || artifact.sha256 !== file.sha256) refuse('artifact-digest-mismatch');
      const before = snapshot(destination, file.path, MAX_ARTIFACT_BYTES - beforeBytes);
      beforeBytes += before?.bytes ?? 0;
      files.push({ ...file, source: join(options.artifactRoot, ...file.path.split('/')),
        destination: join(destination, ...file.path.split('/')),
        action: !before ? 'create' : before.sha256 === file.sha256 && before.mode === file.mode ? 'retain' : 'replace',
        beforeImage: before ? { state: 'present', sha256: before.sha256, bytes: before.bytes, mode: before.mode } : { state: 'absent' } });
    }
    plan.artifact = { tool: record.tool, version: record.version, sourceCommit: record.sourceCommit,
      platform: record.platform, entrypoint: record.entrypoint };
    plan.destination = destination;
    plan.files = files;
    plan.status = 'verified-plan';
  } catch (error) {
    // Do not forward raw filesystem errors or payload bytes into reports.
    plan.blockers = [error instanceof Blocked ? error.message : 'filesystem-inspection-failed'];
  }
  return plan;
}
