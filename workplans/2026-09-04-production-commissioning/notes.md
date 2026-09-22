# Notes: Agent OS production commissioning

## Starting evidence

- Repository: `/Users/masonwyatt/Desktop/github/dev-tools/ashlr-hub`
- Branch: `codex/v333-iteration`
- Starting HEAD: `6d1bf2fe8a237343681049043ec50fa1b6bf307f`
- Worktree: extensively dirty and untracked from concurrent Agent OS work; ownership must be resolved before staging.
- Entire: enabled in manual-commit mode with no current checkpoint.
- Previous M550-M564 tranche: source-complete and lane-verified, but uncommitted, uncommissioned, and inactive.

## Production evidence log

- `origin/master` is `d6c1a5ec` (merged PR #327). Current `HEAD` is 11 commits behind and 14 commits ahead of that protected branch; it is 8 commits ahead of `origin/codex/v333-iteration` and has no open or historical PR under the current head name.
- `master` protection is strict, admin-enforced, disallows force-push/deletion, and requires ten named GitHub Actions checks across Windows, macOS, Ubuntu, dependency audit, and Windows service authority.
- GitHub CLI is authenticated as the repository owner account with repository/workflow scope. This establishes API access, not passing checks or merge authorization.
- GitHub releases currently show prerelease `v3.3.0`; latest stable is `v3.0.0`. Current source package version is `3.3.0`.
- npm registry identity check returned `E401 Unauthorized`; direct npm publication cannot currently be performed from this shell. Trusted GitHub publication remains to be inspected.
- Installed CLI is immutable release `18a60269037009d20162f3339236af35221e25d2`, reports version `3.1.0`, and is symlinked through `~/.local/share/ashlr/current`.
- LaunchAgent `ai.ashlr.daemon` exists and points at the dirty development checkout's `bin/ashlr`, not the immutable installed release. It is registered without a live PID. Hub reports the daemon stopped with stale activity from 2026-09-01.
- Current source reports `activation-permit-inspection-failed`, `residentAuthorized=false`, and `residentStandingAuthorized=false`. Starting a resident is therefore not currently admitted.
- Current fleet config is executable with auto-merge enabled, but protected-remote evidence is missing, so the only pending proposal is blocked. Eighteen active goals exist and thirteen are visible as locked work; this must be reconciled before unattended activation.
- Available model capacity is observable for local Ollama, Claude, Codex, and Kimi. NIM credentials are unavailable. Availability observations do not establish execution authentication or acceptance.
- No Docker, Podman, Colima, or Lima executable is installed. `/usr/bin/sandbox-exec` exists, but the existing M562b audit showed the current profile is not an authenticated deny-default backend and cannot support an `enforced` claim.
- The first formal serial `test:ci` run hit 900 seconds. A second hit 1,800 seconds after completing the full real-I/O lane and part of the unit lane. The unit project independently passed in its configured four-worker mode; CI splitting/budget correction remains a release-gate task.
