# How to actually turn the fleet on

`QUICKSTART.md` gets you to a foreground, one-tick-at-a-time daemon
(`ashlr daemon start --once`). This doc is the next step: an **unattended,
resident** fleet that survives a reboot — and the four gates that block it if
you skip a step. Each gate below failed silently or confusingly before
2026-08-16; as of that date all four are diagnosable, but none of them are
removed. Read this before filing "the daemon won't stay up" as a bug.

This is a different system from
[`docs/RUNTIME_ACTIVATION_AUTHORITY.md`](RUNTIME_ACTIVATION_AUTHORITY.md)'s
`ashlr daemon activation-preflight` / `ashlr daemon activate` — that system
verifies a *release build* is safe to install and is still preflight-only
(no mutation). This doc covers `ashlr activation` (top-level command,
`src/cli/activation.ts`) — the *operator authority* layer that decides
whether the daemon is allowed to run resident, auto-merge, deploy, repair
itself, or install as an OS service at all. The two are easy to confuse
because both use the word "activation"; they do not share code or state.

---

## 0. The default is still deny

By design, a fresh install has **zero** standing grants. Every resident,
install, auto-merge, deploy, and repair capability throws the same denial it
always has
(`src/core/daemon/service-install-authority.ts:11-12`,
`RESIDENT_SERVICE_AUTHORITY_DENIAL`). This is intentional — see
`docs/RUNTIME_ACTIVATION_AUTHORITY.md`'s "Authority boundary" section for why
mutation authority stays withheld by default. What changed today is that this
denial is no longer *unconditional*: an operator can now explicitly grant it.

```sh
ashlr activation init                 # creates the operator trust root — grants NOTHING by itself
ashlr activation grant resident residentStanding install --ttl 30d
ashlr activation status               # confirm what's actually granted, and when it expires
```

Scopes: `once`, `resident`, `residentStanding`, `conductor`, `automerge`,
`repair`, `deploy`, `install`, `proposalOnly`
(`src/core/daemon/activation-permit.ts:121-131`). `residentStanding` is the
one that lets the daemon **restart unattended** — grant it explicitly; it is
not implied by `resident`.

---

## Gate 1 — A dirty git tree fails `validBuildIdentity`

Every activation permit binds to a `BuildIdentity`
(`src/core/daemon/activation-permit.ts:435-446`). For a local git build,
`validBuildIdentity` requires `provenance === 'git'` **and** `dirty ===
false` — a working tree with uncommitted changes is rejected outright, not
warned about. (The `github-actions` provenance path instead requires `dirty
=== null`, since CI builds from a clean checkout by construction.)

**Symptom:** `activation grant` or a permit-consuming command refuses with a
build-identity mismatch and no further explanation.
**Fix:** `git status` clean, then re-run. Uncommitted local edits — even
docs-only ones in an unrelated directory — will trip this.

---

## Gate 2 — `launchctl bootstrap` returns `Input/output error (5)` when the service is disabled

macOS's `launchd` distinguishes "not loaded" from "loaded but administratively
disabled." If a prior `launchctl bootout` (or System Settings) disabled
`ai.ashlr.daemon` in the user domain, a subsequent `launchctl bootstrap`
fails with exit 5 / `Input/output error` — a message that gives no hint that
the fix is re-enabling, not re-installing
(`test/m93.daemon-service-transaction.test.ts:452,460` pins this exact
string: `'Boot-out failed: 5: Input/output error'`).

**Check before you install:**

```sh
launchctl print-disabled gui/$UID | grep ai.ashlr.daemon
```

The daemon's own readiness check runs the same command
(`src/core/daemon/resident-service-readiness.ts:1240`,
`runBounded('/bin/launchctl', ['print-disabled', domainTarget])`) — if you
see this in `ashlr daemon service-status` output, that is why bootstrap is
failing, not a corrupt plist.

**Fix:**

```sh
launchctl enable gui/$UID/ai.ashlr.daemon
```

---

## Gate 3 — `daemon resolve-state` writes a conservative fresh state that consumes the full daily budget

After a crash-suspect quarantine (`daemon recover-state`), `daemon
resolve-state` reconstructs a fresh `DaemonState` from whatever evidence it
can verify. The reconstruction is deliberately pessimistic
(`src/core/daemon/state-recovery.ts:2016-2027`,
`deriveDaemonAccounting()`):

- If the quarantined source's spend can be proven to belong to a **prior**
  budget day (`sourceBudgetDay < budgetDay`, and the source record parses
  cleanly) → `disposition: 'prior-day-reset'`, spend resets to `0`.
- **Any other case** — malformed source, ambiguous day, or same-day but
  unverifiable — → `disposition` is `'same-day-exhausted'` or
  `'ambiguous-exhausted'`, and:
  ```ts
  resolvedSpentUsd = Math.max(sourceSpentUsd ?? 0, configuredDailyBudgetUsd)
  ```
  i.e. the fresh state is written as if the **entire configured daily
  budget** has already been spent today.

This is the fail-safe direction on purpose — an unverifiable recovery assumes
the worst (no further spend today) rather than the convenient one (spend
resets to zero and the daemon immediately starts working again). It also
means a resolve-state you expected to "fix" the daemon can leave it
correctly idle for the rest of the day.

**Symptom:** daemon comes back up after `resolve-state` but does zero ticks
until midnight UTC (or your configured budget-day boundary).
**Fix:** nothing to fix — this is correct behavior. If you need it to run
today anyway, that is a deliberate override of a safety default; there is no
supported flag for it, and adding one is out of scope for this doc.

---

## Gate 4 — The launchd plist hardcodes `--budget <n>` at install time

`ashlr daemon install` (or the underlying `buildLaunchdDefinition()`) writes
the resolved budget directly into `ProgramArguments` as a literal CLI flag
when the plist is generated (`src/core/daemon/service.ts:229-238`):

```ts
runtimeArguments.push(
  'daemon', 'start',
  '--budget', String(o.budget),
  '--interval', String(o.intervalMs),
  '--parallel', String(o.parallel),
);
```

That string is baked into
`~/Library/LaunchAgents/ai.ashlr.daemon.plist` at install time. **Editing
`~/.ashlr/config.json`'s budget afterward does nothing to the running
service** — launchd re-execs the daemon with the same frozen argv every
time it restarts the process. There is no live-reload of this value.

**Symptom:** you raise (or lower) `daemon.dailyBudgetUsd` in config, restart
the *daemon process* some other way (`ashlr daemon stop && ashlr daemon
start`), and it still enforces the old number — because launchd's copy of
the plist, not your config edit, is what actually restarts it.
**Fix:** re-run the install step so the plist is regenerated with the new
budget, then reload the service:

```sh
ashlr daemon install --budget <new-value>   # rewrites the plist
launchctl bootout gui/$UID/ai.ashlr.daemon 2>/dev/null
launchctl bootstrap gui/$UID ~/Library/LaunchAgents/ai.ashlr.daemon.plist
```

(Confirm Gate 2 first if this second command errors.)

---

## Putting it together — first resident activation, start to finish

```sh
# 0. Clean tree (Gate 1)
git status --porcelain          # must be empty

# 1. Grant standing authority
ashlr activation init
ashlr activation grant resident residentStanding install --ttl 30d
ashlr activation status

# 2. Check for a disabled service before installing (Gate 2)
launchctl print-disabled gui/$UID | grep ai.ashlr.daemon || true
# if it prints "disabled" or similar: launchctl enable gui/$UID/ai.ashlr.daemon

# 3. Install with the budget you actually want (Gate 4 — this is baked in now)
ashlr daemon install --budget 25

# 4. Verify
ashlr daemon service-status
ashlr daemon status
```

If the daemon was previously crash-quarantined, run `daemon recover-state`
then `daemon resolve-state` before step 3 — and read Gate 3 above so a quiet
day of zero ticks doesn't look like a new bug.

## See also

- `docs/RUNTIME_ACTIVATION_AUTHORITY.md` — the separate release-build
  admission preflight (`ashlr daemon activate`), not operator authority.
- `docs/QUICKSTART.md` — foreground, one-tick-at-a-time operation; no
  resident service, no launchd.
- `docs/MILESTONE-INDEX.md` — M470 for the activation-authority rework (note
  the M470 collision recorded there), M486/M487/M501 for the crash-safety
  quarantine/recovery/resolve-state pipeline this doc's Gate 3 describes.
- `src/core/daemon/activation-permit.ts` — scopes, standing grants, trust
  roots.
- `src/core/daemon/service.ts` — plist/systemd/schtasks generation (Gate 4).
- `src/core/daemon/state-recovery.ts` — `deriveDaemonAccounting()` (Gate 3).
