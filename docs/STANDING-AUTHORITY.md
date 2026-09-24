# Standing authority (3.10)

One Touch ID signs a **standing grant**: what the fleet may do, on which repos,
with which engines and how much of your usage, for up to 30 days — including a
signed **rollout ladder** the daemon climbs by itself as evidence accrues and
drops back down on a breach. Lowering authority (Stop, switch down, revoke) is
instant and needs nothing. Raising it past what you signed needs a new grant.

This page specifies the grant, the ladder and the ledger. For the model,
custody, Stop and Revoke, setup, and the **residual risks**, see
[AUTHORITY.md](AUTHORITY.md). The code is `src/core/authority/`, the CLI is
`ashlr authority`, and the Verse Command bar uses `/api/verse/authority`.

## The pieces

| Piece | Where | What it does |
|---|---|---|
| Custody key | `ashlr-custody` (Secure Enclave, Touch ID) | The only signer. It parses the grant strictly, shows its scope in the Touch ID prompt, and cannot sign anything else. |
| Trust roots | `src/core/authority/trust-roots.ts` | The compiled public keys a grant must verify against. Added only in your own PR. Never read from a file or the environment. |
| Grant | `~/.ashlr/authority/grant.json` | The installed signed grant (signed public data; 0600 anyway). |
| Switch | `~/.ashlr/authority/clamp.json` | Off / Propose / Autonomous. A missing or unreadable file means Off. |
| Stop | `~/.ashlr/KILL` | Nothing autonomous runs while it exists. |
| Ledger | `~/.ashlr/authority/ledger.jsonl` | One hash-chained, append-only record of every grant, switch, Stop, rollout move, gate, merge, revert, hold, Leader and harness event. |
| Surface manifest | `dist/authority-surface.json` | Every file in the runtime import closure of the authority code, hashed at build time. |

## What a grant must pass, every time

`verifyStandingGrant` (pure) and the daemon's per-tick check:

1. The compiled root set is valid: ES256 / P-256 keys only, unique ids, no
   burned key (the August `mason-workstation` ed25519 key can never be a root).
2. The payload has **exactly** the StandingGrantV1 key set at every level, and
   every value is at or under the compiled ceilings — refused, never clamped.
3. The key id is a compiled root and the ES256 signature (IEEE-P1363 r‖s)
   verifies over `ashlr:standing-grant:v1\0` ‖ canonical JSON.
4. Issued no more than 5 minutes in the future; not expired; at most 30 days.
5. Not revoked, and `grantSeq` is at least every floor: revocations, every
   grant accepted before it (putting an older grant back is refused), and the
   floor carried over by a ledger recovery.
6. Signed for **this Mac** (`sha256(IOPlatformUUID)`).
7. Signed for **this code**: the authority-surface digest of the release that
   would act. A deploy that changes any authority file pauses the grant
   ("authority code changed — re-approve"); putting the old code back resumes it.
8. Recorded as accepted in an intact ledger, as the latest accepted grant.

The daemon additionally needs Stop off, the switch not Off, and OS
confinement that passes its self-test (`probeAutonomousConfinement()`: the
real autonomous profile, applied to a throwaway home, must be enforced).
If confinement fails, nothing ticks.

## Compiled ceilings

| Limit | Value |
|---|---|
| Lifetime | 30 days |
| Risk | medium at most (`high` is never mergeable) |
| Size | 10 files / 300 lines (merge.ts's policy maximum) |
| Local-authored work | low risk, 4 files / 150 lines |
| Locally enforced repos (private, free plan) | low risk, 4 / 150, 4 merges a day |
| Merges | 24 per repo per day |
| Class-B veto window | 30 minutes to 24 hours |

## The effective policy

`currentStandingPolicy()` is min(grant, current rollout stage, switch,
config, ceilings). Config can only **tighten**; an absent key is no
constraint, a mangled one is ignored. What config can tighten:

| Config | Effect |
|---|---|
| `foundry.autoMerge.enabled: false` | every repo proposes only |
| `foundry.autoMerge.maxRisk: "low"` | low risk only |
| `foundry.autoMerge.maxAutomergeFiles / maxAutomergeLines` | lower size caps |
| `foundry.autoMerge.allowSelfMerge: false` | ashlr-hub stays propose-only |
| `foundry.localOnly: true` | only the local engine family |

It is cached for 10 seconds, but Stop and the switch are re-read on every
call: lowering takes effect immediately, in every process.

The standing overlay the daemon applies to its config forces
`claimIntegrity`, `selfImprove` and `counterfactual` on, OS confinement
(`mode: os`, fail when unsupported), merges only through the remote
(`pushToRemote`, no local-merge fallback), never without verification, and
the clamped caps. The budget policy is clamped too: mode at most the grant's
`maxMode`, reserves at least the grant's floors, seats the grant does not
name disabled.

## The rollout ladder

The grant's `rollout.stages` are signed with it. The daemon, on each tick:

- **advances one stage** when every criterion of the current stage is met,
  counting only ledger rows written while that stage was current;
- **drops back one stage** on any sandbox violation, any reserve breach, or a
  revert rate above the stage's limit (on the first rung, the stage restarts);
- never goes past the last signed stage. Nothing — not the Leader, not config
  — can skip or edit a stage.

A merge counts toward advancing only once its post-merge watch reports; a
watch still running holds the stage. In a stage where no repo merges
(shadow), complete would-merge digests count instead.

The default ladder `ashlr authority draft` proposes:

| Stage | Repos (merging) | Caps | Leader | To advance |
|---|---|---|---|---|
| shadow | ashlrcode, binshield, fleet-canary (none) | low, 4/150 | — | 5 would-merges, 12 h |
| 2a | + ashlrcode, fleet-canary merge | low, 4/150, 6/day | — | 3 merges, 100% green, no reverts, 8 h |
| 2b | + binshield merges | low, 4/150, 6/day | — | 10 merges, 90% green, ≤ 10% reverts, 24 h |
| 2c | same | low, 4/150, 6/day | A | 25 merges, 95% green, ≤ 10% reverts, 48 h |
| 3a | + ashlr-plugin | medium, 10/300, 12/day | A, B | 5 merges, 95% green, ≤ 5% reverts, 24 h |
| 3b | + ashlr-pulse (once it has a verify command) | same | A, B | same |
| 3c | + locus, phantom-secrets (low risk) | same | A, B | same |
| 3d | + measurably (local), ashlr-cortex (propose until verify), ashlr-hub (merge-non-authority) | same | A, B | last stage |

Engines: local, grok-cli and claude-cli (Claude judges and leads, never
produces) through 2c; codex from phase 3. Budget: balanced, no metered spend;
Claude keeps 40% of its weekly window for you and is left alone while its
5-hour window is above 70%; Grok 0% reserve; local unlimited.

**Re-approval continues the ladder.** After a deploy that changed authority
code, an expiry, or for the next 30 days, `ashlr authority re-approve` (or
the Command bar) drafts the same scope with fresh dates and bindings, and its
ladder starts at the stage you had reached — so a deploy never restarts the
ramp from shadow. The starting stage is inside what you sign.

## The authority surface

`npm run build` runs `scripts/authority-surface.mjs` after `tsc`. It walks the
runtime import closure (the TypeScript parser, so comments and strings never
count and every real import form does) of the modules that decide authority:
`authority/**`, the activation permit, the tick hooks, the post-merge halt and
watch, liveness, `inbox/merge.ts`, the automerge pass and merge gates,
host-merge, quarantine, the regression sentinel, the dispatch router,
backpressure, mirrors, the fleet manager and reviewer independence,
`sandbox/**`, `policy/**`, the routing policy, provenance, the sandboxed
engine, Leader actions, the harness registry, the host-merge revocation
protocol, the model-family enum and the verify-command runner — about 360
files. Packages the closure imports are pinned by version; a dynamic import
with a computed specifier is listed so a reviewer sees it.

`daemon/loop.ts` and `fleet/tick-hooks-live.ts` are deliberately **not**
roots: they orchestrate calls into the modules above, but each pulls in the
whole daemon, the Verse server and Universe (about 590 files), so as roots
they would pause the grant on nearly every deploy. They stay protected paths:
the fleet can never change them.

## The ledger

Each line is exactly the canonical JSON of one entry. `hash` is
`sha256(ashlr:authority-ledger:v1\0 ‖ canonical entry without hash)`,
`prevHash` chains, `seq` is contiguous, time never runs backwards, and row 0
is a genesis row naming this Mac. Tampering is caught by the chain, by the
anchor file (`ledger-head.json`, rewritten after each append — a shorter chain
is broken), by each process's high-water mark, and by the daemon re-hashing
every byte it already verified on every tick.

A broken chain is **sticky** (`ledger.broken`): nothing autonomous runs, and
nothing that raises authority can be recorded, until you sign a new grant.
Installing it archives the broken file beside the ledger and starts a fresh
chain whose second row (`ledger:recovered`) carries the old chain's highest
grant number forward.

Writers must fail closed: when `appendLedger` answers `ok: false`, the action
it was recording must not happen. `repo` is always GitHub `owner/name` (or
null), never a path.

## Commands and routes

```
ashlr authority status [--json]
ashlr authority switch <off|propose|autonomous>
ashlr authority stop [--no-wait] | clear-stop
ashlr authority revoke [--reason <text>] [--no-wait]
ashlr authority draft [--new|--reapprove] [--json]
ashlr authority grant [--yes] [--payload <file>] [--switch <mode>]
ashlr authority re-approve [--yes] [--switch <mode>]
ashlr authority ledger verify | tail [--limit N] [--kind K]
ashlr authority surface [--installed]
ashlr authority protect --print | --apply [--repo owner/name]
ashlr authority github-app [--org <login>]
ashlr authority rotate-provenance
ashlr authority setup [--dry-run] [--source <ashlr-hub checkout>]
```

Stop arms KILL, aborts running agents (reporting `liveExecutionLeases`)
and revokes armed host merges. Revoke does all of that too, then burns the
grant sequence. The CLI waits for agents to drain (up to 30 s); `--no-wait`
and the Verse route return at once. See AUTHORITY.md §3.

`GET /api/verse/authority` (status), `GET /api/verse/authority/draft`,
`GET /api/verse/authority/ledger`, and `POST /api/verse/authority` with one
of `switch`, `stop`, `clear-stop`, `revoke`, `grant`, `re-approve`. Every POST
passes Verse's dispatch and mutation-token gates. A grant action names the
digest of a draft the server served; the server signs exactly that draft.

## Phase 0: `ashlr authority setup`

One guided command that asks before every step and prints what it did. It
never runs `sudo` and never touches launchd.

1. Checks the custody helper; if it is missing, it tells you to run
   `sudo scripts/install-custody.sh` and stops.
2. Creates the Secure Enclave key (Touch ID).
3. Opens a PR in your ashlr-hub checkout (from a throwaway worktree — your
   checkout is untouched) adding the key to `trust-roots.ts`, then waits for
   you to merge it, build, install the release and kickstart the daemon.
4. Creates the `ashlr-fleet` GitHub App through the App Manifest flow (one
   browser page). The private key goes straight into custody; it is never
   written to disk or printed. Installing the App on the repos is one more
   page.
5. Stores a Claude token for restricted judge and Leader calls (hidden input).
6. Applies the default-branch rulesets (`protect --apply`).
7. Creates `ashlrai/fleet-canary` with a CI workflow, using your own gh auth
   (the App cannot write workflows).
8. Moves `~/.ashlr/activation` out of `~/.ashlr` for you to archive offline.
9. Rotates the provenance HMAC key.
10. Signs the first grant (Touch ID) and, if you agree, sets the switch to
    Autonomous — the ladder starts in shadow.

## Rulesets

`ashlr authority protect` builds one ruleset per server-enforced repo:
required status checks (the check runs CI reports on the default branch
today), no force-push, no deletion, changes through pull requests with
code-owner review on the paths in `.github/CODEOWNERS`. The **repository
admin role (you) may bypass it; the ashlr-fleet App may not.** Private
free-plan repos cannot have rulesets and are enforced by the daemon's own
gates at the local-enforcement ceilings.

## Residual risks

The residual risks are listed in one place, [AUTHORITY.md §6](AUTHORITY.md#6-residual-risks-read-before-activating),
so the list cannot drift between two documents.
