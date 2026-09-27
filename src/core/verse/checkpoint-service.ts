/**
 * core/verse/checkpoint-service.ts — per-chat checkpoints: when they are
 * taken, what they are called, the review record, and the Undo/Redo plans
 * (git plumbing: checkpoints.ts; routes: checkpoints-api.ts; wire:
 * checkpoint-types.ts).
 *
 * LIFECYCLE
 *   beforeTurn  (engine, awaited before the seat's process starts, bounded)
 *               → a `pre` checkpoint of every repository the chat can reach.
 *   afterTurn   (engine, after every turn end) → a `post` checkpoint.
 *   review      accept (recorded) / reject a file or a hunk (restored from `pre`).
 *   undo        restore the working tree to a turn's `pre`, three-way where
 *               someone edited a file after the agent; the state it replaced is
 *               kept (`undo` ref) so Redo can put it back.
 *
 * THE PLAN (undo and redo share it). Three snapshots per repository:
 *   target    — what to restore (the turn's `pre`; for Redo, the pre-Undo state)
 *   reference — what Ashlr last left on disk (the latest `post`, or the state
 *               right after the last Undo/Redo/reject); null when unknown
 *   now       — a fresh snapshot, taken for the preview
 * For each path that differs between target and now:
 *   reference == now     → nobody touched it since: restore it           (apply)
 *   reference == target  → only someone else changed it: leave it        (kept)
 *   otherwise            → both did: the operator decides, with a three-way
 *                          merge preview (keep / take checkpoint / merge) (conflict)
 * Apply refuses unless every conflict has a decision, and unless a fresh
 * snapshot still equals the preview's `now` — nothing is ever overwritten
 * that the operator did not see.
 *
 * RECORD. Every checkpoint, review decision, undo and redo is appended to
 * `<verse root>/checkpoints/<chat>.jsonl` (0600 in a 0700 directory), with
 * the before/after commits of anything that changed files.
 *
 * NODE-ONLY.
 */
import { randomBytes } from 'node:crypto';
import { appendFile, mkdir, readFile, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import {
  CheckpointError,
  chatRefPrefix,
  changedPathsBetween,
  checkpointRefName,
  defaultCheckpointGit,
  deleteCheckpointRefs,
  diffCheckpoints,
  latin1ToUtf8,
  mergeThreeWay,
  mergedBytes,
  parsePatchHunks,
  patchBetween,
  readBlob,
  readCheckpointManifest,
  rejectHunkOnDisk,
  resolveRepoTop,
  rootIdFor,
  setCheckpointRef,
  snapshotWorkingTree,
  treeEntries,
  writePathsFromCheckpoint,
  writeRepoFile,
  type CheckpointGitRunner,
  type SnapshotLimits,
  type SnapshotResult,
  type TreeEntry,
} from './checkpoints.js';
import { mapLimited } from './folder-io.js';
import { withRepoLock } from './git-ops.js';
import {
  VERSE_CHECKPOINT_MERGE_MAX_BYTES,
  VERSE_CHECKPOINT_PREVIEW_TTL_MS,
  VERSE_CHECKPOINT_TIMEOUT_MS,
  type VerseCheckpointApplyResponse,
  type VerseCheckpointApplyRoot,
  type VerseCheckpointDecision,
  type VerseCheckpointDiffMode,
  type VerseCheckpointDiffResponse,
  type VerseCheckpointListResponse,
  type VerseCheckpointPlanConflict,
  type VerseCheckpointPlanRoot,
  type VerseCheckpointPreviewResponse,
  type VerseCheckpointRedo,
  type VerseCheckpointResolution,
  type VerseCheckpointReviewResponse,
  type VerseCheckpointRootInfo,
  type VerseCheckpointSnap,
  type VerseCheckpointTurn,
} from './checkpoint-types.js';

// ===========================================================================
// Journal records
// ===========================================================================

interface SnapRecord {
  rootId: string;
  path: string;
  commit: string | null;
  error: string | null;
  skipped: number;
  ms: number;
}

interface ChangeRecordRoot {
  rootId: string;
  path: string;
  /** Working tree just before the change. */
  before: string;
  /** Working tree just after it. */
  after: string | null;
  written: string[];
  deleted: string[];
  merged: string[];
  kept: string[];
}

type JournalRecord =
  | { kind: 'turn-start'; at: string; turnId: string; roots: SnapRecord[] }
  | { kind: 'turn-end'; at: string; turnId: string; outcome: string; roots: SnapRecord[] }
  | { kind: 'review'; at: string; turnId: string; rootId: string; path: string; hunk: string | null; decision: VerseCheckpointDecision; change: ChangeRecordRoot | null }
  | { kind: 'undo' | 'redo'; at: string; turnId: string; roots: ChangeRecordRoot[] };

interface TurnState {
  turnId: string;
  index: number;
  startedAt: string;
  endedAt: string | null;
  outcome: string | null;
  pre: Map<string, SnapRecord>;
  post: Map<string, SnapRecord>;
  undone: boolean;
}

interface ChatState {
  roots: Map<string, string>;
  turns: TurnState[];
  byId: Map<string, TurnState>;
  /** `turnId|rootId|path` → whole-file accepted, and accepted hunk hashes. */
  reviews: Map<string, { file: boolean; hunks: Set<string> }>;
  /** Per root: the last working tree Ashlr itself left (post / after undo, redo, reject). */
  lastWritten: Map<string, string>;
  /** The undo Redo can reverse, while no turn started after it. */
  redoable: { turnId: string; at: string; roots: ChangeRecordRoot[] } | null;
}

function emptyState(): ChatState {
  return { roots: new Map(), turns: [], byId: new Map(), reviews: new Map(), lastWritten: new Map(), redoable: null };
}

const reviewKey = (turnId: string, rootId: string, path: string) => `${turnId}|${rootId}|${path}`;

function fold(state: ChatState, rec: JournalRecord): void {
  switch (rec.kind) {
    case 'turn-start': {
      let turn = state.byId.get(rec.turnId);
      if (!turn) {
        turn = { turnId: rec.turnId, index: state.turns.length + 1, startedAt: rec.at, endedAt: null, outcome: null, pre: new Map(), post: new Map(), undone: false };
        state.turns.push(turn);
        state.byId.set(rec.turnId, turn);
      }
      for (const r of rec.roots) {
        state.roots.set(r.rootId, r.path);
        turn.pre.set(r.rootId, r);
      }
      state.redoable = null;
      return;
    }
    case 'turn-end': {
      const turn = state.byId.get(rec.turnId);
      if (!turn) return;
      turn.endedAt = rec.at;
      turn.outcome = rec.outcome;
      for (const r of rec.roots) {
        state.roots.set(r.rootId, r.path);
        turn.post.set(r.rootId, r);
        if (r.commit) state.lastWritten.set(r.rootId, r.commit);
      }
      return;
    }
    case 'review': {
      const key = reviewKey(rec.turnId, rec.rootId, rec.path);
      const entry = state.reviews.get(key) ?? { file: false, hunks: new Set<string>() };
      if (rec.decision === 'accept') {
        if (rec.hunk) entry.hunks.add(rec.hunk);
        else entry.file = true;
      }
      state.reviews.set(key, entry);
      if (rec.change?.after) state.lastWritten.set(rec.change.rootId, rec.change.after);
      return;
    }
    case 'undo':
    case 'redo': {
      const turn = state.byId.get(rec.turnId);
      if (turn) {
        for (const t of state.turns) if (t.index >= turn.index) t.undone = rec.kind === 'undo';
      }
      for (const r of rec.roots) if (r.after) state.lastWritten.set(r.rootId, r.after);
      state.redoable = rec.kind === 'undo' ? { turnId: rec.turnId, at: rec.at, roots: rec.roots } : null;
      return;
    }
  }
}

function isRecord(v: unknown): v is JournalRecord {
  if (!v || typeof v !== 'object') return false;
  const r = v as { kind?: unknown; at?: unknown; turnId?: unknown };
  return typeof r.kind === 'string' && typeof r.at === 'string' && typeof r.turnId === 'string'
    && ['turn-start', 'turn-end', 'review', 'undo', 'redo'].includes(r.kind);
}

// ===========================================================================
// Service
// ===========================================================================

/** What the service needs to know about a chat for a request. */
export interface CheckpointChat {
  id: string;
  /** Every folder the chat can reach, primary first. */
  roots: readonly string[];
  /** A turn is running (or starting) in this chat. */
  running: boolean;
}

export interface CheckpointServiceOptions {
  /** Journal directory (default `~/.ashlr/verse/checkpoints`, resolved at first use). */
  stateDir?: string;
  run?: CheckpointGitRunner;
  limits?: SnapshotLimits;
  /** How long `beforeTurn` may hold a turn (default VERSE_CHECKPOINT_TIMEOUT_MS). */
  timeoutMs?: number;
  now?: () => number;
  /** Repository mutation lock (default git-ops `withRepoLock`, shared with commit/push). */
  lock?: <T>(gitRoot: string, fn: () => Promise<T>) => Promise<T>;
  log?: (message: string) => void;
}

export interface TurnHookInfo {
  sessionId: string;
  turnId: string;
  roots: readonly string[];
  /** The engine's own deadline for `beforeTurn`: aborted before the agent may start. */
  signal?: AbortSignal;
}

interface PreviewRoot {
  rootId: string;
  gitRoot: string;
  target: string;
  reference: string | null;
  now: SnapshotResult;
  plan: VerseCheckpointPlanRoot;
}

interface Preview {
  id: string;
  kind: 'undo' | 'redo';
  chatId: string;
  turnId: string;
  expiresAt: number;
  roots: PreviewRoot[];
}

export interface CheckpointService {
  beforeTurn(info: TurnHookInfo): Promise<void>;
  afterTurn(info: TurnHookInfo & { outcome: string }): Promise<void>;
  forgetChat(chatId: string, roots: readonly string[]): Promise<void>;
  list(chat: CheckpointChat): Promise<VerseCheckpointListResponse>;
  diff(chat: CheckpointChat, turnId: string, rootId: string, mode: VerseCheckpointDiffMode, file: string | null): Promise<VerseCheckpointDiffResponse>;
  review(chat: CheckpointChat, input: { turnId: string; rootId: string; file: string; hunk: string | null; decision: VerseCheckpointDecision }): Promise<VerseCheckpointReviewResponse>;
  previewUndo(chat: CheckpointChat, turnId: string): Promise<VerseCheckpointPreviewResponse>;
  previewRedo(chat: CheckpointChat): Promise<VerseCheckpointPreviewResponse>;
  apply(chat: CheckpointChat, previewId: string, resolutions: Record<string, Record<string, VerseCheckpointResolution>>): Promise<VerseCheckpointApplyResponse>;
  /** Test/diagnostic: resolves once every queued operation for the chat has settled. */
  idle(chatId: string): Promise<void>;
}

const CHAT_FILE = /^[A-Za-z0-9_-]{1,128}$/;
const PREVIEW_CAP = 32;
const CONFLICT_DIFF_MAX_CHARS = 64 * 1024;

function nowIso(ms: number): string {
  return new Date(ms).toISOString();
}

function operatorMessage(err: unknown): string {
  if (err instanceof CheckpointError) return err.message;
  if (err && typeof err === 'object' && 'code' in err && (err as { code?: unknown }).code === 'VERSE_GIT_BUSY') {
    return 'Another git process was working in this repository.';
  }
  return 'The checkpoint could not be taken.';
}

export function createCheckpointService(opts: CheckpointServiceOptions = {}): CheckpointService {
  const run = opts.run ?? defaultCheckpointGit;
  const clock = opts.now ?? Date.now;
  const timeoutMs = opts.timeoutMs ?? VERSE_CHECKPOINT_TIMEOUT_MS;
  const lock = opts.lock ?? (<T>(gitRoot: string, fn: () => Promise<T>) => withRepoLock(gitRoot, fn));
  const log = opts.log ?? (() => undefined);
  const stateDir = () => opts.stateDir ?? join(homedir(), '.ashlr', 'verse', 'checkpoints');

  const states = new Map<string, Promise<ChatState>>();
  const queues = new Map<string, Promise<unknown>>();
  const previews = new Map<string, Preview>();
  const manifestCache = new Map<string, Set<string>>();
  const turnCountCache = new Map<string, number>();
  const topCache = new Map<string, string | null>();

  // ---- per-chat serial queue: hooks and mutations never interleave ----------

  /**
   * Reject/Undo/Redo writes. They run in the chat's serial queue, so a turn's
   * `pre` snapshot always runs AFTER a write already in flight (never in the
   * middle of it) — but it waits for it inside the same checkpoint budget.
   */
  function mutation<T>(chatId: string, fn: () => Promise<T>): Promise<T> {
    return serial(chatId, fn);
  }

  function serial<T>(chatId: string, fn: () => Promise<T>): Promise<T> {
    const prev = queues.get(chatId) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    const tail = next.then(() => undefined, () => undefined);
    queues.set(chatId, tail);
    void tail.then(() => { if (queues.get(chatId) === tail) queues.delete(chatId); });
    return next;
  }

  // ---- journal ----------------------------------------------------------------

  function journalPath(chatId: string): string {
    if (!CHAT_FILE.test(chatId)) throw new CheckpointError('VERSE_INVALID', 'chatId is not valid');
    return join(stateDir(), `${chatId}.jsonl`);
  }

  function stateOf(chatId: string): Promise<ChatState> {
    let hit = states.get(chatId);
    if (!hit) {
      hit = (async () => {
        const state = emptyState();
        let text = '';
        try {
          text = await readFile(journalPath(chatId), 'utf8');
        } catch {
          return state;
        }
        for (const line of text.split('\n')) {
          if (!line.trim()) continue;
          try {
            const rec = JSON.parse(line) as unknown;
            if (isRecord(rec)) fold(state, rec);
          } catch {
            /* a torn last line from a crash: skip it */
          }
        }
        return state;
      })();
      states.set(chatId, hit);
    }
    return hit;
  }

  async function record(chatId: string, rec: JournalRecord): Promise<void> {
    const state = await stateOf(chatId);
    fold(state, rec);
    try {
      await mkdir(stateDir(), { recursive: true, mode: 0o700 });
      await appendFile(journalPath(chatId), `${JSON.stringify(rec)}\n`, { mode: 0o600 });
    } catch {
      log(`checkpoints: journal for ${chatId} could not be written`);
    }
  }

  // ---- roots ---------------------------------------------------------------------

  async function repoTop(dir: string): Promise<string | null> {
    if (topCache.has(dir)) return topCache.get(dir) ?? null;
    const top = await resolveRepoTop(dir, run);
    if (topCache.size > 512) topCache.clear();
    // A folder that is not a repo yet may become one; only cache hits.
    if (top) topCache.set(dir, top);
    return top;
  }

  /** The chat's distinct repositories, as `rootId → git top level`. */
  async function reposOf(roots: readonly string[]): Promise<Map<string, string>> {
    const tops = await mapLimited(roots, 4, (r) => repoTop(r).catch(() => null));
    const out = new Map<string, string>();
    for (const top of tops) if (top) out.set(rootIdFor(top), top);
    return out;
  }

  async function snapRoots(repos: Map<string, string>, label: string, isAborted: () => boolean): Promise<Array<SnapRecord & { snap: SnapshotResult | null }>> {
    return mapLimited([...repos], 2, async ([rootId, gitRoot]) => {
      const t0 = clock();
      try {
        const snap = await snapshotWorkingTree(gitRoot, { run, label, ...(opts.limits ?? {}) });
        if (isAborted()) return { rootId, path: gitRoot, commit: null, error: 'The checkpoint took too long; this turn ran without one.', skipped: 0, ms: clock() - t0, snap: null };
        return { rootId, path: gitRoot, commit: snap.commit, error: null, skipped: snap.skipped.length, ms: snap.ms, snap };
      } catch (err) {
        return { rootId, path: gitRoot, commit: null, error: operatorMessage(err), skipped: 0, ms: clock() - t0, snap: null };
      }
    });
  }

  // ---- hooks -----------------------------------------------------------------------

  /**
   * The `pre` checkpoint. ONE budget, started at call entry, covers everything
   * — waiting behind a reject/undo already queued for this chat, resolving the
   * repositories, and the snapshot itself. It ends at whichever comes first:
   * this service's `timeoutMs`, or the engine's `info.signal` (the engine's own
   * ceiling). Either way `aborted` is set BEFORE this call returns / the signal
   * handler returns, i.e. before the engine can spawn the agent; from then on
   * no snapshot is recorded as `pre` unless it had already finished (so it
   * cannot hold a single byte the agent wrote).
   */
  async function beforeTurn(info: TurnHookInfo): Promise<void> {
    const budget = { aborted: false };
    let wake: () => void = () => undefined;
    const stopped = new Promise<'aborted'>((resolve) => { wake = () => resolve('aborted'); });
    const abort = (): void => {
      if (budget.aborted) return;
      budget.aborted = true;
      wake();
    };
    const signal = info.signal;
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, timeoutMs);
    timer.unref?.();
    const skipped = 'The checkpoint took too long; this turn ran without one.';

    // Queued at once (not after an await), so this turn's `pre` is always
    // ordered before its own `post` in the chat's queue.
    const work = serial(info.sessionId, async () => {
      const repos = await reposOf(info.roots);
      if (repos.size === 0) return;
      const snaps = budget.aborted
        ? [...repos].map(([rootId, path]) => ({ rootId, path, commit: null, error: skipped, skipped: 0, ms: 0, snap: null }))
        : await snapRoots(repos, `Ashlr Verse checkpoint: before turn ${info.turnId}`, () => budget.aborted);
      for (const s of snaps) {
        // A commit here finished before the budget ran out (snapRoots drops
        // any that finished later), so its content predates the agent.
        if (!s.commit) continue;
        try {
          await setCheckpointRef(s.path, checkpointRefName(info.sessionId, info.turnId, s.rootId, 'pre'), s.commit, run);
        } catch (err) {
          s.commit = null;
          s.error = operatorMessage(err);
        }
      }
      await record(info.sessionId, { kind: 'turn-start', at: nowIso(clock()), turnId: info.turnId, roots: snaps.map(({ snap: _snap, ...r }) => r) });
    });
    try {
      const outcome = await Promise.race([work.then(() => 'done' as const, () => 'done' as const), stopped]);
      if (outcome === 'aborted') log(`checkpoints: turn ${info.turnId} started without a checkpoint (timeout)`);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      // Whatever happens next happens after the engine may have spawned.
      if (!budget.aborted) budget.aborted = true;
    }
  }

  async function afterTurn(info: TurnHookInfo & { outcome: string }): Promise<void> {
    await serial(info.sessionId, async () => {
      const state = await stateOf(info.sessionId);
      const turn = state.byId.get(info.turnId);
      if (!turn) return; // no `pre` was ever attempted (refused before start, hooks off)
      const repos = new Map<string, string>();
      for (const [rootId, snap] of turn.pre) if (snap.commit) repos.set(rootId, snap.path);
      if (repos.size === 0) {
        await record(info.sessionId, { kind: 'turn-end', at: nowIso(clock()), turnId: info.turnId, outcome: info.outcome, roots: [] });
        return;
      }
      const snaps = await snapRoots(repos, `Ashlr Verse checkpoint: after turn ${info.turnId}`, () => false);
      for (const s of snaps) {
        if (!s.commit) continue;
        try {
          await setCheckpointRef(s.path, checkpointRefName(info.sessionId, info.turnId, s.rootId, 'post'), s.commit, run);
        } catch (err) {
          s.commit = null;
          s.error = operatorMessage(err);
        }
      }
      await record(info.sessionId, { kind: 'turn-end', at: nowIso(clock()), turnId: info.turnId, outcome: info.outcome, roots: snaps.map(({ snap: _snap, ...r }) => r) });
    });
  }

  async function forgetChat(chatId: string, roots: readonly string[]): Promise<void> {
    await serial(chatId, async () => {
      const state = await stateOf(chatId).catch(() => emptyState());
      const tops = new Set<string>(state.roots.values());
      for (const t of (await reposOf(roots)).values()) tops.add(t);
      for (const top of tops) {
        try {
          await deleteCheckpointRefs(top, chatRefPrefix(chatId), run);
        } catch {
          log(`checkpoints: refs for deleted chat ${chatId} could not be removed`);
        }
      }
      states.delete(chatId);
      try {
        await rm(journalPath(chatId), { force: true });
      } catch {
        /* nothing to remove */
      }
    });
  }

  // ---- reads -------------------------------------------------------------------------

  async function skippedIn(gitRoot: string, commit: string | null): Promise<Set<string>> {
    if (!commit) return new Set();
    const hit = manifestCache.get(commit);
    if (hit) return hit;
    const manifest = await readCheckpointManifest(gitRoot, commit, run);
    const set = new Set((manifest?.skipped ?? []).map((s) => s.path));
    if (manifestCache.size > 1024) manifestCache.clear();
    manifestCache.set(commit, set);
    return set;
  }

  function snapView(s: SnapRecord | undefined, at: string | null): VerseCheckpointSnap | null {
    if (!s) return null;
    return { commit: s.commit, error: s.error, skipped: s.skipped, at: at ?? '', ms: s.ms };
  }

  function rootInfos(state: ChatState, repos: Map<string, string>): VerseCheckpointRootInfo[] {
    const all = new Map<string, string>([...state.roots, ...repos]);
    return [...all].map(([rootId, path]) => ({ rootId, path, name: path.split(/[\\/]/).filter(Boolean).pop() ?? path }));
  }

  async function filesChanged(state: ChatState, turn: TurnState): Promise<number | null> {
    let total = 0;
    let known = false;
    for (const [rootId, pre] of turn.pre) {
      const post = turn.post.get(rootId);
      if (!pre.commit || !post?.commit) continue;
      const key = `${pre.commit}..${post.commit}`;
      let n = turnCountCache.get(key);
      if (n === undefined) {
        try {
          n = (await changedPathsBetween(state.roots.get(rootId) ?? pre.path, pre.commit, post.commit, run)).length;
          if (turnCountCache.size > 4096) turnCountCache.clear();
          turnCountCache.set(key, n);
        } catch {
          continue;
        }
      }
      total += n;
      known = true;
    }
    return known ? total : null;
  }

  async function list(chat: CheckpointChat): Promise<VerseCheckpointListResponse> {
    const state = await stateOf(chat.id);
    const repos = await reposOf(chat.roots);
    const lastIndex = state.turns.length;
    const turns: VerseCheckpointTurn[] = await mapLimited(state.turns, 2, async (t) => ({
      turnId: t.turnId,
      index: t.index,
      startedAt: t.startedAt,
      endedAt: t.endedAt,
      outcome: t.outcome,
      state: t.undone ? 'undone' : chat.running && t.index === lastIndex && t.endedAt === null ? 'running' : 'done',
      roots: [...new Set([...t.pre.keys(), ...t.post.keys()])].map((rootId) => ({
        rootId,
        pre: snapView(t.pre.get(rootId), t.startedAt),
        post: snapView(t.post.get(rootId), t.endedAt),
      })),
      filesChanged: await filesChanged(state, t),
    }));
    const redo: VerseCheckpointRedo | null = state.redoable ? { turnId: state.redoable.turnId, at: state.redoable.at } : null;
    return { chatId: chat.id, running: chat.running, roots: rootInfos(state, repos), turns, redo };
  }

  function requireTurn(state: ChatState, turnId: string): TurnState {
    const turn = state.byId.get(turnId);
    if (!turn) throw new CheckpointError('VERSE_NOT_FOUND', 'This chat has no checkpoint for that turn.');
    return turn;
  }

  function requirePre(state: ChatState, turn: TurnState, rootId: string): { gitRoot: string; pre: string } {
    const pre = turn.pre.get(rootId);
    if (!pre) throw new CheckpointError('VERSE_NOT_FOUND', 'That repository has no checkpoint for this turn.');
    if (!pre.commit) throw new CheckpointError('VERSE_CHECKPOINT_UNAVAILABLE', pre.error ?? 'No checkpoint was taken before this turn.');
    return { gitRoot: state.roots.get(rootId) ?? pre.path, pre: pre.commit };
  }

  /** A fresh snapshot of `gitRoot`, reused for 1.5 s (a file list then its patches). */
  const nowCache = new Map<string, { at: number; snap: Promise<SnapshotResult> }>();
  function snapshotNow(gitRoot: string, fresh = false): Promise<SnapshotResult> {
    const hit = nowCache.get(gitRoot);
    if (!fresh && hit && clock() - hit.at < 1_500) return hit.snap;
    const snap = snapshotWorkingTree(gitRoot, { run, label: 'Ashlr Verse snapshot', ...(opts.limits ?? {}) });
    nowCache.set(gitRoot, { at: clock(), snap });
    snap.catch(() => nowCache.delete(gitRoot));
    return snap;
  }

  function sameEntry(a: TreeEntry | undefined, b: TreeEntry | undefined): boolean {
    if (!a || !b) return a === b;
    return a.oid === b.oid && a.mode === b.mode;
  }

  async function diff(
    chat: CheckpointChat,
    turnId: string,
    rootId: string,
    mode: VerseCheckpointDiffMode,
    file: string | null,
  ): Promise<VerseCheckpointDiffResponse> {
    const state = await stateOf(chat.id);
    const turn = requireTurn(state, turnId);
    const { gitRoot, pre } = requirePre(state, turn, rootId);
    const post = turn.post.get(rootId)?.commit ?? null;
    const target = mode === 'turn' && post ? post : (await snapshotNow(gitRoot)).commit;
    const [entries, skipBase, skipTarget] = await Promise.all([
      diffCheckpoints(gitRoot, pre, target, run),
      skippedIn(gitRoot, pre),
      skippedIn(gitRoot, target),
    ]);
    // "Edited after the agent": differs from what Ashlr last left on disk.
    const reference = mode === 'since' ? state.lastWritten.get(rootId) ?? null : null;
    let edited = new Set<string>();
    if (reference && reference !== target) {
      const paths = entries.map((e) => e.path);
      const [inTarget, inRef] = await Promise.all([treeEntries(gitRoot, target, paths, run), treeEntries(gitRoot, reference, paths, run)]);
      edited = new Set(paths.filter((p) => !sameEntry(inTarget.get(p), inRef.get(p))));
    }
    const files = entries.map((e) => {
      const review = state.reviews.get(reviewKey(turnId, rootId, e.path));
      const captured = ![e.path, e.oldPath].some((p) => p !== null && (skipBase.has(p) || skipTarget.has(p)));
      return { ...e, captured, editedAfterTurn: edited.has(e.path), accepted: review?.file ?? false };
    });
    let patch: VerseCheckpointDiffResponse['patch'] = null;
    if (file !== null) {
      const entry = files.find((f) => f.path === file);
      if (!entry) throw new CheckpointError('VERSE_CHECKPOINT_STALE', 'That file has no changes in this view any more.');
      if (!entry.captured) {
        patch = { path: file, text: '', truncated: false, binary: true, hunks: [] };
      } else {
        const p = await patchBetween(gitRoot, pre, target, file, entry.oldPath, run);
        const accepted = state.reviews.get(reviewKey(turnId, rootId, file))?.hunks ?? new Set<string>();
        patch = {
          path: file,
          text: latin1ToUtf8(p.raw),
          truncated: p.truncated,
          binary: p.binary,
          hunks: p.binary ? [] : parsePatchHunks(p.raw).map((h) => ({ index: h.index, hash: h.hash, header: latin1ToUtf8(h.header), accepted: accepted.has(h.hash) })),
        };
      }
    }
    return { chatId: chat.id, turnId, rootId, mode, base: pre, target, files, patch, actionable: mode === 'since' && !chat.running };
  }

  // ---- mutations -------------------------------------------------------------------

  function refuseRunning(chat: CheckpointChat): void {
    if (chat.running) throw new CheckpointError('VERSE_CHECKPOINT_BUSY', 'A turn is running in this chat. Wait for it to finish.');
  }

  async function review(
    chat: CheckpointChat,
    input: { turnId: string; rootId: string; file: string; hunk: string | null; decision: VerseCheckpointDecision },
  ): Promise<VerseCheckpointReviewResponse> {
    return mutation(chat.id, async () => {
      const state = await stateOf(chat.id);
      const turn = requireTurn(state, input.turnId);
      const { gitRoot, pre } = requirePre(state, turn, input.rootId);
      if (input.decision === 'accept') {
        await record(chat.id, { kind: 'review', at: nowIso(clock()), turnId: input.turnId, rootId: input.rootId, path: input.file, hunk: input.hunk, decision: 'accept', change: null });
        return { ok: true, decision: 'accept', changed: [] };
      }
      refuseRunning(chat);
      return lock(gitRoot, async () => {
        const now = await snapshotNow(gitRoot, true);
        const entries = await diffCheckpoints(gitRoot, pre, now.commit, run);
        const entry = entries.find((e) => e.path === input.file);
        if (!entry) throw new CheckpointError('VERSE_CHECKPOINT_STALE', 'That file has no changes since the checkpoint any more.');
        const [skipBase, skipNow] = await Promise.all([skippedIn(gitRoot, pre), skippedIn(gitRoot, now.commit)]);
        const paths = [entry.path, ...(entry.oldPath && entry.oldPath !== entry.path ? [entry.oldPath] : [])];
        if (paths.some((p) => skipBase.has(p) || skipNow.has(p))) {
          throw new CheckpointError('VERSE_CHECKPOINT_UNAVAILABLE', 'That file was too large to checkpoint, so it cannot be restored.');
        }
        let changed: string[];
        if (input.hunk) {
          await rejectHunkOnDisk({ gitRoot, base: pre, now: now.commit, path: entry.path, oldPath: entry.oldPath, hash: input.hunk, run });
          changed = [entry.path];
        } else {
          const out = await writePathsFromCheckpoint(gitRoot, pre, paths, run);
          changed = [...out.written, ...out.deleted];
        }
        const after = await snapshotNow(gitRoot, true).catch(() => null);
        await record(chat.id, {
          kind: 'review',
          at: nowIso(clock()),
          turnId: input.turnId,
          rootId: input.rootId,
          path: input.file,
          hunk: input.hunk,
          decision: 'reject',
          change: { rootId: input.rootId, path: gitRoot, before: now.commit, after: after?.commit ?? null, written: input.hunk ? [entry.path] : changed, deleted: [], merged: [], kept: [] },
        });
        return { ok: true, decision: 'reject', changed };
      });
    });
  }

  async function blobOf(gitRoot: string, e: TreeEntry | undefined): Promise<Buffer | null> {
    if (!e) return Buffer.alloc(0);
    if (e.type !== 'blob') return null;
    return readBlob(gitRoot, e.oid, VERSE_CHECKPOINT_MERGE_MAX_BYTES, run);
  }

  async function planRoot(rootId: string, gitRoot: string, target: string, reference: string | null, now: SnapshotResult): Promise<VerseCheckpointPlanRoot> {
    const plan: VerseCheckpointPlanRoot = { rootId, apply: [], conflicts: [], kept: [], uncaptured: [], unavailable: null };
    const changed = await changedPathsBetween(gitRoot, target, now.commit, run);
    const skipped = new Set<string>([
      ...(await skippedIn(gitRoot, target)),
      ...(await skippedIn(gitRoot, now.commit)),
      ...(reference ? await skippedIn(gitRoot, reference) : []),
    ]);
    const paths = changed.filter((p) => {
      if (skipped.has(p)) {
        plan.uncaptured.push(p);
        return false;
      }
      return true;
    });
    const [t, n, r] = await Promise.all([
      treeEntries(gitRoot, target, paths, run),
      treeEntries(gitRoot, now.commit, paths, run),
      reference ? treeEntries(gitRoot, reference, paths, run) : Promise.resolve(null),
    ]);
    const conflictPaths: Array<{ path: string; kind: 'edited-after' | 'unverified' }> = [];
    for (const p of paths) {
      const action: 'restore' | 'delete' = t.has(p) ? 'restore' : 'delete';
      if (r === null) conflictPaths.push({ path: p, kind: 'unverified' });
      else if (sameEntry(r.get(p), n.get(p))) plan.apply.push({ path: p, action });
      else if (sameEntry(r.get(p), t.get(p))) plan.kept.push(p);
      else conflictPaths.push({ path: p, kind: 'edited-after' });
    }
    plan.conflicts = await mapLimited(conflictPaths, 2, async ({ path, kind }): Promise<VerseCheckpointPlanConflict> => {
      const action: 'restore' | 'delete' = t.has(path) ? 'restore' : 'delete';
      const merge = kind === 'unverified' || !r
        ? { clean: false, text: null, conflicts: 1 }
        : await mergeThreeWay(
          n.has(path) ? await blobOf(gitRoot, n.get(path)) : null,
          r.has(path) ? await blobOf(gitRoot, r.get(path)) : null,
          t.has(path) ? await blobOf(gitRoot, t.get(path)) : null,
          run,
        );
      let diffText = '';
      try {
        const p = await patchBetween(gitRoot, now.commit, target, path, null, run);
        diffText = latin1ToUtf8(p.raw).slice(0, CONFLICT_DIFF_MAX_CHARS);
      } catch {
        diffText = '';
      }
      return { path, action, kind, merge, diff: diffText };
    });
    return plan;
  }

  function prunePreviews(): void {
    const t = clock();
    for (const [id, p] of previews) if (p.expiresAt <= t) previews.delete(id);
    while (previews.size > PREVIEW_CAP) {
      const oldest = previews.keys().next().value;
      if (oldest === undefined) break;
      previews.delete(oldest);
    }
  }

  function previewResponse(p: Preview): VerseCheckpointPreviewResponse {
    return { previewId: p.id, kind: p.kind, chatId: p.chatId, turnId: p.turnId, expiresAt: nowIso(p.expiresAt), roots: p.roots.map((r) => r.plan) };
  }

  async function buildPreview(
    chat: CheckpointChat,
    kind: 'undo' | 'redo',
    turnId: string,
    targets: Array<{ rootId: string; gitRoot: string; target: string | null; reference: string | null; unavailable: string | null }>,
  ): Promise<VerseCheckpointPreviewResponse> {
    const roots: PreviewRoot[] = [];
    const unavailable: VerseCheckpointPlanRoot[] = [];
    for (const t of targets) {
      if (!t.target) {
        unavailable.push({ rootId: t.rootId, apply: [], conflicts: [], kept: [], uncaptured: [], unavailable: t.unavailable ?? 'No checkpoint was taken for this repository.' });
        continue;
      }
      const now = await snapshotNow(t.gitRoot, true);
      const plan = await planRoot(t.rootId, t.gitRoot, t.target, t.reference, now);
      roots.push({ rootId: t.rootId, gitRoot: t.gitRoot, target: t.target, reference: t.reference, now, plan });
    }
    if (roots.length === 0) {
      throw new CheckpointError('VERSE_CHECKPOINT_UNAVAILABLE', unavailable[0]?.unavailable ?? 'There is no checkpoint to restore.');
    }
    prunePreviews();
    const preview: Preview = { id: randomBytes(12).toString('hex'), kind, chatId: chat.id, turnId, expiresAt: clock() + VERSE_CHECKPOINT_PREVIEW_TTL_MS, roots };
    previews.set(preview.id, preview);
    const response = previewResponse(preview);
    response.roots.push(...unavailable);
    return response;
  }

  async function previewUndo(chat: CheckpointChat, turnId: string): Promise<VerseCheckpointPreviewResponse> {
    refuseRunning(chat);
    return serial(chat.id, async () => {
      const state = await stateOf(chat.id);
      const turn = requireTurn(state, turnId);
      const targets = [...turn.pre].map(([rootId, pre]) => ({
        rootId,
        gitRoot: state.roots.get(rootId) ?? pre.path,
        target: pre.commit,
        reference: state.lastWritten.get(rootId) ?? null,
        unavailable: pre.error,
      }));
      if (targets.length === 0) throw new CheckpointError('VERSE_CHECKPOINT_UNAVAILABLE', 'No repository was checkpointed before this turn.');
      return buildPreview(chat, 'undo', turnId, targets);
    });
  }

  async function previewRedo(chat: CheckpointChat): Promise<VerseCheckpointPreviewResponse> {
    refuseRunning(chat);
    return serial(chat.id, async () => {
      const state = await stateOf(chat.id);
      const redo = state.redoable;
      if (!redo) throw new CheckpointError('VERSE_CHECKPOINT_UNAVAILABLE', 'There is nothing to redo.');
      const targets = redo.roots.map((r) => ({ rootId: r.rootId, gitRoot: r.path, target: r.before, reference: r.after, unavailable: null }));
      return buildPreview(chat, 'redo', redo.turnId, targets);
    });
  }

  async function apply(
    chat: CheckpointChat,
    previewId: string,
    resolutions: Record<string, Record<string, VerseCheckpointResolution>>,
  ): Promise<VerseCheckpointApplyResponse> {
    refuseRunning(chat);
    return mutation(chat.id, async () => {
      prunePreviews();
      const preview = previews.get(previewId);
      if (!preview || preview.chatId !== chat.id) {
        throw new CheckpointError('VERSE_CHECKPOINT_STALE', 'This preview expired. Open Undo again to review the changes.');
      }
      // Every conflict needs a decision; `merge` only where the merge was clean.
      for (const root of preview.roots) {
        const chosen = resolutions[root.rootId] ?? {};
        for (const c of root.plan.conflicts) {
          const choice = chosen[c.path];
          if (choice !== 'keep' && choice !== 'checkpoint' && choice !== 'merge') {
            throw new CheckpointError('VERSE_INVALID', `Choose what to do with ${c.path} before applying.`);
          }
          if (choice === 'merge' && !c.merge.clean) {
            throw new CheckpointError('VERSE_INVALID', `${c.path} does not merge cleanly; keep it or take the checkpoint.`);
          }
        }
      }
      // Phase 1: nothing moved since the preview, in ANY repository.
      for (const root of preview.roots) {
        const fresh = await snapshotNow(root.gitRoot, true);
        if (fresh.tree !== root.now.tree) {
          previews.delete(previewId);
          throw new CheckpointError('VERSE_CHECKPOINT_STALE', 'Files changed since this preview. Review the undo again.');
        }
      }
      // Phase 2: write, one repository at a time, each under its mutation lock.
      const results: VerseCheckpointApplyRoot[] = [];
      const recorded: ChangeRecordRoot[] = [];
      for (const root of preview.roots) {
        const chosen = resolutions[root.rootId] ?? {};
        const res = await lock(root.gitRoot, async () => {
          const fresh = await snapshotNow(root.gitRoot, true);
          if (fresh.tree !== root.now.tree) throw new CheckpointError('VERSE_CHECKPOINT_STALE', 'Files changed while the undo was being applied. Review it again.');
          const toWrite = [
            ...root.plan.apply.map((f) => f.path),
            ...root.plan.conflicts.filter((c) => chosen[c.path] === 'checkpoint').map((c) => c.path),
          ];
          const out = await writePathsFromCheckpoint(root.gitRoot, root.target, toWrite, run);
          const merged: string[] = [];
          for (const c of root.plan.conflicts.filter((x) => chosen[x.path] === 'merge')) {
            const [t, n, r] = await Promise.all([
              treeEntries(root.gitRoot, root.target, [c.path], run),
              treeEntries(root.gitRoot, root.now.commit, [c.path], run),
              root.reference ? treeEntries(root.gitRoot, root.reference, [c.path], run) : Promise.resolve(new Map<string, TreeEntry>()),
            ]);
            const [ours, base, theirs] = await Promise.all([blobOf(root.gitRoot, n.get(c.path)), blobOf(root.gitRoot, r.get(c.path)), blobOf(root.gitRoot, t.get(c.path))]);
            const bytes = ours && base && theirs ? await mergedBytes(ours, base, theirs, run) : null;
            if (!bytes) throw new CheckpointError('VERSE_CHECKPOINT_STALE', `${c.path} no longer merges cleanly.`);
            await writeRepoFile(root.gitRoot, c.path, bytes);
            merged.push(c.path);
          }
          const kept = [...root.plan.kept, ...root.plan.conflicts.filter((c) => chosen[c.path] === 'keep').map((c) => c.path)];
          const after = await snapshotNow(root.gitRoot, true).catch(() => null);
          return { out, merged, kept, after };
        });
        if (preview.kind === 'undo') {
          try {
            await setCheckpointRef(root.gitRoot, checkpointRefName(chat.id, preview.turnId, root.rootId, 'undo'), root.now.commit, run);
            if (res.after) await setCheckpointRef(root.gitRoot, checkpointRefName(chat.id, preview.turnId, root.rootId, 'undone'), res.after.commit, run);
          } catch {
            log(`checkpoints: redo refs for ${chat.id} could not be saved`);
          }
        }
        results.push({ rootId: root.rootId, written: res.out.written, deleted: res.out.deleted, merged: res.merged, kept: res.kept });
        recorded.push({
          rootId: root.rootId,
          path: root.gitRoot,
          before: root.now.commit,
          after: res.after?.commit ?? null,
          written: res.out.written,
          deleted: res.out.deleted,
          merged: res.merged,
          kept: res.kept,
        });
      }
      previews.delete(previewId);
      await record(chat.id, { kind: preview.kind, at: nowIso(clock()), turnId: preview.turnId, roots: recorded });
      const state = await stateOf(chat.id);
      return {
        ok: true,
        kind: preview.kind,
        turnId: preview.turnId,
        roots: results,
        redo: state.redoable ? { turnId: state.redoable.turnId, at: state.redoable.at } : null,
      };
    });
  }

  return {
    beforeTurn,
    afterTurn,
    forgetChat,
    list,
    diff,
    review,
    previewUndo,
    previewRedo,
    apply,
    idle: async (chatId) => { await (queues.get(chatId) ?? Promise.resolve()); },
  };
}

// ===========================================================================
// Process singleton + the engine's turn hooks
// ===========================================================================

let singleton: CheckpointService | null = null;

export function getCheckpointService(): CheckpointService {
  if (!singleton) singleton = createCheckpointService();
  return singleton;
}

/** Test hook: install a service (or null for a fresh default on next use). */
export function setCheckpointServiceForTest(next: CheckpointService | null): void {
  singleton = next;
}
