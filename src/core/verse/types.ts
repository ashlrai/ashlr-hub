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
