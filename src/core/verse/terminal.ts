/**
 * core/verse/terminal.ts — the Terminal pane's shells (V3.10, unit C4).
 *
 *   TerminalManager — one login shell per tab, each on its own pseudo-terminal:
 *     - `TERM=xterm-256color`, the operator's login PATH, and an environment
 *       with the sidecar's secrets stripped (login-path.ts `childProcessEnv`);
 *     - its own process group (a PTY child is a session leader, so pgid ===
 *       pid), registered in process-registry.ts as a `terminal` entry so a
 *       shell a crashed sidecar left behind is reaped on the next start;
 *     - output coalesced into numbered frames (≤ 60 Hz, leading edge so a
 *       keystroke's echo is never held back), kept as a 256 KB scrollback IN
 *       MEMORY ONLY — never written to disk — and replayed to a reattaching
 *       client past the `seq` it already has, so tabs survive a page reload;
 *     - its title taken from the shell's OSC 0/2 sequences;
 *     - at most VERSE_TERMINAL_MAX_TABS tabs, and a tab idle for 12 h is killed.
 *
 * WHY BUN'S PTY. Bun (the desktop sidecar's runtime — `bun build --compile`)
 * has a built-in pseudo-terminal: `Bun.spawn(argv, { terminal: { cols, rows,
 * data } })` (research r5/panes.md, verified on Bun 1.3.14). No native addon,
 * no new page permission. Under Node (the npm CLI, `npm run dev`, vitest)
 * there is no PTY, so the manager reports `available: false` and the pane
 * says the terminal needs the desktop app. The spawner is INJECTED, so tests
 * drive the whole manager on Node with a fake.
 *
 * KILLING A TAB. An interactive shell puts every job in a process group of
 * its own, so signalling the shell's group alone would leave `npm run dev`
 * running. Closing the PTY master hangs the terminal up — the kernel sends
 * SIGHUP to the foreground job and the shell, and the shell forwards it to its
 * jobs — and after a short grace every descendant still alive (snapshotted
 * with `ps` BEFORE the hang-up, so reparented orphans are still known) and the
 * shell's group get SIGKILL.
 *
 * NEVER A MODEL CALL, NEVER A PAID SEAT: this only starts the operator's own
 * shell. An Apps [Launch ▸] or a dev-server Start TYPES a command into that
 * shell on an explicit click; nothing here runs one on its own.
 */
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, isAbsolute, join } from 'node:path';

import { childProcessEnv, pickLoginShell } from './login-path.js';
import { createProcessRegistry, type VerseProcessRegistry } from './process-registry.js';
import {
  VERSE_TERMINAL_IDLE_KILL_MS,
  VERSE_TERMINAL_MAX_FRAME_HZ,
  VERSE_TERMINAL_MAX_TABS,
  VERSE_TERMINAL_SCROLLBACK_BYTES,
  type VerseTerminalFrame,
  type VerseTerminalTab,
} from './workbench-types.js';

// ---------------------------------------------------------------------------
// The PTY seam
// ---------------------------------------------------------------------------

export interface PtyExit {
  code: number | null;
  signal: string | null;
}

/** One running pseudo-terminal child. */
export interface PtyHandle {
  readonly pid: number;
  write(data: Uint8Array): void;
  resize(cols: number, rows: number): void;
  /** Close the PTY master (hangs the terminal up). Idempotent. */
  close(): void;
  readonly exited: Promise<PtyExit>;
}

export interface PtySpawnOptions {
  argv: readonly string[];
  cwd: string;
  env: Record<string, string>;
  cols: number;
  rows: number;
  /** Output as it arrives. The chunk is the callee's to keep. */
  onData: (chunk: Uint8Array) => void;
}

export type PtySpawner = (opts: PtySpawnOptions) => PtyHandle;

/** The slice of Bun's API this file uses (the repo has no bun-types). */
interface BunPtyTerminal {
  write(data: string | Uint8Array): number;
  resize(cols: number, rows: number): void;
  close(): void;
}
interface BunPtySubprocess {
  readonly pid: number;
  readonly exited: Promise<number | null>;
  readonly exitCode: number | null;
  readonly signalCode: string | null;
  readonly terminal?: BunPtyTerminal;
}
interface BunPtyRuntime {
  Terminal?: unknown;
  spawn(argv: string[], opts: Record<string, unknown>): BunPtySubprocess;
}

/**
 * Bun's built-in PTY, or null when this process is not Bun (or a Bun without
 * `terminal:` support). Exported for the availability test.
 */
export function bunPtySpawner(runtime: unknown = (globalThis as { Bun?: unknown }).Bun): PtySpawner | null {
  const bun = runtime as BunPtyRuntime | undefined;
  if (!bun || typeof bun.spawn !== 'function' || typeof bun.Terminal !== 'function') return null;
  return (opts) => {
    const proc = bun.spawn([...opts.argv], {
      cwd: opts.cwd,
      env: opts.env,
      terminal: {
        cols: opts.cols,
        rows: opts.rows,
        // Bun may reuse the buffer it hands us: copy before keeping it.
        data: (_terminal: unknown, data: Uint8Array) => opts.onData(data.slice()),
      },
    });
    const terminal = proc.terminal;
    if (!terminal) throw new Error('pty unavailable');
    let closed = false;
    return {
      pid: proc.pid,
      write: (data) => { if (!closed) terminal.write(data); },
      resize: (cols, rows) => { if (!closed) terminal.resize(cols, rows); },
      close: () => {
        if (closed) return;
        closed = true;
        try { terminal.close(); } catch { /* already closed */ }
      },
      exited: proc.exited.then(
        () => ({ code: proc.exitCode ?? null, signal: proc.signalCode ?? null }),
        () => ({ code: null, signal: null }),
      ),
    };
  };
}

// ---------------------------------------------------------------------------
// OSC title parsing
// ---------------------------------------------------------------------------

const ESC = 0x1b;
const BEL = 0x07;
const OSC_TITLE_MAX_BYTES = 512;
export const TERMINAL_TITLE_MAX_CHARS = 80;

/**
 * A title for the tab strip: no control or bidi-override characters (they
 * could reorder or hide what the operator reads), trimmed, capped. Null when
 * nothing is left. Secrets and home paths are scrubbed where it LEAVES the
 * server (sendJson / the SSE title frame go through sanitizePublicJson), so
 * the stored title stays exact.
 */
export function sanitizeTerminalTitle(raw: string): string | null {
  // eslint-disable-next-line no-control-regex
  const cleaned = raw.replace(/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '').trim();
  if (cleaned.length === 0) return null;
  const capped = cleaned.length > TERMINAL_TITLE_MAX_CHARS ? `${cleaned.slice(0, TERMINAL_TITLE_MAX_CHARS - 1)}…` : cleaned;
  return capped;
}

/**
 * Incremental OSC 0 / OSC 2 ("set window title") parser. Output arrives in
 * arbitrary chunks, so a sequence may straddle two of them; the parser keeps
 * only the bytes of an OPEN title sequence (≤ 512, then it gives up on it).
 * `feed` returns the last complete title in the chunk, or null.
 */
export function createOscTitleParser(): { feed(chunk: Uint8Array): string | null } {
  // 0 ground, 1 saw ESC, 2 saw ESC ], 3 saw ESC ] <0|2>, 4 in title, 5 in title and saw ESC, 6 ignoring another OSC
  let state = 0;
  let buf: number[] = [];
  const decoder = new TextDecoder('utf-8', { fatal: false });
  return {
    feed(chunk) {
      let found: string | null = null;
      for (const byte of chunk) {
        switch (state) {
          case 0:
            if (byte === ESC) state = 1;
            break;
          case 1:
            state = byte === 0x5d /* ] */ ? 2 : byte === ESC ? 1 : 0;
            break;
          case 2:
            if (byte === 0x30 /* 0 */ || byte === 0x32 /* 2 */) state = 3;
            else state = byte === BEL ? 0 : 6;
            break;
          case 3:
            if (byte === 0x3b /* ; */) { state = 4; buf = []; } else state = byte === BEL ? 0 : 6;
            break;
          case 4:
            if (byte === BEL) {
              found = decoder.decode(new Uint8Array(buf));
              state = 0;
            } else if (byte === ESC) {
              state = 5;
            } else if (buf.length < OSC_TITLE_MAX_BYTES) {
              buf.push(byte);
            } else {
              state = 6;
            }
            break;
          case 5:
            // ESC \ is the string terminator; anything else aborts the sequence.
            if (byte === 0x5c) found = decoder.decode(new Uint8Array(buf));
            state = byte === 0x5d ? 2 : 0;
            break;
          case 6:
            if (byte === BEL) state = 0;
            else if (byte === ESC) state = 1;
            break;
        }
      }
      return found;
    },
  };
}

// ---------------------------------------------------------------------------
// Manager
// ---------------------------------------------------------------------------

export type TerminalErrorCode =
  | 'TERMINAL_UNAVAILABLE'
  | 'TERMINAL_LIMIT'
  | 'TERMINAL_NOT_FOUND'
  | 'TERMINAL_EXITED'
  | 'TERMINAL_INVALID'
  | 'TERMINAL_SPAWN_FAILED';

export class TerminalError extends Error {
  constructor(public readonly code: TerminalErrorCode, message: string) {
    super(message);
    this.name = 'TerminalError';
  }
}

/** The one sentence the pane shows when there is no PTY. */
export const TERMINAL_UNAVAILABLE_REASON = 'The terminal needs the Ashlr desktop app. This server runs without a built-in terminal.';

export const TERMINAL_COLS_RANGE = Object.freeze({ min: 2, max: 500 });
export const TERMINAL_ROWS_RANGE = Object.freeze({ min: 2, max: 300 });
/** One SSE frame never carries more than this, so a `cat` of a big file streams instead of stalling. */
export const TERMINAL_FRAME_MAX_BYTES = 64 * 1024;
/** Idle tabs are looked for this often (the kill itself is at 12 h). */
export const TERMINAL_SWEEP_INTERVAL_MS = 10 * 60 * 1000;
/** After the hang-up, how long a tab's processes get before SIGKILL. */
export const TERMINAL_KILL_GRACE_MS = 1_500;
/** A command typed at start (Launch / dev server) waits for the prompt, at most this long. */
export const TERMINAL_START_COMMAND_WAIT_MS = 2_000;

export const TERMINAL_TAB_ID_RE = /^t-[a-z0-9]{1,32}$/;

export interface TerminalCreateOptions {
  sessionId: string | null;
  /** Absolute, already validated by the API (session root / discovered project + path guard). */
  root: string;
  cols: number;
  rows: number;
  appId?: string | null;
  devServerId?: string | null;
  /** Typed into the shell once it is ready, followed by Enter. Built by the API from a catalog / dev-server record. */
  startCommand?: string | null;
}

export type TerminalListener = (frame: VerseTerminalFrame) => void;

export interface TerminalManagerOptions {
  /** undefined = detect Bun; null = unavailable. */
  spawner?: PtySpawner | null;
  /** The environment for a new shell (default: login-path's sanitised env + login PATH). */
  env?: (set: Record<string, string>) => Promise<Record<string, string>>;
  /** Absolute path of the login shell (default: `$SHELL`, else /bin/zsh on macOS). */
  shell?: () => string | null;
  /** null = do not register shells (tests); default: ~/.ashlr/verse/running.json. */
  registry?: VerseProcessRegistry | null;
  now?: () => number;
  /** process.kill semantics (negative = group). */
  kill?: (pidOrNegPgid: number, signal: NodeJS.Signals) => void;
  /** `kill(pid, 0)` semantics. */
  exists?: (pidOrNegPgid: number) => boolean;
  /** Every descendant pid of `pid` (best effort; [] when unknown). */
  listDescendants?: (pid: number) => Promise<number[]>;
  maxTabs?: number;
  scrollbackBytes?: number;
  idleKillMs?: number;
  frameIntervalMs?: number;
  sweepIntervalMs?: number;
  killGraceMs?: number;
  startCommandWaitMs?: number;
  log?: (message: string) => void;
}

interface OutputFrame {
  seq: number;
  data: Buffer;
}

interface TabRecord {
  tab: VerseTerminalTab;
  pty: PtyHandle | null;
  frames: OutputFrame[];
  frameBytes: number;
  nextSeq: number;
  pending: Buffer[];
  pendingBytes: number;
  flushTimer: ReturnType<typeof setTimeout> | null;
  lastFlushAt: number;
  lastActivity: number;
  listeners: Set<TerminalListener>;
  /** Called once when the tab is removed (killed, idle, shutdown): its streams end. */
  closers: Set<() => void>;
  titleParser: { feed(chunk: Uint8Array): string | null };
  defaultTitle: string;
  sawOutput: boolean;
  onFirstOutput: (() => void) | null;
  removed: boolean;
}

export interface TerminalManager {
  available(): { available: boolean; reason: string | null };
  list(): VerseTerminalTab[];
  get(id: string): VerseTerminalTab | null;
  create(opts: TerminalCreateOptions): Promise<VerseTerminalTab>;
  write(id: string, data: Uint8Array): void;
  resize(id: string, cols: number, rows: number): void;
  /** Kill the tab's processes (if any are running) and remove it. */
  kill(id: string): void;
  /**
   * Replay the scrollback frames with seq > `after`, then the title and (if
   * the shell exited) the exit frame, then live frames. `onClosed` runs once
   * if the tab is removed while subscribed. Returns unsubscribe.
   */
  subscribe(id: string, after: number, listener: TerminalListener, onClosed?: () => void): () => void;
  /** Kill every tab (server shutdown). */
  closeAll(): void;
  /** Kill tabs idle past the limit. Returns the ids removed (exported for tests; also runs on a timer). */
  sweepIdle(): string[];
}

function clampInt(value: number, range: { min: number; max: number }): number {
  return Math.min(range.max, Math.max(range.min, Math.round(value)));
}

function defaultKill(pidOrNegPgid: number, signal: NodeJS.Signals): void {
  process.kill(pidOrNegPgid, signal);
}

function defaultExists(pidOrNegPgid: number): boolean {
  try {
    process.kill(pidOrNegPgid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException | undefined)?.code === 'EPERM';
  }
}

/**
 * Descendants of `root` from one `ps` snapshot. Fixed `/bin/ps` (this feeds
 * a kill), async with a hard timeout, [] on any failure — the hang-up still
 * reaches the foreground job and the shell's jobs without it.
 */
export function listDescendantsWithPs(root: number): Promise<number[]> {
  if (process.platform !== 'darwin' && process.platform !== 'linux') return Promise.resolve([]);
  return new Promise((resolve) => {
    execFile('/bin/ps', ['-A', '-o', 'pid=,ppid='], {
      timeout: 2_000,
      maxBuffer: 8 * 1024 * 1024,
      env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' },
    }, (error, stdout) => {
      if (error || typeof stdout !== 'string') {
        resolve([]);
        return;
      }
      resolve(descendantsFromPsRows(stdout, root));
    });
  });
}

/** Parse `ps -o pid=,ppid=` and walk the tree below `root`. Exported for tests. */
export function descendantsFromPsRows(stdout: string, root: number): number[] {
  const children = new Map<number, number[]>();
  for (const line of stdout.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
    if (!m) continue;
    const pid = Number(m[1]);
    const ppid = Number(m[2]);
    const list = children.get(ppid) ?? [];
    list.push(pid);
    children.set(ppid, list);
  }
  const out: number[] = [];
  const queue = [...(children.get(root) ?? [])];
  const seen = new Set<number>([root]);
  while (queue.length > 0) {
    const pid = queue.shift()!;
    if (seen.has(pid)) continue;
    seen.add(pid);
    out.push(pid);
    queue.push(...(children.get(pid) ?? []));
  }
  return out;
}

/**
 * Variables that describe the terminal the SIDECAR was started from, not the
 * one we are creating: a stale TERM_PROGRAM would make tools enable another
 * emulator's escape codes, and stale COLUMNS/LINES override the real size.
 */
const INHERITED_TERMINAL_VARS = [
  'TERM_PROGRAM',
  'TERM_PROGRAM_VERSION',
  'TERM_SESSION_ID',
  'COLUMNS',
  'LINES',
  'OLDPWD',
  'SHLVL',
  'ITERM_SESSION_ID',
  'ITERM_PROFILE',
  'VSCODE_INJECTION',
  'TMUX',
  'TMUX_PANE',
  'STY',
];

/**
 * The environment of a new tab: the sanitised base (no ASHLR_*, credentials
 * or seat pins), the terminal's own identity, and a UTF-8 locale when the
 * sidecar has none (launchd starts it with no LANG, which makes zsh print
 * multibyte characters as escapes).
 */
export function terminalEnv(base: Record<string, string>, cwd: string): Record<string, string> {
  const env: Record<string, string> = { ...base };
  for (const name of INHERITED_TERMINAL_VARS) delete env[name];
  env['TERM'] = 'xterm-256color';
  env['COLORTERM'] = 'truecolor';
  env['PWD'] = cwd;
  if (!env['LANG'] && !env['LC_ALL'] && !env['LC_CTYPE']) env['LANG'] = 'en_US.UTF-8';
  return env;
}

export function createTerminalManager(opts: TerminalManagerOptions = {}): TerminalManager {
  const spawner = opts.spawner === undefined ? bunPtySpawner() : opts.spawner;
  const now = opts.now ?? Date.now;
  const kill = opts.kill ?? defaultKill;
  const exists = opts.exists ?? defaultExists;
  const listDescendants = opts.listDescendants ?? listDescendantsWithPs;
  const maxTabs = opts.maxTabs ?? VERSE_TERMINAL_MAX_TABS;
  const scrollbackBytes = opts.scrollbackBytes ?? VERSE_TERMINAL_SCROLLBACK_BYTES;
  const idleKillMs = opts.idleKillMs ?? VERSE_TERMINAL_IDLE_KILL_MS;
  const frameIntervalMs = opts.frameIntervalMs ?? Math.ceil(1000 / VERSE_TERMINAL_MAX_FRAME_HZ);
  const killGraceMs = opts.killGraceMs ?? TERMINAL_KILL_GRACE_MS;
  const startWaitMs = opts.startCommandWaitMs ?? TERMINAL_START_COMMAND_WAIT_MS;
  const log = opts.log ?? (() => {});
  const envFor = opts.env ?? ((set: Record<string, string>) => childProcessEnv({ set }));
  const shellFor = opts.shell ?? (() => pickLoginShell(process.env, process.platform));
  let registry: VerseProcessRegistry | null | undefined = opts.registry;
  const registryOf = (): VerseProcessRegistry | null => {
    // Resolved at first use so a relocated HOME (tests, a moved home) is honoured.
    if (registry === undefined) registry = createProcessRegistry(join(homedir(), '.ashlr', 'verse'), { log: (_l, m) => log(m) });
    return registry;
  };

  const tabs = new Map<string, TabRecord>();
  let sweepTimer: ReturnType<typeof setInterval> | null = null;

  function iso(ms: number): string {
    return new Date(ms).toISOString();
  }

  function ensureSweep(): void {
    if (sweepTimer || tabs.size === 0) return;
    sweepTimer = setInterval(() => { manager.sweepIdle(); }, opts.sweepIntervalMs ?? TERMINAL_SWEEP_INTERVAL_MS);
    if (typeof sweepTimer.unref === 'function') sweepTimer.unref();
  }

  function stopSweepIfIdle(): void {
    if (sweepTimer && tabs.size === 0) {
      clearInterval(sweepTimer);
      sweepTimer = null;
    }
  }

  function require(id: string): TabRecord {
    const rec = tabs.get(id);
    if (!rec) throw new TerminalError('TERMINAL_NOT_FOUND', 'terminal not found');
    return rec;
  }

  function emit(rec: TabRecord, frame: VerseTerminalFrame): void {
    for (const listener of [...rec.listeners]) {
      try { listener(frame); } catch { /* one broken stream never stops the others */ }
    }
  }

  function touch(rec: TabRecord): void {
    rec.lastActivity = now();
    rec.tab.lastActivityAt = iso(rec.lastActivity);
  }

  function flush(rec: TabRecord): void {
    if (rec.flushTimer) {
      clearTimeout(rec.flushTimer);
      rec.flushTimer = null;
    }
    if (rec.pendingBytes === 0) return;
    const data = Buffer.concat(rec.pending, rec.pendingBytes);
    rec.pending = [];
    rec.pendingBytes = 0;
    rec.lastFlushAt = now();
    touch(rec);

    for (let offset = 0; offset < data.length; offset += TERMINAL_FRAME_MAX_BYTES) {
      const slice = data.subarray(offset, Math.min(data.length, offset + TERMINAL_FRAME_MAX_BYTES));
      const frame: OutputFrame = { seq: rec.nextSeq++, data: Buffer.from(slice) };
      rec.frames.push(frame);
      rec.frameBytes += frame.data.length;
      emit(rec, { type: 'output', seq: frame.seq, dataBase64: frame.data.toString('base64') });
    }
    // The ring: oldest frames go first. A reattaching client that asks for a
    // seq older than the ring gets what is left (see subscribe).
    while (rec.frameBytes > scrollbackBytes && rec.frames.length > 1) {
      rec.frameBytes -= rec.frames.shift()!.data.length;
    }

    const title = rec.titleParser.feed(data);
    if (title !== null) {
      const next = sanitizeTerminalTitle(title) ?? rec.defaultTitle;
      if (next !== rec.tab.title) {
        rec.tab.title = next;
        emit(rec, { type: 'title', title: next });
      }
    }
  }

  function onOutput(rec: TabRecord, chunk: Uint8Array): void {
    if (rec.removed || chunk.length === 0) return;
    rec.pending.push(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength));
    rec.pendingBytes += chunk.byteLength;
    if (!rec.sawOutput) {
      rec.sawOutput = true;
      const ready = rec.onFirstOutput;
      rec.onFirstOutput = null;
      if (ready) setTimeout(ready, 50);
    }
    // Leading edge: a frame goes out at once when the last one left more than
    // a frame interval ago (a keystroke's echo is never delayed); otherwise
    // the rest of the burst coalesces into one trailing frame (≤ 60 Hz).
    if (rec.flushTimer) return;
    const wait = rec.lastFlushAt + frameIntervalMs - now();
    if (wait <= 0) {
      flush(rec);
    } else {
      rec.flushTimer = setTimeout(() => {
        rec.flushTimer = null;
        flush(rec);
      }, wait);
    }
  }

  function signalTree(pgid: number, descendants: readonly number[], signal: NodeJS.Signals): void {
    for (const target of [-pgid, ...descendants]) {
      try {
        if (exists(target)) kill(target, signal);
      } catch { /* gone, or not ours */ }
    }
  }

  function removeRecord(rec: TabRecord): void {
    if (rec.removed) return;
    flush(rec);
    rec.removed = true;
    tabs.delete(rec.tab.id);
    stopSweepIfIdle();
    if (!rec.tab.exited) {
      const at = iso(now());
      rec.tab.exited = { code: null, signal: 'SIGHUP', at };
      emit(rec, { type: 'exit', code: null, signal: 'SIGHUP' });
    }
    rec.listeners.clear();
    const closers = [...rec.closers];
    rec.closers.clear();
    for (const close of closers) {
      try { close(); } catch { /* best effort */ }
    }
  }

  function terminate(rec: TabRecord): void {
    const pty = rec.pty;
    const running = pty !== null && rec.tab.exited === null;
    const sessionKey = rec.tab.sessionId ?? 'terminal';
    removeRecord(rec);
    if (!pty) return;
    if (!running) {
      pty.close();
      return;
    }
    const pid = pty.pid;
    registryOf()?.remove(sessionKey, rec.tab.id);
    // Snapshot the tree BEFORE the hang-up: once the shell dies its jobs are
    // reparented to launchd and no longer look like ours.
    void listDescendants(pid).catch(() => [] as number[]).then((descendants) => {
      pty.close();
      try { if (exists(-pid)) kill(-pid, 'SIGHUP'); } catch { /* gone */ }
      const timer = setTimeout(() => signalTree(pid, descendants, 'SIGKILL'), killGraceMs);
      if (typeof timer.unref === 'function') timer.unref();
    });
  }

  const manager: TerminalManager = {
    available() {
      return spawner ? { available: true, reason: null } : { available: false, reason: TERMINAL_UNAVAILABLE_REASON };
    },

    list() {
      return [...tabs.values()].map((rec) => ({ ...rec.tab }));
    },

    get(id) {
      const rec = tabs.get(id);
      return rec ? { ...rec.tab } : null;
    },

    async create(req) {
      if (!spawner) throw new TerminalError('TERMINAL_UNAVAILABLE', TERMINAL_UNAVAILABLE_REASON);
      if (tabs.size >= maxTabs) {
        throw new TerminalError('TERMINAL_LIMIT', `${maxTabs} terminals are already open. Close one to open another.`);
      }
      if (typeof req.root !== 'string' || !isAbsolute(req.root)) throw new TerminalError('TERMINAL_INVALID', 'root must be an absolute path');
      try {
        if (!statSync(req.root).isDirectory()) throw new Error('not a directory');
      } catch {
        throw new TerminalError('TERMINAL_INVALID', 'root must be an existing directory');
      }
      const shell = shellFor();
      if (!shell) throw new TerminalError('TERMINAL_UNAVAILABLE', 'no login shell is available on this platform');
      const cols = clampInt(req.cols, TERMINAL_COLS_RANGE);
      const rows = clampInt(req.rows, TERMINAL_ROWS_RANGE);

      const env = terminalEnv(await envFor({}), req.root);
      // The await above yields: re-check the cap so two concurrent creates
      // cannot both squeeze past it.
      if (tabs.size >= maxTabs) {
        throw new TerminalError('TERMINAL_LIMIT', `${maxTabs} terminals are already open. Close one to open another.`);
      }

      const id = `t-${randomBytes(6).toString('hex')}`;
      const createdAt = now();
      const defaultTitle = basename(req.root) || req.root;
      const rec: TabRecord = {
        tab: {
          id,
          sessionId: req.sessionId,
          root: req.root,
          title: defaultTitle,
          cols,
          rows,
          createdAt: iso(createdAt),
          lastActivityAt: iso(createdAt),
          exited: null,
          appId: req.appId ?? null,
          devServerId: req.devServerId ?? null,
        },
        pty: null,
        frames: [],
        frameBytes: 0,
        nextSeq: 1,
        pending: [],
        pendingBytes: 0,
        flushTimer: null,
        lastFlushAt: 0,
        lastActivity: createdAt,
        listeners: new Set(),
        closers: new Set(),
        titleParser: createOscTitleParser(),
        defaultTitle,
        sawOutput: false,
        onFirstOutput: null,
        removed: false,
      };

      let pty: PtyHandle;
      try {
        // `-l`: a LOGIN shell, so the operator's profile builds PATH, aliases
        // and prompt exactly as Terminal.app would. The PTY makes it interactive.
        pty = spawner({
          argv: [shell, '-l'],
          cwd: req.root,
          env,
          cols,
          rows,
          onData: (chunk) => onOutput(rec, chunk),
        });
      } catch (err) {
        log(`terminal spawn failed: ${(err as NodeJS.ErrnoException | undefined)?.code ?? 'error'}`);
        throw new TerminalError('TERMINAL_SPAWN_FAILED', 'the shell could not be started');
      }
      rec.pty = pty;
      tabs.set(id, rec);
      ensureSweep();

      const sessionKey = req.sessionId ?? 'terminal';
      // pgid === pid: a PTY child is a session leader (verified on Bun 1.3.14).
      registryOf()?.add({
        kind: 'terminal',
        sessionId: sessionKey,
        turnId: id,
        pid: pty.pid,
        pgid: process.platform === 'win32' ? null : pty.pid,
        markers: [basename(shell)],
        spawnedAt: createdAt,
      });

      void pty.exited.then((exit) => {
        // Output can trail the exit by a moment; take it before the exit frame.
        setTimeout(() => {
          registryOf()?.remove(sessionKey, id);
          if (rec.removed) return;
          flush(rec);
          rec.tab.exited = { code: exit.code, signal: exit.signal, at: iso(now()) };
          touch(rec);
          emit(rec, { type: 'exit', code: exit.code, signal: exit.signal });
          pty.close();
        }, 30);
      });

      const command = typeof req.startCommand === 'string' ? req.startCommand.replace(/[\r\n]+/g, ' ').trim() : '';
      if (command.length > 0) {
        // Typed once the shell has drawn its prompt (or after a short wait if
        // it never does): typeahead before a profile finishes can be eaten by
        // an update prompt. It shows in the tab exactly as if typed.
        let typed = false;
        const type = (): void => {
          if (typed || rec.removed || rec.tab.exited) return;
          typed = true;
          try { pty.write(new TextEncoder().encode(`${command}\r`)); } catch { /* shell gone */ }
        };
        rec.onFirstOutput = type;
        const fallback = setTimeout(type, startWaitMs);
        if (typeof fallback.unref === 'function') fallback.unref();
      }
      return { ...rec.tab };
    },

    write(id, data) {
      const rec = require(id);
      if (rec.tab.exited || !rec.pty) throw new TerminalError('TERMINAL_EXITED', 'the shell has exited');
      touch(rec);
      rec.pty.write(data);
    },

    resize(id, cols, rows) {
      const rec = require(id);
      const c = clampInt(cols, TERMINAL_COLS_RANGE);
      const r = clampInt(rows, TERMINAL_ROWS_RANGE);
      rec.tab.cols = c;
      rec.tab.rows = r;
      if (rec.tab.exited || !rec.pty) return;
      rec.pty.resize(c, r);
    },

    kill(id) {
      terminate(require(id));
    },

    subscribe(id, after, listener, onClosed) {
      const rec = require(id);
      // Anything not yet flushed belongs in the replay too.
      flush(rec);
      const cursor = Number.isSafeInteger(after) && after > 0 ? after : 0;
      for (const frame of rec.frames) {
        if (frame.seq > cursor) listener({ type: 'output', seq: frame.seq, dataBase64: frame.data.toString('base64') });
      }
      listener({ type: 'title', title: rec.tab.title });
      if (rec.tab.exited) listener({ type: 'exit', code: rec.tab.exited.code, signal: rec.tab.exited.signal });
      rec.listeners.add(listener);
      if (onClosed) rec.closers.add(onClosed);
      return () => {
        rec.listeners.delete(listener);
        if (onClosed) rec.closers.delete(onClosed);
      };
    },

    closeAll() {
      for (const rec of [...tabs.values()]) terminate(rec);
      stopSweepIfIdle();
    },

    sweepIdle() {
      const removed: string[] = [];
      const cutoff = now() - idleKillMs;
      for (const rec of [...tabs.values()]) {
        if (rec.lastActivity > cutoff) continue;
        terminate(rec);
        removed.push(rec.tab.id);
        log(`terminal ${rec.tab.id} closed after ${Math.round(idleKillMs / 3_600_000)} h idle`);
      }
      return removed;
    },
  };
  return manager;
}

// ---------------------------------------------------------------------------
// Process singleton
// ---------------------------------------------------------------------------

let singleton: TerminalManager | null = null;

/** The server's terminal manager (created on first use). */
export function getTerminalManager(): TerminalManager {
  if (!singleton) singleton = createTerminalManager();
  return singleton;
}

/** Test hook: install a manager (or null to drop it, closing the old one's tabs). */
export function setTerminalManagerForTest(next: TerminalManager | null): void {
  if (singleton && singleton !== next) singleton.closeAll();
  singleton = next;
}

/** Server shutdown: kill every tab, if a manager was ever created. Never creates one. */
export function closeVerseTerminals(): void {
  try {
    singleton?.closeAll();
  } catch {
    /* best effort at shutdown */
  }
}
