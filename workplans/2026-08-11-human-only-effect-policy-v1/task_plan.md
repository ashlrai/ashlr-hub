# Task Plan: Human-Only Proposal Effect Policy

## Goal

Add a lifecycle-stable, signed proposal effect policy that makes every missing,
unknown, invalid, or human-only proposal ineligible for Ashlr-owned effects.
This is a tightening-only authority slice: it does not add human approval,
apply, merge, push, provider, release, installation, or runtime authority.

## Phases

- [x] Create an isolated exact-master worktree and resume Entire context
- [x] Complete Explore mapping of schema, signatures, locks, consumers, and tests
- [x] Finalize the migration/default-deny design and adversarial matrix after independent critique
- [ ] Implement the smallest shared policy primitive and creation-time binding — in progress
- [ ] Enforce early eligibility and lock-held sink revalidation — in progress
- [ ] Prove every machine-invocable decision/effect path refuses human-only work — adapter tests in progress
- [ ] Run focused, adjacent, type, lint, build, diff, and independent security gates
- [ ] Preserve locally; publish only after exact protected-base and WIP gates pass

## Non-Negotiable Boundaries

- No authenticated human approval capability is introduced in this slice.
- No caller-controlled bypass or legacy permissive default is allowed.
- Automated findings may annotate or quarantine but must not impersonate a
  human approve/reject decision.
- Missing, unknown, removed, or invalid policy is effect-ineligible.
- All consequential sinks revalidate policy while holding the proposal lock.
- Existing source merge, package publication, resident activation, and runtime
  authority remain separate gates.

## Current Gate State

- Exact base: `d9046fe5c99c2454c65f56e4849d20e86cef1d05`.
- Protected master CI is red in the unrelated M380 time fixture; CodeQL passed.
- The reviewed 0A-0 branch is preserved remotely without opening a PR.
- Entire is installed but has no checkpoint for this new branch.

## Architecture Decision

- V1 classifies only `note` with no action payload as `none`; every other,
  unknown, malformed, or ambiguous kind/action is `outward-effect`.
- Every newly persisted row receives a signed policy so a later lifecycle change
  cannot exploit a creation-time exemption. Outward-effect rows are
  `human-only`; no historical row is migrated or grandfathered.
- The signature binds the exact kind, a canonical action digest, the derived
  effect class, and all proposal identity/content fields. Verification
  recomputes classification from live bytes using a read-only key path.
- Exact factual reconciliation of a cryptographically proven effect that
  already happened remains observation, never permission to start/retry one.
- Destructive-diff detection must stop falsely recording a machine refusal as a
  human `rejected` decision. The row stays pending with a bounded non-decisional
  safety annotation in this slice.

## Errors Encountered

- None yet.
