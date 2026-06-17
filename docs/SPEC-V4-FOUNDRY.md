# Ashlr Foundry (v4) — the Autonomous Engineering Fleet (end-state spec)

> A sibling to `docs/SPEC-V3-TEAM.md` and `docs/SPEC-V3-LOCAL-WEAPON.md`. Those
> made ashlr **plural across machines** and the **local tier strong**. This one
> makes the whole thing **autonomous at fleet scale**: many agents, three
> backends, building and maintaining the entire ecosystem of dev tools 24/7 —
> with authority to reach `main` granted strictly by **model-trust tier**. Same
> safety posture, zero new runtime deps. This document travels through git and is
> reviewed like everything else.

---

## 1. Context

v4 builds on what already shipped and on the seams v3 left exposed.

- **Shipped foundation (v3-Weapon, M41–M44):** the adaptive prompt suite +
  model profiles (M41 — Fable-5-grade, model-sized system prompts), the
  sandboxed engineering tool surface (M42 — write/edit/bash confined to a git
  worktree, diffs → inbox, never the live tree), the verify→repair loop (M43),
  and `ashlr eval` proving the local uplift (M44). The local model is already a
  capable engineer; v4 puts a fleet of them to work.
- **Seams from v3-Team:** `RepoRef`/`repoId`, the shared inbox lifecycle
  (`pending → approved → claimed → applied`), per-`repoId` daemon leases, the
  team spend ledger, and the two-layer kill. v4 routes the fleet over exactly
  these seams — it grows new *engines*, not new side channels.

**The three gaps v4 closes:**

1. **The autonomous loop was builtin-only.** `runGoal`/`runTask` could only
   drive the in-process builtin engine; an external frontier agent (Claude Code,
   Codex) could be invoked manually via `--engine` but never *inside* the
   autonomous loop, and never contained.
2. **No backend routing or rate model.** Nothing decided which backend a backlog
   item should go to, and nothing tracked subscription rate windows — so the
   fleet could neither saturate the frontier subscriptions within limits nor
   spill unbounded volume to local.
3. **Proposal-only, full stop.** Everything the loop produced stopped at a
   PENDING inbox proposal awaiting a human. There was no graduated path by which
   *verified* low-risk work could flow further — and crucially, no trust-gated
   path to `main` at all.

v4 closes all three while keeping the v1–v3 safety floor intact: everything CAN
reach `main`, but only through a model-trust gate.

## 2. North Star

**A fleet of agents continuously builds and maintains the whole ecosystem of dev
tools — ashlr-hub, phantom, the Claude Code plugin, pulse, … — 24/7, driving
three backends (local models on an M5 Max, Claude Code / Opus 4.8, and Codex /
GPT-5.5). Autonomy is gated by model-trust tier: local models do unbounded bulk
work and drafts and NEVER touch `main`; only frontier "merge-authority" models
may merge to `main` or push to production, and only after full verification.
Everything can reach `main` — but only through that gate.**

v1 built the command center. v2 made it a safe autonomous organization. v2.2 made
it agent-native. v3-Team made it plural; v3-Weapon made local strong. **v4 makes
it a fleet** — many engines, continuously, across every repo, with trust as the
throttle on how far any one of them may go.

## 3. A Day in the Life (the end state, as scenes)

Every scene maps to a roadmap row in §7 — no scene ships without its milestone.

- **Now.** `ashlr run "harden the inbox apply path" --engine codex
  --sandbox-engine` forks a throwaway worktree, runs Codex confined to it with
  git push severed, captures **only the diff**, and files a scrubbed PENDING
  proposal trust-tagged `{engineModel:'codex:gpt-5.5', engineTier:'frontier'}`.
  Nothing reached the live tree. *(M45 — shipped)*
- **Routing.** The backlog has 40 items. The router sends the gnarly refactor to
  Codex, the architecture-shaped change to Claude, and the 35 mechanical
  cleanups to the local M5 Max — capability-tiered by class and difficulty. The
  rate scheduler keeps Claude and Codex saturated within their subscription rate
  windows and spills the unbounded remainder to local. *(M46)*
- **Graduated trust.** A low-risk, fully-verified lint-fix from the local engine
  auto-applies to a branch. A change that would touch `main` waits: it requires
  CI/verify green **and** a frontier merge-authority model. A local-authored diff
  is never eligible for `main`, regardless of how green it is. *(M47)*
- **24/7.** Overnight, the fleet supervisor holds leases across every enrolled
  repo, keeps the local M5 Max saturated and Claude/Codex busy within quota,
  routes each swarm sub-task to a backend, and reuses the swarm's own worktree
  via `runEngineSandboxed(existingWorktree)`. *(M48)*
- **Glance.** Mason opens the control plane: per-backend throughput, queue
  depth, merges-to-main today, per-repo health trends, per-tier budgets, and a
  single **kill** that halts every backend. *(M49)*

## 4. Operating Principles (adds to v1/v2/v3)

The v1–v3 principles carry forward verbatim (local-first · proposal-only
autonomy · safety by construction proven by tests · contracts-first · zero
runtime deps · the harness carries the model · adaptive-not-one-size · cloud is
sync-not-dependency). v4 adds five of its own:

1. **The harness carries the model — at fleet scale.** A backend is an
   interchangeable worker behind the harness's containment and gates. Capability
   and *safety* come from the scaffolding (`runEngineSandboxed`,
   `buildContainedEnv`, the trust gate), never from trusting the black box.
2. **Tiered-trust autonomy.** Authority is a function of the *model*, not the
   task. `engineTierOf` partitions every backend into `'local'` or `'frontier'`;
   only `'frontier'` merge-authority models may reach `main`/prod, and only after
   full verification. Local does unbounded bulk work and never touches `main`.
3. **Only the diff is consumed from external agents.** An external CLI is a black
   box. We take its captured worktree diff and nothing else — its own commits
   land on a throwaway scratch branch and die with the sandbox. No transcript, no
   live-tree write, no push.
4. **Local-first degradation is sacred.** Every v4 feature is gated by
   `cfg.foundry`. Absent ⇒ exactly today's behavior, byte-for-byte: builtin-only
   autonomous loop, external engines run raw as before, proposal-only.
5. **Zero new runtime dependencies.** The fleet drives external CLIs the user
   already has installed (their own Claude/Codex subscriptions, local Ollama/LM
   Studio). v4 ships with zero new deps.

## 5. Architecture Overview

The autonomous spine is unchanged: `runGoal → planGoal → task DAG → runTask`
ReAct loop, with the v3-Weapon engineering surface and verify→repair loop inside
it. v4 wraps that spine with a containment layer and a routing/trust layer, all
gated by `cfg.foundry` (`src/core/types.ts`).

```mermaid
flowchart LR
  subgraph FOUNDRY[cfg.foundry — fleet on]
    BL[backlog · multi-repo] --> RT[router + rate/quota\nscheduler (M46)]
    RT -->|local class/bulk| L[local M5 Max\nOllama / LM Studio\ntier: local]
    RT -->|frontier class| C[Claude Code · Opus 4.8\ntier: frontier]
    RT -->|frontier class| X[Codex · GPT-5.5\ntier: frontier]
    L --> SB[runEngineSandboxed\nthrowaway worktree · buildContainedEnv\npush severed · diff-only]
    C --> SB
    X --> SB
    SB -->|scrubbed diff +\n{engineModel,engineTier}| IN[(PENDING inbox)]
    IN --> GT{tiered-trust\nmerge gate (M47)}
    GT -->|low-risk verified| BR[branch / PR]
    GT -->|main / prod:\nCI green AND\nmergeAuthority model| MAIN[(main · prod)]
    GT -->|else| HU[human approval]
  end
  SUP[fleet supervisor (M48)] -. drives 24/7 .-> RT
  CP[control plane (M49)] -. observes / pause / kill .-> SUP
```

**The load-bearing claim: v4 is `runEngineSandboxed` (the M45 keystone) becoming
the loop's external-engine path, plus a router and a trust gate around the
existing inbox.** The local stack, the seams, and the proposal lifecycle are
untouched in shape.

Core M45 mechanics, already shipped (`src/core/run/sandboxed-engine.ts`):

- **`runEngineSandboxed(engine, goal, cfg, opts)`** forks an M21 sandbox
  worktree of `opts.sourceRepo`, runs the external CLI with `cwd =
  worktreePath`, captures `sandboxDiff`, scrubs it (`scrubSecrets`), and files a
  PENDING `'patch'` proposal via `selectInboxStore(cfg)`. It never falls back to
  a raw run — a sandbox-creation failure is terminal by design. `existingWorktree`
  lets a swarm reuse its own sandbox.
- **`buildContainedEnv(cfg, hooksDir)`** preserves the agent's OWN vendor auth
  (real `HOME`, `CODEX_HOME`, `CLAUDE_CONFIG_DIR`, `XDG_*`) so the subscription
  session works, while severing git's PUSH credential channels: a
  `CRED_ENV_DENY` strip of every `*_TOKEN|SECRET|KEY|PASSWORD|CREDENTIALS` var,
  `GIT_TERMINAL_PROMPT=0`, empty `GIT_ASKPASS`, deleted `SSH_AUTH_SOCK`,
  `GIT_SSH_COMMAND='ssh -oBatchMode=yes'`, and a per-invocation `core.hooksPath`
  (via `GIT_CONFIG_COUNT/KEY_0/VALUE_0` — **no shared-config mutation**) pointing
  at a hooks dir whose `pre-push` hard-fails every push.
- **`engineTierOf(engine)`** maps `{claude, codex} → 'frontier'`, everything else
  → `'local'` (`EngineTier = 'local' | 'frontier'`; `EngineId = 'builtin' |
  'ashlrcode' | 'aw' | 'claude' | 'codex'`). Every `RunState` and every proposal
  carries `{engineModel, engineTier}`.

## 6. Capability Pillars

| Pillar | What it delivers | Milestone |
|---|---|---|
| Multi-backend sandboxed engines | Codex + headless-autonomous Claude adapters; `runEngineSandboxed` confines any external CLI, severs push, captures diff-only, trust-tags every run/proposal | **M45 (shipped)** |
| Backend router + rate/quota scheduler | Capability-tiered routing per backlog item; per-subscription rate windows saturate Claude/Codex within limits, spill volume to local | M46 ✓ |
| Tiered-trust merge gate | Graduated auto-apply: verified low-risk → branches; `main`/prod requires CI green **and** a frontier merge-authority model | M47 ✓ |
| Fleet supervisor (24/7) | Continuous multi-backend, multi-repo daemon; swarm per-task routing reusing existing worktrees | M48 |
| Fleet control plane + observability | Live per-backend throughput, queues, merges, per-repo health, per-tier budgets, pause/kill | M49 |

## 7. Roadmap (M45–M49)

Each milestone is one contracts-first workflow: `CONTRACT-M<N>.md` authored and
reviewed **before** code, adversarial tests alongside, one commit per milestone,
each shipping standalone value. Effort: S ≈ 1–2d · M ≈ 3–5d · L ≈ 1–2w.

| M | Name | Value shipped | Effort | Status |
|---|---|---|---|---|
| **M45** | **Multi-backend sandboxed engines (keystone)** — Codex adapter + headless-autonomous Claude adapter; `runEngineSandboxed` runs an external agent CLI confined to a throwaway git worktree (`cwd = worktreePath`), severs git PUSH creds (`buildContainedEnv`: env strip + empty `GIT_ASKPASS` + no `SSH_AUTH_SOCK` + per-invocation `core.hooksPath` pre-push blocker via `GIT_CONFIG_*`) while preserving the agent's own `HOME` subscription session; captures ONLY the diff → scrubbed PENDING inbox proposal; trust-tags every run/proposal `{engineModel, engineTier}`. Gated by `cfg.foundry` (absent ⇒ today's behavior). Usable now via `ashlr run --engine codex\|claude --sandbox-engine`. | external frontier backends drive the loop without ever touching the live tree or `main` | M–L | **Shipped** |
| **M46** | **Backend router + rate/quota scheduler** — route each backlog item to a backend by class/difficulty (capability-tiered over `cfg.foundry.allowedBackends`); track per-subscription rate windows so the fleet saturates Claude/Codex within limits and spills unbounded volume to local. (Codex `--sandbox workspace-write` is its own additive sandbox; note it as defense-in-depth atop our worktree containment.) | the right work to the right backend, within subscription limits | M | **Shipped** |
| **M47** | **Tiered-trust merge gate** — graduated auto-apply: low-risk verified classes → branches; **merge-to-`main` / push-to-prod requires full CI/verify green AND a frontier merge-authority model** matching `cfg.foundry.mergeAuthority` (today `[{engine:'claude',model:'<opus-4.8>'},{engine:'codex',model:'<gpt-5.5>'}]`). Extends `inbox/apply.ts`; kill-switch + human override always available. | trust-gated path to `main`, fully verified | M–L | **Shipped** (signed provenance → M47.1) |
| **M47.1** | **Signed provenance** — HMAC-bind `{engineModel, engineTier, diffHash}` at sandboxed-producer time and re-verify in the merge gate, so a local/in-process writer can't forge frontier merge-authority on a proposal record (review finding H3; today bounded by the default-disabled posture + the agent MCP surface being unable to set those fields). | merge authority can't be spoofed on disk | S–M | Planned |
| **M48** | **Fleet supervisor (24/7)** — extend the daemon into a continuous multi-backend, multi-repo supervisor; wire swarm per-task backend routing (reusing the swarm's existing worktree via `runEngineSandboxed(existingWorktree)`); keep local saturated + Claude/Codex busy within quota across all enrolled repos. | the fleet runs itself, around the clock, across the portfolio | L | Planned |
| **M49** | **Fleet control plane + observability** — live dashboard/CLI: per-backend throughput, queue, merges-to-main, per-repo health trends, per-tier budgets/quotas, pause/kill. Extends the web UI. | one glance at the whole fleet; one button to stop it | M | Planned |

## 8. Hard Gates (the loop STOPS and asks)

- Any external engine running in the autonomous loop **without** the sandbox —
  forbidden by construction; `runEngineSandboxed` is the only autonomous path and
  never falls back to a raw run.
- Any merge-to-`main` or push-to-prod (M47) — requires CI/verify green AND a
  matching `cfg.foundry.mergeAuthority` entry; a non-frontier (or unlisted)
  model is refused.
- Flipping any auto-apply default from off (M47) — graduated classes are opt-in;
  default remains proposal-only.
- Any new runtime dependency (the answer should remain: none).
- The kill-switch (`~/.ashlr/KILL`) present — halts every backend, every repo.
- Each milestone's contract reviewed before its first line of code.

## 9. Safety Invariants (each → a named adversarial test)

The entire v1–v3 set carries forward verbatim. v4 adds nine fleet invariants,
each of which must have a named adversarial test before its milestone closes.

1. **Local-first degradation** — no `cfg.foundry` ⇒ byte-identical builtin /
   proposal-only behavior; the fleet path is unreachable. → `m45.foundry`
   foundry-absent test; full suite green flag-off.
2. **Sandboxed-with-diff-capture only** — in the autonomous loop, external
   engines run ONLY through `runEngineSandboxed`; there is no raw-external path
   inside the loop (sandbox-creation failure is terminal, never a raw fallback).
   → `m45.foundry` no-raw-fallback test.
3. **Git push is blocked from the sandbox** — the pre-push hook + credential
   strip make every push from the worktree fail (`buildContainedEnv`: empty
   `GIT_ASKPASS`, deleted `SSH_AUTH_SOCK`, `GIT_TERMINAL_PROMPT=0`,
   per-invocation `core.hooksPath` blocker via `GIT_CONFIG_*`). → cite
   `test/m45.foundry.test.ts` (pre-push / cred-strip proof).
4. **Agent vendor auth preserved** — the agent's OWN subscription session
   (real `HOME`, `CODEX_HOME`, `CLAUDE_CONFIG_DIR`, `XDG_*`) survives
   containment, so it can function, while git push creds are severed. → `m45.foundry`
   env-preservation test.
5. **Only the diff is consumed** — the loop ingests solely the captured,
   scrubbed worktree diff; the agent's own commits/scratch branch are discarded
   with the sandbox; no transcript or live-tree write escapes. → `m45.foundry`
   diff-only / scrub test.
6. **Immutable trust provenance** — every `RunState` and every proposal carries
   write-once `{engineModel, engineTier}` (`engineTierOf`: `{claude,codex} →
   frontier`); attribution is never mutated post-hoc. → `m45.foundry` provenance
   test.
7. **Merge-to-main requires frontier + verification** — a proposal may auto-apply
   to `main`/prod only when CI/verify is green AND its `{engine,model}` matches a
   `cfg.foundry.mergeAuthority` entry; a local-tier (or unlisted) author is
   refused regardless of green status. → `m47.merge-gate` trust-and-verify test.
8. **Kill halts every backend** — the kill-switch stops local, Claude, and Codex
   work across all enrolled repos; an in-flight sandboxed run is torn down. →
   `m48.supervisor` kill-all test.
9. **Zero new runtime deps** — v4 adds no runtime dependency; backends are CLIs
   the user already has. → dependency-manifest grep-guard, full suite.

## 10. Non-Goals (explicit)

- Hosting or shipping the models. We orchestrate the user's own
  Claude/Codex subscriptions and local Ollama/LM Studio — no provider keys, no
  fine-tuning, no new runtime.
- OS-level / VM jailing of external agents. The boundary is the git worktree +
  contained env + push-sever + diff-only consumption; the documented residual
  (an external CLI can *read* outside the worktree) is a later milestone, not v4.
- Trusting an external agent's commits or push. We never consume anything but the
  diff; the fleet — not the agent — decides what reaches `main`.
- A public/multi-tenant fleet. This is the founders' own engineering fleet over
  their own enrolled repos.
- Removing the human. Human override and approval are always available; the gate
  graduates trust, it does not abolish review.

## 11. Success Metrics (measurable)

- The fleet runs **24/7** across all enrolled repos with the local M5 Max
  saturated and Claude/Codex busy within their subscription rate windows.
- **Zero** external-engine runs in the autonomous loop ever touch the live tree
  or push (every push from a sandbox fails; proven by the M45 test).
- Every merge to `main` carries a frontier merge-authority `{engineModel}` and a
  green CI/verify record; **zero** local-authored merges to `main`.
- Every run and proposal carries `{engineModel, engineTier}` provenance — 100%.
- **0 new runtime dependencies** at v4 completion.
- Every invariant in §9 maps to a **named adversarial test**; the full suite
  stays green flag-off (byte-identical) and flag-on.

## 12. Verification (per milestone)

House pattern: per-milestone suites (`test/m45.foundry.test.ts`,
`test/m46.*`, `test/m47.*`, `test/m48.*`, `test/m49.*`) with the adversarial
lens, plus source-level grep-guards for structural invariants (the `advance.ts`
precedent). M45's keystone is verified hermetically: a tmp source repo, a stub
engine CLI, and assertions that a push from the worktree fails, the contained env
strips creds while preserving vendor-auth vars, only the scrubbed diff reaches a
PENDING proposal, and the run/proposal carry `{engineModel, engineTier}`. M47's
gate is verified by asserting refusal of merge-to-`main` for non-frontier /
unlisted / not-yet-green proposals and acceptance only when both conditions hold.
M48's supervisor is verified by a kill-all teardown test across multiple
in-flight backends.

## 13. Living-Spec Mechanics

This document is the source of truth; changes go through PRs like any code. After
import, `ashlr spec import --from docs/SPEC-V4-FOUNDRY.md` makes it a first-class
SpecArtifact. The registered goal tracks delivery; its milestones mirror §7. Each
milestone updates its row in §7 and ticks its invariants in §9 with the test that
proves them. The gates in §8 — especially the M47 merge-to-`main` trust gate —
open only when their named tests are green on the founders' machines and CI.
