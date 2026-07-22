# M445: Causally Honest External Skill Trials

## Scope

M445 defines a metadata-only experiment protocol for comparing one quarantined
external skill against an explicit no-skill control. It does not execute a
trial, persist a ledger, qualify a skill, or grant prompt, routing, learning,
proposal, verification, merge, or promotion authority.

The protocol is stacked on M444. A M444 `trialReady` report remains only an
intake signal. Trial content must be reacquired into an immutable sandbox input
and independently authorized before any execution runner may mount it.

## Frozen assignments

`buildExternalSkillTrialPlan()` accepts only content digests, a bounded policy
identifier, and at least eight case identities. It:

- derives each pair identity from the pack, skill, case, fixture, verifier, and
  execution-envelope digests;
- commits a minimum 256-bit randomization key without returning the key;
- requires one skill and one unique logical case per pair, preventing pooled
  skill effects and repeated-case sample inflation;
- assigns both `skill` and `no-skill` runs to every pair with randomized order
  and explicit `0.5` order propensity; and
- binds each run to a campaign and assignment digest before execution.

The complete frozen plan is authenticated with a distinct minimum 256-bit host
key. Evaluation recomputes every campaign, pair, run, order, and assignment
identity and verifies that attestation before counting any row. Serialized plan
truncation, extension, duplication, reordering, or unknown fields fail closed.
Both keys must come from a CSPRNG-backed host key authority and remain private;
the byte-length check is not an entropy estimator. Low-entropy, prompt-derived,
user-supplied, or reused keys are outside this contract.

Input order cannot change the plan. Duplicate pairs, malformed digests,
undersized populations, and oversized populations are rejected.

## Outcome boundary

`evaluateExternalSkillTrial()` accepts only closed-schema receipts. A complete
pair requires:

- the exact campaign, pair, assignment, verifier-contract, and execution-
  envelope identities from the frozen plan;
- `skill-mounted` exposure with the expected content hash for treatment;
- `no-skill-confirmed` exposure with no skill hash for control;
- a verified exposure receipt;
- a verified deterministic evidence receipt; and
- one terminal `passed|failed` outcome per arm.

The host-side attestor signs the complete bounded outcome tuple only after the
authorized runner has verified those two source receipts. The evaluator checks
that HMAC with the host key; booleans supplied by an untrusted caller cannot
assert verification. Reused exposure/evidence identities and contradictory
outcomes for identical artifacts withhold the campaign.

Missing rows are never silently excluded. Replays, conflicts, unknown rows,
identity drift, unsigned exposure, unsigned evidence, contamination, and
degraded sources withhold the entire effect.

## Reporting

Open incomplete campaigns report `collecting`. Closed attrition and all
integrity failures report `withheld`. Pass/fail counts, rates, confidence
intervals, and effect estimates remain absent until every frozen pair is
complete and the minimum sample is met.

A ready report contains arm rates, marginal descriptive Wilson 95% intervals,
paired discordance, and the descriptive randomized lift. It always states:

```text
authority: observation-only
policyEligible: false
promotionEligible: false
inference: descriptive-randomized-paired
```

The private execution plan and public report contain hashes, bounded
identifiers, counts, rates, and fixed enums only. They cannot contain pack text,
prompts, fixtures, diffs, stdout, stderr, paths, environment values, commands,
or model prose. The plan's source hashes are linkable metadata and must remain
inside private trial control storage. Only the aggregate evaluation may be
projected into Fleet OS, and it omits skill, case, fixture, and result hashes.

## Deliberate omissions

M445 does not yet provide immutable pack storage, a sandbox runner, host-key
storage, append-only persistence, sequential testing, multiplicity correction,
or Fleet OS projection. Those must be separate fail-closed layers. The
attestation helper is not a verifier: only an authorized host producer that has
already checked exposure and deterministic evidence may hold its key. In
particular, this protocol must not reuse `SkillUseEvent`, production trajectory
ledgers, route snapshots, proposal records, or decision records.
