/** Closed installed evaluator identities. Seed files never grant host execution authority. */
import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import type { BigIntStats } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PREPARATION_MEASUREMENT_BUILTIN = 'preparation-measurement-v1' as const;
export type BuiltinEvaluatorId = typeof PREPARATION_MEASUREMENT_BUILTIN;
const FILES = ['preparation-bridge.mjs', 'preparation-verification-activity.mjs', 'preparation-verification-child.mjs',
  'preparation-verification-controller.mjs', 'preparation-verification-protocol.mjs', 'preparation-verification-tool.mjs',
  'preparation-verification.mjs'] as const;
const HASH = /^[a-f0-9]{64}$/;
const TOOLS = ['/usr/bin/git', '/bin/ls', '/bin/ps', '/usr/bin/sandbox-exec'] as const;
const sha = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');
const unavailable = (): Error => new Error('Installed built-in evaluator unavailable or changed');

export interface InstalledBuiltinEvaluator {
  id: BuiltinEvaluatorId;
  digest: string;
  executableDigest: string;
  command: string[];
  files: Array<{ name: string; path: string; digest: string }>;
  tools: Array<{ path: string; digest: string }>;
}

function exact(value: unknown, keys: string[]): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value)) && Reflect.ownKeys(value).length === keys.length &&
    keys.every(key => Object.hasOwn(Object.getOwnPropertyDescriptor(value, key) ?? {}, 'value'));
}
function same(a: BigIntStats, b: BigIntStats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs && a.mode === b.mode && a.nlink === b.nlink;
}
function regular(path: string, limit: number, systemTool = false): { bytes: Buffer; stat: BigIntStats } {
  const before = lstatSync(path, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || (systemTool ? before.nlink < 1n : before.nlink !== 1n) || before.size < 1n || before.size > BigInt(limit) ||
      (before.mode & 0o022n) !== 0n || realpathSync(path) !== path) throw unavailable();
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (!same(before, fstatSync(fd, { bigint: true }))) throw unavailable();
    const bytes = readFileSync(fd);
    if (bytes.length !== Number(before.size) || !same(before, fstatSync(fd, { bigint: true })) ||
        !same(before, lstatSync(path, { bigint: true }))) throw unavailable();
    return { bytes, stat: before };
  } finally { closeSync(fd); }
}

// The host statically imports these helpers. Never adopt newly edited bundle
// bytes while this process is still executing the previously loaded helpers.
const HOST_HELPERS = (() => {
  try {
    return ['preparation-verification-activity.mjs', 'preparation-verification-protocol.mjs'].map(name => {
      const path = fileURLToPath(new URL(`../../../scripts/evaluators/${name}`, import.meta.url));
      return { name, path, digest: sha(regular(path, 256 * 1024).bytes) };
    });
  } catch { return null; } // A missing optional built-in never disables legacy evaluators.
})();

/** Read-only verifier, not a dispatch resolver. Runtime selection never accepts this path from a manifest. */
export function inspectBuiltinEvaluatorBundle(directory: string): InstalledBuiltinEvaluator {
  try {
    if (process.platform !== 'darwin' || HOST_HELPERS === null) throw unavailable();
    const anchor = lstatSync(directory, { bigint: true });
    if (!anchor.isDirectory() || anchor.isSymbolicLink() || (anchor.mode & 0o022n) !== 0n || realpathSync(directory) !== directory ||
        JSON.stringify(readdirSync(directory).sort()) !== JSON.stringify([...FILES, 'manifest.json'].sort())) throw unavailable();
    const manifestPath = join(directory, 'manifest.json');
    const manifestFile = regular(manifestPath, 16 * 1024);
    const manifest: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(manifestFile.bytes));
    if (!exact(manifest, ['schemaVersion', 'id', 'files']) || manifest.schemaVersion !== 1 || manifest.id !== PREPARATION_MEASUREMENT_BUILTIN ||
        !Array.isArray(manifest.files) || manifest.files.length !== FILES.length) throw unavailable();
    const rows = manifest.files;
    const captured = FILES.map((name, index) => {
      const row: unknown = rows[index];
      if (!exact(row, ['name', 'digest']) || row.name !== name || typeof row.digest !== 'string' || !HASH.test(row.digest)) throw unavailable();
      const path = join(directory, name), file = regular(path, 32 * 1024 * 1024), digest = sha(file.bytes);
      if (digest !== row.digest) throw unavailable();
      return { name, path, digest, stat: file.stat };
    });
    const executable = regular(process.execPath, 256 * 1024 * 1024), executableDigest = sha(executable.bytes);
    // Apple's fixed /usr/bin/git launcher is intentionally hard-linked to other
    // system tool launchers. Only these closed native paths permit hard links.
    const nativeTools = TOOLS.map(path => { const file = regular(path, 256 * 1024 * 1024, true); return { path, digest: sha(file.bytes), stat: file.stat }; });
    const hostHelpers = HOST_HELPERS.map(helper => {
      const file = regular(helper.path, 256 * 1024);
      if (sha(file.bytes) !== helper.digest || captured.find(row => row.name === helper.name)?.digest !== helper.digest) throw unavailable();
      return { path: helper.path, stat: file.stat };
    });
    for (const file of [...captured, ...nativeTools, ...hostHelpers, { path: manifestPath, stat: manifestFile.stat }]) {
      if (!same(file.stat, lstatSync(file.path, { bigint: true }))) throw unavailable();
    }
    if (!same(anchor, lstatSync(directory, { bigint: true })) || !same(executable.stat, lstatSync(process.execPath, { bigint: true }))) throw unavailable();
    const files = captured.map(({ name, path, digest }) => ({ name, path, digest }));
    const tools = nativeTools.map(({ path, digest }) => ({ path, digest }));
    const command = [process.execPath, '--experimental-vm-modules', '--no-warnings',
      join(directory, 'preparation-verification.mjs'), join(directory, 'preparation-bridge.mjs')];
    return { id: PREPARATION_MEASUREMENT_BUILTIN, executableDigest, command, files, tools,
      digest: sha(JSON.stringify({ schemaVersion: 1, id: PREPARATION_MEASUREMENT_BUILTIN,
        manifestDigest: sha(manifestFile.bytes), files: files.map(({ name, digest }) => ({ name, digest })),
        executable: { path: process.execPath, digest: executableDigest }, tools })) };
  } catch { throw unavailable(); }
}

export function resolveBuiltinEvaluator(id: BuiltinEvaluatorId): InstalledBuiltinEvaluator {
  if (id !== PREPARATION_MEASUREMENT_BUILTIN || process.platform !== 'darwin' || Number(process.versions.node.split('.')[0]) < 24) throw unavailable();
  const modulePath = fileURLToPath(import.meta.url);
  // Source-mode development still consumes the built installed asset, never a
  // source script or candidate-controlled bridge. Compiled runtime sidecars are local.
  const directory = modulePath.endsWith('/src/core/universe/builtin-evaluator-registry.ts')
    ? join(dirname(modulePath), '../../../dist/core/universe/builtins/preparation')
    : join(dirname(modulePath), 'builtins/preparation');
  return inspectBuiltinEvaluatorBundle(directory);
}
