# Autonomy authority

This is the owner's contract for what the ashlr fleet may do on its own, who can
change that, how to stop it, and what is still exposed. The grant format, the
rollout ladder and the ledger are specified in detail in
[STANDING-AUTHORITY.md](STANDING-AUTHORITY.md). This page covers the model,
custody, Stop and Revoke, setup, and the residual risks.

The code lives in `src/core/authority/`, the CLI is `ashlr authority`, and the
Verse Command bar uses `/api/verse/authority`. Every path named here is a Tier-1
protected path. The fleet can never change one, and `.github/CODEOWNERS`
requires the owner's review on GitHub as well.

**Current state (3.15).** Autonomy is built and ships dormant. It runs only
after you install custody, sign a standing grant with Touch ID and start the
resident daemon yourself (`ashlr authority resident start`). A grant starts on
the **shadow** stage, where every proposal goes through the gates and nothing
merges. On the maintainer's Mac a grant is active and the ladder is at shadow;
the dated details, and what is left to do, are in
[AUTONOMY-GAP.md](AUTONOMY-GAP.md#current-activation-state-315). Devin is
its own engine: a grant may name it only as a producer, and a Devin PR merges
only when the stage names `devin` and judges from two different families
approved it; otherwise it is shadow ([DEVIN.md](DEVIN.md)). Signing a grant
that names Devin needs custody helper 1.1.0 or later. You can talk to the
Leader and set directives ([LEADER.md](LEADER.md)), but nothing said in that
conversation widens the grant. **Elite self-land:** under a grant whose stage
is `elite-direct`, work by an elite model (Opus 5.5/5, Fable 5.1/5, Sonnet 5,
GPT-6 Astra/Sol/Luna, Grok 4.7/4.6, SWE-2, Qwen 3.8 27B) lands on green tests
with no judge. Devin CLI can qualify; Devin cloud still needs two judges (§1a).

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

## 1a. Elite self-land (3.15)

**Eligible elite models land directly on green tests without a judge.**
This is your decision of 2026-09-27: Codex, Claude Code, Grok and Devin CLI can
self-merge verified PRs when they run an elite model. A repository's deploy
pipeline determines when that merge reaches production. This path is on only
while the grant's **current stage is `elite-direct`**, and only you can sign that stage,
with Touch ID.

**What changes.** When the signed producer identity (`proposal.engineModel`,
`<engine>:<model>`, host-signed provenance) is on the elite allowlist, gate G6
passes with the code `elite-direct` and **no judge is asked**. There is no
judge seat to wait for, no cross-family rule, and no two-judge rule for Devin.
G5's red team, when you have it on, runs only its deterministic half, which
still blocks injected secrets and destructive diffs. Every other producer
keeps the existing judge path (G6 as before, two judges for non-elite Devin
work).

**What still gates an elite landing.** None of these is a model's opinion:

| Gate | What it checks |
|---|---|
| G0 | Stop is off, the grant is live, the repo is enrolled at `merge`, no hold, under the daily cap |
| G1 | Tier-1 self-protection: a change to authority or guardrail code goes to your owner lane and never self-lands |
| G1b | No test tampering (removed assertions, `.skip`, `.only`, snapshot edits) |
| G2 | Risk and size caps (compiled ceiling 10 files / 300 lines, medium risk; local work and local-enforcement repos lower) |
| G3 | The repo's own verify commands (tests) pass on the exact tree, off the current base |
| G4 | The producer's report matches its diff |
| G7 | Every required check is green on the PR head, including the App's host-verified `ashlr/verify`; the merge is SHA-pinned |
| After | The post-merge watch reruns checks and **automatically reverts** a landing that goes red; repeated failures hold the repo and can soft-kill the fleet |

At merge time the pass re-checks that the stage is still `elite-direct` and
the model is still allowed. If either has lapsed, the PR is held for you as a
would-merge and never merges unjudged.

**The allowlist** (`src/core/authority/elite-models.ts`, a Tier-1 file the
fleet can never change). An identity matches only when both the engine
prefix and the exact model id are listed. Matching is case-insensitive, and a
trailing context tag such as `[1m]` is ignored.

| Model | Engines | Model ids matched |
|---|---|---|
| Claude Opus 5.5 | `claude`, `claude-cli`, `anthropic`, `devin-cli` | `claude-opus-5-5`, `opus-5-5` |
| Claude Opus 5 | same | `claude-opus-5`, `opus-5`, `claude-opus-5.5` (the retired alias that ran Opus 5) |
| Claude Fable 5.1 | same | `claude-fable-5-1`, `fable-5-1` |
| Claude Fable 5 | same | `claude-fable-5`, `fable-5` |
| Claude Sonnet 5 | same | `claude-sonnet-5`, `sonnet-5` |
| GPT-6 Astra / Sol / Luna | `codex`, `openai`, `devin-cli` | `gpt-6-astra`, `gpt-6-sol`, `gpt-6-luna`, each also with `-minimal`, `-low`, `-medium`, `-high`, `-xhigh` or `-max` |
| Grok 4.7 | `grok-cli` | `grok-4.7`, `grok-4.7-build-fast` |
| Grok 4.6 | `grok-cli` | `grok-4.6`, `grok-4.6-build` |
| SWE-2 | `devin-cli` | `swe-2`, `swe-2-high`, `swe-2-medium`, `swe-2-max`, `swe` |
| Qwen 3.8 27B | `local`, `local-coder`, `ollama` | `qwen3.8:27b`, `qwen3.8:27b-ctx64k`, `qwen3.8:27b-q8_0` |

These are **never** elite, and fail closed:

- A bare id with no engine.
- Version-less aliases: `claude:opus` and `claude:sonnet` resolve to Claude
  4.x in the fleet catalog.
- The per-token Grok API engine (`grok:`).
- `llama-server:`, which serves whatever weights it loaded whatever tag the
  record carries.
- A local runtime serving a vendor-named model.
- `claude:cloud` and every `devin:` identity: the cloud intakes do not provide
  host-verifiable model identity.
- Any id not listed.

**Configuration only narrows it.** `foundry.autoMerge.eliteModels` can list
entry ids (`["gpt-6-sol", "grok-4.7"]`) to keep only those, or be `false` to
turn elite self-land off. Unknown ids are ignored; a malformed explicit value
also turns it off. Adding a model means editing the Tier-1 file in your own PR.

**Turning it on.** Several commands offer it, each with a one-line
explanation:

- `ashlr authority setup` offers it at the first grant.
- `ashlr authority grant` and `re-approve` ask about it, or take
  `--elite-direct` / `--no-elite-direct`.
- `ashlr authority draft --elite-direct` shows the grant without signing it.
- Verse's grant sheet has an **Elite direct** checkbox that fetches that draft.

An elite-direct grant has **one rung**, `elite-direct`. Every enrolled repo
sits at the stage the grant signs for it (a repo without a verify command
still only proposes), every granted engine is included (so Codex's GPT-6
produces from day one), the grant's own caps apply, and each repo keeps its
signed merges-per-day. There is no ramp. A sandbox violation, a reserve
breach or reverts above 10% restart the rung's evidence window. Choosing it
never widens the Leader: a new grant gets no Leader classes, and a
re-approval keeps the classes of the rung you had reached. A re-approval of
an elite-direct grant continues it. To go back to the judged ladder, sign a
new grant, which starts at shadow.

The custody helper signs this grant as it is: `elite-direct` is an ordinary
stage id, so **no helper reinstall is needed**. The Touch ID prompt lists it
among the stages.

**Parallel throughput.**

- The standing pass now works through repos in parallel:
  `foundry.autoMerge.repoLanes`, default 4, and `1` restores one at a time.
- Within a repo, work stays one queue: its open PRs first, then its
  proposals, oldest first.
- The per-pass verification budget rose from 2 to 4
  (`verifyBeforeJudgePerPass`), so both machine verification slots are used.
- Elite work spends nothing from the per-pass judge budget.

The limits that remain are:

- the daemon's 5-minute tick;
- two verification slots per machine and one per repo
  (`sandbox/execution-leases.ts`);
- each repo's daily merge cap (at most 24; 4 on local-enforcement repos);
- the size and risk ceilings.

**Decisions left to you** (kept, not removed; tell us to change them):

- **Size and risk ceilings.** 10 files / 300 lines and medium risk are
  compiled into both the verifier and the custody helper. Larger elite
  changes are refused at G2, or wait there.
- **Local work and local-enforcement repos.** Work a local model wrote,
  including elite Qwen 3.8, and work on private free-plan repos stays at low
  risk, 4 files / 150 lines. Local-enforcement repos are also held to 4
  merges a day.
- **Claude as a producer.** The default grant gives the Claude seat judge and
  leader roles only, keeping it in reserve for you. Opus and Fable produce
  autonomously only through a seat you give the `producer` role.
- **Your config.** `allowSelfMerge: false` keeps ashlr-hub propose-only,
  whatever the grant says.
- **Cloud intakes.** `claude:cloud` and `devin:<mode>` record no model. To
  make cloud sessions elite, they would have to record the model they ran.

## 2. Custody

| Item | Where | Protection |
|---|---|---|
| Signing key | Secure Enclave, through `/usr/local/libexec/ashlr-custody` (root-owned, installed once with `sudo scripts/install-custody.sh`) | The key cannot be exported, and every signature needs Touch ID or the login password. The helper parses the grant strictly, shows its scope in the Touch ID prompt, and refuses anything that is not a StandingGrantV1 within the compiled ceilings. |
| Key id | `se-p256-` + the first 16 hex characters of sha256(SPKI DER) | The verifier accepts a compiled root only when its `keyId` equals `keyIdForPublicKeyPem(publicKeyPem)`, so anyone reviewing a trust-roots PR can recompute the id. |
| Trust roots | `src/core/authority/trust-roots.ts` | Added only in your own PR (setup opens it from a throwaway worktree). The August `mason-workstation` ed25519 key is burned: roots are ES256 only, and that key id is on the refusal list. |
| GitHub App key (`ashlr-fleet`) | Keychain item owned by the helper | Created through the App Manifest flow. The PEM never touches disk and is never printed. The App can write contents, pull requests and check runs (3.13: it posts the host-verified `ashlr/verify` check) and read statuses and metadata. It is never a code owner and cannot bypass rulesets. |
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

Setup is safe to rerun, as often as you like. Each step checks first and
reports `already` for what is in place: an open trust-root PR is found, not
reopened; a ruleset GitHub already holds with the same content is not applied
again; the provenance key is rotated only once. A step that fails is reported
as failed, and the run still ends with its summary. Verse shows the same
checklist, read-only, on Command and in onboarding
(`GET /api/verse/authority/setup`, the dry run's `--json`), with the next
step's command to copy.

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
   more click. The step counts as done only when the App is installed on the
   enrolled repos, not just when its key is in custody. Setup checks with
   `gh api orgs/<owner>/installations`, then asks the App itself (custody
   `gh-token`) about any repo that check leaves open. Until the App is
   installed, the step waits on you and prints the install page. An App
   created before 3.13 has only `checks: read` and cannot post
   `ashlr/verify`; setup detects that, marks this step waiting on you and
   prints the exact links: set **Checks: Read and write** on the App's
   Permissions page, then accept the new permission on each installation.
6. **Claude token.** Run `claude setup-token` in another terminal and paste
   the token. The input is hidden, and the token goes straight to custody.
7. **Rulesets.** Setup runs `ashlr authority protect --apply`; review the
   rules first with `--print`. Only repos whose ruleset is missing or
   differs are applied. An extra rule, bypass actor or required check counts
   as a difference. Each ruleset requires status checks, pinned to
   the App that reports each one today, and requires the head to be up to
   date with its base. For a grant repo whose fleet mirror has a verify
   command it also requires `ashlr/verify`, pinned to the `ashlr-fleet` App,
   even when the default branch reports no checks at all (GitHub Actions
   off). The App posts `ashlr/verify` only on fleet PRs: `success` only when
   G3 passed and the PR head is exactly the verified tree on the verified
   base, `failure` otherwise. Your own PRs need the admin bypass unless
   another required check covers them. It also blocks force-push and deletion and requires
   code-owner review on protected paths.
   **The repository admin role (you) may bypass the ruleset; the App may
   not.** A private repository on GitHub's free plan cannot have rulesets or
   branch protection. New grants use **local enforcement** there, with the
   App's `ashlr/verify` and lower compiled caps (low risk, 4 files / 150
   lines, 4 merges a day); `status` and `setup` explain the mismatch for an
   older grant, and re-approving switches it.
8. **Canary repo.** Setup creates `ashlrai/fleet-canary` and its CI workflow
   using your own `gh` auth, because the App cannot write workflows.
9. **Old activation state.** Setup moves `~/.ashlr/activation`, which holds
   the burned key, out of `~/.ashlr`. Archive it offline, then delete it.
10. **Provenance key.** Setup rotates the provenance HMAC key, which agents
    could read while confinement was off. It does this once. The rotation is
    recorded next to the key in `provenance.key.rotation.json`, as the new
    key's sha256, so a rerun leaves that key alone. Rotating again would
    invalidate every pending proposal. `ashlr authority rotate-provenance`
    still rotates whenever you run it, and records that rotation too.
11. **First grant.** You sign the first grant (Touch ID). Setup first offers
    elite-direct in one line (§1a); say no and the ladder starts in shadow.
    If you agree, setup then sets the switch to Autonomous.

12. **Resident daemon.** Press **Start** in the desktop app's Fleet tab (3.15),
    or run `ashlr authority resident start` in your own terminal. Either way
    it refuses agents, a dirty build, Stop, the switch at Off and an inactive
    grant, shows the release, plist and daily budget, and asks you to confirm
    — in the app, in a native dialog no page script or agent can answer
    ([desktop/README.md](../desktop/README.md), "Fleet operations"). Setup
    never does this step for you ([RESIDENT-RUNTIME.md](RESIDENT-RUNTIME.md)).

Your recurring actions after setup are one Touch ID per 30-day grant, and one
after installing a release that changes authority code (`ashlr authority
re-approve`, or the Command bar), followed by `ashlr authority resident stop`
and `start` so the daemon runs that release. Re-approval continues from the
rung you had reached. `ashlr authority resident status` shows when the
installed plist has drifted from config.

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
- **Cloud intake (3.13)** (`fleet/cloud-intake.ts`, a Tier-1 root) is the one
  place the host signs provenance for a diff it did not produce. Each standing
  tick it turns a Claude cloud or self-improvement PR (`ashlr-cloud/<taskId>`)
  on a granted repo with a current mirror into a pending mirror proposal with
  producer `claude:cloud`. The signature vouches for **identity only**: this
  host read exactly this diff hash from the pinned head SHA of the task's
  pinned PR, with the head ref, repository and base checked on GitHub that
  tick. It says nothing about correctness, and no gate reads it that way. G3
  still verifies the exact tree in the mirror, G4 checks the session's
  (UNVERIFIED) report against the diff, G6 requires a codex or Grok judge (the
  producer family is `claude`; `claude:cloud` names no model, so it is never
  elite-direct), and G7 requires the App's green
  `ashlr/verify`. G1 (protected paths go to the owner lane) and G1b are
  unchanged. The cloud PR is closed as "superseded" once the App PR exists,
  and the tracker follows the App PR to `merged`. Details:
  [CLOUD.md](CLOUD.md#intake-into-the-standing-gates-313).
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
    ruleset exists. ashlr-hub is such a repo today; once `protect --apply`
    requires `ashlr/verify` there, G7 can pass on the App's host-verified
    check. On a local-enforcement repo G7 requires the App's green
    `ashlr/verify` among the checks, so a deploy-only green (a Vercel
    preview) never proves a PR green.
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
20. **Cloud intake trusts GitHub's answer for the diff.** The host signs
    what `gh api …/compare/<merge-base>...<head>` returned for the pinned
    head. A compromised gh session could feed it a different diff. That diff
    would still have to pass G3 in the mirror, an independent judge and G7,
    and what lands is the verified tree, not the cloud branch. The gh
    identity that closes the superseded cloud PR is yours (the cloud lane's
    `gh`), not the App's.
21. **Elite self-land trusts the recorded model.** G6 no longer asks a judge
    about elite work, so the producer identity has to be what actually ran.
    The host builds it from its own dispatch, never from what the agent says.
    Since 3.15 it names the model passed to the CLI whenever one is passed.
    Two gaps remain:
    - When no model is passed, claude and codex run their CLI's own default
      while the record names the registry default (`claude-opus-4-8`,
      `gpt-5.5`, or `ASHLR_MODEL`). Both defaults are non-elite, so this fails
      closed unless `ASHLR_MODEL` names an elite model.
    - `llama-server` is excluded outright.

    What stands in for the judge is your test suite: a repo whose tests are
    thin gets thin protection. The post-merge watch and its automatic revert
    are the backstop.

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
- starts a run only when one is due: the 06:30 slot, or a trigger (10 fleet
  merges, a revert, a seat window resetting, a high-severity insight), at
  most 3 a day, and skipped when the evidence has not changed;
- routes that run to a seat the router admits (reserve floors, budget mode,
  no cloud fallback). Without a standing grant it runs on a free local model
  or not at all, and the memo is a dry run: its actions are shown, not
  applied.

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
