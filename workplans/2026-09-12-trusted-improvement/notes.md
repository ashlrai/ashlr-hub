# Evidence and decisions

- Existing registry permits only `preparation-measurement-v1`, a diagnostic.
- Existing capture stores bind report bytes, artifact and installed pins, but
  replay is explicitly historical and not fresh runtime health.
- The planned score uses four leaf and eleven workflow-request counts, with
  per-region nonregression. Total is leaf + workflow counts, excluding blob
  subtotals and fixture-owned groups.
- Ordinary builtin trials now preserve uncertain custody. Reuse that path;
  adding an accepted score must not weaken its settlement checks.
- Exact candidate scope and candidate-linked during-call mutation controls are
  required before any improvement can be accepted or delivered.

## Implemented evidence path

- Three distinct settled, identity-verified captures produce a deterministic
  descriptor only when full artifact, evaluator, manifest/comparator and all
  fifteen scenario vectors agree. Equal raw report hashes are valid repeatability.
- Caller-pinned target hash and complete artifact inventory anchor the baseline.
  A candidate capture must match the workload and every non-target entry, including
  executable flags; only preparation-source content can differ.
- Region process or blob regressions dominate aggregate gains. Blob subsets and
  fixture process groups are not double-counted. Unknown totals stay unknown.
- CLI and SDK expose authoring and comparison without new execution or writes.
  A parsed descriptor remains caller-supplied diagnostic input, not acceptance authority.
- Independent reviewers checked digest reconstruction, whole-inventory joins,
  integer overflow, proxy/accessor refusal, redaction and bounded file reads.
- Real filesystem CLI round trips used synthetic journal contents. Adjacent native
  tests exercised installed diagnostic/custody behavior, not successful calibration
  or an accepted source optimization.
