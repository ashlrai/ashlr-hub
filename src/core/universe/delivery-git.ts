import { spawn, spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { canonical, digest, MAX_ARTIFACT_BYTES, type UniverseArtifactEntry } from './artifacts.js';

const OID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const MAX_ENTRIES = 8_192;
export interface GitTreeEntry { path: string; oid: string; executable: boolean }

/** Plumbing only: no index, checkout, filters, hooks, replacement objects, or lazy fetch. */
export function deliveryGit(repo: string, deadline = performance.now() + 120_000) {
  if (!isAbsolute(repo) || realpathSync(repo) !== repo) throw new Error('Delivery repository must remain canonical');
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? '/usr/bin:/bin', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_ATTR_NOSYSTEM: '1', GIT_NO_REPLACE_OBJECTS: '1',
    GIT_NO_LAZY_FETCH: '1', GIT_ALLOW_PROTOCOL: '', GIT_PROTOCOL_FROM_USER: '0',
    GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C',
  };
  const prefix = ['--no-replace-objects', '-c', 'core.hooksPath=/dev/null',
    '-c', 'core.fsmonitor=false', '-c', 'core.attributesFile=/dev/null', '-c', 'commit.gpgsign=false',
    '-c', 'tag.gpgsign=false', '-c', 'gc.auto=0', '-c', 'maintenance.auto=false',
    '-c', 'core.logAllRefUpdates=false', '-c', 'protocol.allow=never', '-C', repo];
  function invoke(args: string[], input?: Buffer | string, allowMissing = false, extra: NodeJS.ProcessEnv = {}, cutoff = deadline): Buffer | null {
    const remaining = Math.floor(Math.min(deadline, cutoff) - performance.now());
    if (remaining <= 0) throw new Error('Delivery Git operation deadline exceeded');
    const result = spawnSync('git', [...prefix, ...args], {
      env: { ...env, ...extra }, input, timeout: Math.min(30_000, remaining),
      maxBuffer: MAX_ARTIFACT_BYTES + 4 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'],
    });
    if (!result.error && result.status === 0) return result.stdout;
    if (!result.error && allowMissing && result.status === 1) return null;
    throw new Error(`Delivery Git ${args[0]} failed without changing the checkout`);
  }
  const text = (args: string[], input?: Buffer | string, extra?: NodeJS.ProcessEnv): string => invoke(args, input, false, extra)!.toString('utf8').trim();
  function oid(args: string[], input?: Buffer | string, extra?: NodeJS.ProcessEnv): string {
    const value = text(args, input, extra);
    if (!OID.test(value)) throw new Error('Delivery Git returned an invalid object identity');
    return value;
  }
  if (realpathSync(text(['rev-parse', '--show-toplevel'])) !== repo) throw new Error('Delivery seed is not the repository root');
  function ref(branch: string, cutoff = deadline): string | null {
    const name = `refs/heads/${branch}`;
    // symbolic-ref catches dangling symbolic refs that show-ref cannot resolve.
    if (invoke(['symbolic-ref', '-q', name], undefined, true, {}, cutoff) !== null) throw new Error('Delivery refuses symbolic branch refs');
    if (invoke(['show-ref', '--verify', '--quiet', name], undefined, true, {}, cutoff) === null) return null;
    const target = invoke(['rev-parse', '--verify', name], undefined, false, {}, cutoff)!.toString('utf8').trim();
    if (!OID.test(target)) throw new Error('Delivery branch has an invalid target');
    return target;
  }
  function entries(tree: string): GitTreeEntry[] {
    if (!OID.test(tree)) throw new Error('Invalid delivery tree identity');
    const list = invoke(['ls-tree', '-rz', '--full-tree', tree])!.toString('utf8').split('\0').filter(Boolean);
    if (list.length > MAX_ENTRIES) throw new Error('Delivery Git tree entry limit exceeded');
    return list.map((line) => {
      const match = /^(100644|100755) blob ([a-f0-9]{40}|[a-f0-9]{64})\t([\s\S]+)$/.exec(line);
      if (!match || match[3]!.split('/').some((part) => !part || part === '.' || part === '..' || /^\.(?:git|ashlr)$/i.test(part))) {
        throw new Error('Delivery Git tree contains unsupported entries');
      }
      return { path: match[3]!, oid: match[2]!, executable: match[1] === '100755' };
    });
  }
  function treeDigest(tree: string): string {
    const list = entries(tree);
    if (!list.length) return digest(canonical([]));
    const bytes = invoke(['cat-file', '--batch'], list.map((entry) => entry.oid).join('\n') + '\n')!;
    let offset = 0;
    let total = 0;
    const summaries = list.map((entry) => {
      const end = bytes.indexOf(10, offset);
      if (end < 0) throw new Error('Delivery object batch is incomplete');
      const header = bytes.subarray(offset, end).toString('ascii');
      const match = /^([a-f0-9]{40}|[a-f0-9]{64}) blob (0|[1-9][0-9]*)$/.exec(header);
      if (!match || match[1] !== entry.oid) throw new Error('Delivery object batch identity changed');
      const size = Number(match[2]);
      total += size;
      if (!Number.isSafeInteger(size) || total > MAX_ARTIFACT_BYTES || end + size + 1 >= bytes.length || bytes[end + size + 1] !== 10) {
        throw new Error('Delivery object batch exceeds its byte envelope');
      }
      const data = bytes.subarray(end + 1, end + 1 + size);
      offset = end + size + 2;
      return { path: entry.path, executable: entry.executable, size, digest: digest(data) };
    });
    if (offset !== bytes.length) throw new Error('Delivery object batch contains trailing bytes');
    return digest(canonical(summaries.sort((a, b) => a.path.localeCompare(b.path))));
  }
  function writeTree(snapshot: UniverseArtifactEntry[]): string {
    interface Directory { files: Array<{ name: string; mode: string; oid: string }>; children: Map<string, Directory> }
    const root: Directory = { files: [], children: new Map() };
    for (const entry of snapshot) {
      const parts = entry.path.split('/');
      let directory = root;
      for (const part of parts.slice(0, -1)) {
        if (!directory.children.has(part)) directory.children.set(part, { files: [], children: new Map() });
        directory = directory.children.get(part)!;
      }
      directory.files.push({ name: parts.at(-1)!, mode: entry.executable ? '100755' : '100644', oid: oid(['hash-object', '-w', '--stdin', '--no-filters'], entry.data) });
    }
    function write(directory: Directory): string {
      const lines = directory.files.map((entry) => `${entry.mode} blob ${entry.oid}\t${entry.name}\0`);
      for (const [name, child] of directory.children) lines.push(`040000 tree ${write(child)}\t${name}\0`);
      return oid(['mktree', '-z'], lines.join(''));
    }
    return write(root);
  }
  function assertNotCheckedOut(branch: string, cutoff = deadline): void {
    const entries = invoke(['worktree', 'list', '--porcelain', '-z'], undefined, false, {}, cutoff)!.toString('utf8').split('\0');
    if (entries.includes(`branch refs/heads/${branch}`)) throw new Error('Delivery branch is checked out in an existing worktree');
  }
  async function createRef(branch: string, commit: string): Promise<void> {
    const remaining = Math.min(30_000, Math.floor(deadline - performance.now()));
    if (remaining <= 0) throw new Error('Delivery Git operation deadline exceeded');
    const transactionDeadline = Math.min(deadline, performance.now() + remaining);
    await new Promise<void>((resolve, reject) => {
      const child = spawn('git', [...prefix, 'update-ref', '--stdin'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
      let output = '';
      let error: Error | null = null;
      let phase: 'preparing' | 'committing' | 'aborting' = 'preparing';
      let hardKill: ReturnType<typeof setTimeout> | undefined;
      const timer = setTimeout(() => {
        abort(new Error('Delivery Git ref transaction timed out'));
        child.kill('SIGTERM');
        hardKill = setTimeout(() => child.kill('SIGKILL'), 1_000);
      }, remaining);
      function abort(reason: Error): void {
        error ??= reason;
        if (phase === 'aborting') return;
        phase = 'aborting';
        // An explicitly started transaction is abandoned on EOF; abort makes
        // that intention explicit and lets Git release its own ref locks.
        if (!child.stdin.destroyed) child.stdin.end('abort\n');
      }
      child.once('error', () => abort(new Error('Delivery Git ref transaction could not start')));
      child.stdin.on('error', () => abort(new Error('Delivery Git ref transaction pipe failed')));
      child.stdout.on('data', (chunk: Buffer) => {
        if (output.length + chunk.length > 4_096) { abort(new Error('Delivery Git ref transaction output exceeded its bound')); return; }
        output += chunk.toString('utf8');
        if (!error && phase === 'preparing' && output.includes('start: ok\n') && output.includes('prepare: ok\n')) {
          try {
            // Git's zero-OID/create check alone can overwrite a dangling
            // symbolic ref. Recheck while prepare holds Git's own ref lock.
            if (ref(branch, transactionDeadline) !== null) throw new Error('Delivery refuses an existing branch at publication');
            assertNotCheckedOut(branch, transactionDeadline);
            if (error || performance.now() >= transactionDeadline) throw new Error('Delivery Git ref transaction deadline exceeded');
            phase = 'committing';
            child.stdin.end('commit\n');
          } catch (cause) { abort(cause instanceof Error ? cause : new Error('Delivery ref preflight failed')); }
        }
      });
      let stderrBytes = 0;
      child.stderr.on('data', (chunk: Buffer) => {
        stderrBytes += chunk.length;
        if (stderrBytes > 4_096) abort(new Error('Delivery Git ref transaction error output exceeded its bound'));
      });
      child.once('close', (code) => {
        clearTimeout(timer);
        if (hardKill) clearTimeout(hardKill);
        if (error) reject(error);
        else if (code === 0 && phase === 'committing' && output.includes('commit: ok\n')) resolve();
        else reject(new Error('Delivery Git ref transaction did not commit'));
      });
      child.stdin.write(`start\noption no-deref\ncreate refs/heads/${branch} ${commit}\nprepare\n`);
    });
  }
  return { invoke, text, oid, ref, entries, treeDigest, writeTree, assertNotCheckedOut, createRef };
}
