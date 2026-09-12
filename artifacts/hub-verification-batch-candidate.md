# Candidate: batch immutable evaluator blob reads

Status: **unapplied; strict native process-count comparison passed with pinned
developer Git**. The fresh comparison preserves healthy results and during-call
drift refusal, with two blob launches instead of eight for both four-file reads.
Earlier runs using the platform Git launcher measured ten blob launches: an
xcrun cache-write warning despite exit 0 correctly triggered complete fallback.
That earlier rejection remains valid for that tool identity. The new harness
pins developer Git itself without widening confinement or discarding stderr.
Six actual Node combined-output boundary tests and33 pure artifact controls pass.
Full installed candidate measurement remains pending. This is not
an accepted optimization, a scoring evaluator, or permission to promote a result.
The [candidate patch](hub-verification-batch-candidate.patch) changes only
`src/core/resources/engineering-preparation.ts`. Production source, the installed
evaluator, its bridge and tests are unchanged by this artifact.

## Baseline and purpose

Prepared against source commit `948a7fa4cde76002b6029b61f588127e3f70c42e`, target
Git blob `a5a6fcf36dd6990f309ee1f0e15072c63cce16d4`, on branch `auto/p00` in
`/Users/masonwyatt/.codex/worktrees/ashlr-hub/firm-p00`. The shared worktree has
in-progress installed-workload changes; the target source itself is unchanged.

The current `capture()` hashes each protected evaluator file through a separate
`git cat-file blob <OID>` invocation. For multiple protected paths, the candidate
first attempts one `git cat-file --batch` request, reusing the existing
[Git batch parser](../src/core/universe/git-blob-batch.ts). For N distinct protected
paths, a usable clean batch would change N blob launches to one per capture.
N = 1 keeps the exact original per-file path, with no batch attempt. Actual
confined measurements with pinned developer Git show four-file blob launches
falling from 8 to 2. The earlier launcher-based comparison increased them from 8
to 10 through fallback. No wall-time or end-to-end savings are established.

### Fresh strict comparison

Local gate 88594 passed 63 tests across four suites with zero skips in 72.39s.
It applies the exact patch only to a private candidate copy and uses
`/Library/Developer/CommandLineTools/usr/bin/git`, SHA-256
`74b90b9f97ec79bfe7886a4fc6132533b3e1014ef4195d28abd1ca9bf321f34a`.

| Read | Baseline broker / blob launches | Candidate broker / blob launches |
| --- | ---: | ---: |
| One-file check | 36 / 2 | 36 / 2 |
| Four-file check | 42 / 8 | 36 / 2 |
| Four-file metadata | 117 / 8 | 111 / 2 |

All observed candidate batch exits were 0 with empty stderr and no transport
error. Exact results and the same-child runtime-drift refusal passed. The report's
`improvementAccepted: true` describes this numerical comparison only; it is not
archive acceptance, full installed candidate evaluation or delivery evidence.

## Preserved decisions and boundaries

- Keep the existing unique, sorted path list. Map each path to its immutable OID
  from the freshly read pinned seed tree. Do not replace OIDs with paths or refs.
- Keep duplicate OIDs when different paths have identical content. Parse and hash
  one returned payload per destination; retain the existing path/digest shape.
- Read the executable digest before reading evaluator blobs, as before. Preserve
  all `capture()` calls, entry/exit successor `assertSource()` calls, comparator
  checks, runtime checks, project identities, receipt checks and publication
  fences. There is no memoization or cross-call reuse.
- Leave the existing Git helper entirely unchanged. A separate bounded
  `spawnSync` batch call uses the same environment, config overrides and timeout,
  with piped stdin and a larger framing envelope. Any permitted fallback uses
  the original helper, not a reconstruction of its stream/error handling.
- The parser checks exact frame order, requested OIDs, blob type, declared sizes,
  terminators, complete consumption and content hashes (SHA-1 or SHA-256 as
  indicated by the requested OID).

## Byte and execution limits

The existing seed inventory's 64 MiB artifact limit and 8,192-entry limit remain
unchanged. The batch parser separately enforces a 64 MiB payload sum, counting
duplicate OIDs once per requested path. Each returned evaluator blob is then
explicitly refused if it exceeds 8 MiB. Exactly 8 MiB with no stderr is not
rejected by that explicit comparison. The single-file and fallback paths retain
the original runner's combined-output handling rather than relying on this
payload check.

Independent review found that the first draft lost Node's combined stdout/stderr
`maxBuffer` semantics. See the pinned [Node 24.18.0 implementation](https://github.com/nodejs/node/blob/v24.18.0/src/spawn_sync.cc#L610-L616).
This revision captures both batch streams and uses this closed decision order:

1. Refuse a thrown call, any reported error, signal, missing/negative/noninteger
   status, non-Buffer stream or aggregate output beyond the declared envelope.
   No retry follows timeout, killed process, invalid transport or unknown result.
2. A normally exited batch with any stderr or a nonzero status discards the whole
   batch and restarts **every** sorted OID through the unchanged per-file helper.
   No successful batch prefix is retained. Each legacy call applies its original
   combined 8 MiB stdout/stderr limit and error behavior. A small warning is not
   itself an unconditional failure; an oversized combined legacy result still is.
3. A zero-status, empty-stderr batch must pass the shared parser and explicit
   per-file bound. Malformed/missing/reordered frames, identity/hash mismatches,
   trailing bytes and excessive payloads refuse immediately, without fallback.

The broker returns a synthetic PID of zero, so PID is not used as proof of
settlement. Actual process ownership remains with the existing trusted runner.
This is not an equivalence claim for an adversarial Git executable whose output
depends on invocation mode or for transient warnings that disappear between
calls. The allowed fallback re-executes the original commands rather than
pretending that discarded batch output was legacy evidence.

The batch subprocess permits at most 68 MiB of buffered output: the existing
64 MiB artifact cap plus 4 MiB of bounded framing headroom, matching the pattern
already used by the artifact reader. This does increase peak buffering versus
the old sequential 8 MiB calls, and oversized individual blobs may be read before
the explicit per-file refusal. It does not increase the artifact payload limit.
This bound
is not a peak-memory guarantee: buffers and parsed values may coexist.
The batch keeps a 30-second subprocess timeout. A permitted fallback adds at
most one batch launch and up to that 30-second attempt before the full original
sequence: N + 1 launches rather than N. There is no recursive fallback or retry
after a process error. The existing outer invocation deadline is not renewed;
extra work can exhaust it and cause a safe refusal. Clean batch mode can also
refuse sooner on slow storage than the old per-file timeouts.

The isolated candidate broker's actual output bound remains separate and much
smaller than the declared maximum. The patch does not change that broker bound,
its command allowlist, process ownership, candidate sandbox or whole-session
deadline. Large boundary cases need appropriately scoped independent validation;
small installed fixtures alone do not prove them.

## Verification and adoption gate

The native comparison has two deliberately separate outcomes: compatibility
regression tests verify outputs, drift refusal, cleanup and counts derived from
each observed batch result; the strict improvement gate requires the original
two-blob/six-fewer-launch target for both four-file reads. A green compatibility
test does not mean the candidate improved anything. Its report marks
`improvementAccepted: false` unless that exact numerical target is met.

Run the strict improvement gate from the repository root:

```sh
ASHLR_PREPARATION_BATCH_REPORT=1 ASHLR_REQUIRE_BATCH_IMPROVEMENT=1 npm run test:serial -- test/preparation-batch-candidate-acceptance.test.ts --reporter=verbose
```

Use Node24 on macOS. This applies the candidate only in a private fixture and
does not modify the live target. The closed developer Git installation described
in the [benchmark plan](hub-verification-benchmark-plan.md) is required. The old
launcher warning caused the earlier failure, not corrupted output or a lost
drift refusal. Do not grant broader filesystem access, discard warning bytes or
relax this improvement target to make it pass.

Read-only patch applicability has been checked:

```sh
git apply --check artifacts/hub-verification-batch-candidate.patch
```

Run from the repository root; success prints nothing and does not apply the
patch. The [pure candidate suite](../test/preparation-batch-candidate.test.ts)
extracts the actual added helper from this patch, uses fake subprocess calls and
the real batch parser, and passed 33 tests with no skips in 363 ms on Node 24.18.0.
It does not apply the patch or launch a native command. Strict standalone
TypeScript and scoped lint passed. A private actual patch application, whole-source
virtual TypeScript compilation and native comparison have now run. Exact output,
mixed/duplicate committed content, dirty-checkout separation and during-call
runtime drift controls passed. The improvement assertion failed twice under the
old launcher, then passed under pinned developer Git. The second failed run
recorded successful batch exits with the launcher cache warning, confirming
fallback rather than a parser or transport failure. Before adoption,
independently review and evaluate a
separate candidate artifact while keeping the baseline and installed trusted
workload fixed. Require:

- Identical healthy ordinary and successor check/metadata/full-bundle outputs,
  including manager construction, check, replay, close and restart behavior.
- Existing during-call and between-call runtime mutation controls still refuse
  stale reads. Require unchanged fixture snapshots after reads and clean owned
  process settlement; reduced counts cannot compensate for a lost refusal.
- Ordered duplicate-OID, dirty-checkout-versus-committed-data and SHA-256 object
  controls; malformed, missing, reordered, oversized and trailing batch frames
  must refuse rather than return partial pins.
- Explicit per-file cases at 8 MiB and 8 MiB + 1, aggregate cases at and beyond
  64 MiB, and duplicate-content paths counted against that aggregate. Preserve
  the original seed entry bound and reject untracked evaluator paths. Include
  successful stderr and combined-output boundaries against the original runner.
- Controller-owned per-request and total tool accounting across the full
  installed workload, including manager operations. Report setup groups
  separately from candidate broker launches and make no complete process-census
  claim.

### Runner-control coverage and remaining native checks

The pure suite records exact command/options/input order and verifies the helper's
batch/fallback decisions, unsafe result rejection, real frame parsing and byte
guards below. The combined-limit failure is injected from the original helper,
not generated by a real Node process. Separate real during-call drift and Node
combined-output checks have now passed; the numerical improvement gate failed.

| Batch/fixture input | Required decision and calls |
| --- | --- |
| One protected path | No `spawnSync` batch; one original per-file call |
| Two paths with one shared OID, valid frames | One batch containing the OID twice, ordered equal pins |
| Normal zero exit with a small warning | Full original sequence, even if the batch payload looks valid |
| Warning and a later legacy 8 MiB blob plus warning | Original combined-limit error propagates; no partial acceptance |
| Normal nonzero batch exit | Full original sequence, propagating any original failure |
| Error, timeout, signal, malformed status or stream | Immediate refusal, zero per-file fallback calls |
| Clean status with malformed frame or wrong OID/hash | Immediate parser refusal, zero fallback calls |
| Clean status with oversized per-file/aggregate payload | Refusal, zero fallback calls |
| First fallback file succeeds, next fails | Propagate failure; no batch prefix or extra retries |
| During-call runtime drift with clean batch or warning fallback | Existing final capture/source fence still refuses |

Fake combined-limit modeling is not a replacement for an isolated Node runtime
boundary check. The six actual Node boundary cases now pass; this does not make
the rejected process-count candidate an accepted optimization.

The result remains a non-scoring measurement until its separate acceptance and
reward contract is completed. See the
[benchmark plan](hub-verification-benchmark-plan.md) for that broader boundary.
