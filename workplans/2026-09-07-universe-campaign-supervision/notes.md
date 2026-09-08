# Findings

PR375 provides typed read-only campaign readiness and explicit local model inventory
refresh. Campaign run already repeats generations within original budgets, but
resource withholding pauses it and no supervisor resumes it automatically.
Run admits exact expected summary identity inside the Universe lease and performs
campaign-event compare-and-swap when recording a new owner.

An operationally paused campaign currently makes pause a no-op; explicit owner
intent must be recorded before any supervisor can safely wait. Raw events may
change even where summary projection is similar, so supervision pins recordsDigest
as an optional runner expectation in addition to summaryDigest.

Resource withholding conflates stale/missing evidence, quota denials and occupied
capacity. Timer-based resumption consumes another campaign reservation before
resource admission. This increment launches explicit never-started queue entries
once only; held/uncertain work stays held with a machine-readable reason.
