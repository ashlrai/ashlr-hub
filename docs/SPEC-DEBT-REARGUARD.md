# SPEC — The Debt Rearguard (tech-debt handler + tester that follows the vision-chaser)

> Status: **planning**. D0 (debt tracker) is built and merged; D1–D6 are the
> build-out. This doc is the executable plan — pick up from "Milestones" after a
> context reset. Direction, not a contract (see `CONTRACT.md` for commitments).

## Why

The fleet has a **vision-chaser** (the vanguard): strategist + invent-engine +
frontier trio chasing `docs/NORTH-STAR.md`, shipping ~30–50 milestones/day. It is
a fantastic builder and a careless housekeeper. Observed first-hand (the M18 +
lint session, 2026-06-30):

- **It ships broken tests with its own commits.** M300 added `runApiModelSandboxed`
  and routed through it but never updated the test mocks → broke m280/m298/m78 on
  master. M295 changed `classifyRisk` but left m86 asserting the old value.
- **Master CI is perpetually red.** Lint debt (297 errors had accumulated) plus
  hermetic test failures; the fleet gates on its own internal delta-gate, not the
  public green-CI signal, so it keeps shipping over a broken foundation.
- **Debt is invisible to the fleet itself.** `scanLint` is **default-OFF** *and*
  cache-first (reads a pre-existing lint report; never runs lint live) — so lint
  debt silently compounds. `scanTests` is a *heuristic* (checks for a test
  script; never runs the suite to find failures). Nothing watches CI status or
  tracks debt **trend**.

The **rearguard** trails the vanguard and keeps the house tidy: it measures debt,
fixes broken tests + lint + red CI, and proves the foundation is getting *cleaner*
over time — the missing counterpart that lets Mason "leave it alone" safely.

## Non-negotiable safety invariant

**Never weaken a test to make it pass.** The cardinal failure mode is masking a
real regression by deleting an assertion, loosening a matcher, or `.skip`-ing a
test that caught a genuine bug. Every test "fix" MUST be classified first
(see D4): *stale test* (source changed intentionally → update the test) vs *real
bug* (source regressed → fix the source or escalate; do NOT touch the test).
This mirrors the existing M54 never-weaken-safety gate and `guardSafetyTests`.

## What already exists (reuse, don't rebuild)

- Scanners: `src/core/portfolio/scanners.ts` — `scanLint`, `scanTests`,
  `scanSelfImprove`, `scanTodos`, `scanDeps`, … emit `WorkItem`s into the backlog.
- Daemon tick + cadence: `src/core/daemon/loop.ts`.
- Sandbox execution + worktrees: `src/core/run/` + `src/sandbox/`.
- Judge / verification gate / scope-cap / automerge: `src/core/inbox/merge.ts`,
  the verify pipeline, HMAC attestation, proposal→pending→merge lifecycle.
- Routing: `src/core/fleet/router.ts`, the Inference Fabric gateway (`src/core/fabric/`).
- Backlog + work selection: `src/core/portfolio/`.

The rearguard is **mostly a new scanner + a routing lane + a specialized tester +
one new safety classifier**, riding the existing sandbox/judge/gate machinery.
It is flag-gated and proposal-only by default, like every other fleet capability.

## Architecture

```
 vision-chaser (vanguard)            rearguard (this spec)
 ───────────────────────            ──────────────────────
 strategist + invent  ──ships──▶    D0 tracker     (measure debt + trend)
 frontier trio                       D1 scanDebt    (debt → WorkItems, live)
 sandbox→judge→merge                 D2 debt routing(cheap/local tier)
        │                            D3 tester      (repair mocks/assertions/coverage)
        └── leaves debt ───────────▶ D4 classifier  (stale-test vs real-bug — SAFETY)
                                     D5 green-keeper (keep master CI green)
                                     D6 daemon wiring + dashboard + self-metrics
```

## Milestones

### D0 — Debt tracker (DONE)
`scripts/debt-tracker.mjs` + `npm run debt` / `npm run debt:trend`. Runs lint +
tsc **live**, reads master CI status via `gh`, appends a snapshot to
`.ashlr/debt-ledger.jsonl` (gitignored), prints snapshot + delta + trend.
`--gate` exits non-zero when dirty (cheap pre-push / cron gate).
**Acceptance:** ✅ runs cross-platform, never throws, records trend.

### D1 — `scanDebt` live debt scanner
A scanner that runs the signals **live** (not cache-first) and emits `WorkItem`s
with `source: 'debt'`:
- Lint errors (live `eslint . -f json`), grouped by file/rule.
- Failing tests (run the suite or `--changed` subset; parse vitest JSON), one
  item per failing test with the assertion + file:line.
- Red CI on master (one high-priority item carrying the failing job + step).
- Stale-mock smell: a heuristic for the M300 class — a source module gained an
  export that a `vi.mock` of it doesn't provide (detectable statically).
**Acceptance:** on a dirty tree, `scanDebt` surfaces the same items a human would;
gated behind `cfg.foundry.scanDebt` (default decision in Open Questions).

### D2 — Debt-aware routing
Debt fixes are mechanical → route `source: 'debt'` items to the **cheap/local
tier** by default (don't burn frontier budget on lint/mocks). Escalate only the
real-bug class (from D4) to a stronger tier. Hook into `router.ts` / the fabric
gateway's `decide()`.
**Acceptance:** a lint-fix item routes to local; a real-bug item routes higher.

### D3 — The tester (specialized test-repair engine)
A focused capability (prompt + tools) for test repair, targeting the classes we
actually hit:
- **Mock completeness** — source export added → add it to the module's `vi.mock`
  (the m280/m298/m78 fix).
- **Assertion reconciliation** — source behavior changed intentionally → update
  the stale assertion (the m86/m298 directive fix), never loosen blindly.
- **Env-decoupling** — a test depends on a live binary/network → mock it or
  `runIf`-gate it (the Ollama / `engineInstalled` fixes).
- **Coverage backfill** — new source landed with no test → propose one.
**Acceptance:** given a CI-red commit of the M300 class, the tester proposes a
diff that greens it without weakening coverage.

### D4 — Stale-test vs real-bug classifier (SAFETY-CRITICAL)
Before any test change, decide: did the source change *intend* this new behavior
(→ update test) or *regress* (→ the test is right, fix source / escalate)? Signals:
was the source change in the same commit/PR as the feature? does the new behavior
match a spec/commit message? is the assertion semantically central or incidental?
On low confidence → **escalate to human** (Telegram, matching the comms pattern),
never auto-weaken. Wire into `guardSafetyTests` / the verify gate so a rearguard
proposal that edits a test under `test/h*` (invariants) or deletes an assertion is
refused by default.
**Acceptance:** a planted real regression is NOT "fixed" by editing the test; it
is escalated or the source is corrected.

### D5 — Green-keeper loop
A daemon cadence whose single job is "master CI is green." On red: pull the
failing jobs (D1), dispatch the tester/handler (D3) through sandbox→judge→gate,
and re-green. The D0 tracker is its scoreboard.
**Acceptance:** fleet breaks its own suite → green-keeper files a fix proposal
within one cadence, debt trend returns to 0.

### D6 — Daemon wiring + dashboard + self-metrics
Wire `scanDebt` + green-keeper into the tick (flag-gated, proposal-only floor).
Surface the debt trend in Mission Control + a proactive Telegram alert when master
goes red or debt spikes (so "leave it alone" is *safe*). The rearguard scores
itself the NORTH-STAR way: **debt-trend DOWN, time-to-green DOWN, zero
safety-gate weakenings** — never vanity.

## Safety & gating summary

- Flag-gated, default-OFF until proven; flag-off = byte-identical to today.
- Proposal-only floor; all fixes go sandbox → judge → scope-cap → verify → gate.
- D4 classifier + `guardSafetyTests` prevent test-weakening.
- Irreversible acts still escalate to the human (per `docs/SPEC-ELON-DIRECTOR.md`).

## Open questions (decide before D1 scaffold)

1. **Cadence & cost** — how often does the green-keeper run, and what token budget
   does the debt lane get? (Cheap/local-first by default; cap per cadence.)
2. **Default-on threshold** — what evidence flips `scanDebt`/green-keeper from
   default-OFF to default-ON? (Proposed: N consecutive cadences with zero
   safety-gate weakenings and a downward debt trend.)
3. **Scope** — rearguard on ashlr-hub only first, or all enrolled repos? (Start
   self-hosted: ashlr-hub keeps *itself* green, then generalize.)
4. **Tester model tier** — local for mechanical repair; which tier for the
   real-bug class, and does it share the frontier trio?
5. **CI source of truth** — gh Actions status vs the internal delta-gate; the
   green-keeper should target the *public* green signal (the gap we found).

## Wiring / where to start (for a fresh context)

- Read this doc + `docs/NORTH-STAR.md` + `docs/SPEC-ELON-DIRECTOR.md` (comms +
  escalation pattern) + `docs/SPEC-INFERENCE-FABRIC.md` (routing/cost lane).
- D0 lives at `scripts/debt-tracker.mjs`. Run `npm run debt` to see current state.
- D1 extends `src/core/portfolio/scanners.ts` (mirror `scanLint`/`scanSelfImprove`
  but run live + add `source: 'debt'`); register in the backlog build.
- D4 extends `guardSafetyTests` / the verify gate in `src/core/inbox/`.
- D5/D6 add a cadence in `src/core/daemon/loop.ts` + a Mission Control panel.
