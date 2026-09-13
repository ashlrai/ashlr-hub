# Integration notes

Primary branch auto/p00 is clean at 242cf7fd. Isolated branch
codex/spark-enrollment-preparation is at 1ff4184384c57a340babddedc9b2dfad9aacbb17,
with only the intentionally untracked dependency symlink before this plan.

Ordered source commits are af5d02bd then 1ff41843, based on primary fc66f69e.
Later primary changes are bookkeeping only. The primary installed evaluator
digest is 25d5787412e177238745216d259a9167768ca6460bfed126cc453eb714d0f953.

The existing native suite measures two frozen baselines, poisoned manager
behavior, installed artifact drift before and after actual process settlement,
and cancellation. Its long-running subprocesses must finish under the original
test deadlines, without replacing source or the installed bundle.

Known activation blockers are the legacy v1 collector record without ownership
evidence, the active global stop, unavailable or stale quota, and absence of an
installed genuine scoring calibration. A prepared Spark proposal and a rendered
inspection panel do not resolve any of those conditions.

## Review findings

- Independent integration review found no conflicts and passed a read-only patch
  applicability check against primary. No scoring runtime files change.
- Account-operation review confirmed existing pool evolution plus quota-scope
  access APIs are sufficient: migrate first, merge General exclusion with a fresh
  revision, verify, and only then consider releasing the whole-account pause.
  Existing exclusions and75%allocation must not be replaced.
- Native acceptance audit identified missing retention on throw/unconfirmed
  result and a non-sticky cancellation cleanup assignment. Fix only in isolated
  test sources while primary test handles run.
- The native measurement suite does not include all four current/stale packaged
  qualifier controls. Handle3245 runs only that describe block against the
  unchanged primary25d57874 bundle. Full-workload case is filtered out, not counted
  as executed. This does not provide genuine calibration captures.
