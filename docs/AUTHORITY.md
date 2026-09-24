# Autonomy authority (3.10)

This is the owner's contract for what the ashlr fleet may do on its own, who can
change that, how to stop it, and what is still exposed. The grant format, the
rollout ladder and the ledger are specified in detail in
[STANDING-AUTHORITY.md](STANDING-AUTHORITY.md). This page covers the model,
custody, Stop and Revoke, setup, and the residual risks.

The code lives in `src/core/authority/`, the CLI is `ashlr authority`, and the
Verse Command bar uses `/api/verse/authority`. Every path named here is a Tier-1
protected path. The fleet can never change one, and `.github/CODEOWNERS`
requires the owner's review on GitHub as well.

## 1. The model

**Only a Touch ID signature raises authority. Anything can lower it, instantly.**

| Direction | Actions | What it takes |
|---|---|---|
| Raise | New grant, re-approval, a wider ladder | A **standing grant** signed by the Secure Enclave key in `ashlr-custody`, which asks for Touch ID every time. The grant is verified against the **compiled** trust roots, never against a file or an environment variable. |
| Raise within the grant | Switch back up to Propose or Autonomous; clear Stop | No Touch ID, but the change is written to the ledger **first**. If the ledger refuses the row, nothing is raised. |
| Lower | Switch down, Stop, Revoke, moving the budget toward the reserve | Nothing. The action takes effect first and is recorded afterwards (best effort), so it still works when the ledger is broken. |

What the daemon may do at any moment is
`currentStandingPolicy()` = min(grant, current rollout stage, switch, config,
compiled ceilings). It is **null**, so nothing runs autonomously, whenever:

- no grant is installed, or it is expired, revoked, paused or invalid;
- the switch is Off, or Stop (`~/.ashlr/KILL`) is on;
- the ledger chain is broken;
- the running code is not the code the grant was signed for (the
  authority-surface digest);
- this is a different Mac (`hostBinding` = sha256 of the uppercase
  `IOPlatformUUID`; the helper and the CLI compute it the same way, and
  `ashlr authority setup` checks that they agree before it asks for Touch ID);
- **the confinement self-test fails.** `confinementAvailable()` runs U2's
  `probeAutonomousConfinement()`, which applies the real autonomous sandbox
  profile to a throwaway home. The profile must be accepted, the worktree must
  be writable, a read of an `~/.ashlr/authority` tripwire must be killed, and a
  write elsewhere in HOME must be refused. The result is cached for 10 minutes.
  A macOS update that silently stops enforcing the profile therefore turns
  autonomy off instead of letting agents run unconfined.

The grant carries a signed **rollout ladder**, which runs shadow → 2a → 2b →
2c → 3a…3d. The daemon climbs one rung when that rung's criteria are met and
drops one rung on a breach. It can never go past the last rung you signed, and
neither the Leader nor config can skip a rung or edit one.

## 2. Custody

| Item | Where | Protection |
|---|---|---|
| Signing key | Secure Enclave, through `/usr/local/libexec/ashlr-custody` (root-owned, installed once with `sudo scripts/install-custody.sh`) | The key cannot be exported, and every signature needs Touch ID or the login password. The helper parses the grant strictly, shows its scope in the Touch ID prompt, and refuses anything that is not a StandingGrantV1 within the compiled ceilings. |
| Key id | `se-p256-` + the first 16 hex characters of sha256(SPKI DER) | The verifier accepts a compiled root only when its `keyId` equals `keyIdForPublicKeyPem(publicKeyPem)`, so anyone reviewing a trust-roots PR can recompute the id. |
| Trust roots | `src/core/authority/trust-roots.ts` | Added only in your own PR (setup opens it from a throwaway worktree). The August `mason-workstation` ed25519 key is burned: roots are ES256 only, and that key id is on the refusal list. |
| GitHub App key (`ashlr-fleet`) | Keychain item owned by the helper | Created through the App Manifest flow. The PEM never touches disk and is never printed. The App can write contents and pull requests and read checks, statuses and metadata. It is never a code owner and cannot bypass rulesets. |
| Claude token | Keychain item owned by the helper | Used only by `claude --restricted --tools ""` judge and Leader calls, which have no tools. |
| Grant, switch, ledger | `~/.ashlr/authority/` (0700; files 0600) | The grant is signed, the ledger is hash-chained and anchored, and a missing or unreadable switch reads as Off. Confined agents cannot read this directory at all; it is a tripwire that kills the reader. |

Confined agents cannot exec or read the helper, the custody data directory, the
Keychain, Touch ID, `security`, `launchctl`, `osascript` or `sudo`. U2 verified
this with real `sandbox-exec` runs under the generated profiles.

## 3. Stop and Revoke

| Control | Effect | Resume |
|---|---|---|
| **Switch down** (`ashlr authority switch propose\|off`) | Takes effect on the next policy read in every process. Nothing is cached past a lowering. | Raise it again within the grant. No Touch ID is needed, and the raise is ledgered first. |
| **Stop** (`ashlr authority stop`, the Verse Stop button) | 1. Arms `~/.ashlr/KILL`. 2. Aborts every running agent: this process's agents immediately, other processes' at their next lease poll (≤ 2 s). 3. Revokes every **armed** host merge through the revocation protocol, so one that another process prepared can never be consumed. 4. Reports how many agents are still running (`liveExecutionLeases`). The CLI waits up to 30 s for agents to exit (`--no-wait` returns at once). The Verse route answers at once and runs step 3 a few milliseconds later in the same process. | `ashlr authority clear-stop`. It is ledgered first, and it waits until the fence is free. |
| **Revoke** (`ashlr authority revoke`) | Switches off, raises `minGrantSeq` past every grant accepted so far, moves the installed grant aside, **and engages Stop** (everything above). Revoke must halt a running agent within one tick, and the lease abort is keyed on KILL. | Needs a **new grant** (Touch ID), and then clearing Stop. |

Even if the merge revocation fails, a merge cannot go out after Stop. The
consume step re-checks KILL and the KILL epoch under the outward fence
immediately before it calls GitHub, and again after consuming.

## 4. Setup (Phase 0)

`ashlr authority setup` is one guided command. It asks before every step,
prints what it did, never runs `sudo`, and never touches launchd.
`--dry-run` shows the plan without asking or changing anything.

1. **Custody helper.** If the helper is missing, setup stops and asks you to
   run `sudo scripts/install-custody.sh` yourself. Running it with `--dry-run`
   first prints the plan. The build and the tests run as you; only the final
   install runs as root.
2. **Host binding.** Setup checks that the helper and this release agree on
   the Mac's identity. If they disagree, setup stops before any Touch ID.
3. **Signing key.** Setup creates the key with `ashlr-custody init` (Touch
   ID). A key made on an earlier run is read back with `ashlr-custody pubkey`,
   which needs no Touch ID.
4. **Trust root.** Setup opens a PR that adds `{keyId, publicKeyPem}` to
   `trust-roots.ts`, working in a throwaway worktree so your checkout is
   untouched. You review it, merge it, run `npm run build`, install the
   release, then `launchctl kickstart -k gui/$(id -u)/ai.ashlr.daemon`, and
   rerun setup.
5. **GitHub App.** Setup creates the `ashlr-fleet` App through the Manifest
   flow, which takes one browser page. Installing the App on the repos is one
   more click.
6. **Claude token.** Run `claude setup-token` in another terminal and paste
   the token. The input is hidden, and the token goes straight to custody.
7. **Rulesets.** Setup runs `ashlr authority protect --apply`; review the
   rules first with `--print`. Each ruleset requires status checks, pinned to
   the App that reports each one today, and requires the head to be up to
   date with its base. It also blocks force-push and deletion and requires
   code-owner review on protected paths.
   **The repository admin role (you) may bypass the ruleset; the App may
   not.**
8. **Canary repo.** Setup creates `ashlrai/fleet-canary` and its CI workflow
   using your own `gh` auth, because the App cannot write workflows.
9. **Old activation state.** Setup moves `~/.ashlr/activation`, which holds
   the burned key, out of `~/.ashlr`. Archive it offline, then delete it.
10. **Provenance key.** Setup rotates the provenance HMAC key, which agents
    could read while confinement was off.
11. **First grant.** You sign the first grant (Touch ID). If you agree, setup
    then sets the switch to Autonomous; the ladder starts in shadow.

Your only recurring action after setup is one Touch ID per 30-day grant, or
after a deploy that changes authority code (`ashlr authority re-approve`, or
the Command bar). Re-approval continues from the rung you had reached.

## 5. What is protected, and how the list stays honest

- **Tier-1 protected paths** (`authority/protected-paths.ts`
  `TIER1_SOURCE_PATTERNS`) route any fleet diff that touches them to the owner
  lane (gate G1) before a PR exists. `.github/CODEOWNERS` is generated from
  the same rules, and a drift test fails when the two disagree. At 3.10
  integration four modules were added: `run/engine-registry.ts` and
  `resources/native-profile.ts` (engine mapping and the confined grok-cli
  launch), and `learn/experiments.ts` and `local-eval/tasks-heldout.ts` (the
  yardstick that harness adoption rests on).
- **The authority surface** (`scripts/authority-surface.mjs`, run by
  `npm run build`) hashes the runtime import closure of the modules that
  decide authority, about 357 files. A deploy that changes any of them pauses
  the grant until you re-approve. The same four modules were added as roots.
  U4's post-merge watch, quarantine and post-merge halt were already roots.
- **The Tier-1 closure snapshot** (`test/fixtures/authority/tier1-closure.json`)
  makes CI fail when any Tier-1 module's import closure grows. The snapshot
  file is itself protected, so only you can bless new members:
  `ASHLR_UPDATE_TIER1_CLOSURE=1 npx vitest run test/authority-tier1-closure-310b.test.ts`.

## 6. Residual risks (read before activating)

**Custody and confinement (U2):**

1. **Code running unconfined as you** can do anything you can. It can run the
   installed helper (`gh-token`, `claude-token`), use your gh token, edit
   `~/.ashlr`, delete `~/.ashlr/KILL`, and, because the rulesets let the admin
   role bypass them so you are never your own bottleneck, push past them.
   Autonomous work never runs unconfined. The ledger, the `Ashlr-Grant:`
   commit trailer and the protected branches make such actions visible, not
   impossible. Revoke is the durable stop: resuming needs a new Touch ID.
2. **Egress engines can reach non-loopback listeners and the LAN.** Examples
   are dev servers on `*:3000` and AirPlay on `*:5000`/`*:7000`, because
   Seatbelt cannot filter by IP. Closing this needs an egress proxy (3.11).
3. **Verification runs expose loopback services** to the code under test,
   such as Ollama's unauthenticated admin endpoints.
4. **Not yet exercised against paid seats.** These are the real `grok -p`
   path (token refresh, the auth write-back, the leader socket) and a Claude
   judge call with a real token. Verify both in the Phase 1 shadow.
5. **Ad-hoc signing ties the Keychain access list to one exact build.** Every
   helper reinstall means storing the App key and the Claude token again.
   Setting `ASHLR_CUSTODY_SIGN_IDENTITY` to a Developer ID avoids this.
6. **Sandbox denials are invisible to non-root log readers.** Violation
   detection is best effort: tripwire kills plus an output scan. The denial
   itself still holds.
7. **AppleEvents denial is not proven against a real target**, because that
   would pop a macOS permission prompt. It relies on the `osascript` exec deny
   and the operation and mach-service denies.
8. **Local engines have no egress**, so they cannot fetch Rust or Bun
   dependencies. Package caches are per run.
9. **safe-git passes the push token in the child's environment**, not argv.
   This relies on macOS not exposing other processes' environments (verified
   on macOS 26) and on the profile's process-info deny.
10. **Grok state is a per-run copy.** A refreshed `auth.json` is written back
    only when it is provably the same account and the real file has not
    changed in the meantime. Signing grok in again revokes an agent's copy.

**Merging and post-merge (U3/U4):**

11. **Base-move race.** The rulesets that `protect --apply` writes turn on
    "require branches to be up to date", which closes this race. A repo
    protected any other way can still land a head that was never tested
    against a base that moved after the final re-check, because the SHA pin
    covers only the head. That includes classic branch protection, where
    the flag reads as unknown, and local enforcement.
12. **Zero auto-merges at first on repos without required checks.** A repo
    with no required checks sends every fleet PR to the owner lane until its
    ruleset exists. ashlr-hub is such a repo today.
13. **Slow revert CI can trip the kill.** The revert lander waits up to 15
    minutes for checks. Repeated slow runs escalate to owner-hold plus a
    global soft kill.
14. **Post-merge suite re-runs execute merged fleet code.** Check that they
    run under `autonomousVerificationProfile()` before phase 2a. That was a
    cross-unit request to U3 and U4.

**Authority model:**

15. **The loop and the live tick hooks are outside the surface.** A deploy
    that changes `daemon/loop.ts` or `fleet/tick-hooks-live.ts` does not ask
    for a new Touch ID. Both remain protected paths the fleet cannot change.
16. **Config can only tighten.** Your live `allowSelfMerge: false` keeps
    ashlr-hub propose-only even under a `merge-non-authority` grant.
17. **The ledger has no rotation.** The per-tick check re-hashes every byte
    already verified: about 20 ms at around 15 MB, plus a full re-parse every
    hour.
18. **The rulesets' admin bypass assumes GitHub's repository-admin role id
    is 5.** `ashlr authority protect --print` shows the exact JSON, so review
    it before `--apply`.
19. **Grok as a judge.** Allowing `grok-cli:<model>` to judge, only through
    the seat, reverses the M298 rule that Grok never carries merge authority
    (U7). The per-token Grok API engine is still refused. This is your call to
    confirm.

## 7. Nightly oversight

The `ai.ashlr.oversight` LaunchAgent runs every morning at 07:00. Before 3.10
it ran `~/.ashlr/oversight.sh`. That script is outside the repo and has never
been reviewed, and it makes two paid calls with no budget gate:

- **`ashlr vision review`** ran the legacy Strategist, which picks the Claude
  CLI first and spends from your Claude window outside `BudgetPolicy`.
- **`ashlr manager`** ran the M120 judge, which also resolves the Claude CLI
  outside the SeatRouter.

**What 3.10 changes.** `ashlr vision review` is now an alias of
`ashlr leader tick --wait`, and it never loads the Strategist. That fixes the
first call even under the old script, but only once the 3.10 release is
installed: `~/.local/bin/ashlr` runs the installed release, not this checkout.
A Leader tick does four things:

- applies class-B actions whose veto window has passed;
- grades moves that are due;
- starts a run only when one is due: the 06:30 slot, or a merge, revert,
  seat-reset or insight trigger, at most 3 a day, and skipped when the
  evidence has not changed;
- routes that run to a seat the router admits (reserve floors, budget mode,
  no cloud fallback). Without a standing grant the run is a dry run.

Run at 07:00, the tick catches the 06:30 slot when the daemon is dark. When
the daemon already ran it, the tick costs nothing.

**The job it should run.** `ashlr leader oversight-plist --print` prints a
self-contained replacement. The script is inline, so the job no longer depends
on `oversight.sh`. It keeps the same label, the same 07:00 schedule and the
same log paths, and appends to `~/.ashlr/oversight.log`:

| Step | Why |
|---|---|
| `ashlr leader tick --wait` | The budget-gated planning pass. Replaces `vision review`. |
| `ashlr fleet oversight` | Read-only scorecard, with no model call. |
| `ashlr comms digest` | Read-only snapshot sent to your channel. |
| `ashlr comms ask-vision` | Posts the newest Leader memo (Keep it / Veto this memo / Show full memo). Its own tick finds nothing due right after the first one, so there is never a second run. |

`ashlr manager` is **left out on purpose**, because its judge would spend
your Claude reserve unattended. If you want its scorecard anyway, run it by
hand, or add it back knowing that it bypasses the router.

The command only prints. It writes no file and never calls `launchctl`. It
uses `~/.local/bin/ashlr` by default, the stable symlink the installer keeps,
so each new release is picked up without regenerating the plist. Pass
`--bin /abs/path` to use a different launcher.

**Installing it.** This is your step, after review. Nothing in the build or
in activation does it for you.

```sh
ashlr leader oversight-plist --print > "$TMPDIR/ai.ashlr.oversight.plist"
plutil -lint "$TMPDIR/ai.ashlr.oversight.plist"
diff ~/Library/LaunchAgents/ai.ashlr.oversight.plist "$TMPDIR/ai.ashlr.oversight.plist"
cp ~/Library/LaunchAgents/ai.ashlr.oversight.plist ~/.ashlr/oversight.plist.pre-310   # rollback copy
launchctl bootout gui/$(id -u)/ai.ashlr.oversight
cp "$TMPDIR/ai.ashlr.oversight.plist" ~/Library/LaunchAgents/ai.ashlr.oversight.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/ai.ashlr.oversight.plist
launchctl kickstart gui/$(id -u)/ai.ashlr.oversight    # optional: run once now
```

To roll back, do the same `bootout` and `bootstrap` with the saved copy.
After the swap, `~/.ashlr/oversight.sh` is no longer used. Archive it rather
than editing it, so that no second copy of the job drifts.
