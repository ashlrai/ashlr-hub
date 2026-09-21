/**
 * Ashlr Verse — interactive multi-turn session contract (V1).
 *
 * A Verse session binds one project directory to one execution seat
 * (engine + account + model). Each user turn spawns ONE vendor CLI process
 * that resumes the vendor-native conversation by id, streams normalized
 * events, and exits. No long-lived stdin is held between turns.
 *
 * Seats:
 *   claude  -> `claude -p ... --output-format stream-json` via a native-profile launcher (account pinned by CLAUDE_CONFIG_DIR)
 *   local   -> the plain `claude` binary with ANTHROPIC_BASE_URL pointed at Ollama (Anthropic-compatible API); model = Ollama tag
 *   codex   -> `codex exec --json` / `codex exec resume <threadId> --json` via a native-profile launcher (CODEX_HOME pinned)
 *   grok    -> `grok -p ... --output-format streaming-messages-json` via a native-profile launcher (GROK_HOME pinned)
 *
 * Nothing in this module reads secrets. Account identity is pinned by the
 * launcher command recorded in ~/.ashlr/account-connections/connections.json.
 */

export type VerseEngine = 'claude' | 'codex' | 'grok' | 'local';

export type VerseSessionStatus = 'idle' | 'running' | 'error';

/** One selectable execution seat shown in the model/account picker. */
export interface VerseSeat {
  /** Stable id, e.g. `claude`, `codex-personal`, `grok`, `local:qwen3-coder-next:ctx64k`. */
  id: string;
  engine: VerseEngine;
  /** Human label, e.g. "Claude Code", "Personal Codex", "Grok", "Qwen3-Coder-Next (local)". */
  label: string;
  /** Account id from connections.json for native seats; `local` for Ollama seats. */
  accountId: string;
  /** Models this seat can run. First entry is the default. */
  models: VerseModelOption[];
  /** Best-known context window in tokens for the default model (null when unknown). */
  contextWindow: number | null;
  /** Latest health/usage evidence, if any. Never an admission input in V1. */
  health: VerseSeatHealth;
  /**
   * V2.1 ADDITIVE. The subscription capacity behind this seat, so the seat
   * list can render a meter without a second request.
   *
   * Absent (`undefined`) for LOCAL seats: an Ollama tag has no subscription
   * and no provider window. Its real constraint is machine memory, which is
   * reported by `VerseBootstrap.localRuntime`, not by a quota. Absent on a
   * native seat means the server could not build a record for that account
   * at all — `health.state` says what it does know.
   */
  capacity?: VerseSeatCapacity;
}

export interface VerseModelOption {
  id: string;
  label: string;
  contextWindow: number | null;
}

export interface VerseSeatHealth {
  state: 'ready' | 'degraded' | 'unavailable' | 'unknown';
  /** e.g. "5h window 72% used, resets 14:00" — plain text, already sanitized. */
  summary: string | null;
  windows: Array<{ id: string; usedPercent: number | null; resetsAt: string | null }>;
  observedAt: string | null;
}

// ---------------------------------------------------------------------------
// Seat capacity (V2.1, additive) — see docs/VERSE-TELEMETRY-V2.md, which is
// the authority for every honesty rule encoded in these shapes.
//
// This file is imported by the BROWSER bundle, so it may not import
// `core/verse/accounts.ts` (node:fs). The shapes below therefore restate the
// provider-record shapes structurally. `seats.ts` assigns the account record's
// values straight into them, so a divergence in `core/verse/accounts.ts` stops
// `seats.ts` compiling — that assignment is the drift guard.
// ---------------------------------------------------------------------------

/** One provider-reported quota window, as carried on a seat. */
export interface VerseSeatWindow {
  id: string;
  /** Provider-reported percent, or null for NO SIGNAL — which is not zero. */
  usedPercent: number | null;
  /**
   * Machine-readable reset instant. STRUCTURALLY ALWAYS NULL for Claude: that
   * provider publishes only a sentence, which lives in `resetDescription` and
   * is rendered verbatim. Never synthesize a countdown from a description.
   */
  resetsAt: string | null;
  /** The provider's own reset wording, verbatim ("resets Sep 25 at 7pm (America/New_York)"). */
  resetDescription: string | null;
  /**
   * TRUE only when the provider explicitly FLAGGED the limit. Such a window's
   * `usedPercent` is the SENTINEL 100 — a denial, not a measurement — and must
   * be labelled "limit reached", never "100% used".
   */
  limitReached: boolean;
  /** False when `usedPercent` is a flagged sentinel rather than a reading. */
  measured: boolean;
}

/**
 * Codex credits, INDEPENDENT of the window: a fully used weekly window with a
 * spendable balance is not blocked. `null` is "no signal", never "no credits".
 */
export interface VerseSeatCredits {
  hasCredits: boolean;
  unlimited: boolean;
  /** Provider-reported decimal string, kept verbatim — never rounded. */
  balance: string | null;
}

/**
 * The coarse "can I use this seat right now" verdict. Deliberately coarse: the
 * exact numbers are in `windows`, and a verdict that pretended to more
 * precision than the providers give would be a lie.
 *
 * - `ready`      — a reading exists and the binding window has headroom.
 * - `tight`      — the binding window is at/above the warn threshold, OR it is
 *                  spent while Codex credits remain spendable (not blocked).
 * - `exhausted`  — the binding window is spent and nothing else is left.
 * - `signed-out` — the account is not authenticated; reconnect it.
 * - `unknown`    — NO window carried a percent. Not zero, not healthy.
 */
export type VerseSeatUsability = 'ready' | 'tight' | 'exhausted' | 'signed-out' | 'unknown';

/**
 * Where a seat's windows came from, so nothing implies freshness it lacks.
 * Mirrors `VerseEvidenceSource` in `core/verse/accounts.ts`.
 */
export type VerseSeatEvidenceSource = 'collector' | 'shared-evidence' | 'baseline' | 'none';

/** Everything the seat list needs to draw a capacity meter honestly. */
export interface VerseSeatCapacity {
  /** e.g. "max", "pro", "SuperGrok". Null when the provider gave none. */
  planType: string | null;
  /**
   * THE CONSTRAINT THAT ACTUALLY BLOCKS WORK: the window with the highest
   * `usedPercent`. Null when no window carried a percent at all.
   */
  binding: VerseSeatWindow | null;
  /** Every window the provider reported, in provider order. */
  windows: VerseSeatWindow[];
  /** Codex only; null for every other provider and when no signal exists. */
  credits: VerseSeatCredits | null;
  usability: VerseSeatUsability;
  observedAt: string | null;
  evidenceSource: VerseSeatEvidenceSource;
  /** Plain-language provider facts the UI must show instead of implying a fault. */
  notes: string[];
}

export interface VerseProject {
  path: string;
  name: string;
  /** From ~/.ashlr/enrollment.json when present. */
  enrolled: boolean;
}

export interface VerseUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  /** Prompt size of the most recent assistant call = live context occupancy. */
  contextTokens: number;
  contextWindow: number | null;
}

export interface VerseSession {
  id: string;
  title: string;
  projectPath: string;
  engine: VerseEngine;
  accountId: string;
  seatId: string;
  model: string;
  /** Vendor conversation id used for resume (claude/grok: our uuid; codex: thread id from output). */
  nativeSessionId: string | null;
  createdAt: string;
  updatedAt: string;
  status: VerseSessionStatus;
  turnCount: number;
  usage: VerseUsage;
  lastError: string | null;
}

/** Normalized event stream. `seq` is monotonic per session and is the SSE id. */
export type VerseEvent =
  | { seq: number; at: string; type: 'user-message'; turnId: string; text: string }
  | { seq: number; at: string; type: 'turn-started'; turnId: string; pid: number | null }
  | { seq: number; at: string; type: 'text-delta'; turnId: string; text: string }
  | { seq: number; at: string; type: 'assistant-message'; turnId: string; text: string }
  | { seq: number; at: string; type: 'thinking'; turnId: string; text: string }
  | { seq: number; at: string; type: 'tool-use'; turnId: string; toolUseId: string; name: string; input: unknown }
  | { seq: number; at: string; type: 'tool-result'; turnId: string; toolUseId: string; output: string; isError: boolean }
  | { seq: number; at: string; type: 'usage'; turnId: string; usage: VerseUsage }
  | { seq: number; at: string; type: 'turn-done'; turnId: string; ok: boolean; nativeSessionId: string | null; durationMs: number }
  | { seq: number; at: string; type: 'error'; turnId: string | null; message: string }
  | { seq: number; at: string; type: 'cancelled'; turnId: string };

export type VerseEventType = VerseEvent['type'];

/** GET /api/verse/bootstrap */
export interface VerseBootstrap {
  seats: VerseSeat[];
  projects: VerseProject[];
  sessions: VerseSession[];
  /** Whether POST routes are enabled on this server (`ashlr serve --allow-dispatch` / `ashlr verse`). */
  dispatchEnabled: boolean;
  /** Ollama reachable? Drives the local seats and an inline hint when false. */
  localRuntime: { ollama: { reachable: boolean; baseUrl: string; models: string[] } };
}

/**
 * GET /api/verse/seats (V2.1)
 *
 * WHY THIS ROUTE EXISTS: `bootstrap` is a MOUNT-TIME snapshot. A client that
 * opened the app before the collector's first cycle finished would show
 * "unknown" forever. This is the same seat list, cheap enough to poll, and it
 * always reflects the collector's CURRENT state rather than a cached one.
 */
export interface VerseSeatsResponse {
  /** When this body was built. */
  sampledAt: string;
  seats: VerseSeat[];
  localRuntime: VerseBootstrap['localRuntime'];
}

/** POST /api/verse/sessions */
export interface VerseCreateSessionRequest {
  projectPath: string;
  seatId: string;
  model?: string;
  title?: string;
}

/** POST /api/verse/sessions/:id/turns */
export interface VerseTurnRequest {
  text: string;
}
export interface VerseTurnResponse {
  turnId: string;
  session: VerseSession;
}

/** GET /api/verse/sessions/:id */
export interface VerseSessionDetail {
  session: VerseSession;
  events: VerseEvent[];
}

/** Adapter input: how to launch one turn. Pure data, produced by the engine, consumed by the spawner. */
export interface VerseTurnLaunch {
  argv: string[];
  cwd: string;
  /** Extra env layered over a minimal base (PATH/HOME/TMPDIR/LANG). Never contains secrets. */
  env: Record<string, string>;
  /** Text written to stdin (codex); null when the prompt is in argv. */
  stdin: string | null;
}

export const VERSE_MAX_TURN_TEXT_BYTES = 64 * 1024;
export const VERSE_MAX_EVENTS_PER_SESSION = 20_000;
export const VERSE_TURN_TIMEOUT_MS = 30 * 60 * 1000;
export const VERSE_DEFAULT_CONTEXT_WINDOWS: Record<string, number> = {
  claude: 200_000,
  codex: 272_000,
  grok: 256_000,
  local: 65_536,
};
