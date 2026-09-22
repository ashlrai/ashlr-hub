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

If a measurement changes, change the page. A landing page that drifts from what
the software does is worse than no landing page.

## Two deliberate omissions

**No third-party logos.** Claude, OpenAI, Grok and Ollama are named in text with
the CLI and models Verse drives for each. Reproducing another company's mark from
memory produces an inaccurate version of their trademark, and naming the CLI is
more useful to a reader deciding whether their setup is covered.

**No claims about unbuilt features.** Multi-folder workspaces, GitHub surfacing
and MCP management are specified in `docs/VERSE-WORKSPACES.md` and are not on the
page, because they do not exist yet.

## Platform claims

The page states per-platform support rather than showing three logos as though
they were equivalent, because they are not:

- **macOS** — CLI, console, desktop window, sandboxing via `sandbox-exec`
- **Linux** — CLI and console (CI-tested), sandboxing via `bwrap`/`firejail`, no desktop package
- **Windows** — CLI and console (CI-tested), per-account profile isolation, env-only isolation, installers draft-only
