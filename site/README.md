# site/

The landing page for **verse.ashlr.ai**.

One standalone `index.html`. No build step, no dependencies, no framework — so it
can be served by any static host pointed at this directory, and opened straight
from disk to check a change.

```sh
open site/index.html
```

## Deploying

Vercel deploys `site/` to `verse.ashlr.ai` from `master`. Any static host
pointed at this directory works; nothing needs to run and there is no server
side.

Before merging a change, check it at a phone width: the page must not scroll
sideways at 390 px (tables and code blocks scroll inside their own boxes).

## What the numbers on it mean

Every figure is measured on a real machine (128 GB, Qwen3.8 27B at four-bit),
not estimated, and each one is reproducible from the repo:

| Claim on the page | Where it came from |
|---|---|
| 23,500 → 34-556 prompt tokens reprocessed per turn | the prefix-cache fix in `anthropic-shim.ts` |
| 333s → 151s single agent, 1386s → 540s for four | timed agent runs before and after that fix |
| 9.05 / 15.61 / 22.79 tok/s at 1 / 2 / 4 slots | aggregate decode throughput on llama-server |
| four agents, 4/4 correct, 521s wall | driven through Verse's own dispatch path |
| Context windows and compaction points (≈367k / ≈967k Claude, ≈244.8k of 258.4k Codex, 400k of 500k Grok) | CHANGELOG 3.9.0, read from the pinned CLIs and each seat's catalog; `docs/VERSE-CONTEXT.md` |
| API, replay, render and first-paint before/after table | CHANGELOG 3.10.0, "Performance"; the newer 349.7 KB first-paint result is in CHANGELOG 3.11.2 |
| Grant limits, compiled ceilings, two-hour watch, budget-mode reserves | CHANGELOG 3.10.0; `docs/STANDING-AUTHORITY.md`. These describe the guarded path, not current resident activation. |
| Burn-down history (every minute, ≥ 8 days, < 2 MiB) | CHANGELOG 3.10.1, "Command" |
| Cloud lane defaults ($250, $3 per session, 4 at once, 20 a day, $40 reserve) | `DEFAULT_CLOUD_BUDGET` in `src/core/cloud/types.ts`. These are settings, not measurements, and the page says so |
| Devin defaults (50 ACU, 10 per session, 2 at once, 30 ACU and 10 sessions a day, 10 ACU reserve) | `DEFAULT_DEVIN_BUDGET` in `src/core/devin/types.ts`; `docs/DEVIN.md` |
| "Our own fleet, today": standing grant active, ladder stage 1 of 8 (shadow), 0 repos merging | `ashlr authority status` on the maintainer's Mac, 2026-09-27; `docs/AUTONOMY-GAP.md` "Current activation state". **Recheck and update this line before each release** |
| The eight-stage ladder and its labels | the default ladder in `docs/STANDING-AUTHORITY.md` ("The rollout ladder") |
| Gate names G0–G7 | `src/web-ui/routes/verse/fleet/live-model.ts` (the Fleet shadow-decision chips) |
| Leader: directive prefixes, action classes, Telegram commands and buttons, seat fallback, retries, check-ins | CHANGELOG 3.14.0; `docs/LEADER.md` |
| Wiki: verified citations, local-first engines (never Claude), storage only on this Mac | CHANGELOG [Unreleased] "Private repo wiki and Ask"; `docs/VERSE.md` |
| Lessons: approval before use, 16 KiB cap, byte-identical prompts on no match | PR #535; `docs/VERSE.md` "Lessons" |
| Devin: Keychain key, chat seats (cloud and CLI), fleet launches only under a grant that names Devin; cloud merges need two independent judge families, while signed elite-direct scope can let eligible CLI work land at G6 | PRs #536, #540, #545, #556; `docs/DEVIN.md`; `docs/STANDING-AUTHORITY.md`; `src/core/fleet/reviewer-independence.ts` |
| Leader founder mode: briefs, instant brief on "status", "go build X", one question at a time, new powers with classes and veto windows | PR #550; `docs/LEADER.md` "Founder mode"; `src/core/comms/leader-line.ts`, `src/core/vision/leader-powers.ts` |
| Panel: terminal blocks and Agent tab, browser agents cannot click in, per-turn checkpoints with Accept/Reject/Undo/Redo | PRs #541, #546, #549, #551, #553; `docs/VERSE.md` "The workbench panel"; `docs/VERSE-BROWSER.md` |

The Leader conversation in the page is marked **illustrative**: the surfaces are
real, the words are an example. Keep that label if you change it.

If a measurement changes, change the page. A landing page that drifts from what
the software does is worse than no landing page.

## Current autonomy status

Autonomy ships dormant. It runs only under a Touch-ID-signed standing grant,
after the operator starts the resident daemon (`ashlr authority resident
start`), and only on macOS. The default grant starts on the shadow stage,
where nothing merges; an explicitly signed elite-direct grant has a different
single-rung rollout. The page's current fleet status is an observed default
grant at shadow, with 0 repositories merging. It must not claim merges,
merge counts or a later stage until `ashlr authority status` shows them. The
legacy permit-based daemon and conductor trust roots remain compiled empty;
see `docs/RESIDENT-RUNTIME.md`.

## Two deliberate choices

**Provider marks from a real source, never from memory.** Anthropic, OpenAI,
Grok and Ollama carry marks whose path data comes from `@lobehub/icons` (MIT),
the same set Verse uses, each with the CLI and models Verse drives for it.
llama.cpp and Devin get a generic glyph, because no verified mark is on hand;
do not draw one from memory.

**No claims about unbuilt features.** This rule stands; the example it used to
give has expired. Multi-folder workspaces, GitHub surfacing and MCP management
were listed here as unbuilt — all three now ship, and the page says so. What the
page still does not claim: autonomous merges (the ladder is at shadow), that
our own fleet launches or merges Devin work (our grant does not name Devin),
autonomy on Linux or Windows, a Linux or Windows desktop
package, a notarized macOS build, or a readable Claude credit balance (the cloud
lane's spend is an estimate, and the page labels it as one). Check this section against the product before a release rather than
assuming the omission still holds.

## Platform claims

The page states per-platform support rather than showing three logos as though
they were equivalent, because they are not:

- **macOS** — CLI, console, desktop app built from source, custody support (Secure Enclave, Touch ID), resident autonomy under a standing grant the operator starts, the Devin key in the Keychain, sandboxing via `sandbox-exec`
- **Linux** — CLI and console, sandboxing via `bwrap`/`firejail`, no desktop package, no custody helper
- **Windows** — CLI and console, per-account profile isolation, env-only isolation, no desktop package, no custody helper

GitHub Actions is off, so the page no longer says "CI-tested".
