# Net improvement over the starting seed

Independent exploration and review found a genuine delivery regression: a measured
passing seed of 140 followed by selected candidates 145 and 144 could deliver 144
because its improvement over 145 bypassed the starting baseline. A private real-Git test
reproduced that erroneous delivery before the fix (35514).

## Implemented source behavior

All generations now need a positive, threshold-meeting improvement over a measured
passing seed in addition to the existing delivery eligibility rules. Archive
exploration and real parent/delta values remain unchanged. Failed-seed repair and
unmeasured legacy campaigns retain their existing policy.

Final Git publication rechecks the durable seed/trial evidence and seed artifact
bytes. Recovery first compares the caller summary to a fresh durable campaign;
omitting or altering seed evidence cannot bypass the rule. Historical regressed
receipts become ineligible handoff evidence without deleting records or branches.

## Verification

- Focused proof and synthetic-evaluator/private-Git matrix 31486: 67/67, 113.22 seconds.
- Real worker/evaluator delivery and controller 28026: 19/19, 40.96 seconds.
- Adjacent delivery, repair and portfolio 27652: 105/105, 111.87 seconds.
- Source and changed-test types, scoped lint, docs and lane checks passed.
- Independent source and parent acceptance review found no remaining blocker.
- Full resource-accounted successor-chain 31303: running; result not yet claimed.

The real worker cases verify 150 → 149 delivery, 140 → 145 → 144 withholding, and
140 → 145 → 139 delivery. They retain exact generation ancestry, original deadlines,
unchanged checkout/index/seed and byte-equal journals on replay.

## Installed qualification remains separate

Native handle 76456 runs the fixed build from 29f3e055 with evaluator 9a051509.
Node is 24.18.0 at /opt/homebrew/Cellar/node@24/24.18.0/bin/node. Its selected full
case covers 23 checks, 15 benchmark regions and two qualification probes; four control
cases are filtered. Do not claim its result while it is running. Do not rebuild
the installed assets underneath it, or restart solely after a silent poll.

The new source correction is not in that frozen installed build. After 76456 is
terminal, build the corrected source and record its own identity. Diagnostic
qualification is not retained three-capture calibration, an installed scored
optimization, account readiness or production activation.

## Commissioning

The selected legacy v1 collector marker still has no owner/boot/PID or activity
evidence; no existing recovery protocol can reacquire its original live lease.
An optional prospective restart-verified recovery path was raised for direction,
not implemented or activated. No real collector state, account reserve, global
stop, provider, resident service, GitHub remote or package publication was changed.

Entire resume found no checkpoint on auto/p00. Prior goal turn was verified
progress; this turn adds a confirmed red-to-green delivery correction while
continuing the specifically identified native qualification handle.
