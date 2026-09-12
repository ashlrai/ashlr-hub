# Scoped campaign histories — September 12, 2026

Implemented on primary `auto/p00` in
`/Users/masonwyatt/.codex/worktrees/ashlr-hub/firm-p00`. Original dirty checkout
was preserved. Entire resume found no checkpoint. Parent integrated three agents'
implementation, acceptance and independent review.

Source commit: `694b568e4166791a63c4670a147206708cc12480`. Clean full build64056
exited0 with257webmodules; its build identity reports that exact SHA and
`dirty:false`. Builtin evaluator digest is
`db228df553eada0318d0685d49be06f9c1a41ea659c75bb89d4fff7d0f43ca39`.
This build does not inherit the older native qualification of evaluator9a051509.
Source and package documentation checks both passed.

## What works

Optional host-pinned `registrationScope` separates preparation histories while
using the same account ledger. Setup, the foreground console, background
preparation, successor registration and restart all use the selected scope.
Existing configurations retain their exact legacy paths and context digests.
Each active catalog/history retains its 32-entry bound. No account usage is
reset and old histories remain available through their original configuration.

Actual local-worker tests proved two separately started campaign scopes retain
the first receipt and delivery while exhausting one shared task allowance. A
separate source-CLI test proved scoped automatic A → proposal → B execution,
delivered-commit lineage and restart without duplicate requests or deadline
renewal. These are test-owned Git repositories, evaluators and loopback workers,
not provider commissioning or production activation.

## Verification

| Gate | Passed | Files | Duration | Handle |
|---|---:|---:|---:|---:|
| Scoped setup and legacy replay | 20 | 1 | 45.74s | 21262 |
| Existing CLI/preparation boundaries | 90 | 5 | 105.10s | 66855 |
| Registry isolation, custody and capacity | 14 | 1 | 56.92s | 46234 |
| Existing web preparation contracts | 60 | 3 | 1.17s | 39309 |
| Two scopes, one ledger, two deliveries | 1 | 1 | 46.57s | 63732 |
| Scoped setup CLI and automatic successors | 1 | 1 | 252.39s | 42535 |

186 distinct tests passed across 12 files. The two selected acceptance commands
filtered four and one other cases respectively. No zero-collected command is
counted. Source/web types, strict changed-test imports, scoped lint, documentation
links and real-IO lane membership passed. Independent review cleared the final
source after strengthening the exact-capacity test and rejecting dangling
registration-directory symlinks.

## Remaining autonomy work

This is a required storage/execution prerequisite, not an automatic standing
mission. The next caller must prove predecessor settlement before creating a new
scope; owner close alone is insufficient. See [source-backed seams](notes.md).
The shared ledger's 4,096-attempt/storage bounds also need a retained-history
strategy for continuous operation. Existing global stop, collector custody and
account commissioning remain separate and unchanged. No remote push, npm
publication, provider call or resident service activation occurred.

Read-only post-build sample at `2026-09-12T11:46:17.268Z` confirms active/healthy
global stop and a pending v1 collector record with legacy owner evidence missing;
`recoveryAttempted:false`. No account or collector configuration was changed.

Documentation was updated in the existing resource guide and CLI help rather
than adding a competing operating contract. It distinguishes explicit history
selection from budget renewal and unfinished-work recovery.

## Continuation: faster fresh predecessor evidence

Parent integrated saved implementation and independent tests from two workers;
both subsequently reached their provider usage limit. They were not retried,
and no account was switched or policy changed. The third worker delivered a
source-backed design for an in-process mission owner using the existing console.

The predecessor checker now reconstructs each registration's committed metadata
once per sample, sharing it with catalog and delivered-source derivation. It
still takes two independent complete samples. Tests reject caller proof fields,
changed configuration/receipts/runtime, mutated returned objects and second-read
source drift. Ordinary setup check/replay still do not require delivery.

| Gate | Result | Handle |
|---|---|---|
| Setup evidence, public replay, source reuse and predecessor join | 100 tests passed | 40187 |
| Final predecessor join and CLI | 104 tests passed; overlaps 63 above | 12342 |
| Actual scoped CLI, execution, restart and receipt controls | 1 passed, 1 filtered; 417.95s | 81952 |
| TypeScript and targeted ESLint | Passed | 51702 |
| Real-IO lane classification | Passed | 81687 |
| Documentation links | Passed; no external requests | 326058 |

Total: 142 distinct tests across six files, not 205. The complete scoped
acceptance now passes in one run, replacing the earlier interrupted-run gap.
No product execution deadline was extended by this optimization.

A read-only CLI check of the retained two-campaign fixture took 53.317s versus
the prior separate 114.041s observation. Both yielded the exact same evidence
digest and delivered commit. All 240 fixture and four isolated home entries
were unchanged. This is a single-fixture comparison, not a general benchmark.

The standing-mission owner is still not implemented. It must persist scope
reservations and original deadlines, obtain one deterministic accounted proposal,
recheck predecessor evidence at publication and preserve stop decisions and
shared account reserves. Foreground console close already drains its existing
owners; a second execution runtime is unnecessary. See [notes](notes.md).

This continuation does not activate providers, recover collector custody,
unpause queues, change personal/Spark allocations, install a service, publish to
npm, push remote Git or deploy a public site. Entire remains enabled with
manual commits on `auto/p00`; prior resume found no checkpoint.

### Built artifact

Source `4a4488527b5dba69aabaeebc9a77f1d2b9cf8d7c` built successfully in run
16678. `dist/build-identity.json` reports that exact SHA, package 3.4.0,
`dirty:false`, provenance `git`; 257 web modules built. Package-mode documentation
validation also passed. The nine-file builtin measurement bundle has digest
`e41419e9fabaef5844c0aebe2504b980c4e4b1c60f72c174373b0c67c293d864`.
Its bytes were inspected, not natively qualified or executed. Older bundle
qualification does not transfer. All verification process handles are terminal.
