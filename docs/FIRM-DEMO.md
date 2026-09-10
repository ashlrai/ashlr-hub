# Run the signed firm graph fixture

This source-build demo exercises the new graph kernel without contacting a model,
running candidate code, switching accounts, changing HOME or activating a daemon.
It is a deterministic fixture, not an autonomous engineering deployment.

## Prerequisites

- Build this branch locally with `npm ci --ignore-scripts` and `npm run build`.
- Supply an existing absolute, canonical directory owned by you with mode `0700`.
  Use a dedicated directory: one graph definition is pinned to each root.
- The existing host-local provenance key must already be available. These commands
  do not create or replace it. Missing or unsafe key storage returns unavailable.
- Leave the existing global KILL switch engaged if you intend to stop execution.
  The demo does not clear it. A `KILL` entry inside the explicit demo root is an
  additional restrictive stop, not another authority source.

## Execute and inspect

Replace `/absolute/private/firm-demo` with your dedicated directory:

```sh
node bin/ashlr universe firm demo --root /absolute/private/firm-demo --json
node bin/ashlr universe firm status --root /absolute/private/firm-demo --json
node bin/ashlr universe firm query --root /absolute/private/firm-demo --entity node:verify-liar --limit 2 --json
```

The fixture records two genuinely different boolean XOR strategies. Its builder
emits a declarative four-row result; a separate deterministic checker resolves
the pinned specification and checks every row. A second builder emits a wrong
row while claiming every test passed. The checker rejects that candidate.

Successful fixture output has `status: "accepted-fixture"`, four completed nodes,
one deliberately rejected node, eleven signed event traces and a retained conflict
link. The underlying graph is **not** labeled completely successful: rejection is
the intended negative control. Filtered queries retain conflict links even when
their other endpoint is outside the page. The graph reader verifies signatures;
the underlying structural query reports `signatureVerification: "not-performed"`
because authentication happened at the reader boundary, not in that pure filter.

`status` and `query` are read-only. Re-running `demo` preserves existing history:
completed work is not dispatched again, unresolved intents are held, and the
original sixty-second execution deadline is not renewed. After expiry, use
`status` to inspect a completed fixture; a new execution needs a new explicit root.

SIGINT, SIGTERM and KILL request cooperative cancellation. The fixture has no
subprocesses, but the generic graph waits for trusted adapters to settle; it cannot
force-terminate an arbitrary in-process callback. Never interpret a timeout as
proof that externally owned work is dead or safe to retry.

## Evidence boundary

### Inspect any signed graph

The fixture-specific `status` and `query` commands retain their original contract.
Use `graph` and `traces` for any persisted control graph, including incomplete
graphs. These commands neither dispatch work nor acquire execution ownership:

```sh
node bin/ashlr universe firm graph --root /absolute/private/firm-graph --json
node bin/ashlr universe firm traces --root /absolute/private/firm-graph --action graph-settled --entity node:builder --limit 20 --json
```

Trace filters also accept inclusive `--since` and `--until` UTC ISO timestamps.
The default page contains up to 100 traces in history order; the maximum is 256.
Conflict links remain intact even when the other trace is outside the page.
`status: "available"` describes verified evidence availability, not execution
success. Consult `graph.status` or `graphStatus` for the recorded execution state.
Missing or unverifiable history exits with code 1 and exposes no traces; invalid
filters exit with code 2. No keys are created. Read-only inspection remains
available under KILL, but it does not prove a worker is currently alive.

### What signatures establish

The trace uses the existing provenance HMAC. This is integrity under a host-local
key, not process isolation, independent model judgment, anti-rollback protection,
resource capacity or an activation permit. Distinct checker IDs are caller-enrolled
metadata. A real cold model transport and confined execution still need wiring.

Memory, harness archive and payment broker tests exercise separate components;
this demo does not claim it already composes them into the resident company loop.
See the [autonomy gap map](AUTONOMY-GAP.md) for the remaining integrations.

## Local checks

```sh
npm run typecheck
npm run lint
npm run check:docs
npx vitest run test/universe-firm-demo.test.ts test/universe-control-graph.test.ts
node bin/ashlr verify-safety --json
npm run test:invariants
```

No GitHub Actions are required or invoked. Preserve and report any skipped
invariant tests rather than claiming their coverage was executed.
