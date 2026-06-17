# ashlr-hub roadmap

The forward-looking companion to [CHANGELOG.md](../CHANGELOG.md) (what shipped)
and [docs/contracts/](./contracts/) (the binding per-milestone specs). This
file states direction; contracts state commitments.

## Design principles (constant across every milestone)

1. **Local-first.** No network egress without explicit opt-in; local models by
   default; cloud is a flag plus a key, never a silent fallback.
2. **Proposal-only autonomy.** Every outward mutation passes through the
   approval inbox. There is no agent-reachable approve/apply path — and there
   never will be.
3. **Safety by construction, proven by tests.** Enrollment gating, kill
   switch, sandboxed execution, append-only audit, secret scrubbing — each
   invariant has a named adversarial test, not a paragraph of intent.
4. **Contracts-first.** A milestone is a contract doc + regression tests +
   implementation, in that order.
5. **Zero runtime dependencies** except the MCP SDK. Boring is a feature.

## Shipped

- **v1 (M1–M20)** — desktop command center: index/navigate/scaffold, local
  agent runs, MCP gateway, genome memory, observability, onboarding.
- **v2 (M21–M30)** — autonomous engineering organization: enrollment,
  sandboxed swarms, work discovery, the daemon, the approval inbox, portfolio
  RAG, health scoring, goals, reflection, cloud-ready seams.
- **v2.1 (H1–H8)** — harden & prove: crash recovery, concurrency stress,
  safety-invariant regression suites, guided activation, reproducible demo.
- **v2.2 (M31–M33)** — agent-native ecosystem: native MCP tools + CLI-first
  agent contract (`orient`, `docs --agent`), the living web command center
  (inbox approvals, cost estimates), plugins, npm distribution
  (`@ashlr/hub`), public programmatic API.
- **v3-Weapon (M41–M44)** — make local models an engineering weapon: adaptive
  model-sized prompts, the sandboxed engineering tool surface (write/edit/bash
  confined to a worktree, diffs → inbox), the verify→repair loop, and `ashlr
  eval`. See [`docs/SPEC-V3-LOCAL-WEAPON.md`](./SPEC-V3-LOCAL-WEAPON.md).
- **v4-Foundry (M45–M49)** — the autonomous engineering fleet: multi-backend
  sandboxed engines (`runEngineSandboxed`, push severed, diff-only,
  trust-tagged), backend router + rate/quota, the tiered-trust merge-to-`main`
  gate with HMAC-signed provenance (M47.1), the 24/7 supervisor, and the fleet
  control plane. See [`docs/SPEC-V4-FOUNDRY.md`](./SPEC-V4-FOUNDRY.md).
- **v5-Open-Fleet (M50–M55)** — polyglot, self-improving, conducted: a
  declarative engine registry + a real OpenAI-compatible API client (Hermes,
  OpenCode, NVIDIA NIMs, Kimi K2.7, … added config-only); a third trust tier
  (`mid`); OS-level confinement (macOS `sandbox-exec`/Linux seccomp read-jail +
  egress gate) closing v4's read-residual; learned routing + budget-breach
  recovery + cost-anomaly holds; the fleet pointed at its OWN source behind a
  never-weaken guard + self-eval harness; and the `ashlr goal` / `ashlr loop`
  (+ `/goal`, `/loop`) conductor. See
  [`docs/SPEC-V5-OPEN-FLEET.md`](./SPEC-V5-OPEN-FLEET.md).

## Near-term (v2.3 candidates — direction, not commitments)

- **First public release.** Tag `v2.2.0` → npm publish via the release
  pipeline; gather real-world install feedback (docs/RELEASING.md).
- **Plugin ecosystem seeding.** A handful of reference plugins (e.g. a Jira
  backlog scanner, an org-template pack) exercising each capability kind, plus
  authoring docs hardening from real usage.
- **Estimator learning loop.** Feed `reflect` outcomes back into `--estimate`
  (per-goal-class priors instead of keyword similarity alone).
- **Web command center depth.** Run/swarm detail drill-downs, goal/milestone
  views, and a first-run tour mirroring `ashlr onboard`.
- **Agent contract v2.** Versioned `--json` schemas surfaced in
  `docs --agent --json`; conformance tests that fail when a shape drifts.

## v3 — Team Command Center (gate OPENED 2026-06-12)

The team / multi-machine backbone is now specced and scheduled: see
[`docs/SPEC-V3-TEAM.md`](./SPEC-V3-TEAM.md) — one team memory, one approval
inbox (approve anywhere, owning machine applies), coordinated daemons, and
team visibility, riding the existing api.ashlr.ai backend under `/hub/v1/*`.
Milestones M34–M40, contracts-first, delivered via the registered ashlr goal.
Everything stays local-first: cloud is sync, not dependency.

## Gated future (explicitly NOT scheduled)
- **Public SaaS / anything world-readable.** The team backbone is
  founders-only and self-hostable (`ASHLR_API_URL`).
- **Plugin marketplace / remote plugin fetch.** Plugins remain files you
  place locally and enable explicitly.
- **OS-level plugin sandboxing.** Out of scope; the trust model is gating +
  least privilege + tamper evidence + audit (docs/PLUGINS.md).

## How to influence this

Open a GitHub issue with the problem (not the feature). Anything that touches
an invariant in the design principles above starts as a contract draft in
docs/contracts/.
