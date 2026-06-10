# CONTRACT-M29 — Portfolio Dashboard + Digest (`ashlr digest`)

Ashlr v2 **pillar G** (surfacing). An **ORG-LEVEL portfolio view** — health,
in-flight goals/work, costs, and a "today" summary — that aggregates everything
v2 built (M22 backlog, M23 inbox, M24 daemon, M25 knowledge, M26 reflect, M27
health, M28 goals) on top of the existing **M13 `DashboardSnapshot`**, surfaced
in the **M13/M14 TUI + local web dashboard**, PLUS a local **DAILY DIGEST**
(`ashlr digest`) written to `~/.ashlr/digests/` with **OPT-IN** notify.

> **Framing.** M29 is a **READ-ONLY AGGREGATION + a LOCAL DIGEST** surfacing
> layer. It introduces **NO new outward authority** and **NO new path scan**. It
> READS already-local state and WRITES only the digest artifact under
> `~/.ashlr/digests/`. The **ONLY** outward path is `notify()` behind an
> explicit, opt-in `--notify` flag — anything outward stops at the human.

New core code extends `src/core/dashboard.ts` + adds `src/core/digest/*`; CLI in
`src/cli/digest.ts`; TUI/web surfaces extended. Shared types are appended
(single-sourced) to `src/core/types.ts`. **No new runtime deps.**

---

## How the portfolio view extends `DashboardSnapshot`

We add an **OPTIONAL** `portfolio?` field to `DashboardSnapshot` (NOT a new
embedding type) so **every existing `buildSnapshot` producer + test stays
valid** — absent ⇒ no portfolio section was populated. `buildSnapshot` populates
it best-effort; each sub-source is wrapped so a missing/failed source degrades to
its empty/zeroed default, and the enrollment-scoped sections (health, goals) stay
empty on an empty enrollment with **NO disk scan**.

### Exact TS shape (in `src/core/types.ts`)

```ts
// Added to DashboardSnapshot:
portfolio?: PortfolioSummary;

export interface PortfolioSummary {
  health: PortfolioHealthSummary;          // M27 — ENROLLMENT-SCOPED
  goalsInFlight: PortfolioGoalInFlight[];  // M28 — bounded cap
  backlogTop: PortfolioBacklogItem[];      // M22 — bounded cap
  cost: PortfolioCost;                     // M19 rollup + forecast
  effectiveness: PortfolioEffectiveness | null; // M26 reflect
  today: PortfolioTodayDelta;              // day-over-day vs prev digest
}

export interface PortfolioHealthSummary {
  reposScored: number;
  averageScore: number;                    // 0..100
  averageGrade: HealthGrade;               // 'A'|'B'|'C'|'D'|'F'
  worstRepos: { repo: string; score: number; grade: HealthGrade }[];
}

export interface PortfolioGoalInFlight {
  goalId: string;
  objective: string;
  status: GoalStatus;
  fractionDone: number;                    // 0..1
  proposed: number;
  totalMilestones: number;
  nextActionable: string | null;           // next actionable milestone title
}

export interface PortfolioBacklogItem {
  title: string;
  repo: string | null;
  score: number;
}

export interface PortfolioCost {
  window: string;                          // '7d' | '30d'
  spentUsd: number;
  localSavingsUsd: number;
  projectedMonthlyUsd: number;
}

export interface PortfolioEffectiveness {
  successRate: number;                     // 0..1
  effectivenessDeltaPct: number | null;
  headline: string;
}

export interface PortfolioTodayDelta {
  previousAt: string | null;
  pendingProposalsDelta: number | null;
  dirtyReposDelta: number | null;
  spendUsdDelta: number | null;
  healthScoreDelta: number | null;
  goalsInFlightDelta: number | null;
}
```

### Digest shape (in `src/core/types.ts`)

```ts
export type DigestWindow = '7d' | '30d';

export interface DigestOptions {
  window?: DigestWindow;                   // default '7d'
  allowCloud?: boolean;                    // default false — local-only narrative
}

export interface DigestReport {
  generatedAt: string;                     // ISO
  date: string;                            // YYYY-MM-DD
  window: DigestWindow;
  portfolio: PortfolioSummary;             // the org view backing the digest
  repos: { total: number; dirty: number; stale: number };
  pendingProposals: number;                // M23
  daemon: { running: boolean; todaySpentUsd: number } | null; // M24
  headline: string;                        // deterministic, always present
  narrative?: string;                      // OPTIONAL local-LLM; absent by default
  narrativeLocal?: boolean;                // true when produced by a LOCAL model
}

export interface DigestDeliveryResult {
  jsonPath: string | null;                 // artifact written (ALWAYS attempted)
  markdownPath: string | null;
  notified: boolean;                       // TRUE only when --notify delivered
}
```

---

## Module boundaries

### `src/core/dashboard.ts` — populate `portfolio` (EXTEND)
`buildSnapshot(cfg)` gains a portfolio-building block that runs **after** the
existing sections and sets `snapshot.portfolio`. Each sub-source is wrapped in
its own `try/catch` and degrades to an empty/zeroed default (the existing
buildSnapshot model). The enrollment-scoped sources stay empty on empty
enrollment — **no new disk scan is introduced**.

- **health** ← `computeReport()` (M27) — already `listEnrolled()`-scoped; default
  empty ⇒ `reposScored:0`, no scan. Map to `PortfolioHealthSummary` (avg/grade +
  worst-N repos, bounded).
- **goalsInFlight** ← `listGoals({ status:'active' })` + `progressOf(goal)` +
  `nextActionableMilestone(goal)` (M28), bounded to a small cap.
- **backlogTop** ← `loadBacklog()` (M22) top scored items, bounded.
- **cost** ← `buildRollup(window, cfg)` (spend) + `buildForecast(window, cfg)`
  (savings + monthly projection) (M19).
- **effectiveness** ← latest M26 report (`learn/store.listReports()[0]`) →
  `{ successRate, delta.effectivenessPct, delta.headline }`, or `null`.
- **today** ← `emptyTodayDelta()` at snapshot time; the day-over-day numbers are
  filled by `buildDigest` against `loadPreviousDigest()` (the snapshot itself has
  no prior to diff against).

> **Performance note (kept from M13/M24):** `buildSnapshot` is called every TUI
> refresh tick (~2s) and MUST stay sub-second + never throw. M27 `computeReport`
> over enrolled repos is the heaviest call; it is wrapped and (per existing
> pattern) degrades on failure. If profiling shows it is too slow for the tick,
> the integration phase may gate the portfolio block behind a cheaper cached
> read — but the digest path (one-shot) always uses the full build.

### `src/core/digest/build.ts` — `buildDigest(cfg, opts?): Promise<DigestReport>`
Deterministic daily summary computed from the portfolio snapshot + day-over-day
deltas vs the previous digest. Steps: `buildSnapshot` → take `.portfolio` (or
`emptyPortfolio(window)`) → `loadPreviousDigest(generatedAt)` → fill
`portfolio.today` deltas → compose deterministic `headline` → OPTIONAL narrative
via `getActiveClient(cfg, { allowCloud })` (local-only unless `--allow-cloud` +
key; mirror M26 playbooks / M27 health). Async, **never throws**, writes nothing.

### `src/core/digest/store.ts` — persistence under `~/.ashlr/digests/`
Mirrors the M26 learn / M27 quality stores: atomic tmp-write + rename, epoch-ms
filename stems (lexicographic == chronological), bounded reads (`MAX_DIGESTS`),
never throws on reads. Each digest persists **two** sibling artifacts sharing a
stem: `<stem>.json` (canonical `DigestReport`, the prior for deltas) and
`<stem>.md` (markdown rendering).

- `digestsDir()` — `~/.ashlr/digests` (re-resolved from `homedir()`; added to
  `src/core/config.ts` as the single source of truth for the `~/.ashlr` root).
- `saveDigest(report, markdown): { jsonPath, markdownPath }` — atomic; writes
  ONLY under `digestsDir()`.
- `listDigests(): DigestReport[]` — most-recent first, bounded.
- `loadPreviousDigest(before?): DigestReport | null` — prior for day-over-day
  deltas (mirror `loadPreviousReport`).

### `src/core/digest/deliver.ts` — render + deliver
- `renderDigestText(report): string` — pure, deterministic markdown body (no I/O,
  no model, no secrets). Used both for the `<stem>.md` artifact and the notify
  payload.
- `deliverDigest(report, cfg, { notify? }): Promise<DigestDeliveryResult>` —
  ALWAYS writes the local artifact (via `saveDigest`); calls `notify(markdown,
  cfg)` **ONLY** when `notify === true` (opt-in). Returns exactly what happened.
  Never throws.

---

## TUI / web surfacing (READ-ONLY)

### TUI (M13)
- `TuiTab` gains `'portfolio'` (in `src/core/types.ts`).
- `src/tui/render.ts`: `TABS` adds `{ id:'portfolio', label:'Portfolio', key:'7' }`;
  the `buildBody` switch adds `case 'portfolio': return bodyPortfolio(...)`; new
  `bodyPortfolio(snap, cols, bodyRows, col)` renders `snap.portfolio` (health/
  goals/backlog/cost/effectiveness/today) READ-ONLY, degrading to a "no portfolio
  data" line when absent.
- `src/tui/app.ts`: `TAB_ORDER` adds `'portfolio'`. `selectableCount` already has
  a safe `default: 0` (the portfolio tab has no row selection).

### Web (M14)
- `src/core/web/api.ts`: `handleApi` already serves `GET /api/snapshot ->
  buildSnapshot(cfg)`, which now carries `portfolio`. Add a small read-only
  `GET /api/portfolio` projection (or surface `.portfolio` from the existing
  snapshot endpoint) — NO dispatch, token-guarded like the rest.
- A public read-only portfolio view in the served dashboard. **READ-ONLY**: no
  mutation endpoints, no proposal apply/approve, no outward calls.

---

## CLI surface — `ashlr digest`

```
ashlr digest                       # build + write local artifact + print (default)
ashlr digest --json                # emit the DigestReport as JSON
ashlr digest --window <7d|30d>     # cost/forecast window (default 7d)
ashlr digest --notify              # ALSO send via configured webhook (OPT-IN)
ashlr digest --allow-cloud         # permit a CLOUD model for the optional narrative
```

`src/cli/digest.ts` exports `cmdDigest(args): Promise<number>` (mirrors
`health.ts`/`reflect.ts`: lazy core import + graceful "module not yet built"
fallback, `parseDigestArgs`, `printHelp`, human + `--json` output). Exit codes:
`0` success, `1` runtime error, `2` bad usage.

### Dispatcher wiring (integration owns this — NOT this scaffold)
`src/cli/index.ts` must add (mirroring reflect/health/goals exactly):
- `const loadDigestCmd = lazyCmd(() => import('./digest.js'), (m) => m.cmdDigest
  as Cmd, 'digest command requires src/cli/digest.ts (M29 module not yet built).');`
- `case 'digest': { const cmdDigest = await loadDigestCmd(); process.exitCode =
  await cmdDigest(rest); break; }`
- a `cmdHelp()` command line + an example for `ashlr digest`.

(The M25 review caught this wiring being missed — it is called out explicitly.)

---

## The 5 HARD SAFETY INVARIANTS (verbatim) + enforcement + proof

### 1. READ-ONLY AGGREGATION
> The portfolio snapshot + digest only READ existing local state (index, runs,
> swarms, health snapshots, goals, backlog, inbox, observability rollup/forecast,
> daemon state, genome). They WRITE only under `~/.ashlr/digests/` (digest
> artifacts). NEVER mutate a repo/working tree, NEVER write CONFIG_PATH, NEVER
> apply/approve a proposal, NEVER push/PR/deploy.

- **Enforced:** `buildSnapshot`/`buildDigest` call only read APIs
  (`computeReport`, `listGoals`/`progressOf`, `loadBacklog`, `buildRollup`/
  `buildForecast`, `listReports`, `loadDaemonState`, `loadGenome`, `pendingCount`)
  + `loadPreviousDigest`. The ONLY write is `saveDigest` → `digestsDir()` via
  atomic tmp+rename. No `createProposal`/`setStatus`/`applyProposal`/`saveConfig`/
  `createPr`/deploy import exists in `src/core/digest/*`.
- **Verifier proves:** static — `grep` `src/core/digest/*` for `saveConfig`,
  `applyProposal`, `setStatus`, `createPr`, `createProposal`, `writeFileSync`
  outside the store; assert every write target in the store resolves under
  `digestsDir()`. Runtime — run `digest` against a tmp HOME + a tmp repo, snapshot
  the repo working tree + `CONFIG_PATH` mtime before/after, assert unchanged;
  assert files appear ONLY under `~/.ashlr/digests/`.

### 2. NO OUTWARD ACTION BY DEFAULT
> `ashlr digest` writes a LOCAL file by default. It sends via `notify()` (Slack/
> Discord webhook) ONLY when the user EXPLICITLY passes `--notify` AND a webhook
> is configured. `notify()` is already a strict no-op when unconfigured — keep it
> that way; default digest path makes ZERO outward network calls.

- **Enforced:** `deliverDigest` calls `notify()` ONLY inside
  `if (opts?.notify === true)`. The default path never references it. `notify()`
  remains the unchanged strict no-op for an unconfigured webhook.
- **Verifier proves:** unit — spy on `notify`; assert NOT called for `cmdDigest([])`
  and `cmdDigest(['--json'])`; assert called exactly once only for
  `cmdDigest(['--notify'])`. Network — mock `fetch`/`https` and assert ZERO
  non-localhost requests on the default path (and zero when `--notify` is passed
  but no webhook is configured).

### 3. ENROLLMENT-SCOPED
> The v2 portfolio dimensions (health via M27 `computeReport`, goals via M28)
> cover ENROLLED repos only (default empty ⇒ those sections are empty, NO
> portfolio disk scan). The pre-existing M13 index roll-up over the local index
> is unchanged. Do NOT introduce any new arbitrary-path scan; reuse the existing
> read-only sources which are already enrollment/index scoped.

- **Enforced:** health comes from `computeReport()` (defaults to `listEnrolled()`;
  empty ⇒ empty report, no scan) and goals from `listGoals()` (reads
  `~/.ashlr/goals/`). M29 adds NO `readdir`/glob over repo roots. The M13 index
  roll-up in `buildSnapshot` is untouched.
- **Verifier proves:** with empty enrollment, assert
  `portfolio.health.reposScored === 0`, `worstRepos === []`, and (via a spied FS)
  that NO directory under the configured repo roots was read by the portfolio
  block. `grep` `src/core/digest/*` + the new dashboard block for `readdirSync`/
  glob over repo paths ⇒ none.

### 4. LOCAL-FIRST
> Aggregation + digest rendering is deterministic with NO LLM by default. Any
> optional digest narrative routes through `getActiveClient(cfg,{allowCloud})` —
> local only unless `--allow-cloud` + key (mirror M25-M28). Default path = zero
> non-localhost connections.

- **Enforced:** all portfolio numbers + `headline` + `renderDigestText` are pure
  deterministic functions — no model. The single model touchpoint is the
  OPTIONAL narrative in `buildDigest`, guarded by `opts.allowCloud` and routed
  through `getActiveClient(cfg, { allowCloud })` which throws for a cloud provider
  without `allowCloud` + key (local providers are localhost-only).
- **Verifier proves:** assert a built digest with no `allowCloud` has
  `narrative === undefined`; assert determinism (same snapshot + prior ⇒ identical
  report sans `generatedAt`). Mock `fetch`/`https` ⇒ zero non-localhost calls on
  the default path.

### 5. BOUNDED + NEVER-THROWS
> Every source is wrapped so a missing/failed source degrades to a zeroed/empty
> section (the existing `buildSnapshot` pattern). Cap list sizes. No unbounded
> loops. No new runtime deps.

- **Enforced:** every portfolio sub-source + every digest step is in its own
  `try/catch` degrading to its empty/zeroed default. `worstRepos`/`goalsInFlight`/
  `backlogTop` are capped; `listDigests` is bounded by `MAX_DIGESTS`. No new deps
  (Node builtins + existing modules only).
- **Verifier proves:** inject a throwing source (e.g. stub `computeReport` to
  reject) and assert `buildSnapshot`/`buildDigest` still resolve with that section
  zeroed and never throw. Assert list lengths ≤ caps. `package.json` deps
  unchanged.

---

## Files

- **Contract:** `CONTRACT-M29.md` (this file)
- **Types (extended):** `src/core/types.ts` — `portfolio?` on `DashboardSnapshot`;
  `'portfolio'` on `TuiTab`; `PortfolioSummary` + `PortfolioHealthSummary` +
  `PortfolioGoalInFlight` + `PortfolioBacklogItem` + `PortfolioCost` +
  `PortfolioEffectiveness` + `PortfolioTodayDelta`; `DigestWindow` + `DigestOptions`
  + `DigestReport` + `DigestDeliveryResult`.
- **Config (extended):** `src/core/config.ts` — `digestsDir()`.
- **Core (new stubs):** `src/core/digest/build.ts`, `src/core/digest/store.ts`,
  `src/core/digest/deliver.ts`.
- **CLI (new stub):** `src/cli/digest.ts` (`cmdDigest`).
- **TUI (extended):** `src/tui/render.ts` (`TABS` + `buildBody` case +
  `bodyPortfolio` stub), `src/tui/app.ts` (`TAB_ORDER`).
- **Dispatcher (NOT yet wired — integration owns it):** `src/cli/index.ts`.
- **Tests:** `test/m29.*.test.ts` (tmpdir + mocked sources; never real `~/.ashlr`,
  never a real webhook POST).
