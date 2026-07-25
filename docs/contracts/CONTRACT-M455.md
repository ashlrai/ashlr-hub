# CONTRACT-M455: External Skill Maturity Readiness

Status: observation-only, fail-closed

M455 joins the external-skill quarantine evidence from M444-M451 with the
privacy-preserving routing calibration from M450-M454. It does not activate,
route to, expose, execute, promote, revoke, or otherwise authorize an external
skill.

## Purpose

The contract answers one narrow question:

> What is the highest external-skill maturity state that the evidence currently
> supports without converting missing controls into optimistic labels?

The maturity ladder is:

1. `quarantined`
2. `structurally-valid`
3. `routing-valid`
4. `sandbox-trialed`
5. `shadow-observed`
6. `verified-active`
7. `revoked`

M455 v1 can project only `quarantined`. Every later state is defined so its
missing evidence is visible, but no later state is reachable.

## Input Boundary

`projectExternalSkillMaturity()` accepts a closed-schema object containing:

- a canonical `asOf` timestamp;
- optional exact M444 report and M451 receipt bytes plus the selected skill
  name; and
- optional first and second M450 snapshot bytes.

It does not accept:

- a caller-supplied maturity state or previous transition;
- caller-supplied `verified`, `eligible`, `complete`, or authority booleans;
- caller-supplied verifier results;
- trust roots, signing keys, policy approval, revocation claims, or clocks;
- custody, trial, shadow, activation, or revocation summaries; or
- raw prompts, outputs, diffs, environment, stdout, stderr, or file contents in
  its output.

M455 copies and bounds byte inputs. It reruns the repository-owned M451 audit
receipt verifier and M450 calibration evaluator internally. Routing snapshot
identities use canonical JSON digests so whitespace and object-key order do not
change the evidence root. Evidence that exceeds the canonicalization bound is
withheld and marked degraded; no raw snapshot identity enters the evidence root.

## Honest Reachability

`quarantined` is the default state for untrusted content. It grants no
authority.

`structurally-valid` remains blocked even when an M451 test receipt has a valid
signature. M451 still reports no exact capture-receipt binding, trusted clock,
online revocation, independent verifier principal, one-use replay protection,
or append-only transparency. Production also ships with no M451 trust roots.

`routing-valid` remains blocked because M450:

- is aggregate and does not bind a result to one selected skill lineage;
- evaluates `m450-tfidf-v1`, not the active `verified-skills-v1` retriever;
- accepts caller-asserted independent snapshots; and
- uses corpus-fit thresholds without held-out provenance or confidence-bound
  policy.

M454 is a pinned regression challenge, not promotion evidence. Its current
snapshot is sample-incomplete and its upstream provenance is not authenticated.

`sandbox-trialed` remains blocked because M445 has no authenticated custody,
sealed runner, independently verified exposure receipt, independent outcome
principal, or global replay authority. A caller-held HMAC key cannot establish
those facts.

`shadow-observed` remains blocked because no verifier-signed production shadow
receipt, adverse-event policy, or no-effect exposure contract exists.

`verified-active` remains blocked because no independent activation receipt,
rollback canary evidence, or runtime configuration attestation exists.

`revoked` remains blocked because verifier-key revocation is not candidate
revocation. A later milestone must add an append-only, lineage-bound candidate
revocation receipt. Revocation is orthogonal to promotion: it must be reachable
from any non-revoked state and terminal for that exact lineage.

## Output

A projected result contains:

- `highestDefensibleState: quarantined`;
- `nextState: structurally-valid`;
- one ordered stage record for every maturity state;
- stable, typed blockers per stage;
- bounded M451 and M450 result metadata;
- `sourceState: degraded` whenever supplied audit or routing evidence is
  withheld or degraded, so unusable evidence never appears healthy;
- a domain-separated evidence root; and
- fixed false authority fields.

Malformed top-level input is withheld with no caller-controlled digest or
metadata.

Every result fixes:

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
globalReplayProtectionVerified: false
```

The evidence root binds accepted canonical evidence and verifier observations.
Malformed or over-limit routing bytes are withheld without receiving a raw
snapshot identity.
M451 deliberately uses the verifier's current clock and repository revocation
state, so its observation and the resulting root may change as evidence expires
or revocation knowledge advances. The root is not a signed receipt, append-only
head, nonce-consumption proof, or global replay defense.

## Runtime Firewall

M455 is not exported from the runtime package API and has no CLI, daemon,
router, dispatcher, prompt, learning, proposal, verification, merge, release,
or deployment consumer. Public package access is type-only.

M455 may call M451 and M450 as a dedicated verifier composition edge. That edge
does not grant their outputs authority and is covered by a statically
resolvable source import firewall.

## Required Future Controls

Higher states require separate repository-owned verifiers for:

- immutable candidate lineage and exact capture reread;
- trusted time, online revocation, one-use envelopes, and transparency;
- candidate-bound calibration against the actual runtime retriever;
- independent held-out data and confidence-bound acceptance policy;
- disposable no-network sandbox execution with authenticated exposure and
  outcome evidence;
- verifier-signed production shadow observation;
- independent canary activation and rollback evidence; and
- append-only candidate revocation with compare-and-swap head continuity.

Actual execution must still require a fresh, scoped, one-use runtime
authorization envelope after any maturity projection reaches
`verified-active`.
