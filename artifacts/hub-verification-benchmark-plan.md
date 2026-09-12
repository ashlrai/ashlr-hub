# Hub verification-work benchmark proposal

Status: design and local baseline observations, **not a frozen evaluator or an
accepted optimization**. Audience: the engineer approving a real Hub campaign
and the independent evaluator author. No candidate implementation is supplied.

## Runnable prototype: limited measurement, not acceptance authority

The prototype introduced after `3a228e1b` comprises a
[standalone prototype](../scripts/evaluators/preparation-verification.mjs), a
[shared trusted dependency packager](../scripts/build-preparation-builtin.mjs)
and [real-fixture tests](../test/universe-preparation-verification.test.ts).
The target remains unchanged. The first slice compares ordinary preparation
check and metadata reads for one/four protected evaluator files, including
committed bytes that differ from the working checkout. It does not yet cover
the full manager, successor-source or end-to-end sequence below.

Use Node 24 or newer on macOS for the actual-process development fixtures:

```sh
npx vitest run test/universe-preparation-verification.test.ts test/preparation-verification-child.test.ts test/preparation-verification-protocol.test.ts --no-file-parallelism
```

Both candidate-process suites require that platform/runtime. Unsupported checks
are skipped, not accepted. The separate mailbox suite exercises local data/file
validation. Fixtures are private and temporary; no enrolled provider or real
project is dispatched.

The continuation from `96e9a6e8` moves candidate execution into a persistent
OS-confined child. The controller owns expected results, immutable fixture
snapshots, runtime mutation, assertions and the final envelope. Numbered,
nonce-correlated private mailboxes carry bounded JSON; candidate stdout is never
a verdict. The child has readonly fixture/inbox access, writable private scratch,
no network, and denied process creation/signals. Required readonly Git/ACL/process
metadata commands pass an exact controller-owned allowlist. Reported process
counts measure those actual broker launches, not a complete OS process census.
OS-resolved user-home read denial is independent of the fixture's `HOME`.
The inherited system-read profile is not a universal filesystem or VM boundary.

Do **not** enroll this prototype as a trusted improvement evaluator. The ordinary
command-evaluator route still refuses the nested sandbox on the verified Mac:
`sandbox_apply: Operation not permitted`, classified as
`CANDIDATE_CONFINEMENT_UNAVAILABLE`, with no unconfined fallback. The separate
installed builtin route below now launches its candidate sandbox directly from
the trusted controller. This is not permission to execute arbitrary seed scripts
outside confinement or to widen the candidate's scratch grant. Ordinary
deadline/close settlement does not establish arbitrary controller-crash recovery.
The full correctness workload and competitive reward remain unfinished.

Numeric results are development diagnostics, not evidence authorizing acceptance,
rewards, promotion or autonomous delivery. The `preparation-verification-measurement`
envelope deliberately omits evaluation `passed` and `score` fields; the tests
require the Universe evaluation parser to reject it, including the confined run.
This prevents mistaking a prototype measurement for accepted evaluation evidence.

Historical baseline at `96e9a6e8` (before process separation): eight tests passed
in 23.35s on macOS/Node 24.18.0. Three fresh processes produced these diagnostics;
these are not the isolated-controller acceptance results:

| Protected files | Public method | Observed launches | Git blob launches |
| --- | --- | ---: | ---: |
| 1 | check | 34 | 2 |
| 1 | metadata | 109 | 2 |
| 4 | check | 40 | 8 |
| 4 | metadata | 115 | 8 |

The historical four measured calls total 298 launches. Current correctness
checks cover same-candidate runtime drift and malformed JSON input refusal;
JSON does not transmit accessors, so the former accessor-input test is not claimed
as cross-process evidence. Separate child tests exercise malformed return values.
Fixtures preserve a 40% account allocation
ceiling, a held worker, dirty working-tree evaluator bytes, duplicate committed
blobs and differing executable modes. Constant results, cached verification,
incorrect blob content, direct assertion tampering, stdout forgery and an
unexpected shell call are negative controls. Payload syntax is checked separately
so parse failures cannot masquerade as behavioral coverage. The prior outer
confined success does not carry forward to nested candidate confinement. See the
[local handoff](../workplans/2026-09-10-firm/report.md) for current checks and gaps.

### Installed builtin measurement route

#### Candidate-linked workflow measurement

The workflow extension based on `2acf37714ee01135550de75d33de0a648ac4ce54`
adds a separate fixed workflow graph embedded in the shipped bridge. At authoring
time, only the exact preparation module is externalized; a build graph check
rejects accidental inclusion of baseline preparation or non-native dependencies.
At runtime that import resolves to the selected candidate, including successor
re-exports. It never falls back to baseline code or builds a candidate-supplied
dependency. Candidate return values are checked before trusted manager code can
consume them, not merely after final JSON serialization.

The private measurement protocol adds ordinary full bundle reads, successor
check/metadata/full bundle reads, and explicit manager open/check/replay/close.
Manager construction and restoration happen inside the measured open request.
The actual manager and engineering owner validate real registration stores;
their supervisor is a deliberately nonexecuting fixture view backed by pinned
project directories and validated pool files. Only already-restored IDs can
reach replay. This is not a live supervisor or an execution permission grant.

The controller exposes detached cumulative and per-request launch counts. They
count validated, settled native broker operations, not all OS processes or
incompletely settled failures. The fixed tool wrapper and its descendants are
not a complete process census. A failed session cannot become accepted evidence.
Reconcile totals at completed request boundaries and require successful session
close before interpreting a run; an in-flight request can contribute launches
and appear in the ledger before its request reply completes.
The successor reader's larger declared buffer is admitted while actual tool
output remains capped at 64 KiB per stream; writes, network tools and expanded
Git command forms remain refused.

The full workflow tests explicitly request a 300-second session deadline. The
first real manager run exhausted the earlier 120-second leaf ceiling; a complete
successor sequence then measured 231 seconds, leaving insufficient headroom at 240.
One deadline covers all calls and shutdown; it is never renewed by an operation.
The normal 60-second session default, individual 30-second tool ceiling and
110-second installed evaluator example below remain unchanged. A larger test
budget is not evidence of speedup or permission to exceed a campaign allowance.

The corrected manager fixture produces identical counts in two fresh candidate
processes, with exact output and before-startup/after-close snapshot equality:

| Operation | Validated broker operations | Of which blob operations |
| --- | ---: | ---: |
| Restoration/open | 708 | 6 |
| Full bundle read | 237 | 2 |
| Check | 264 | 2 |
| Exact replay | 513 | 2 |
| Total | 1,722 | 12 |

These are observations for the private fixed fixture, not a frozen competitive
score. Owner work outside the mutable preparation module also contributes.

The real delivered successor fixture likewise matches in two fresh processes:

| Operation | Validated broker operations | Of which blob operations |
| --- | ---: | ---: |
| Successor check | 700 | 7 |
| Successor metadata | 909 | 8 |
| Successor full bundle | 1,030 | 8 |
| Total | 2,639 | 23 |

No successor campaign executes in these reads. The command-only upstream setup,
trusted expected-output reads and fixture teardown are outside the measured calls.

Run the new real-process evidence and authoring-graph controls locally with:

```sh
npm run test:serial -- test/preparation-verification-workflow.test.ts test/preparation-verification-workflow-bridge.test.ts test/preparation-verification-readonly-commands.test.ts test/preparation-verification-controller-deadline.test.ts
```

These tests create and remove private temporary fixtures, including a genuine
two-generation command-only upstream delivery. They do not contact a model,
change real account policy or launch a successor campaign. See the handoff for
the actual verification outcome. The default installed harness still emits its
original non-evaluation measurement; these expanded operations are not yet its
frozen scoring workload. Completing the full correctness matrix, integrated
workload budgeting and repeated numerical baseline precedes optimization.

#### During-call candidate correctness probes

The continuation based on `df44cf730f4ca4155e8c56e0a8ce1783f630a0d0`
adds two paired controls: runtime configuration drift and delivered-source branch
drift inside an already-running metadata read. Each candidate first returns exact
expected metadata in the same child with unchanged evidence. The trusted test
bridge then arms one mutation at the ACL read of that bundle's exact `intent.json`,
after initial capture and receipt comparison. It awaits the real native result,
mutates only the private fixture and returns the identical original result.
No callback is exposed to candidate code and no production injection hook is added.

The runtime stale control removes only the final capture/digest comparison. The
source stale control retains initial origin verification but omits subsequent
source revalidation. Tests require the real baseline to refuse drift and the
deliberately broken candidate to demonstrate stale success. This is not a
final-return-only source-guard proof or a numerical performance comparison.

The interceptor validates transport, real settlement and bounded native output;
a failed/missing trigger, duplicate request or mutation failure invalidates the
harness instead of counting as candidate refusal. Snapshots include startup,
the healthy call, deliberate mutation and confirmed shutdown. Injection work is
outside candidate broker counts. Failed opens or unconfirmed closes retain the
private root; do not remove retained evidence without resolving process custody.

Run these local controls on macOS/Node 24 with:

```sh
npm run test:serial -- test/preparation-verification-runtime-drift.test.ts test/preparation-verification-successor-drift.test.ts test/preparation-mutation-interceptor.test.ts test/preparation-harness-custody.test.ts
```

Pool/binding/project replacement, same-size byte mutations, final-return-only
source proof, richer quota contexts and full installed workload integration
remain separate unfinished matrix entries. These tests do not change scoring,
grant account capacity, launch a successor or activate autonomous operation.

#### Installed invocation

The continuation based on `f00b4f01c44ab9b44e9f7e7c0eaeda377310d3f8`
adds the closed builtin `preparation-measurement-v1`. The first actual
default-registry test completed two measurements successfully in approximately
87 seconds on macOS/Node 24. Final coverage includes 433 distinct tests across
18 suites, with two full suites rerun after test-harness corrections; consult
the handoff above for exact evidence. Neither this
result nor the prototype counts establish a frozen reward or a useful Hub change.

From an authorized development checkout with its existing dependencies, the
following authoring command regenerates only the installed builtin build output:

```sh
npm run build:preparation-builtin
```

`npm run build` includes the same step. The reproducible output is
`dist/core/universe/builtins/preparation/`: seven fixed code files plus
`manifest.json`, with no timestamps in the manifest. Rebuilding restores the
derived output; it does not activate accounts, start a service or modify a
candidate. The bridge bundles trusted source at build time; runtime never builds
or imports a candidate-supplied bridge. The registry pins all seven files, Node,
the fixed Git/ls/ps/sandbox launchers, and equality with the host-imported
activity/protocol helper bytes. A missing, stale or unsupported installation
is refused, not replaced with an arbitrary command or source-tree fallback.

The explicit Universe manifest selection is:

```json
"evaluation": {
  "builtin": "preparation-measurement-v1",
  "timeoutMs": 110000
}
```

This replaces, and cannot accompany, `evaluation.command`. Ordinary command
evaluators keep their existing execution path. The builtin requires macOS and
Node 24 or newer; package-wide Node compatibility does not imply builtin
availability. Registration binds its installed implementation digest into the
comparator. Launch uses fixed installed paths and a closed environment, never
caller-selected executable code, and rechecks comparator/artifact integrity.

The trusted controller launches a separately confined candidate and fixed
asynchronous tool workers. Tools return raw stdout/stderr as bounded base64;
the current prototype caps native output at 64 KiB per stream and mailbox
messages at 256 KiB. Invocation-bound activity records track candidate/tool
groups. Final acceptance of process settlement requires their durable receipts
and independent group-absence checks, not merely the controller's exit. Missing
or uncertain activity remains unresolved; no process is adopted or killed from
an unauthenticated stale PID. These controls are not arbitrary controller-crash
recovery. Counted native launches are not an OS-wide process census, and launcher
hashes do not pin all native transitive dependencies.

See the [installed registry](../src/core/universe/builtin-evaluator-registry.ts),
[launch boundary](../src/core/universe/fixed-evaluator.ts) and
[actual builtin tests](../test/universe-builtin-preparation-evaluator.test.ts).
The measurement envelope still deliberately fails `parseEvaluation`; it cannot
authorize campaign selection, promotion or delivery. The full manager/successor
matrix below and an independently reviewed frozen scoring contract remain next.

## Decision and scope

Reduce redundant work in preparation verification while preserving exact input,
project, comparator, receipt and successor-source checks. This directly affects
objective check/replay, console registration restoration and successor source
inspection. It is a useful Hub improvement, unlike replaying the already-fixed
marker-filter defect or incrementing a synthetic value.

Reviewed checkout: `/Users/masonwyatt/.codex/worktrees/ashlr-hub/firm-p00`, branch
`auto/p00`, source `f543e3627adbbe979c5b4a826d5e1036ab745edb`. Initial working tree
was clean. Entire reported no checkpoint for this branch in the preceding audit.
This proposal is the only file changed by this workstream; concurrent parent
work is outside its scope.

Initial candidate allowlist: **only**
[`src/core/resources/engineering-preparation.ts`](../src/core/resources/engineering-preparation.ts).
Keep manager, artifact/store/runtime readers, campaign/delivery guards, evaluator,
test harness, package scripts and dependencies immutable. The manager's previous
call-local reuse optimization is already present; do not grade rediscovering it.
If a safe improvement requires another file, review a new benchmark contract
before expanding the candidate allowlist.

## Observed cost and baseline evidence

`capture()` currently performs these Git subprocesses for an existing prepared
bundle with one protected evaluator file:

| Operation | Source | Calls per capture |
| --- | --- | ---: |
| Resolve physical repository and exact commit | `artifacts.ts::pinSeed` | 2 |
| Enumerate tracked seed sizes, modes and object IDs | `engineering-preparation.ts::capture` | 1 |
| Read protected evaluator blob | same, evaluator pins | 1 |
| Validate sterile resource workspace | `resource-generation.ts::checkResourceGenerationWorkspace` | 3 |

That is a **source-derived lower bound of 7**, not a measured total. The committed
metadata reader captures before and after bundle/evidence validation, giving at
least 14; enrollment and nested evidence readers add work outside this count.
Each capture also hashes the resolved evaluator executable. Successor readers
add fresh source proof. Batching immutable object queries or sharing computation
within a verified call may help; skipping an observation boundary does not count
as a valid improvement. No across-request positive-proof cache is authorized.

Observed local baseline command (Node `v24.18.0`; default shell Node was
`v22.22.3`, so PATH is explicit):

```sh
PATH=/opt/homebrew/opt/node@24/bin:$PATH caffeinate -i npx vitest run \
  test/resource-engineering-preparation-metadata.test.ts \
  test/resource-console-engineering-preparation-reuse.test.ts \
  --no-file-parallelism \
  -t 'retains both runtime captures|checks and replays an existing objective'
```

Result: 2 passed, 10 intentionally unselected/skipped; 2 files passed; 10.74 s
total, 9.14 s tests. The tests observed two runtime captures and one enrollment
validation per metadata read, and one committed reader call per manager check
or replay, with unchanged private filesystem snapshots. They do **not** measure
the total subprocess count or prove a candidate speedup. The frozen process-count
baseline remains a prerequisite; no invented numeric target is published here.

## Frozen evaluator contract to build before candidate work

1. Pin the evaluator/harness and baseline source in Git before giving a worker
   candidate-write authority. Use an isolated fixture HOME, private temporary
   stores and local Git; no provider endpoints, evaluator subprocess dispatch or
   account configuration is needed for scored inspection. The fixture evaluator
   executable is pinned bytes, not executed by these reads.
2. Construct prepared ordinary and successor fixtures outside the scored region.
   Include one and multiple protected evaluator inputs, an existing shared ledger,
   a selected registered project, and unrelated project history. Fixture creation
   and cleanup are unscored. Seed setup for the successor can use the existing
   real command-generation/fixed-evaluation fixture, with no model transport.
3. Score a fixed sequence: ordinary metadata read, complete bundle read, manager
   exact check/replay, restart restoration, and successor metadata read. Repeat
   each in a fresh process and again within one process; every output must match
   the pinned baseline after normalizing only known fixture absolute roots and
   observational timestamps. Never normalize digests, policy or error status.
4. Instrument the evaluator-owned subprocess boundary with call-through wrappers
   covering `execFileSync`, `spawnSync`, asynchronous spawn/exec variants and any
   descendant launch. Count actual launches, not calls to `capture()` or a
   candidate-reported counter. Refuse unexpected executable/process routes.
   A PATH-only Git shim is insufficient because absolute paths can bypass it.
   Cross-check instrument completeness against an independent process trace in
   review; wrappers are measurement instrumentation, **not a security sandbox**.
5. With all correctness gates passing, emit metric `verification_processes`,
   direction `minimize`, integer score equal to total scored launches, and
   `minImprovement: 1`. Preserve per-scenario counts and bytes read as diagnostic
   dimensions. Require no scenario to regress; wall time is diagnostic only.
   Run the same baseline three times and require identical operation counts
   before freezing its numeric score. Any failed correctness case emits
   `passed: false`; it must never earn a better score by failing early.
6. To claim a second autonomous successor improvement, B must reduce the same
   metric again from A's delivered artifact with unchanged correctness gates.
   Do not presume that two independent safe reductions exist or relax acceptance
   to manufacture an A-to-B result.

## Independent correctness matrix

Reuse real fixture conventions, not candidate helper return values. Keep expected
outcomes outside mutable source. Tests should inject changes at observable I/O
boundaries, including after successful intermediate checks and before return:

- Change runtime/pool/bindings/project configuration between captures; replace
  the project directory at the same path; assert refusal without writes.
- Change the pinned evaluator executable, saved comparator bytes, receipt,
  generated campaign/manifest or intent. Include same-size replacements and
  restored mtime so metadata-only caching cannot pass.
- Change a successor source branch, delivery receipt or source artifact during
  the final proof. Require source revalidation even on exact completed replay.
- Repeat a successful call, mutate inputs, then call again. Restart and repeat.
  Old success must not authorize the later read or restore a missing receipt.
- Preserve exact detached outputs, unknown evidence, General/Spark exclusions,
  allocation ceilings and account-wide pauses. Benign observation refresh must
  not change immutable plan identity; policy changes must not be cached away.
- Reject getter/inherited/unknown options, unsafe paths and evaluator mutation;
  preserve dirty checkout/index bytes and unsupported/symlink/hardlink refusals.
- Missing/incomplete output stays missing/incomplete; no automatic repair,
  locks, registration, provider contact or cleanup in inspection. Snapshot
  directory inode/mode/mtime/ctime plus file hashes before and after.

Relevant existing suites: [metadata](../test/resource-engineering-preparation-metadata.test.ts),
[boundaries](../test/resource-engineering-preparation-boundaries.test.ts),
[manager reuse](../test/resource-console-engineering-preparation-reuse.test.ts),
[successor preparation](../test/resource-engineering-successor-preparation.test.ts).
The existing tests' exact helper-call counts are baseline observations, not a
requirement to preserve redundant internals; replacement implementations must
still satisfy independent final-state and fault-injection checks.

## Review and commissioning gates

Independent reviewer approval is required for the frozen metric, subprocess
instrumentation coverage, mutation timing, and candidate diff. Reject bypassing
the counter, recognizing fixture names, moving unmeasured work outside the scored
region, weakening file checks, or retaining stale authority. Validate through the
actual selected Universe launch route before commissioning, including its
candidate confinement: a Vitest pass alone does not prove its subprocess/fixture
needs fit that boundary. Pin Node, Git,
dependency versions and evaluator executable digest; do not install tools from
inside the evaluator.

The initial proposal established the scope and two selected baseline tests.
It did not build the frozen evaluator, measure total subprocesses, optimize
production code, run a model, commission a service or alter any real account.
The next approval is to build and independently challenge the evaluator, then
measure and freeze its baseline before any candidate optimization.

## Later integration observation: responsiveness is a separate acceptance dimension

The autonomous-setup CLI acceptance on this branch subsequently observed a status
GET waiting 73,098 ms before `ECONNRESET`, after A's delivered result and a
successor proposal. The foreground console was still alive, with no stderr or
output-limit failure; a fresh connection immediately returned HTTP 200. This
is measured request-wait evidence, not a measured CPU duration or proof of its
precise cause. Source inspection identifies synchronous preparation/proof work
on the same event loop as a plausible contributor.

Reducing subprocess counts alone therefore is not sufficient operational
acceptance. The separate
[control-room responsiveness gate](../benchmarks/resource-engineering-responsiveness.test.ts)
now probes read latency and stop responsiveness during real verification.
Its results must remain distinct from subprocess-count improvements; candidates
cannot skip source checks or return fabricated snapshots. Read reconnection can
establish workflow continuity, but cannot earn a latency improvement score.
This observation does not change the proposed candidate allowlist or metric.
