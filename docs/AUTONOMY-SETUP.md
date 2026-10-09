# Autonomy setup

> Moved from the top-level [README](../README.md) to keep the README short.

## Autonomy commissioning path

**Setup and runtime behavior:** `ashlr authority setup` is a resumable preparation
workflow. Its dry run is read-only; a live run can create custody, GitHub and
grant state after your explicit actions. Setup itself never installs or restarts
the daemon. The legacy service paths (`ashlr daemon install`, `ashlr setup`,
`worker setup`, `update`) remain temporarily unavailable for install, reinstall, repair and restart and support status and uninstall only; the permit-based compiled daemon and conductor trust roots are empty.
The resident runtime instead runs under your **standing grant**
([docs/RESIDENT-RUNTIME.md](RESIDENT-RUNTIME.md)): with a Touch-ID-signed
grant active, `ashlr authority resident start`, typed by you in your own
terminal, installs `ai.ashlr.daemon` from a clean release with its plist
regenerated from config. Every tick re-verifies the grant, Stop and the switch.

Autonomy ships **dormant**: nothing runs until your custody key is compiled in,
you sign a grant, and you start the resident service yourself.

```sh
ashlr authority setup --dry-run   # print every step and what it would do
ashlr authority setup --dry-run --json  # machine-readable checklist and runtime block
# ashlr authority setup           # live preparatory steps require your explicit actions
ashlr authority status            # grant, switch, Stop, rollout stage, ledger, custody
```

`setup` performs each available step and pauses for the steps marked ✋. Its
last step reports the resident runtime: in place, waiting on the exact command,
or blocked on a missing prerequisite. Rerunning it is safe: whatever is already
in place is reported `already` and left alone (the provenance key is rotated
only once). Verse shows the same checklist, with the next step's command to
copy.

1. ✋ **Install the custody helper:** `sudo scripts/install-custody.sh`
   (root-owned, in `/usr/local/libexec/`).
2. ✋ **Create the Secure Enclave key** (Touch ID). The private key never leaves
   this Mac's Secure Enclave.
3. ✋ **Compile the public key in.** Setup opens a PR adding it to
   `src/core/authority/trust-roots.ts`. You merge it, run `npm run build`,
   install the release as usual and restart the daemon.
4. ✋ **Create the `ashlr-fleet` GitHub App** (one browser page) and **install
   it** on the enrolled repos (one more click). Its private key goes straight
   into the custody Keychain item; the PEM never touches disk.
5. ✋ **Store a Claude token:** run `claude setup-token` and paste it when
   asked. Only tool-less judge and Leader calls ever see it.
6. **Apply the rulesets** (`ashlr authority protect --print`, then `--apply`):
   required checks, no force-push or deletion, and bypass for your admin role
   but never for the App.
7. **Create the canary** repository `fleet-canary` with its CI workflow, using
   your own `gh` login (the App cannot write workflows).
8. ✋ **Retire the old key.** Confirm moving `~/.ashlr/activation/` out of
   `~/.ashlr`; archive it offline, then delete it.
9. **Rotate the provenance HMAC key** (`ashlr authority rotate-provenance`).
10. ✋ **Sign the first grant** (Touch ID) and, optionally, set the switch to
    Autonomous. The grant starts on the shadow stage of its rollout ladder.
11. ✋ **Start the resident daemon** in your own terminal:
    `ashlr authority resident start`. It refuses agents, a dirty build, Stop,
    the switch at Off and an inactive grant, shows the release, plist and daily
    budget, and asks you to confirm. `ashlr authority resident status` shows
    drift after a config change; `ashlr authority resident stop` removes the
    service.

Standing grants require Touch ID reapproval every 30 days or after authority
code changes; until then the resident daemon parks without working. 3.16
changes authority code, so after installing it run `ashlr authority re-approve`,
then `ashlr authority resident stop` and `start` to put the daemon on the new
build.

**Where to check.** `ashlr authority status` and `ashlr authority resident status`
report this Mac's live grant, switch, rollout stage, and daemon state. A new
grant begins in shadow, recording would-merges without merging. Command shows
the ladder and grant countdown; Fleet lists shadow decisions with their G0–G7
chips. Private
repositories on GitHub's free plan, which cannot have rulesets, use local
enforcement with the App's host-verified `ashlr/verify` check. Dated details:
[AUTONOMY-GAP.md](AUTONOMY-GAP.md#current-activation-state-315).

**What a grant allows.** A standing grant names the repositories, engines, risk
and size caps, spend ceiling and Leader classes, and is valid for at most 30
days. Effective policy is the minimum of the grant, the config and compiled
risk ceilings. Legacy grants keep 10 files / 300 lines / 24 merges per repo per day and smaller local limits. Explicit volume edits can sign larger limits or No volume cap using `merge.volumePolicy: "operator-signed"`; plain renewal does not widen an existing grant. Signing the new marker requires an upgraded root-owned custody helper.
Lowering never asks: the switch (Off, Propose, Autonomous) goes down instantly,
**Stop** writes `~/.ashlr/KILL`, and **Revoke** needs a new grant to resume.
Every merge happens on GitHub, pinned to the head SHA, after the gates. Ordinary lanes require a judge from a different model family; an explicitly eligible `elite-direct` lane skips that separate judge. CI and a fresh re-run watch it for two
hours, and a red merge is reverted automatically. The full model is in
[`docs/STANDING-AUTHORITY.md`](https://github.com/ashlrai/ashlr-hub/blob/master/docs/STANDING-AUTHORITY.md).

**Budget modes** decide how much of each seat autonomy may use. They are set in
`~/.ashlr/budget.json` and from the budget pill on Command. Under **balanced**
(the default), Claude keeps 40 % of its weekly window for you, and autonomy
never uses it while its five-hour window is above 70 %. Grok keeps no reserve.
Local models incur no provider token charges; available hardware determines their capacity. **all-in** drops the budget preference reserves, while signed account floors and session ceilings still apply.
**reserve** keeps 85 % of every paid window for you. Balanced mode enables
eligible included Codex allowance; stored per-account Off settings still apply. A seat whose usage cannot be read is never eligible.
Your own chats ignore reserves.


**Account scope in 3.18.** The grant editor shows only the accounts listed by
this server. Choose whether each can work autonomously, its permitted roles,
its reserve floor (0–100%) and an optional session ceiling (1–100%). No session
ceiling removes that signed ceiling. All-in alone does not erase these fields.
Review the complete preview before Touch ID approval; new edits disable approval
until their preview succeeds. Untouched account fields and ordinary renewals
preserve the existing scope. Native Devin supports Leader and producer roles. Role
permission does not establish provider support; Apps & Accounts and Resources
show the separate budget preferences and actual readiness.

**Cash exhaustion.** When a positive daily daemon USD allowance is exhausted,
resident work with a proven zero-dollar final execution path can continue on the
normal cadence. The recorded spend and original ceiling remain intact. Metered
or unknown-cost routes, unproven model checks and unresolved spend journals
still wait; a daily USD setting of 0 still stops the loop. Hosted Devin uses
separate ACU admission and accounting, which remain binding. This behavior does
not bypass subscription usage windows, signed reserves or local serving capacity.
The Devin CLI is excluded from this exhausted-USD exception: its static SWE-2
model allowlist does not establish fresh account-specific zero pricing. Its
existing positive-budget admission remains unchanged. Qualify current account
pricing before enabling the lane; an installed model or credential file is not
that evidence. See [Devin](DEVIN.md#how-it-works).
