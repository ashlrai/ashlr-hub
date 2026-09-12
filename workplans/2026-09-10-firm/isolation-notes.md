# Candidate isolation findings

Baseline: 96e9a6e82402b337532fcbb1a934a3cca52a0fb7, initially clean auto/p00.

- At that baseline, `scripts/evaluators/preparation-verification.mjs` shares a process
  with candidate code. Its restricted VM reduces accidental interference, but
  exposed host constructors can reach that process; measurements are deliberately
  rejected by the normal evaluation parser.
- `src/core/run/verify-commands.ts` already owns bounded subprocess input/output,
  cancellation and process-group settlement. Its one-shot stdin interface can
  initialize a persistent bounded mailbox session without a shared runner rewrite.
- `src/core/universe/fixed-evaluator.ts` provides existing macOS confinement and
  pre/post comparator checks. A nested profile must make controller fixtures and
  inbox read-only; inheriting the outer writable scratch is insufficient.
- Existing process-group settlement does not cover deliberately detached
  descendants. A local sandbox probe with process-fork/signal denied allowed Node
  bootstrap and rejected native spawnSync with EPERM. Broker necessary read-only
  commands in the controller instead of permitting direct candidate forks.
- Child JSON is untrusted result data, not an assertion, score, process count,
  getter-activity proof or execution permission. Expected outputs and snapshots
  stay outside it; the same candidate must face mutation between calls.

Current implementation separates controller and persistent candidate, brokers
readonly commands and retains the original session deadline. Actual local tests
cover mailbox validation, readonly scope, network/native-fork denial, malformed
returns, repeated unchanged public-method outputs and timeout cleanup. The final
gate and precise limitations are recorded in [report.md](report.md).

The nested launch experiment found `sandbox_apply: Operation not permitted`.
This is an OS refusal of a second sandbox, not missing fixture permissions. The
existing Universe evaluator path remains unavailable and fails closed with a
specific safe code; do not infer production acceptance from direct child tests.
Controller-crash recovery and universal process isolation remain open.

Exploration command correction: confinement lives at
`src/core/sandbox/confine.ts`, not `src/sandbox/confine.ts`.
