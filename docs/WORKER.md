# Spare-Mac Worker Runbook

Resident worker provisioning is temporarily unavailable. Production service
install, reinstall, repair, and restart authority is withheld, so `ashlr worker
setup` refuses before loading or saving config, running the setup wizard,
enrolling repos, registering a queue, or touching an OS service. Existing
services support `ashlr daemon service-status` and `ashlr daemon uninstall`
only. Status reports registration as `present`, `absent`, or `unknown`; a
missing file is not treated as absence unless the native manager also proves no
registration. Compiled daemon and conductor trust roots are empty, so non-dry
daemon execution is dormant; owner-invoked proposal commands remain available.

## Quick start

```sh
# 1. Install
npm i -g @ashlr/hub

# 2. Inspect an existing service (read-only)
ashlr daemon service-status

# 3. Preview a daemon tick (compiled daemon roots are empty)
ashlr daemon start --once --dry-run

# 4. Run owner-invoked proposal work without a resident service
ashlr run "<goal>"
ashlr swarm "<goal>"
```

When resident authority is restored, worker setup is designed to:

1. Runs the full identity setup (`ashlr setup --user`) — sets `cfg.user.name` so
   each worker has a unique identity in the fleet.
2. Enrolls the given repos in the sandbox policy so the daemon is allowed to
   mutate them.
3. Installs the launchd service with `caffeinate -i -s` keep-awake (see below).
4. Prints a summary and next-step reminders (engine auth, pulse key).

## Shared-queue mode

Shared-queue registration through `ashlr worker setup --queue` is also
temporarily unavailable and performs no partial setup mutation.

This stores the queue path in `cfg.fleet.sharedQueue.path`. It does not attest
that the path is safe for distributed execution authority. After independently
verifying that every worker mounts the same coherent filesystem, set the
attestation in `~/.ashlr/config.json`:

```json
{
  "fleet": {
    "sharedQueue": {
      "mode": "filesystem",
      "path": "/Volumes/shared/ashlr-queue",
      "trustedCoherentStorage": true
    }
  }
}
```

`trustedCoherentStorage` defaults to `false`. The worker must fail closed for
filesystem queue authority unless it is exactly `true`. Treat enabling it as a
protocol migration barrier: drain every legacy worker first, then point the v2
fleet at a fresh empty queue path. Old writers are not compatible authority
participants; if one rewrites v2 metadata, modern readers fail closed.

The queue path must be on a coherent shared filesystem that supports
linearizable exclusive create, rename, hard links, fsync, and read-after-write.
Replicated sync folders such as iCloud Drive and Dropbox are not supported for
execution authority. Ashlr probes local filesystem primitives before its first
queue mutation, but that probe cannot verify cross-host linearizability or prove
that separate machines observe the same storage. The explicit operator
attestation is therefore required in addition to a successful local probe.

On POSIX, Ashlr requires file and parent-directory fsync. Windows does not
portably expose parent-directory fsync through Node, so its explicit policy is
file fsync plus atomic rename; Fleet Status reports that policy rather than
claiming directory-fsync verification. `trustedCoherentStorage:true` is also an
operator acceptance that the selected Windows storage provides the required
durability and cross-host visibility under that policy.

If Fleet Status reports `lock recovery required`, Ashlr deliberately stops
shared authority. A hard-link guard may belong to a paused writer, so elapsed
time alone is never used to remove it. Drain and stop every worker that can
access the queue before performing operator-led lock recovery.

Each daemon selection carries its worked-ledger cooldown keys and policy into
the atomic claim transaction. The store rechecks the latest outcome while the
queue lock is held, so a worker cannot reclaim an item from a stale pre-completion
snapshot. Claims then cross a durable `claimed` to `executing` boundary; expired
executing or phase-unknown legacy work is never automatically reassigned.
All workers must maintain synchronized wall clocks; keep maximum host skew well
below the configured lease and shortest cooldown windows. Clock health is part
of the operator's coherent-storage attestation because lease and cooldown
deadlines are cross-host epoch timestamps.

Repairable no-proposal outcomes in shared mode remain immediately retryable
until their repair handoff has a shared durable authority store. Ashlr settles
the exact executing claim without recording cooldown and reports the tick as a
state-persistence failure instead of silently stranding or suppressing the item.

Without `--queue` the worker operates in **repo-partition** mode: it runs
autonomous work only on its enrolled repos.

## Check worker state

```sh
ashlr worker status
```

Prints identity, enrolled repos, daemon running state, and whether a shared
queue is configured.

## 8 GB Mac: use subscription engines only

An 8 GB Mac does not have enough RAM to run large local models alongside the
OS and the repos under edit.  Configure subscription-backed engines instead:

```sh
# Point the provider chain at remote APIs
ashlr config set engines.providerChain claude,openai

# Set API keys (stored in ~/.ashlr/config.json, never in source)
ashlr config set engines.claudeApiKey  sk-ant-...
ashlr config set engines.openaiApiKey  sk-...
```

The built-in provider chain already falls back gracefully — if a key is
absent the engine is skipped.  For a bare worker node with no local model
tooling, remove the local entries entirely:

```sh
ashlr config set engines.providerChain claude,openai
```

A 16 GB Air can run a small local model (e.g. `llama3:8b` via Ollama) if you
prefer:

```sh
ashlr config set engines.providerChain ollama,claude
ashlr config set models.ollama llama3:8b
```

## Keep-awake: how it works

The keep-awake design is retained but cannot currently be installed or repaired.
On macOS, the resident launchd job runs on a `ThrottleInterval`; when the Mac is
idle or the lid is closed, macOS may put the system to sleep and the daemon
stops ticking.

The unavailable worker setup path is designed to pass `keepAwake: true` to the
service installer, wrapping the daemon process with:

```
caffeinate -i -s <node> <ashlr> daemon start ...
```

- `-i`  prevents **idle sleep** (display off, no user activity)
- `-s`  prevents **system sleep** while on **AC power**

The caffeinate process is the direct child of launchd; if it exits launchd
respawns it per `KeepAlive: { SuccessfulExit: false }` in the plist.

### Power caveats

| Condition | Behaviour |
|-----------|-----------|
| Plugged in, lid closed ("clamshell") | Daemon ticks normally |
| On battery, lid closed | macOS may still sleep despite `-s` (Apple policy) |
| Low-battery sleep threshold hit | System sleeps regardless |

**Recommendation**: keep spare-Mac workers plugged in at all times.  If you
need lid-closed operation on battery, enable "Prevent automatic sleeping" in
System Settings → Battery → Options (macOS 13+).

### Linux workers

`caffeinate` is macOS-specific.  On Linux, `keepAwake` is documented only —
the service installer writes a standard systemd unit.  To prevent sleep on a
Linux worker, configure the system power policy separately:

```sh
# Prevent suspend (systemd)
sudo systemctl mask sleep.target suspend.target hibernate.target hybrid-sleep.target
```

### Windows workers

On Windows the service is registered via `schtasks`.  `keepAwake` has no
effect; use the Windows power plan ("High performance" or a custom plan with
sleep disabled).

## Per-machine identity

Each worker should have a unique `--user` name (e.g. `worker-mbp-8gb`,
`worker-mba-16gb`).  This name appears in:

- `ashlr worker status`
- Pulse heartbeat reports (if pulse is enabled)
- Fleet coordinator dashboards

If all workers share one Anthropic account, set the same `CLAUDE_API_KEY` on
each machine.  The fleet coordinator distributes work by repo, not by account,
so shared credentials are fine.

If you prefer per-worker accounts (better billing attribution), provision each
machine with its own key and set `--user` to match the account email.

## Daemon management

```sh
# Inspect or stop an existing background daemon
ashlr daemon service-status
ashlr daemon status
ashlr daemon stop

# Preview one dormant-runtime tick without effects
ashlr daemon start --once --dry-run

# View logs from an existing service
tail -f ~/.ashlr/daemon.launchd.out.log
tail -f ~/.ashlr/daemon.launchd.err.log

# Uninstall the service
ashlr daemon uninstall
```

Production install/reinstall/repair/restart and non-dry daemon execution are
dormant while the compiled daemon and conductor trust roots are empty. Use
owner-invoked `ashlr run "<goal>"` or `ashlr swarm "<goal>"` for proposal work.

## Withheld provisioning flow (annotated)

The flow below is currently blocked at its shared authority boundary before any
listed mutation runs. It documents intended internals, not an available command.

```
npm i -g @ashlr/hub            # install ashlr globally
ashlr worker setup             # runs:
  → stepUser                   #   M110: set cfg.user.name
  → stepEngines                #         detect / auth engines
  → stepEnroll                 #         enroll repos in sandbox policy
  → stepDaemonService          #         install launchd plist (base)
  → install({ keepAwake:true}) #   M112: reinstall with caffeinate wrap
  → saveConfig (sharedQueue)   #         optional shared-queue path
  → print summary              #   print identity + reminders
```
