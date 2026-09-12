/** Closed installed evaluator identities. Seed files never grant host execution authority. */
import { constants, closeSync, fstatSync, lstatSync, openSync, readSync, readdirSync, realpathSync } from 'node:fs';
import type { BigIntStats } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolvePreparationGit, assertPreparationGit, type PreparationGitPin } from '../../../scripts/evaluators/preparation-verification-native.mjs';
import { parsePreparationMeasurementCalibration, preparationCalibrationWorkload } from './preparation-measurement-calibration.js';
import { canonical } from './artifacts.js';

export const PREPARATION_MEASUREMENT_BUILTIN = 'preparation-measurement-v1' as const;
export const PREPARATION_PROCESS_SCORE_BUILTIN = 'preparation-process-score-v1' as const;
export type BuiltinEvaluatorId = typeof PREPARATION_MEASUREMENT_BUILTIN | typeof PREPARATION_PROCESS_SCORE_BUILTIN;
const FILES = ['preparation-bridge.mjs', 'preparation-verification-activity.mjs', 'preparation-verification-child.mjs',
  'preparation-verification-controller.mjs', 'preparation-verification-fixtures.mjs', 'preparation-verification-native.mjs', 'preparation-verification-protocol.mjs',
  'preparation-verification-tool.mjs', 'preparation-verification.mjs'] as const;
const HASH = /^[a-f0-9]{64}$/;
export const PREPARATION_SCORE_FILES = Object.freeze(['preparation-score.mjs', 'calibration.json', 'measurement/manifest.json',
  ...FILES.map(name => `measurement/${name}`)]);
const TOOLS = ['/bin/ls', '/bin/ps', '/usr/bin/sandbox-exec'] as const;
const sha = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');
const unavailable = (): Error => new Error('Installed built-in evaluator unavailable or changed');

export interface InstalledBuiltinEvaluator {
  id: BuiltinEvaluatorId;
  digest: string;
  executableDigest: string;
  command: string[];
  files: Array<{ name: string; path: string; digest: string }>;
  tools: Array<{ path: string; digest: string }>;
  git: PreparationGitPin;
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
    // A concurrently growing file must not allocate beyond the captured bound.
    const bytes = Buffer.alloc(Number(before.size) + 1); let count = 0;
    while (count < bytes.length) {
      const got = readSync(fd, bytes, count, bytes.length - count, count);
      if (got === 0) break;
      count += got;
    }
    if (count !== Number(before.size) || !same(before, fstatSync(fd, { bigint: true })) ||
        !same(before, lstatSync(path, { bigint: true }))) throw unavailable();
    return { bytes: bytes.subarray(0, count), stat: before };
  } finally { closeSync(fd); }
}

// The host statically imports these helpers. Never adopt newly edited bundle
// bytes while this process is still executing the previously loaded helpers.
const HOST_HELPERS = (() => {
  try {
    return ['preparation-verification-activity.mjs', 'preparation-verification-native.mjs', 'preparation-verification-protocol.mjs'].map(name => {
      const path = fileURLToPath(new URL(`../../../scripts/evaluators/${name}`, import.meta.url));
      return { name, path, digest: sha(regular(path, 256 * 1024).bytes) };
    });
  } catch { return null; } // A missing optional built-in never disables legacy evaluators.
})();

/** Read-only verifier, not a dispatch resolver. Runtime selection never accepts this path from a manifest. */
export function inspectBuiltinEvaluatorBundle(directory: string): InstalledBuiltinEvaluator & { id: typeof PREPARATION_MEASUREMENT_BUILTIN } {
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
    // Pin developer Git itself, not Apple's launcher or candidate-selected PATH.
    const git = resolvePreparationGit();
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
    assertPreparationGit(git);
    const tools = [{ ...git }, ...nativeTools.map(({ path, digest }) => ({ path, digest }))];
    const command = [process.execPath, '--experimental-vm-modules', '--no-warnings',
      join(directory, 'preparation-verification.mjs'), join(directory, 'preparation-bridge.mjs')];
    return { id: PREPARATION_MEASUREMENT_BUILTIN, executableDigest, command, files, tools, git: { ...git },
      digest: sha(JSON.stringify({ schemaVersion: 1, id: PREPARATION_MEASUREMENT_BUILTIN,
        manifestDigest: sha(manifestFile.bytes), files: files.map(({ name, digest }) => ({ name, digest })),
        executable: { path: process.execPath, digest: executableDigest }, tools })) };
  } catch { throw unavailable(); }
}

export function resolveBuiltinEvaluator(id: typeof PREPARATION_MEASUREMENT_BUILTIN): InstalledBuiltinEvaluator & { id: typeof PREPARATION_MEASUREMENT_BUILTIN };
export function resolveBuiltinEvaluator(id: BuiltinEvaluatorId): InstalledBuiltinEvaluator;
export function resolveBuiltinEvaluator(id: BuiltinEvaluatorId): InstalledBuiltinEvaluator {
  if (![PREPARATION_MEASUREMENT_BUILTIN, PREPARATION_PROCESS_SCORE_BUILTIN].includes(id) ||
      process.platform !== 'darwin' || Number(process.versions.node.split('.')[0]) < 24) throw unavailable();
  const modulePath = fileURLToPath(import.meta.url);
  // Source-mode development still consumes the built installed asset, never a
  // source script or candidate-controlled bridge. Compiled runtime sidecars are local.
  const selected = id === PREPARATION_PROCESS_SCORE_BUILTIN ? 'preparation-score' : 'preparation';
  const directory = modulePath.endsWith('/src/core/universe/builtin-evaluator-registry.ts')
    ? join(dirname(modulePath), '../../../dist/core/universe/builtins', selected)
    : join(dirname(modulePath), 'builtins', selected);
  return id === PREPARATION_PROCESS_SCORE_BUILTIN ? inspectPreparationScoreBundle(directory) : inspectBuiltinEvaluatorBundle(directory);
}

/** Verify a closed score package without adopting its path as dispatch authority.
 * The nested diagnostic keeps its original aggregate; the outer aggregate pins
 * calibration and scoring policy without putting its own digest in either.
 */
export function inspectPreparationScoreBundle(directory: string): InstalledBuiltinEvaluator {
  try {
    const anchor = lstatSync(directory, { bigint: true });
    if (!anchor.isDirectory() || anchor.isSymbolicLink() || (anchor.mode & 0o022n) !== 0n || realpathSync(directory) !== directory ||
        canonical(readdirSync(directory).sort()) !== canonical(['calibration.json', 'manifest.json', 'measurement', 'preparation-score.mjs'])) throw unavailable();
    const nestedPath = join(directory, 'measurement');
    const nestedAnchor = lstatSync(nestedPath, { bigint: true });
    const nested = inspectBuiltinEvaluatorBundle(nestedPath);
    const manifestPath = join(directory, 'manifest.json'), manifestFile = regular(manifestPath, 16 * 1024);
    const decoder = new TextDecoder('utf-8', { fatal: true });
    const manifest: unknown = JSON.parse(decoder.decode(manifestFile.bytes));
    if (!exact(manifest, ['schemaVersion', 'id', 'files']) || manifest.schemaVersion !== 1 || manifest.id !== PREPARATION_PROCESS_SCORE_BUILTIN ||
        !Array.isArray(manifest.files) || manifest.files.length !== PREPARATION_SCORE_FILES.length) throw unavailable();
    const rows = manifest.files;
    const captured = PREPARATION_SCORE_FILES.map((name, index) => {
      const row: unknown = rows[index];
      if (!exact(row, ['name', 'digest']) || row.name !== name || typeof row.digest !== 'string' || !HASH.test(row.digest)) throw unavailable();
      const filePath = join(directory, name);
      const limit = name === 'calibration.json' ? 2 * 1024 * 1024 : name === 'measurement/manifest.json' ? 16 * 1024 : 32 * 1024 * 1024;
      const file = regular(filePath, limit), digest = sha(file.bytes);
      if (digest !== row.digest) throw unavailable();
      return { name, path: filePath, digest, stat: file.stat, bytes: file.bytes };
    });
    const calibration = parsePreparationMeasurementCalibration(decoder.decode(captured.find(file => file.name === 'calibration.json')!.bytes));
    if (calibration.workload.id !== 'preparation-workflows-v2' ||
        canonical(calibration.workload) !== canonical(preparationCalibrationWorkload(nested, 'preparation-workflows-v2'))) throw unavailable();
    if (canonical(inspectBuiltinEvaluatorBundle(nestedPath)) !== canonical(nested)) throw unavailable();
    for (const file of [...captured, { path: manifestPath, stat: manifestFile.stat }]) {
      if (!same(file.stat, lstatSync(file.path, { bigint: true }))) throw unavailable();
    }
    if (!same(anchor, lstatSync(directory, { bigint: true })) || !same(nestedAnchor, lstatSync(nestedPath, { bigint: true }))) throw unavailable();
    const files = captured.map(({ name, path, digest }) => ({ name, path, digest }));
    return { id: PREPARATION_PROCESS_SCORE_BUILTIN, executableDigest: nested.executableDigest, files,
      command: [process.execPath, '--experimental-vm-modules', '--no-warnings', join(directory, 'preparation-score.mjs'),
        join(nestedPath, 'preparation-bridge.mjs')], tools: nested.tools, git: nested.git,
      digest: sha(JSON.stringify({ schemaVersion: 1, id: PREPARATION_PROCESS_SCORE_BUILTIN,
        manifestDigest: sha(manifestFile.bytes), files: files.map(({ name, digest }) => ({ name, digest })),
        executable: { path: process.execPath, digest: nested.executableDigest }, tools: nested.tools })) };
  } catch { throw unavailable(); }
}
