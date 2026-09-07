# Ashlr documentation

Hub is the local kernel; Universe is the engineering system it is building toward.
Use one canonical guide for each task. The North Star is a target, not a claim
that every integration, provider or autonomous effect is active.

## Start here

| Your task | Canonical guide |
|-----------|-----------------|
| Understand the objective and how progress is measured | [Universe North Star](NORTH-STAR.md) |
| Run a first bounded experiment and inspect its results | [Quickstart](QUICKSTART.md) |
| Understand the current components and their boundaries | [Architecture](ARCHITECTURE.md#current-runtime-map) |
| Configure experiments, campaigns, portfolios and artifact delivery | [Universe operator guide](ASHLR-UNIVERSE.md) |
| Configure native/local workers, quotas, the foreground queue and fleet map | [Resource Pools](RESOURCE-POOLS.md) |
| Install or roll back an exact trusted local package | [Pinned runtime](ASHLR-UNIVERSE.md#install-a-pinned-local-runtime) |
| Change code and verify it locally | [Contributing — source guide](https://github.com/ashlrai/ashlr-hub/blob/master/CONTRIBUTING.md) |
| Build release evidence and distinguish distribution from activation | [Releasing — source guide](https://github.com/ashlrai/ashlr-hub/blob/master/docs/RELEASING.md) |

The CLI's `universe help`, `resources pool --help` and `runtime help` describe
the command surface in the exact binary you are running. A source guide may
describe features not present in an older registry or desktop release.

## What the evidence means

- **Implemented** means the code path exists; **verified** names the tests that ran.
- **Packaged** identifies exact built bytes; **published** identifies their distribution.
- **Commissioned** means a specific provider/runtime was configured and exercised.
- **Accepted engineering value** requires useful artifact-level acceptance, not
  process completion, token consumption, dashboard activity or a benchmark alone.

Universe evaluates candidates and retains evidence. Resource Pools manage explicit
worker capacity and execution receipts. These paths are not yet automatically
connected into an unattended subscription-backed product factory. Keep their
roots, budgets and acceptance evidence explicit.

## Deeper design and history

The [ecosystem design](https://github.com/ashlrai/ashlr-hub/blob/master/docs/AGENT-NATIVE-ECOSYSTEM.md)
describes federation across independent products. [Mission OS](MISSION-OS.md)
documents mission contracts, and [runtime activation authority](RUNTIME_ACTIVATION_AUTHORITY.md)
records the separate resident-runtime boundary. The
[milestone index](https://github.com/ashlrai/ashlr-hub/blob/master/docs/MILESTONE-INDEX.md)
and [historical contracts](https://github.com/ashlrai/ashlr-hub/blob/master/docs/contracts/README.md)
are source references, not setup instructions or current release receipts.

Update the owning guide when behavior changes. Keep exact test counts, source
hashes, artifact digests, provider observations and rollback identities in dated
release or commissioning evidence instead of duplicating them throughout the
documentation. Verification is local; do not enable GitHub Actions to follow
these guides.
