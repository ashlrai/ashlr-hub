# site/

The landing page for **verse.ashlr.ai**.

One standalone `index.html`. No build step, no dependencies, no framework — so it
can be served by any static host pointed at this directory, and opened straight
from disk to check a change.

```sh
open site/index.html
```

## Deploying

Point a static host at `site/` and set the domain to `verse.ashlr.ai`. Nothing
needs to run; there is no server side.

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
| Cloud lane defaults ($250, $3 per session, 4 at once, 20 a day, 4 self-improvement a day, $40 reserve) | `DEFAULT_CLOUD_BUDGET` in `src/core/cloud/types.ts`. These are settings, not measurements, and the page says so |

If a measurement changes, change the page. A landing page that drifts from what
the software does is worse than no landing page.

## Current autonomy status

The published release's daemon and conductor trust roots are compiled empty, and
resident service install/reinstall/repair/restart authority is withheld.
`ashlr authority setup --dry-run` can describe the custody steps, but setup alone
does not activate live resident work. The site presents grant, merge and budget
behavior as the guarded source path, not as an active production fleet. See
`README.md` under "Authority defaults" and `src/core/daemon/service-install-authority.ts`.

## Two deliberate omissions

**No third-party logos.** Claude, OpenAI, Grok and Ollama are named in text with
the CLI and models Verse drives for each. Reproducing another company's mark from
memory produces an inaccurate version of their trademark, and naming the CLI is
more useful to a reader deciding whether their setup is covered.

**No claims about unbuilt features.** This rule stands; the example it used to
give has expired. Multi-folder workspaces, GitHub surfacing and MCP management
were listed here as unbuilt — all three now ship, and the page says so. What the
page still does not claim: active resident autonomy, a Linux or Windows desktop package, a notarized
macOS build, or a readable Claude credit balance (the cloud lane's spend is an
estimate, and the page labels it as one). Check this section against the product before a release rather than
assuming the omission still holds.

## Platform claims

The page states per-platform support rather than showing three logos as though
they were equivalent, because they are not:

- **macOS** — CLI, console, desktop app built from source, custody support (Secure Enclave, Touch ID; resident autonomy currently dormant), sandboxing via `sandbox-exec`
- **Linux** — CLI and console, sandboxing via `bwrap`/`firejail`, no desktop package, no custody helper
- **Windows** — CLI and console, per-account profile isolation, env-only isolation, no desktop package, no custody helper

GitHub Actions is off, so the page no longer says "CI-tested".
