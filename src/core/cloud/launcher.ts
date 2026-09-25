/**
 * PTY-wrapped `claude --cloud` launcher (unit C1). New cloud sessions can
 * only be created by the interactive CLI, so the seat launcher runs under a
 * pseudo-terminal: macOS `script -q /dev/null <argv…>`, Linux
 * `script -qec "<quoted argv>" /dev/null`. Output is ANSI-stripped and
 * parsed. The seat launcher argv comes from the seat's native profile
 * (`~/.ashlr/native-profiles/<seat>/command.json`, an argv array) — never a
 * shell string, never the ambient `claude` (it may be API-key authed).
 */
import type { CloudLaunchFailureCode } from './types.js';
import { notImplemented } from './_stub.js';

export type CloudLaunchResult =
  | { ok: true; sessionId: string; url: string; title: string }
  | { ok: false; failure: CloudLaunchFailureCode; message: string };

export interface CloudLaunchDeps {
  /** Seat launcher argv (default: read the claude-a native profile command.json). */
  seatArgv?: () => string[] | null;
  /** Spawn override for tests: returns combined output + exit code. */
  run?: (argv: string[], opts: { cwd: string; timeoutMs: number }) => Promise<{ output: string; code: number | null; timedOut: boolean }>;
  platform?: NodeJS.Platform;
  timeoutMs?: number;
}

/** Pure: ANSI-strip + find "Created cloud session: <title>" / "View: <url>" / session id, or classify the error text. */
export function parseCloudLaunchOutput(_raw: string): CloudLaunchResult { return notImplemented('parseCloudLaunchOutput'); }
export function launchCloudSession(_opts: { cwd: string; prompt: string }, _deps?: CloudLaunchDeps): Promise<CloudLaunchResult> { return notImplemented('launchCloudSession'); }
