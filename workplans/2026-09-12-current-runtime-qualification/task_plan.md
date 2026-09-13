# Current runtime qualification and commissioning

## Goal

Advance the full autonomous engineering fleet by qualifying the rebuilt runtime
and resolving evidence-backed operational gaps without overriding the global stop,
account reservations or uncertain collector ownership.

## Phases

- [x] Confirm clean primary checkout and prior verified progress.
- [x] Inspect qualification procedure and commissioning gaps in parallel.
- [ ] Run exact-current native qualification; preserve terminal evidence.
- [x] Implement a justified remaining gap if discovery establishes one.
- [x] Review source results and document remaining qualification/commissioning gates.

## Constraints and ownership

Primary auto/p00 at 40140282; last clean build source 29f3e055. Original dirty
checkout remains untouched. Parent owns qualification and integration; three
agents perform bounded read-only discovery. No providers, auth changes, collector
recovery, stop clearing, service activation or remote publication in discovery.

## Status

Previous goal turn was progress: 395 distinct tests, clean build, shared fresh
quota preflight and real automatic successor delivery. Current evaluator digest
9a051509 needs its own native execution evidence. No previous handles are live.
Current native qualification runs at handle 76456 against fixed installed9a051509;
do not rebuild assets or restart because a poll has no output.

## Confirmed implementation gap

Independent review confirmed delivery can accept a parent-relative improvement
that regresses against a measured passing seed (minimize140 ->145 ->144).
Builder owns campaign-improvement.ts, campaign-delivery.ts and recovery consumer;
tester owns calibrated-campaign and passed-seed proof tests. Parent owns canonical
docs and integration; reviewer owns independent verification. Preserve archive
exploration, legacy unmeasured campaigns and failed-seed repair semantics. Require
all delivered generations to beat a verified passing seed and recheck custody at
the final Git effect and recovery. No budget, priority or account changes.

Source correction f8cd6f1e is implemented and independently reviewed. Parent
real-worker/controller gate 28026 passed 19/19; adjacent delivery/repair/portfolio
gate 27652 passed 105/105. Final proof/private-Git gate 31486 passed 67/67.
Automatic quota-to-successor-chain acceptance 31303 passed 1 selected case in
233.34 seconds; two other cases were filtered. Native 76456 remains live and fixed9a;
this new source correction will change future bundle bytes and is not included in
that native invocation. Do not conflate source tests with installed qualification.

There are 192 distinct passing tests across ten files for the corrected source.
No new build was run while native 76456 retained its fixed installed assets.
Last native poll at approximately 11:24 UTC confirmed the same session running;
continue that handle next turn. A fresh read-only sample at 11:23:59 UTC still
showed healthy active global stop and pending v1 collector without owner evidence.
No authority or real account state changed. Optional restart-verified recovery
direction was requested asynchronously; it does not block the source work.

## Discovery corrections

An initial workplan patch expected a standalone sentence that shared a line;
corrected the exact context and retried. Inferred filenames were replaced with
rg-discovered actual paths; no source edits depended on missing files.

The independent RED regression35514 reproduced erroneous old-code delivery.
An unmeasured-campaign fixture incorrectly wrote own seedContext:undefined;
omitting the absent field restored production-compatible evidence. A synthetic
controller reader also needed an independently cloned durable campaign response
for the new mandatory readback; gate28026 then passed all19 tests. No acceptance
condition was disabled to obtain those results.
