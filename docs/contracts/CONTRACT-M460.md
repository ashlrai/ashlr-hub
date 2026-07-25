# M460 Policy Assignment Receipt Contract

## Purpose

Ashlr may eventually learn from a routing choice only when it can independently
verify the complete eligible action set, behavior probabilities, assignment
timing, exposure, and outcomes. M460 is an earlier prerequisite: it preserves
an authenticated, immutable policy report without granting any routing,
execution, proposal, promotion, merge, deployment, or learning authority.

## Receipt

Each assignment unit has one immutable, host-keyed receipt under
`~/.ashlr/fleet/policy-assignment-receipts/`.

- The assignment unit binds canonical repository identity, work item identity,
  source, generation, objective hash, campaign, eligibility population, policy,
  and epoch with the protected host provenance key. Repository identity uses
  the physical path so aliases collapse.
- Raw repository paths, work item IDs, objective hashes, generation IDs,
  prompts, diffs, output, environment, file contents, and model rationale are
  never persisted.
- The reported probabilities retain their exact integer numerators over one
  bounded, globally reduced denominator. Reported actions are unique, sorted,
  carry immutable action-definition digests, and sum exactly to one.
  Zero-support candidates remain visible. A reported deterministic policy must
  be exactly one-hot.
- The reported selected action must be a positive-probability member of the
  reported action set.
- Policy version, learning epoch, campaign, eligibility-population digest,
  transient context stratum, and reported assignment time are mandatory. M460
  derives the persisted context-stratum digest with the protected host key.
- The complete receipt is domain-separated and authenticated with the existing
  protected provenance key.

## Authority

Every receipt permanently carries:

```json
{
  "authority": "observation-only",
  "executionAuthority": false,
  "policyEligible": false,
  "causalIdentifiability": "not-identifiable",
  "assignmentEvidence": "policy-reported",
  "timingEvidence": "policy-reported",
  "preExposureVerified": false,
  "denominatorComplete": false
}
```

No M460 API chooses an action or changes fleet behavior. A later release must
prove eligibility-denominator closure, assignment timing, the behavior policy,
exposure, and outcome populations before any policy may consume these records.
The receipt authenticates what the policy reported. It does not prove that the
reported action set was complete, that a reported randomizer was implemented
correctly, or that persistence preceded execution.

## Persistence And Reads

- Receipt files and their parent directories must have exact private ownership
  and modes.
- Publication uses an exclusive private stage, file fsync, a no-clobber hard
  link, stage removal, and directory fsync while holding the local-store lock.
- The first receipt for an assignment unit wins. Exact repeats are replays;
  different assignments for the same unit are conflicts.
- Readers never create locks or repair keys. They pin one existing provenance
  key, pin directory and file identities, require canonical JSON bytes, compare
  bounded directory snapshots, and reject active writers, aliases, symlinks,
  torn or duplicate-key records, unknown fields, malformed probabilities,
  digest or MAC failures, and filename-to-unit mismatches.
- Missing sources are missing and incomplete. Any integrity, key, race, option,
  or bound failure is degraded and incomplete. `requireComplete` withholds all
  partial rows. `denominatorComplete` remains false in every state.
