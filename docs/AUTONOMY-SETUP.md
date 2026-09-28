# Autonomy setup

> Moved from the top-level [README](../README.md) to keep the README short. Content is unchanged apart from link paths.

## Autonomy commissioning path

**Current release status (3.15):** `ashlr authority setup` is a resumable preparation
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
code changes; until then the resident daemon parks without working. 3.15
changes authority code, so after installing it run `ashlr authority re-approve`,
then `ashlr authority resident stop` and `start` to put the daemon on the new
build.

**Where it stands.** On the maintainer's Mac a standing grant is active and the
rollout ladder is at stage 1 of 8, shadow: the gates run and record
would-merges, and no repository merges yet. Command shows the ladder and grant
countdown; Fleet lists every shadow decision with its G0–G7 chips. Private
repositories on GitHub's free plan, which cannot have rulesets, use local
enforcement with the App's host-verified `ashlr/verify` check. Dated details:
[AUTONOMY-GAP.md](AUTONOMY-GAP.md#current-activation-state-315).

**What a grant allows.** A standing grant names the repositories, engines, risk
and size caps, spend ceiling and Leader classes, and is valid for at most 30
days. Effective policy is the minimum of the grant, the config and compiled
ceilings (medium risk, 10 files / 300 lines, 24 merges per repo per day).
Lowering never asks: the switch (Off, Propose, Autonomous) goes down instantly,
**Stop** writes `~/.ashlr/KILL`, and **Revoke** needs a new grant to resume.
Every merge happens on GitHub, pinned to the head SHA, after the gates and a
judge from a different model family. CI and a fresh re-run watch it for two
hours, and a red merge is reverted automatically. The full model is in
[`docs/STANDING-AUTHORITY.md`](https://github.com/ashlrai/ashlr-hub/blob/master/docs/STANDING-AUTHORITY.md).

**Budget modes** decide how much of each seat autonomy may use. They are set in
`~/.ashlr/budget.json` and from the budget pill on Command. Under **balanced**
(the default), Claude keeps 40 % of its weekly window for you, and autonomy
never uses it while its five-hour window is above 70 %. Grok keeps no reserve.
Local models are free and unlimited. **all-in** drops the reserves, and
**reserve** keeps 85 % of every paid window for you. Codex is off for autonomy
until you switch it on. A seat whose usage cannot be read is never eligible.
Your own chats ignore reserves.
