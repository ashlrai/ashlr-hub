import { closeSync, constants, fstatSync, lstatSync, mkdtempSync, openSync, readFileSync, realpathSync,
  rmdirSync, unlinkSync, writeFileSync, type Stats } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { buildSandboxLauncher, escapeSbplPath } from '../sandbox/confine.js';
import { runVerifySubprocessAsync } from '../run/verify-commands.js';
import { artifactDigest, canonical, digest, readArtifactSnapshot } from './artifacts.js';
import { fileOperationsPathKey, validateGenerationConfig } from './generation.js';
import { FILE_OPERATIONS_WORKER } from './file-operations-worker.js';
import type { UniverseGenerationConfig } from './types.js';
import type { UniverseFileOperationEvidence } from './file-operations-types.js';

interface FileIdentity { dev: number; ino: number; size: number; mode: number; mtimeMs: number; ctimeMs: number }
export interface FileOperationInput { path: string; contentDigest: string | null; content: string | null; stat: FileIdentity | null }
export interface FileOperationsSnapshot {
  root: string;
  rootIdentity: { dev: number; ino: number };
  runtime: { path: string; stat: FileIdentity };
  artifactDigest: string;
  entries: Array<{ path: string; executable: boolean; size: number; digest: string }>;
  files: FileOperationInput[];
  contextFiles: FileOperationInput[];
}
export type FileOperation = { op: 'create' | 'replace'; path: string; content: string } | { op: 'delete'; path: string };
export class FileOperationsTimeoutError extends Error {}

function fail(message: string): never { throw new Error(`Model file operations: ${message}`); }
function identity(stat: Stats): FileIdentity {
  return { dev: stat.dev, ino: stat.ino, size: stat.size, mode: stat.mode, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs };
}
function same(before: FileIdentity, after: Stats): boolean {
  return Object.entries(before).every(([key, value]) => after[key as keyof FileIdentity] === value);
}
function missing(error: unknown): boolean { return !!error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT'; }
function readInput(root: string, path: string): FileOperationInput {
  const absent = (): FileOperationInput => ({ path, contentDigest: null, content: null, stat: null });
  let ancestor = root;
  for (const part of path.split('/').slice(0, -1)) {
    ancestor = join(ancestor, part);
    let stat: Stats;
    try { stat = lstatSync(ancestor); } catch (error) { if (missing(error)) return absent(); throw error; }
    if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(ancestor) !== ancestor) fail('declared ancestors must be real directories');
  }
  const absolute = join(root, path);
  let stat: Stats;
  try { stat = lstatSync(absolute); } catch (error) { if (missing(error)) return absent(); throw error; }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || realpathSync(absolute) !== absolute) {
    fail('declared files must be regular single-link files without aliases');
  }
  if (stat.size > 64 * 1024) fail('declared text exceeds the per-file byte limit');
  const original = identity(stat);
  const fd = openSync(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (!same(original, fstatSync(fd))) fail('declared file changed before reading');
    const bytes = readFileSync(fd);
    if (bytes.length !== stat.size || !same(original, fstatSync(fd)) || !same(original, lstatSync(absolute))) {
      fail('declared file changed while reading');
    }
    let content: string;
    try { content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
    catch { return fail('declared files must be valid UTF-8 text'); }
    if (content.includes('\0')) fail('declared files must not contain NUL');
    return { path, content, contentDigest: digest(bytes), stat: original };
  } finally { closeSync(fd); }
}

/** The opt-in path is separate so legacy replacement prompts and writes do not change. */
export function readFileOperationsSnapshot(candidatePath: string, config: UniverseGenerationConfig): FileOperationsSnapshot {
  const validated = validateGenerationConfig(config);
  if (!validated.fileOperations) fail('explicit opt-in configuration required');
  if (process.platform !== 'darwin') fail('macOS confinement is required before model contact');
  const root = resolve(candidatePath);
  const stat = lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(root) !== root) fail('candidate must be a real directory');
  const runtime = realpathSync(process.execPath);
  const runtimeStat = lstatSync(runtime);
  if (!runtimeStat.isFile() || runtimeStat.isSymbolicLink()) fail('current Node runtime must be a real file');
  const files = validated.files.map((path) => readInput(root, path));
  const contextFiles = validated.fileOperations.contextFiles.map((path) => readInput(root, path));
  if (contextFiles.some((file) => file.content === null)) fail('read-only context files must exist');
  if ([...files, ...contextFiles].reduce((sum, file) => sum + Buffer.byteLength(file.content ?? '', 'utf8'), 0) > 128 * 1024) {
    fail('combined declared text exceeds the context byte limit');
  }
  if (lstatSync(root).ino !== stat.ino || lstatSync(root).dev !== stat.dev) fail('candidate directory changed while reading');
  const tree = readArtifactSnapshot(root);
  const entries = tree.entries.map((entry) => ({ path: entry.path, executable: entry.executable, size: entry.data.length, digest: digest(entry.data) }));
  for (const file of [...files, ...contextFiles]) {
    const key = fileOperationsPathKey(file.path);
    const aliases = entries.filter((entry) => fileOperationsPathKey(entry.path) === key);
    if (aliases.some((entry) => entry.path !== file.path) ||
        (entries.find((entry) => entry.path === file.path)?.digest ?? null) !== file.contentDigest) {
      fail('declared state does not match the complete candidate artifact');
    }
  }
  return { root, rootIdentity: { dev: stat.dev, ino: stat.ino }, runtime: { path: runtime, stat: identity(runtimeStat) },
    artifactDigest: tree.digest, entries, files, contextFiles };
}

/** Validate the entire response before creating directories or modifying a file. */
export function parseFileOperations(content: string, snapshot: FileOperationsSnapshot): FileOperation[] {
  let value: unknown;
  try { value = JSON.parse(content) as unknown; } catch { return fail('response must be strict JSON operations'); }
  const exact = (item: unknown, keys: string[]): item is Record<string, unknown> =>
    item !== null && typeof item === 'object' && !Array.isArray(item) &&
    Object.keys(item).length === keys.length && Object.keys(item).every((key) => keys.includes(key));
  if (!exact(value, ['operations']) || !Array.isArray(value.operations) ||
      value.operations.length > snapshot.files.length) fail('response must contain a bounded operations array only');
  const seen = new Set<string>();
  let total = 0;
  return value.operations.map((operation: unknown) => {
    if (!operation || typeof operation !== 'object' || Array.isArray(operation)) fail('each operation must be an exact object');
    const entry = operation as Record<string, unknown>;
    if (!['create', 'replace', 'delete'].includes(String(entry.op)) ||
        !exact(entry, entry.op === 'delete' ? ['op', 'path'] : ['op', 'path', 'content']) || typeof entry.path !== 'string') {
      fail('operations must be exact create, replace, or delete objects');
    }
    const file = snapshot.files.find((item) => item.path === entry.path);
    if (!file || seen.has(entry.path)) fail('each operation must target a unique declared mutable path');
    seen.add(entry.path);
    if ((entry.op === 'create') !== (file.content === null)) fail('operation must match the declared present or absent parent state');
    if (entry.op === 'delete') return { op: 'delete', path: entry.path };
    if (typeof entry.content !== 'string' || entry.content.includes('\0') || Buffer.from(entry.content, 'utf8').toString('utf8') !== entry.content) {
      fail('new and replacement files must be valid NUL-free UTF-8 text');
    }
    const bytes = Buffer.byteLength(entry.content, 'utf8');
    total += bytes;
    if (bytes > 64 * 1024 || total > 128 * 1024) fail('new and replacement text exceeds the byte limit');
    return { op: entry.op as 'create' | 'replace', path: entry.path, content: entry.content };
  });
}

function workerArgv(snapshot: FileOperationsSnapshot, input: string, inputDigest: string): string[] {
  const scratch = dirname(input);
  const launcher = buildSandboxLauncher({ mode: 'os', networkEgress: false, onUnsupported: 'fail',
    readAllowed: [scratch, dirname(snapshot.runtime.path)] }, { worktree: snapshot.root, home: homedir(), env: { TMPDIR: scratch } });
  if (!launcher || process.platform !== 'darwin') fail('macOS confinement is required before model contact');
  const sub = (path: string): string => `(subpath "${escapeSbplPath(path)}")`;
  const ancestors = new Set<string>();
  for (const path of [snapshot.root, input, snapshot.runtime.path]) {
    for (let parent = dirname(path); ; parent = dirname(parent)) {
      ancestors.add(parent);
      if (dirname(parent) === parent) break;
    }
  }
  const profile = `${launcher.prefixArgs[1]}\n` +
    `(deny file-read* ${sub(homedir())})\n` +
    `(allow file-read* ${sub(snapshot.root)} ${sub(scratch)} ${sub(dirname(snapshot.runtime.path))})\n` +
    `(allow file-read-metadata ${[...ancestors].map((path) => `(literal "${escapeSbplPath(path)}")`).join(' ')})\n` +
    `(deny network*)\n(deny file-write*)\n(allow file-write* ${sub(snapshot.root)} (literal "/dev/null"))\n`;
  return ['/usr/bin/sandbox-exec', '-p', profile, snapshot.runtime.path, '--no-addons', '--no-warnings',
    '-e', FILE_OPERATIONS_WORKER, input, inputDigest];
}

async function runWorker(snapshot: FileOperationsSnapshot, operations: FileOperation[], mode: 'check' | 'apply',
  options: { signal: AbortSignal; timeoutMs: number }): Promise<void> {
  if (options.signal.aborted || !Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 900_000) {
    fail('worker requires a remaining positive time budget');
  }
  if (realpathSync(process.execPath) !== snapshot.runtime.path || !same(snapshot.runtime.stat, lstatSync(snapshot.runtime.path))) {
    fail('current Node runtime changed before application');
  }
  const baseline = ({ path, contentDigest, stat }: FileOperationInput): Omit<FileOperationInput, 'content'> => ({ path, contentDigest, stat });
  const data = canonical({ schemaVersion: 1, mode, root: snapshot.root, rootIdentity: snapshot.rootIdentity,
    runtime: snapshot.runtime, files: snapshot.files.map(baseline), contextFiles: snapshot.contextFiles.map(baseline), operations });
  if (Buffer.byteLength(data, 'utf8') > 1024 * 1024) fail('worker input exceeds its byte limit');
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'ashlr-universe-file-operations-')));
  const input = join(scratch, 'operations.json');
  let cleanupFailed = false;
  try {
    writeFileSync(input, data, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    const result = await runVerifySubprocessAsync(workerArgv(snapshot, input, digest(data)), {
      cwd: snapshot.root, timeoutMs: options.timeoutMs, signal: options.signal,
      // Do not inherit Node flags, preload hooks, provider variables, or user homes.
      env: { PATH: '/usr/bin:/bin', TMPDIR: scratch, LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', NO_COLOR: '1' },
    });
    if (result.timedOut) throw new FileOperationsTimeoutError('Model file operations: worker exceeded its remaining time budget');
    if (result.exitCode !== 0 || result.signal !== null || result.error || result.cancelled || result.timedOut || result.stdout !== '{"ok":true}' || result.stderr !== '') {
      fail(mode === 'check' ? 'confined preflight could not verify candidate state' : 'confined application failed; candidate is not accepted');
    }
    if (!same(snapshot.runtime.stat, lstatSync(snapshot.runtime.path))) fail('current Node runtime changed during application');
  } finally {
    try { unlinkSync(input); } catch (error) { if (!missing(error)) cleanupFailed = true; }
    try { rmdirSync(scratch); } catch { cleanupFailed = true; }
  }
  if (cleanupFailed) fail('private worker input cleanup could not be verified');
}

/** Establish that this exact worker/profile can launch before spending model tokens. */
export async function preflightFileOperations(snapshot: FileOperationsSnapshot, options: { signal: AbortSignal; timeoutMs: number }): Promise<void> {
  await runWorker(snapshot, [], 'check', options);
}

/** Nontransactional scratch writes: any error prevents evaluation/archive admission. */
export async function applyFileOperations(snapshot: FileOperationsSnapshot, operations: FileOperation[],
  options: { signal: AbortSignal; timeoutMs: number }): Promise<UniverseFileOperationEvidence[]> {
  // The worker independently repeats structure validation, even for direct callers.
  const validated = parseFileOperations(JSON.stringify({ operations }), snapshot);
  if (artifactDigest(snapshot.root) !== snapshot.artifactDigest) fail('candidate artifact changed during model generation');
  await runWorker(snapshot, validated, 'apply', options);
  const evidence: UniverseFileOperationEvidence[] = [];
  const rootStat = lstatSync(snapshot.root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || realpathSync(snapshot.root) !== snapshot.root ||
      rootStat.ino !== snapshot.rootIdentity.ino || rootStat.dev !== snapshot.rootIdentity.dev) fail('candidate root changed during application');
  for (const file of [...snapshot.files, ...snapshot.contextFiles]) {
    const operation = validated.find((entry) => entry.path === file.path);
    const expected = operation ? (operation.op === 'delete' ? null : digest(operation.content)) : file.contentDigest;
    const current = readInput(snapshot.root, file.path);
    if (current.contentDigest !== expected || (!operation && file.stat !== null &&
        (!current.stat || canonical(current.stat) !== canonical(file.stat)))) fail('final declared state did not match the complete batch');
  }
  for (const operation of validated) {
    const beforeDigest = snapshot.files.find((file) => file.path === operation.path)!.contentDigest;
    const afterDigest = operation.op === 'delete' ? null : digest(operation.content);
    if (beforeDigest !== afterDigest) evidence.push({ op: operation.op, path: operation.path, beforeDigest, afterDigest });
  }
  const expectedEntries = new Map(snapshot.entries.map((entry) => [entry.path, { ...entry }]));
  for (const operation of validated) {
    if (operation.op === 'delete') expectedEntries.delete(operation.path);
    else expectedEntries.set(operation.path, { path: operation.path, executable: expectedEntries.get(operation.path)?.executable ?? false,
      size: Buffer.byteLength(operation.content, 'utf8'), digest: digest(operation.content) });
  }
  const expectedDigest = digest(canonical([...expectedEntries.values()].sort((a, b) => a.path.localeCompare(b.path))));
  if (artifactDigest(snapshot.root) !== expectedDigest) fail('complete candidate artifact exceeded the declared operation scope');
  return evidence;
}
