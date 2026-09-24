/**
 * core/verse/verse-log.ts — Verse's own durable diagnostic log.
 *
 *   <root>/verse.log     (default root ~/.ashlr/verse; 0600 in a 0700 dir)
 *   <root>/verse.log.1   the previous generation, after rotation
 *
 * WHY. Before 3.10 a Verse server kept no log of its own: the sidecar's
 * stderr reached only Tauri's `eprintln` and an in-memory buffer, so a crash,
 * an orphaned agent process or a storage failure left nothing to look up
 * afterwards (research r2/reliability.md: `~/.ashlr/ashlr.log` was last
 * written in March). This file is where the engine, the process registry and
 * the CLI's crash handlers write what went wrong.
 *
 * RULES
 *  - SYNCHRONOUS appends. The crash handler writes from `uncaughtException`,
 *    where an async write would never land before the process exits.
 *  - Every line is scrubbed (`scrubSecrets`) and has the home directory
 *    rewritten to `~` — a stack trace or a vendor error can carry a token or
 *    a native-profile path, and this file outlives the process.
 *  - Size-bounded: one 1 MiB generation plus one rotated generation, so a
 *    crash loop can never fill the disk.
 *  - NEVER throws. A logger that can fail would turn a storage error into an
 *    uncaught exception inside the handler meant to survive it.
 */

import {
  appendFileSync,
  chmodSync,
  mkdirSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { scrubSecrets } from '../util/scrub.js';

export type VerseLogLevel = 'info' | 'warn' | 'error' | 'fatal';

export const VERSE_LOG_FILE = 'verse.log';
/** Rotate once the live file passes this size. Two generations are kept. */
export const VERSE_LOG_MAX_BYTES = 1024 * 1024;
/** One line is capped so a runaway stack or payload cannot dominate the file. */
export const VERSE_LOG_MAX_LINE_CHARS = 8 * 1024;

/** The default Verse root. Resolved per call so a relocated HOME (tests) is honoured. */
export function defaultVerseRoot(): string {
  return join(homedir(), '.ashlr', 'verse');
}

export function verseLogPath(root: string = defaultVerseRoot()): string {
  return join(root, VERSE_LOG_FILE);
}

function homeToTilde(text: string): string {
  const home = homedir();
  return home && home.length > 1 ? text.split(home).join('~') : text;
}

/** Scrub + home-redact + flatten to one bounded line. Exported for tests. */
export function formatVerseLogLine(level: VerseLogLevel, message: string, at: Date = new Date()): string {
  const flat = homeToTilde(scrubSecrets(String(message))).replace(/\r?\n/g, ' ⏎ ').trim();
  const bounded = flat.length > VERSE_LOG_MAX_LINE_CHARS ? `${flat.slice(0, VERSE_LOG_MAX_LINE_CHARS - 1)}…` : flat;
  return `${at.toISOString()} ${level.toUpperCase()} [pid ${process.pid}] ${bounded}\n`;
}

/** Describe any thrown value without trusting it (it may be a non-Error, or have a throwing getter). */
export function describeError(err: unknown): string {
  try {
    if (err instanceof Error) {
      const code = (err as NodeJS.ErrnoException).code;
      const head = `${err.name}${code ? ` ${code}` : ''}: ${err.message}`;
      return err.stack && err.stack.includes(err.message) ? err.stack.replace(/^[^\n]*/, head) : head;
    }
    return typeof err === 'string' ? err : JSON.stringify(err) ?? String(err);
  } catch {
    return '[unprintable error]';
  }
}

/**
 * Append one line. Returns false when nothing could be written (the caller
 * has nowhere better to report that, so it is only ever informational).
 */
export function appendVerseLog(
  level: VerseLogLevel,
  message: string,
  opts: { root?: string; maxBytes?: number; now?: Date } = {},
): boolean {
  try {
    const root = opts.root ?? defaultVerseRoot();
    const path = verseLogPath(root);
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const maxBytes = opts.maxBytes ?? VERSE_LOG_MAX_BYTES;
    try {
      if (statSync(path).size >= maxBytes) {
        const previous = `${path}.1`;
        try { rmSync(previous, { force: true }); } catch { /* best effort */ }
        renameSync(path, previous);
      }
    } catch {
      // No file yet (ENOENT) or rotation failed: append to whatever is there.
    }
    appendFileSync(path, formatVerseLogLine(level, message, opts.now), { mode: 0o600 });
    // appendFileSync's mode only applies on creation; a file a user widened
    // (or one created under a permissive umask) is narrowed back.
    try { chmodSync(path, 0o600); } catch { /* best effort */ }
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Process-level crash handlers (installed by `ashlr verse`)
// ---------------------------------------------------------------------------

/** The slice of `process` the handlers need — a test seam. */
export interface CrashHandlerHost {
  on(event: 'uncaughtException', listener: (err: unknown) => void): unknown;
  on(event: 'unhandledRejection', listener: (reason: unknown) => void): unknown;
  off?(event: 'uncaughtException' | 'unhandledRejection', listener: (...args: never[]) => void): unknown;
  exit(code?: number): never | void;
}

export interface VerseCrashHandlerOptions {
  /** Verse root the log lives under. Default ~/.ashlr/verse. */
  root?: string;
  /**
   * Called once on a fatal exception BEFORE the process exits: settle and
   * kill running turns (the engine's `interruptAll`). Must be synchronous —
   * nothing async runs after an uncaught exception handler returns and exits.
   */
  onFatal?: (reason: string) => void;
  host?: CrashHandlerHost;
  /** Exit code after a fatal exception. Default 1 (the Tauri shell restarts the sidecar). */
  exitCode?: number;
}

/**
 * Install `uncaughtException` / `unhandledRejection` handlers. Returns the
 * uninstaller.
 *
 * POLICY
 *  - uncaughtException is FATAL. Node's own documentation is explicit that
 *    resuming after one is unsafe (state may be half-mutated). We log it,
 *    let `onFatal` settle running turns and kill their process groups (so no
 *    vendor CLI keeps editing files under launchd after we are gone), then
 *    exit non-zero for the desktop shell to restart us.
 *  - unhandledRejection is LOGGED and survived. A stray rejected promise has
 *    not corrupted synchronous state, and Node's default (crash) would take
 *    every live chat down for, typically, a best-effort background probe.
 *
 * Re-entrancy: an exception thrown while handling a fatal one goes straight
 * to exit — it is never handled twice.
 */
export function installVerseCrashHandlers(opts: VerseCrashHandlerOptions = {}): () => void {
  const host: CrashHandlerHost = opts.host ?? (process as unknown as CrashHandlerHost);
  const exitCode = opts.exitCode ?? 1;
  let handlingFatal = false;

  const onException = (err: unknown): void => {
    if (handlingFatal) {
      host.exit(exitCode);
      return;
    }
    handlingFatal = true;
    const reason = describeError(err);
    appendVerseLog('fatal', `uncaught exception — shutting down: ${reason}`, { root: opts.root });
    if (opts.onFatal) {
      try {
        opts.onFatal('server crashed');
      } catch (inner) {
        appendVerseLog('error', `crash cleanup failed: ${describeError(inner)}`, { root: opts.root });
      }
    }
    host.exit(exitCode);
  };

  const onRejection = (reason: unknown): void => {
    appendVerseLog('error', `unhandled promise rejection (survived): ${describeError(reason)}`, { root: opts.root });
  };

  host.on('uncaughtException', onException);
  host.on('unhandledRejection', onRejection);
  return () => {
    if (typeof host.off === 'function') {
      host.off('uncaughtException', onException as (...args: never[]) => void);
      host.off('unhandledRejection', onRejection as (...args: never[]) => void);
    }
  };
}
