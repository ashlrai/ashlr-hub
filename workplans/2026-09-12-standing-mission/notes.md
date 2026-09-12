# Standing mission findings

Starting state: clean primary at357f8c35. Existing supervisor is finite and cannot
be truthfully presented as a resident24/7mission. Current task investigates actual
caller integration rather than extending an old deadline.

## Source-backed design

- Legacy mission graphs and shadow receipts grant no execution/budget authority.
  Reuse existing resource preparation, engineering owner, supervision and successor
  machinery rather than the legacy conductor's watch mode.
- Setup refused any existing preparation registry on the ledger; the registry and
  active owner each bound their catalog to32. A fixed optional host-selected
  registrationScope now partitions preparation history while preserving all
  accounting paths and private-store anchor checks. Each active scope stays32.
- The immutable record store requires a direct child of its anchor. Therefore
  storage is the flat sibling console-engineering-preparations-scope-<ID>, not a
  new nested anchor. Omitted scope retains exact legacy paths/context hashes.
- Pool task caps already count shared capacityKey reservations across campaigns;
  General/Spark aliases do not get duplicate allowance. Reuse this ledger instead
  of inventing another mission quota authority. Unknown provider token reporting
  remains unknown, not a hard input-token guarantee.
- The shared pool ledger itself has4096attempt and4MiB bounds. Long-run retained
  history/segmentation remains needed; scope partitioning does not remove that
  independent capacity boundary.
- Closing an old owner proves drain, not completed obligations. A later standing
  mission must verify exact predecessor settlement before selecting a new scope;
  this explicit setup capability is not automatic renewal/recovery.

## Verification so far

- Setup21262:20/20passed,45.74seconds. Checks separatepreparedhistories, unchanged
  pool-state bytes, exactreplay, scope-drift and sharedpendingcollector refusal.
- Static70578 and20152:source types, strict setup-test imports, scopedlint and
  documentation checker passed.
- Real two-console63732:1passed/4filtered,46.57seconds. Sameledger, twoevaluated
  branchrepairs, twoaccountedrequests,60reportedtokens, oldreceipt/records/bundle/
  branchunchanged,70percentallocation andsparepausepreserved. Secondrequestreaches
  the original shared taskcap. This test explicitly starts each console; no claim
  of automatic inter-envelope rollover.
- Legacy CLI/preparation gate66855:90/90passed across5files,105.10seconds.
- Actual discovered web gate39309:60/60passed across3files,1.17seconds;
  previous zero-collected guessed-path command is not counted.
- Web types and real-IO lane membership52778 passed. Initial registry75164
  passed12tests; final rerun includes both new dangling-link refusals and an
  exact checked-plan capacity test. Dangling namespaces now fail locally before
  the generic reader can misclassify them as absent; no shared-store changes.
- Final registry46234:14/14passed,56.92seconds; strict imports13358 and final
  parent source/web types + scoped lint27269 passed. Independent final review
  found no blocking issues after capacity-test correction and dangling-link guard.
- Scoped actual setupCLI/backgroundA-proposal-B acceptance42535 is still live
  at this note. Do not restart solely because Vitest has not emitted output.

Update:42535 is terminal, exit0. One scoped case passed, one legacy case filtered,
252.39seconds total (250.99test). ActualsourceCLI→emittedconfig→background→A/proposal/B
verified5requests,150reportedtokens,6evaluations, two scopedregistrations, exact
A→Bcommitlineage, unchanged70percentallocation/sparepause and originaldeadline,
no duplicate requests or rewritten registrations onrestart. No providers used.

## Concrete next implementation

Before a mission selects its next scope, add one bounded predecessor-settlement
reader that joins existing proofs rather than a new scheduler. Setup check already
verifies scoped bundle/receipt/config identities. Extract supervision's existing
private DurableState validation into an owner-free read: snapshot alone projects
cached state. Match the full registration census to exact queue membership.
Join successor journal intents to completed receipts and either parsed stop or
prepared/admitted/completed work; coordinator close alone permits incomplete
intent chains. Extract the durable part of preparation.successorSource to prove
the unique delivered descendant tip, not a timestamp-selected branch. Finally,
retain existing seed/measurement/builtin-trial settlement guards and shared ledger
reserved/uncertain refusal, await all actual owners' close, then re-read. None of
these completion proofs may be inferred just from owner disappearance.
