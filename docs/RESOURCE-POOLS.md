# Account-aware resource pools

Use `ashlr resources pool` to assign an explicit engineering task to one enrolled
Codex, Claude Code, or local-model worker. Admission combines quota evidence,
operator task limits, and shared-account concurrency. Each assignment is durably
recorded before launch. This is a foreground task runner, not a resident scheduler
or an extension of the legacy daemon's authority.

This source feature is not yet a published registry release. Native adapter
contracts were checked against Codex CLI 0.136.0 and Claude Code 2.1.257 on
September 7, 2026. Local validation uses inert executables and loopback fixtures;
it does not establish authenticated multi-account production acceptance.

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
authentication. Hub does not create wrappers, log in, copy OAuth tokens, switch
accounts, scrape keychains/transcripts, consume reset credits, or alter billing.
Direct native executables use their existing default authentication. Do not map
the same default account to multiple independent capacity keys.

Bindings are trusted local code, not model-generated input or a security sandbox.
Hub passes a small environment containing existing system paths/locale/home,
without ambient API keys, account-switching variables, proxy variables, or Node
loader overrides. A wrapper or cached native profile can still select paid
billing; confirm its account, model eligibility, and overage settings before use.

## Supply quota observations

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

Each observation holds at most eight windows. If successive valid snapshots
exceed that inventory, the ledger retains seven strongest readings and a
`hub_observation_overflow` hard-denial marker. Its `100` is a refusal sentinel,
not measured usage. Ordinary refresh cannot clear that marker because recovery
of discarded windows is unproven; stop and reconcile the pool before a deliberate
schema migration. The ledger remains readable and does not dispatch through the
overflow.

The bounded store retains up to 4,096 task identities and 4 MiB. It does not prune
old identities into replayable work. These limits, explicit enrollment, external
quota capture, and manual ambiguous-run recovery mean this is not yet an
unattended production fleet. Universe's versioned generation receipts, measured
feedback, evaluator, and archive selection are unchanged. `ashlr runtime run`
still forwards Universe commands only; it does not forward this new pool runner.

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

For implementation and local regressions, see `src/core/resources/` and
`test/resource-*.test.ts`. Run focused tests, backend/web typecheck, and lint
locally. No GitHub Actions, provider credentials, or real model calls are needed
for this feature's deterministic acceptance suite.
