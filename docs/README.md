<a id="ashlr-documentation"></a>

<a id="ashlrverse-documentation"></a>

# Phantom documentation

Phantom by AshlrAI is the engineering workbench, formerly Ashlr Verse. Its local
kernel includes the Universe experiment runtime and compatible command interfaces.
The published canonical package is `@ashlr/phantom`; existing `@ashlr/hub` SDK
imports belong to the compatibility releases. `phm`, compatible `ashlr` commands,
`/verse/` routes and stored identities retain their supported meanings; see
[the product naming guide](PHANTOM-BRAND.md).
Historical Ashlrverse research and build contracts keep their original names.
Use one canonical guide for each task. The North Star is a target, not a claim
that every integration, provider or autonomous effect is active.

## Start here

| Your task | Canonical guide |
|-----------|-----------------|
| See real candidates, rejection and parent-linked improvement without model credentials | [Executable demo](DEMO.md) |
| Understand the objective and how progress is measured | [Phantom North Star](NORTH-STAR.md) |
| Separate tested firm machinery from remaining activation and integration work | [Autonomy gap map](AUTONOMY-GAP.md) |
| Exercise signed graph execution and a deliberately lying candidate | [Firm graph fixture](FIRM-DEMO.md) |
| Connect autonomy research to engineering acceptance | [Autonomy engineering brief](UNIVERSE-AUTONOMY-RESEARCH.md) |
| Compare Phantom with current agent platforms using measurable acceptance gates | [Competitive acceptance](https://github.com/ashlrai/phantom/blob/master/docs/VERSE-COMPETITIVE-ACCEPTANCE.md) |
| Connect a resource and make a first useful turn | [Quickstart](QUICKSTART.md) |
| Choose chat or fleet work, understand routing and inspect results | [Automatic work](AUTOMATIC-OUTCOMES.md) |
| Understand the current components and their boundaries | [Architecture](ARCHITECTURE.md#current-runtime-map) |
| Configure experiments, campaigns, portfolios and artifact delivery | [Universe operator guide](ASHLR-UNIVERSE.md) |
| Configure native/local workers, quotas, the foreground queue and fleet map | [Resource Pools](RESOURCE-POOLS.md) |
| Install or roll back an exact trusted local package | [Pinned runtime](ASHLR-UNIVERSE.md#install-a-pinned-local-runtime) |
| Change code and verify it locally | [Contributing — source guide](https://github.com/ashlrai/phantom/blob/master/CONTRIBUTING.md) |
| Build release evidence and distinguish distribution from activation | [Releasing — source guide](https://github.com/ashlrai/phantom/blob/master/docs/RELEASING.md) |
| Run agents in Phantom against your accounts and a local model | [Local fleet](https://github.com/ashlrai/phantom/blob/master/docs/LOCAL-FLEET.md) |
| Inspect managed OpenAI Agents sessions through the read-only CLI | [OpenAI Agents integration](OPENAI-AGENTS-INTEGRATION.md) |
| Understand supported Dots companion workflows and the plugin-event integration path | [Dots companion](DOTS-COMPANION.md) |
| Apply durable sessions, steering, tool discovery and context ideas to the existing harness | [Agent harness evolution](AGENT-HARNESS-EVOLUTION.md) |
| Choose goal and Leader preferences, inspect review evidence, and run or compare local benchmarks | [Operator preferences and evidence](AGENT-HARNESS-EVOLUTION.md#operator-goal-and-leader-preferences) |
| Inspect recorded producer outcomes and their deterministic learning path | [Execution feedback](EXECUTION-FEEDBACK.md) |
| Read current and historical account usage, credit units, captured dollar balances and cloud estimates | [Resource evidence](RESOURCE-EVIDENCE.md) |
| Decide whether to give one agent the whole context window or four a quarter each | [Plan deep, execute wide](https://github.com/ashlrai/phantom/blob/master/docs/LOCAL-CONTEXT-STRATEGY.md) |
| Finalize and publish original qualified release artifacts locally | [Releasing locally](https://github.com/ashlrai/phantom/blob/master/docs/RELEASING-LOCALLY.md) |
| See what multi-folder workspaces, GitHub and MCP management still need | [Workspaces build contract](https://github.com/ashlrai/phantom/blob/master/docs/VERSE-WORKSPACES.md) |
| Read a Phantom chat's context meter, choose standard or expansive context, and continue a long session in a fresh chat | [Context windows — source guide](https://github.com/ashlrai/phantom/blob/master/docs/VERSE-CONTEXT.md) |
| Use the Phantom workbench: Command, Fleet, Growth and Lessons, Mind, Chat and its panel (terminal, browser, changes, sources, reasoning), the Needs-you and Resources drawers, the repo wiki, playbooks, automations, ⌘K, budget modes and account health | [Phantom user guide — source guide](https://github.com/ashlrai/phantom/blob/master/docs/VERSE.md) |
| Talk to the Leader from Phantom, Telegram or the CLI: directives, answers, approvals, briefs, founder mode | [The Leader — source guide](https://github.com/ashlrai/phantom/blob/master/docs/LEADER.md) |
| Hand work to Claude Code cloud sessions or Devin, and triage what they deliver | [Cloud lane — source guide](https://github.com/ashlrai/phantom/blob/master/docs/CLOUD.md) · [Devin — source guide](https://github.com/ashlrai/phantom/blob/master/docs/DEVIN.md) |
| Understand the standing authority design, and turn autonomy on under a grant that starts in shadow | [Standing authority — source guide](https://github.com/ashlrai/phantom/blob/master/docs/STANDING-AUTHORITY.md) · [Current activation state](AUTONOMY-GAP.md#current-activation-state-315) |
| Find a Verse route family, its gates and wire shapes | [Verse build contract — source guide](https://github.com/ashlrai/phantom/blob/master/docs/VERSE-CONTRACT-V1.md#v310-additive-contract--the-workbench-and-the-autonomy-console) |

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

The [ecosystem design](https://github.com/ashlrai/phantom/blob/master/docs/AGENT-NATIVE-ECOSYSTEM.md)
describes federation across independent products. [Mission OS](MISSION-OS.md)
documents mission contracts, and [runtime activation authority](RUNTIME_ACTIVATION_AUTHORITY.md)
records the separate resident-runtime boundary. The
[milestone index](https://github.com/ashlrai/phantom/blob/master/docs/MILESTONE-INDEX.md)
and [historical contracts](https://github.com/ashlrai/phantom/blob/master/docs/contracts/README.md)
are source references, not setup instructions or current release receipts.

Update the owning guide when behavior changes. Keep exact test counts, source
hashes, artifact digests, provider observations and rollback identities in dated
release or commissioning evidence instead of duplicating them throughout the
documentation. Use focused local checks while iterating, then follow the
canonical release guide for required hosted qualification and publication.
