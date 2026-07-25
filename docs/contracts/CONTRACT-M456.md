# CONTRACT-M456: Candidate-Bound Shadow-Router Calibration

## Purpose

M456 measures one audited external candidate against the exact metadata scoring
kernel used by `verified-skills-v1`. It closes two diagnostic gaps:

1. M450 evaluates a different TF-IDF router.
2. M454 is not bound to one M451-selected candidate.

M456 is observation-only. It does not admit a candidate, release post-merge
credit, make a card eligible, select a runtime skill, modify a prompt, authorize
exposure, or clear a maturity transition.

The production retrieval path remains dormant:

- `skill-retrieval.ts` has no active or injection mode;
- generic skill-card attestations cannot establish post-merge credit;
- no external candidate is converted into an eligible `SkillCard`; and
- the shadow observer rejects non-empty selections.

Accordingly, M456 may claim `scoringKernelEquivalent:true` but must retain
`runtimeRouterEquivalent:false`.

## Private Inputs

`evaluateSkillRetrievalCalibration()` accepts a closed-schema object containing:

- one canonical `asOf`;
- exact M451 report and audit-receipt bytes plus the selected skill name;
- exact selected `SKILL.md` bytes;
- two exact canonical JSON snapshots.

The evaluator owns bounded copies of every byte input. It rejects proxies,
generic typed arrays, shared backing memory, invalid UTF-8, noncanonical JSON,
duplicate-key encodings, unknown fields, oversized content, and malformed
timestamps.

The snapshots contain:

- exact policy `verified-skills-v1`;
- one source revision and caller-declared quality counters;
- M451 report, receipt, pack, portable-pack, selected-name, and selected-content
  bindings;
- the submitted candidate set and bounded metadata used by the scoring kernel;
- settled positive-owner and negative-owner cases;
- opaque case, cluster, and source-group identities.

Caller-supplied verdicts, confidence labels, independence claims, eligibility
booleans, runtime selections, maturity states, and authority flags are rejected.

## Candidate Binding

M456 reruns the code-owned M451 verifier. It then requires the selected
`SKILL.md` bytes to hash to the M451 `selectedSkillContentHash`.
M456 additionally requires canonical UTF-8 bytes, so decoder-normalized
alternate encodings such as a leading BOM are withheld even if an older M444
report accepted their decoded text identity.

Only a deterministic external-candidate mapping enters the scorer:

```text
candidateId   = selectedSkillContentHash
name          = canonical frontmatter name
summary       = canonical frontmatter description
tags          = []
taskKinds     = []
commandKinds  = []
```

The same M444 frontmatter parser and content hashing rules produce this mapping.
Snapshot metadata for the selected candidate must match it exactly. Arbitrary
caller tags, task kinds, command kinds, names, or summaries cannot be attached
to the audited hash.

This proves binding to M451 audit identity only when a current code-owned M451
root authenticates the receipt. It does not prove M446 capture/custody lineage,
which remains a fixed blocker.

## Exact Scoring Kernel

`rankSkillRetrievalCandidates()` is the one metadata-only scoring function used
by both M356 shadow selection and M456. It retains:

- the `verified-skills-v1` policy identity;
- query-field weights `6/5/3/2/1`;
- candidate-field weights `6/5/4/2/1`;
- bounded tokenization and secret/payload sanitation;
- production query-tag order, duplicates, and live 50-tag input bound before
  the shared scorer applies its first-16/48-term limits;
- six-decimal score quantization;
- score-descending and candidate-ID tie ordering.

The function performs no lifecycle eligibility, routing, persistence, prompt
mutation, or external-content execution. It returns only candidate identity,
rank, score, and matched-field enums.

Shared code proves scorer parity. It does not prove that the tested candidate
could pass runtime eligibility, that a compiled production release contains the
same build, or that the external mapping is an admitted `SkillCard`.

## Settlement And Denominator

Both snapshots must be byte-identical canonical JSON and normalize to the same
semantic value. This detects submitted mutation but does not prove distinct
verifier-owned reads; `distinctReadReceiptsVerified` remains false.

Cases newer than `asOf - 2 minutes` are excluded. Cases after `asOf` are
invalid. Empty settled evidence reports `collecting`, never a healthy zero.

The submitted source must declare itself complete and healthy with zero invalid,
duplicate, or conflicting rows and no exceeded limit. Candidate IDs, case IDs,
and cluster IDs are unique. Cases with the same owner/exclusion and the same
weighted scorer-term fingerprint are rejected even when transport text,
punctuation, case, or caller-minted identities differ. Every owner and exclusion
refers to the submitted candidate set. Selected-candidate omission or identity
conflict fails closed. Omission of an unauthenticated competitor is not
detectable.

Successful projections therefore report `sourceState:'declared-healthy'`, while
`sourceCompletenessVerified` remains false. M456 never upgrades a caller's
completeness declaration into verified source health.

The authenticated audit and supplied raw `SKILL.md` bytes bind only the selected
candidate's deterministic name-description projection. Competitor metadata and
the completeness of the submitted choice set are not independently
authenticated. Accordingly, `selectedCandidateBindingVerified` may be true
while `choiceSetBindingVerified` is permanently false.

## Descriptive Quality Gates

For every candidate, M456 requires:

- at least 50 declared positive clusters;
- at least 60 declared negative clusters;
- at least five source groups for each case kind;
- no source group above 25 percent of either denominator.

A positive passes only when the owner is in the deterministic operational
top-two set with a positive score. Rank-one is reported separately.

A negative passes only when its owner is selected, its excluded candidate is
not selected, and the owner has a positive score.

M456 computes descriptive one-sided Wilson statistics for each candidate using
the nominal 95 percent formula. It does not establish independent Bernoulli
trials, marginal coverage, or simultaneous coverage across the submitted set;
`marginalConfidenceVerified` and `simultaneousConfidenceVerified` remain false.
Descriptive thresholds are:

- minimum per-candidate positive-selection lower bound at least 0.80;
- minimum per-candidate negative-exclusion lower bound at least 0.95.

Operational metrics preserve the shared scorer's deterministic candidate-ID
tiebreak. A rank-two/rank-three score tie increments
`ambiguousCutoffCases` and fails the descriptive statistic threshold without
rewriting what the operational selector actually selected. Exact normalized
query duplicates and reused cluster IDs cannot inflate the denominator.
Paraphrases and caller-assigned source groups still require verifier-owned
provenance before they can be treated as independent.

Even perfect samples report `gate:'collecting'` and
`reason:'evidence-collected'`. M456 cannot authenticate that a developer-visible
fixture is blinded, independently labeled, held out before policy freeze, or
unavailable during development.

## Output And Privacy

The result contains only:

- fixed enums and authority booleans;
- aggregate sample counts and rates;
- minimum per-candidate descriptive Wilson statistics;
- bounded source/audit reasons;
- a digest of the full submitted scoring metadata and an evidence root.

It never returns skill prose, candidate names or IDs, query text, case or group
IDs, prompts, diffs, paths, commands, stdout, stderr, environment values,
signatures, keys, trust policies, or file contents.

Malformed or unknown-field snapshots receive no evidence identity. Valid
identities remain pseudonymous commitments, not anonymity.

## Fixed Authority Boundary

Every M456 result fixes these fields:

```text
authority: observation-only
executionAuthority: false
exposureAuthority: false
routingAuthority: false
learningAuthority: false
policyAuthority: false
promotionAuthority: false
proposalAuthority: false
verificationAuthority: false
mergeAuthority: false
releaseAuthority: false
deploymentAuthority: false
transitionAuthority: false
revocationAuthority: false
runtimeRouterEquivalent: false
runtimeBuildAttestationVerified: false
independentHeldoutVerified: false
distinctReadReceiptsVerified: false
trustedClockVerified: false
captureReceiptBindingVerified: false
appendOnlyTransparencyVerified: false
choiceSetBindingVerified: false
sourceCompletenessVerified: false
simultaneousConfidenceVerified: false
marginalConfidenceVerified: false
```

M456 has no CLI, daemon, scheduler, web, MCP, dispatch, proposal, learning,
verification, merge, release, deployment, or activation consumer. Its public
package export surface is type-only. The compiled internal evaluator is present
inside the published `dist` tree, so this is export-map containment rather than
physical secrecy or an execution sandbox.

## Remaining Evidence

Before M455 may consume M456 to remove any routing blocker, a separate
verifier-owned receipt must bind:

- M446 capture/custody lineage;
- the exact immutable compiled release and dependency/runtime identity;
- two distinct stable source-read receipts;
- a complete choice-set head;
- blinded independent holdout provenance;
- trusted time, expiry, revocation, anti-rollback, and append-only transparency;
- the M456 result and fixed-false authority boundary.

Such a receipt may eventually remove only candidate-binding and scoring-policy
diagnostic blockers. It cannot establish structural validity, sandbox safety,
causal lift, activation authority, or verified-active maturity.
