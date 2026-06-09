# CONTRACT — M14: Surfaces II (local web dashboard)

A localhost-only web dashboard served by the hub. **ZERO new runtime deps**
(Node `http` builtin + a hand-built static SPA), **NO CDN** — every asset
(HTML/CSS/JS/fonts) is bundled in the repo and served locally. Read-only by
default; ephemeral (Ctrl-C stops it). Build against these signatures — each
agent edits ONLY its file(s). Preserve all existing behavior + the 1314 tests.

---

## Shared types (already in `src/core/types.ts` — DO NOT redefine)

```ts
export interface WebServerOptions {
  port: number;          // bound on 127.0.0.1 (CLI default e.g. 7777)
  open: boolean;         // open browser to URL after start
  allowDispatch: boolean;// expose token-guarded POST /api/run (default false)
}

export interface WebServerHandle {
  port: number;          // actual bound port
  token: string;         // per-session token; required header for POST /api/run
  url: string;           // e.g. http://127.0.0.1:7777
  close(): Promise<void>;// stop listeners + bounded SSE pollers cleanly
}
```

`AshlrConfig` is imported from `../types.js` (or `../../core/types.js` from
cli). Reuse — do not re-derive.

---

## Module signatures (EXACT)

### `src/core/web/server.ts`
```ts
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AshlrConfig, WebServerOptions, WebServerHandle } from '../types.js';

/**
 * Start the local web dashboard server. Binds 127.0.0.1 ONLY (never 0.0.0.0).
 * Generates a per-session token (crypto.randomBytes hex). Wires the request
 * pipeline in this order:
 *   1. Host-header allowlist check  -> 403 on mismatch (anti DNS-rebinding).
 *   2. handleApi(...)               -> if it returns true, request is handled.
 *   3. serveStatic(req, res, assetsDir()) for everything else -> 404 if false.
 * The dispatch route (POST /api/run) is registered ONLY when opts.allowDispatch
 * is true, and is token-guarded inside handleApi via ctx.token.
 * Resolves once listening; the handle's close() shuts down listeners + SSE.
 * NEVER throws on a bad request — responds with the appropriate status code.
 */
export async function startServer(
  cfg: AshlrConfig,
  opts: WebServerOptions,
): Promise<WebServerHandle>;

/**
 * Absolute path to the bundled static assets directory (the SPA: index.html,
 * app.js, styles.css, etc.). Resolved relative to this module so it works from
 * both src (tsx) and dist (built). serveStatic confines all serving here.
 */
export function assetsDir(): string;
```

### `src/core/web/api.ts`
```ts
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AshlrConfig } from '../types.js';

/**
 * Handle a single request if its URL matches an /api/* route.
 * @returns true if the request was an /api/* route and a response was written
 *          (so server.ts must NOT fall through to static); false otherwise.
 *
 * ctx.token        — the per-session token from the WebServerHandle.
 * ctx.allowDispatch— whether POST /api/run is permitted at all.
 *
 * Read-only routes (always available):
 *   GET /api/snapshot          -> buildSnapshot(cfg)                  (core/dashboard.ts)
 *   GET /api/runs              -> listRuns()                          (core/run/orchestrator.ts)
 *   GET /api/run/:id           -> loadRun(id) | 404                   (core/run/orchestrator.ts)
 *   GET /api/swarms            -> listSwarms()                        (core/swarm/store.ts)
 *   GET /api/swarm/:id         -> loadSwarm(id) | 404                 (core/swarm/store.ts)
 *   GET /api/pulse?window=7d   -> buildRollup(window, cfg)            (core/observability/rollup.ts)
 *                                 window in {'1d','7d','30d'}; default '7d'.
 *   GET /api/genome[?q=...]    -> q present: recall(q, cfg) hits;     (core/genome/recall.ts,
 *                                 else loadGenome(cfg) list           core/genome/store.ts)
 *   GET /api/events            -> Server-Sent Events stream (see below)
 *
 * Mutating route (ONLY when ctx.allowDispatch === true):
 *   POST /api/run              -> launch `ashlr run` (cmdRun/runGoal),
 *                                 bounded by the same budget caps as the CLI.
 *
 * SECURITY for POST /api/run:
 *   - 404 (route does not exist) when ctx.allowDispatch is false.
 *   - 401/403 when the request's token header does not equal ctx.token
 *     (constant-time compare). This defeats CSRF / drive-by POSTs.
 *   - Body is JSON { goal: string, budget?, parallel?, ... } validated and
 *     clamped to the local-first budget ceiling; NEVER allowCloud by default.
 *
 * SSE (GET /api/events):
 *   - Content-Type: text/event-stream; bounded poll interval (e.g. 1000–2000ms)
 *     re-reads the run/swarm record files and pushes deltas (snapshot/run/swarm
 *     updates) so the page live-streams burndown without reload.
 *   - The poll timer is cleared on client disconnect AND on server close()
 *     (server.ts tracks open SSE responses so close() ends them — no leak).
 *
 * METADATA ONLY — never write secret values. All read endpoints return JSON
 * with Content-Type: application/json. Never makes outward/SSRF calls.
 */
export async function handleApi(
  req: IncomingMessage,
  res: ServerResponse,
  cfg: AshlrConfig,
  ctx: { token: string; allowDispatch: boolean },
): Promise<boolean>;
```

### `src/core/web/static.ts`
```ts
import type { IncomingMessage, ServerResponse } from 'node:http';

/**
 * Serve a static asset from `dir` (the bundled assets dir). PATH-TRAVERSAL
 * SAFE: decode the URL path, join under `dir`, resolve to an absolute path,
 * and REJECT (404, return false) anything that escapes `dir` (`..`, absolute
 * paths, null bytes, symlink escape). "/" maps to index.html (SPA shell).
 * Sets a correct Content-Type per extension and a no-store/short cache header.
 * @returns true if a file was found & served; false if not found / rejected
 *          (server.ts then writes the 404). NEVER throws.
 */
export function serveStatic(
  req: IncomingMessage,
  res: ServerResponse,
  dir: string,
): boolean;
```

### `src/cli/serve.ts`
```ts
/**
 * `ashlr serve [--port N] [--open] [--allow-dispatch]`
 * Parse args, load config, call startServer(cfg, opts). Print the URL + (when
 * --allow-dispatch) the per-session token + the header name needed for POST
 * /api/run. With --open, open the default browser to handle.url. Keep the
 * process alive until Ctrl-C (SIGINT), then handle.close() and return 0.
 * Returns a process exit code (0 ok, non-zero on bind/arg error).
 *
 * Wire into src/cli/index.ts via the existing lazyCmd pattern (a `serve` case
 * dispatching to cmdServe) and add the command to cmdHelp's list.
 */
export async function cmdServe(args: string[]): Promise<number>;
```

---

## Route table

| Method | Route                     | Handler source (reuse)              | Auth                         |
|--------|---------------------------|-------------------------------------|------------------------------|
| GET    | `/api/snapshot`           | `buildSnapshot(cfg)`                | none (read-only, metadata)   |
| GET    | `/api/runs`               | `listRuns()`                        | none                         |
| GET    | `/api/run/:id`            | `loadRun(id)`                       | none                         |
| GET    | `/api/swarms`             | `listSwarms()`                      | none                         |
| GET    | `/api/swarm/:id`          | `loadSwarm(id)`                     | none                         |
| GET    | `/api/pulse?window=7d`    | `buildRollup(window, cfg)`          | none                         |
| GET    | `/api/genome[?q=...]`     | `recall(q, cfg)` / `loadGenome(cfg)`| none                         |
| GET    | `/api/events`             | SSE poller (bounded interval)       | none                         |
| POST   | `/api/run`                | `cmdRun` / `runGoal` (budget-capped)| **token header + --allow-dispatch** |
| GET    | `/*` (any non-/api path)  | `serveStatic(req,res,assetsDir())`  | none (path-traversal-safe)   |

`buildRollup` signature: `buildRollup(window: '1d'|'7d'|'30d', cfg, opts?)`.
`recall` signature: `recall(query: string, cfg, opts?): Promise<RecallHit[]>`.

---

## SECURITY RULES (top priority — a local server that can run agents is a real attack surface)

1. **127.0.0.1 ONLY.** `server.listen(port, '127.0.0.1')`. NEVER `0.0.0.0` /
   never externally reachable.
2. **Host-header allowlist (anti DNS-rebinding).** Reject (HTTP 403) any
   request whose `Host` header is not in the localhost allowlist
   (`127.0.0.1[:port]`, `localhost[:port]`, `[::1][:port]`). Enforced FIRST,
   before any route handling.
3. **Read-only by default.** The default server has NO mutating endpoints.
   POST `/api/run` is registered ONLY when `opts.allowDispatch` is true.
4. **Token-guarded dispatch (CSRF defense).** When dispatch is enabled, POST
   `/api/run` requires the per-session `token` (printed by `ashlr serve`) in a
   request header; compared constant-time. Missing/wrong token -> 401/403.
   The dispatch is bounded by the SAME budget caps as `ashlr run`
   (local-first; never `allowCloud` by default).
5. **Path-traversal-safe static serving.** Resolve every requested path WITHIN
   `assetsDir()`; reject `..`, absolute paths, null bytes, and symlink escapes
   (404). Only bundled assets are ever served.
6. **No secrets ever served.** snapshot/pulse are metadata-only; genome is the
   user's own notes. No secret VALUES cross the wire.
7. **No outward / SSRF calls** from the server. No external fonts/scripts/CDN —
   everything is served from the bundled assets dir.
8. **Ephemeral + clean shutdown.** Ctrl-C (SIGINT) stops the server; SSE poll
   is bounded; `close()` ends listeners AND all open SSE responses/timers (no
   leaks).
9. **ZERO new runtime deps.** Node `http`/`crypto`/`fs`/`path`/`url` builtins
   only.

---

## Reuse map (DO NOT re-derive)

- `core/dashboard.ts` — `buildSnapshot(cfg)`
- `core/run/orchestrator.ts` — `listRuns()`, `loadRun(id)`, `runGoal(...)`
- `core/swarm/store.ts` — `listSwarms()`, `loadSwarm(id)`
- `core/observability/rollup.ts` — `buildRollup(window, cfg, opts?)`
- `core/genome/store.ts` — `loadGenome(cfg)`, `genomeHealth(cfg)`
- `core/genome/recall.ts` — `recall(query, cfg, opts?)`
- `cli/run.ts` — `cmdRun(args)` (for the guarded dispatch path)
- `cli/ui.ts` — terminal color/format helpers for `cmdServe` output

GUARDRAILS: preserve all existing behavior + 1314 tests; reuse existing
modules; no new runtime deps; no git commit (main loop commits/pushes).
