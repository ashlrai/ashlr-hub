# ashlr Command Center — Panel & Data Contract

The single pane of glass for the autonomous fleet. Built in **ashlr-pulse** (the
`pulse-map-world-model` session owns the UI); **ashlr-hub** produces the data via
the endpoints below. Goal: **beautiful, real-time, dense, and readable by agents
as well as humans.**

## Design principles
- **Dark, dense, real-time.** Cockpit aesthetic. Streams (SSE) for live state; no manual refresh.
- **One glance = "is the fleet healthy + productive?"** — surface quality/impact, not just activity.
- **Agent-readable.** Every panel's data is also available via API + MCP tools, so the Manager/Elon/coding agents query the same state machines render.
- **Action is reversible + gated.** Anything that mutates (triage, assign-goal) is human-approved; advisories are non-actionable.

## Panels

| Panel | Purpose | Data source (ashlr-hub) |
|---|---|---|
| **Live Fleet** | What's running *right now* — active engine runs (repo · model · task), tick cadence, local-vs-cloud concurrency slots in use, today's spend/budget | `GET /api/fleet-state` (.daemon, .ticks) + SSE run events; MCP `ashlr_fleet_status` |
| **Routing** | Which models handle what — opus/sonnet/haiku · codex:gpt-5.5 · local · NIM split, quota-window burn, and the *reason* each task routed where (e.g. "hard coding → codex:gpt-5.5"; "claude window 92% → local") | `GET /api/fleet-state` (.routing); MCP `ashlr_routing` |
| **Scorecard** | Productivity · quality · impact, trended: accept/reject/verify-pass rates, trivial-ratio, per-engine quality | `POST /api/oversight` ingest (fleet_scorecard) + MCP `ashlr_scorecard` |
| **Map** | The repo ecosystem as a live graph with health/activity | `/map` (already built) + repo health |
| **Alerts + Triage** | Degrading-quality warnings (worst-first) + the CEO agent's reversible cleanup (human-approved); critical advisories rendered non-actionable | AlertsPanel/TriagePanel (already built) + the fleet_command queue round-trip |
| **Vision** | The end-state spec · progress-to-vision · the latest Elon briefing (current state, gap, recommendations, questions for you) | OversightSnapshot.vision + MCP `ashlr_oversight` |
| **Inbox / Review** | Human-gated proposals (the ones the Manager escalated) — approve/reject | the fleet_command queue → daemon applies locally |

## Data contract (ashlr-hub → pulse)

1. **`GET /api/fleet-state`** (NEW, read-only, host+token gated) — the live combined snapshot:
   ```jsonc
   {
     "daemon":   { "running": true, "lastTickAt": "...", "todaySpentUsd": 0, "itemsProcessed": 1681, "pending": 92, "ticks": [...] },
     "scorecard": { /* QualityMetrics: acceptRate, trivialRatio, verifyPassRate, byEngine, trend */ },
     "oversight": { /* OversightSnapshot: scorecard + manager{shipped,review,noise,recs} + vision{northStar,progressPct} + goals */ },
     "routing":  [ { "task": "...", "engine": "codex", "model": "gpt-5.5", "reason": "hard coding (effort 5)" }, ... ]
   }
   ```
2. **`POST /api/oversight`** (pulse ingest, already built) — the daemon pushes `OversightSnapshot` on a cadence → `fleet_scorecard` (trended).
3. **OTLP spans** (`POST /api/otlp/v1/traces`) — fleet lifecycle events (tick/proposal/merge/decline) with `ashlr.fleet.owner` attribution + (extend) routing model attrs.
4. **fleet_command queue** (cloud→local round-trip, already built) — the cockpit's triage actions land here; the daemon polls + executes locally (proposal-only-safe).

## Agent surface (MCP — same data, for agents)
`ashlr_fleet_status` · `ashlr_scorecard` · `ashlr_oversight` · `ashlr_routing` — read-only native tools (kill-switch-exempt, secret-scrubbed). Any agent (Manager, Elon, a coding agent) calls these to reason about the live fleet. The command center and the agents read the *same* nervous system.

## Wiring (config only)
Point the daemon at pulse: `cfg.pulse.endpoint = https://pulse.ashlr.ai` + `ASHLR_PULSE_PAT=<fleet PAT>`. Then `exportOversight` + the pulse-sync round-trip flow the live fleet in. No code change.

## Division of labor
- **ashlr-pulse** (`pulse-map-world-model` session): owns the UI — panels, charts, the SEE→GRADE→ALERT→ACT cockpit, `/map`, the reactive streams. Canonical.
- **ashlr-hub** (this session): produces the data — `/api/fleet-state`, the oversight export, the MCP tools, the routing decisions. Drop the redundant `/api/oversight` + `management.tsx` duplicate; the cockpit wins.
