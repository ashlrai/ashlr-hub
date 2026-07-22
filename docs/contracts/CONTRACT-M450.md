# M450 Skill Routing Calibration V1

## Purpose

`SkillRoutingCalibrationV1` is a pure, observation-only evaluator for measuring whether a skill router can distinguish known owners from competing skills. It has no runtime consumer and grants no routing, learning, policy, promotion, or merge authority.

M450 is independent of the external-skill intake stack and is based directly on `origin/master`.

## Input Contract

The caller supplies an explicit canonical `asOf` timestamp and two independently read metadata snapshots. The evaluator never reads a ledger, filesystem, network source, clock, prompt, skill body, or description.

Each snapshot contains only:

- An immutable source revision and router policy version.
- Complete source-quality counters and state.
- Skills represented by opaque, source-keyed HMAC identifiers and sparse positive-integer term vectors.
- Cases represented by opaque HMAC identifiers, an owner relationship, a canonical observation timestamp, and a sparse positive-integer term vector.
- Negative-owner cases additionally name one excluded skill that the owner must outrank.

Skill, case, and term identifiers must be 64-character lowercase hexadecimal HMAC outputs. Producing those HMACs with a source-held key and domain separation is the source's responsibility; the key and source values never enter M450.

The runtime schema is exact. Unknown fields, empty vectors, duplicate identifiers, duplicate vector terms, malformed ownership, invalid timestamps, non-integer counts, and non-canonical identifiers are rejected. Arrays and vector width are bounded, and declared or observed limit overflow fails closed.

## Repeatable Snapshot Rule

Both snapshots are independently validated, canonically ordered, and compared across all metadata. Ordering differences are harmless. Any semantic difference in source identity, policy identity, quality state, skills, cases, timestamps, or vector values yields `snapshot-mutation` and withholds the result.

The evaluator uses the explicit `asOf` value only. Cases observed after `asOf` are invalid. Cases newer than `asOf - 2 minutes` are excluded from calibration. An empty source or a source whose cases are all inside that settlement window returns `collecting`, never a healthy zero.

## Calibration Math

M450 recomputes all values from sparse vectors. Caller-supplied ranks, scores, similarities, and outcomes are not accepted.

1. Document frequency is computed across skill vectors.
2. Each term uses `idf = ln((1 + skillCount) / (1 + documentFrequency)) + 1`.
3. Raw positive-integer term frequency is multiplied by IDF.
4. Case-to-skill and skill-to-skill similarity use cosine similarity.
5. A positive-owner case passes only when its owner has a nonzero score strictly greater than every competitor. Ties fail.
6. A negative-owner case passes only when its owner strictly outranks its declared excluded skill. Ties fail.
7. Skill-pair similarity at or above `0.50` is a warning; similarity at or above `0.75` is an error.

The sample gate requires at least five settled positive-owner cases and three settled negative-owner cases for every skill. Calibration readiness then requires:

- Global positive rank-one accuracy of at least `80%`.
- Positive rank-one accuracy of at least `80%` for every skill.
- Negative-owner accuracy of exactly `100%`.
- Zero collision errors.

Aggregate success cannot hide a failing individual skill. Insufficient samples return `collecting`. Sample-complete calibration below any quality threshold returns `withheld`. Passing calibration returns `ready`, but remains observation-only.

## Public Output

The output contains fixed enums, timestamps, bounded aggregate counts, rates, and threshold constants only. It does not expose skill, case, or term references; source revisions; policy versions; digests; prompts; descriptions; paths; model prose; diffs; stdout; stderr; argv; commands; environment values; or exception text. The package's public type entrypoint exports only aggregate result types; private snapshot, case, skill, and vector input types stay internal.

Every result includes:

- `authority: "observation-only"`
- `routingAuthority: false`
- `learningAuthority: false`
- `policyAuthority: false`
- `promotionAuthority: false`
- `mergeAuthority: false`

No M450 output is sufficient evidence for activation, routing, learning, promotion, merge, release, or deployment.

## Scope Exclusions

M450 does not import `skill-retrieval`, read learning or proposal ledgers, mount or execute skills, activate external content, modify routing, wire a daemon or web consumer, change CI or release behavior, or deploy anything.
