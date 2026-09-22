/**
 * Verse adapters — one per vendor CLI. An adapter knows two things:
 *
 *   1. how to build the argv/env/stdin for ONE turn of a session
 *      (`buildLaunch`), and
 *   2. how to turn the CLI's stdout lines into normalized `VerseEvent`s
 *      (`createParser`).
 *
 * Adapters are pure: they never spawn, never touch the filesystem and never
 * read secrets. Events they produce omit `seq`/`at` — the session engine
 * stamps those when it appends to the durable store. Parsers must never throw
 * on a garbage line; unknown or malformed lines are dropped.
 */

import type { VerseEngine, VerseEvent, VerseSession, VerseTurnLaunch } from '../types.js';
import type { VerseSeatLaunch } from '../session-engine.js';
import { claudeAdapter } from './claude.js';
import { codexAdapter } from './codex.js';
import { grokAdapter } from './grok.js';

/** Distributive Omit — `Omit` on a union would collapse it to the common keys. */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** A VerseEvent before the engine stamps `seq` and `at`. */
export type VerseParsedEvent = DistributiveOmit<VerseEvent, 'seq' | 'at'>;

export interface VerseTurnParser {
  /** Feed one stdout line. Returns zero or more normalized events. */
  push(line: string): VerseParsedEvent[];
  /** Called once after the process exits. Flushes buffered state (e.g. usage). */
  finish(exitCode: number | null): VerseParsedEvent[];
  /** Vendor conversation id observed in the output (codex thread id, claude session id), or null. */
  nativeSessionId(): string | null;
}

export interface VerseAdapter {
  buildLaunch(session: VerseSession, text: string, launch: VerseSeatLaunch): VerseTurnLaunch;
  createParser(turnId: string): VerseTurnParser;
}

export function adapterFor(engine: VerseEngine): VerseAdapter {
  switch (engine) {
    case 'claude':
    case 'local':
      return claudeAdapter;
    case 'codex':
      return codexAdapter;
    case 'grok':
      return grokAdapter;
    default: {
      const never: never = engine;
      throw new Error(`unknown verse engine: ${String(never)}`);
    }
  }
}
