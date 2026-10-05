/** Package-owned worker selection only. Source identity is not an account,
 * billing or standing-authority attestation; the host supplies those fences. */
import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync, type BigIntStats } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseBuildIdentity } from '../build-identity.js';
import { bundledIntoSingleFileBinary } from '../resources/probe-helper-invocation.js';

export const CLAUDE_TOOL_WORKER_FLAG = '--_claude-broker-tool-worker';
export const CLAUDE_TOOL_WORKER_SOURCE_SYMBOL = Symbol.for('ashlr.claude-tool-worker-source.v1');
const MAX_SOURCE_BYTES = 128 * 1024;
const sha = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
export interface ClaudeBrokerToolInvocation {
  bin: string;
  args: string[];
  readOnlyPaths: string[];
  workerDigest: string;
  /** Recheck immediately at each owned tool spawn, never serialize this fence. */
  isCurrent(): boolean;
}
function exact(value: unknown, keys: string[]): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
/** A build snapshot proves its own bytes and build binding, never live authority. */
export function embeddedClaudeToolWorkerDigest(raw: unknown, identity: unknown): string {
  if (typeof raw !== 'string' || Buffer.byteLength(raw) > MAX_SOURCE_BYTES * 2 || typeof identity !== 'string') throw new Error('Tool worker source unavailable');
  const build = parseBuildIdentity(identity);
  const value: unknown = JSON.parse(raw);
  if (!build || build.provenance === 'unavailable' || !build.revision || build.dirty === true
    || !exact(value, ['schemaVersion', 'buildIdentityJson', 'text', 'sha256']) || value.schemaVersion !== 1
    || value.buildIdentityJson !== identity || typeof value.text !== 'string' || value.text.length === 0
    || Buffer.byteLength(value.text) > MAX_SOURCE_BYTES || typeof value.sha256 !== 'string'
    || !/^[a-f0-9]{64}$/.test(value.sha256) || sha(value.text) !== value.sha256) throw new Error('Tool worker source unavailable');
  return value.sha256;
}
function same(a: BigIntStats, b: BigIntStats): boolean {
  return ['dev', 'ino', 'mode', 'nlink', 'size', 'mtimeNs', 'ctimeNs'].every(key => a[key as keyof BigIntStats] === b[key as keyof BigIntStats]);
}
function openSource(path: string): { fd: number; stat: BigIntStats } {
  if (realpathSync(path) !== path) throw new Error('Tool worker source unavailable');
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd, { bigint: true });
    if (!stat.isFile() || stat.nlink !== 1n || (stat.mode & 0o022n) !== 0n
      || !same(stat, lstatSync(path, { bigint: true }))) throw new Error('Tool worker source unavailable');
    return { fd, stat };
  } catch (error) { closeSync(fd); throw error; }
}
function fileSource(path: string): { stat: BigIntStats; digest: string } {
  const { fd, stat } = openSource(path);
  try {
    if (stat.size < 1n || stat.size > BigInt(MAX_SOURCE_BYTES)) throw new Error('Tool worker source unavailable');
    const buffer = Buffer.alloc(Number(stat.size) + 1);
    const count = readSync(fd, buffer, 0, buffer.length, 0);
    if (count !== Number(stat.size) || !same(stat, fstatSync(fd, { bigint: true }))
      || !same(stat, lstatSync(path, { bigint: true }))) throw new Error('Tool worker source unavailable');
    return { stat, digest: sha(buffer.subarray(0, count)) };
  } finally { closeSync(fd); }
}
/** Byte/epoch observation utility only; not an executable or authority grant. */
export function observeClaudeToolWorkerFile(path: string): { digest: string; isCurrent(): boolean } {
  // Windows synthetic stat mode bits cannot attest the required POSIX source
  // permissions. No ACL equivalence or native tool jail is qualified here.
  if (process.platform === 'win32') throw new Error('Tool worker source integrity unsupported');
  const fixed = fileSource(path);
  return { digest: fixed.digest, isCurrent: () => {
    try { const fresh = fileSource(path); return same(fixed.stat, fresh.stat) && fresh.digest === fixed.digest; }
    catch { return false; }
  } };
}
/** The caller cannot inject a worker path, digest, runtime or trusted snapshot. */
export function resolveClaudeBrokerToolInvocation(): ClaudeBrokerToolInvocation {
  if (process.platform === 'win32') throw new Error('Native Claude tool worker unsupported');
  const bin = realpathSync(process.execPath);
  const binary = openSource(bin); closeSync(binary.fd);
  const binaryCurrent = (): boolean => {
    try { const current = openSource(bin); try { return same(binary.stat, current.stat); } finally { closeSync(current.fd); } }
    catch { return false; }
  };
  if (bundledIntoSingleFileBinary(import.meta.url)) {
    const raw: unknown = Reflect.get(globalThis, CLAUDE_TOOL_WORKER_SOURCE_SYMBOL);
    const identity: unknown = Reflect.get(globalThis, Symbol.for('ashlr.build-identity.v1'));
    const digest = embeddedClaudeToolWorkerDigest(raw, identity);
    return { bin, args: [CLAUDE_TOOL_WORKER_FLAG], readOnlyPaths: [], workerDigest: digest,
      isCurrent: () => binaryCurrent() && Reflect.get(globalThis, CLAUDE_TOOL_WORKER_SOURCE_SYMBOL) === raw
        && Reflect.get(globalThis, Symbol.for('ashlr.build-identity.v1')) === identity };
  }
  const source = import.meta.url.endsWith('.ts');
  const path = fileURLToPath(new URL(`./claude-broker-tool-worker.${source ? 'ts' : 'js'}`, import.meta.url));
  const fixed = observeClaudeToolWorkerFile(path);
  // This worker has only erasable types and stdlib imports: dev Node needs no
  // loader/dependency directories admitted into the tool jail. Bun reads TS.
  const args = source && !process.versions['bun'] ? ['--experimental-strip-types', path] : [path];
  return { bin, args, readOnlyPaths: [path], workerDigest: fixed.digest, isCurrent: () => {
    try { return binaryCurrent() && fixed.isCurrent(); }
    catch { return false; }
  } };
}
