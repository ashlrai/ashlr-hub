# Hub verification-work benchmark proposal

Status: design and local baseline observations, **not a frozen evaluator or an
accepted optimization**. Audience: the engineer approving a real Hub campaign
and the independent evaluator author. No candidate implementation is supplied.

## Runnable prototype: limited measurement, not acceptance authority

The continuation from `3a228e1b` adds a
[standalone prototype](../scripts/evaluators/preparation-verification.mjs), a
[test-only frozen dependency packager](../test/helpers/preparation-verification-bundle.ts)
and [real-fixture tests](../test/universe-preparation-verification.test.ts).
The target remains unchanged. The first slice compares ordinary preparation
check and metadata reads for one/four protected evaluator files, including
committed bytes that differ from the working checkout. It does not yet cover
the full manager, successor-source or end-to-end sequence below.

Use Node 24 or newer for this development fixture:

```sh
npx vitest run test/universe-preparation-verification.test.ts --no-file-parallelism
```

The prototype tests are gated on that runtime; the real OS-confinement case
also requires macOS. Unsupported checks are skipped, not accepted. Fixtures are
private and temporary; no enrolled provider or real project is dispatched.

Do **not** enroll this prototype as a trusted improvement evaluator. Candidate
code and measurement currently share a process. An isolated VM context can
reduce accidental global interference, but exposed host-function constructors
can escape that context; filesystem confinement does not prevent forged stdout
or corrupted in-process checks. Competitive measurement requires an independently
owned evaluator process and independently observed effects. The numeric results
are development diagnostics, not evidence authorizing acceptance, rewards,
promotion or autonomous delivery. Its `preparation-verification-measurement`
envelope deliberately omits evaluation `passed` and `score` fields; the tests
require the Universe evaluation parser to reject it, including the confined run.
This prevents mistaking a prototype measurement for accepted evaluation evidence.

On macOS with Node 24.18.0, the complete prototype suite passed eight tests with
zero skips in 23.35s. Three fresh processes produced identical diagnostics:

| Protected files | Public method | Observed launches | Git blob launches |
| --- | --- | ---: | ---: |
| 1 | check | 34 | 2 |
| 1 | metadata | 109 | 2 |
| 4 | check | 40 | 8 |
| 4 | metadata | 115 | 8 |

The four measured calls total 298 launches. Eight correctness checks also cover
runtime drift and accessor refusal. Fixtures preserve a 40% account allocation
ceiling, a held worker, dirty working-tree evaluator bytes, duplicate committed
blobs and differing executable modes. Constant results, cached verification,
incorrect blob content, direct assertion tampering, stdout forgery and an
unexpected shell call all failed the prototype checks. The real confined run
completed with confirmed process-group exit. These observations remain narrower
than the full sequence below and have no trusted reward authority.

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
region, weakening file checks, or retaining stale authority. Validate within the
actual confined Universe evaluator before commissioning: a Vitest pass alone
does not prove its subprocess/fixture needs fit confinement. Pin Node, Git,
dependency versions and evaluator executable digest; do not install tools from
inside the evaluator.

This task established the proposed scope and the two selected baseline tests.
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
acceptance. A future frozen responsiveness evaluator should independently probe
read latency and stop responsiveness while real verification is in progress,
without letting a candidate skip source checks or return a fabricated snapshot.
Read reconnection can establish workflow continuity, but cannot earn a latency
improvement score. These probes and a baseline still need implementation; this
observation does not silently change the proposed candidate allowlist or metric.
