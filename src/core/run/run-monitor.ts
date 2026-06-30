/**
 * run-monitor.ts — M236: stall-based engine termination.
 *
 * Replaces the old wall-clock kill with productivity-aware termination:
 * a frontier agent (Claude Code / Codex) can run for hours as long as it is
 * making PROGRESS. We terminate early only when we detect a stall:
 *
 *   1. idle-stall    — no RunEvent for cfg.foundry.stallIdleMs (default 3 min).
 *   2. loop-stall    — last N consecutive tool-call events share the same
 *                      (toolName+normArgs) hash (infinite tool-call loop).
 *   3. no-diff-stall — many events emitted but zero file mutations observed.
 *
 * Termination sequence (graceful-stop ladder):
 *   The monitor calls the provided `onStall(reason)` callback exactly once —
 *   the caller (spawnEngineInner in engines.ts) owns the ChildProcess and
 *   performs: SIGINT → grace period → SIGKILL.
 *
 * The outer backstop (timeoutMs, default 2 h) lives in spawnEngine itself and
 * is the absolute runaway-cost safety net.
 *
 * SAFETY: graceful-stop never bypasses the proposal gate; the existing M233
 * partial-capture path in sandboxed-engine.ts handles non-zero exits from
 * stall-terminated runs identically to timeout exits.
 */

import type { RunEvent } from './engines.js';
import type { AshlrConfig } from '../types.js';
import { createHash } from 'node:crypto';

// ---------------------------------------------------------------------------
// Configuration / defaults
// ---------------------------------------------------------------------------

/** Default idle-stall timeout: 3 minutes of no events. */
const DEFAULT_STALL_IDLE_MS = 3 * 60_000;

/** How many consecutive identical (tool+args) events constitute a loop. */
const LOOP_STALL_WINDOW = 6;

/** Minimum events before no-diff-stall can trigger (avoids false positives).
 * M291: raised 20→80. Substantial frontier tasks legitimately READ many files
 * (20-40 tool calls) before their first edit; the old 20 killed them mid-read
 * ('no-diff-stall' before any edit registered). 80 still catches a genuinely
 * spinning agent (many calls, zero edits) but gives real work room to orient. */
const NO_DIFF_MIN_EVENTS = 80;

/** M291: tool names that indicate a file MUTATION (so the no-diff-stall detector
 * recognises an editing agent as productive). Claude/Codex edit tool-calls are
 * normalised to kind 'tool_call' (not 'file_touched'), so without this the
 * monitor never counted edits → false no-diff-stall kills on working agents. */
const EDIT_TOOL_RE = /(write|edit|create|str_replace|multi_?edit|apply_?patch|insert|notebook)/i;

// ---------------------------------------------------------------------------
// TerminationReason
// ---------------------------------------------------------------------------

export type TerminationReason =
  | 'idle-stall'
  | 'loop-stall'
  | 'no-diff-stall'
  | 'backstop-timeout'
  | 'clean-exit'
  | 'error-exit';

// ---------------------------------------------------------------------------
// StallMonitorHandle — returned by attachStallMonitor
// ---------------------------------------------------------------------------

export interface StallMonitorHandle {
  /**
   * Feed the next normalised RunEvent into the stall detector.
   * Call this from the spawnEngine onEvent callback.
   */
  onEvent(ev: RunEvent): void;

  /**
   * Notify the monitor that a file mutation was observed explicitly.
   * Also triggered automatically when a file_touched RunEvent is fed via onEvent.
   */
  onFileTouched(): void;

  /**
   * Detach all timers. Safe to call multiple times.
   * Call this when the child exits (stall or clean).
   */
  detach(): void;

  /** Resolves with the stall reason when a stall is detected, or null when detached cleanly. */
  waitForStall(): Promise<TerminationReason | null>;
}

// ---------------------------------------------------------------------------
// attachStallMonitor
// ---------------------------------------------------------------------------

/**
 * Attach a stall monitor. When a stall is detected, the monitor calls
 * `onStall(reason)` exactly once — the caller is responsible for sending
 * SIGINT → grace → SIGKILL to the child process.
 *
 * @param cfg         AshlrConfig (reads cfg.foundry.stallIdleMs if present).
 * @param onStall     Called once when a stall condition is detected.
 * @param stallIdleMs Override idle timeout (ms). Injected by tests so that
 *                    vi.advanceTimersByTimeAsync() controls advancement.
 */
export function attachStallMonitor(
  cfg: AshlrConfig,
  onStall: (reason: TerminationReason) => void,
  stallIdleMs?: number,
): StallMonitorHandle {
  const idleMs: number =
    stallIdleMs ??
    ((cfg.foundry as Record<string, unknown> | undefined)?.['stallIdleMs'] as number | undefined) ??
    DEFAULT_STALL_IDLE_MS;

  let totalEvents = 0;
  let fileTouchedCount = 0;
  let detached = false;
  let stalled = false;

  // Ring buffer of recent (tool+normArgs) hashes for loop-stall detection.
  const recentHashes: string[] = [];

  // Promise that resolves when a stall is detected or the monitor is detached.
  let resolveStall!: (r: TerminationReason | null) => void;
  const stallPromise = new Promise<TerminationReason | null>((res) => { resolveStall = res; });

  // -----------------------------------------------------------------------
  // Stall trigger
  // -----------------------------------------------------------------------

  function triggerStall(reason: TerminationReason): void {
    if (stalled || detached) return;
    stalled = true;
    // Resolve the promise BEFORE calling detach() so detach()'s resolveStall(null)
    // fires after — but Promise resolution is idempotent so the first call wins.
    resolveStall(reason);
    detach();
    onStall(reason);
  }

  // -----------------------------------------------------------------------
  // Idle-stall timer — reset on every event
  // -----------------------------------------------------------------------

  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  function resetIdleTimer(): void {
    if (detached) return;
    if (idleTimer !== null) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      triggerStall('idle-stall');
    }, idleMs);
    if (idleTimer.unref) idleTimer.unref();
  }

  // Start the idle timer immediately so even a silent child stalls correctly.
  resetIdleTimer();

  // -----------------------------------------------------------------------
  // Public handle
  // -----------------------------------------------------------------------

  function onEvent(ev: RunEvent): void {
    if (detached || stalled) return;
    totalEvents++;
    resetIdleTimer();

    // Track file mutations from file_touched events.
    if (ev.kind === 'file_touched') fileTouchedCount++;

    // M291: count edit-like tool calls as file mutations so an editing agent is
    // recognised as productive (claude/codex edit tool-calls arrive as 'tool_call',
    // never 'file_touched', so the no-diff-stall detector otherwise never sees edits).
    if (ev.kind === 'tool_call' && ev.toolName && EDIT_TOOL_RE.test(ev.toolName)) {
      fileTouchedCount++;
    }

    // Loop-stall detection: hash (toolName + normalised text) for tool_call events.
    if (ev.kind === 'tool_call' && ev.toolName) {
      const normArgs = (ev.text ?? '').replace(/\s+/g, ' ').trim().slice(0, 256);
      const hash = createHash('sha1')
        .update(`${ev.toolName}|${normArgs}`)
        .digest('hex')
        .slice(0, 8);
      recentHashes.push(hash);
      if (recentHashes.length > LOOP_STALL_WINDOW) recentHashes.shift();

      if (
        recentHashes.length >= LOOP_STALL_WINDOW &&
        recentHashes.every((h) => h === recentHashes[0])
      ) {
        triggerStall('loop-stall');
        return;
      }
    }

    // No-diff-stall detection: many events, zero file writes.
    // M300b: codex emits MANY noise events (skill-load + MCP-auth errors from its
    // global ~/.codex config) BEFORE its first edit — 80 false-killed it. Make the
    // threshold config-driven + default much higher so verbose agents reach their
    // first edit. (idle-stall + the 2h wall-clock remain the real backstops.)
    const noDiffMin =
      ((cfg.foundry as Record<string, unknown> | undefined)?.['noDiffMinEvents'] as number | undefined) ??
      (NO_DIFF_MIN_EVENTS * 5); // 80 → 400
    if (totalEvents >= noDiffMin && fileTouchedCount === 0) {
      triggerStall('no-diff-stall');
    }
  }

  function onFileTouched(): void {
    if (detached || stalled) return;
    fileTouchedCount++;
    resetIdleTimer();
  }

  function detach(): void {
    if (detached) return;
    detached = true;
    if (idleTimer !== null) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
    // If not yet resolved, resolve null (clean detach).
    resolveStall(null);
  }

  function waitForStall(): Promise<TerminationReason | null> {
    return stallPromise;
  }

  return { onEvent, onFileTouched, detach, waitForStall };
}
