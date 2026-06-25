# ashlr — Team Guide (2-person fleet)

This guide covers running ashlr as a two-person team. Each teammate runs an
independent fleet on their own machine. Shared visibility is provided by
ashlr-pulse: both teammates point at the same pulse instance and see each
other's fleet activity attributed by owner.

---

## The team model

```
Mason's machine                     Cofounder's machine
──────────────────                  ──────────────────────
~/.ashlr/config.json                ~/.ashlr/config.json
~/.ashlr/inbox/          (local)    ~/.ashlr/inbox/         (local)
~/.ashlr/goals/          (local)    ~/.ashlr/goals/         (local)
~/.ashlr/enrollment.json (local)    ~/.ashlr/enrollment.json (local)
          │                                    │
          └──────────────┬────────────────────┘
                         ▼
               ashlr-pulse instance
               (shared OTLP endpoint)
               fleet activity, attributed
               by ashlr.fleet.owner per machine
```

Each fleet only writes to repos enrolled on that machine. Proposals stay in
the local inbox until the machine owner reviews and applies them. Pulse is the
read-only shared layer: it receives OTLP spans from both machines and groups
activity by owner so both teammates see whose fleet produced what.

---

## What is shared vs. local

| Item | Where it lives | Shared? |
|------|---------------|---------|
| Enrolled repos | `~/.ashlr/enrollment.json` | No — per machine |
| Proposals / inbox | `~/.ashlr/inbox/*.json` | No — per machine |
| Goals | `~/.ashlr/goals/*.json` | No — per machine |
| Engine API keys | env / Phantom vault | No — per machine |
| `~/.ashlr/config.json` | local only | No |
| Fleet activity + attribution | ashlr-pulse (OTLP) | Yes — both see it |
| `ashlr.fleet.owner` label | carried in every OTLP span | Yes — identifies whose work |

---

## Onboard your cofounder

### 1. Install ashlr

```bash
npm i -g @ashlr/hub
```

### 2. Run setup

```bash
ashlr setup
```

Setup runs the first-run wizard: config, models, editor wiring, daemon
service install, and repo enrollment discovery. It is idempotent.

Flags:
- `--yes` — non-interactive, accept defaults, auto-enroll discovered repos
- `--wire` — wire detected editors (backup-first)
- `--json` — emit result as JSON (useful for scripting)

### 3. Set user identity for pulse attribution

`ashlr setup` does not accept a `--user` flag. Set identity directly in
`~/.ashlr/config.json` after setup, or via `ashlr config set`:

```bash
ashlr config set user.id cofounder@example.com
ashlr config set user.name Alex
```

Or edit `~/.ashlr/config.json` directly:

```json
{
  "user": {
    "id": "cofounder@example.com",
    "name": "Alex"
  }
}
```

`user.id` should be the email that matches their pulse account (used as the
`ashlr.fleet.owner` attribute on all OTLP spans from that machine). Absent
`cfg.user`, owner stamps are omitted and pulse cannot attribute that machine's
activity — set this before connecting to pulse.

### 4. Enroll repos

```bash
ashlr enroll add /absolute/path/to/repo
```

Or re-run `ashlr setup --yes` to auto-discover from configured roots. Each
person enrolls only the repos on their machine. The fleet will not touch
unenrolled repos.

---

## Shared pulse setup

Both teammates must point at the same pulse instance.

### 1. Set the endpoint (both machines)

```bash
ashlr pulse connect https://pulse.ashlr.ai/api/otlp/v1/traces
```

Or for a self-hosted instance:

```bash
ashlr pulse connect https://your-pulse-host/api/otlp/v1/traces
```

This writes `cfg.pulse.endpoint` to `~/.ashlr/config.json`.

### 2. Enable the pulse export (both machines)

```bash
ashlr config set pulse.enabled true
```

### 3. Store your PAT (each person mints their own)

The PAT is never stored in `config.json`. It lives in Phantom or the
environment.

**Preferred — Phantom vault:**

```bash
ashlr pulse connect --token <your-pulse-pat>
```

This stores the token as `ASHLR_PULSE_TOKEN` in your Phantom vault.

**Fallback — shell environment:**

```bash
export ASHLR_PULSE_PAT=<your-pulse-pat>
```

Add to `~/.zshrc` / `~/.bashrc` to persist.

### 4. Verify

```bash
ashlr pulse connect --status   # show config + sink state
ashlr pulse connect --test     # send one test span and confirm receipt
```

Once both machines pass `--test`, the Fleet/Team view in pulse will show both
teammates' activity grouped by `ashlr.fleet.owner`.

---

## Daily team flow

### Each person on their own machine

```bash
# Review proposals the fleet generated overnight
ashlr inbox

# Check daemon / fleet status
ashlr daemon status

# Check or add goals
ashlr goal ls
ashlr goal add "harden error handling in auth module"

# Run one fleet tick manually (proposal-only, no auto-apply)
ashlr loop

# Open Mission Control UI (localhost:4242)
ashlr serve
```

The Mission Control Goals tab shows goals local to that machine. Each person
manages their own fleet's goals independently.

### Shared visibility in pulse

Both teammates see the shared Fleet/Team view at the pulse endpoint. Activity
is attributed by `ashlr.fleet.owner` (the `cfg.user.id` set in step 3 above).
Neither person's proposals, inbox items, nor goals are visible to the other
directly — only the aggregated activity metrics and span data that the fleet
exports to pulse.

---

## Kill switch

Each machine has its own independent kill switch. It does not affect the other
person's fleet.

```bash
# Halt all autonomous fleet writes on this machine immediately
ashlr enroll kill on

# Resume
ashlr enroll kill off
```

Under the kill switch, read-only tools continue to work. All writes and
proposal creation are refused until it is cleared.

The kill switch is implemented as a sentinel file at `~/.ashlr/KILL`. You can
also create or remove it directly:

```bash
touch ~/.ashlr/KILL    # engage
rm ~/.ashlr/KILL       # clear
```

`ashlr daemon status` and `ashlr doctor` will warn when the kill switch is on.

---

## Daemon

The daemon runs as a background OS service (launchd on macOS, systemd on
Linux) installed during `ashlr setup`.

```bash
ashlr daemon start              # start (or restart) the loop
ashlr daemon start --once       # run exactly one tick, then stop
ashlr daemon start --dry-run    # tick without creating any proposals
ashlr daemon stop               # stop + engage kill switch
ashlr daemon status             # running?, last tick, spend, pending count
```

The daemon is proposal-only. It can never apply a proposal, push to git, or
touch the live working tree. All mutations flow through the inbox.

---

## Troubleshooting

| Symptom | Check | Fix |
|---------|-------|-----|
| Pulse not receiving spans | `ashlr pulse connect --status` | Verify `pulse.enabled true` + PAT set |
| Fleet activity not attributed in pulse | pulse Fleet/Team view shows no owner | Set `cfg.user.id` on that machine |
| Daemon not running | `ashlr daemon status` | `ashlr daemon start` |
| Kill switch engaged | `ashlr doctor` shows WARN | `ashlr enroll kill off` |
| Repo not being worked | `ashlr enroll list` | `ashlr enroll add <path>` |
| PAT rejected (401) | `ashlr pulse connect --test` | Re-run `ashlr pulse connect --token <fresh-pat>` |

---

## Key paths

| Path | Purpose |
|------|---------|
| `~/.ashlr/config.json` | All config: user identity, pulse endpoint, enrolled repos, daemon settings |
| `~/.ashlr/enrollment.json` | Enrolled repo list (local) |
| `~/.ashlr/inbox/*.json` | Pending proposals (local) |
| `~/.ashlr/goals/*.json` | Goals (local) |
| `~/.ashlr/daemon-state.json` | Last tick, spend ledger |
| `~/.ashlr/KILL` | Kill switch sentinel |

---

## Reference: relevant source files

| File | What it does |
|------|-------------|
| `src/cli/setup.ts` | First-run wizard (`ashlr setup`) |
| `src/cli/pulse.ts` | `ashlr pulse connect` — bridge config + PAT storage |
| `src/cli/sandbox.ts` | `ashlr enroll` + kill switch |
| `src/cli/daemon.ts` | `ashlr daemon` subcommands |
| `src/cli/inbox.ts` | `ashlr inbox` — proposal review |
| `src/cli/goal.ts` | `ashlr goal` — goal management |
| `src/core/fleet/pulse-export.ts` | OTLP span export + `ashlr.fleet.owner` stamping |
| `src/core/types.ts:L240–268` | `cfg.pulse` and `cfg.user` type definitions |
| `docs/PULSE-BRIDGE.md` | Full `ashlr pulse connect` reference (M62) |
| `docs/SPEC-V3-TEAM.md` | Multi-machine architecture spec |
