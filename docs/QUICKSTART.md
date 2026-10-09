<a id="quickstart--ashlr-verse"></a>

# Quickstart — Phantom

Phantom by AshlrAI is the everyday coding-agent workbench, formerly Ashlr Verse.
The Universe experiment kernel is a separate, bounded source-checkout path below.
Installing Phantom, enrolling a repo, starting a resident fleet and publishing
its work are distinct steps.

The primary CLI is `phm`; `ashlr` remains compatible. Current source uses
`@ashlr/phantom` in `ashlrai/phantom`; the canonical 3.27.0 release is published.
The verified 3.25.3 compatibility release remains `@ashlr/hub`.
Local routes remain `/verse/`, and the published macOS app is `Phantom.app`. See
[the product naming guide](PHANTOM-BRAND.md).

<a id="open-verse"></a>

## Open Phantom

### CLI on macOS, Linux or Windows

Install Node.js 22.15+ and Git, then install the published canonical release, Phantom 3.27.0:

```sh
npm install -g @ashlr/phantom@3.27.0
phm --version   # should print 3.27.0
phm verse
```

Phantom opens at `http://127.0.0.1:7777/verse/` and binds to loopback. The CLI
prints a read token for the browser and asks for a separate mutation token
before your first chat or other change. Keep both tokens private. Confirm
`phm --version` reports `3.27.0`; the
[versioned GitHub release](https://github.com/ashlrai/phantom/releases/tag/v3.27.0) is the
source for versioned installers. Use the explicit package version above and inspect the selected release artifacts before installing.

### Desktop app on Apple silicon Mac

Use the published [v3.27.0 Phantom macOS arm64 DMG](https://github.com/ashlrai/phantom/releases/download/v3.27.0/Phantom_3.27.0_aarch64.dmg)
from its [versioned release](https://github.com/ashlrai/phantom/releases/tag/v3.27.0).
It fixes the reproduced 3.25.2 updater-client startup issue. Publication and
installed startup acceptance remain separate; do not install the old 3.25.2 DMG.
The desktop includes the CLI and the same console. The app inside the DMG is
locally signed; the DMG is unsigned. Neither is Apple Developer ID notarized;
macOS may require **Open Anyway** on first launch.
For a source build and local signing, follow [Releasing locally](https://github.com/ashlrai/phantom/blob/master/docs/RELEASING-LOCALLY.md).
There is no Linux or Windows desktop package in this release; use the CLI above.

### Read the workbench before starting work

- In the desktop top bar, expand **Automatic awake** to inspect the idle-sleep
  request and choose **Automatic during local work**. A browser reports host
  power unavailable; display sleep, locking and lid closure remain separate.
- Expand **Resources** for dated usage and Devin organization consumption.
  Consumed ACUs are distinct from the tracked budget and do not show remaining
  subscription or purchased credits.
- Open **Growth** for source-qualified adoption readings. Retrievals, traffic
  and downloads use different windows and do not count active engineers.
- In Fleet or Resources, inspect **Use allowance before resets**. Saving On
  does not establish execution eligibility. Current unbound producers retain
  the saved reserve; Off disables both reset priority and reserve shrinking.
  Read [the reset guide](RESET-AWARE-SCHEDULING.md) before changing the setting.

### Choose how to work

**Work with me** is a conversation you steer: Automatic picks an eligible
resource; Advanced pins an explicit account or model. Choose **Manager** in the
Auto seat menu when you want planning, delegation and review in one conversation.
It uses the resident fleet and its existing authority.

**Work for me** is a durable outcome: the Leader refines priorities and ready
tasks, while you inspect progress and answer decisions in Phantom or configured
Telegram. Enabling a Manager on an outcome adds its coordination and review path.
Saving an outcome or changing workspaces does not start the fleet.

Supported CLI accounts, configured APIs and tool-capable local models share the
workbench, but keep their own billing and limits. In **Resources**, check both
chat and fleet readiness. Signed out, missing usage, exhausted quota, reserved
capacity or missing authority can hold work; connection alone is not readiness.
See [Automatic work](AUTOMATIC-OUTCOMES.md) for resource boundaries and recovery.

### Make your first useful turn

1. Choose **Work with me**, open **New chat** and choose a project folder. Saving a folder as a project
   does not enroll it for unattended fleet work.
2. Use provider CLIs you are already signed in to, or start Ollama with
   a tool-capable local model. **Automatic** chooses an eligible resource;
   open **Advanced** if you want to pin an account or model. For separate Claude Code, Codex and Grok accounts,
   follow [seat commissioning](RESOURCE-POOLS.md#commission-native-accounts-and-local-capacity).
   Each vendor signs in through its own CLI; Phantom does not take its password.
3. Ask for a small, checkable change. Inspect reported tools, context and
   sources, then review the diff and verification results before accepting it.
   Usage can be reported, estimated or unknown; a producer's success message
   alone does not prove delivery. Use **⌘K** to find actions and **⌘J** for
   **Needs you**. The full interface is in the [Phantom guide](https://github.com/ashlrai/phantom/blob/master/docs/VERSE.md).

Choose **Work for me**, open Fleet and select **New outcome**. Describe the
result, select enrolled repositories and add observable acceptance criteria.
The Leader refines the work; expand its tasks to inspect runs, proposals and
verified merge evidence. Edit, pause or resume the outcome as it evolves.
See [Automatic work](AUTOMATIC-OUTCOMES.md). Standing instructions also guide
the Leader's fleet planning. Changing workspaces only navigates; it does not start the fleet or
change your permission mode. Optional planning, CI and spend settings are under
**Options** when creating an agent.

Several available seats can receive the same task, each in its own workspace.
There is no preset six-seat fan-out ceiling. Workspace retention defaults to
25; `ASHLR_VERSE_AGENT_CAP=none` disables retention-driven automatic archiving,
or use a positive safe-integer count. Capacity and provider quotas still govern
execution. This environment setting applies when the Phantom process starts and
does not widen fleet authority.

The optional phone gateway is a separate, Access-protected and Mac-approved
surface; [set it up](REMOTE-PHONE.md) rather than exposing the main loopback
console. Resident autonomy is macOS-only and starts dormant. Inspect the
**installed** release with `ashlr authority status` and
`ashlr authority setup --dry-run --json`, then use the
[autonomy setup guide](https://github.com/ashlrai/phantom/blob/master/docs/AUTONOMY-SETUP.md) if you want to sign a standing grant.
A source checkout or a static guide cannot establish the current service state
on your Mac.

## Run a bounded Universe experiment

This path is for evaluating the local experiment kernel from a trusted source
checkout. Source commands may differ from the published npm package; confirm
with the [release record](https://github.com/ashlrai/phantom/blob/master/docs/RELEASING.md) and your selected binary's help.

| What you want to do | Supported path |
|--------------------|----------------|
| Run reproducible code experiments without model credentials | [Current Universe kernel](#run-the-current-universe-kernel) |
| Inspect one experiment store and its evidence graph | [Scoped Universe console](ASHLR-UNIVERSE.md#observe-one-universe-store) |
| Run explicitly configured Codex, Claude Code or local workers | [Resource Pool commissioning](RESOURCE-POOLS.md#commission-native-accounts-and-local-capacity) |
| View worker assignments, capacity and a controllable foreground queue | [Resource operations console](RESOURCE-POOLS.md#operate-the-resource-console) |
| Run independently of a mutable source checkout | [Pinned local runtime](ASHLR-UNIVERSE.md#install-a-pinned-local-runtime) |

## Run the current Universe kernel

Prerequisites: a trusted source checkout, Git and Node.js 22.15+. Current Universe
experiment execution additionally requires macOS `sandbox-exec`; Linux isolation
and Windows execution are not yet supported for that path. Building the CLI and
reading supported console evidence are separate from executing experiments.

1. In the repository root, install the locked dependencies and build the CLI and
   web assets. Installation and build execute trusted repository scripts locally:

   ```sh
   npm ci
   npm run build
   node bin/ashlr universe help
   ```

2. Choose a new absolute private experiment root, outside the source checkout,
   with an existing physical parent. Run the demonstration only in that selected
   root; it creates a seed repository and performs bounded local code execution:

   ```sh
   node bin/ashlr universe demo --root /absolute/private/experiments --json
   ```

   Expect tested code variants, rejected candidates and later-generation parent
   references. This deterministic example proves the experiment mechanism, not
   model capability or accepted product value. No provider account is required.

3. Inspect the same root without starting another experiment:

   ```sh
   node bin/ashlr universe status --root /absolute/private/experiments --json
   node bin/ashlr universe archive --root /absolute/private/experiments --json
   ```

4. Start its foreground, read-only loopback console:

   ```sh
   node bin/ashlr universe console --root /absolute/private/experiments --json
   ```

   Open the printed URL, enter its private read token and inspect campaigns,
   trials and the evidence graph. Keep the terminal running; Ctrl-C stops this
   console. Never share its startup token or put it in a URL. If records appear
   missing, compare the console's displayed root with the command above before
   creating more state. See the [operator guide](ASHLR-UNIVERSE.md) for failure
   recovery and campaign controls.

The demonstration can be replaced with explicitly configured local-model
generation or the opt-in [resource generation bridge](ASHLR-UNIVERSE.md#generate-candidates-through-an-enrolled-resource-pool).
The bridge uses enrolled native or local workers through Resource Pools; it needs
an explicit private runtime binding, fresh observations and resource limits
before dispatch. The fleet map does not create accounts or evidence. Follow the
commissioning guide above before authorizing generation.

<a id="general-hub-and-legacy-fleet-setup"></a>

## General Phantom and legacy fleet setup

`ashlr init`, `ashlr serve`, `ashlr enroll` and `ashlr daemon` remain compatibility
surfaces beneath the workbench. For their command and safety contracts, use the
[Phantom reference](https://github.com/ashlrai/phantom/blob/master/docs/HUB-REFERENCE.md). The current first-run console is
`ashlr verse` at `/verse/`; older `/` and `/next/` dashboard guidance should not
be used as a Phantom onboarding path.

To inspect resident authority, use the **installed** binary, not an unbuilt
source checkout:

```sh
ashlr authority status
ashlr authority setup --dry-run --json
ashlr authority resident status --json
```

A grant, service installation and live resident process each require their own
verification. The [autonomy setup guide](https://github.com/ashlrai/phantom/blob/master/docs/AUTONOMY-SETUP.md) covers signing,
starting, stopping and scope. The [phone guide](REMOTE-PHONE.md) covers the
separate protected gateway. Neither path makes the main loopback server public.

Workspace retention does not reserve infinite hardware. Creation refuses an exhausted dedicated-port range before archiving or creating a workspace; restore refuses an occupied original range. Create and restore admissions serialize across repositories in the owning Phantom process. Separate Phantom processes do not share that reservation lock. A repository needing no dedicated ports may configure `ports: 0` in `.ashlr/verse/workspace.json`.
