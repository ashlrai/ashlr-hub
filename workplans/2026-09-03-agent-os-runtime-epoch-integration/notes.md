# Notes: Agent OS runtime epoch integration

## Starting state

- Branch: `codex/v333-iteration` at `6d1bf2fe8a237343681049043ec50fa1b6bf307f`.
- Entire is enabled in manual-commit mode with no checkpoint on this branch.
- The worktree contains extensive existing user/agent work; no unrelated changes may be overwritten.
- M550-M564 are now source-complete for the host-local epoch substrate, ordered recovery, runtime transaction, trust composition, and observation-sandbox contract, but remain uncommitted and uncommissioned.
- External anchor selection, key and trust-root provisioning, daemon/config activation, an enforced isolation backend, stopped-runtime upgrade, and mixed-version/legacy-writer exclusion remain separate steps.

## Fixed boundaries

- No external network adapter, key generation, credential lookup, trust-root install, daemon activation, release, commit, push, or provider effect.
- No claim of same-user rollback resistance or hostile-process exclusion.
- No Windows durability support without equivalent parent-directory fsync evidence.
- No automatic deletion of incomplete or conflicting evidence.

## Research findings and resolutions

- **Closed P0 runtime-layout collision:** M553 originally required the `snapshots/` and `attempts/` directories to remain empty, so a runtime ledger write would have degraded the active epoch. Preparation validation is now separate from the versioned, bounded post-activation runtime-layout allowlist.
- **Closed P0 incomplete source lifecycle:** M555 Source Bundle V2 remains fixed to `epochSequence: 1` and a five-minute maximum lifetime. M559/M561 now provide the separately versioned sequence 2..N renewal contract and complete-lineage authentication needed by the runtime.
- Existing Snapshot V1 also resets its sequence against a V1 genesis sentinel and does not carry epoch/prior-epoch closure. It cannot be relabeled as an epoch-aware snapshot ledger without a new envelope contract.
- **Closed P0 genesis mismatch:** M555 now reuses M550's raw epoch-one source sentinel exactly; permissive dual acceptance remains forbidden.
- **Closed P0 circular authentication:** M564 constructs runtime admission from the exact active artifacts, fresh anchor, commissioned trust generation, complete source lineage, configured identity/policy, and protocol observations. Caller-provided Boolean authentication is not accepted.
- **P1 transaction ordering:** the durable order is start receipt, computed observation, Snapshot V2, then terminal receipt. Snapshot-without-terminal recovery may close the exact persisted attempt but must never rerun observation.
- **Pointer replay liveness:** first/new pointer installation still requires a pristine prepared candidate, but exact replay authenticates the already-active candidate in bounded `runtime-owned` mode. Normal ledger initialization therefore cannot strand an already-durable pointer operation.
- **P1 key-separation boundary:** M564 requires injected purpose-separated services and never lets a record-provided key ID select its own verifier. Actual key derivation, provisioning, rotation, and commissioning remain external gates.
- **P1 authority laundering:** accepted/authenticated/healthy states remain evidence only and cannot invoke an executor or effect adapter.
- **Closed P0 partial-layout liveness:** bounded subsets of known runtime children are admitted for authorized domain-store recovery after a creation crash; semantic completeness remains the domain ledger's responsibility.
- **Closed P0 reciprocal verification cycle:** the start side uses an authenticated deterministic ordinal-one point read, and successful-terminal bindings are verified as one bounded canonical batch.
- **Closed P1 capacity complexity:** complete reads now use transaction-scoped authenticated source and snapshot indexes/batches with linear ledger joins. Point and write paths retain bounded singleton resolution.
- **Closed P0 deadline fence:** the stores share a live fail-closed runtime commit guard. Cancellation and failure terminals remain recordable while late snapshots and successful terminals are denied.
- **Observation isolation boundary:** M562's callback is trusted same-process code. Node 22's stable Permission Model can deny filesystem, child-process, worker, WASI, addon, and other ambient APIs by default, but Node explicitly describes it as a seat belt rather than a malicious-code security boundary. Cloudflare Sandbox is remote/container infrastructure and does not fit this local-first tranche. Any `sandboxed` claim therefore requires an attested local container/VM/backend, not flags alone.
- **Local backend inspection:** The host runs Node 22.22.3 and has `/usr/bin/sandbox-exec`; a trivial SBPL profile executes. A local Node permission probe denied child-process creation but still allowed `fetch()` network access. The existing Hub SBPL profile is designed for interactive coding-agent containment, begins with `allow default`, re-allows vendor homes, and does not authenticate actual child/profile/deadline/output enforcement. Neither path is auto-qualified for untrusted M562 producers.
- **M562b sandbox contract:** A new backend-neutral observation-sandbox protocol authenticates exact canonical request/response frames; binds epoch, tick, attempt, start, input, deadline, cap, backend, policy, and process identity; and rereads fresh attestation after execution. It hard-codes Node permission-only backends to `seatbelt-only` and admits `enforced` only when a separately trusted attestation proves process/untrusted-code isolation, egress and write denial, child/worker/addon/WASI/inspector denial, deadline kill, output cap, and process binding.

## Frozen implementation slices

- Root integration: reconcile M550/M555 genesis and split M553 strict preparation from exact runtime-owned layout validation.
- M557: durable epoch attempt record store plus deterministic attempt-set digest, internally derived active closure, and no successful terminal before Snapshot V2 persistence exists.
- M558: pure canonical Snapshot V2 envelope binding epoch, anchored head/manifest, namespace, attempt, tick, source, policy, predecessor, signer generation, and read-model digests.
- M559: sequenced source renewal contract for records 2..N inside an epoch, leaving M555 Source V2 as the immutable first-source record.
- M560: durable epoch Snapshot V2 store with historical source/start verification and reciprocal M557 binding.
- M561: durable source-renewal store deriving its sequence and tip from authenticated local history.
- M562: integrated observation/recovery orchestration only after the M557-M561 contracts pass independent review.
- M562b: fail-closed sandbox commissioning and authenticated producer-frame contract; no backend implementation or runtime activation.

## Implementation progress

- The M550/M555 epoch-one genesis mismatch is corrected with a single compatibility alias and exact deterministic vector.
- M553 now preserves strict empty-ledger validation for preparation while active-pointer reads recognize only the exact M557 attempt-ledger root layout. A new active-artifact read returns owned immutable core bytes without claiming external-anchor or ledger authentication.
- M559 source renewal is implemented as a pure separate protocol for epoch sequences 2..4096. It binds head, manifest, namespace, predecessor, policy, key, principals, time, and payload; rereads an internally supplied active context to detect callback drift; and retains every false authority claim.
- M559 verification: 31 focused tests and 57 M555+M559 adjacent tests passed; typecheck, scoped lint, Semgrep, Gitleaks, and whitespace checks passed.
- M558/M560 implement the canonical Snapshot V2 record and its guarded immutable epoch ledger. The current focused gate passes 42/42, including source A attempt/snapshot continuity after renewal to B, historical revocation, callback mutation, signer identity drift, and partial layout repair.
- M557/M561 implement attempt and source-renewal persistence, deterministic exact start point reads, historical key lineage, guarded partial-layout repair, conservative recovery, live runtime commit fences, and bounded historical batch joins.
- M562b implements the honest local observation-isolation seam without upgrading the current callback. Nine focused adversarial tests cover Node seatbelt refusal, partial controls, stale/wrong/mutated attestation evidence, exact request/response authentication, callback mutation, deadline/output failure, attestation drift, extra fields, role-separated keys, and authority denial.
- M562b verification passed its 9 focused tests, scoped ESLint, repository TypeScript compilation, scoped Semgrep TypeScript rules, and per-file Gitleaks scans. A repository-wide no-git Gitleaks pass reported 81 pre-existing/unattributed findings across roughly 355 MB; the three new M562b files each reported no leaks, so the broad result is not represented as a clean repository gate.

## Final M563/M564 trust and recovery decisions

- **Complete source lineage is mandatory.** M564 authenticates the M553 head, manifest, and first source, then admits current and historical attempt/snapshot contexts only from a complete M555/M559/M561 lineage. It does not accept caller Boolean authentication or record-selected keys.
- **Freshness is continuous.** Independent facade reads and runtime admission freshly compare external anchor bytes to the active head, recheck the commissioned trust generation, immutable core, manifest-fixed snapshot identity, and current source time window. Signer callbacks retain pre/post fences and reject byte mutation, reentrancy, provider drift, anchor rollback/removal, trust revocation, core replacement, and expiry.
- **The session token is one-use and exact-object-bound.** M562 mints it only after acquiring the process lease and observation lock. A private registry binds it to the exact M564 session object; M564 atomically deletes it before comparison. Missing, forged, replayed, wrapped, or cross-composition tokens cannot activate signing.
- **Signing is not public authority.** Attempt and snapshot signer calls and signer-bearing attempt-authenticator resolution work only during that exact M562 session. Reconstructed M557/M560 stores remain unable to publish. The public closure contains identity only. M561 renewal signing remains separately available because source publication is its own locked protocol, but every call is fenced by fresh anchor, commissioning, source-currentness, immutable-core, mutation, and reentrancy checks.
- **Recovery is ordered and conservative.** M563 runs source, snapshot, then attempt recovery and stops on the first unavailable or hostile stage. Each stage is surrounded by fixed-identity, lease, lock, and stop-state checks. It can remove an authenticated one-link uncommitted stage or only the staging name of an exact already-linked two-link target; it cannot invent or overwrite a durable record.
- **Restart admission is read-only.** A real restart may encounter the two-link target and stage before M564 exists. The dedicated recovery-admission reader accepts only canonical stage/target paths that contain equivalent authenticated records and share the same private regular-file inode. It performs no cleanup and does not relax ordinary M561 complete reads.
- **Source fingerprints are semantic.** M564 pins ordered expected renewal filenames and exact file-content digests. Content changes, replacements, additions, or unexpected/symlinked entries fail closed, while M563's authenticated hardlink-name cleanup does not create false drift merely because link count or ctime changed.
- **M562b is a separate security boundary.** The current M562 callback remains trusted same-process code. The backend-neutral contract can call isolation `enforced` only after fresh authenticated pre/post evidence for all required controls; Node permissions remain `seatbelt-only` and no backend is selected or active.

## Verification snapshot (2026-09-04)

- The authoritative exact M550-M564 tranche covered 17 test files and passed 346/346 tests.
- M564 focused trust-composition suite: 13/13 passed, including a real M562 transaction, reconstructed-store denial, token laundering, stale/rollback anchor, trust/core/source/currentness drift, callback mutation/reentrancy, source rotation/key retirement, and stage-before-composition linked-source recovery.
- M561 plus shared immutable-record-store adjacent suites: 21/21 passed after adding the read-only restart admission path.
- M562, M562b, M563, and M564 contain 12, 9, 5, and 13 focused test cases respectively; all are included in the passing 346-test tranche.
- Repository TypeScript compilation passed. Full lint completed with zero errors and 108 pre-existing warnings. The final build completed through TypeScript, asset copy, Vite's 183-module build, dependency inventory, and build identity generation.
- Scoped Semgrep reported zero findings. Scoped Gitleaks reported zero findings across the 30 M550-M564 runtime/store/test files. The whole dirty-worktree Gitleaks scan still has 81 pre-existing or unattributed findings and is not a clean repository gate.
- `npm audit --offline --audit-level=low` reported zero vulnerabilities from the local cache, and `git diff --check` passed. The earlier online audit did not complete and is not represented as current online registry evidence.
- A prior isolated M562 three-store crash-recovery test passed in 17.084 seconds after one parallel run exceeded its existing 20-second test cap; this was treated as filesystem-load variance, not hidden by changing its timeout.
- A second `npm run test:ci` attempt used a 1,800,000 ms cap, completed the entire 116-file real-I/O project without an observed failure, continued into the unit project, and then reached the cap. A separate complete unit-project run passed 590 files with 1 skipped and 12,778 tests with 28 skipped. This is complete green lane-level coverage, not a passing single-command `test:ci` result.

## Remaining commissioning blockers

- Select and independently accept an external monotonic-anchor implementation; M564 only consumes an injected fresh read.
- Provision and rotate the purpose-separated source, renewal, attempt, snapshot, manifest, and prepared-evidence cryptographic services; install authenticated trust roots and establish revocation/recovery procedures.
- Implement and commission an M562b-compatible local isolation backend, then explicitly integrate it with M562. Node permission flags and the existing interactive `sandbox-exec` profile do not qualify.
- Establish legacy/mixed-version writer exclusion, the stopped-runtime upgrade protocol, and commissioned crash/contention acceptance.
- Raise or split the serial CI budget so the formal combined regression command can finish, commit/review the exact source through the normal release process, and only then consider a separately authorized daemon/config activation. Both test lanes and the local build passed, but no immutable release artifact was created. No backend, anchor, key, daemon, or observer lane was activated in this tranche.
