# Ashlr — Reliability: failure modes & recovery

> Consolidated from the proven H1–H6 facts (each guarantee below is backed by an
> existing passing regression test and/or a structural grep-guard — this doc
> states nothing new; it is a CONSOLIDATION). See
> `docs/contracts/CONTRACT-H8.md` (BUILD ITEM 2) and the activation runbook in
> the top-level `README.md`.

This document is honest about limits: Ashlr is single-machine / single-process;
a swarm has no hard wall-clock deadline yet; and the daily budget has a bounded
(not zero) overshoot under concurrency. Before you trust the autonomous chain,
watch the WHOLE thing run safely on a disposable repo with `ashlr demo` — it
never touches your portfolio and auto-cleans.

---

## What can't happen (proven guarantees)

Each row is enforced by code and pinned by a permanent regression test; the live
structural ones are re-checked any time with `ashlr verify-safety` (5/5).

| Guarantee | What it means | Proven by |
|-----------|---------------|-----------|
| **Proposal-only** | The ONLY outward path is `applyProposal`, gated `exist + approved + confirmed + enrolled + kill-off`. The daemon and `advance` emit ONLY `PENDING` proposals and import NO `apply`/`push`/`createPr`/`deploy` primitive. | H1 chain harness + H4 proposal-only suite; the daemon grep-guard (`verify-safety` CHECK 3). |
| **Sandboxed** | Autonomous code work happens only inside isolated git worktrees. Your real working tree, branch, index and `HEAD` are byte-identical across the entire chain. | H1 (REAL-TREE-UNCHANGED) + H4 sandbox-required + containment suites. |
| **Enrollment-gated** | Only repos you explicitly `enroll` are ever touched. Default enrollment is `{repos:[]}` ⇒ nothing runs. `allowAnyRepo` is env-gated (no stray flag can bypass). | H4 enrollment suite + H5 `allowAnyRepo` env-gate. |
| **Kill switch always wins** | `ashlr enroll kill on` (or `touch ~/.ashlr/KILL`) halts everything immediately; the kill check precedes the enrollment / `allowAnyRepo` gate and is unconditional. | H4 kill-switch suite; `verify-safety` CHECK 2 (kill precedes enroll). |
| **Local-first / no cloud egress** | Code never leaves your machine to a cloud model by default; cloud is opt-in per task (`--allow-cloud`). | H4 local-first suite; `verify-safety` CHECK 5 (provider cloud-gate present). |
| **Containment** | `removeSandbox` refuses any namespace / path-containment mismatch; git ops only ever target a re-derived safe path; a symlink worktree escape is defeated by `resolve()`. | H4 sandbox-containment suite. |
| **Fully audited** | Every enroll / unenroll / kill / proposal / apply / daemon action is appended to `~/.ashlr/audit/<date>.jsonl`; secrets are scrubbed before write. | H6 audit-completeness suite (`verify-safety` CHECK 4 exercises the real scrub guard). |

---

## Failure modes & recovery

Ashlr is designed to fail safe and resume cleanly. Each scenario below has a
proven recovery path and a single command (where manual repair is needed).

- **Daemon crash mid-tick.** A same-day restart preserves `todaySpentUsd`
  (`resetDayIfNeeded` always precedes the spend add; state is persisted +
  reloaded each tick), so there is **no double-spend**. A crashed `running`
  swarm resumes via `resumeId` and skips already-`done` tasks. `PENDING`
  proposals survive the restart byte-equal. A kill-race during a tick aborts
  cleanly. *(H2 crash-recovery.)*
  **Recovery:** just restart `ashlr daemon` — it self-heals.

- **Stuck daemon flag** (`running:true` left behind by a dead process).
  `reconcileDaemonState` (`src/core/daemon/state.ts`) detects a dead-pid
  `running:true` on load and self-heals the flag, so the daemon will start
  again. *(H5.)*
  **Recovery:** automatic on next load; `ashlr daemon stop` to be explicit.

- **Orphan / leftover sandbox worktree** (a swarm died without cleaning up its
  worktree). `sweepOrphanSandboxes({ staleMs })` runs at daemon-start with a
  conservative `ORPHAN_STALE_MS` (6h): it reclaims stale worktrees but **never
  touches a live in-flight worktree** — any sandbox whose owner pid is still
  alive, or whose `createdAt` is younger than `staleMs`, is skipped. *(H2/H5.)*
  **Recovery command:** `ashlr sandbox gc` (manual sweep + disk reclaim).

- **Budget exhaustion mid-tick.** When the daily cap is reached the tick
  short-circuits and **skips** remaining work rather than overspending; per-task
  budget reservation keeps `sum(authorized) ≤ pool`, and the daily reset is
  exact. *(H3 budget stress.)* See the bounded-overshoot caveat under
  **Honest limits**.
  **Recovery:** none needed — spend resumes within cap on the next day boundary.

- **Concurrency flood.** The daemon's `bounded()` pool and the swarm
  `MAX_PARALLEL` cap (≤ 8, default `parallel = 2`) hold under a flood of
  concurrent backlog items — no unbounded fan-out. *(H3 concurrency stress.)*

- **Halt everything now (kill switch).** `ashlr daemon stop` (sets the kill
  switch + clears the running flag), `ashlr enroll kill on`, or
  `touch ~/.ashlr/KILL`. The kill switch is checked first and halts the chain
  immediately — no in-flight proposal can be applied while it is set.

---

## Honest limits

These are real boundaries of the current design. They are documented, tracked,
and **not** papered over.

- **Single machine, single process.** Multi-daemon / multi-machine is a *gated*
  cloud seam (M30) — **NOT built**. Two concurrent daemons on the same `~/.ashlr`
  could race the budget accounting and the per-process id counters; the
  in-process caps are proven, the multi-process case is out of scope.

- **Budget overshoot is bounded, not zero.** Under `parallel > 1`, spend can
  overshoot the remaining daily cap by up to `(parallel - 1) × per-item` before
  the in-tick short-circuit fires (default `parallel = 2` ⇒ at most ~1 extra
  item). The daily reset itself is exact. Keep `daemon.parallel` low if you want
  the tightest bound. *(H3.)*

- **No hard swarm wall-clock deadline yet.** A swarm is bounded by `maxSteps`
  (200) and its token budget, but **not** by elapsed time. Because of that,
  `ORPHAN_STALE_MS` is set to a conservative 6h so the orphan sweep can never
  reclaim a worktree that might still be live. A hard per-swarm deadline (tracked
  follow-up) would let that staleness window tighten to `deadline + margin`.

- **Windows atomic-write caveat.** `saveSwarm` falls back to a direct
  `writeFileSync` if the atomic `tmp + rename` fails (racy on Windows
  cross-device moves). The POSIX path is fully atomic.

---

## Self-check, audit & watch

Read-only ways to confirm the system is safe and see what it has done:

- **`ashlr verify-safety`** — read-only self-check of the 5 structural safety
  guards (enrollment default-empty, kill-precedes-enroll, daemon-no-outward,
  secret-scrub, provider cloud-gate). Exit 0 = all pass. CI does not run this
  command directly, but the SAME five structural guards are re-asserted under
  `npm test` by the H4 verify-safety suite (`test/h4.verify-safety.test.ts`,
  which drives both `cmdVerifySafety([])` and `runSafetyChecks()`), so a violated
  guard fails CI via that test. *(H4.)*
- **`ashlr audit`** — view the append-only action trail (every enroll / unenroll
  / kill / proposal / apply / daemon action; secrets scrubbed before write).
  *(H6.)*
- **`ashlr preflight`** — read-only first-activation readiness (enrollment state,
  daemon not stuck, kill-switch state, `~/.ashlr` writeable, sandbox health,
  local model reachable) → `ready = true|false` + blockers. *(H7.)*
- **`ashlr demo`** — watch the FULL autonomous chain (enroll → backlog scan →
  daemon tick → PENDING proposal → inbox review → rollback) run safely on a
  DISPOSABLE repo in an isolated tmp context, proposal-only, with NO local model
  required and guaranteed auto-cleanup. The "see it before you trust it" step.
  *(H8.)*

---

## Where state lives

`~/.ashlr/` — `config.json`, `enrollment.json`, `KILL`, `daemon.json`,
`inbox/`, `sandboxes/`, `audit/`. The activation runbook (preflight → enroll one
→ dry-run → daemon → inbox approve → rollback) and the full evidence table live
in the top-level [`README.md`](../README.md).
