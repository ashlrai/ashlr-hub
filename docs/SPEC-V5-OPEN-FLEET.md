# Ashlr Open Fleet (v5) — the Polyglot, Self-Improving, Conducted Fleet (end-state spec)

> A sibling to `docs/SPEC-V4-FOUNDRY.md`. v4 made the fleet autonomous at scale
> across three backends with authority gated by model-trust tier. **v5 makes the
> fleet polyglot, self-improving, and conducted**: any number of backends behind
> the same containment (local models, Claude Code, Codex, Hermes, OpenCode, and
> any OpenAI-compatible API — NVIDIA NIMs, Kimi K2.7, …), a third trust tier for
> strong open models, OS-level confinement that closes v4's read-residual, a fleet
> that learns how to route and recover from budget breaches, the fleet pointed at
> **its own source** behind a self-eval harness, and a single polished `/goal` +
> `/loop` conductor. Same safety floor, zero new runtime deps. Travels through git.

---

## 1. Context

v5 builds on what v4 shipped and on the seams v4 left exposed.

- **Shipped foundation (v4-Foundry, M45–M49):** `runEngineSandboxed` containment
  (throwaway worktree, push severed, diff-only capture), `buildContainedEnv`, the
  backend router + rate/quota scheduler, the tiered-trust merge-to-`main` gate,
  HMAC-signed provenance (M47.1), the 24/7 fleet supervisor, and the control plane.
- **Seams from v4:** `EngineId`/`EngineTier`/`engineTierOf`, the
  `{engineModel, engineTier}` provenance on every run + proposal, `cfg.foundry`,
  `routeBackend`/`withinLimit`, `evaluateMergeAuthority`/`classifyRisk`, and the
  `spawnSync` containment point. v5 grows new *engines, tiers, jails, and a
  conductor* over exactly these seams — never a new side channel.

**The five gaps v5 closes:**

1. **Backends were hardcoded.** `EngineId` was a closed union; `buildEngineCommand`
   / `engineInstalled` / `engineTierOf` were hand-written switches; and the
   OpenAI-compatible *cloud completion path was an unimplemented stub that threw*.
   Adding a backend meant editing code in five places, and API models did not work
   at all.
2. **Trust was binary.** `local | frontier` could not express a strong *open*
   model (Kimi K2.7, Hermes, a NIM-hosted 70B) that deserves more than
   proposal-only but must never reach `main`.
3. **The worktree was not jailed.** v4 explicitly documented the residual: a
   contained external CLI can still *read* outside its worktree, and nothing gated
   its network egress.
4. **The fleet did not learn.** Routing was static keyword/effort heuristics; there
   was no budget-breach recovery and no per-run cost-anomaly guard.
5. **The fleet did not build itself, and had no front door.** ashlr was never an
   enrolled target of its own fleet (with the safety harness that would require),
   and there was no single polished autonomous entrypoint — `/goal` and `/loop`
   did not exist.

v5 closes all five while keeping the v1–v4 safety floor intact: everything CAN
reach `main`, but only through the trust gate; the fleet may improve *itself*, but
may never disarm its own gates.

## 2. North Star

**A polyglot fleet drives every capable backend the founders own — local models on
an M5 Max, Claude Code (Opus), Codex (GPT), Hermes, OpenCode, and any
OpenAI-compatible API (NVIDIA NIMs, Kimi K2.7, …) — behind one containment and one
trust gate, with three tiers of authority. The fleet learns how to route, recovers
from budget breaches, and is pointed at its own source behind a self-eval harness
that forbids it from ever weakening its own safety invariants. One conductor —
`ashlr goal` / `ashlr loop`, also `/goal` and `/loop` inside Claude Code — runs the
whole thing 24/7. Adding a backend is config-only. Everything can reach `main` —
but only frontier authority, fully verified, may.**

v4 made it a fleet. **v5 makes it an open, self-improving, conducted fleet** — many
engines behind one gate, learning, building itself, with a single front door.

## 3. A Day in the Life (the end state, as scenes)

Every scene maps to a roadmap row in §7 — no scene ships without its milestone.

- **Polyglot.** A new backend — say a NIM-hosted Llama or Kimi K2.7 — is added by
  one `cfg.foundry.engines` entry (bin/argv or API base+key); the router, the
  containment, the gate, and the control plane all pick it up with no code change.
  An OpenAI-compatible API model now actually runs (the v4 stub is gone). *(M50)*
- **Three tiers.** A fully-verified small fix from Kimi K2.7 (`mid` tier)
  auto-applies to a **branch**; the same change from the builtin local model stays
  a proposal; only a frontier model (Opus/GPT) may take it to `main`. *(M51)*
- **Jailed.** An external CLI tries to read `~/.ssh/id_ed25519` from inside its
  worktree; the macOS `sandbox-exec` profile denies the read, the egress gate
  blocks its `curl`, and the attempt lands in the append-only audit. *(M52)*
- **Learns.** The router notices a class of task is 3× more expensive on frontier
  than its verified-success rate justifies and routes it to `mid`; a predicted
  daily-budget breach cascades new work frontier→mid→local; a run that costs 5× its
  historical p50 is held with a `TuningProposal` for review. *(M53)*
- **Builds itself.** Overnight the fleet triages ashlr-hub's own backlog, drafts
  fixes on local, and a frontier model reviews them — but a self-authored diff is
  ineligible to merge unless the full invariant suite is green flag-off AND
  flag-on against it, and any diff that would delete or weaken a safety test is
  refused outright. *(M54)*
- **Conducted.** Mason types `ashlr goal "harden the inbox apply path"` (or `/goal`
  in Claude Code) and watches it decompose, route across the roster, and file
  proposals; `ashlr loop` runs the whole portfolio 24/7 with the control plane
  inline and one button to stop it. *(M55)*

## 4. Operating Principles (adds to v1–v4)

The v1–v4 principles carry forward verbatim (local-first · proposal-only autonomy ·
safety by construction proven by tests · contracts-first · zero runtime deps · the
harness carries the model — at fleet scale · tiered-trust autonomy · only-the-diff
· local-first degradation is sacred). v5 adds five:

1. **The roster is open and declarative.** A backend is a registry entry, not a
   code branch. Capability and *safety* still come from the scaffolding
   (containment, gate, provenance), never from trusting any black box — old or new.
2. **Trust has gradations, authority does not leak upward.** `local | mid |
   frontier`. A higher tier may do everything a lower one may; only `frontier`
   reaches `main`/prod. A backend's tier is declared and provenance-bound — it can
   never be claimed post-hoc.
3. **Containment is defense-in-depth.** The worktree + contained env + push-sever +
   diff-only consumption remain the floor; OS-level confinement (when available)
   adds read-jailing and egress gating on top. Absent OS support ⇒ v4 behavior,
   never weaker.
4. **The fleet learns within the gate.** Learned routing, cost forecasting, and
   anomaly holds change *which backend* and *whether to pause* — never *whether the
   gate applies*. Every learned action is itself proposal-only or a tier choice.
5. **Self-improvement may never self-disarm.** The fleet may modify its own source,
   but a change is ineligible unless it keeps the invariant suite green flag-off
   and flag-on, and any diff that deletes/weakens a safety or invariant test is
   refused by construction.

## 5. Architecture Overview

The autonomous spine and the v4 containment/routing/trust layers are unchanged in
shape. v5 (a) makes the engine layer **declarative** (a registry), (b) adds a
**third tier** to the gate, (c) wraps the containment `spawn` with an **OS jail**,
(d) adds a **learned-routing/recovery** layer over the scheduler, (e) makes ashlr
**a target of its own fleet** behind a self-eval harness, and (f) puts a single
**conductor** in front. All gated by `cfg.foundry`; absent ⇒ exactly v4 behavior.

```
backlog (multi-repo, incl. ashlr itself ─ M54)
  │
  ▼
learned router + budget recovery (M53) ── over ── routeBackend / quota (v4)
  │   picks {backend, tier} from the declarative ENGINE_REGISTRY (M50)
  ▼
runEngineSandboxed (v4)  ──wrapped by──▶  OS jail: sandbox-exec / seccomp (M52)
  │   CLI agents: claude·codex·aw·hermes·opencode  │  API models: NIM·Kimi·… (M50)
  ▼   push severed · diff-only · {engineModel, engineTier∈local|mid|frontier} (M51)
PENDING proposal  ──▶  tiered-trust gate (M51 over v4 M47/M47.1)
  │   frontier+green → main · mid+green → branch · local → proposal-only
  │   self-target (M54): also require suite green flag-off+on; never weaken a gate
  ▼
conductor: `ashlr goal` · `ashlr loop` · /goal · /loop (M55) ─ drives + observes
```

**The load-bearing claim: v5 is the v4 engine union becoming a declarative
registry (with the API path finally implemented), the binary tier becoming three,
the containment `spawn` gaining an OS jail, the static router gaining a learned
layer, ashlr becoming its own enrolled target behind a self-eval harness, and one
conductor in front — with every v4 seam preserved.**

## 6. Capability Pillars

| Pillar | What it delivers | Milestone |
|---|---|---|
| Polyglot backend registry | Declarative engine registry; real OpenAI-compatible API client (NIMs, Kimi K2.7, Hermes-via-API); CLI adapters for Hermes + OpenCode; adding a backend is config-only | **M50 (keystone)** |
| Tri-tier trust | `local \| mid \| frontier`; mid = strong open models (branch/PR auto-apply, never `main`); per-tier risk thresholds; capability routing | M51 |
| OS-level confinement | macOS `sandbox-exec` / Linux seccomp read-jail + network-egress gate + syscall audit around the contained spawn; graceful fallback | M52 |
| Fleet intelligence | Learned routing from verified-outcome priors; cost forecasting; budget-breach tier cascade; per-run cost-anomaly hold | M53 |
| Self-improving fleet | ashlr enrolled as its own target; self-eval harness (suite green flag-off+on); never-weaken-a-safety-test guard | M54 |
| The conductor | `ashlr goal` + `ashlr loop` CLI + `/goal` + `/loop` Claude Code slash commands over the existing spine | M55 |

## 7. Roadmap (M50–M55)

Each milestone is one contracts-first workflow: `docs/contracts/CONTRACT-M<N>.md`
authored and reviewed **before** code, adversarial tests alongside, one commit per
milestone, each shipping standalone value.

| M | Name | Value shipped | Status |
|---|---|---|---|
| **M50** | **Polyglot backend registry (keystone)** — declarative `ENGINE_REGISTRY` (`src/core/run/engine-registry.ts`) merged with `cfg.foundry.engines`, driving `buildEngineCommand`/`engineInstalled`/tier; the OpenAI-compatible API completion client implemented for real (NVIDIA NIMs, Kimi K2.7/Moonshot, Hermes-via-API); CLI adapters for `hermes` + `opencode`. All flow through `runEngineSandboxed` + the PENDING-proposal seam. Gated by `cfg.foundry`. | a config-only, working roster of every capable backend | **Shipped** |
| **M51** | **Tri-tier trust** — `EngineTier += 'mid'`; tier resolved from the registry; `evaluateMergeAuthority` enforces frontier→`main`, mid→branch only, local→proposal-only; `classifyRisk` thresholds tighten by tier; capability-aware routing. Provenance (M47.1) still binds tier. | strong open models earn graduated trust without `main` access | **Shipped** |
| **M52** | **OS-level confinement** — `cfg.foundry.confinement` per-backend profiles; `buildSandboxLauncher` wraps the contained spawn with macOS `sandbox-exec` (read-jail to worktree + vendor homes, egress deny) / Linux seccomp when present; append-only audit; graceful env-only fallback. Closes the v4 §10 read-residual. | external CLIs can no longer read outside the worktree or exfiltrate | **Shipped** |
| **M53** | **Fleet intelligence** — `learned-router.ts` (`recommendRoute` from verified-outcome priors + `estimateRun`); budget-breach tier cascade (frontier→mid→local→pause); per-run cost-anomaly hold → `TuningProposal` (proposal-only). | the fleet routes smart and stays cost-predictable | **Shipped** |
| **M54** | **Self-improving fleet** — ashlr enrolled as its own target; self-eval harness in the merge gate (a self-authored diff requires the invariant suite green flag-off AND flag-on); a self-improvement scanner; a hard guard that refuses any diff deleting/weakening a safety or invariant test. | the fleet builds the fleet — and can never disarm it | **Shipped** |
| **M55** | **The conductor** — `ashlr goal "<objective>"` (single polished goal runner over `runGoal`/`advanceGoal`) + `ashlr loop` (continuous portfolio conductor over `runDaemon`/`tick` with the control plane inline) + `.claude/commands/{goal,loop}.md` slash commands. Proposal-first; kill-switch + budget always apply. | one front door to the whole fleet, in the terminal and in Claude Code | **Shipped** |

## 8. Hard Gates (the loop STOPS and asks)

The v1–v4 gates carry forward verbatim. v5 keeps them and adds:

- A new backend that has no declared tier — refused (no implicit `frontier`).
- A `mid`-tier proposal attempting to reach `main`/prod — refused; mid never
  merges to `main`, regardless of green status.
- A self-authored diff (ashlr's own source) that is not green flag-off AND flag-on
  in the sandbox — refused; and any diff that deletes/weakens a safety or invariant
  test — refused by construction.
- An OS confinement profile that fails to launch (where required) — terminal, never
  a silent downgrade to un-jailed.
- A learned-routing or anomaly action that would bypass the trust gate or
  auto-apply — forbidden; learned actions are tier choices or proposal-only.
- Any new runtime dependency (the answer remains: none).
- The kill-switch present — halts every backend, every repo, including self-work.

## 9. Safety Invariants (each → a named adversarial test)

The entire v1–v4 set carries forward verbatim. v5 adds:

1. **Flag-off byte-identical** — no `cfg.foundry` (and no new cfg keys) ⇒ exactly
   v4 behavior; the registry resolves the existing engines to byte-identical argv.
   → `m50.*` parity + whole-suite regression.
2. **Registry is the single source of engine truth** — `buildEngineCommand` /
   `engineInstalled` / tier all read the registry; no orphaned hardcoded engine.
   → `m50.*` registry-coverage test.
3. **API completions are real and local-first-gated** — the OpenAI-compatible
   client works AND still refuses cloud without `--allow-cloud` + key.
   → `m50.*` api-client + cloud-gate tests.
4. **Tier authority never leaks upward** — `mid` and `local` can never reach
   `main`; only `frontier` ∈ `mergeAuthority` can. → `m51.*` mid-blocked test.
5. **Tier is provenance-bound** — a record cannot claim a higher tier than its
   signed `{engineModel, engineTier}` (M47.1 holds across three tiers). → `m51.*`.
6. **The worktree is read-jailed where supported** — under `sandbox-exec` a read
   outside the worktree + vendor homes is denied and egress blocked; unsupported
   platform ⇒ documented env-only fallback (never weaker than v4). → `m52.*`.
7. **Learned actions stay inside the gate** — routing/recovery/anomaly never
   auto-apply or bypass the gate; anomaly holds stay PENDING. → `m53.*`.
8. **Self-improvement cannot self-disarm** — a self-target diff merges only when
   green flag-off+on; a diff weakening any safety/invariant test is refused. →
   `m54.*` self-eval + never-weaken guard.
9. **The conductor is proposal-first** — `goal`/`loop` produce PENDING proposals;
   kill-switch + daily budget halt them; they import no outward primitive.
   → `m55.*` + daemon-no-primitive source guard.
10. **Zero new runtime deps** — backends are CLIs/APIs the user already has;
    API calls use the platform `fetch`. → dependency-manifest grep-guard.

## 10. Non-Goals (explicit)

- Hosting or shipping models, or bundling provider keys. We orchestrate the
  founders' own subscriptions, local runtimes, and API keys.
- A public/multi-tenant fleet. Still the founders' own engineering fleet.
- Full VM/container jailing. M52 raises the floor (read-jail + egress) on the OSes
  that support `sandbox-exec`/seccomp natively; a VM boundary remains later work.
- Removing the human. Human override and approval remain always available; the
  self-eval harness graduates trust, it does not abolish review.
- Auto-merging mid/local to `main`. Only frontier, fully verified, ever reaches it.

## 11. Success Metrics (measurable)

- A backend is added end-to-end by **config alone** (one `cfg.foundry.engines`
  entry), exercised by an `m50` test; an OpenAI-compatible API model files a
  scrubbed PENDING proposal.
- Every proposal carries a `{engineModel, engineTier ∈ local|mid|frontier}`
  provenance; **zero** mid/local merges to `main`.
- On a supported OS, an out-of-worktree read from a contained CLI is **denied** and
  audited (proven by the `m52` test); flag-off behavior is byte-identical.
- The fleet builds and proposes changes to **its own repo**; **zero** self-authored
  merges that are not green flag-off+on; **zero** merges that weaken a safety test.
- `ashlr goal` and `ashlr loop` (and `/goal`, `/loop`) drive the roster
  proposal-first; the kill-switch halts everything.
- **0 new runtime dependencies** at v5 completion; full suite green flag-off
  (byte-identical) and flag-on.

## 12. Verification (per milestone)

House pattern: per-milestone suites (`test/m50.*` … `test/m55.*`) with the
adversarial lens, plus source-level grep-guards for structural invariants (the
`advance.ts` / `daemon-no-primitive` precedent). M50's registry is verified by
asserting byte-identical argv for existing engines and a working mocked-`fetch`
API client behind the cloud gate. M51 asserts mid/local can never reach `main`.
M52 asserts (macOS-gated) an out-of-worktree read is denied + audited and a
graceful fallback elsewhere. M53 asserts learned actions never auto-apply. M54
asserts a self-target diff merges only when green flag-off+on and a
safety-test-weakening diff is refused. M55 asserts the conductor is proposal-first
and kill/budget-bounded.

## 13. Living-Spec Mechanics

This document is the source of truth; changes go through PRs like any code. After
import, `ashlr spec import --from docs/SPEC-V5-OPEN-FLEET.md` makes it a
first-class SpecArtifact. Each milestone updates its row in §7 and ticks its
invariants in §9 with the test that proves them. The gates in §8 open only when
their named tests are green on the founders' machines and CI.

---

## Addendum — v5.1 Claude 5 Model Intelligence (M320–M324, shipped 2026-07)

The routing layer described above gained model-generation awareness:

- **M320** — `claude:sonnet-5` / `claude:fable-5` in the catalog behind
  `cfg.foundry.claude5` (default on; `enabled:false` is a byte-identical
  rollback). Fable 5 is the default judge/strategist with automatic per-call
  Opus 4.8 fallback. Merge-authority matching is spelling-variant-safe via
  `canonicalModelTag`.
- **M321** — Sonnet 5 is the frontier routing workhorse (hard/medium claude
  picks); quality policy sorts by `qualityRank` so Fable/Opus stay the strong
  picks. Claude 5 dispatches use full API ids.
- **M322** — judge calls record cost/tokens/latency + the actual answering
  model; `computeModelRoi` derives per-model ship-rate and
  cost-per-merged-proposal with producer-attributed joins.
- **M323** — `cfg.foundry.modelGranularRouting` (default off): route to the
  CHEAPEST model whose producer-attributed learned ship-rate clears the bar.
  M51 tri-tier trust, quota, and availability constraints are unchanged; the
  M53 safety invariant stands — learned decisions never auto-apply.
