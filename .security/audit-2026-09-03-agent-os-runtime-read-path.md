# Security Audit: Agent OS Runtime Read Path

Date: 2026-09-03

Scope: the uncommitted Agent OS execution-identity, capability, vision, kernel, read-model, snapshot-store, standing-permit, web API, and cockpit tranche on `codex/v333-iteration`, plus dependency overrides changed during this audit.

Status: source-level audit; no installed artifact, daemon, release, provider, or live-effect activation was performed.

## Executive summary

No confirmed critical or high-severity vulnerability was introduced in the scoped Agent OS path. Focused Semgrep returned no findings, the final npm audit returned zero known dependency vulnerabilities, and Gitleaks returned no matches in the scoped changed files.

The principal residual trust limitation is explicit by design: the host-local provenance HMAC and same-user filesystem cannot prove resistance to a malicious same-user process or coordinated replacement with an older internally valid store. Every snapshot and public read response therefore reports `sameUserTamperResistant: false`, `rollbackProtected: false`, and `historicalAuthority: false`. An external monotonic or transparency anchor is required before those claims can change.

## Threat model

Protected assets:

- private Agent OS observations and source lineage;
- provider/account locators and credentials;
- repository, model, merge, release, deployment, publication, external-send, and destructive-effect authority;
- truthful source-quality and effectiveness claims shown in the cockpit.

Principal adversaries and failures:

- unauthenticated local web clients and cross-port loopback requests;
- malformed, replayed, forked, stale, or partially written observation records;
- prompt-injected or compromised agent output embedded in display metadata;
- concurrent writers and process crashes;
- compromised tools or providers attempting to convert observation state into effect authority;
- malicious same-user processes able to read the shared provenance key and replace local files.

## Findings and dispositions

### Remediated caller-asserted trust markers

Severity before remediation: High trust-boundary risk.

The first implementation accepted self-consistent records containing `preverified-*` marker strings for outcome evidence, the kernel evidence index, and public display metadata. Those strings established format and digest association but did not authenticate an independent observer or prove that the displayed claim was true. A coherent caller-authored bundle could therefore look verified.

Disposition:

- marker strings were replaced by neutral format identifiers;
- outcome evidence now requires an injected verifier that confirms both authentication and observer independence;
- kernel evidence completeness requires an injected evidence-index verifier;
- the read model requires authentication of its exact source bundle and fails closed without a verifier;
- effective, refuted, and guardrail classifications require verified non-null outcome evidence;
- arbitrary caller display prose was removed and replaced with a closed deterministic template projection;
- the default snapshot writer has no production verifier and therefore rejects writes until an adapter is deliberately supplied;
- adversarial tests cover a coherent replacement bundle and structurally valid forged effective/refuted decisions with missing evidence.

### Remediated signed-tip crash residue

Severity before remediation: High availability/recovery risk.

The first signed-tip implementation could leave a fixed temporary file after a crash and permanently wedge later writers on exclusive creation. The original failure-injection test stopped before temporary-file creation and did not cover this state.

Disposition:

- recovery operates under the existing transaction lock and only after a complete authenticated record-chain read;
- only the exact fixed tip-temp path is considered;
- regular-file identity, owner, 0600 mode, single-link count, size, and stable read are checked without following symlinks;
- a valid signed temp can finalize only when it matches the authenticated current head and the installed tip is absent or authentically older;
- malformed, widened, symlink, stale, or conflicting residue is exact-inode rechecked before unlink, and the anchor directory is fsynced;
- tests cover valid, partial, widened-permission, symlink, stale, and conflicting residues.

### Remediated standing-permit self-verification and scope

Severity before remediation: High trust-boundary risk.

The first permit evaluator accepted a `preverified-ed25519-v1` claim and head/floor values from the same caller bundle. A fully coherent forged bundle could satisfy the canaries, and the low-risk class was broad enough to include higher-impact repository effects.

Disposition:

- every evidence receipt requires an injected verifier;
- the current head, minimum sequence, suffix base, and predecessor require a separately verified current anchor;
- missing verifiers fail signer, replay, and evidence-health canaries;
- a bounded suffix supports long histories without accepting a caller-controlled sequence reset;
- only workspace editing and model dispatch may be policy-eligible;
- commit, proposal, push, merge, release, deploy, external-send, and destructive capabilities remain categorically ineligible;
- the contract remains inert, unexported, and disconnected from effect authority.

### Accepted trust limitation: same-user forgery and historical rollback

Severity: Medium if misunderstood; explicitly represented and not accepted as authority.

The provenance key is host-local and shared by same-user Hub components. The immutable private-record store defends against accidents, races, permission widening, symlinks, malformed files, and incomplete reads; it is not a hardware or external trust anchor. A same-user attacker with key and filesystem access can forge an observation or roll back both records and the signed local tip.

Disposition:

- public and private contracts publish false tamper/rollback/historical-authority flags;
- degraded or incomplete chains withhold the current snapshot;
- the standing-permit evaluator consumes preverified evidence but grants no authority;
- future historical assurance is blocked on an external monotonic/transparency anchor.

### Remediated dependency advisories

Severity before remediation: High (transitive `fast-uri`) and Moderate (`qs`).

Initial `npm audit` reported three vulnerability entries: `fast-uri`, its `ajv` dependency path, and `qs`. The root cause was a stale `fast-uri@3.1.5` override and `qs@6.15.2` through the bundled MCP SDK dependency.

Disposition:

- pinned compatible patched transitive releases `fast-uri@3.1.6` and `qs@6.16.0`;
- refreshed `package-lock.json`;
- final audit: 0 vulnerabilities across 434 dependencies.

### Baseline Semgrep findings outside the scoped path

Severity: triaged; no new scoped finding.

Repository-wide Semgrep reported existing findings including Windows-only `spawn(..., { shell: true })` browser launchers, a loopback-only cleartext Ollama health request to `127.0.0.1`, dynamic regular-expression warnings, and prototype-pollution heuristics. Manual inspection confirmed the two shell uses execute fixed platform commands with a separately passed URL argument, the HTTP request is pinned to loopback, and the modified effective-config traversal uses an own-property check.

Semgrep also reported parser errors for several TypeScript constructs and a timeout on the generated legacy web bundle. These limit the completeness of the repository-wide automatic scan. A focused scan of the new Agent OS, standing-permit, API, and UI paths completed with zero errors and zero findings.

Disposition: no scoped blocker. The repository-wide baseline should be addressed in a separate hardening tranche, including rule suppressions only after source-specific review.

### Secret-scanner findings are fixtures or non-secret constants

Severity: Informational after triage.

Gitleaks scanned the current working tree and reported 81 matches. Seventy-six were deliberate test fixtures exercising secret detection/redaction. The two source matches were a localStorage preference key and a synthetic API-key string used by the runtime scrub self-check. The remaining matches were generated build metadata/bundles and a test-worker configuration token. The scoped Agent OS changed-file filter returned zero matches.

Disposition: no confirmed secret. Do not blanket-ignore the repository-wide findings; preserve fixture-specific allowlisting or fingerprint review so future real credentials remain detectable.

### Native and install-script dependency surface

Severity: Informational.

Native modules present are Rollup's macOS binary and `fsevents`, both development/build dependencies. `esbuild` has a postinstall binary-selection script and is also build tooling. Package metadata points to the upstream Rollup, fsevents, and esbuild projects with MIT licenses. No new native or install-script dependency was added by this tranche.

## Security controls verified

- `GET /api/agent-os` inherits the server's default-deny read-session/token boundary; missing and incorrect credentials return 401.
- No Agent OS POST, write, dispatch, merge, release, deploy, or external-effect endpoint exists.
- The public API omits envelopes, HMACs, key IDs, digests, sequences, filesystem paths, and private source internals.
- The private writer accepts the complete `AgentOsReadModelInputV1`, rebuilds it with the fail-closed verifier, and persists only a successful projection and its exact digest.
- Records are HMAC-authenticated, domain-separated, bounded, private, immutable, sequence-linked, predecessor-linked, and read as a complete aggregate.
- Transaction locking covers sequence selection and publication; the next authenticated writer reconciles the safe record-ahead-of-tip crash state.
- Exact replay is idempotent; malformed records, gaps, broken predecessors, non-monotonic time, permission widening, and inconsistent tips degrade and withhold current state.
- Display fields are bounded and reject credential, account, URL, and local-path patterns.
- The cockpit renders only healthy, complete, authenticated snapshots with every effect-authority and tamper-resistance field exactly false.
- Standing-permit eligibility is separated from grant and execution; every authority/effect output is hard false.
- The new persistence and permit modules are absent from public package exports and are not daemon-scheduled.

## Verification evidence

- Focused scoped Semgrep: 0 findings, 0 errors.
- Final npm audit: 0 vulnerabilities.
- Scoped Gitleaks filter: 0 matches.
- New/adjacent backend tests M526-M534: 9 files, 99 passed, 1 platform-specific skip.
- Full web suite: 29 files, 107 passed.
- Full core and web TypeScript: passed.
- Focused ESLint: 0 errors; one pre-existing unrelated unused-variable warning.
- Production build: passed; 183 web modules transformed.
- `git diff --check`: passed.

The monolithic backend suite was not run in this tranche; the focused integration matrix and full web suite are the available evidence.

## Required follow-on controls

1. Add durable production sources for mission, capability, portfolio, hypothesis, and redacted display metadata before scheduling a writer.
2. Add an external transparency, secure-enclave, or otherwise independently monotonic anchor before claiming historical rollback resistance.
3. Connect future standing-permit decisions only through the existing activation-permit and effect-journal mechanisms, with immediate pre-effect revalidation.
4. Add a post-durable-tick observer with overlap suppression, deadline, cancellation, kill/revocation checks, allowlisted environment, and durable attempt receipts.
5. Maintain a reviewed Gitleaks fixture allowlist and resolve the repository-wide Semgrep parse gaps in a dedicated baseline-hardening effort.
