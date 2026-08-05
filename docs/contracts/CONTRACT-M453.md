# M453 Privacy-Safe Skill Calibration Snapshot Projection

## Purpose

M453 is a pure, bounded projector that converts private source-owned skill and
case text into an M450 `SkillRoutingCalibrationSnapshotV1`. It closes the data
preparation gap between settled source observations and M450 without adding a
runtime learning consumer or persisting raw source material.

M453 is based on the direct-master M450 branch. It has no relationship to the
external-skill execution or admission stack.

## Private Input

The caller supplies two direct Node `Buffer` values:

- A bounded canonical UTF-8 JSON source document.
- A separate 32-byte source-held HMAC key.

The source document contains immutable source and router-policy revisions,
complete source-quality metadata, skills, and cases:

- Complete source-quality counters and state.
- Skills with private source identifiers and bounded text parts.
- Positive-owner and negative-owner cases with private source identifiers,
  canonical timestamps, ownership references, and bounded text parts.

Only direct, non-shared `Buffer` instances are accepted. The source bytes are
bounded before UTF-8 decoding or JSON parsing, eliminating proxy traps,
accessors, custom iterators, and pre-clone memory amplification from the
verification boundary. The JSON encoding must be minified and canonical with
the contract field order; whitespace variants, duplicate keys, alternate
escapes, unknown fields, and noncanonical key order fail closed.

The parsed runtime schema is exact. Sparse arrays, malformed timestamps,
invalid ownership, duplicate source identifiers, empty vectors, degraded or
incomplete source state, nonzero quality counters, and declared or observed
limit overflow fail closed.

## Projection

M453 emits the exact `m453-token-counts-v1` projection policy and accepts only
M450's exact `m450-tfidf-v1` evaluator policy. It lowercases and tokenizes
ASCII alphanumeric terms in memory using its versioned, deterministic policy.
Stop words and tokens outside the bounded length are removed. It derives:

- Skill identifiers with a skill-ID HMAC domain.
- Case identifiers with a case-ID HMAC domain.
- Term identifiers with a term-ID HMAC domain.
- Sparse positive-integer term vectors from local token counts.

The copied source bytes, canonical comparison bytes, and source key are zeroed
before return. Decoded JavaScript strings are garbage-collected runtime values
and cannot be reliably zeroed in place, so callers must still treat the
projection process as a private-data boundary. Caller-owned buffers remain the
caller's responsibility. Raw identifiers, text, tokens, and key bytes are never
included in the result.

The successful snapshot contains only opaque 64-character HMAC identifiers,
integer counts, canonical timestamps, immutable revision labels, and source
quality metadata. Skills, cases, and vector terms are canonically sorted, so
independent reads of equivalent input produce semantically identical M450
snapshots.

This projection policy is an offline TF-IDF calibration representation. It
does not claim to reproduce the active `verified-skills-v1` weighted-field
retriever. A later champion/challenger comparison must calibrate and identify
each policy separately before any randomized behavioral experiment.

## Authority

Every result is:

- `authority: "observation-only"`
- `routingAuthority: false`
- `learningAuthority: false`
- `policyAuthority: false`
- `promotionAuthority: false`
- `mergeAuthority: false`

`state: "projected"` means only that a bounded metadata snapshot was
constructed. It does not mean the source was independently authenticated, the
snapshot was persisted, routing quality passed M450, or any policy may change.
M450 still requires two independently obtained, stable snapshots and its
settlement, sample, collision, and accuracy gates.

M453 does not prove that two snapshots came from independent reads. That is a
caller precondition until a later receipt boundary binds separate source reads.
M450's case-count gate measures descriptive corpus coverage; it does not prove
independent sampling, causal lift, or generalization.

## Privacy And Scope

M453 performs no filesystem, ledger, network, clock, process, model, or
environment access. It emits no logs and returns no exception text. Its raw
input and snapshot types are internal and are not exported by the package
public type entrypoint.

M453 does not modify routing, activate skills, write learning data, create
proposals, wire a daemon, change CI or release behavior, or deploy anything.
