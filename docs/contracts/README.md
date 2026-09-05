# Milestone contracts

Per-milestone **contracts-first** build specifications. Each milestone (M*/H*) was built by an
agent fleet against a contract authored in its scaffold phase: module boundaries, the hard safety
invariants, and how each is verified. They are a historical/design record — the code is the source
of truth; these capture the intent and the safety reasoning at build time.

Not every shipped milestone has a standalone contract file — many were delivered as part of a
batched CHANGELOG entry instead. For a complete ID → subject → status lookup across every
milestone (including which numbers were spec'd for one thing and shipped as another), see
[`docs/MILESTONE-INDEX.md`](../MILESTONE-INDEX.md) — check it before assigning the next milestone
number.

- [`CONTRACT-M566.md`](./CONTRACT-M566.md) — private, default-off execution-capacity reservation ledger.
- [`CONTRACT-M567.md`](./CONTRACT-M567.md) — source-complete, default-off local Docker observation broker.
- [`CONTRACT-M568.md`](./CONTRACT-M568.md) — version-general, authority-free stopped-selection broker permit.
- [`CONTRACT-M570.md`](./CONTRACT-M570.md) — strict, authority-free release-successor policy evidence schema and verifier.
- [`CONTRACT-M571.md`](./CONTRACT-M571.md) — exact-source local production gate and canonical no-authority receipt.

- `CONTRACT-M3.md` … `CONTRACT-M30.md` — v1 (M1–M20) + v2 (M21–M30, the Autonomous Engineering Organization).
- `CONTRACT-H1.md` … — v2.1 "Harden & Prove" (end-to-end chain harness, crash recovery, concurrency/budget stress, …).
- `CONTRACT-M486.md`, `CONTRACT-M487.md`, `CONTRACT-M493.md`, `CONTRACT-M501.md` — daemon
  crash-safety, quarantine/resolution, and Mission OS observation receipts (M464–M503 range).

The canonical, binding interface contract lives at the repo root: [`../../CONTRACT.md`](../../CONTRACT.md).
The roadmap + per-milestone build log lives outside the repo at `~/.ashlr/ROADMAP.md`; the v1/v2
end-state specs at `~/.ashlr/docs/`. From v3 onward the end-state spec is IN-REPO (team-visible
via git): [`docs/SPEC-V3-TEAM.md`](../SPEC-V3-TEAM.md), covering milestones M34–M40 — **specced
only, not yet built**: no `test/m34.*`–`test/m40.*` exist, and the `/hub/v1/*` API surface it
describes is absent from `src/`. See the status banner at the top of that spec and
`docs/MILESTONE-INDEX.md` §3 for what actually exists today (gated local-only seam stubs).
