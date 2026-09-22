# Unattended execution notes

Start: primary auto/p00 at f4ac1af58e11d4195bd6ad5d14ed3ff9d436f1a3.
Last clean build is e732a824; later changes are evidence/documentation only.
At turn start, installed evaluator was 25d57874, with prior native gate 489 tests
passing. The shared runtime change is bundled into the bridge and fixture assets;
the next build must record a new identity, not inherit exact-digest qualification.

Actual commissioning was still blocked by healthy active global stop and a legacy
v1 collector record lacking owner evidence at the end of the prior turn. These
conditions will be checked separately from source functionality. No live native
validation handles remain.

The original vision attachment emphasizes a running firm, verified yield and
existing activation/stop authority. Current doctrine confirms tokens spent alone
are not progress and routines should execute inside delegated resource envelopes.

Three-agent findings:

- Ordinary autoAdmitPrepared, appendable queues and successor execution are wired.
- Actual v1 collector metadata has no owner/PID/boot; sidecar, recovery receipt and
  collector lock are absent. There is no supported current recovery path; missing
  ownership evidence cannot be reconstructed from absence or a timestamp.
- Existing scope-policy API already handles General exclusion after migration;
  another scheduler or reservation panel is not needed.
- New successor tick records intent before discovering known unavailable quota.
  Future polls hold that intent because no execution receipt exists. A pre-intent
  eligibility check can defer it without relaxing post-dispatch accounting.

Review-driven refinement: ordinary resourcePoolStatus conservatively merges
persisted observations, whereas final dispatch also projects fresh evidence alone.
The new read-only resourceAdmissionPreflight reuses an extracted freshAdmission
helper from final dispatch. The same four occupancy/allowlist/scope-policy exception
reasons remain intact; fresh quota refusals cannot be rescued by a cached zero.
No state or lock is published by the preflight. Its result is still only a sample;
final transaction admission remains authoritative after source verification.

Test correction: an initial array-parameterized invalid-allowlist case exercised
the fixture default accidentally. Object cases fixed that test-only error; strict
types and the final 72-case combined/24-case focused runs passed afterward.
