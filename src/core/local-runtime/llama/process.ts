/**
 * Process inspection and crash-safe ownership for the serving runtime.
 *
 * This is a TypeScript port of the reasoning in
 * desktop/src-tauri/src/sidecar_guard.rs, which exists because a pid alone is
 * not proof of anything: pids are recycled, and a supervisor that kills "the
 * pid in the record" eventually kills a stranger's process.
 *
 * Before this family terminates anything, ALL of the following must hold:
 *
 *   * the record names the port we are operating on,
 *   * the recorded pid is alive (a zombie counts as dead), and
 *   * that pid's argv still names OUR binary, OUR model and OUR port.
 *
 * The last condition is what makes recycling harmless — a recycled pid belongs
 * to some other program whose argv will not be a llama-server serving our
 * model on our port. The decision itself is {@link shouldReclaim}, a pure
 * function, so all of it is testable without spawning anything.
 *
 * Unlike the desktop guard there is no long-lived owner process to check for
 * liveness: `ashlr local-runtime start` exits once the server is healthy. The
 * argv match therefore carries the whole ownership proof, which is why it
 * checks three independent things rather than a path prefix alone.
 */

import { spawnSync } from 'node:child_process';
import type { LlamaLivenessFacts, LlamaOwnershipRecord } from './types.js';

/** How long a graceful SIGTERM is given before SIGKILL. */
const TERMINATE_GRACE_MS = 8_000;
const TERMINATE_POLL_MS = 100;

/** Bound on the descendant walk, so a pathological `pgrep` cannot loop. */
const MAX_TREE_DEPTH = 4;

/**
 * Is `pid` a live process?
 *
 * A **zombie** counts as dead: `kill(pid, 0)` succeeds for a process that has
 * exited but has not been reaped, and treating that as alive would make a
 * crashed server look alive forever, so its port would never be reclaimed.
 */
export function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  let exists: boolean;
  try {
    process.kill(pid, 0);
    exists = true;
  } catch (err: unknown) {
    // EPERM means the process exists but belongs to another user.
    exists = (err as NodeJS.ErrnoException)?.code === 'EPERM';
  }
  return exists && !processIsZombie(pid);
}

/**
 * Has `pid` exited without being reaped?
 *
 * Unknown state reads as *not* a zombie, so an unreadable process is treated
 * as alive and nothing is killed on a guess.
 */
function processIsZombie(pid: number): boolean {
  const out = runPs(['-p', String(pid), '-o', 'state=']);
  if (out === null) return false;
  return out.trim().startsWith('Z');
}

/** Run `/bin/ps` with the given args, returning stdout or null. Never throws. */
function runPs(args: string[]): string | null {
  if (process.platform === 'win32') return null;
  try {
    const result = spawnSync('/bin/ps', args, { encoding: 'utf8', timeout: 5_000 });
    if (result.status !== 0 || typeof result.stdout !== 'string') return null;
    return result.stdout;
  } catch {
    return null;
  }
}

/**
 * Full argv of `pid`, or null when it cannot be read.
 *
 * `-ww` disables the width truncation macOS `ps` otherwise applies: the blob
 * path inside Ollama's store is long, and a truncated argv would silently fail
 * the ownership check below.
 */
export function processArgv(pid: number): string | null {
  if (!Number.isInteger(pid) || pid <= 1) return null;
  const out = runPs(['-ww', '-p', String(pid), '-o', 'args=']);
  if (out === null) return null;
  const text = out.trim();
  return text.length > 0 ? text : null;
}

/**
 * Does this argv line belong to the llama-server described by the record?
 *
 * Pure, so the rule is testable without a live process. Three independent
 * facts must all appear, because any one of them alone is forgeable by an
 * unrelated command line:
 *
 *   1. it starts with the recorded binary path,
 *   2. it serves the recorded model path, and
 *   3. it binds the recorded port.
 */
export function argvMatchesRecord(argv: string, record: LlamaOwnershipRecord): boolean {
  const line = argv.trim();
  if (!line || !record.binPath) return false;

  const startsWithBin = line === record.binPath || line.startsWith(`${record.binPath} `);
  if (!startsWithBin) return false;

  if (record.modelPath && !line.includes(record.modelPath)) return false;

  return argvBindsPort(line, record.port);
}

/** Does an argv line carry `--port <n>` or `--port=<n>` for exactly this port? */
export function argvBindsPort(argv: string, port: number): boolean {
  const pattern = new RegExp(`(?:^|\\s)--port(?:=|\\s+)${port}(?:\\s|$)`);
  return pattern.test(argv);
}

/**
 * May we terminate the process this record names?
 *
 * Every condition is required — see the module docs. Kept pure and exported so
 * the pid-recycling guarantee is pinned by unit tests rather than asserted in
 * a comment.
 */
export function shouldReclaim(
  record: LlamaOwnershipRecord,
  port: number,
  facts: LlamaLivenessFacts,
): boolean {
  return (
    record.port === port &&
    record.pid > 1 &&
    facts.processAlive &&
    facts.argvMatches
  );
}

/** Gather the liveness facts {@link shouldReclaim} needs for a record. */
export function livenessFactsFor(record: LlamaOwnershipRecord): LlamaLivenessFacts {
  const alive = processAlive(record.pid);
  if (!alive) return { processAlive: false, argvMatches: false };
  const argv = processArgv(record.pid);
  return { processAlive: true, argvMatches: argv !== null && argvMatchesRecord(argv, record) };
}

/** A llama-server process discovered by scanning the process table. */
export interface DiscoveredLlamaServer {
  pid: number;
  argv: string;
  /** Absolute binary path, recovered from argv[0]. */
  binPath: string;
  /** Value of `-m` / `--model`, when present. */
  modelPath: string | null;
}

/**
 * Recover the `-m` / `--model` value from an argv line.
 *
 * Pure. Paths with spaces are not supported here and deliberately so: the
 * value is used for an ownership comparison, and a wrong guess would weaken
 * the recycling guard rather than merely inconvenience the operator.
 */
export function modelPathFromArgv(argv: string): string | null {
  const tokens = argv.trim().split(/\s+/);
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i] as string;
    if (token === '-m' || token === '--model') {
      const next = tokens[i + 1];
      return typeof next === 'string' && next.length > 0 ? next : null;
    }
    if (token.startsWith('--model=')) return token.slice('--model='.length) || null;
  }
  return null;
}

/** Is this argv line a llama-server invocation (not, say, a grep for one)? */
export function isLlamaServerArgv(argv: string): boolean {
  const argv0 = argv.trim().split(/\s+/)[0] ?? '';
  const base = argv0.split('/').pop() ?? '';
  return base === 'llama-server' || base === 'llama-server.exe';
}

/** One row of the process table: a pid and its full, untruncated argv. */
export interface ProcessTableEntry {
  pid: number;
  argv: string;
}

/**
 * Every live process as (pid, argv) pairs. Empty when the table is unreadable.
 *
 * Shared by both supervisors' discovery scans (llama-server here,
 * the Anthropic proxy host in proxy-process.ts) so there is one spelling of
 * "read the process table" rather than two that can drift on `ps` flags —
 * `-ww` in particular, without which macOS truncates argv at the terminal
 * width and an ownership check silently fails on a long path.
 */
export function processTable(): ProcessTableEntry[] {
  const out = runPs(['-axww', '-o', 'pid=,args=']);
  if (out === null) return [];

  const rows: ProcessTableEntry[] = [];
  for (const line of out.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const split = /^(\d+)\s+(.*)$/.exec(trimmed);
    if (!split) continue;
    const pid = Number.parseInt(split[1] as string, 10);
    const argv = (split[2] as string).trim();
    if (!Number.isInteger(pid) || pid <= 1 || argv.length === 0) continue;
    rows.push({ pid, argv });
  }
  return rows;
}

/**
 * Find every live llama-server bound to `port`.
 *
 * Used to ADOPT a server an operator started by hand, so `local-runtime start`
 * does not refuse to manage a runtime that is already serving correctly, and
 * `stop` can actually release the port afterwards. Adoption still verifies
 * `/health` before the record is written — a matching argv proves identity,
 * not health.
 */
export function findLlamaServersOnPort(port: number): DiscoveredLlamaServer[] {
  const found: DiscoveredLlamaServer[] = [];
  for (const { pid, argv } of processTable()) {
    if (!isLlamaServerArgv(argv)) continue;
    if (!argvBindsPort(argv, port)) continue;
    const binPath = argv.split(/\s+/)[0] as string;
    found.push({ pid, argv, binPath, modelPath: modelPathFromArgv(argv) });
  }
  return found;
}

/** Direct children of `pid`. Empty when they cannot be read. */
function childPids(pid: number): number[] {
  if (process.platform === 'win32') return [];
  try {
    const result = spawnSync('/usr/bin/pgrep', ['-P', String(pid)], {
      encoding: 'utf8',
      timeout: 5_000,
    });
    if (typeof result.stdout !== 'string') return [];
    return result.stdout
      .split('\n')
      .map((line) => Number.parseInt(line.trim(), 10))
      .filter((child) => Number.isInteger(child) && child > 1);
  } catch {
    return [];
  }
}

/**
 * Every descendant of `pid`, NOT including `pid` itself.
 *
 * Must be called while `pid` is still ALIVE: once the parent dies the kernel
 * reparents its children to pid 1 and `pgrep -P` returns nothing.
 */
export function descendantPids(pid: number): number[] {
  const found: number[] = [];
  let frontier = [pid];
  for (let depth = 0; depth < MAX_TREE_DEPTH; depth += 1) {
    const next: number[] = [];
    for (const parent of frontier) {
      for (const child of childPids(parent)) {
        if (child === pid || found.includes(child)) continue;
        found.push(child);
        next.push(child);
      }
    }
    if (next.length === 0) break;
    frontier = next;
  }
  return found;
}

/** Best-effort signal delivery. A process that is already gone is not an error. */
function signal(pid: number, sig: NodeJS.Signals): void {
  if (pid <= 1) return;
  try {
    process.kill(pid, sig);
  } catch {
    // Already exited, or not ours — either way there is nothing to do.
  }
}

/**
 * Stop `pid` and its descendants, giving them a chance to shut down cleanly.
 *
 * SIGTERM first: llama-server flushes and closes its listening socket on
 * SIGTERM, and that close is what actually releases the port. SIGKILL alone
 * leaves the socket in the kernel's hands for longer and skips the flush.
 * Escalates to SIGKILL only after {@link TERMINATE_GRACE_MS}.
 *
 * Returns true when nothing from the tree is alive afterwards.
 */
export async function terminateTree(
  pid: number,
  graceMs = TERMINATE_GRACE_MS,
): Promise<boolean> {
  if (!Number.isInteger(pid) || pid <= 1) return true;

  // Snapshot BEFORE signalling: a dead parent has no discoverable children.
  const descendants = descendantPids(pid);

  for (const child of descendants) signal(child, 'SIGTERM');
  signal(pid, 'SIGTERM');

  const deadline = Date.now() + Math.max(0, graceMs);
  while (Date.now() < deadline) {
    const alive = processAlive(pid) || descendants.some((child) => processAlive(child));
    if (!alive) return true;
    await sleep(TERMINATE_POLL_MS);
  }

  for (const child of descendants) signal(child, 'SIGKILL');
  signal(pid, 'SIGKILL');

  // Give the kernel a moment to reap before reporting the outcome honestly.
  const hardDeadline = Date.now() + 2_000;
  while (Date.now() < hardDeadline) {
    const alive = processAlive(pid) || descendants.some((child) => processAlive(child));
    if (!alive) return true;
    await sleep(TERMINATE_POLL_MS);
  }
  return !processAlive(pid);
}

/**
 * Promise-based sleep. Local so this module has no dependency on a helper.
 *
 * The timer is deliberately NOT unref'd. An unref'd poll tick lets Node decide
 * the event loop is empty and exit the process mid-await — which it did: `stop`
 * terminated with an "unsettled top-level await" warning and exit 13 while the
 * server it was waiting on was still alive and the ownership record was still
 * on disk. Every wait here is bounded, so holding the loop open costs nothing.
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
