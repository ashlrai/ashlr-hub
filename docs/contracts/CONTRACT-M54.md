# CONTRACT-M54 — Self-improving fleet (the apex)

**Pillar:** Ashlr v5 Open Fleet — point the fleet at its OWN source so it builds
and maintains ashlr-hub 24/7 — behind a harness that makes it impossible for the
fleet to ever weaken its own safety guarantees.

**Mason's hard rule (the load-bearing one):** self-improvement may never
self-disarm. A self-authored diff (one that touches ashlr's own source) is
INELIGIBLE for any auto-apply unless the FULL invariant suite passes flag-off AND
flag-on against the diff in the sandbox; and ANY diff that deletes or weakens a
safety/invariant test is refused BY CONSTRUCTION, before verification even runs.
Proposal-only by default; kill-switch halts self-work.

---

## 1. Self-target detection (`inbox/merge.ts` / a new `fleet/self.ts`)

- `isSelfTargetProposal(proposal, cfg)` — PURE. True when the proposal's repo is
  ashlr-hub itself (the repo whose package name is `@ashlr/hub`, matched by repo
  path / package.json name — not a brittle hardcoded absolute path).

## 2. The never-weaken guard (`src/core/fleet/self.ts`, new) — runs FIRST

- `guardSafetyTests(diff)` — PURE. Parses the unified diff; REFUSES (returns a
  blocking verdict) when the diff:
  - deletes a test file matching the safety set (`test/h*.test.ts`,
    `test/m45.foundry.test.ts`, `test/m47*.test.ts`, `test/m51.trust.test.ts`,
    `test/m52.*`, `test/m54.*`, and any file containing a `daemon-no-primitive` /
    grep-guard), OR
  - removes net assertions from such a file (more `-  expect(`/`-  it(` /
    `-  describe(` lines than added), OR
  - removes/loosens a source-level grep-guard.
  This is a structural, conservative guard: ambiguous ⇒ refuse. It is the FIRST
  check in the self-target path — a weakening diff never reaches verification.

## 3. Self-eval harness (`inbox/merge.ts` verifyProposal extension)

- For a self-target proposal, `verifyProposal` additionally requires: apply the
  diff in the sandbox worktree, then run the suite `npm test` BOTH with the
  foundry flag OFF and ON (env toggles), and require BOTH green. A failure in
  either ⇒ not eligible. Bounded wall-clock; never throws; default proposal-only
  unchanged.

## 4. Self-improvement scanner (`src/core/portfolio/scanners/self-improve.ts`, new)

- A backlog scanner (wired through the existing `getScanners`/`buildBacklog`
  seam) that surfaces ashlr's own actionable work: open TODO/FIXME with context,
  test-coverage gaps, failing/`.skip` tests, lint debt — as `WorkItem`s with
  `source: 'self'`. Bounded, never throws, secret-scrubbed, score via the
  canonical `scoreItem`. It NEVER emits an item proposing to weaken a guard.

## HARD RULES + verification (`test/m54.*`)

1. **Never-weaken guard refuses** — a diff deleting `test/h1.audit.test.ts` or
   removing assertions from `m45.foundry`/`m47` is REFUSED before verification;
   a benign source diff is allowed through to verification. → `m54.self-guard`.
2. **Self-eval required** — a self-target proposal is ineligible unless the suite
   is green flag-off AND flag-on; a diff that breaks a test (either flag state) is
   refused. → `m54.self-eval` (hermetic: stub the suite runner / use a tiny fixture
   repo).
3. **Adversarial** — a diff that both makes a "real" fix AND quietly weakens a
   safety test is REFUSED (the guard dominates). → `m54.self-guard`.
4. **Proposal-only + kill** — self-work is proposal-only by default; kill-switch
   halts it; the scanner imports no outward primitive. → `m54.*` + source scan.
5. **Flag-off byte-identical** — non-self-target proposals verify exactly as
   today; scanner off unless enrolled. → regression.

## Deliverables checklist

- [ ] `src/core/fleet/self.ts`: `isSelfTargetProposal`, `guardSafetyTests`.
- [ ] `inbox/merge.ts`: self-target branch in verifyProposal (guard-first, then
      flag-off+on suite), behind the existing gate.
- [ ] `src/core/portfolio/scanners/self-improve.ts` + scanner wiring.
- [ ] Tests: `m54.self-guard`, `m54.self-eval`.

## Non-goals

Auto-merging self-changes by default (stays gated + default-off) · removing human
review · a self-target diff bypassing ANY existing gate.
