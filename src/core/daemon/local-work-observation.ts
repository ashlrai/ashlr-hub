/** Power metadata only. This observation cannot authorize execution or spend. */
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { daemonActivityDirectory, readDaemonActivity, type DaemonActivityReadResult, type DaemonActivityRowV1 } from './activity.js';
import { probeDaemonLiveness, type DaemonLivenessV1 } from './liveness.js';
import type { EngineId } from '../types.js';
import { writePrivateFileAtomicallyAsync } from '../util/private-file-write.js';

const PERIOD_MS = 5_000;
const STALE_MS = 15_000;
type Owner = Pick<DaemonActivityRowV1, 'pid' | 'instanceId' | 'processStartRef' | 'daemonStartedAt'>;
export interface LocalWorkObservation extends Owner {
  schemaVersion: 1;
  authority: 'none';
  observedAt: string;
  localRuns: number | null;
}
const HOST_ENGINES = new Set<string>([
  'builtin', 'local-coder', 'llama-server', 'ashlrcode', 'aw', 'claude', 'codex',
  'grok-cli', 'devin-cli', 'hermes', 'kimi', 'nim', 'opencode', 'meta-muse', 'grok',
] satisfies readonly EngineId[]);
export function hostDispatchEngine(engine: string): boolean { return HOST_ENGINES.has(engine); }

/** One entry per dispatch, renewed without a task deadline. Overlap is a Set. */
export class LocalWorkObserver {
  private active = new Set<string>();
  private unknown = new Set<string>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private closed = false;
  constructor(private owner: Owner, private publish: (row: LocalWorkObservation) => void, private now = Date.now) {
    // Verified idle remains current; a zero heartbeat never requests awake.
    this.emit();
    this.timer = setInterval(() => this.emit(), PERIOD_MS); this.timer.unref?.();
  }
  private emit(uncertain = false): void {
    this.publish({
      ...this.owner,
      schemaVersion: 1,
      authority: 'none',
      observedAt: new Date(this.now()).toISOString(),
      localRuns: uncertain ? null : this.active.size > 0 || this.unknown.size === 0 ? this.active.size : null,
    });
  }
  begin(id: string, engine: string): void {
    if (this.closed || engine === 'devin-cloud' || engine === 'devin') return;
    if (hostDispatchEngine(engine)) this.active.add(id);
    else this.unknown.add(id);
    this.emit();
  }
  end(id: string): void {
    const known = this.active.delete(id);
    const unknown = this.unknown.delete(id);
    if (!known && !unknown) return;
    this.emit();
  }
  close(uncertain = false): void {
    if (this.closed) return;
    if (this.timer) clearInterval(this.timer);
    this.timer = null; this.closed = true; this.active.clear(); this.unknown.clear(); this.emit(uncertain);
  }
}

function observationPath(): string { return join(daemonActivityDirectory(), 'local-work.json'); }
let ownerObserver: LocalWorkObserver | null = null;
/** Called only after the resident has written its owner-bound activity row. */
export function startLocalWorkObservation(): void {
  ownerObserver?.close();
  const activity = readDaemonActivity();
  const owner = activity.activity;
  if (!owner || owner.pid !== process.pid || activity.ownerState !== 'alive') { ownerObserver = null; return; }
  const path = observationPath();
  let pending: LocalWorkObservation | null = null;
  let writing = false;
  const publish = (row: LocalWorkObservation): void => {
    pending = row;
    if (writing) return;
    writing = true;
    void (async () => {
      try {
        await mkdir(dirname(path), { recursive: true, mode: 0o700 });
        while (pending) {
          const next = pending; pending = null;
          try {
            await writePrivateFileAtomicallyAsync(join(dirname(path), `.local-work-${randomUUID()}.tmp`), path, `${JSON.stringify(next)}\n`, {
              anchorPath: dirname(path), label: 'local work observation', beforePublish: () => {
                // A retired writer must never replace a newer owner's observation.
                if (ownerObserver !== observer) throw new Error('local work owner changed');
              },
            });
          } catch { /* Metadata failure cannot fail or admit an agent run. */ }
        }
      } finally { writing = false; }
    })().catch(() => { writing = false; });
  };
  const observer = new LocalWorkObserver(owner, publish);
  ownerObserver = observer;
}
export function beginLocalWorkObservation(id: string, engine: string): void { ownerObserver?.begin(id, engine); }
export function endLocalWorkObservation(id: string): void { ownerObserver?.end(id); }
export function closeLocalWorkObservation(uncertain = false): void { ownerObserver?.close(uncertain); }

/** Requires the same verified process start and daemon instance, not merely a PID. */
export function verifiedLocalRuns(row: unknown, activity: DaemonActivityReadResult, live: DaemonLivenessV1, now: number): number | null {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return null;
  const value = row as Record<string, unknown>;
  const owner = activity.activity;
  const age = typeof value['observedAt'] === 'string' ? now - Date.parse(value['observedAt']) : NaN;
  if (value['schemaVersion'] !== 1 || value['authority'] !== 'none' || !Number.isFinite(age) || age < 0 || age >= STALE_MS ||
    !Number.isSafeInteger(value['localRuns']) || (value['localRuns'] as number) < 0 ||
    activity.ownerState !== 'alive' || activity.freshness !== 'fresh' || !owner || live.alive !== true || live.pid !== owner.pid ||
    value['pid'] !== owner.pid || value['instanceId'] !== owner.instanceId || value['processStartRef'] !== owner.processStartRef ||
    !owner.processStartRef || value['daemonStartedAt'] !== owner.daemonStartedAt) return null;
  return value['localRuns'] as number;
}

let cache: { path: string; at: number; count: number | null } | null = null;
let refreshing = false;
let readerTimer: ReturnType<typeof setInterval> | null = null;
async function refresh(): Promise<void> {
  if (refreshing) return;
  refreshing = true;
  const path = observationPath();
  let count: number | null = null;
  try {
    const row = await readLocalWorkObservation(path);
    if (row !== null) count = verifiedLocalRuns(row, readDaemonActivity(), probeDaemonLiveness(), Date.now());
  } catch { /* Unknown is never zero. */ }
  finally { cache = { path, at: Date.now(), count }; refreshing = false; }
}
/** Bounded private JSON read; a FIFO must not stall subsequent owner observations. */
export async function readLocalWorkObservation(path: string): Promise<unknown> {
  let row: unknown = null;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1 || before.size > 2048 ||
      (typeof process.getuid === 'function' && (before.uid !== process.getuid() || (before.mode & 0o077) !== 0))) throw new Error('unsafe observation');
    const buffer = Buffer.alloc(2049);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > 2048) throw new Error('observation too large');
    const named = await lstat(path);
    if (named.isSymbolicLink() || named.ino !== before.ino || named.dev !== before.dev) throw new Error('observation replaced');
    row = JSON.parse(buffer.subarray(0, bytesRead).toString('utf8'));
  } catch { /* Unknown is never zero. */ }
  finally { try { await handle?.close(); } catch { row = null; } }
  return row;
}
/** Start the background reader; peeking itself is an in-memory operation. */
export function startLocalWorkReader(): void {
  if (readerTimer) return;
  void refresh();
  readerTimer = setInterval(() => { void refresh(); }, PERIOD_MS); readerTimer.unref?.();
}
export function peekLocalFleetRuns(): number | null {
  return cache && cache.path === observationPath() && Date.now() - cache.at < STALE_MS ? cache.count : null;
}
