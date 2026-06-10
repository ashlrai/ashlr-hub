# Milestone contracts

Per-milestone **contracts-first** build specifications. Each milestone (M*/H*) was built by an
agent fleet against a contract authored in its scaffold phase: module boundaries, the hard safety
invariants, and how each is verified. They are a historical/design record — the code is the source
of truth; these capture the intent and the safety reasoning at build time.

- `CONTRACT-M3.md` … `CONTRACT-M30.md` — v1 (M1–M20) + v2 (M21–M30, the Autonomous Engineering Organization).
- `CONTRACT-H1.md` … — v2.1 "Harden & Prove" (end-to-end chain harness, crash recovery, concurrency/budget stress, …).

The canonical, binding interface contract lives at the repo root: [`../../CONTRACT.md`](../../CONTRACT.md).
The roadmap + per-milestone build log lives outside the repo at `~/.ashlr/ROADMAP.md`; the end-state
specs at `~/.ashlr/docs/`.
