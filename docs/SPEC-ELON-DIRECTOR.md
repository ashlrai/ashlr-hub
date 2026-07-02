# SPEC: Elon Director — Autonomous Strategic Reasoning Layer (M257+)

**Status:** Design — not yet implemented  
**Branch target:** `feat/v5-open-fleet` (after M250–M256 resource control plane + cache)  
**Author:** Architecture session 2026-06-29  
**Driver:** Give the Elon agent a brain. Today it reacts (digests, notifications,
dialogue). This spec makes it *direct* — a periodic strategic reasoning cycle that
reads the god-view, decides the highest-leverage next move, configures the fleet,
and communicates proactively — acting as Mason's chief-of-staff while the safety
gates remain fully intact.

---

## 1. The Problem Today

The Elon agent (`src/core/comms/`) is a **reactive comms layer**, not a director:

| What it does today | What's missing |
|---|---|
| Fires `notifyFleetEvent()` notifications (merge, anomaly, standup) | No periodic strategic reasoning |
| `handleStrategicMessage()` responds to Mason's free-form Telegram text | No autonomous decision-making between conversations |
| `buildDailyStandup()` aggregates 24h facts into a digest | No interpretation, no recommendations |
| `buildFleetSnapshot()` reads kill-switch + proposals | No resource-awareness, no prioritization logic |
| Handlers can create goals, pause fleet, adopt briefings | Only acts on explicit Mason commands |

The fleet has the **eyes** (god-view: ResourceMonitor, decisions-ledger, telemetry,
genome, goals store, ecosystem-index). The fleet has the **hands** (goal planner,
advance.ts, backend router, gateway). What it lacks is the **brain** that sits between
them — observing the state, reasoning first-principles, then *directing* rather than
just reporting.

---

## 2. Ground-Truth: What Each System Actually Has Today

### 2.1 Elon Agent (src/core/comms/)

**elon-dialogue.ts** — `handleStrategicMessage(text, cfg)`  
Called from `dispatch.ts` when Mason sends free-form Telegram text. Calls Opus with
ecosystem context → returns JSON `{ reply, action }`. Actions: `create_goal`,
`update_goal_priority`, `pause_fleet`, `resume_fleet`, `fleet_status`. Never touches
merge/push/destructive ops. Secret-scrubbed output. **Pure reactive.**

**events.ts** — `notifyFleetEvent(kind, payload, cfg)` + `buildDailyStandup(cfg)`  
Triggered by: `automerge-pass.ts` (merge events), `daemon/loop.ts` (anomaly events),
CLI scheduler (daily-standup, 22h cooldown). `buildDailyStandup()` reads: inbox store,
decisions-ledger, goals store, frontier-usage, genome store. Returns ~120-line
Telegram message. **Pure reporting — no interpretation, no recommendations.**

**dispatch.ts** — `runCommsCycle(cfg)` + `registerResolutionHandler(kind, fn)`  
Heartbeat: sends pending requests, polls inbound replies, routes to handlers.
Two-way: button taps, numeric replies, text commands (pause/resume/snapshot/revert),
free-form text → `handleStrategicMessage()`. Pause-gated. **Transport layer.**

**handlers.ts** — `registerCommsHandlers(cfg)`  
Wires resolution handlers for `elon-vision` (adopt briefing), `manager-approval`
(merge approve/reject), `decision-needed` (no-op record). **Handler wiring.**

**pause.ts** — `isPaused()` / `savePauseState()`  
`~/.ashlr/comms/pause.json`. Checked at cycle start in dispatch. **Simple flag.**

### 2.2 Strategist / Goals (src/core/goals/ + src/core/strategy/)

**goal-planner.ts** — `expandGoalToMilestones(goal, cfg, repoRoot)`  
M222: called by `scanGoals()` + conductor when `goal.milestones.length === 0`.
Prompts Opus with NORTH-STAR + IMPROVEMENT-BACKLOG context → decomposes into 3-6
shippable milestones. Flag-gated (`cfg.foundry.goalPlanning`). Cached per-tick.
Never throws. **Goal decomposition — but goals must already exist.**

**advance.ts** — `advanceGoal(goalId, cfg)` / `nextActionableMilestone(goal)`  
M28 safety contract: sandboxed + proposal-only, enrollment-scoped, budget-capped,
one milestone per call. `assertMayMutate()` hard-gates before any swarm.
**Goal execution — but sequencing is purely mechanical (next pending milestone).**

**store.ts** — `createGoal()`, `listGoals()`, `updateMilestoneStatus()`  
`~/.ashlr/goals/<id>.json`. Pure persistence, atomic writes. **No strategy.**

**invent.ts** — `inventWorkItems(input, config)`  
Opus-powered, grounded in NORTH-STAR + ECOSYSTEM-MAP. Invents bold net-new
capabilities. Filters maintenance items, deduplicates by 7-day TTL. **Creative
backlog generation — but no prioritization against real fleet state.**

**NORTH-STAR.md** — the grand vision document  
Three pillars: recursive self-improvement, ecosystem product factory, composition
flywheel. Human Mason: sets direction + approves highest-stakes least-reversible
calls. Fleet: conceives, builds, judges, ships, operates everything else. Measures:
products shipped+adopted, capabilities invented, compounding velocity, safety never
weakened.

### 2.3 God-View (being built, M250+)

**resource-monitor.ts** — `getResourceSnapshot(cfg)` → `ResourceSnapshot`  
Per-backend: `{ backend, availability, usedPct, cap, capUnit, resetsAt, costPerMTokenOut,
p50LatencyMs, reason, backoffUntilMs }`. Availability states: `open / near / throttled /
exhausted / unreachable / unknown`. 30s cached, never throws. Claude: reads
`~/.claude/stats-cache.json` (7d rolling sum). Codex: reads real subscription window.
Builtin/Ollama: `GET /api/ps`. **The headroom signal.**

**decisions-ledger.ts** — `recordDecision()` / `readDecisions()`  
`~/.ashlr/decisions/<YYYY-MM-DD>.jsonl`. Per-proposal lifecycle with M246 telemetry
fields: `costUsd, tokensIn, tokensOut, durationMs, cacheHit`. M47.1 HMAC attestation.
**The outcome record.**

**fleet/status.ts** — `buildFleetStatus()`  
Reads: daemon state, per-backend quota + recent dispatches, backlog queue size,
proposals pending/applied/frontier-pending, recent merge count, kill-switch. **The
operational snapshot.**

**fabric/gateway.ts** — `GatewayDecision`  
M250 resource-aware demotion: when claude is `throttled/exhausted`, gateway demotes
to next available backend (codex, kimi, local). `demotedFrom` field records it.
Hard items (effort≥4 or escalation) paused instead of demoted. **The routing
execution layer.**

**observability/rollup.ts** — `collectUsageEvents()`  
Aggregates sessions from `~/.claude/sessions/`, `~/.codex/sessions/`, replay.jsonl.
Per-project: `tokensIn/Out, estCostUsd`. Per-tier breakdowns from ledger `cacheHit`.
**The cost/efficiency signal.**

**genome/store** — accessed by `buildDailyStandup()` today  
Anti-playbook lessons (M235), skill counts (M243). 24h window from hub entries.
**The learning record.**

---

## 3. Architecture: The Elon Director Loop

### 3.1 Concept

The **Elon Director** is a periodic strategic-reasoning cycle that runs alongside
(not inside) the existing daemon loop. It reads the full god-view, reasons
first-principles about the highest-leverage next move, directs the fleet, and
communicates proactively to Mason. It is the brain that connects the eyes
(god-view) to the voice (Telegram comms) to the hands (goal planner + gateway).

```
┌─────────────────────────────────────────────────────────────────────┐
│                        ELON DIRECTOR LOOP                           │
│                     (runs every ~15 minutes)                        │
│                                                                     │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────────────┐  │
│  │  READ        │    │  REASON      │    │  DIRECT + COMM       │  │
│  │  god-view    │───▶│  Opus        │───▶│  fleet + Mason       │  │
│  │  snapshot    │    │  first-princ │    │  Telegram            │  │
│  └──────────────┘    └──────────────┘    └──────────────────────┘  │
│         │                    │                       │              │
│  ResourceSnapshot     DirectorDecision        DirectorAction        │
│  FleetStatus          (structured JSON)       (goal CRUD,           │
│  DecisionSummary                               gateway hint,        │
│  GoalProgress                                  Telegram msg)        │
│  NorthStarContext                                                    │
└─────────────────────────────────────────────────────────────────────┘
         ▲                                            │
         │                                            ▼
    [existing systems]                    [existing safety gates]
    resource-monitor.ts                   assertMayMutate()
    decisions-ledger.ts                   judge / scope-cap
    fleet/status.ts                       sandbox / kill-switch
    goals/store.ts                        enrollment
    genome/store                          never bypassed
    NORTH-STAR.md
```

### 3.2 The Director Context Object

The director reads a single unified `DirectorContext` before each reasoning pass.
This is assembled from the existing god-view systems — no new persistence required.

```typescript
// src/core/comms/director-context.ts (NEW)

export interface DirectorContext {
  // Resource headroom — from resource-monitor.ts
  resources: ResourceSnapshot;              // per-backend availability + usedPct

  // Fleet operational state — from fleet/status.ts
  fleet: FleetStatus;                       // daemon state, backlog, proposals

  // Recent outcomes — from decisions-ledger.ts (last 24h)
  outcomes: {
    mergedCount: number;
    rejectedCount: number;
    costUsdToday: number;
    cacheHitRate: number;                   // 0-1
    engineShipRates: Record<string, number>; // engine → ship%
    blockedGoals: string[];                 // goalIds with all-blocked milestones
  };

  // Goal state — from goals/store.ts
  goals: {
    active: GoalSummary[];                  // id, objective, fractionDone, nextMilestone
    planning: GoalSummary[];                // awaiting expansion
    blocked: GoalSummary[];                 // stuck milestones, no progress
    recentlyCompleted: GoalSummary[];       // done in last 48h
  };

  // North-star grounding — from NORTH-STAR.md (static, cached)
  northStar: {
    vision: string;
    pillars: string[];
    nearTermBets: string[];
  };

  // Self-improvement signal — from genome/store (last 7d)
  learning: {
    lessonsCount: number;
    recentLessonTitles: string[];
    skillCount: number;
  };

  // Fleet resource posture — derived
  resourcePosture: ResourcePosture;         // see §3.3
}

export type ResourcePosture =
  | 'full'         // all frontier backends open, use freely
  | 'preserve'     // claude near/throttled → route to codex+kimi+local
  | 'local-only'   // all frontier exhausted → builtin only
  | 'degraded';    // some backends unreachable
```

**Assembly:** `buildDirectorContext(cfg)` in `director-context.ts` — calls each
existing system, never throws, degrades gracefully when any source is unavailable.
Estimated assembly time: <500ms (all reads are local files or cached in-memory).

### 3.3 The Reasoning Pass

The director calls Opus with the full `DirectorContext` serialized as structured
JSON. The system prompt encodes:

1. **The Elon persona:** ambitious, first-principles, high-leverage, decisive.
   Not a reporter — a director. Asks "what is the single highest-leverage move
   right now?" not "what happened today?"

2. **NORTH-STAR grounding:** the three pillars + near-term bets are injected
   verbatim so reasoning is anchored to the grand vision, not local plumbing.

3. **Resource-aware allocation rules:** if claude is `near/throttled/exhausted`,
   reason about which work can run on codex/kimi/local (mid-tier effort≤3) vs.
   what must wait for claude headroom (effort≥4, escalation, architecture).

4. **Escalation criteria (NORTH-STAR §The human):** the model is instructed that
   it MUST escalate — ask Mason via `decision-needed` — before recommending any
   of: enrollment of a new repo, public release of an ecosystem product, spend
   above daily budget threshold, major architectural change to core fleet systems.

5. **Output schema:** structured JSON `DirectorDecision` (see below).

```typescript
// src/core/comms/director.ts (NEW)

export interface DirectorDecision {
  reasoning: string;             // 2-3 sentence first-principles rationale
  resourcePosture: ResourcePosture;
  resourceRationale: string;     // why this posture given current headroom

  // What to work on next
  topGoalId: string | null;      // existing goal to prioritize (or null)
  suggestedNewGoal: string | null; // new goal objective if gap detected (or null)

  // Fleet configuration hint
  backendHint: BackendHint | null; // recommendation to gateway (non-binding)

  // Communication to Mason
  telegramDigest: string;        // the proactive message to send (always)
  escalations: EscalationItem[]; // items requiring Mason's call (may be empty)

  // Confidence
  confidence: 'high' | 'medium' | 'low';
}

export interface BackendHint {
  preferBackends: EngineId[];    // ordered preference for next N dispatches
  avoidBackends: EngineId[];     // currently constrained
  rationale: string;
}

export interface EscalationItem {
  topic: string;                 // what decision Mason needs to make
  context: string;               // relevant facts
  options: string[];             // proposed options (2-3)
  stakes: 'high' | 'critical';  // high=reversible, critical=least-reversible
}
```

### 3.4 The Director Acts

After reasoning, the director takes actions through **existing interfaces only** —
it never bypasses safety gates, never touches repos directly, never auto-approves.

**Actions available to the director:**

| Action | Mechanism | Gate |
|---|---|---|
| Prioritize an existing goal | `updateGoalPriority(goalId, notes)` in store.ts | goals store, non-destructive |
| Create a new goal | `createGoal(objective, cfg)` in store.ts | enrollment gate in advance.ts |
| Suggest backend routing | `BackendHint` → advisory field in fleet config | gateway ignores if safety requires |
| Send Telegram digest | `sendTelegramMessage()` via comms integrations | Telegram rate-limit guard |
| Escalate to Mason | `postRequest('decision-needed', ...)` in requests.ts | handler registered in handlers.ts |
| Pause fleet (emergency) | `savePauseState({ paused: true })` in pause.ts | only on explicit anomaly signal |

**What the director explicitly cannot do:**

- Approve or apply proposals (only `handlers.ts` `manager-approval` + Mason can)
- Change sandbox/scope-cap/judge parameters
- Enroll a new repo (must escalate to Mason)
- Trigger a public release (must escalate to Mason)
- Override kill-switch
- Modify trust-tier gate logic (M47)
- Spend above the configured daily budget

### 3.5 The Director Communicates

Every director cycle produces a **Telegram digest** — proactive, not reactive.
The digest is designed as a chief-of-staff briefing: short, decisive, actionable.

**Digest anatomy:**

```
Fleet brief — Sun, 29 Jun  14:32

POSTURE: claude at 87% → routing to codex+kimi+local (preserving your headroom)

FOCUS: advancing "phantom team-vaults" (goal: phantom-team-vaults-m3/6 → 50%)
       next: implement vault sharing API — dispatching to codex now

OUTCOMES (24h): 14 merged, 2 rejected, $4.12 spent (↓18% vs yesterday)
                cache hit 62% — saving ~$1.80/day

LEARNING: 3 new lessons (avoid deep-copy in hot path ×2, prefer typed enums)

[escalation needed — see below]
```

**Escalation block** (only when `escalations.length > 0`):

```
NEEDS YOUR CALL:
→ binshield v0.3.0 ready to publish to npm
  Options: 1) publish now  2) hold for changelog review  3) skip this release
  Stakes: public release — least-reversible
  [Publish now] [Hold for review] [Skip]
```

**Non-escalation decisions** (director decided autonomously, logged):

```
DECIDED AUTONOMOUSLY:
→ deprioritized "update CI config" goal (low value, blocked, no milestones)
→ created goal: "phantom: vault-sharing REST API" (NORTH-STAR: product factory)
```

### 3.6 Director Loop Scheduling

The director loop runs as a **separate scheduled cycle** inside the daemon, not
inside `runCommsCycle()` (which is the transport heartbeat). Proposed cadence:

| Trigger | Cadence | Guard |
|---|---|---|
| Scheduled tick | Every 15 minutes | Only if daemon is running, fleet not paused |
| Post-wave signal | After each completed improvement wave | 5-minute cooldown (no double-fire) |
| Explicit command | `ashlr director run` CLI | No guard (manual override) |
| Mason's Telegram text | `handleStrategicMessage()` already handles this | No change to existing path |

The existing `buildDailyStandup()` (M244) becomes the **morning edition** of the
director digest — same channel, richer reasoning context, same cooldown guard.

---

## 4. Safety and Escalation Model

### 4.1 Invariants (Never Weakened)

These invariants are enforced by existing code and the director does not bypass them:

1. **Sandbox + proposal-only:** `advanceGoal()` always runs with `{sandbox:true,
   requireSandbox:true, propose:true}`. Director cannot change this.
2. **Enrollment gate:** `assertMayMutate(repo)` in advance.ts. Director cannot
   enroll — it must escalate.
3. **Judge gate:** every proposal passes the judge before merge. Director cannot
   skip or influence judge verdicts.
4. **Scope-cap:** scope guard in proposals. Director has no mechanism to touch this.
5. **Kill-switch:** `isPaused()` in dispatch.ts. Director respects it; can set it
   (emergency pause) but cannot unset without Mason's explicit `resume` command.
6. **Trust-tier gate (M47):** merge-to-main requires frontier + green. Director
   has no mechanism to grant tier or bypass gate.
7. **Daily budget cascade:** gateway `recoverWithinBudget`. Director's `BackendHint`
   is advisory only; gateway ignores it when budget is exceeded.

### 4.2 Escalation Gate

The director **must escalate** (post a `decision-needed` request, block on Mason's
reply) before taking or recommending any of:

| Category | Examples | Stakes |
|---|---|---|
| **Enrollment** | enrolling a new ecosystem repo | critical |
| **Public release** | npm publish, GitHub release, tag | critical |
| **Major spend** | cost trajectory > 2× daily budget | high |
| **Architecture** | changing judge parameters, trust-tier logic, sandbox rules | critical |
| **External comms** | posting to social media, emailing users | critical |
| **Irreversible ops** | deleting goals, archiving proposals, dropping data | high |

All other decisions — goal prioritization, backend routing hints, new goal creation,
fleet pause/resume, digest content — are within the director's autonomous authority.

### 4.3 Resource Allocation: Scope

Resource allocation changes only **which backend** handles a work item, never
**whether** a work item is gated. A throttled claude backend → work routes to codex.
The judge, scope-cap, and sandbox still run regardless of backend. The director's
`BackendHint` is an advisory to the gateway's resource-aware demotion logic
(already in `gateway.ts` M250) — not a new mechanism.

---

## 5. Integration Points

All integration is with existing code — no new external dependencies.

### 5.1 Reads (director reads these, does not own them)

| Source | Symbol | File |
|---|---|---|
| Resource headroom | `getResourceSnapshot(cfg)` | `src/core/fabric/resource-monitor.ts` |
| Fleet operational state | `buildFleetStatus()` | `src/core/fleet/status.ts` |
| Recent decisions | `readDecisions({ sinceMs, limit })` | `src/core/fleet/decisions-ledger.ts` |
| Goal list | `listGoals()` | `src/core/goals/store.ts` |
| Goal progress | `progressOf(goal)` | `src/core/goals/advance.ts` |
| Genome lessons | genome store | `src/core/genome/store.ts` (via `buildDailyStandup` pattern) |
| North-star context | `northStarDocSummary()` | `src/core/strategy/goal-planner.ts` (already exists) |

### 5.2 Writes (director writes through these)

| Action | Symbol | File |
|---|---|---|
| Create goal | `createGoal(objective, cfg)` | `src/core/goals/store.ts` |
| Update goal priority | `updateMilestoneStatus()` / goal notes | `src/core/goals/store.ts` |
| Post escalation request | `postRequest('decision-needed', ...)` | `src/core/comms/requests.ts` |
| Send Telegram digest | `sendTelegramMessage()` | `src/core/integrations/telegram.ts` |
| Set fleet pause | `savePauseState({ paused: true })` | `src/core/comms/pause.ts` |
| Record director decision | append to decisions-ledger (new action type `'directed'`) | `src/core/fleet/decisions-ledger.ts` |

### 5.3 New Files Required

| File | Role |
|---|---|
| `src/core/comms/director-context.ts` | `buildDirectorContext(cfg)` — assembles god-view snapshot |
| `src/core/comms/director.ts` | `runDirectorCycle(cfg)` — reasoning pass + action dispatch |
| `src/core/comms/director-prompt.ts` | System/user prompt builders (Elon persona + NORTH-STAR) |
| `src/cli/director.ts` | `ashlr director run` CLI command |

### 5.4 Modified Files

| File | Change |
|---|---|
| `src/core/comms/events.ts` | `buildDailyStandup()` → delegate to director-context + director-prompt for richer digest (backward-compatible) |
| `src/core/daemon/loop.ts` | Schedule `runDirectorCycle()` every 15 min (alongside existing fleet loop) |
| `src/core/fleet/decisions-ledger.ts` | Add `action: 'directed'` type to `DecisionEntry` for director audit trail |
| `src/cli/index.ts` | Register `director` command loader |

---

## 6. The "Elon" Persona

The system prompt for the reasoning pass encodes a specific decision-making style:

**First-principles:** Does not extrapolate from yesterday's pattern. Asks: "Given
the fleet's actual resources and the north-star, what is the single highest-leverage
move?" Willing to contradict prior decisions if the context has changed.

**Ambitious:** Anchors recommendations to NORTH-STAR pillar 2 (product factory) and
pillar 3 (flywheel). Prefers ecosystem product milestones over internal plumbing when
resources are available. Does not propose documentation or cleanup unless genuinely
blocking.

**Decisive:** Returns one clear top recommendation, not a ranked list of five options.
Escalates to Mason only when a decision is genuinely irreversible — does not escalate
for decisions within its authority.

**Resource-honest:** States the current resource posture plainly ("claude at 87% →
preserving your headroom") and explains how that changes the recommendation ("codex
handles medium-effort ecosystem work, saves claude for architecture review").

**Brief:** The Telegram digest is capped at 15 lines. Reasoning is shown only in the
audit trail, not the digest. Mason's time is a scarce resource.

---

## 7. MVP: Smallest Slice (M257)

The minimum valuable version of the director that demonstrates the concept without
building the full loop.

### M257 — Director Digest (read + reason + communicate)

**Goal:** On a 15-minute schedule, the daemon assembles the god-view snapshot,
calls Opus with the director prompt, and sends a proactive Telegram digest with:
1. Current resource posture (headline)
2. One recommended next move (top goal or new goal suggestion)
3. Costs/outcomes (last 24h, single line)
4. Escalations if any (blocks on Mason's reply)

**Scope:** READ only — no goal mutations yet. The director observes and reports.
Replaces `buildDailyStandup()` as the primary proactive communication.

**Files:**
- CREATE `src/core/comms/director-context.ts` — `buildDirectorContext(cfg)`
- CREATE `src/core/comms/director.ts` — `runDirectorCycle(cfg)` (read + reason + message)
- CREATE `src/core/comms/director-prompt.ts` — prompt builders
- MODIFY `src/core/daemon/loop.ts` — schedule `runDirectorCycle()` every 15 min
- MODIFY `src/core/comms/events.ts` — `buildDailyStandup()` calls `buildDirectorContext()` for richer facts

**Verification:** run `ashlr director run` manually; observe Telegram message with
correct posture label and a concrete recommended next move grounded in north-star.

**Not in M257:** goal creation/mutation by director, backend hint integration, audit
trail entry, CLI `ashlr director status`.

### M258 — Director Acts (goal direction)

After M257 proves the reasoning quality, enable goal mutations:
- Director can `createGoal()` when it identifies a gap against NORTH-STAR
- Director can update goal priority/notes
- All goal mutations logged as `action:'directed'` in decisions-ledger

**Gate:** M257 must demonstrate high-confidence reasoning (≥3 consecutive digests
where Mason does not override the recommendation).

### M259 — Backend Hint Integration

Director's `BackendHint` is fed to the gateway as a per-cycle advisory:
- `cfg.foundry.fabric.backendHint` field (ephemeral, not persisted)
- Gateway's resource-aware demotion step (M250/M252) reads hint as tiebreaker
- Director records why it preferred each backend in the audit trail

**Gate:** M258 shipped. Resource-aware demotion (M250) shipped.

### M260 — Director Dashboard Panel

Add a "Director" section to Mission Control (web dashboard):
- Current posture badge (full / preserve / local-only / degraded)
- Last reasoning (timestamp + 2-sentence rationale)
- Top goal with progress bar
- Last 5 autonomous decisions (action + rationale)
- Escalation queue (pending + resolved)

**Gate:** M259 shipped.

### M261 — Director Memory (inter-cycle continuity)

Director reads its own recent decisions from the `'directed'` ledger entries to
avoid recommending the same move it made last cycle. Enables multi-cycle reasoning
chains ("I directed X last cycle → X is now in-progress → next highest-leverage is Y").

**Gate:** M260 shipped (dashboard validates continuity is visible).

---

## 8. The Demonstrable Thing: Best Open-Source Project of All Time

The director loop, once M257–M261 ship, makes the following demonstrable:

> A local autonomous engineering org that sees its own resources in real time,
> reasons first-principles about the highest-leverage next move, routes all work
> optimally across three AI backends (claude / codex / kimi / local), runs a
> 21-repo product factory, and reports to its human like a chief-of-staff — all
> while every safety gate (sandbox, judge, scope-cap, enrollment, kill-switch)
> remains intact and all irreversible decisions escalate to Mason via Telegram.

**The concrete demo sequence (post M261):**

1. `ashlr director run` — prints current director context snapshot
2. Telegram receives: "claude at 91% → routing to codex+kimi. Focus: phantom
   team-vaults API (goal 3/6 → 50%). $3.80 today (↓22%). NEEDS YOUR CALL: binshield
   v0.3.0 ready to publish."
3. Mason taps "Publish now" — handler in `handlers.ts` fires, records resolution
4. Fleet advances `phantom` milestone on codex while claude headroom is preserved
5. 15 minutes later, digest shows milestone proposed, pending judge review
6. No human wrote a task, no human picked a backend, no human scheduled a cycle

This is not a demo of AI writing code (every coding tool does that). This is a
demo of AI *running an engineering organization* — resource-aware, north-star-
grounded, human-in-the-loop on exactly the decisions that matter.

---

## 9. Milestone Sequencing (M257–M261 in context)

```
M250 Resource Monitor (resource-monitor.ts) ─────────────────────┐
M251 Config schema (claudeResource, protectPct, resourceAware)    │
M252 Gateway resource-aware demotion (demotedFrom)                │
M253 ashlr resources CLI                                          │
M254 Mission Control resource panel                               │
M255 Concurrent dispatcher (resource snapshot consumed) ──────────┤
M256 (any pending between M255 and director)                      │
                                                                   ▼
M257 Director Digest (read+reason+communicate) ◄──────── DEPENDS: M250 (senseResources)
M258 Director Acts (goal direction)            ◄──────── DEPENDS: M257 stable
M259 Backend Hint Integration                  ◄──────── DEPENDS: M258 + M252 (gateway demotion)
M260 Director Dashboard Panel                  ◄──────── DEPENDS: M259 + M254 (resource panel)
M261 Director Memory (inter-cycle continuity)  ◄──────── DEPENDS: M260 (ledger entries visible)
```

**Critical path:** M250 → M257. Everything else builds on these two.  
**Independent parallel track:** M253–M254 (CLI + dashboard) can ship alongside M257.

---

## 10. Open Questions (Decide Before M257 Scaffold)

1. **Director frequency:** 15 minutes is proposed. Should it be configurable
   (`cfg.foundry.director.intervalMinutes`)? What's the minimum that feels "live"
   without spamming Mason?

2. **Digest channel:** Director sends to Telegram by default. Should there be an
   option for iMessage (existing `sendIMessage()` in dispatch.ts)?

3. **Daily standup migration:** Does `buildDailyStandup()` (M244) become a special
   case of the director digest (morning edition, 22h cooldown), or do both run
   independently? Recommend: director digest replaces standup — one channel, richer.

4. **Goal creation gate:** In M258, when the director creates a goal, should it
   send a Telegram notification and wait for acknowledgment, or act immediately?
   Recommend: act immediately (goal creation is reversible) + include in next digest.

5. **Escalation timeout:** If Mason doesn't respond to an escalation within N hours,
   what does the director do? Recommend: hold the blocked action, re-surface in next
   digest, never auto-resolve a critical escalation.

---

## 11. Non-Goals

- The director does not write code directly (hands are `advance.ts` + swarms)
- The director does not browse the web or external APIs (god-view is local)
- The director does not manage CI/CD pipelines (escalated to Mason)
- The director does not communicate to any channel except Telegram (and optionally iMessage)
- The director does not replace the existing `handleStrategicMessage()` path — that remains Mason's free-form override channel

---

*Generated 2026-06-29. Do not commit — Mason commits.*
