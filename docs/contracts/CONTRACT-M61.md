# CONTRACT-M61 — Mission Control (the live control-room dashboard)

**Pillar:** A great user-facing dashboard for agentic engineers — one live glance
at the whole local engineering surface: local models + what's running + health +
logs + activity + per-provider (Claude/Codex/local) usage & limits + the fleet.
Local-first, in `ashlr serve`; the team/cofounder aggregate stays in ashlr-pulse.

**Mason's hard rule:** read-only + local-first. The control view adds NO mutation
path (no apply/dispatch); it's the same no-auth read class as `/api/fleet` and
`/api/pulse`. Never fabricate numbers — cloud subscription limits we can't read
are shown HONESTLY as "not connected", not invented. localhost-only, zero new
deps, vanilla-JS SPA (no framework/CDN).

---

## 1. Backend (`src/core/web/control.ts` + `api.ts`)

- `buildControlSnapshot(cfg): Promise<ControlSnapshot>` — aggregates, reusing the
  existing builders, NEVER throws (each section degrades to safe/empty):
  - `models` ← `getProviderRegistry` (local Ollama/LM Studio health + model lists)
  - `fleet` ← `buildFleetStatus` (verbatim)
  - `daemon` ← `loadDaemonState`
  - `usage` ← `buildRollup('7d')` (+ forecast local-savings), per-provider shares
  - `limits` ← `cfg.foundry.limits` × quota `usesInWindow`/`evalQuota` (LOCAL rate
    windows; `[]` when none). `subscriptionLimits: { connected:false, note }` —
    honest stub; cloud account limits are not wired (future work).
  - `logs` ← daemon `ticks[]` → most-recent-first feed (cap 50).
- Routes (GET, no-auth read class): `/api/control` (full), `/api/models`
  (models section, live probe), `/api/logs?tail=N` (logs).

## 2. Frontend (`src/core/web/public/{app.js,styles.css}`)

- New `control` view ("Mission Control"), FIRST nav item. `renderControl()` fetches
  `/api/control`, polls every 4s while active (interval cleared on navigate-away),
  refreshes on SSE `daemon`/`snapshot`. Panels: Fleet pulse (hero) · Local models
  (health dots + model chips) · Backends & limits (quota pills + used/max bars) ·
  Usage 7d (per-provider bar) · Activity log. Dark terminal aesthetic reusing the
  existing styles.css palette; live pulse on the running dot. Defensive: any empty
  section renders a graceful placeholder, never throws.

## HARD RULES + verification (`test/m61.*`)

1. **Read-only** — `/api/control|models|logs` are GET, no-auth, no mutation; no
   apply/dispatch primitive. → `m61.control` + the existing web-route auth class.
2. **Never throws / honest gaps** — `buildControlSnapshot` returns the full shape
   under a minimal cfg (no daemon/quota/providers); `subscriptionLimits.connected
   === false`; no fabricated limit numbers. → `m61.control`.
3. **Contract stable** — the ControlSnapshot keys match what the view consumes. →
   `m61.control` shape assertions.
4. **Flag-off / parity** — adds only new routes + a new view; no existing route or
   view changes. → full suite + manual `ashlr serve` smoke.

## Deliverables checklist

- [ ] `src/core/web/control.ts` (`buildControlSnapshot`) + `api.ts` routes.
- [ ] `app.js` `#control` view + `styles.css` panels.
- [ ] Tests: `m61.control`. Manual: `ashlr serve` → open `#control`, screenshot.

## Non-goals (this milestone)

Cloud subscription-limit ingestion (Anthropic/OpenAI billing APIs) · Codex usage
capture · the team/cofounder aggregate (ashlr-pulse) · any control/mutation action
from the dashboard. The hub→pulse OTLP bridge is a separate follow-on.
