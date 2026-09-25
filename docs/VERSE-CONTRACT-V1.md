# Ashlr Verse V1 — build contract

Goal: a Claude-desktop-style operator surface inside ashlr-hub where Mason opens a project, picks a seat
(Claude Max account, Codex account A/B, Grok, or a local Ollama model), chats with an agent that can edit
that project, sees live context-window occupancy, and sees all account resources in one place. Served by
`ashlr serve` (main server), opened by `ashlr verse`, wrapped by the Tauri desktop app.

Types are the spine: `src/core/verse/types.ts`. Do not change exported shapes without updating every consumer.

## File layout (owners in brackets)

```
src/core/verse/
  types.ts                 [contract — frozen]
  adapters/
    claude.ts              [A] build argv/env + parse stream-json lines -> VerseEvent[] (also used for engine=local)
    codex.ts               [A] build argv (exec / exec resume) + parse codex JSONL
    grok.ts                [A] build argv + parse streaming-messages-json (Anthropic wire format)
    index.ts               [A] adapterFor(engine)
  session-store.ts         [A] durable store: ~/.ashlr/verse/sessions/<id>.json + <id>.events.jsonl (append-only, seq)
  session-engine.ts        [A] createSession / sendTurn / cancelTurn / subscribe(sessionId, fromSeq) — owns spawn + process-group kill
  seats.ts                 [B] discover seats: connections.json accounts (+ observations.json health when present) + Ollama tags
  projects.ts              [B] enrolled repos from ~/.ashlr/enrollment.json + any projectPath used by an existing session
  verse-api.ts             [B] handleVerseApi(ctx, req, res, path, method) mounted from src/core/web/api.ts before the 404
  verse-stream.ts          [B] SSE tail for /api/verse/sessions/:id/events, modeled on src/core/web/run-stream.ts (Last-Event-ID resume)
src/cli/verse.ts           [B] `ashlr verse [--port N] [--no-open] [--json]` = serve with dispatch enabled, prints tokens, opens /verse/
src/web-ui/routes/verse/   [C] VerseApp.tsx + components (see UI spec)
src/web-ui/app/console-mode.ts  [C] add isVerseConsolePath() for pathname `/verse`
src/web-ui/main.tsx        [C] mount VerseApp on that path
src/core/web/static.ts     [B] map `/verse` and `/verse/` -> /next/index.html (same as /resources)
desktop/                   [D] point window at /verse/, generate icons, stage sidecar, document macOS build
docs/VERSE.md              [D] user guide
```

## Backend behavior

### Seats (`seats.ts`)
- Read `~/.ashlr/account-connections/connections.json` (path overridable via `cfg.verse?.accountsRoot`, default that dir).
  Each account → one seat: `id=account.id`, `engine=account.provider` (`codex|claude|grok`), `label=account.label`,
  `accountId=account.id`, launcher `command` kept privately (NOT exposed in the API).
- Models per engine. *The V1 lists (`gpt-5.5-mini`, `grok-4`, 200k for every Claude model, 256k for Grok) were wrong and are
  superseded by V3.9* — see [the V3.9 section](#v39-additive-contract--context-orchestration) and `docs/VERSE-CONTEXT.md` §1:
  claude from `model-windows.ts` `VERSE_CLAUDE_MODEL_SPECS` (per-model window, max output and `minCliVersion`, checked against
  the seat's pinned CLI version); codex from the seat's own `native-state/models_cache.json` (visible slugs; a documented
  fallback list when the seat has no catalog yet); grok from the seat's own catalog, `.info` only (500k).
- Local seats: `GET <ollama>/api/tags` (base from `cfg.models.ollama` or `http://127.0.0.1:11434`, 2s timeout). One seat per tag whose
  `/api/show` capabilities include `tools` (the name regex `/coder|code|qwen|deepseek|devstral|llama/i` is only a fallback for an
  Ollama that reports no capabilities), `id=local:<tag>`, `engine=local`, `accountId=local`. contextWindow (V3.9): the llama-server
  per-slot `n_ctx` on that lane, else `min(num_ctx, native)` when `num_ctx` is pinned, else `min(server default, native)` with the
  server default taken from the resident `/api/ps` context → `OLLAMA_CONTEXT_LENGTH` → the running server's `server.log` config
  line → its VRAM-default line, else the trained length marked `fallback`; only when `/api/show` failed, the `ctxNNk` tag suffix
  (`/(?:^|[:_-])ctx(\d+)k$/i`), else 65536 — `docs/VERSE-CONTEXT.md` §1.5.
- Health: if `observations.json` exists and has an entry for the account, map `health`+`windows` into `VerseSeatHealth`; else `unknown`.
  Additionally for claude, use `src/core/fabric/claude-usage.ts` rolling-window token counts to fill `summary` when available.

### Session engine (`session-engine.ts`)
- `createSession(req)` validates `projectPath` is an existing directory (realpath), seat exists, model ∈ seat.models (default first).
  `nativeSessionId` for claude/local/grok = `randomUUID()` minted now; codex = null until the first `thread.started`.
- `sendTurn(sessionId, text)`: reject if `status==='running'` (409), text > `VERSE_MAX_TURN_TEXT_BYTES` (413). Append `user-message`,
  set status running, build `VerseTurnLaunch` via the adapter, spawn with `stdio: ['pipe'|'ignore', 'pipe', 'pipe']`, `detached: true`
  (process group), parse stdout line-by-line through the adapter, append events, on exit append `usage` (if any) and `turn-done`.
  Timeout `VERSE_TURN_TIMEOUT_MS` → SIGINT, 10s grace, SIGKILL to the group → `error` + `turn-done ok:false`.
- `cancelTurn(sessionId)` → same kill path → `cancelled` + `turn-done ok:false`.
- `subscribe(sessionId, fromSeq, listener)` → replays events with `seq > fromSeq` then live. Unsubscribe function returned.
- Base env for every spawn: `{PATH, HOME, TMPDIR, LANG, LC_ALL}` from process.env + adapter env. Never forward process.env wholesale.
  Strip anything matching the `CRED_ENV_DENY` regex from `src/core/run/sandboxed-engine.ts` (import it or copy the regex with a comment).
- Session title: first 60 chars of the first user message unless provided.
- Store writes are atomic (temp + rename), events appended with `appendFileSync`; `VERSE_MAX_EVENTS_PER_SESSION` enforced (oldest dropped on read, not deleted).

### Adapters
Each exports `buildLaunch(session, text, seat): VerseTurnLaunch` and `createParser(turnId): { push(line: string): VerseEvent[]; finish(exitCode: number|null): VerseEvent[] }`.
Events omit `seq`/`at` (engine stamps them). Parsers must never throw on garbage lines (drop them).

- **claude** (`engine=claude` and `engine=local`):
  argv = `[...launcherCommand]` for claude (account launcher) or `['claude']` for local, then
  `['-p', text, '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--model', model,
    '--permission-mode', 'acceptEdits', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}']`
  plus `['--resume', nativeSessionId]` when `session.turnCount > 0` else `['--session-id', nativeSessionId]`.
  local env: `ANTHROPIC_BASE_URL=<ollama base without /v1>`, `ANTHROPIC_AUTH_TOKEN=ollama`, `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`.
  V3.9 adds: `--model` is the canonical id (`canonicalModelId`); claude seats pass `--autocompact <400000|auto>` per the session's
  mode; local adds env `CLAUDE_CODE_MAX_CONTEXT_TOKENS=<session window>` and `--exclude-dynamic-system-prompt-sections`; when the
  launch record carries memory, `--add-dir <dir>` (when the snapshot is writable) and `--append-system-prompt=<block>` — the same
  snapshotted block every turn.
  Parse: `stream_event` with `content_block_delta.text_delta` → `text-delta`; `assistant` message content blocks → `assistant-message`
  (text) / `tool-use`; `user` message `tool_result` blocks → `tool-result`; `result` → `usage` (input_tokens + cache_read + cache_creation
  = contextTokens; V3.9: `contextWindow` from `result.modelUsage`) and `ok = subtype==='success'`. Ignore `system` except `init`
  (log model) and, V3.9, `compact_boundary` → `compaction`.
- **codex**: first turn argv = `[...launcher, 'exec', '--json', '--model', model, '--cd', cwd, '--sandbox', 'workspace-write', '-']`
  with prompt on stdin; later turns `[...launcher, 'exec', 'resume', nativeSessionId, '--json', '-']` + stdin.
  Parse codex JSONL (see `src/core/run/engines.ts` normaliseEngineOutputLine and `src/core/resources/worker.ts` parseCodex for the shapes):
  `thread.started.thread_id` → captured nativeSessionId (emit via `turn-done.nativeSessionId`); `item.started/completed` with
  `agent_message` → `assistant-message`; `command_execution`/`file_change`/`mcp_tool_call` items → `tool-use` + `tool-result`;
  `turn.completed.usage` → `usage` (V3.9: the parser HOLDS it and `afterTurn` emits the turn's single `usage` event from the
  rollout — see below; `contextTokensExact: false` when no rollout reading exists, because the turn total is an upper bound). V3.9 expansive mode adds `-c model_context_window=<providerWindow>` and
  `-c model_auto_compact_token_limit=<autoCompactAt>`, always together, on both `exec` and `exec resume`. Memory (V3.9) rides
  `-c` too — the directory in `sandbox_workspace_write.writable_roots`, the block as `developer_instructions` — because
  `exec resume` accepts `-c` but not `--add-dir`. On `exec resume`, `turn.completed.usage` is the THREAD's running total (codex
  seeds its counter from the rollout), so the turn's usage comes from the rollout: its per-turn `token_usage_record` (0.149+),
  else the sum of the turn's calls, else the printed figure converted to a delta.
- **grok**: argv = `[...launcher, '-p', text, '--output-format', 'streaming-messages-json', '--include-partial-messages',
  '--cwd', cwd, '--model', model, '--permission-mode', 'acceptEdits']` + (`['--resume', id]` after first turn else `['--session-id', id]`).
  Parse Anthropic Messages wire format lines (same block/delta shapes as claude stream-json without the outer `stream_event` wrapper —
  handle both). Usage from `message_delta.usage` / `message_start.message.usage`. V3.9: `contextWindow` from the single
  `result.modelUsage` row carrying a numeric `contextWindow` (its key can differ from the CLI id); `compact_boundary` →
  `compaction`; no mode flags (Grok has no per-invocation compaction setting); memory as `--rules=<block>` (Grok's append-to-system-
  prompt flag), read-only because Grok can reach nothing beyond `--cwd`.

### API (`verse-api.ts`) — mounted in `handleApi` before the 404 fallthrough; GETs use the read session, POSTs use `passesMutationGate` + `ctx.allowDispatch` (404 when off) exactly like existing mutating routes
- `GET  /api/verse/bootstrap` → `VerseBootstrap`
- `GET  /api/verse/sessions` → `VerseSession[]`
- `POST /api/verse/sessions` `VerseCreateSessionRequest` → `VerseSession` (201)
- `GET  /api/verse/sessions/:id` → `VerseSessionDetail`
- `POST /api/verse/sessions/:id/turns` `VerseTurnRequest` → `VerseTurnResponse` (202)
- `POST /api/verse/sessions/:id/cancel` → `{ ok: true }`
- `POST /api/verse/sessions/:id/delete` → `{ ok: true }` (removes files)
- `POST /api/verse/sessions/:id/rename` `{ title }` → `VerseSession`
- `GET  /api/verse/sessions/:id/events` → SSE; event name = `VerseEvent.type`, `id` = seq, data = the event JSON; honors `Last-Event-ID`;
  15s `: keepalive` comments; requires the read *session* (cookie) like `/api/events`.
Errors: `{ error, code? }` via `sendJson`. Codes: `VERSE_SESSION_NOT_FOUND` 404, `VERSE_SESSION_BUSY` 409, `VERSE_INVALID` 400, `VERSE_TOO_LARGE` 413. V3.9 adds `VERSE_MODEL_UNAVAILABLE` 409 (a turn on a model the seat lists as unavailable) and `VERSE_MEMORY_REDACTED` 409 (`POST /memory` content carrying more `[REDACTED]` placeholders than the file on disk).
Also add `verse` to the `/api/events` `emitUpdate` poll: emit `verse-sessions` (list digest) when it changes, so the sidebar refreshes.
V3.9 adds context-mode, handoff-preview, preferences, context-fit, search and memory routes — listed in
[the V3.9 section](#v39-additive-contract--context-orchestration).

### CLI (`src/cli/verse.ts`)
`ashlr verse [--port N] [--no-open] [--json]` → `startServer` with `allowDispatch: true`, prints
`Ashlr Verse  http://127.0.0.1:<port>/verse/` + read token + mutation token (same wording as serve.ts), opens the browser unless `--no-open`.
Register in `src/cli/index.ts` dispatch table + help text.

## UI spec (`src/web-ui/routes/verse/`)
Full-bleed console app (pattern: `ResourcePoolConsoleApp.tsx`), pathname `/verse`. Uses `data/client.ts` (`apiGet`/`apiPost`), `auth-store`
(`useMutationHold` + `MutationTokenDialog`), `SessionGate` for the read token, design tokens from `design/tokens.css`, primitives from
`components/primitives`. No new global state library; a small `verse-store.ts` (useSyncExternalStore) is fine.

Layout (three columns, resizable like WorkspaceView):
1. **Sidebar** (260px): brand "Ashlr Verse"; `+ New chat`; search; sessions grouped by project (project name header, sessions sorted by
   updatedAt, seat badge, running dot); footer: seat health summary chips (one per account) + "Resources" toggle.
2. **Workspace**: header (session title editable, seat/model badge, project path, context meter); transcript (virtualization not required in V1;
   render Markdown via `marked` + `dompurify` — add `dompurify` as a dependency; code blocks with copy button; tool-use cards collapsed by default
   showing tool name + summarized input + result, error tint when isError; thinking blocks collapsed); live streaming text appended from
   `text-delta` until the matching `assistant-message` arrives, then replaced; auto-scroll unless the user scrolled up (show "Jump to latest").
   **Composer**: textarea (Enter sends, Shift+Enter newline), seat/model selector (grouped: Claude · Codex · Grok · Local; disabled with reason
   when health.state==='unavailable'; changing the seat on an existing session creates a new session — sessions are seat-bound),
   dictation button (Web Speech API `webkitSpeechRecognition`/`SpeechRecognition` when present: toggles listening, interim results shown
   in the textarea; when unavailable render a tooltip "Use Wispr Flow / Superwhisper — system dictation works in this box"), send/stop button
   (stop → cancel). Composer disabled while `status==='running'` except stop.
   **Context meter** (V3.9 — supersedes the V1 "amber ≥70%, red ≥90% of the window"): full-window track with a compaction tick,
   label "142k / 1M · compacts ≈367k", tone from context-math `occupancy` (warn at 80 %, danger at 95 % of the compaction point,
   `over` past the window), "≤" when the reading is not exact, unknown window → "n/a". See `docs/VERSE-CONTEXT.md`.
3. **Resources panel** (right, 320px, collapsible): seats with health state, usage windows (meter per window), local runtime status (Ollama reachable, models),
   running sessions with elapsed time and stop buttons, cumulative usage for the current session (input/output/cache).

New-chat flow: modal or inline panel → pick project (list from bootstrap + "Other folder…" free-text absolute path), pick seat + model, optional title → create → focus composer.
Keyboard: ⌘K opens a session/seat quick switcher (reuse CommandPalette if practical, else a minimal list), ⌘N new chat, Esc stops dictation.
Theme: follow `theme-store.ts`; both themes must pass contrast on transcript text and tool cards.

Tests (`*.test.tsx` beside components, run by `npm run test:web`): bootstrap renders seats/projects/sessions from a stubbed fetch; creating a session
POSTs the right body; sending a turn appends the user message and renders streamed deltas from a fake EventSource (stub `EventSource` global);
context meter thresholds; dictation button fallback when no SpeechRecognition; seat selector disables unavailable seats.

## Desktop (`desktop/`)
- `tauri.conf.json`: window `url` → `http://127.0.0.1:7777/verse/`, `devUrl` same, title "Ashlr Verse", width 1280 height 820, min 960×640.
- Generate icons from `icons/icon.svg` via the existing script; stage the sidecar via `prepare-sidecar.mjs` after `npm run build:binary`.
- Sidecar must start the server on port 7777 with dispatch enabled and hand tokens to the window: document the current mechanism in
  `desktop/README.md`; if the sidecar lacks a way to pass tokens, add `--verse` mode to the sidecar launch that prints `{readToken, token}` JSON and
  have `lib.rs` inject them via `window.__ASHLR_TOKENS__` init script (Tauri `initialization_script`). SessionGate must accept `window.__ASHLR_TOKENS__`
  when present (owner C exposes a tiny hook; owner D wires Rust side).
- `docs/VERSE.md`: what it is, `ashlr verse`, seats, local models, dictation note, macOS build steps, known limits.

## V3.9 additive contract — context orchestration

Everything below is **optional and additive**: a record, fixture or client written before V3.9 keeps validating and behaves as
before (absent `contextTokensExact` = exact, absent memory = off). Absent `contextMode` means a record from before V3.9, because
every V3.9 create writes it explicitly (`'standard'` included): a Claude record whose model has an expansive budget resolves to
`expansive` — the ~967k compaction it ran at before, since 3.5–3.8 passed no `--autocompact` — and the engine persists
`contextMode: 'expansive'` the first time the session is loaded, read or sent a turn; every other absent `contextMode` is `standard`. New fields are spread onto
records only when present, so an ordinary session's on-disk shape does not change. The GET `/api/verse/bootstrap` key set is
unchanged. The authority for every number and rule is `docs/VERSE-CONTEXT.md`; the arithmetic lives in one browser-safe module,
`src/core/verse/context-math.ts`, used by the server and the UI alike.

### Types (`src/core/verse/types.ts`)

| Shape | New optional fields |
|---|---|
| `VerseSeat` | `cliVersion` (the pinned CLI binary's version), `notes: string[]` (binary skew, catalog not yet fetched, …) |
| `VerseModelOption` | `autoCompactAt` (standard), `expansive: VerseContextBudget \| null` (present only when real), `maxOutputTokens`, `windowSource: VerseWindowSource`, `minCliVersion`, `unavailableReason` (non-null = listed but not runnable) |
| `VerseUsage` | `contextWindowSource`, `autoCompactAt`, `contextTokensExact` (false = upper bound). `contextTokens` is now stored **unclamped** |
| `VerseSession` | `contextMode: 'standard' \| 'expansive'`, `compactionCount`, `handoffFrom: { sessionId, title }`, `memoryEnabled` |
| `VerseCreateSessionRequest` | `contextMode` (absent → the seat's preferred mode, else standard), `handoffFromSessionId` (the server resolves the title) |
| `VerseProjectMemory` | `contentSanitized: true` — present only when the `content` sent differs from the file's bytes (`sanitizePublicJson` rewrote the home path to `~` or replaced secret-shaped text with `[REDACTED]`) |
| `VerseSeatLaunch` (private launch record, `session-engine.ts`) | `memory: { dir, block, writable }` — snapshotted at creation; the same block every turn |

New types: `VerseWindowSource` (`runtime` · `provider-catalog` · `cli-catalog` · `documented` · `fallback`), `VerseContextMode` /
`VERSE_CONTEXT_MODES`, `VerseContextBudget { contextWindow, autoCompactAt, providerWindow? }`, `VersePreferences`,
`VersePreferencesUpdate`, `VerseContextModeRequest`, `VerseHandoffPreviewRequest`, `VerseHandoffPreview`, `VerseContextFit`,
`VerseContextFitRoot`, `VerseFitVerdict`, `VerseSearchHit`, `VerseSearchResponse`, `VerseProjectMemory`,
`VerseProjectMemoryWrite`. Constants: `VERSE_HANDOFF_MAX_CHARS = 12_000`, `VERSE_MEMORY_MAX_BYTES = 64 KiB`,
`VERSE_HANDOFF_SUMMARY_REQUEST` (the fixed text of the "Ask *seat* to summarize first" turn: the UI sends it as an ordinary turn,
and the handoff builder leaves that exact text out of the note's "latest asks"), and
`VERSE_DEFAULT_CONTEXT_WINDOWS` = `{ claude: 200_000, codex: 258_400, grok: 500_000, local: 65_536 }` (last-resort fallbacks only;
every known model carries its own window).

### Events

Both are persisted and flow through the normal emit / SSE path (event name = `type`, id = `seq`):

- `compaction { turnId, trigger: 'auto' | 'manual', preTokens, postTokens, durationMs }` — the CLI compacted its conversation
  (claude/grok `system/compact_boundary`, `manual` for an operator's **Compact now** `/compact` turn; codex rollout `compacted`,
  trigger `auto`, with `preTokens` / `postTokens` from the bracketing `token_count` readings — the last before the line and the
  first after it — and `durationMs` null; a codex event can arrive mid-turn from `pollTelemetry`). The comment on the frozen
  `types.ts` declaration still says codex counts are null; the codex adapter fills them when the readings exist, null otherwise.
  The engine increments `session.compactionCount`.
- `context { turnId, contextTokens, contextWindow, exact, autoCompactAt?, contextWindowSource? }` — an occupancy **reading**
  (codex rollout `token_count`: `info.last_token_usage.total_tokens` against `info.model_context_window`), not a usage delta: it
  replaces `contextTokens` / the window and is never summed. The engine fills `autoCompactAt` for the window in force.
  `contextWindowSource` says where the window came from: a CLI reading is `runtime`; an event the engine writes itself after a
  **mode switch** or a **local window refresh** carries the budget's catalog source, so a client never relabels a catalog figure as
  a measurement. Absent on events from before the field existed — treat those as `runtime`.
- `usage` is unchanged in shape; its `contextWindow` is now the CLI's runtime figure when the CLI reports one (claude/grok
  `result.modelUsage` — the window only: its token counts accumulate across `--resume`). Codex emits exactly one `usage` per turn
  from `afterTurn`, not the parser: `exec resume`'s printed `turn.completed` usage is thread-cumulative, so the figure comes from
  the rollout (the CLI's 0.149+ per-turn record, else the sum of this turn's calls, else the printed figure as a delta), and
  falls back to the printed figure with `contextTokensExact: false` when no rollout is readable.

### Adapters (`src/core/verse/adapters/index.ts`)

`VerseAdapter` gains two optional hooks, the one place an adapter may read the filesystem (bounded, synchronous, never throwing):
`pollTelemetry(ctx)` every `VERSE_TELEMETRY_POLL_MS` (2 s) while a turn runs, and `afterTurn(ctx)` once after the process exits,
after the parser's `finish()` events are applied and before `turn-done`. `ctx: VerseAdapterTurnContext` carries the session, the
launch record, the turn id, the spawn time, the native id seen so far, the turn's parser and a per-turn `state` scratch object.
Codex implements both (its rollout); claude and grok need neither.

### Engine (`src/core/verse/session-engine.ts`)

- `createSession(req, launch, opts?: VerseCreateOptions)` — `opts.memory` / `opts.handoffFrom` are resolved by the API from
  preferences and the source session, never read off a request body. Rejects (`VERSE_INVALID`) a `contextMode` the model has no
  budget for and a model whose option carries an `unavailableReason` (the reason is in the message). Stores the mode's budget on
  `session.usage` (`contextWindow`, `autoCompactAt`, `contextWindowSource`). `opts.memory` is always passed on V3.9 creates — a
  snapshot, or `null` when memory is off or could not be set up, which the engine records as `memoryEnabled: false`.
- Turns: `POST /sessions/:id/turns` is refused with 409 `VERSE_MODEL_UNAVAILABLE` (the reason in the message) when the session's
  seat currently lists its model as unavailable — e.g. a stored `claude-opus-5.5` session on a seat pinned below 2.1.280, or a
  local tag whose window now resolves below `LOCAL_MIN_USABLE_WINDOW` — before any CLI is spawned.
- `createSession` always writes `contextMode` (`'standard'` included), so an absent key reliably marks a pre-V3.9 record (see the
  preamble for how those resolve).
- `setContextMode(id, mode): VerseSession` — new on `VerseEngineHandle`; applies from the next turn. Moving to `standard` while
  occupancy is above the standard compaction point makes the CLI compact on that next turn (a paid summary call on a metered seat);
  the engine does not refuse it, the UI warns.
- Local sessions: before each turn launches, the engine re-resolves the seat's window from live discovery and, when it differs,
  rewrites the stored `usage.contextWindow` / `autoCompactAt` (and emits a `context` event) — the adapter passes that stored window
  as `CLAUDE_CODE_MAX_CONTEXT_TOKENS`, so the CLI and the meter always use one number. A local window below
  `LOCAL_MIN_USABLE_WINDOW` (56,000, `context-math.ts`) is listed with an `unavailableReason`.
- Usage: a runtime window wins (source `runtime`, compaction point recomputed by `reconcileAutoCompactAt`) except on engine
  `local`, where Verse sets the window itself. Stored sessions whose model is an alias (`claude-opus-5.5`) keep their stored id.

### Routes (all under `/api/verse`, same gates as V1: POSTs 404 unless `allowDispatch` — including `handoff-preview`, so a
read-only server answers 404 there — then `passesMutationGate` + the 64 KiB JSON body cap (`POST /memory` alone: 2 × 64 KiB +
8 KiB = 139,264 bytes, so a full 64 KiB file survives JSON escaping; its content cap stays `VERSE_MEMORY_MAX_BYTES`); an unknown
body key **or an unknown or duplicated query parameter** is a 400, never ignored; every response through `sendJson` →
`sanitizePublicJson`. None of these routes starts a model call — the only spend is still `POST /sessions/:id/turns`, which also
carries an operator's **Compact now** (`/compact` as the turn text, claude and local seats only))

| Route | Body / query | Response |
|---|---|---|
| `POST /sessions` | V1 body plus optional `contextMode`, `handoffFromSessionId`. Now **strict**: any key outside `projectPath`, `seatId`, `model`, `title`, `extraRoots`, `workspaceId`, `contextMode`, `handoffFromSessionId` is a 400; a client-sent `workspaceName` is refused with its own message (the server fills it from `workspaceId`); a requested `claude-opus-5.5` is rewritten to `claude-opus-5-5` | `VerseSession` (201), with `memoryEnabled` always set |
| `POST /sessions/:id/context-mode` | `VerseContextModeRequest { mode }` | `VerseSession`; 409 `VERSE_SESSION_BUSY` while a turn runs, 400 `VERSE_INVALID` for a mode the model lacks |
| `POST /sessions/:id/handoff-preview` | `VerseHandoffPreviewRequest { includeLastAssistant?, focus? }` | `VerseHandoffPreview` — a POST because it runs `git`; spends nothing |
| `GET /preferences` | — | `VersePreferences` |
| `POST /preferences` | `VersePreferencesUpdate` — exactly one of `{seatId, contextMode}`, `{memoryEnabled}`, `{projectPath, memoryEnabled}` | `VersePreferences` |
| `GET /context-fit` | `?workspaceId=…` or `?projectPath=…[&extraRoots=…]…` — `extraRoots` repeats (a comma is legal in a path); never both forms; paths validated with the same rules as `createSession` | `VerseContextFit` |
| `GET /search` | `?q=…&limit=…` (limit ≤ 50) | `VerseSearchResponse` |
| `GET /memory` | `?projectPath=…` | `VerseProjectMemory`, with `contentSanitized: true` when the content shown is not the file's bytes |
| `POST /memory` | `VerseProjectMemoryWrite { projectPath, content }` (≤ `VERSE_MEMORY_MAX_BYTES`, else 413 `VERSE_TOO_LARGE`) | `VerseProjectMemory` (+ `contentSanitized?`); 409 `VERSE_MEMORY_REDACTED` when `content` holds more `[REDACTED]` markers than the file on disk — a save that would overwrite real values with the sanitizer's placeholders (the `~` home rewrite is not refused) |

### Files

```
src/core/verse/
  context-math.ts        [contract — frozen] budgets, compaction formulas, occupancy, fit verdict, advice (browser-safe)
  model-windows.ts       Claude spec table, seat-catalog readers (codex/grok), local option builder, CLI version helpers
  codex-rollout.ts       bounded rollout tail reads: token_count, compacted, task_started
  session-handoff.ts     buildHandoffPreview — deterministic handoff note
  context-fit.ts         estimateContextFit — git ls-files sizes, bytes/4, 60 s cache
  session-search.ts      searchSessions — bounded keyword scan of the session store
  project-memory.ts      memory dir, block, read/write
  preferences.ts         ~/.ashlr/verse/preferences.json (0600, atomic)
src/web-ui/routes/verse/context/   context-queries.ts, HandoffDialog, MemoryPanel, SessionSearch
```

Private state: `~/.ashlr/verse/preferences.json` (0600) and `~/.ashlr/verse/memory/<slug>-<sha256(realpath)[0:12]>/` (0700, files
0600). Neither is ever inside a repository.

## V3.10 additive contract — the workbench and the autonomy console

3.10 adds no V1 route and changes no V1 or V3.9 wire shape. Everything new is a **route family**: a module that owns
one or more path prefixes and exports one `ApiModule` handler (`(req, res, ctx, path) => Promise<boolean>`). `verse-api.ts`
only mounts them. Each module's header comment lists its own routes and is the authority for them; this section is the index.

### Mount rules (every family)

- **Order.** Families are consulted only after every V1 and V3.9 route has declined. Track A's modules come first, in a
  fixed order (health, reasoning, fleet history, budget); then the workbench families of
  `WORKBENCH_ROUTE_FAMILIES` (`src/core/verse/workbench-types.ts` §9), routed by prefix to exactly one family. A prefix
  owns its exact path and `prefix + '/…'` only, and no two prefixes overlap (`test/verse-workbench-contracts-310.test.ts`).
- **Gates.** GETs sit behind `server.ts`'s read session. Every non-GET is 404 unless the server allows dispatch, then
  passes `passesMutationGate` (constant-time token + JSON `Content-Type`) **before the module loads**; each module
  re-checks, so it is safe mounted anywhere. Agents and MCP clients hold no mutation token and reach none of it.
- **Strict input.** An unknown body key or query parameter (or a repeated single-valued one) is a 400, never ignored.
  Bodies keep the shared 64 KiB cap unless the family says otherwise (attachment uploads, terminal input).
- **Output.** Every JSON response goes through `sendJson` → `sanitizePublicJson` (home → `~`, secret-shaped text
  scrubbed). The two deliberate exceptions are named below: terminal output frames and preview file bodies.
- **Partial landing.** A family whose module has not landed is a plain 404 that touches nothing else. One that landed but
  fails to load answers 503 naming it (`API_MODULE_UNAVAILABLE`), never a misleading 404.
- **Budget.** No handler blocks the event loop over 20 ms; nothing polls faster than 2 s. Producers that other families
  read on every poll (`needsYouItems()`, `autonomyBadge()`) answer from memory and refresh off the caller's stack.
- **Honesty.** `null` means not measured. A source that cannot be read makes its numbers `null` and names itself, never 0.

### Track A modules

| Family (module) | Routes | Notes |
|---|---|---|
| health (`verse/health-api.ts`) | `GET /api/verse/health` → `VerseHealthResponse`; `POST /api/verse/health/refresh`; `POST /api/verse/health/reconnect {seatId}` → 202 | Zero spend: status commands only. Reconnect opens the seat's own login in Terminal (10 s cooldown per seat; 501 off macOS). Readiness refusals elsewhere are 409 `{ error, code: 'seat-not-ready', readiness }`. |
| reasoning (`reasoning/reasoning-api.ts`) | `GET /api/reasoning/digest[?days=1..180]`; `GET /api/reasoning/steps?q=&sessionId=&limit=` | Read-only. The only reader of the local reasoning store outside the process; the store never feeds a prompt. Note the prefix is `/api/reasoning`, not `/api/verse`. |
| fleet history (`verse/fleet-history.ts`) | `GET /api/verse/fleet/history` | Daily projection (runs, proposals, verdicts, verification, authenticated merges) + scorecard trend. Incremental, async, time-sliced readers. |
| budget (`routing/budget-api.ts`) | `GET /api/verse/budget`; `POST /api/verse/budget` (one of `{mode}` \| `{seatId, policy}`); `GET /api/verse/budget/preview?task=&difficulty=&autonomous=[&contextTokens=]`; `GET /api/verse/budget/decisions[?limit=]`; `GET /api/verse/budget/history[?days=1..14]` (3.10.1, default 8) → `CapacityHistoryResponse` | Nothing spends. A read refreshes `~/.ashlr/routing/capacity.json` (throttled) so the daemon sees current windows. `/history` (`routing/capacity-history-api.ts`, wire shape in `routing/capacity-history-types.ts`) serves per-seat window series from `~/.ashlr/routing/capacity-history.jsonl` (rows kept 8 days), bounded to ≤ 32 series × ≤ 720 points; `days` outside 1..14 is a 400. It mounts inside the `budget` entry (`withCapacityHistory`), so the family's id and mount order are unchanged, and a 200 `GET /api/verse/budget` also records the snapshot it refreshed (throttled, after the response). |

### Workbench families (Track C)

| Family (owner, module) | Routes |
|---|---|
| activity (C1, `verse/activity-api.ts`) | `GET /api/verse/activity[?since=<cursor>]`; `POST /api/verse/activity/seen` (`{sessionId, turnCount}` or `{surface:'mind'}`); `GET /api/verse/session-meta`; `GET /api/verse/session-meta/:id`; `POST /api/verse/session-meta/:id {pinned?, archived?}` |
| session-controls (C3, `verse/session-controls-api.ts`) | `GET\|POST /api/verse/session-controls/defaults`; `GET\|POST /api/verse/session-controls/:id` (`{model?, effort?, permissionMode?, confirmBypass?}`); `GET\|POST /api/verse/attachments/:id`, `POST …/:id/:attachmentId/delete`; `GET\|POST /api/verse/queue/:id`, `POST …/:id/:queueId/delete`, `POST …/:id/:queueId/send`; `GET /api/verse/files?sessionId=&q=` |
| terminal (C4, `verse/terminal-api.ts`) | `GET\|POST /api/verse/terminal`; `POST /api/verse/terminal/:id/{input,resize,kill}`; `GET /api/verse/terminal/:id/stream?after=<seq>` (SSE via `fetch` + the read-client header); `POST /api/verse/terminal/open-external` → 202 |
| preview (C4, `verse/preview-api.ts`) | `GET /api/verse/preview/targets?sessionId=`; `GET /api/verse/preview/raw?sessionId=&path=`; `GET /api/verse/preview/ticket?sessionId=&path=` → `{url, expiresAt}`; `GET /api/verse/preview/frame/<ticket>` |
| git (C5, `verse/git-api.ts`) | `GET /api/verse/git/status?root=`; `GET /api/verse/git/diff?root=&scope=working\|branch[&file=]`; `POST /api/verse/git/{commit,push,pr,pr/merge,worktree}` |
| apps (C6, `verse/apps-api.ts`) | `GET /api/verse/apps`; `POST /api/verse/apps/refresh`; `POST /api/verse/apps/:id/toggle {enabled, confirm:true}` → 202; `POST /api/verse/apps/:id/launch {root, via?, model?}` → 202 |

- **session-controls.** `permissionMode` is `plan`, `acceptEdits` (default), `auto` or `bypass`; `bypass` needs
  `confirmBypass: true` per chat and is never a default. The queue holds at most `VERSE_QUEUE_MAX` (3) turns per chat and
  sends only through the engine's `sendTurn` (readiness gate, local-only policy, the one spawn chokepoint) — so the only
  spend is still a turn. Attachments live in `~/.ashlr/verse/attachments/<sid>/` (0700 / 0600) and a turn is granted
  exactly that folder.
- **terminal.** The command typed into a shell is always built server-side (`appId` from the fixed catalog,
  `devServerId` from what Preview discovered for this chat), never taken from the request. A `root` must be one of the
  chat's roots or a discovered project and pass `checkWorkspaceRootPath` (never `/`, `~`, `~/.ashlr`). Output frames are
  raw base64 bytes and **skip the public-JSON scrubber** on purpose: scrubbing a byte stream would corrupt it, and it is
  the operator's own shell. Needs Bun (the desktop sidecar); under Node, `GET` reports `available: false` with the reason.
- **preview.** `frame/<ticket>` is the **one path `server.ts` lets past its read boundary**: an `<iframe src>` can carry
  neither the read-client header nor the query proof, so it answers only a live ticket presented with the cookie of the
  read session that minted it. Every file is served under CSP `sandbox` (an opaque origin), `nosniff`, framable by Verse
  alone, and only from inside the chat's own roots after symlinks are resolved. The page CSP adds
  `frame-src 'self' http://127.0.0.1:* http://localhost:*`. Read-only: dev-server Start goes through the terminal.
- **git.** `root` must be a folder the operator already brought into Verse and pass `checkWorkspaceRootPath`; a diff's
  `file` must be one of that scope's changed files. git/gh stderr never reaches a response. A commit is 409 while a chat
  turn runs in the same repository. `/api/verse/github` (the read-only V2 panel) is a different path, not this family.
- **apps.** Status commands and loopback GETs only. Toggle and Launch open a visible Terminal the operator drives; a
  model must be an installed Ollama tag. Accounts and MCP are composed on the page from `/api/verse/seats`,
  `/api/verse/health`, `/api/verse/budget` and `/api/verse/mcp`, so no fourth description of a seat exists.

### Autonomy families (Track B)

| Family (owner, module) | Routes |
|---|---|
| authority (B-U1, `verse/authority-api.ts`) | `GET /api/verse/authority` → `AuthorityStatusV1` (+ `effectiveReason`); `GET /api/verse/authority/draft[?kind=new\|reapprove]` → draft (+ `kind`, `summary`, `startStageId`); `GET /api/verse/authority/ledger[?limit=&kind=]`; `POST /api/verse/authority` with one of `{action:'switch', to}`, `{action:'stop'}`, `{action:'clear-stop'}`, `{action:'revoke', reason?}`, `{action:'grant', draftDigest}`, `{action:'re-approve', draftDigest}` |
| overnight (B-U5, `verse/overnight-api.ts`) | `GET /api/verse/overnight` → `OvernightStatus` (+ `daemon`, `pending`); `POST /api/verse/overnight` (`{action:'arm', stopRule}` \| `{action:'disarm'}`); `GET /api/verse/overnight/report` → `OvernightReportV1` |
| fleet-live (B-U5, `verse/fleet-live-api.ts`) | `GET /api/verse/fleet/live` → `FleetLiveSnapshotV1`; `POST /api/verse/fleet/live` (`{action:'pause-repo', repo, reason}` \| `{action:'resume-repo', repo, kind?}`) |
| leader (B-U8, `verse/leader-api.ts`) | `GET /api/verse/leader` → `LeaderStateV1`; `GET /api/verse/leader/memos/<id>`; `POST /api/verse/leader` with one of `{action:'run'}` (202), `{action:'veto', actionId, note?}`, `{action:'veto-memo', memoId, note?}`, `{action:'dismiss', itemId}` |
| learning (B-U9, `verse/learning-api.ts`) | `GET /api/verse/learning` → `LearningStateV1`; `POST /api/verse/learning/experiments {hypothesis}`; `POST /api/verse/learning/experiments/cancel {experimentId, reason?}`; `POST /api/verse/learning/adopt {versionId, experimentId}`; `POST /api/verse/learning/rollback {toVersionId\|null, reason?}` |

- **authority.** Lowering (switch down, stop, revoke) is instant and needs only the mutation token. Raising within the
  installed grant needs nothing more; raising past it is 409 `grant-required`, and only `grant` / `re-approve` widen
  authority — they ask the custody helper to show the scope in a Touch ID prompt on this Mac. The server signs exactly the
  draft the operator saw: drafts are kept server-side by digest and the action echoes `draftDigest`. Digests (64-hex
  values the server produced) are restored after sanitizing, because the secret scrubber would otherwise redact them.
  Full model: [`docs/STANDING-AUTHORITY.md`](STANDING-AUTHORITY.md).
- **overnight.** Arming never starts anything: a resident daemon adopts the armed record at its next iteration, and the
  run ends by pausing at its stop rule, never by the kill switch. Refusals are `{ ok: false, note }`, in order: kill
  switch engaged or unreadable, nothing enrolled, a run already armed or running, a stop rule that does not resolve (400).
  Halting a live run is `POST /api/verse/daemon` (a separate V2 route, on purpose).
- **fleet-live.** Read-only numbers from the authority ledger, the last standing tick, the runtime journal and the hold
  store, built off the request path (≤ 2 s old). POSTs act as `mason`: pause sets an `owner-hold`; resume clears one kind,
  or every active hold on the repo.
- **leader.** A veto only lowers what autonomy is doing, so it needs nothing more. `run` spends at most one Leader call on
  a seat the router allows; with no standing grant that is a free local model or nothing.
- **learning.** Adoption must clear the same gate the Leader does; the route only removes the veto window the operator
  would be waiting on. Cancel and rollback only lower. Refusals are 409 with the registry's reason.

### Cross-family producers

`needsYouItems(): NeedsYouItem[]` (type in `workbench-types.ts`) is exported by `authority-api.ts`, `fleet-live-api.ts`
and `leader-api.ts`; the activity route merges them with the approvals scan. Each is pure and cached. A producer that has
not produced its first answer **throws**, so activity reports that source as not answering instead of a false all-clear;
a producer that has not landed reports `unavailable`. Items carrying a different `source`, or an action route outside
`/api/`, are dropped. The desktop shell reads the activity response and depends on `running[].sessionId/title`,
`needsYou[].id/kind/subject.sessionId`, `completions[].sessionId/title/outcome/durationMs`, `counts.needsYou` and a
`cursor` matching `[A-Za-z0-9._-]`.

### CLI (3.10)

- `ashlr authority …` — `status`, `switch <off|propose|autonomous>`, `stop` / `clear-stop`, `revoke`, `draft`, `grant`,
  `re-approve`, `ledger verify|tail`, `surface`, `protect --print|--apply`, `github-app`, `rotate-provenance`, and
  `setup [--dry-run]` (guided one-time Phase 0). Lowering never asks; raising asks first or takes `--yes`.
- `ashlr leader …` and `ashlr mirror …` — the Leader and the fleet's mirrors (`~/.ashlr/fleet/mirrors/<owner>__<repo>`).
- `ashlr daemon start --until <HH:MM|ISO> | --iterations <n> | --until-paused`; `ashlr daemon doctor [--clear-stale] [--json]`;
  `daemon status --json` gains `runningVerified` and `liveness`.

### Private state added in 3.10

`~/.ashlr/authority/` (grant, clamp, hash-chained `ledger.jsonl`; denied to every sandboxed agent), `~/.ashlr/budget.json`,
`~/.ashlr/routing/{capacity.json,decisions.jsonl}`, `~/.ashlr/reasoning/{steps,features,state}/` (text 30 days, features
180 days), `~/.ashlr/verse/attachments/<sid>/`, `~/.ashlr/fleet/mirrors/`. Directories 0700, files 0600, and none of them
inside a repository.

## V3.11 additive contract — the cloud lane

3.11 adds one mounted module after `budget`: **cloud** (`cloud/cloud-api.ts`, wire shapes and constants in
`cloud/types.ts`). Same mount rules as the Track A modules above. Nothing here merges, and nothing touches GitHub
except the tracker's read-only `gh pr list`.

| Route | Body / query | Response |
|---|---|---|
| `GET /api/verse/cloud` | no query parameters | `CloudOverviewResponse` (seat, budget view, newest ≤ 100 tasks, backlog). Reads local state only; refreshes nothing. |
| `POST /api/verse/cloud/launch` | `CloudLaunchRequest { repo, prompt, baseBranch?, title?, origin? }` — `repo` is `owner/name`, `origin` is `chat` \| `operator` \| `cli` (default `operator`); body ≤ 128 KiB (the prompt may be 20 000 characters; the service truncates past that) | `CloudLaunchResponse`: 200 when launched; **409 with the same body** when refused (budget, seat) or when the launch failed (`failure` names why, `error` says it plainly) |
| `POST /api/verse/cloud/budget` | `CloudBudgetUpdate` (any subset; numbers ≥ 0, counts whole; the store clamps maxima) | `CloudBudgetView` |
| `POST /api/verse/cloud/refresh` | `{}` | `{ checked, updated }` — joins a scheduled refresh already running |
| `POST /api/verse/cloud/improve` | `CloudImproveRequest { count? }` (1–5, default 1) | `CloudImproveResponse` — the operator's button: the launch gate only, not the self-improvement gate |
| `POST /api/verse/cloud/tasks/<id>/dismiss` | `{}` | `{ ok: true, task }` — marks the local record `closed` with "Dismissed in Verse."; never touches GitHub. 404 unknown id, 409 for a merged task or one still launching |

- **Gates and input.** GET behind the read session; every POST 404 unless dispatch is allowed, then token + JSON
  `Content-Type`, then the body cap (4 KiB except launch). Unknown keys and query parameters are 400
  `VERSE_INVALID` with a plain sentence. A service error is a bare 500 `cloud request failed` — its text can quote a
  checkout path, so it is never forwarded.
- **Scheduler.** Starts when the module first loads (the Verse server's first activity poll imports it), never under a
  test runner; `ASHLR_CLOUD_AUTO=0` disables it. Every 10 min it refreshes tasks from GitHub; 2 min after start and
  then hourly it runs self-improvement (`runSelfImprove({ auto: true })`, which also needs the self-improvement switch
  and gate). Runs never overlap; a failure is logged once per distinct error.
- **Needs you.** `cloud-api.ts` exports `needsYouItems()` (pure, cached, rebuilt off the caller's stack) and
  `activity-api.ts` merges it. It adds no source or kind: a task whose PR is open is a `fleet` / `owner-lane-pr` item
  ("Cloud task ready for review: …", the report summary, target = the PR); a launch that failed in the last 24 h is a
  `chats` / `chat-failed` item with the plain reason, targeting Command. Both carry a Dismiss action (the route above).
- **CLI.** `ashlr cloud launch|list|refresh|improve|budget|backlog` (`src/cli/cloud.ts`) calls the same service
  in-process and never starts the scheduler. Output uses local times and no absolute paths; `--json` prints the wire
  shapes.
- **Private state.** `~/.ashlr/cloud/` (tasks, budget, backlog, launch checkouts); 0700 / 0600.

## Definition of done
- `npm run typecheck && npm run typecheck:web && npm run lint && npm run test:web && npx vitest run test/verse*.test.ts` green.
- Live: `ashlr verse --no-open --json` → open `/verse/` → new chat on a local seat → two turns with memory across turns → context meter moves → stop works.
- No secrets in any API payload or log line. Launcher commands never leave the server.
