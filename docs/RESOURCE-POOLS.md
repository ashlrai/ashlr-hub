# Account-aware resource pools

Use `ashlr resources pool` to assign an explicit engineering task to one enrolled
Codex, Claude Code, or local-model worker. Admission combines quota evidence,
operator task limits, and shared-account concurrency. Each assignment is durably
recorded before launch. This is a foreground task runner, not a resident scheduler
or an extension of the legacy daemon's authority. The scoped operations console
adds a durable queue and visual dispatch controls for that same pool.

This source feature is not yet a published registry release. Native adapter
flag and event contracts were checked against Codex CLI 0.136.0 and Claude Code
2.1.257 on September 7, 2026. This is not proof of model compatibility: the exact
CLI/model pair needs an explicit authenticated canary with the enrolled account.
Fixture-based tests use inert executables and loopback responses; they do not
establish authenticated multi-account production acceptance.

## Resource semantics

| Resource | Source | Admission behavior |
| --- | --- | --- |
| Provider windows | Explicit native quota observations | Every known window applies; missing is unknown, not zero |
| Operator task cap | Private durable reservation ledger | All admitted tasks count, including failure and cancellation |
| Concurrent slots | Unfinished reservations in the same ledger | Workers with the same `capacityKey` share slots and task caps |
| Local-model readiness | Fresh explicit health observation | Readiness is required; no cloud fallback or model download |

Workers are ranked by declared priority, then lowest normalized quota/task/slot
pressure, then stable ID. Priority is not a measured model-quality score. This
increment records usage but does **not** claim to optimize verified engineering
yield automatically. A completed worker result always has `verifiedAccepted:false`.

Use one shared ledger root for all workers representing the same resource pool.
Limits are per ledger, not machine-global provider limits. `capacityKey` is an
operator-declared identity: Hub does not inspect credentials to establish whether
two profiles actually represent the same account. All aliases of one account must
use the same key. Shared groups must have identical concurrency/task bounds.
Known denials conservatively block the entire group, even when their precise
model applicability is not established.

## Enroll explicit workers

Store input JSON as owned regular files with mode `0600`. Use canonical absolute
paths without symlinks. Keep the private ledger outside writable task workspaces.
Its parent must exist; `run` creates only its selected `0700` root, while `status`
never creates storage. Runtime persistence is currently POSIX-only.

The pool file contains policy, not secrets. This example uses conservative
operator bounds, not provider-advertised allowances:

```json
{
  "schemaVersion": 1,
  "id": "engineering",
  "workers": [
    {
      "id": "codex-a",
      "provider": "codex",
      "model": "your-supported-codex-model",
      "maxConcurrent": 1,
      "reservePercent": 15,
      "maxTasksPerWindow": 6,
      "taskWindowMs": 3600000,
      "priority": 50
    },
    {
      "id": "local-a",
      "provider": "local",
      "model": "your-loaded-local-model",
      "maxConcurrent": 1,
      "reservePercent": 0,
      "maxTasksPerWindow": 20,
      "taskWindowMs": 3600000,
      "priority": 40
    }
  ]
}
```

The separate bindings file must cover every worker exactly once:

```json
[
  {
    "workerId": "codex-a",
    "capacityKey": "account-a",
    "kind": "native-cli",
    "command": ["/absolute/owner-managed/codex-a"]
  },
  {
    "workerId": "local-a",
    "capacityKey": "local-compute",
    "kind": "local-chat",
    "endpoint": "http://127.0.0.1:11434/v1"
  }
]
```

A native command is an absolute executable or a trusted owner-managed wrapper
prefix. It must forward appended native CLI arguments and stdin unchanged, and
must already select its intended account through the vendor's supported
authentication. The runner does not create wrappers, log in, copy OAuth tokens, switch
accounts, scrape keychains/transcripts, consume reset credits, or alter billing.
Direct native executables use their existing default authentication. Do not map
the same default account to multiple independent capacity keys.

Bindings are trusted local code, not model-generated input or a security sandbox.
Hub passes a small environment containing existing system paths/locale/home,
without ambient API keys, account-switching variables, proxy variables, or Node
loader overrides. A wrapper or cached native profile can still select paid
billing; confirm its account, model eligibility, and overage settings before use.

### Commission native accounts and local capacity

#### Prepare isolated native profiles

`ashlr resources profile prepare` creates a new owner-private profile; it does
not sign in or enroll capacity. Choose an existing mode-`0700` parent outside
repositories, task workspaces and version control. Select the canonical regular
executable behind the vendor's installation symlink, without updating it.

```sh
ashlr resources profile prepare --provider codex \
  --directory /absolute/private/profiles/codex-a \
  --executable /absolute/canonical/codex-executable --json
```

Repeat with a **different new directory** for `codex-b`. For an isolated Claude
login, use `--provider claude` and its canonical native executable; Grok uses
`--provider grok` with a separate private `GROK_HOME`. This writes
`launcher.mjs`, `command.json` and a preparation-only `profile.json` as mode
`0600`, plus empty private state directories. Existing targets are never reused,
repaired or overwritten. A partial failure retains its leaf for inspection;
never delete it automatically because a later login may have added credentials.

The standalone launcher pins the selected native and Node executable paths and
checks its original private directory identities. It uses `process.execve` to
preserve PID, process group and stdio. A Node runtime supporting that API and a
supported POSIX system are required; relocating/replacing state directories or
removing the pinned runtime can invalidate the launcher. A native OS-level exec
failure is still a process failure, not a guarantee of a redacted exception.

Codex gets its own `CODEX_HOME` with explicit file credential storage and ChatGPT
login selection. Forwarded config overrides permit simple unquoted bare/dotted
keys only; the two selected authentication keys cannot be overridden through
normal launcher arguments. Claude gets separate `CLAUDE_CONFIG_DIR` and
`ANTHROPIC_CONFIG_DIR` directories and disabled native updates. This avoids
reusing the default Anthropic profile directory as a fallback. [Codex native
authentication](https://learn.chatgpt.com/docs/auth), [Anthropic profile resolution](https://platform.claude.com/docs/en/manage-claude/wif-reference#configuration-directory).

The native child receives only existing PATH/HOME/TMPDIR/LANG/LC_ALL plus the
fixed profile selectors. HOME is unchanged. This is owner-managed launcher code,
not a sandbox, account-independence proof or billing attestation. In particular,
Node startup happens before the launcher sanitizes the native child's environment;
run manual commands from a trusted shell. Hub dispatch already strips loader
overrides before starting the wrapper.

The returned `loginCommand` is the **separate interactive native sign-in** to run
when ready. Codex uses `login`; Claude uses `auth login --claudeai`; Grok uses
`--no-auto-update login --oauth`. Finish the
vendor's browser flow with the intended account, then verify account/billing and
quota before enrollment. `authentication:not-checked` in the preparation manifest
never changes into a live login-status claim. Use its `command.json` with
`resources launcher check`, and the contained argv as the pool binding's `command`.
No credential is read or copied, and preparation requests no model inference.

#### Verify identity and capacity

Authentication is an operator step outside the runner. Adding a worker to JSON
does not authenticate it or establish its quota. Keep native account directories
and launcher files outside task-writable workspaces.
Switching accounts in a desktop app is not simultaneous CLI enrollment. To run
two Codex subscriptions concurrently, complete the native sign-in separately for
each selected state directory; never copy the first account's credentials to
create the second worker.

1. Select a supported, version-pinned native executable. For two Codex accounts,
   use separate owner-managed launchers and native state directories. `CODEX_HOME`
   selects Codex's state location; `--profile` only selects configuration and is
   **not** evidence of a separate account. Verify the active account and storage
   mode through each exact launcher using native login/status before enrollment;
   do not duplicate credential files. [Codex state and profiles](https://learn.chatgpt.com/docs/config-file/config-advanced#config-and-state-locations),
   [native authentication](https://learn.chatgpt.com/docs/auth).
2. For Claude Code, select a dedicated `CLAUDE_CONFIG_DIR` in the owner-managed
   launcher and authenticate with the native flow. That directory also scopes
   its macOS Keychain entry. Confirm the account and billing source in the native
   client: cached API profiles or an API key selected by a wrapper can supersede
   subscription login. Hub deliberately does not inherit ambient account-selector
   variables. [Claude authentication and precedence](https://code.claude.com/docs/en/authentication).
3. Enroll each verified identity separately, for example `codex-a`, `codex-b`,
   and `claude-a`. Give aliases of the **same** account one `capacityKey`; different
   worker names, models, or launcher paths do not establish separate allowances.
   Start with one concurrent task per account and explicit task limits. Capture
   quota evidence before dispatch, or deliberately select bounded unknown-quota
   bootstrap. Never rotate identities to evade an account's known denial.
4. For local calibration, an existing `qwen3-coder:30b` Q4_K_M installation is a
   useful starting candidate with `maxConcurrent:1`, not a hardwired best model.
   Pin the installed model digest and measure its results on the same tasks as
   the native workers before expanding concurrency. Use only the explicitly
   selected, already-running loopback endpoint. Hub neither downloads the model
   nor starts its server, and local-chat cannot use native workspace file tools.

Test the exact launcher first with a small explicit task in an expendable
workspace, then inspect its result, resource observation, and diff before using
the queue. This dispatch consumes the selected provider's allowance; a healthy
local fixture is not evidence that native credentials or plan entitlements work.

### Check launcher capabilities before dispatch

Run this against the exact operator-trusted launcher you intend to enroll. The
mode-`0600` command file contains its argv array, for example
`["/absolute/owner-managed/codex-a"]`; it contains no credentials. The working
directory must already be owned, mode `0700`, canonical, and outside candidates.

```sh
ashlr resources launcher check --provider codex \
  --command /absolute/private/codex-a-command.json \
  --cwd /absolute/private/launcher-check --json
```

Repeat with each distinct launcher and `--provider claude` for Claude Code.
This command requests only native help/version output through the trusted prefix,
under one bounded deadline (default 10 seconds, `--timeout-ms` up to 30 seconds).
Native startup and wrappers can still maintain their own configuration/cache;
the command does not request login, authentication status, quota, inference,
reset credits or paid fallback. It writes no Hub enrollment or ledger.

Exit zero and `status:supported` mean required flags were **advertised**, not that
the full argument combination or a model works. Missing flags, known unsupported
Claude versions, failures, output limits and uncertain cleanup have fixed reason
codes. Unknown version formats remain `null`; they are not minimum-version proof.
Reports omit raw native output, commands, paths and account identifiers. Finish
commissioning with native identity/billing verification, quota evidence and an
explicit allowance-consuming canary as described above.

### Grok Build integration status

`--provider grok` checks native `agent stdio` help with auto-updates disabled.
Even when advertised upstream support is found, it returns exit one with
`hubTransport:not-implemented`. Grok is not currently an enrollable pool provider.

Grok Build documents headless and ACP interfaces and a separate `GROK_HOME` for
native state. Subscription entitlement and the selected billing route still need
account-specific verification. A Hub adapter must establish configuration/tool
isolation, cached-auth behavior, terminal and usage semantics, and cancellation;
top-level flags alone do not prove ACP enforcement. Do not substitute a Claude
binding or silently introduce an API key. [Native integration](https://docs.x.ai/build/cli/headless-scripting),
[native settings](https://docs.x.ai/build/settings/reference).

## Supply quota observations

### Probe an enrolled Codex launcher without generating work

After authenticating and enrolling the exact launcher, capture a private report:

```sh
ashlr resources pool probe --pool /absolute/private/pool.json \
  --bindings /absolute/private/bindings.json --worker codex-a --bucket codex \
  --output /absolute/private/new-codex-a-probe.json --json
```

This explicitly contacts the launcher's native App Server for account metadata and
quota windows. It creates no thread, turn, or model request and does not select a
different account. Native authentication/cache maintenance can still occur. The
fixed helper runs in private scratch, not the task project; native global
configuration remains native-managed. Trusted wrapper prefixes must forward
`app-server --stdio` and appended configuration arguments.

The private report contains `poolDigest`, an opaque `accountHint`, `planType`, and
a normalized `observation`, never raw account email, credential material or native
diagnostics. Account metadata is checked before and after quota capture. The
hint hashes reported account type/email/plan; the native endpoint supplies no
stable workspace/account identifier. It is **not proof of independent capacity**.
Use `--expected-account-hint` to pin a previously checked hint. Null/API-key
identity, drift, malformed protocol or an unsupported launcher produce no usable
observation. A successfully observed report can still contain unknown or exhausted
quota; exit zero means metadata was observed, not that work is admissible.

The report path must be new and is reserved with mode `0600` before native
contact. Failed preflight can leave an empty report file. The command writes no
pool ledger or enrollment and never resets quota. Its timeout is 10 seconds by
default, configurable with `--timeout-ms` from 1 to 30,000. Cancellation awaits
owned process cleanup; an uncertain result requires reconciliation before retry.

### Import explicitly captured evidence

The observations file is an array. A complete observation contains `workerId`,
canonical ISO `observedAt` and `expiresAt`, `health` (`ready` or `unavailable`),
`windows`, and `retryAfter` (ISO or null). Each window has `id`, `usedPercent`
(0–100 or null), and `resetsAt` (ISO or null). Optional `updatedAt` identifies the
latest capture while an older `observedAt` retains the age of untouched windows.
No observation may declare more than five minutes of freshness.

Normalize an owner-supplied decoded Codex `account/rateLimits/read` result:

```sh
ashlr resources pool observe --pool /absolute/private/pool.json \
  --worker codex-a --provider codex --input /absolute/private/native-limits.json \
  --captured-at 2026-09-07T12:00:00.000Z --bucket codex --json
```

The timestamp above is illustrative: supply the actual capture time. This command
does not query the provider or refresh old evidence. It emits a normalized array
with a 60-second freshness ceiling measured from that capture. Codex requires
1–4 explicit bucket IDs; its multi-bucket response takes precedence over the
legacy single bucket. Both primary and secondary windows remain separate.

For Claude, use `--provider claude` and a decoded native `rate_limit_event` with
nested `rate_limit_info`; omit `--bucket`. `--previous /absolute/private/observations.json`
retains other workers and previously known windows. Buffered events from an
executed Claude worker also enter the durable ledger. Their freshness starts at
dispatch, not at delayed output parsing, so long-running buffered evidence may
already be stale. Safe unknown future bucket names are retained; a new rejected
bucket is not ignored just because Hub has not seen its model name before.

Reset time is a recheck hint, never evidence of restored capacity. Omitted,
unknown, expired, and mixed-age updates cannot clear a known denial. Recovery
requires newer fresh evidence for the exact window with a known percentage and
future reset. A fresh single-window export without `--previous` can update that
window; the ledger retains others. `status` merges evidence for display only;
`run` persists admitted observations even when no task can be placed.

Default behavior refuses unknown subscription quota. Setting an individual
worker's optional `allowUnknownQuota:true` explicitly permits bounded bootstrap
under its operator task/concurrency caps. It never bypasses known exhaustion,
unavailable health, future-dated evidence, or provider backoff. This mode is not
a guarantee that a provider will accept the task or that overage is disabled.

## Run one task

An explicit task file:

```json
{
  "schemaVersion": 1,
  "id": "architecture-review-001",
  "allowedWorkerIds": ["codex-a", "local-a"],
  "prompt": "Explain the tradeoffs in the supplied design. Do not modify files.",
  "cwd": "/absolute/project",
  "timeoutMs": 120000,
  "maxOutputTokens": 2048,
  "mode": "read-only"
}
```

Choose allowed workers with compatible capabilities. Local-chat receives only
the explicit prompt and returns text; it does not read or edit `cwd`. Codex uses
its native read-only/workspace-write sandbox selection. Claude read-only mode
disables built-in tools; explicit workspace-write enables restricted file tools,
not shell/code/network tools. Neither task mode grants independent evaluator,
merge, deployment, or service authority. Native tools may retain managed policy
behavior: this adapter is not a separate OS confinement implementation.

Inspect without dispatch:

```sh
ashlr resources pool status --root /absolute/private/ledger \
  --pool /absolute/private/pool.json --bindings /absolute/private/bindings.json \
  --observations /absolute/private/observations.json --json
```

The following command **executes the selected worker**, consumes its resource
allowance, and may edit the explicit workspace when `mode` is `workspace-write`.
Use an expendable checkout or worktree for editing and verify its diff/tests:

```sh
ashlr resources pool run --root /absolute/private/ledger \
  --pool /absolute/private/pool.json --bindings /absolute/private/bindings.json \
  --observations /absolute/private/observations.json --task /absolute/private/task.json \
  --output /absolute/private/new-result.txt --json
```

The output path must not exist. It is reserved with mode `0600` before contact;
failed/refused runs can leave an empty file, identified in result metadata. Raw
worker text is never printed or stored in the ledger. Omit `--output` to discard
it after recording its digest. Replaying a completed task returns only its
receipt, not discarded text; requesting a new output file on replay fails rather
than rerunning the worker. Task IDs cannot be reused with changed content.

Concurrent invocations share atomic admission under a short store lock. The lock
does not span model execution. Each native task may make multiple vendor requests:
`maxTasksPerWindow` is **not** an inference-request cap. Local-chat sends a bounded
single request with `max_tokens`; native `maxOutputTokens` is only an observed
post-completion cutoff. Missing token counts remain null. No dollar-cost estimate
or unused-subscription-token estimate is invented.

### Interpret reported usage

New execution evidence labels known paired token counters with `usageScope`:

| Scope | What the existing counters measure |
| --- | --- |
| `codex-turn` | Native completed-turn input and output usage |
| `claude-main-loop` | Final result's main-loop input, cache-read and cache-creation input, and output usage |
| `local-chat-completion` | The selected local endpoint's single completion usage |

Claude's `modelUsage` has a broader query-pipeline scope, including subagents and
other work; Hub does not substitute it for the existing main-loop counters or
sum it with them. These counters do not establish billing or total account usage.
Older receipts without execution scope remain unclassified; missing or malformed
usage remains null. [Claude result accounting](https://code.claude.com/docs/en/agent-sdk/python#resultmessage).

Claude `subtype:success` alone is insufficient: `is_error:true`, aborted/error
terminal metadata, or deferred tools cannot establish completion. Duplicate
results, conversation resets, and explicitly nonhuman result origins do not
establish attributable usage for this one-prompt adapter. Safe terminal counts
can still be recorded for a failed attempt; reported usage is not acceptance.

## Operate the resource console

Start with an authenticated, read-only view of the explicit pool:

```sh
ashlr resources pool console --root /absolute/private/ledger \
  --pool /absolute/private/pool.json --bindings /absolute/private/bindings.json \
  --observations /absolute/private/observations.json
```

Open the printed `/resources/` URL and enter the printed read token. The server
binds only to `127.0.0.1`, uses an instance-specific read session, and never places
tokens in URLs. Without either metadata option, read-only mode does not create a
missing ledger at startup or launch workers. Saving an allocation can create its
private ledger state even when task execution is disabled.
The pool and bindings are fixed at startup; only the selected observations file
is reread. Reloading the dashboard does not refresh the age of quota evidence.

The capacity board groups worker aliases by account/resource key. It shows all
reported quota windows, exclusion reasons, occupied slots, and the next eligible
worker under current policy. That routing preview is not a promised assignment.
Activity distinguishes console-owned dispatches from external reservations whose
process liveness is unknown. Reported token subtotals and missing coverage remain
separate; completed work is not automatically verified engineering value.

### Follow work through the fleet map

The map connects **declared shared capacity → enrolled workers → recorded
assignments**. Select any worker or task to open its inspector and move keyboard
focus to the selected heading. Inspection preserves an unsent task draft;
background refreshes do not move focus. Successful submission opens the queued
task's inspector so its assignment and cancellation controls are easy to find.
Use **Back to fleet map** to return without losing the map search or selection.

Search by worker, provider, model, capacity key or task ID. The map pages through
eight workers at a time, three assignments per worker and eight tasks per waiting
lane; displayed counts distinguish the current page from all included records.
The source's omitted-history count remains visible. On narrow screens the same
relationships stack vertically, with native buttons and readable relationship
text rather than hover-only controls.

Queued tasks occupy a separate lane: their allowed workers are possibilities,
not assignment edges. Queue previews explain quota, occupancy, parallel limits,
pause and unavailable evidence. Recorded quota recheck times are hints, not
promised task start times. Pending or conflicting assignments are shown separately
until records agree. A settled supervisor job and an earlier occupied receipt
can coexist because sources are sampled separately; that remaining occupancy is
explicit rather than silently treated as released capacity.

After a failed refresh, retained records stay labeled as historical throughout
retry. New submission and resume wait for a successful read; pause and owned-task
cancellation remain available. Output is loaded only on request. A failed output
reload identifies previously loaded text as an older read, and changing console
instances clears session-local output. The map itself never starts workers,
probes accounts or changes scheduling policy.

### Keep Codex quota evidence fresh in the foreground

Create a private `0600` quota configuration using the exact `poolDigest` and
`accountHint` from successful probe reports for this normalized pool and bindings:

```json
{
  "schemaVersion": 1,
  "poolDigest": "REPLACE_WITH_64_HEX_POOL_DIGEST",
  "workers": [
    {
      "workerId": "codex-a",
      "accountHint": "REPLACE_WITH_64_HEX_REPORTED_ACCOUNT_HINT",
      "bucketIds": ["codex"]
    }
  ]
}
```

Every alias sharing a managed worker's capacity key must be included with the
same hint and bucket IDs. The same hint across different capacity keys is refused;
different hints still do not prove independent subscription capacity. Changing
the pool/bindings requires a newly verified configuration. Missing or unsupported
bucket information remains unknown; do not choose buckets merely to omit a known
limit.

Append `--quota-config /absolute/private/quota-config.json` to the console command
to opt in. This works in read-only or execution mode. It creates the selected
private root if absent and owns an exclusive collector lock. No native probe
runs in this collector without this flag; the separate account monitor described
below requires its own explicit option. Browser requests never trigger probes. Keep this
fourth control file outside the writable workspace as well.

One collector sequentially probes configured Codex workers, normally every 30
seconds per worker, with bounded failure backoff up to five minutes and a
10-second probe deadline. Actual captures expire after 60 seconds; a large or
slow pool can expire honestly rather than extending its timestamps. Failed,
unknown, incomplete, exhausted, expired or identity-mismatched managed evidence
blocks the entire shared-capacity group, **even with `allowUnknownQuota:true`**.
This transient gate applies after the normal ledger merge; it never fabricates
fresh health observations or changes durable task/receipt identity. Newer external
zero readings cannot clear the collector's native reserve/exhaustion gate. Other
evidence still participates in the existing conservative timestamp/window merge.

The **Native quota reads** panel shows collector state, fixed failure reasons,
last successful capture and next attempt. Observed metadata is separate from
quota completeness and dispatch eligibility. After a failed console read, the
panel labels retained statuses as **Last reported**, uses neutral unknown styling,
and identifies scheduled times as historical throughout retries. Original capture
timestamps remain unchanged; only a successful console read clears this state.
An unreadable saved allocation explicitly withholds admission rather than
presenting observed metadata as usable capacity. Raw account hints are excluded from
the browser. Closing the console aborts and awaits its collector. Uncertain native
cleanup or a crash retains `.resource-quota-refresh-pending.json`, which blocks a
replacement collector even after its old process lease expires. Do not delete
control records simply to retry. The collector is not a resident service and
cannot recover an ambiguously running native process.

When collector ownership is cleanly refused, the console stays available with
its original configuration and a **Native metadata collection** blocked status.
Configured flags do not mean native reads are running. Managed quota workers
remain withheld; the console starts no metadata coordinator, probes or heartbeat.
The panel distinguishes another owner, reconciliation-required, and unavailable
ownership. It offers no automatic retry or force-clear action. Cancellation or
unconfirmed cleanup still fails startup rather than presenting a usable fallback.

When acquisition can identify the cause, the collector snapshot includes an
optional `recovery` diagnosis containing only a fixed `reasonCode` and
`markerVersion`. The desk explains missing legacy evidence, incomplete command
registration, unconfirmed owner/group absence, identity mismatch and invalid
records. These are sampled startup findings, not current process observations.
Repeated dashboard reads do not acquire a lease or run new identity probes.
Historical views label the diagnosis as historical. Unknown or contradictory
reason/version pairs are rejected by the client rather than rendered as advice.
Legacy v1 records lack owner, boot and group evidence; neither a console restart
nor a computer reboot alone makes those records automatically recoverable.
The diagnostic does not authorize clearing, replaying or replacing evidence.

The console and one-shot quota captures use schema v4 markers when bounded macOS
OS reads verify a machine fingerprint and boot-session UUID; only a digest of the
machine UUID is persisted. Untracked internal lease callers retain v2. Under the
existing exclusive lock, a matching machine and a different verified boot allow
exact-marker recovery. A private, bounded latest authorization receipt is durably
written to `.resource-quota-refresh-recovery.json` before removal. It records
permission to unlink, not proof of unlink completion or a successful quota read.
Fresh quota evidence is still required afterward. Sleep/wake is not a reboot.
Legacy v1, same-boot v2, malformed, changed, different-machine or unverifiable markers
stay blocked. Unsupported platforms write conservative v1 markers. This does not
relax PID-reuse lock checks or reconcile task execution receipts.

For v4, a private bounded schema-2 `.resource-quota-refresh-activity.json` sidecar
records up to two reservations, tied to the immutable marker and owner token.
Each command transitions from `ready` to durable `preparing` before spawn, then
to `registered` with its owned process-group ID, and back to `ready` only after
verified settlement. Registration precedes delivery of helper input. A publication
failure with a spawned child requests bounded owned-process teardown and returns
uncertainty; it cannot invent a clean receipt. The coordinator settles the reservation only
after the adapter confirms that no process started or its owned POSIX group is
absent. All four metadata adapters request these explicit runner receipts,
including each Claude auth/version/usage stage. Exit code alone is insufficient.
Read-only group-absence checks never restore signaling authority over an exited
or recycled process. A budget expiring before native contact settles its local
reservation without inventing a provider sample.

A later acquisition may recover v4 on the same boot when the machine and boot
match, the former owner PID is proven absent with `ESRCH`, no reservation is
`preparing`, and every `registered` group is also proven absent with `ESRCH`.
Only signal-zero observations are used: recovery never kills a persisted group.
It writes the authorization receipt, then rechecks the owner, groups, boot, lock,
marker and sidecar before removal. This covers a crash after group exit but before
durable settlement. Present groups, permission errors, unknown records and the
spawn-before-registration crash window remain blocked. Legacy v3 records can
recover on the same boot only with an exactly idle schema-1 sidecar; their active
reservations lack process-group evidence and remain blocked.
The sidecar stays as a bounded historical record after close and is replaced by
the next owner; its old identity cannot authorize a new marker. This assumes
trusted private ledger storage and does not protect against malicious same-user
file restoration or processes that escape their owned group. No task replay,
resident restart service or quota freshness is implied by passive recovery.

An unexpected runner throw after invocation is attempted is not an ordinary
completed failure. Codex, Grok and Claude status adapters return cleanup uncertainty
and retain their scratch directory when that invocation has no settlement result.
The collectors also stop on thrown, missing or invalid-status probe results.
They abort queued/repeated reads before releasing the shared permit, await active
peers, and refuse clean closure so the pending marker survives. This includes
one-shot quota captures. Pre-contact adapter refusals and explicit settled failures
keep their existing behavior. These checks do not certify the absence of detached
or daemonized descendants; an idle counter alone cannot authorize same-boot recovery.

Universe resource generation can reuse this pinned configuration through its
optional private [`quotaConfigPath`](ASHLR-UNIVERSE.md#generate-candidates-through-an-enrolled-resource-pool).
That mode performs one bounded capture per configured alias before a new
generation, confirms cleanup, and then uses ordinary atomic resource admission
for one task identity. It does not use this console's recurring refresh loop or modify the source
observations file. Both modes share the same root-level collector lease and
pending marker, so collectors are never duplicated. Universe's optional private
`capacityWaitMs` can asynchronously wait for a verified live collector to release
the lease and for an otherwise eligible reserved worker slot to settle. It shares
one pre-admission allowance within the generation deadline; capture is not repeated
on capacity polls. Unknown ownership, retained fences, quota denials and uncertain
task occupancy still refuse. Without positive waiting, contention remains immediate.
To consume the running console's readings without waiting for its lease to close,
Universe can explicitly select
[`quotaEvidenceMode: "shared-collector"`](ASHLR-UNIVERSE.md#share-the-foreground-consoles-quota-collector)
alongside `quotaConfigPath`. The console writes a private five-second witness on
collector transitions and a one-second heartbeat. Readers verify the exact
configuration and live owner before reserving work; no duplicate collector or
fallback probe is started. Native timestamps and failures remain authoritative;
existing file-level denials and the current allocation still gate admission.
Without this opt-in, console readings are not supplied to a separate Universe
process.

For existing local Ollama bindings, Universe's private `localModelConfigPath`
option pins exact model digests and renews short-lived evidence via inventory-only
reads before new generation tasks. It does not run this console's collector or
perform inference during inventory checks. See the [Universe local refresh
guide](ASHLR-UNIVERSE.md#renew-explicitly-pinned-local-model-evidence) for enrollment,
deadline, denial and scope rules.

Claude admission continues to use supplied/native execution events: its documented status
line quotas are populated after a session API response, not a standalone complete
quota polling API. Local workers continue to require fresh explicit health.
No synthetic Claude prompt, undocumented quota scraping, API-key fallback,
account switching, or Grok subscription entitlement is introduced.

### Connect accounts without starting tasks

Append `--connections-config /absolute/private/connections.json` to monitor
explicit native profiles. Keep this file private (`0600`) outside any writable
worker workspace. For example:

```json
{
  "schemaVersion": 1,
  "intervalMs": 30000,
  "accounts": [
    {
      "id": "codex-personal",
      "label": "Personal Codex",
      "provider": "codex",
      "command": ["/absolute/node", "/absolute/profile/launcher.mjs"]
    }
  ]
}
```

One to eight accounts are supported, with providers `codex`, `claude`, or `grok`
and an interval from 30 seconds to one hour. Use the exact command emitted by
`resources profile prepare`; complete each native login separately. An optional
`expectedAccountHint` pins a previously verified native identity privately.
Labels are operator descriptions, not evidence of identity or separate capacity.
Do not enroll two profiles of the same account as independent subscriptions.

The monitor checks at most two native clients concurrently, without overlapping
cycles. When both metadata options are enabled, the account monitor and admission
collector share one FIFO, two-client budget as well as the existing collector
lease. Queued reads recheck ownership before launch. An uncertain cleanup in
either collector cancels both before another queued read can start; the pending
reconciliation marker remains until cleanup is confirmed. Active clients retain
their permits until their process owners settle. This coordinates concurrency,
not deduplication: separately configured collectors can still read the same
account for their distinct display/admission contracts.
Closing the console aborts and awaits owned metadata clients. No credentials are
copied, browser sessions imported, model prompts submitted, or workers enrolled.
Native clients can maintain authentication/cache state and contact ancillary
services while starting. Monitoring is foreground-only, not a resident service.

The connection ledger deliberately separates authentication, metadata health,
quota windows and execution support:

- Codex uses native account and rate-limit metadata. Unknown or expired windows
  never become zero usage. Monitoring alone does not supply admission observations.
- Claude uses native `auth status --json` and, for the verified native version
  2.1.257 only, its built-in noninteractive `/usage` command. Customizations,
  tools and MCP are disabled; conversation persistence is disabled. This local
  command reports session, all-model weekly and recognized model-scoped windows
  without model inference. Unknown versions receive no slash command and remain
  auth-only. Identity is compared before/after the read and pinned across monitor
  cycles; raw identities and activity diagnostics never reach the browser.
  **Native usage is display-only:** Claude floors percentages and can silently
  fall back to cached usage. Hub therefore labels them approximate, leaves exact
  reset timestamps null, preserves validated native reset text, and makes no
  quota-freshness or network-health claim. A newly collected report is not proof
  of freshly measured usage. Unsupported/incomplete output stays unknown.
- Grok uses native ACP auth/billing metadata, with identity checked before and
  after billing. Cached authentication alone cannot establish live health. Missing
  billing configuration remains unknown. Grok has no Hub task execution adapter;
  an observed plan or on-demand setting never authorizes paid overage.

### Reserve subscription usage for other work

Append `--allocation-controls` to enable the **Fleet usage allocation** slider.
Unlock it with the separate printed control token, choose 0–100%, and save. This
does not require `--execute` and does not enable task submission. The saved ceiling
applies to new subscription work using this exact pool ledger, including Universe
generation. It is not a global restriction on other apps or other ledger roots.

The same capability exposes **Fleet account access**. Uncheck a worker and save
to reserve it for your own work. Paused workers and every alias sharing their
capacity key are excluded from subsequent task admission in this ledger, even
if a task allowlist includes them. The pause does not log you out, hide usage,
change enrollment, cancel work already reserved, or affect your desktop Codex
session. For example, pause Personal Codex while leaving CMP allowed for fleet
work. CMP still needs fresh quota and must pass the saved usage ceiling.

Account access and usage allocation have independent revisions. Saving a pause
does not alter the percentage ceiling. Both changes use the reservation lock and
reject stale revisions; refresh before deliberately replacing another edit.
An allowed worker is not necessarily ready or running. The pause is durable
across restart but applies only to this pool's ledger, not arbitrary other apps.

- **75%** stops admitting new subscription tasks once any required reported quota
  window reaches 75% used, targeting 25% headroom for other work.
- **100%** allows admission up to native limits; provider refusals, task caps,
  occupancy and other checks still apply. It does not enable overage or reset limits.
- **0%** withholds all new subscription work. Local workers are unaffected.

Account usage reported by the provider includes outside activity, not merely Hub
work. Each window is evaluated separately; percentages are never summed across
accounts or windows. Unknown or stale quota blocks subscription admission below
100%, even if the pool previously allowed unknown quota. This currently means
Claude's display-only native report cannot guarantee a reserved quota allowance.

The account view draws the saved ceiling as a reference on current, timestamped
quota windows, with per-window percentage-point comparisons. It is not an account
dispatch decision or a sum across subscriptions. Historical, unknown, reset-expired
and native cached reports have no ceiling comparison. Claude's `/usage` reports
are marked approximate and may be cached even when sign-in was just checked.

The **Account reference summary** identifies the most-used window (including
ties) and the smallest percentage-point margin below the saved ceiling. It uses
the maximum reported usage, never a sum. Every reported window must have verified
usage and a future reset, and the account observation must be current, signed in
and reachable; otherwise the account-level comparison is unavailable. A positive
margin that rounds to zero is labeled less than 0.01 percentage point. This is a
reference comparison, not remaining tokens, promised capacity or an execution
decision. The pure helper uses the snapshot timestamp, not the browser clock.

An explicit saved ceiling replaces static worker reserve percentages. With no
saved setting, existing reserve policy remains unchanged; the UI's initial 75%
draft is not active until saved. Edits use a revision check: another operator's
change must be reloaded before saving. Admission rereads the policy under the same
lock as reservation, so lowering the ceiling invalidates an earlier eligible
preview. In-flight tasks are not cancelled and can cross the threshold; this is
an admission cutoff, not a guaranteed hard spending cap.

### Enable and control task execution

To enable task submission, explicitly select a workspace and execution capability:

```sh
ashlr resources pool console --root /absolute/private/ledger \
  --pool /absolute/private/pool.json --bindings /absolute/private/bindings.json \
  --observations /absolute/private/observations.json \
  --execute --workspace /absolute/project-worktree --max-parallel 4
```

**This command can execute durable queued tasks immediately.** Confirm the enrolled
accounts, billing settings, workspace and existing queue before starting. The
ledger and all three control files must be outside the writable workspace. Treat
native bindings as trusted local programs, not a sandbox. Review workspace changes
and task receipts before accepting results; use the checkout's normal versioned
recovery process for unwanted edits.

Enter the separately printed control token through **Unlock controls**. A read
token or read-session cookie cannot submit, pause, resume or cancel work. The
browser can choose only the task ID, prompt, eligible workers, mode, timeout and
output bound; it cannot change the workspace, command, endpoint or environment.
Read sessions expire after 15 minutes; the browser keeps the control token only
in memory for 20 minutes. Token expiry, closing a tab, or losing the HTTP connection
does not stop already queued or dispatched work.

The foreground supervisor provides:

- **Durable scheduling:** queued tasks and pause state survive restart. Unattempted
  work resumes when unpaused and capacity becomes available. A dispatch intent is
  saved before invoking a worker; previously dispatching work is never replayed
  after a crash, even when no receipt is available.
- **Pause and cancel:** pause blocks new starts, not in-flight work. Cancel removes
  queued work or aborts a dispatch owned by this server instance. It cannot stop
  an external reservation. These stop controls remain available when evidence is
  stale or unavailable.
- **Evidence recovery:** missing/corrupt observations stop new admissions but do
  not cancel admitted work. Polling recovers automatically after the selected
  private file is repaired with fresh evidence. Quota reset time alone does not
  release a denial. Storage or lock failures stop the supervisor.
- **Private output:** results are fetched only on demand and retained in server
  memory, at most 256 KiB per task and 4 MiB total. Eviction, restart or shutdown
  loses raw output. The durable queue retains prompts only while queued or
  dispatching; metadata views omit them. A read session can view retained output.
- **Bounded execution:** default four parallel jobs, configurable from one to 16;
  at most 64 queued jobs, a 32 KiB prompt per task, and 256 retained queue identities
  within a 4 MiB state file. History is not silently evicted into replayable work.
  Admission reserves future metadata space; large escaped prompts can reach the
  byte limit before the count limits.
  Capacity exhaustion requires an explicit migration, not deleting state to reuse
  identities. The underlying pool ledger has its separate limits below.

SIGINT/SIGTERM closes the server, aborts its owned work and awaits cleanup. An
unconfirmed termination makes shutdown fail rather than claiming a clean stop.
Already external or unresolved reservations remain distinguishable from this
instance's work. Preserve their receipts and reconcile them before retrying with
a new task ID. Only one supervisor can own a selected ledger at a time.

`--json` emits one private startup record containing scope, URL and tokens; do not
paste it into logs or source control. `--port 0` chooses an available port. This
console has no resident-service installation, machine-global quota collector, account
login, global fleet discovery, or connection to Universe's evaluator. It does not
expose the general Hub API or event stream. The process must remain running for
its queue to advance.

## Measure execution and calibrate a worker

The dispatch desk's **Worker performance** table summarizes all retained ledger
receipts, including history omitted from the task list. Choose one execution
outcome to see its measured sample count and nearest-rank p50/p95. These are
unmatched tasks, not a model ranking. Timing uses a monotonic clock around the
worker adapter; it includes preparation and cleanup, excludes queue/reservation
and durable settlement, and is not provider latency. Old receipts retain unknown
timing. Each receipt and worker summary labels token scope; Claude main-loop
counts exclude subagents. None of these counters establishes accepted work or a
billing total. The optional versioned `execution` field preserves old-ledger
readability; older Hub versions that reject it cannot read a newly measured
ledger, so preserve a pre-upgrade ledger copy for rollback rather than stripping
fields from live records.

Use the fixed `review-calibration-v1` suite to establish a small, repeatable
read-only review baseline. Its three code-comprehension cases have four fixed
checks each. Generated text is parsed as JSON and is never executed. This is a
calibration check, not proof of repository implementation skill. All tasks pass
through normal quota admission, durable reservations and cancellation.

After independently authenticating/enrolling the chosen native worker, or
selecting a running numeric-loopback Ollama endpoint with an installed model,
run the following from the installed Hub CLI. This command **executes model
requests and consumes that worker's resources**. Use an existing canonical
workspace and private manifests as described above; substitute your own explicit
paths and enrolled worker ID.

```sh
ashlr resources pool benchmark \
  --root /absolute/private/pool-ledger \
  --pool /absolute/private/pool.json \
  --bindings /absolute/private/bindings.json \
  --observations /absolute/private/observations.json \
  --workspace /absolute/benchmark-workspace \
  --worker local-reviewer --run-id baseline-001 \
  --expected-model-digest sha256:REPLACE_WITH_INSTALLED_64_HEX_DIGEST \
  --repeats 2 --timeout-ms 120000 --max-output-tokens 512 \
  --output /absolute/private/baseline-001.json --json
```

Local calibration requires the exact Ollama inventory digest and rechecks it
before every task; it never downloads a model. Omit `--expected-model-digest` for
native workers, whose configured model ID is not independently attested. Supply
fresh, truthful readiness observations; `allowUnknownQuota` alone does not imply
health. Normal observation expiry and quota denials remain effective throughout
the run. No service or recurring benchmark is installed.

The exclusive output file contains suite/workload digests, model identity scope,
per-case checks and durable receipts, without raw prompts or responses. Compare
only matching suite/workload digests, and separately control machine load,
runtime version, context allocation, warm/cold state and tool environment before
attributing differences to a model. Record repeated trials; the default is one
repeat, with at most three. A complete score measures the fraction of cases with
every check passing. An interrupted or unscored suite has `score: null`, not a
fabricated zero or success. Exit 0 requires every case to pass.

SIGINT/SIGTERM abort owned work and await its adapter. A failed/uncertain task or
lost settlement stops the suite without retrying. Inspect the ledger before
starting a new run. Reusing a recorded run ID/worker is refused because raw
responses are not durably available for rescoring. Existing report files are
never overwritten; failed preflight can leave an empty reserved output file.
Benchmark reports do not change routing priorities or accept changes. The
separate opt-in [Universe resource generation path](ASHLR-UNIVERSE.md#generate-candidates-through-an-enrolled-resource-pool)
can use the shared pool for candidate responses; a benchmark does not enable it.

## Failure and recovery

SIGINT/SIGTERM abort the owned request/process and await bounded cleanup. Native
process ownership is limited to the existing subprocess runner's process-group
contract, not escaped descendants. No failure is silently restarted on another
worker. A new attempt requires a new task ID and another reservation.

Failed and timed-out tasks add a one-minute shared-group cooldown. Reserved or
uncertain attempts continue occupying slots indefinitely; elapsed time does not
prove their workers stopped. There is no automatic crash reconciliation or
slot-release command in this increment. Stop the affected pool and reconcile the
worker and private receipt evidence before resuming; do not delete the ledger to
manufacture capacity. Pool/binding changes are refused against an existing ledger
rather than resetting its history. Preserve it for any explicit migration.

### Read a native failure

Select the task in the resource console to read **Receipt diagnosis**. It uses
the receipt's fixed reason code, not the separately sampled supervisor reason.
The explanation and next check do not fetch raw output, retry a task, release
capacity, or mark work accepted. A zero native exit code does not override a
failed terminal event or another failed receipt check.

After a native invocation returns, its receipt can include `nativeProcess`:
schema version `1`, scope `native-process`, an observed exit code (`0`–`255`) or
`null`, an allowlisted signal or `null`, and the boolean fields `stderrPresent`
and `outputTruncated`. Timeout, cancellation, process-error, and signal paths
do not turn runner-synthesized codes into measured exits. Captured stderr can
include runner notices; its presence is not proof of a vendor error, and its
absence is not proof of success. Truncation refers to bounded stdout or stderr
capture. This extension contains no captured text or provider error message.
Legacy receipts, local workers, reservations, and pre-invocation failures can
omit it; absence is unknown, not zero or empty capture.

Older builds with strict receipt validation may refuse a ledger containing this
extension. Preserve the ledger and use a compatible build; do not remove receipt
fields to make an older reader accept it.

| Recorded reason | Next check |
| --- | --- |
| `worker-cli-upgrade-required` | The configured model was rejected because the native CLI needs an upgrade. Select or update a compatible CLI, then recheck the enrolled account and quota before a new attempt. Hub does not change the CLI or model automatically. |
| `worker-exit-failed` / `worker-process-failed` | Check the configured launcher, executable, CLI/model compatibility, and private account environment. Exit status alone does not establish an authentication or quota cause. |
| `worker-terminal-failed` / `worker-terminal-missing` / `worker-invalid-events` | Check the supported native event format and task scope. Partial output or process exit `0` is not sufficient completion evidence. |
| `worker-output-truncated` / `worker-output-token-limit` | Review task scope and configured response budget before a deliberate new attempt; do not accept the failed response. |
| `worker-timed-out` | Review the deadline and task scope, confirm cleanup, and refresh capacity evidence. |
| `worker-termination-uncertain` | Stop the affected pool and reconcile process ownership and private receipt evidence. The slot remains occupied; do not delete the ledger to release it. |

An unrecognized reason gets a generic explanation, not raw error text or a
guessed cause. A deliberate new attempt still requires a new task ID and normal
admission checks. The diagnosis is guidance for recovery, not automatic recovery
or a claim of unattended production reliability.

### Ledger recovery boundaries

Each observation holds at most eight windows. If successive valid snapshots
exceed that inventory, the ledger retains seven strongest readings and a
`hub_observation_overflow` hard-denial marker. Its `100` is a refusal sentinel,
not measured usage. Ordinary refresh cannot clear that marker because recovery
of discarded windows is unproven; stop and reconcile the pool before a deliberate
schema migration. The ledger remains readable and does not dispatch through the
overflow.

The bounded store retains up to 4,096 task identities and 4 MiB. Before starting
a worker, admission budgets worst-case settlement metadata for every reserved
task and the bounded quota inventory. Insufficient receipt headroom refuses the
new admission; it does not evict history. Existing receipt reads and replay
behavior are unchanged. The store does not prune old identities into replayable
work. These limits, explicit enrollment, incomplete
vendor quota coverage, and manual ambiguous-run recovery mean this is not yet an
unattended production fleet. Universe's versioned generation receipts, measured
feedback, evaluator, and archive selection remain independent acceptance steps.
The opt-in [generation bridge](ASHLR-UNIVERSE.md#generate-candidates-through-an-enrolled-resource-pool)
links recorded pool tasks to Universe trials without activating a service.
Universe [portfolio execution](ASHLR-UNIVERSE.md#coordinate-campaigns-with-a-dependency-graph)
can supply one explicit `--resource-runtime` to its enrolled, pinned-pool
campaigns. Planning does not validate worker readiness. The shared ledger and
fresh-observation requirements still apply; portfolio concurrency does not add
an automatic capacity-waiting queue or retry.
`ashlr runtime run` still forwards Universe commands only; it does not forward
the standalone resource-pool CLI.

## Provider research and billing boundaries

Research checked September 7, 2026; provider rules and models can change.

- Codex documents subscription authentication separately from usage-billed API
  authentication. App Server exposes account quota windows and metered bucket IDs;
  those percentages cannot be converted to a fixed token allowance.
  [OpenAI authentication](https://learn.chatgpt.com/docs/auth),
  [App Server account limits](https://learn.chatgpt.com/docs/app-server#6-rate-limits-chatgpt).
- Claude supports separately authenticated configuration directories, including
  directory-specific macOS credential storage. Its terms distinguish an end user
  using the unmodified native CLI from third-party credential intermediation.
  This implementation does not collect or proxy subscription credentials and is
  not a blanket determination that every multi-account deployment is permitted.
  [Claude authentication](https://code.claude.com/docs/en/authentication#credential-management),
  [credential-use requirements](https://code.claude.com/docs/en/legal-and-compliance#authentication-and-credential-use).
- The proposed separate monthly Agent SDK credit change was paused. The current
  notice says native print/SDK usage still draws from subscription limits. Do not
  implement the superseded table below that notice as a new resource balance.
  [Claude SDK plan notice](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan).
- On Max, Fable 5/5.1 can use up to 50% of the **same** weekly allowance, not an
  additional allowance. Continued Fable use after that limit can involve paid
  credits. Hub neither enables such credits nor guarantees the owner has disabled
  them. The exact Fable native wire bucket name was not established; no name or
  numeric allowance is hardcoded into the scheduler.
  [Fable plan limits](https://support.claude.com/en/articles/15424964-claude-fable-models-on-your-plan).
- Claude's documented status-line windows may independently disappear after
  reset. A complete daily/per-model quota polling API was not established. Local
  non-Claude models remain on the local adapter, not a faux-Claude gateway.
  [Status-line resource fields](https://code.claude.com/docs/en/statusline),
  [Claude gateway support](https://code.claude.com/docs/en/llm-gateway).
- Grok Build has an official native CLI, headless output modes, and an ACP stdio
  interface. Hub has **no Grok worker transport** yet: a version-pinned terminal
  result/usage contract and a tested tool/customization boundary are still needed.
  Its documented child-network restriction is a no-op on macOS, so a similarly
  named sandbox is not proof of equivalent containment.
  [Grok Build scripting](https://docs.x.ai/build/cli/headless-scripting),
  [sandbox limits](https://docs.x.ai/build/features/sandbox).
- Grok Bot is an external cloud-computer product, not this console's local
  desktop-control worker. The August 26 announcement expands plan access and
  describes its own usage pool; a public Hub-controllable Bot API and this user's
  exact entitlement have not been established. Do not infer either from a Grok
  subscription. [Grok Bot plan announcement](https://x.ai/news/grok-bot-more-plans),
  [Grok Bot FAQ](https://docs.x.ai/grok-bot/faq).
- Consumer access, native Build access, and an xAI API-key billing account are
  distinct integration choices. The documented API route uses API credentials
  and metered billing; confirm any account-specific included credits, overage,
  or auto-top-up before use. Hub does not fall back to a paid xAI endpoint.
  [xAI API quickstart](https://docs.x.ai/developers/quickstart),
  [API billing](https://docs.x.ai/developers/faq/billing).

For implementation and local regressions, see `src/core/resources/` and
`test/resource-*.test.ts`. Run focused tests, backend/web typecheck, and lint
locally. No GitHub Actions, provider credentials, or real model calls are needed
for this feature's deterministic acceptance suite.
