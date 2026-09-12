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
