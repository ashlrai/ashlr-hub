# Roadmap — next milestones (RETIRED)

**This document is retired as of this pass.** It was authored 2026-06-23 and
planned milestones M83–M88 against a claim that "code/tests currently run to
~M82." Code/tests now run to **M503** — roughly 420 milestones past what this
document describes. All six milestones it planned (M83–M88) have since
shipped:

- **M83** (Windows CI lane) — `.github/workflows/ci.yml:42,59,75,87`
  (`windows-latest` in the job matrix); no dedicated test file (CI config
  only — see `docs/MILESTONE-INDEX.md` §1 for why that's expected).
- **M84** (provider-independent CI tests) — `test/m84.goal-direct.test.ts`
- **M85** (`.gitattributes` EOL hygiene / fleet continuity) —
  `test/m85.fleet-continuity.test.ts`
- **M86** (automerge gate) — `test/m86.automerge-gate.test.ts`
- **M87** (anti-clog) — `test/m87.anti-clog.test.ts`
- **M88** (fleet digest) — `test/m88.fleet-digest.test.ts`

(Note: what actually shipped under M86–M88 is not a literal port of the
"Goal Loop"/`ashlr setup`/npm-publish-readiness features this document
originally proposed for those numbers — the numbers were carried forward
into different, unrelated work as the project's priorities shifted. This is
the same "milestone number ≠ fixed feature" pattern documented across the
M250s–M270s range; see `docs/MILESTONE-INDEX.md` §2.)

**What replaced this document:**

- **`docs/MILESTONE-INDEX.md`** — the authoritative ID → subject → status
  lookup across every milestone, M2 through M503, including every known
  spec-vs-shipped collision. Check this before proposing new work under a
  specific milestone number.
- **`CHANGELOG.md`** — what actually shipped, in release order, with prose
  descriptions grouped by theme.
- **`docs/ROADMAP.md`** — current forward-looking direction and the design
  principles that haven't changed since v1.
- **GitHub issues** — the live backlog. Open a GitHub issue with the problem
  (not the feature) per `docs/ROADMAP.md`'s "How to influence this."

The original contracts-first planning content that lived in this file
(M84–M88, authored against PR #8's Windows-support landing) is preserved in
git history for anyone who wants the original reasoning; it is not restated
here because every one of its milestones has since shipped and the concrete
"what to build" detail is no longer actionable.
