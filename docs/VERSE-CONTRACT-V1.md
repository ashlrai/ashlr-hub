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
- Models per engine: claude → `[claude-opus-5, claude-sonnet-5, claude-haiku-4-5-20251001]` (window 200k, 1m variant not listed);
  codex → `[gpt-5.5, gpt-5.5-mini]` (272k); grok → `[grok-4, grok-4-fast]` (256k). Keep the lists in one const so they are easy to edit.
- Local seats: `GET <ollama>/api/tags` (base from `cfg.models.ollama` or `http://127.0.0.1:11434`, 2s timeout). One seat per tag whose
  name matches `/coder|code|qwen|deepseek|devstral|llama/i` (others hidden), `id=local:<tag>`, `engine=local`, `accountId=local`,
  contextWindow from `/api/show` `model_info["<arch>.context_length"]` when available, else the `:ctxNNk` suffix if present, else 65536.
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
  Parse: `stream_event` with `content_block_delta.text_delta` → `text-delta`; `assistant` message content blocks → `assistant-message`
  (text) / `tool-use`; `user` message `tool_result` blocks → `tool-result`; `result` → `usage` (input_tokens + cache_read + cache_creation
  = contextTokens) and `ok = subtype==='success'`. Ignore `system` except `init` (log model).
- **codex**: first turn argv = `[...launcher, 'exec', '--json', '--model', model, '--cd', cwd, '--sandbox', 'workspace-write', '-']`
  with prompt on stdin; later turns `[...launcher, 'exec', 'resume', nativeSessionId, '--json', '-']` + stdin.
  Parse codex JSONL (see `src/core/run/engines.ts` normaliseEngineOutputLine and `src/core/resources/worker.ts` parseCodex for the shapes):
  `thread.started.thread_id` → captured nativeSessionId (emit via `turn-done.nativeSessionId`); `item.started/completed` with
  `agent_message` → `assistant-message`; `command_execution`/`file_change`/`mcp_tool_call` items → `tool-use` + `tool-result`;
  `turn.completed.usage` → `usage`.
- **grok**: argv = `[...launcher, '-p', text, '--output-format', 'streaming-messages-json', '--include-partial-messages',
  '--cwd', cwd, '--model', model, '--permission-mode', 'acceptEdits']` + (`['--resume', id]` after first turn else `['--session-id', id]`).
  Parse Anthropic Messages wire format lines (same block/delta shapes as claude stream-json without the outer `stream_event` wrapper —
  handle both). Usage from `message_delta.usage` / `message_start.message.usage`.

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
Errors: `{ error, code? }` via `sendJson`. Codes: `VERSE_SESSION_NOT_FOUND` 404, `VERSE_SESSION_BUSY` 409, `VERSE_INVALID` 400, `VERSE_TOO_LARGE` 413.
Also add `verse` to the `/api/events` `emitUpdate` poll: emit `verse-sessions` (list digest) when it changes, so the sidebar refreshes.

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
   **Context meter**: `contextTokens / contextWindow` as a slim bar under the header with % and "123k / 200k"; amber ≥70%, red ≥90%; unknown window → "n/a".
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

## Definition of done
- `npm run typecheck && npm run typecheck:web && npm run lint && npm run test:web && npx vitest run test/verse*.test.ts` green.
- Live: `ashlr verse --no-open --json` → open `/verse/` → new chat on a local seat → two turns with memory across turns → context meter moves → stop works.
- No secrets in any API payload or log line. Launcher commands never leave the server.
