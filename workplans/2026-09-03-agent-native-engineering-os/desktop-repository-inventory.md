# Ashlr desktop repository inventory and recoverable consolidation plan

Snapshot: 2026-09-03 15:08 EDT. Scope: `/Users/masonwyatt/Desktop`, searched to a practical maximum depth of seven while pruning `.git`, `node_modules`, `target`, `dist`, `.next`, and `Library` traversal. Repository identity was read from Git; no secrets, file contents, remotes, branches, worktrees, or filesystem locations were changed.

This is an inventory, not cleanup authorization. Counts are `tracked changes / individual untracked files`, not the shorter number of `??` directory entries. The repositories are actively being used, so counts and HEADs are point-in-time evidence and must be regenerated immediately before any consolidation action.

## Decision summary: one canonical Desktop folder per product

| Product | Canonical Desktop folder | Decision |
| --- | --- | --- |
| Ashlr Hub | `/Users/masonwyatt/Desktop/github/dev-tools/ashlr-hub` | Keep. It is the primary Git worktree and the only Hub repository found on Desktop. |
| Ashlr Cortex | `/Users/masonwyatt/Desktop/github/dev-tools/ashlr-cortex` | Keep. `/Users/masonwyatt/Desktop/cortex`, although present in stale workspace configuration, does not exist. |
| Ashlr Plugin | `/Users/masonwyatt/Desktop/github/dev-tools/ashlr-plugin` | Keep as primary. Preserve the verify-contract and Claude linked worktrees as worktrees, not duplicate repos. |
| Core Efficiency | `/Users/masonwyatt/Desktop/github/dev-tools/ashlr-core-efficiency` | Keep. Normalize remote ownership deliberately later; `origin` and the additional `ashlrai` remote currently point to different GitHub owners. |
| Stack | `/Users/masonwyatt/Desktop/github/dev-tools/stack` | Keep. Repository name is `ashlr-stack` on GitHub. |
| Phantom | `/Users/masonwyatt/Desktop/github/dev-tools/phantom-secrets` | Keep. `homebrew-phantom` is separate release infrastructure, not a duplicate product checkout. |
| Locus | `/Users/masonwyatt/Desktop/github/dev-tools/locus` | Keep. `homebrew-ashlr-locus-v020` is separate release infrastructure. |
| MMCP | None observed | `/Users/masonwyatt/Desktop/mmcp` does not exist, and no exact `mmcp` directory was found on Desktop. Do not manufacture a replacement until its authoritative GitHub repository or backup is identified. If it remains a product, the eventual canonical location should be `/Users/masonwyatt/Desktop/github/dev-tools/mmcp`. |
| wrkpad | `/Users/masonwyatt/Desktop/work louder board/wrkpad` | Keep as primary. The three sibling folders are valid linked worktrees. `/Users/masonwyatt/Desktop/work louder board/app` is a separate, dirty, no-remote repository and is not safe to call redundant. |

No second Hub or Cortex Git root was found. Directories under `.git/worktrees`, application-level `.cortex` folders, documentation folders, package-manager installations, crate directories, and generated site output are not product duplicates.

## Primary repositories and visible Desktop worktrees

| Path | Origin | Branch / HEAD | Dirty / untracked | Git/worktree identity | Approx. size | Classification |
| --- | --- | --- | ---: | --- | ---: | --- |
| `/Users/masonwyatt/Desktop/github/dev-tools/ashlr-hub` | `https://github.com/ashlrai/ashlr-hub.git` | `codex/v333-iteration` / `6d1bf2fe8a237343681049043ec50fa1b6bf307f` | 21 / 66 | Primary; common dir is its own `.git`; 11 registered worktrees, all paths present | 1.1G | Canonical, active and dirty |
| `/Users/masonwyatt/Desktop/github/dev-tools/ashlr-core-efficiency` | `https://github.com/masonwyatt23/ashlr-core-efficiency.git`; secondary `ashlrai` remote is `https://github.com/ashlrai/ashlr-core-efficiency.git` | `codex/core-efficiency-verify-contract` / `d5c2d8e84b4d9042131f149707575042683c819d` | 3 / 55 | Primary; one registered worktree | 85M | Canonical, active and dirty; remote-owner decision outstanding |
| `/Users/masonwyatt/Desktop/github/dev-tools/ashlr-cortex` | `https://github.com/ashlrai/ashlr-cortex.git` | `main` / `f4aa45b09d7faeae793658568e38e3e7c07d47bf` | 0 / 1 | Primary; one registered worktree | 837M | Canonical; one local-only file |
| `/Users/masonwyatt/Desktop/github/dev-tools/ashlr-plugin` | `https://github.com/ashlrai/ashlr-plugin.git` | `main` / `f96ac3eee90e5f18aed3c91c0d706a94c82275eb` | 24 / 2 | Primary; nine registered worktrees, all paths present | 5.8G | Canonical, active and dirty |
| `/Users/masonwyatt/Desktop/github/dev-tools/ashlr-plugin-verify-contract` | same Plugin origin | `codex/plugin-verify-contract` / `35390871bf428b1229ebe5dcc9a2838737a1d429` | 0 / 0 | Linked to Plugin common dir; reciprocal `.git` links valid | 1.4G | Valid clean worktree, not a duplicate |
| `/Users/masonwyatt/Desktop/github/dev-tools/stack` | `https://github.com/ashlrai/ashlr-stack.git` | `codex/stack-verify-manifest` / `fe709ad8b6c487ca0510a1fdef9f2a4ab8751797` | 23 / 11 | Primary; second worktree at `/Users/masonwyatt/.ashlr/worktrees/stack/observation-contract-v1` | 731M | Canonical, active and dirty |
| `/Users/masonwyatt/Desktop/github/dev-tools/phantom-secrets` | `https://github.com/ashlrai/phantom-secrets.git` | `docs/accuracy-fixes` / `b3672b4806569249217be2d3c68d8bd75eccffe8` | 136 / 90 | Primary; 29 registered worktrees, all paths present | 77G | Canonical, heavily active and dirty; size is dominated by local/build state and must not be treated as disposable |
| `/Users/masonwyatt/Desktop/github/dev-tools/homebrew-phantom` | `https://github.com/ashlrai/homebrew-phantom.git` | `main` / `1ef0562f3a1f01b55d4a6fb395d661a755a88a83` | 0 / 0 | Primary; one additional external worktree | 456K | Independent Phantom distribution repo |
| `/Users/masonwyatt/Desktop/github/dev-tools/locus` | `https://github.com/ashlrai/locus.git` | `main` / `8c6cfae47d8b71e6376b19b160de3dee0acc4c2a` | 0 / 2 | Primary; one registered worktree | 17M | Canonical; two local-only files |
| `/Users/masonwyatt/Desktop/github/dev-tools/homebrew-ashlr-locus-v020` | `https://github.com/ashlrai/homebrew-ashlr.git` | `codex/locus-v020-formula` / `de856eaf01db96fae7ebcff8268e7af0bed9c80e` | 0 / 0 | Independent primary checkout; one registered worktree | 172K | Locus distribution work, not a product duplicate |
| `/Users/masonwyatt/Desktop/work louder board/wrkpad` | `https://github.com/ashlrai/wrkpad.git` | `codex/creator-micro-physical-recovery` / `1e80a975904b5a4cd9e439d9f50897260eb22445` | 0 / 0 | Primary; four registered Desktop worktrees, all reciprocal links valid | 2.5G | Canonical primary |
| `/Users/masonwyatt/Desktop/work louder board/wrkpad-control-deck-v2` | same wrkpad origin | `codex/control-deck-v2` / `6d639392999f6097ba3ead5ec3da3d64f8a005ea` | 23 / 2 | Linked to wrkpad common dir; reciprocal `.git` links valid | 2.9G | Valid active dirty worktree, not a duplicate |
| `/Users/masonwyatt/Desktop/work louder board/wrkpad-native-acceptance` | same wrkpad origin | `codex/native-acceptance-handoff` / `9112aaf29720e2240112125fc628e2f97c47f1f5` | 0 / 0 | Linked to wrkpad common dir; reciprocal `.git` links valid | 2.4G | Valid clean worktree, not a duplicate |
| `/Users/masonwyatt/Desktop/work louder board/wrkpad-public-site` | same wrkpad origin | `codex/public-site` / `dce8a60e690e6482a4311c3bf83b996356c044de` | 0 / 0 | Linked to wrkpad common dir; reciprocal `.git` links valid | 3.9M | Valid clean worktree, not a duplicate |
| `/Users/masonwyatt/Desktop/work louder board/app` | no remotes configured | `main` / `7bc3a9a9f24680a243108db58de890084846c345` | 5 / 0 | Independent Git root, not registered with wrkpad | 586M | Probable legacy/prototype work, but unique and dirty; preserve until reconciled |

The large worktree counts are real Git topology, not duplicate-folder evidence: Hub has nine Codex worktrees plus one installed-release worktree outside Desktop; Phantom has one temporary release-source worktree and 27 Codex worktrees outside Desktop; Stack has one `.ashlr` worktree outside Desktop. All registered paths existed at snapshot time.

## Plugin internal worktrees and broken shells

Seven directories under `ashlr-plugin/.claude/worktrees` are valid, locked, registered worktrees. Each carries tracked changes; one also has an untracked file. They range from 13M to 893M and correspond to branches `docs/v1.33-release-notes`, `worktree-agent-aa7b25f44e79db2cb`, `docs/v1.32-readme-changelog`, `worktree-agent-ace767ea2fc5d2205`, `chore/v1.33-tsc-sweep-ops-docs`, `feat/q4-discovery-propagation-v2`, and `docs/ops-runbook-v1.32`. Locks cite Claude agent PIDs. A PID becoming stale would not prove the worktree disposable.

Four additional 12M directories are not registered worktrees and have broken `.git` pointers to the old, absent primary path `/Users/masonwyatt/Desktop/ashlr-plugin`:

- `/Users/masonwyatt/Desktop/github/dev-tools/ashlr-plugin/.claude/worktrees/agent-a785a8d8ae573677c`
- `/Users/masonwyatt/Desktop/github/dev-tools/ashlr-plugin/.claude/worktrees/agent-a8e49edb201877cde`
- `/Users/masonwyatt/Desktop/github/dev-tools/ashlr-plugin/.claude/worktrees/agent-aedb18189d318ab8e`
- `/Users/masonwyatt/Desktop/github/dev-tools/ashlr-plugin/.claude/worktrees/agent-af98205873676ebf1`

These are **quarantine candidates, not deletion-approved candidates**. Broken Git metadata does not show that their ordinary files are represented in reachable commits.

## Lookalikes that are not duplicate product repositories

| Paths | Owning identity | Classification |
| --- | --- | --- |
| `ashlr-vault/01-products/{ashlr-plugin,phantom}`, `ashlr-vault/02-sales/launches/{ashlr-plugin,phantom}`, and `ashlr-vault/site/content/01-products/phantom` | Clean `ashlrai/ashlr-vault`, `master` at `70d5d60150603c4dd9553dfb2b8f3d201428045f`; directories are 8K–48K | Tracked product, sales, and site knowledge artifacts; keep in the vault repo |
| `ashlr-web/{src/app,out}/docs/{phantom,stack}` | Clean `ashlrai/ashlr-web`, `master` at `8e6e067e5e682f0532ceb24e3d43c48979aa423c`; directories are 12K–88K | Source documentation and generated site output; not product checkouts |
| `ashlr-plugin[/verify-contract]/node_modules/@ashlr/core-efficiency` | Ignored by Plugin's `node_modules/` rule | Restorable installed package copies, not Core Efficiency repositories |
| `phantom-secrets/target/package/phantom-secrets-core-0.6.0` and other `target` descendants | Ignored by Phantom's `/target` rule | Cargo packaging/build artifacts, not Phantom repositories |
| `phantom-secrets/crates/phantom-*`, `locus/crates/locus-*`, `locus/integrations/ashlr-hub`, and `locus/.locus` | Inside the canonical Phantom or Locus Git root | Monorepo packages/integration/config state |
| `.cortex` under `artist-encyclopedias/{Drake,dontoliverse,swiftiepedia,ye-universe}`, the factory template, and `first-principles` | Inside unrelated project repositories | Per-project Cortex metadata, not Ashlr Cortex copies |
| `.git/worktrees/ashlr-hub*` and analogous entries | Git administrative directories of their primary checkout | Required worktree metadata; never organize or delete as ordinary folders |

## Link and integrity checks run

- `git worktree list --porcelain` was used for every target Git root. Desktop linked-worktree `.git` forward pointers and administrative `gitdir` backlinks matched for Plugin verify-contract and all three wrkpad siblings.
- `git worktree prune --dry-run --verbose` returned no prunable entries for Hub, Plugin, Phantom, wrkpad, and homebrew-phantom.
- `git fsck --connectivity-only --no-dangling --no-reflogs` exited zero for those five multi-worktree repositories.
- Exact-path checks confirmed `/Users/masonwyatt/Desktop/cortex` and `/Users/masonwyatt/Desktop/mmcp` are absent.
- `git check-ignore -v` confirmed the two installed Core Efficiency package copies and the Phantom Cargo package tree are ignored. Ignore status proves only that Git does not preserve those bytes; it is not deletion authority.

These checks establish current Git linkage and object connectivity. They do not preserve working-tree-only content, prove a worktree inactive, validate a backup, or make a deletion recoverable.

## Exact, recoverable consolidation plan

### Gate 0 — freeze the inventory, not the engineering work

Immediately before any future move, create a dated manifest outside the candidate directories containing, for every Git root and worktree: absolute path, device/inode identity, origin URLs, common Git dir, HEAD, branch/upstream, `git status --porcelain=v2 --branch`, untracked-file list, `git worktree list --porcelain`, disk size, and SHA-256 of the manifest itself. Re-run the checks above and stop on drift, a broken backlink, open process, lock, detached/unpushed branch, or any dirty/untracked content not explicitly preserved.

### Gate 1 — preserve work and checkpoints before path changes

For each repository independently:

1. Record Entire status/checkpoint identifiers and export or resume the relevant session context. Entire metadata is supplementary; do not use it as the only backup.
2. Create a timestamped `git bundle create <repo>-<timestamp>.bundle --all`, verify it with `git bundle verify`, and clone it into a temporary directory to prove object restoration.
3. Save `git diff --binary`, `git diff --cached --binary`, a NUL-delimited untracked-file manifest, and a tar archive of untracked files. Hash each artifact and perform a restore comparison in a temporary directory.
4. For active dirty worktrees, either obtain the owning agent's completed commit/checkpoint or leave the path in place. Never stash, commit, reset, or move another agent's work merely to simplify the layout.

### Gate 2 — standardize without merging repositories

- Keep the eight observed canonical product paths listed above. MMCP remains unresolved. Do not relocate a primary repository merely for cosmetic uniformity while it is active.
- Keep clean, purposeful linked worktrees registered to their canonical primary. If a less cluttered view is desired later, move only clean, unlocked secondary worktrees with `git worktree move` into a product-local `.worktrees/<purpose>` or a single managed worktree root; validate both links and HEAD afterward. Never use Finder for this.
- Keep `homebrew-phantom` and `homebrew-ashlr-locus-v020` as independent distribution repositories. Rename or relocate them only through a separately reviewed release-infrastructure plan, because formula/source paths may be consumed by automation.
- Decide whether Core Efficiency's authoritative GitHub owner is `ashlrai` or `masonwyatt23`, then update remote naming and branch protection without rewriting history. Until decided, preserve both remotes.
- Do not create an MMCP folder until its authoritative origin and last known commits/artifacts are identified from backups or GitHub. A new empty folder would conceal rather than solve the missing-product condition.

### Gate 3 — reconcile unique and broken roots

- Treat `/Users/masonwyatt/Desktop/work louder board/app` as preservation priority: it has no remote and five tracked modifications. Bundle all refs, archive working changes, then compare `git diff --no-index`, commit ancestry, manifests, and functionality with wrkpad. If its unique work belongs in wrkpad, import it through a reviewed branch/patch. Only after the imported commit and a restored bundle are verified may the old folder be considered for archive retirement.
- For each of the four broken Plugin shells, create a file manifest and content archive excluding only the broken `.git` pointer; hash it; restore it elsewhere; compare every ordinary file against reachable Plugin commits and the valid worktrees. Move it to a dated quarantine as a plain archive only after the comparison. Deletion requires both a verified archive restore and proof that all valuable content is committed or deliberately retained.
- Retire a linked worktree only when clean, unlocked, merged or otherwise explicitly retained, absent from running processes, and backed up. Use `git worktree remove <exact-path>` followed by `git worktree prune --dry-run`; never delete the directory first.

### Gate 4 — reclaim generated bytes only through reproducible owners

The only concrete generated-byte candidates established here are ignored `node_modules` copies and Phantom `target` output. Before cleanup, verify the relevant lockfile, toolchain, installation credentials/artifacts, free disk requirement, and a clean rebuild in a temporary checkout. Use package-manager/Cargo-native clean operations scoped to one exact repository. Preserve release packages, databases, model weights, signing/notarization outputs, and any test evidence unless separately inventoried and backed up.

## GitHub orchestration: federation with conformance, not a speculative merge

Keep each product and distribution repository standalone. Hub should orchestrate them through versioned contracts, not by absorbing their histories or source trees.

Start with a reviewed, machine-readable compatibility manifest in Hub (for example `ecosystem/compatibility.v1.json`). If multiple products must independently govern or release it, graduate that artifact to a small `ashlrai/ashlr-conformance` repository; do not create the repository until ownership and release governance are agreed. Each product entry should contain:

- GitHub repository and package/artifact identity;
- released semantic version plus immutable source commit and artifact digest;
- supported protocol/schema/receipt versions and min/max peer compatibility;
- read-only observation, planned-effect, approval, execution, and audit-receipt capabilities;
- exact conformance commands and fixture versions;
- authority defaults, with all external effects disabled unless separately permitted;
- maintainers, license, release channel, and deprecation window.

Each product CI should run its own tests plus a pinned conformance suite and publish a content-addressed result. A Hub compatibility PR should update immutable versions/digests and aggregate those results; it must not imply that source tests prove deployment, provider activation, hardware acceptance, or production authority. Shared GitHub workflow templates may live in the existing organization `.github` repository, while product code, issues, releases, and security boundaries remain independent.

The first orchestration slice should therefore be manifest schema + fixtures + read-only verifier in Hub, exercised against pinned Plugin/Core Efficiency/Stack/Phantom/Locus contract samples. It creates a useful compatibility control plane with no filesystem moves, package publication, provider calls, or external effects.

## Candidate disposition

There are **no deletion-approved product folders or worktrees in this snapshot**.

Conditional, recoverable candidates are limited to:

1. ignored installed/build outputs after lockfile/toolchain rebuild proof;
2. four broken Plugin worktree shells after content archive, hash, restore, and reachability comparison;
3. a future archive of `/Users/masonwyatt/Desktop/work louder board/app` only after its unique dirty work is imported or deliberately preserved and the no-remote Git bundle is restore-tested.

Everything else classified above is canonical source, an intentional independent repository, a valid linked worktree, Git administration, or a tracked product/documentation artifact.
