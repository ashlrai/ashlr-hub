# Resource commissioning verification

## Source gate

- Node 24.18.0, existing local dependency install; no GitHub Actions.
- `vitest run test/resource-*.test.ts test/m43.verify-commands.test.ts
  test/m414.local-store-lock-unknown-owner.test.ts
  test/m416.local-store-lock-handoff.test.ts --no-file-parallelism`:
  24 files, 1,077 passing, one Windows-only test skipped, 82.03 seconds.
- Full web Vitest: 40 files, 323 passing, 10.76 seconds.
- Full core/web typecheck: passed.
- Full ESLint: zero errors, 105 existing warnings. Changed-file ESLint clean.
- Real-IO membership guard: passed; three new process/filesystem suites enrolled.
- Build and `git diff --check`: passed.
- Independent final server lane: 43 passing, collector/native HTTP lane: 62
  passing, managed reader/worker/public boundary: 119 passing. These overlap the
  source gate above; do not add them again to the total.

## Native versus fixture evidence

The source CLI performed one actual no-generation metadata probe through the
already installed default Codex launcher. It observed Pro metadata and one
selected quota window in 1.088 seconds. The report is private, outside Git:
`/Users/masonwyatt/.codex/artifacts/ashlr-resource-commissioning.pGyhpb/native-probe-source.json`.
No second native account, Claude quota poller, local model, resident service or
engineering fleet was activated. Normalized account hints do not prove separate
subscription capacity. Quota percentages expire and are not token allowances.

## Immutable package and handoff

After committing this source gate, build/pack from clean source, independently
verify installed bytes against the archive, run installed CLI acceptance and
browser acceptance. Keep exact SHA, archive hashes, release/merge state, browser
results, rollback identity and remaining gaps in the external artifact handoff
beside the private source probe. This file records the pre-package source gate,
not a claim that installation or publication has already completed.

GitHub Actions was rechecked disabled. Existing medium Rust glib Dependabot
alert 32 remains open outside this TypeScript increment. Registry publication,
all-account generation acceptance and unattended fleet operation are not claimed.
