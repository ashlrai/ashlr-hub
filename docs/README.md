<a id="ashlr-documentation"></a>

# Ashlrverse documentation

Ashlrverse is the product vision; Hub is its local kernel, and Universe names the
existing experiment runtime and compatible command interfaces.
Use one canonical guide for each task. The North Star is a target, not a claim
that every integration, provider or autonomous effect is active.

## Start here

| Your task | Canonical guide |
|-----------|-----------------|
| See real candidates, rejection and parent-linked improvement without model credentials | [Executable demo](DEMO.md) |
| Understand the objective and how progress is measured | [Ashlrverse North Star](NORTH-STAR.md) |
| Connect autonomy research to engineering acceptance | [Autonomy engineering brief](UNIVERSE-AUTONOMY-RESEARCH.md) |
| Run a first bounded experiment and inspect its results | [Quickstart](QUICKSTART.md) |
| Understand the current components and their boundaries | [Architecture](ARCHITECTURE.md#current-runtime-map) |
| Configure experiments, campaigns, portfolios and artifact delivery | [Ashlrverse operator guide](ASHLR-UNIVERSE.md) |
| Configure native/local workers, quotas, the foreground queue and fleet map | [Resource Pools](RESOURCE-POOLS.md) |
| Install or roll back an exact trusted local package | [Pinned runtime](ASHLR-UNIVERSE.md#install-a-pinned-local-runtime) |
| Change code and verify it locally | [Contributing — source guide](https://github.com/ashlrai/ashlr-hub/blob/master/CONTRIBUTING.md) |
| Build release evidence and distinguish distribution from activation | [Releasing — source guide](https://github.com/ashlrai/ashlr-hub/blob/master/docs/RELEASING.md) |

The CLI's `universe help`, `resources pool --help` and `runtime help` describe
the command surface in the exact binary you are running. A source guide may
describe features not present in an older registry or desktop release.

## For coding agents

Start with the selected command registry from the binary you intend to use:

```sh
ashlr docs --agent --json
```

From a trusted, built source checkout, use `node bin/ashlr` in place of `ashlr`.
The registry returns command usage, descriptions, safety classifications and JSON
shape references. It is discovery metadata, not a complete schema or permission
to execute. Consult the selected command's help and the owning guide; do not
infer current provider readiness or mutation authority from a safety label.

For an already configured store, these commands inspect evidence without starting
campaigns or contacting model providers. Replace `ID`, `ABS_ROOT` and `ABS_RUNTIME`
with the assigned experiment/campaign ID and explicit private absolute paths;
keep the same root throughout a task.

| Question | Read-only command | Interpret the result |
| --- | --- | --- |
| What experiments and outcomes are recorded? | `ashlr universe status --root ABS_ROOT --json` | Check `sourceState`, run status and measured usage; unknown values are not zero. |
| What recovery state is recorded for this campaign? | `ashlr universe campaign check ID --root ABS_ROOT --json` | Check `sourceState`, `disposition` and `reasonCode`; this does not inspect current workers. |
| Is the explicit resource setup valid? | `ashlr universe resources check --resource-runtime ABS_RUNTIME --json` | Check `status`, worker eligibility and warnings; valid configuration is not authenticated account readiness. |
| Was a local artifact handoff recorded? | `ashlr universe deliveries ID --root ABS_ROOT --json` | Check `sourceState` and each receipt's `status`; `pending`, `unchanged` and `delivered` are different outcomes. |

A zero exit code alone does not mean work is ready, useful or delivered. For
example, campaign `check` returns zero for healthy held or terminal evidence.
Inspect the structured result and use each command's own exit-code contract.
Raw startup records and private JSON can contain tokens or paths; do not publish
them. The [demo exporter](DEMO.md#generate-a-shareable-evidence-graphic) is the
separate, allowlisted path for sharing the deterministic demo.

When execution is within your delegated scope, follow the existing
[experiment contract](ASHLR-UNIVERSE.md#the-experiment-contract),
[bounded campaign guide](ASHLR-UNIVERSE.md#continue-autonomously-with-a-bounded-campaign)
and [worker commissioning guide](RESOURCE-POOLS.md#commission-native-accounts-and-local-capacity).
For [supervised local delivery](ASHLR-UNIVERSE.md#deliver-supervised-campaign-results),
inspect both campaign and delivery outcomes and reconcile receipts before retrying.
A local branch is not a merge, release or production acceptance. Keep scope,
resource reserves and acceptance criteria explicit; routine execution can proceed
within them without turning discovery or a passing trial into broader authority.

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
