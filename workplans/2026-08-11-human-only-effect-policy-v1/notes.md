# Notes: Human-Only Proposal Effect Policy

## Initial Findings

- `pendingAuthorityV1` is status-bound and therefore cannot serve as a
  lifecycle-stable effect policy.
- Several machine paths can spend, stage, judge, or verify before a late
  proposal-state check, so both early eligibility and lock-held sink checks are
  required.
- The safe default is deliberate refusal: human-only proposals cannot be
  approved, applied, merged, pushed, or remotely handed off by Ashlr until a
  separately authenticated one-use human capability exists.
- One-shot First Outcome remains proposal-only and is realized externally by a
  human through protected Git.

## Open Design Questions

- Exact signed envelope fields and canonical serialization/versioning.
- Creation and reload paths that must preserve the policy byte-for-byte.
- Exact lock-held sink seam that covers direct store calls and every adapter.
- Whether automated rejection paths must become quarantine/annotation for a
  human-only proposal to avoid falsely claiming a human decision.
- Compatibility behavior for existing proposals without the new policy.

## Explore Decision Candidate

- Add closed `ProposalEffectPolicyV1` with exact proposal/repo/origin/kind,
  run/trajectory/work identity, diff hash, created time, algorithm, derived-key
  identifier, and signature. Do not bind lifecycle status or annotations.
- Derive a role-separated HMAC key from the existing provenance key. Creation
  may create the key; verification must use the read-only existing-key loader
  and constant-time comparison.
- Delete all caller-provided policy input and mint the trusted policy only after
  repo canonicalization, store scrubbing, causal binding, and provenance.
- Do not backfill or silently re-sign historical records. Missing, removed,
  unsupported, or invalid policy remains effect-ineligible.
- Gate automerge before verification/judge/provider spend, then revalidate at
  every consequential sink while holding the proposal mutation lock.
- A valid `human-only` policy still refuses every Ashlr-owned approve, reject,
  apply, automerge, staging, handoff, recovery, and realized-merge transition
  until the separate one-use human capability exists.
- Leave blocked rows pending and permit only observational annotations/counters;
  do not broaden this slice with a new quarantine lifecycle.
- Outer CLI, web, and comms adapters must stop when the central status decision
  is refused rather than continuing to call apply and producing misleading
  output.

## Scope Risk

This is an intentional compatibility break for newly created outward-effect proposals: today’s
TTY, `--yes`, dispatch-token web, comms, and Pulse inputs are not authenticated
human effect capabilities. Preserving those effects through a `classic` policy
or legacy grandfathering would expand authority and contradict the stage’s
default-deny purpose. Independent security, architecture, and test-impact
reviews are running before implementation.

## Independent Architecture/Security Corrections

- Do not globally freeze harmless notes. Only `note` plus no action payload is
  `none`; everything else defaults to `outward-effect`.
- The signed tuple must bind and verifier must recompute exact `kind`, canonical
  action digest, and effect class. Policy-only classification is transplantable.
- Stamp even initially safety-blocked rows. Creation-time destructive-diff
  handling must no longer write `status: rejected` or `decidedAt`; that falsely
  claims a human decision. Preserve the finding as a bounded annotation while
  keeping the proposal pending and ineligible for effects.
- Factual reconciliation may persist only exact cryptographically/host-proven
  effects already completed. No missing-PR recovery, retry, push, cleanup, or
  uncertain transition is covered by that exception.
