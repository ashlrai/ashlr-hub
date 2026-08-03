# M454 Pinned Upstream Routing Challenge

## Purpose

M454 defines a test-only routing challenge derived from
`addyosmani/agent-skills` commit
`ff2df4c07e7836a092ed28e1e9b42f4d6009280c`. It measures whether an Ashlr
skill-routing policy can distinguish positive owners from explicit negative
owners on a fixed external corpus. It does not import, activate, execute, or
trust the upstream skills.

M454 is an offline evaluation fixture only. It has no runtime consumer and
grants no routing, learning, policy, promotion, proposal, verification, merge,
release, or deployment authority.

## Pinned Fixture

The fixture is derived from immutable blobs in the exact upstream Git tree
named above. The generator reads those Git objects twice and compares the
selected-source and canonical-source projections before writing either
fixture. It never reads the mutable upstream worktree.

Mutable branches, tags, release archives, and later upstream revisions are not
equivalent inputs. Any content change requires a new fixture revision, digest,
and review.

The checked-in challenge representation contains only:

- A versioned fixture schema and extraction-policy revision.
- Pinned commit, tree, selected-source, canonical-source, license,
  implementation, and opaque snapshot digests.
- Pseudonymous, domain-separated HMAC identifiers for skills, cases, and terms.
- Bounded sparse positive-integer term vectors.
- Positive-owner and negative-owner relationships expressed with opaque
  identifiers.
- Bounded completeness counters needed to detect omission.

The fixture must not contain or return skill text, descriptions, prompts,
expected answers, paths, filenames, command text, code, stdout, stderr,
environment values, model prose, or upstream file contents. The repository
identifier and pinned Git object identifiers are allowed provenance metadata.
HMAC keys remain outside the fixture and are never persisted, returned, or
committed. The public corpus and retained ownership topology can make records
structurally re-identifiable; M454 is pseudonymized, not anonymous.

Generation uses a fresh random 32-byte HMAC key, shared only across the two
source reads within that invocation. The generator best-effort zeroizes its
buffers after projection; it does not claim erasure from runtime, library,
crash-dump, swap, or hardware copies. It
publishes neither the key nor a key commitment. Exact opaque fixture-byte
regeneration is therefore intentionally unsupported. A later run against the
same reviewed objects and implementation must reproduce the same coverage,
ownership topology, evaluator state, and aggregate diagnostics, while producing
different opaque identifiers and a different snapshot digest.

The reviewed extraction maps each skill to `[name, name, description]`, includes
all 76 positive triggers, and records the upstream positive `top_k` histogram
of four top-1 and 72 top-3 cases. M454 intentionally discards `top_k` during
projection and reevaluates every positive under M450's strict rank-one rule.
Its rank-one accuracy is not the upstream corpus's declared-top-k pass rate.
The extraction includes 38 negative triggers only when upstream
declares a distinct owner. It does not infer owners for the other 10 negative
triggers. The 29 behavioral cases are out of scope and cannot be used to fill
routing sample quotas. The resulting fixture contains 24 skills, 114 routing
cases, and references 48 selected source files.

Extraction is semantically deterministic, bounded, and non-executing. It must
not run upstream-provided scripts, hooks, installers, commands, tools, models,
or network requests. Any selected-source byte change fails the pinned source
digest. Missing required fields, duplicate identities, malformed ownership,
noncanonical projected input, invalid vectors, incomplete extraction, and bound
overflow fail closed. Upstream fields outside the reviewed extraction remain
out of the fixture; the M450/M453 projected schemas reject unknown fields.

The generator writes only the two fixed M454 fixture paths. It stages
owner-private temporary files with exclusive, no-follow creation and atomically
renames each file. The pair is content-bound by `snapshotDigest`, not claimed as
a multi-file atomic transaction. It binds the reviewed source and compiled
M450/M453 projection implementations plus the extractor digest; a stale or
modified implementation fails generation. Compiled modules are normalized to
reviewed LF bytes, hashed, staged, and executed from those same canonical bytes;
the extractor is bound by its exact raw-byte digest. It requires an explicit absolute,
root-or-invoker-owned, non-writable Git executable, disables replacement objects
and lazy fetching, rejects promisor/partial repositories and object alternates,
and reads only the pinned local object database. Output path components must be
direct repository directories, and verified compiled bytes execute only from an
owner-private temporary module directory.

## Evaluation

M454 submits the opaque fixture to the exact M450 evaluator policy named by the
fixture. It does not replace, relax, or reinterpret M450.

M450's insufficient-sample rule remains unchanged: every skill must have at
least five settled positive-owner cases and three settled negative-owner cases.
A pinned upstream skill that does not meet both minimums remains `collecting`
with `insufficient-sample`; M454 must not synthesize, duplicate, relabel, pool,
or silently omit cases to make the gate pass. Aggregate coverage from other
skills cannot satisfy a deficient skill.

M450 continues to recompute scores, ranks, ties, collision thresholds, and
accuracy from the supplied vectors. M454 cannot provide caller-asserted
outcomes or turn a threshold failure into readiness. The sample gate measures
descriptive fixture coverage only; it is not evidence of statistical
independence, generalization, causal lift, production quality, or safe skill
activation.

For the pinned corpus, the current descriptive result is `collecting` with
`insufficient-sample`: 54 of 76 positive cases rank their owner first; in 29 of
38 negative-owner cases, the declared owner strictly outscored the paired
excluded skill. The latter is pairwise, not an owner rank-one or global
exclusion result. No skill meets the joint sample gate, and no pair crosses the
M450 collision warning threshold. These values describe this fixture under the
named policy only. They are not readiness, generalization, causal, or
active-router evidence.

Aggregate evaluator results expose only fixed states, policy revisions, bounded
aggregate counts, rates, threshold constants, and opaque digests. They do not
return per-case prompts, terms, identifiers, vectors, scores, or upstream
content. The checked-in pseudonymous fixture itself retains bounded vectors and
ownership topology for offline testing.

## Provenance And Custody

The pinned commit, trees, object digests, extraction policy, extractor digest,
and M450/M453 implementation digest identify the source material and
transformation the fixture claims to represent. Aggregate regeneration can show
semantic agreement with that claimed source and policy; it cannot reproduce
exact opaque bytes without the ephemeral key.

The M444 pack, portable-pack, and external-audit-policy digests are declared
cross-references. M454 does not recompute or authenticate them. Provenance is
therefore explicitly `review-pinned-unverified`,
`externalAuditTrialReady: false`, and not a custody receipt.

That identity is not authenticated custody. M454 does not prove who acquired
the upstream tree, that acquisition used an authenticated channel, that the
object database was under authenticated custody while read, that an independent
custodian repeated the read, or that the fixture remained under trusted custody
after generation. A later receipt-bound boundary must separately bind
authenticated acquisition, immutable storage, extractor identity, extraction
policy, signer identity, and custody transitions before provenance may be
treated as verified.

Missing, invalid, expired, or unavailable custody evidence cannot be inferred
from a matching fixture digest and must fail closed wherever authenticated
provenance is required.

`observedAt` and `asOf` are evaluator-fixture timestamps used only to exercise
M450 settlement behavior. They do not claim that a production observation,
dispatch, or experiment occurred at those times.

## Authority Firewall

Every M454 result is observation-only and carries:

- `authority: "observation-only"`
- `routingAuthority: false`
- `learningAuthority: false`
- `policyAuthority: false`
- `promotionAuthority: false`
- `proposalAuthority: false`
- `verificationAuthority: false`
- `mergeAuthority: false`
- `releaseAuthority: false`
- `deploymentAuthority: false`

No result, including a complete fixture or passing M450 calibration, may select
a skill, alter a prompt, change a router, train a policy, create a proposal,
weaken verification, approve or merge a change, activate external content, or
authorize release or deployment.

## Scope Exclusions

M454 does not add a daemon, CLI, router, learning, proposal, verification,
merge, release, deployment, or public API consumer. It does not write runtime
ledgers, load upstream skill bodies into prompts, clone or synchronize external
content at runtime, perform behavioral model evaluation, or modify production
configuration.

Any future shadow or active experiment requires a separate contract with
authenticated custody, deterministic assignment, privacy-safe outcome
telemetry, explicit stop criteria, and independent activation authority.
