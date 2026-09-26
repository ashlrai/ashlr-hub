# Resident runtime under the operator's standing grant

Status: design + implementation notes for `authority-resident-runtime`
(2026-09-26). Line numbers are against `origin/master` at `13f8f788` unless a
section says otherwise.

This document answers four questions:

- (a) which authority system the resident daemon actually consults
- (b) what the "compiled daemon and conductor roots" are
- (c) what the "native resident-start broker" was meant to be
- (d) the smallest safe design that lets a Touch-ID-signed standing grant run
  the resident daemon and conductor unattended

---

## (a) Two authority systems, and which one the daemon consults

### A. Activation permits (pre-3.10, one-shot, now inert)

Signed Ed25519 permit files are verified against **compiled** root arrays. No
file, environment variable or flag can add a root.

- `src/core/daemon/activation-permit.ts:201`: `DAEMON_ACTIVATION_TRUST_ROOTS = Object.freeze([])`.
- `activation-permit.ts:1090-1099`: `needsPermit` / `supportedProposalOnceShape`.
  A permit can only authorize `--once`, non-dry, no-drain runs. Continuous
  (resident) mode is refused structurally, with
  `activation-permit-cannot-authorize-requested-start-shape` at `:1116-1121`,
  before roots are even consulted (`no-trusted-activation-roots` at `:1122-1123`).
- `activation-permit.ts:546`: permits bind a build identity that must be clean
  (`validBuildIdentity`, `:373`).
- `activation-permit.ts:1476`: `GOAL_CONDUCTOR_ACTIVATION_TRUST_ROOTS = Object.freeze([])`.
  These are consumed only by the explicit `ashlr loop --goal <id>` path:
  `runAuthorizedConductorOnce` (`src/core/goals/conductor.ts:244`) calls
  `consumeGoalConductorActivationPermit` (`activation-permit.ts:1882`).
- The `ashlr activation init / grant install conductor / grant residentStanding`
  commands from the August runbook were deleted by the hostile-review
  neutralization (`a3f18a35`, 2026-08-18). The burned `mason-workstation`
  ed25519 key is on `BURNED_KEY_IDS` (`src/core/authority/trust-roots.ts:35`).

### B. Standing grants (3.10, custody-grade)

A `StandingGrantV1` (`src/core/authority/types.ts:220-242`) is signed with ES256
by the Secure Enclave key behind Touch ID (`tools/custody`). It is verified
against `STANDING_GRANT_TRUST_ROOTS` (`src/core/authority/trust-roots.ts:28`),
which is empty until PR #506 adds `se-p256-9c1330e3bd72cf3e`.

Verification happens in `evaluateStandingAuthority`
(`src/core/authority/effective-config.ts:436-570`) and covers:

- signature, expiry and host binding
- revocation and sequence rollback against the ledger
- authority-surface digest of the running release
- ledger chain
- KILL, the switch and OS confinement

### What the daemon loop consults today: B first, A only as fallback

`runDaemon`, in `src/core/daemon/loop.ts`, runs these steps at startup:

1. `:9194`: `openStandingRunForDaemon(cfg)` (defined at `:9032`). This calls
   `openStandingSession` (`src/core/authority/capability.ts:63`), which runs a
   **fresh** `evaluateStandingAuthority({surface:'running'})`.
2. `:9215-9233`: under a grant, the run is narrowed to the autonomous lane (fleet
   mirrors only). If that fails, it refuses.
3. `:9235-9237`: **if a standing session opened, A is never consulted.**
   Otherwise `consumeDaemonActivationPermit` runs, and it refuses every
   continuous start (see A).

Every tick then does the following:

- `:9687`: KILL breaks the loop.
- `:9746`: a pause parks it.
- `:9800-9829`: `standing.mint()` → `mintStandingTickCapability` (`capability.ts:118`)
  → `mintResidentStandingCapability` (`activation-permit.ts:255`) re-verifies
  **everything** from scratch and mints a single-use capability. On refusal the
  loop *parks* rather than exits, and it resumes when authority returns.
- `:3897-3913`: `tick()` refuses without a valid capability
  (`isDaemonActivationCapability`, `activation-permit.ts:220`). The claim-time
  check (`:280-284`) re-reads expiry, KILL and the live grant id.
- `:4867-4892`: the daily budget. The resident loop re-reads `config.json` every
  tick (`reloadLiveConfigForDaemon`, `:1529`; used at `:9772`), so the per-tick
  cap is `daemon.dailyBudgetUsd` from config.

**Conclusion:** once PR #506 compiles Mason's custody key in, a Touch-ID-signed
grant is already enough for `runDaemon` to run resident standing ticks. The same
goes for the conductors: `liveConductorActivationAuthorized()`
(`activation-permit.ts:295-301`) returns `currentStandingPolicy()?.conductorGoals === true`.
It is consumed by `goals/conductor.ts:114` and `simple-conductor.ts:168`.

What does **not** exist is a way to put that daemon under launchd so it
survives logout and reboot:

- `assertResidentServiceInstallAuthorized()` throws unconditionally
  (`src/core/daemon/service-install-authority.ts:14-16`).
- It is called first by `service.install` (`src/core/daemon/service.ts:1422-1424`),
  `service.ensureRunning` (`:1954-1956`), `ashlr daemon install`
  (`src/cli/daemon.ts:1402`), `ashlr setup`, onboarding, `worker setup`,
  `dashboard` and `update`.
- `ashlr authority setup` hard-codes the resident step to `blocked`
  (`src/cli/authority.ts:921-922`, `:978-983`). Its daemon-service step says
  "this build cannot install or start one" (`:1186-1197`).

That gap is what this change closes.

## (b) "Compiled daemon and conductor roots"

The phrase refers to the empty, source-frozen key arrays of system A (plus the
M520/M521 runtime-activation families):

| Constant | Where | Key type | Consumer |
| --- | --- | --- | --- |
| `DAEMON_ACTIVATION_TRUST_ROOTS` | `daemon/activation-permit.ts:201` | Ed25519 SPKI | one-shot `--once` proposal permits |
| `GOAL_CONDUCTOR_ACTIVATION_TRUST_ROOTS` | `daemon/activation-permit.ts:1476` | Ed25519 SPKI | `ashlr loop --goal <id>` one-shot permits |
| `RUNTIME_ACTIVATION_RESIDENT_START_TRUST_ROOTS` | `daemon/runtime-activation-resident-start-runtime.ts:14` | Ed25519 SPKI with a validity window | M521 resident-start permits (no consumer) |
| `RUNTIME_ACTIVATION_STOPPED_CONSUMER_TRUST_ROOTS` (+ v2) | `daemon/runtime-activation-stopped-runtime.ts:44`, `…-v2-runtime.ts:14` | Ed25519 | M520/M568 release-pointer swaps |

Each expects an operator Ed25519 public key committed in source. The operator
signed with the private half from a file (`~/.ashlr/control/activation/…`).
That custody model was burned in August: a 0600 file is readable by every
unconfined agent. The 3.10 custody model replaces it with a non-exportable
Secure Enclave key whose every signature needs Touch ID. **No new root family is
needed.** The standing-grant root *is* the operator root, and system B already
authorizes both the resident daemon and the conductors. This change therefore
leaves every array in the table empty and adds no new root.

## (c) The "native resident-start broker"

History (`git log -S "resident-start"`) covers four pieces:

- **M521**, `7a5fc597`, `docs/contracts/CONTRACT-M521.md`: a 120-second
  Ed25519 resident-start permit. It binds the candidate release, service
  descriptor, config digest, prior launchd state and a broker challenge, plus a
  broker-authenticated acknowledgement (PID, audit token, code identity,
  launchd job generation).
- **M569**, `72191fe9`, `desktop/src-tauri/src/native_launchd_broker.rs`: a
  dormant Rust foundation (frames, `openat` custody, journal) with every
  authority bit false.
- **M520/M568**: cooperative release-pointer swaps.
- **`9b5d137e`** (#496) added `RESIDENT_RUNTIME_BLOCK` to report all of the
  above honestly.

The broker was to be a separately installed, code-signed, privileged native
helper behind XPC. It would own trusted monotonic time, external replay
consumption, a kernel-level conditional old-inode pointer exchange, and
audit-token/code-signature identity of the started process. Its purpose was to
defeat a **hostile process running as the same UID** that races the release
pointer or the plist between verification and launch. CONTRACT-M521 says so
explicitly: "An unprivileged helper under the same UID cannot exclude a hostile
same-UID process". The broker never shipped because none of those native pieces
exist. The unmerged `codex/production-activation-readiness-v1`,
`codex/resident-service-readiness-admission-v1` and
`codex/activation-authority-v2` branches are observation-only and add no broker.

**Why this change does not build that broker.** The 3.10 model already answers
the same-UID threat differently:

1. **Autonomous agents are not same-UID peers in practice.** Every fleet agent
   runs under forced macOS confinement (`src/core/sandbox/confine.ts`). The
   profile denies exec of `/bin/launchctl` and the custody helper, denies writes
   to `~/Library/LaunchAgents`, and denies reads of `~/.ashlr/authority` and the
   custody directory (`confine.ts:72-82`, `:542`, `:557`). A standing policy
   refuses to exist without confinement (`effective-config.ts:532-535`).
2. **Authority cannot be minted by anyone who can race the plist.** It lives in
   a grant signed by the Secure Enclave under Touch ID. Whatever process
   launchd starts, that process can only act within the grant, and it
   re-verifies the grant, the authority surface of the code it is running, KILL
   and the switch on every tick.
3. **The build is pinned.** The grant pins the authority-surface digest of the
   release (`types.ts:232`), so swapped authority code runs under no grant.

The residual risk is an **unconfined** same-UID process, such as Mason's own
interactive Claude Code or Codex sessions. Such a process could start the
service. It could equally run `ashlr daemon start` in the foreground today, and
in both cases it only gets the daemon Mason already authorized. It cannot mint,
extend or widen authority, because that needs the Secure Enclave. The native
broker would narrow this residual risk further. It remains a possible future
hardening, not a prerequisite. This trade was decided by Mason's 2026-09-24
autonomy mandate (full merge autonomy with automated guardrails, custody key as
the root) and his "build it all" approval for this change.

## (d) Design: resident admission under the standing grant

### Root and authority

The only root is the custody key in `STANDING_GRANT_TRUST_ROOTS`. **Resident
admission** is a pure verdict over fresh observations. It is `admitted` only
when all of the following hold:

| # | Condition | Source | If not |
| --- | --- | --- | --- |
| 1 | macOS | `process.platform` | `blocked`: custody and launchd are macOS-only |
| 2 | The CLI is a compiled release (not tsx source) | `runningPackageRoot()` (`surface.ts:353`) | `blocked`: run the installed `ashlr` |
| 3 | The release's build identity is clean: git provenance with `dirty === false`, or CI provenance | `readBuildIdentity()` (`src/core/build-identity.ts:57`) | `blocked`: commit, `npm run build`, reinstall |
| 4 | A standing grant is **active**, verified fresh against the running release's surface | `evaluateStandingAuthority({mode:'fresh', surface:'running'})` | `blocked`: `ashlr authority grant` (Touch ID) |
| 5 | KILL is off | same evaluation | `waiting-on-you`: `ashlr authority clear-stop` |
| 6 | The effective switch is not Off, and a policy is in force (confinement and config readable) | same evaluation | `waiting-on-you` (switch) or `blocked` (no confinement / config) |

Condition 4 is where the operator's **Touch ID** enters. The grant is the
Touch-ID-signed, 30-day-bounded, host-bound, surface-bound authorization for
resident work, which is what "standing" means. `resident start` does not ask
for a second Touch ID. The custody helper has no presence-only verb:
`sign-grant` is its only Touch-ID signature (`tools/custody/Sources/CustodyCore/Commands.swift:107`).
Adding a verb would force a helper reinstall with `sudo`, and ad-hoc re-signing
re-prompts the Keychain for the stored GitHub App key and Claude token
(`scripts/install-custody.sh:9-13`). A per-start signature would also only mean
something if `runDaemon` enforced it. That is listed as optional hardening
below, not built here.

### Effects: `ashlr authority resident start | stop | status`

**`start`** is the only path that installs or restarts the service. It refuses
unless all of the following hold, in this order:

1. The operator context is interactive:
   - stdin and stdout are TTYs
   - no `ASHLR_IN_DAEMON` or `ASHLR_IN_SWARM`
   - no agent-harness marker (`CLAUDECODE`, `CODEX_SANDBOX`, `CODEX_SANDBOX_NETWORK_DISABLED`)
   - `$HOME` equals the password-database home (autonomous runs get an
     ephemeral `HOME`)

   There is no `--yes`. Mason confirms in the terminal after seeing the grant,
   release, plist target and budget.
2. The admission verdict above is `admitted`.
3. `mintResidentServiceCapability` in `src/core/authority/resident.ts`
   re-verifies 1-2 itself and returns a **single-use, WeakMap-branded**
   capability bound to the grant id. This is the same pattern as
   `activation-permit.ts:208-232`, so a structurally forged object is refused.
   At claim time the capability re-checks expiry, KILL and the live grant.
4. `service.installResidentService(opts, capability)` claims the capability
   *before* any mutation. It then runs the existing transactional launchd
   install inside the lifecycle fence: write plist, `launchctl enable`,
   `bootstrap`, verify, rollback on failure (`service.ts:1426-1520`).
   `RunAtLoad` starts it.
5. It appends a ledger note (`resident-service:started`) recording the grant,
   release revision, plist digest and budget.

The legacy `install` / `ensureRunning` / `ashlr daemon install` /
`setup` / `worker` / `dashboard` / `update` paths keep calling
`assertResidentServiceInstallAuthorized()`, which still throws. **No existing
gate is weakened.**

**`stop`** is a lowering action: it uses the existing, authority-free
transactional `uninstall` (bootout and remove plist) and asks nothing. It does
not engage KILL; `ashlr authority stop` does that.

**`status [--json]`** is read-only. It reports:

- the admission verdict
- launchd state
- whether the installed plist equals the one `start` would write now, i.e.
  **drift**, including a budget changed in config since install

### Plist budget

The plist is regenerated from `config.json` (`daemonServiceInstallOptions`,
`src/core/daemon/service-config.ts`) on **every** `resident start`, and `status`
and `setup` compare it byte-for-byte with the installed file. This closes the
August "hard-coded `--budget`" trap. Changing `daemon.dailyBudgetUsd` now shows
up as `waiting-on-you: ashlr authority resident start` until the service is
regenerated.

Note that the continuous loop already re-reads config each tick (see (a)). The
plist flag only feeds the start-time spend-guard recovery and the startup log
line, which is exactly the mismatch the runbook observed.

### `ashlr authority setup`, resident step

- `already`: all of the following hold:
  - the admission verdict is `admitted`
  - `ai.ashlr.daemon` is running
  - the installed plist equals the regenerated one
- `waiting-on-you` + exact command:
  - `ashlr authority resident start` when admitted but not running or drifted
  - `ashlr authority clear-stop` when KILL is on
  - `ashlr authority switch …` when the switch is Off
- `blocked`: only for missing prerequisites (no or inactive grant, not a
  compiled release, dirty build, no confinement, not macOS). The dry-run
  planning path and early exits still report the step exactly once, as
  `blocked: needs an active standing grant first`.
- Setup itself still never touches launchd. It prints the command.

### Unchanged invariants

- **Agents cannot mint or extend authority.** Only `custody sign-grant` (Touch
  ID) raises it. `resident start` writes no grant, never raises the switch and
  never edits config.
- **Build identity binding.** A dirty or unknown build is refused.
- **KILL, pause and budget** are honored every tick exactly as before (`loop.ts`
  is untouched).
- **Post-merge watch/revert, merge gates and the shadow-first rollout ladder**
  are untouched. The grant still starts at its first (shadow) stage.
- **Empty roots stay empty.** The permit and M52x root arrays in (b) are
  unchanged.

### Tier-1

- `src/core/authority/resident.ts` is under `src/core/authority/**`, so it is
  already Tier-1 and in the authority surface.
- `src/core/daemon/service.ts`, `service-install-authority.ts` and
  `service-config.ts` decide what launchd runs, and are added to
  `TIER1_SOURCE_PATTERNS`. They were already inside the Tier-1 import closure.
- CODEOWNERS and `test/fixtures/authority/tier1-closure.json` are regenerated in
  a separate commit.

### Optional future hardening (not built)

1. A custody `approve-resident` verb. It would be a Touch-ID signature over
   `{grantId, release revision, plist digest, nonce, expiry}` that
   `openStandingSession` requires. That would make an unconfined same-UID
   process unable to start a resident session at all. It costs a helper
   reinstall (`sudo`) and, with ad-hoc signing, re-storing the Keychain secrets.
2. The M521/M569 native broker, which excludes hostile same-UID processes from
   the release pointer.
3. A resident conductor service. Goals are still advanced by `ashlr loop`
   (foreground). Under a grant with `conductorGoals: true`, that loop now runs
   live.
