# Ecosystem conformance evidence

Evidence captured at `2026-09-03T19:57:13Z`. This is a local, uncommitted-worktree
compatibility result. It is not evidence that any package was committed, released,
published, promoted, deployed, or granted authority.

## Evaluated source state

| Product | Branch | Base HEAD | Package version | Working-tree state | Released/published state |
| --- | --- | --- | --- | --- | --- |
| Hub | `codex/v333-iteration` | `6d1bf2fe8a237343681049043ec50fa1b6bf307f` | `3.3.0` | dirty shared checkout; M540/M541/M542 and this runner are uncommitted | not evaluated |
| Core Efficiency | `codex/core-efficiency-receipts-v1` | `d5c2d8e84b4d9042131f149707575042683c819d` | `0.3.0` | dirty managed checkout | not evaluated |
| Plugin | `codex/plugin-efficiency-receipts-v1` | `f96ac3eee90e5f18aed3c91c0d706a94c82275eb` | `1.36.2` | dirty managed checkout | not evaluated |
| Stack Core | `codex/stack-observation-contract-v1` | `fe709ad8b6c487ca0510a1fdef9f2a4ab8751797` | `0.2.0` | dirty managed checkout | not evaluated |
| Locus Core | `codex/locus-workspace-identity-v1` | `8c6cfae47d8b71e6376b19b160de3dee0acc4c2a` | `0.5.0` | dirty isolated worktree | not evaluated |

No release compatibility manifest was emitted because the inputs are not released
artifacts. The runner's JSON is the machine-readable local evidence.

This captured runner report covers Core Efficiency, Plugin, and Stack. Each producer is
evaluated through its own permission-isolated adapter; none is inferred from another
producer's result.

Locus was added after this captured runner report. Its Rust producer and Hub consumer
were checked directly against a 1,578-byte synthetic vector and the exact 1,523-byte
newline-free production CLI projection. Its separate bounded Hub lineage ledger also
passed local continuity, replay, fork, corruption, expiry, capacity, and authority
tests. These are local source-contract results, not released-artifact or live-workspace
results.

## Reproduction

```sh
npm run conformance:ecosystem -- \
  --core-entry "$CORE_ENTRY_PATH" \
  --core-fixture "$CORE_FIXTURE_PATH" \
  --core-fixture-format hex \
  --core-fixture-provenance synthetic-test-vector \
  --plugin-entry "$PLUGIN_ENTRY_PATH" \
  --plugin-fixture "$PLUGIN_FIXTURE_PATH" \
  --plugin-fixture-provenance synthetic-test-vector \
  --stack-entry "$STACK_ENTRY_PATH" \
  --stack-observation-fixture "$STACK_OBSERVATION_FIXTURE_PATH" \
  --stack-effect-fixture "$STACK_EFFECT_FIXTURE_PATH" \
  --stack-fixture-provenance synthetic-test-vector \
  --stack-now 2026-09-03T12:01:00.000Z
```

The pinned `--stack-now` validates the producer's canonical short-lived fixture at
its declared validity time; it does not make a live-freshness claim. Core receipt
freshness is evaluated against the actual Hub clock and its 24-hour acceptance
window, so this checked-in fixture will intentionally fail closed after that window.

All current base-HEAD fixtures are explicitly classified as
`synthetic-test-vector`: their producer implementations are still uncommitted, so
their embedded commits are not release provenance.

## Result

The command exited `2` with top-level `state: "fail"` and `releaseReady: false`.
It reports the original five checks plus an independent live-freshness check:

- `producer-build-present`
- `protocol-compatible`
- `fixture-byte-identical`
- `Hub-accepted`
- `authority=false`
- `current-freshness`

Core Efficiency matched protocol `ashlr-external-efficiency-receipt-v1`, version
`0.3.0`, and digest
`58cf59246b34af48eeadbcec7681e8572da4b7453e653284423ba5d696a5529e`.
All six Core checks passed against the live clock, but its synthetic fixture
provenance keeps `releaseReady` false.

Plugin matched protocol `ashlr-external-efficiency-receipt-v1`, version `1.36.2`,
and digest
`7994d7319bfd771a9d4204ac4d59b87acd17b04e3b9785e308d22f27ff0aa809`.
All six Plugin checks passed against the live clock, but its synthetic fixture
provenance keeps `releaseReady` false.

Stack matched protocols `ashlr-stack-observation-manifest-v1` and
`ashlr-stack-planned-effect-manifest-v1`, version `0.2.0`, observation digest
`sha256:206afbf5206074719aae3e675f7f8d7402634324d57f4c26342692768f4d3735`,
and effect digest
`sha256:e120d252e05c6e3e2d9b1b7acb908e99eb70fe3fc68743ce32529563646c79b6`.
The effect's observation digest binding matched the exact accepted observation.
Its five historical compatibility checks passed at the explicitly supplied fixture
clock. `current-freshness` failed against `evaluatedAt`, so the report cannot be
mistaken for current operational acceptance and Stack `releaseReady` remains false.

Every top-level authority field was `false`. The producer workers run with an empty
environment and Node filesystem/child-process permissions restricted to their own
adapter plus the explicit compiled entry. The report emits only bounded protocol,
version, digest, boolean, and null evidence; it does not echo fixture bodies or paths.

## Verification gates

At capture time:

- `npx vitest run test/m544.ecosystem-conformance-runner.test.ts --no-file-parallelism`: 11 tests passed.
- `npx tsc --noEmit --pretty false`: passed.
- `npx eslint scripts/run-ecosystem-conformance.ts scripts/ecosystem-conformance-producer-worker.mjs test/m544.ecosystem-conformance-runner.test.ts`: passed.
- `cargo test -p locus-core`: 485 tests passed in the isolated Locus worktree.
- `npx vitest run test/m547.external-locus-workspace-identity.test.ts test/m548.locus-workspace-identity-ledger.test.ts`: 29 tests passed against both exact Locus fixtures and the bounded local lineage ledger.
- Live-provider calls, filesystem writes by the runner, commit, push, package publication, promotion, and deployment: not performed.
