# site/

The Phantom by AshlrAI landing page and ecosystem page at **verse.ashlr.ai**.
The domain, CLI, package and installation names stay compatible; see
[the product naming guide](https://github.com/ashlrai/ashlr-hub/blob/master/docs/PHANTOM-BRAND.md).

Two standalone HTML pages (`index.html` and `ecosystem.html`). No source build,
runtime dependencies, or framework; Vercel's root configuration skips package
installation and serves this directory as static files. The ecosystem chart uses
the checked-in `assets/star-history.js` snapshot
and works when opened from disk. It never embeds a GitHub credential.
`robots.txt` and `sitemap.xml` list the two public canonical pages for crawlers.

```sh
open site/index.html
open site/ecosystem.html
```

Refresh the chart snapshot before publishing changes to the ecosystem page:

```sh
gh auth status                         # authenticated GitHub CLI
node scripts/update-site-stars.mjs     # from the repository root
```

The generator reads each named public repository and its dated stargazer events
from GitHub. It writes only dates and counts; no stargazer identity. A mismatch
between the current count and dated events fails without replacing the previous
snapshot. The chart sums six selected repository totals, **not** unique people,
and prints its UTC snapshot date. A static snapshot may age: each project links
to GitHub for its current count. Adding another repository requires a deliberate
edit to the generator, page controls, and project copy.

## Deploying

Vercel deploys `site/` to `verse.ashlr.ai` from `master`. Any static host
pointed at this directory works; nothing needs to run and there is no server
side.

Before merging a change, check both pages at a phone width: neither page may
scroll sideways at 390 px (tables and code blocks scroll inside their own boxes).
The hero tabs are explanatory, not a live dispatch surface; check click and
arrow-key switching, visible panel focus, and the copy-command feedback in a
secure context. The first tab remains readable if JavaScript is unavailable.
On `/ecosystem`, check aggregate and each repository, both date ranges, the
keyboard-operated date slider, and the repository links. If JavaScript is
unavailable, the project descriptions and links remain readable; if the data
is missing or invalid, the page must show an error instead of a false zero.

## Interactive Phantom world

The illustrated world uses local HTML, SVG, CSS and `assets/phantom-world.js`;
it has no provider calls, agent dispatch, sign-in or telemetry. Resource cards
explain connection types rather than reporting live account availability. The
Work with me and Work for me controls choose example workflows, and each stage
shows illustrative task evidence. Preserve the visible demo label and result
statement: no repository changed and no tests or releases ran.

Playback starts only when requested and stops at the last stage. It pauses when
the page is hidden or the scene leaves the viewport, and tears down timers and
listeners on page exit. Returning from the browser cache restores an idle scene.
Reduced motion removes animation; stage buttons and text remain available.
Without JavaScript, the first stage and resource descriptions remain readable.
Keep local image dimensions and the scene aspect ratio reserved to avoid layout
shifts. Check keyboard controls, visible focus and provider-label contrast at
phone and desktop widths before deployment.

This public demo is separate from the in-app Fleet world, which shows recorded
run membership and task evidence. Neither surface should invent collaboration
edges or turn an illustrative result into a claim of live work.

## Individual and team entry paths

Both hero buttons use the same visual treatment and lead to separate first-run
cards. Individuals begin with an owned project and a reviewed change; teams
begin with one repository, a named maintainer and their existing GitHub review
workflow. Each engineer uses their own permitted accounts. This is not a claim
of hosted shared workspaces, invitations, SSO, team billing or shared credentials.
The Work with me / Work for me tabs still describe workflows, not audience tiers.
Leader, resident autonomy and Devin cloud setup stay optional.

AshlrAI is the internal first-team pilot, not an external customer endorsement.
Before adding results, record actual work by two engineers using their own
permitted accounts, a tested accepted change and a review handoff. Count runs,
proposals and remote landings separately. The static page adds no telemetry,
forms or signup; any future pilot data collection needs explicit opt-in.

At desktop and 390 px, check equal CTA prominence, no horizontal overflow,
keyboard order and the individual/team/install anchors with and without
JavaScript. Keep the existing journey tabs, arrow-key controls and install-copy
feedback working. Validate the Quickstart section and optional guide links.
Run the existing documentation checker with `site/README.md` as an explicit
entrypoint; its default operator-document set does not include this directory.
Current public downloads are 3.24.2. The unchanged 3.24.3 candidate targets below
must be publicly verified before this branch is deployed; a local preview does
not establish publication or installed behavior.

## Release 3.24.3 copy

The current software metadata and install targets name 3.24.3. Its GitHub
release and downloads must exist and pass release checks before publishing this
page. A source link or prepared download target is not publication evidence.

The hero demonstrates Automatic chat selection with explicit overrides under
Advanced, and Fleet's New outcome flow: desired result, enrolled repositories,
and acceptance criteria. Resident setup is a separate prerequisite. Saving an
outcome does not start the fleet or widen signed permissions. Edit, Pause and
Resume preserve the existing controls; external jobs may take time to stop.
Plan verified describes task verification or explicit gate evidence, not an
independent proof of the user's whole desired result. Source contract:
[Automatic work](https://github.com/ashlrai/ashlr-hub/blob/master/docs/AUTOMATIC-OUTCOMES.md).

The 3.24 copy distinguishes native idle-sleep requests from cloud execution,
reported Devin consumption from tracked budgets, and source-specific Growth
measurements from user counts. Global and account reset controls do not imply
live reserve taper: a verified billing boundary must also match the actual
producer launch. This source adds the account-bound native Claude CLI adapter
and isolated filesystem tools; deployment and live account acceptance remain
separate. Aggressive reset-time reserve shrinking still requires a verified
subscription-only execution boundary. Purchased balances are excluded.

Keep historical 3.22 image leaves unchanged. Current 3.24.3 images are compiled
browser demos; they do not prove current provider activity or native behavior.

## What the numbers on it mean

The local-model tables are historical runs on a 128 GB machine with Qwen3.8
27B at four-bit. They do not describe the currently loaded model or establish
3.19 performance. Settings, controlled test clocks and measured runs are labeled
separately. The current online benchmark command has not been run as part of
this site change; offline comparison is not a new token-savings measurement.

Sources for the figures and behaviors:

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
| The default autonomy rollout begins in shadow after a Touch ID grant; Fleet shows actual activation and merge authority | `docs/STANDING-AUTHORITY.md`; no live grant status is claimed by the static page |
| The eight-stage ladder and its labels | the default ladder in `docs/STANDING-AUTHORITY.md` ("The rollout ladder") |
| Gate names G0–G7 | `src/web-ui/routes/verse/fleet/live-model.ts` (the Fleet shadow-decision chips) |
| Leader: directive prefixes, action classes, Telegram commands and buttons, seat fallback, retries, check-ins | CHANGELOG 3.14.0; `docs/LEADER.md` |
| Wiki: verified citations, local-first engines (never Claude), storage only on this Mac | CHANGELOG [Unreleased] "Private repo wiki and Ask"; `docs/VERSE.md` |
| Lessons: approval before use, 16 KiB cap, byte-identical prompts on no match | PR #535; `docs/VERSE.md` "Lessons" |
| Devin: Keychain key, chat seats (cloud and CLI), fleet launches only under a grant that names Devin; cloud merges need two independent judge families, while signed elite-direct scope can let eligible CLI work land at G6 | PRs #536, #540, #545, #556; `docs/DEVIN.md`; `docs/STANDING-AUTHORITY.md`; `src/core/fleet/reviewer-independence.ts` |
| Devin CLI defaults to Cognition SWE-2 High; Medium and Max are selectable, while Devin cloud sessions are a separate ACU-capped path whose underlying model Verse does not identify | `src/core/devin/models.ts`, local `devin models list` on 2026-09-28; [Cognition SWE-2](https://cognition.com/blog/swe-2), [Devin CLI](https://devin.ai/cli) |
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
single-rung rollout. The static page does not claim a live grant state; the
installed Fleet tab shows it. Do not claim merges, merge counts or a later
stage until `ashlr authority status` shows them. The
legacy permit-based daemon and conductor trust roots remain compiled empty;
see `docs/RESIDENT-RUNTIME.md`.

## Two deliberate choices

**Provider marks from a real source, never from memory.** Anthropic, OpenAI,
Grok and Ollama carry marks whose path data comes from `@lobehub/icons` (MIT),
the same set Verse uses, each with the CLI and models Verse drives for it.
The Devin mark is the vendor's `https://devin.ai/favicon.svg`, copied unchanged
to `assets/devin-mark.svg` on 2026-09-28 (SHA-256
`fe0753d2e3823bc1eb8a37943234fac63733b8c9e8abff0ca0402a6c7ddcd682`).
It identifies the Devin integration, not a partnership or endorsement.
llama.cpp uses a generic glyph; do not draw provider marks from memory.

**No claims about unbuilt features.** This rule stands; the example it used to
give has expired. Multi-folder workspaces, GitHub surfacing and MCP management
were listed here as unbuilt — all three now ship, and the page says so. What the
page still does not claim: current autonomous merges (the default ladder begins
in shadow), that our own fleet launches or merges Devin work without a grant,
autonomy on Linux or Windows, a Linux or Windows desktop
package, a notarized macOS build, or a readable Claude credit balance (the cloud
lane's spend is an estimate, and the page labels it as one). Check this section against the product before a release rather than
assuming the omission still holds.

## Platform claims

The page states per-platform support rather than showing three logos as though
they were equivalent, because they are not:

- **macOS** — CLI, console, desktop app built and locally signed from source (no notarized public installer), custody support (Secure Enclave, Touch ID), resident autonomy under a standing grant the operator starts, the Devin key in the Keychain, sandboxing via `sandbox-exec`
- **Linux** — CLI and console, sandboxing via `bwrap`/`firejail`, no desktop package, no custody helper
- **Windows** — CLI and console, per-account profile isolation, env-only isolation, no desktop package, no custody helper

GitHub Actions validates source candidates on Linux and Windows as well as
macOS. Those checks do not prove an installed desktop package or resident
autonomy on Linux or Windows.

## Demo and metadata

The two hero modes and stage buttons are illustrations. They make no requests
and never simulate a connected account or completed task. Buttons support
keyboard focus; the mode tabs support arrows, Home and End. The first mode and
its first stage are readable without JavaScript. There is no automatic playback.

The 3.19 startup visual is a controlled regression: one mocked account delays
20 seconds and three delay 10 ms each; the rolling two-worker implementation
finishes the fast rows at 10, 20 and 30 ms. It is not provider or native UI latency.
See `test/resource-connection-monitor.test.ts`.

Titles, descriptions and canonical URLs describe each page. JSON-LD describes
the app and site without invented ratings or reviews, so it makes no rich-result
eligibility claim. Sitemap `lastmod` tracks actual page/content updates, not a
new date for an unchanged page. Google may choose different search titles or
snippets; metadata does not prove indexing or ranking. Primary guidance:
[title links](https://developers.google.com/search/docs/appearance/title-link),
[snippets](https://developers.google.com/search/docs/appearance/snippet),
[software apps](https://developers.google.com/search/docs/appearance/structured-data/software-app),
[sitemaps](https://developers.google.com/search/docs/crawling-indexing/sitemaps/build-sitemap).

## Current workbench images

The two `work-*-3.24.3-demo.jpg` assets are unedited 1280 × 720 captures of the
actual compiled browser UI from clean source
`93491b7f8ae75a123d2f2a0c608cc8af357e3831`, with build identity and the complete
4,465-entry compiled inventory checked before and after capture. The same image
bytes appear in `docs/images/` for the repository README. Earlier versioned
captures remain unchanged historical images.

A private GET-only localhost adapter supplied labeled Demo accounts, a sample
conversation and synthetic verification/PR/merge history. All mutations were
refused, no provider ran and no fleet was active. The Work for me image is a
scrolled history excerpt, not an outcome-creation flow or real successful run.
Verification, merge and production are separate records: CI stays unknown and
release/deployment is unrecorded. These images show browser UI, not native app
chrome, installed account readiness or resident autonomy.

Supporting Resources, collapsed-group and 390 × 844 captures remain private.
The phone chat image has its sidebar open and qualifies drawer/overflow state,
not an unobstructed chat or Leader bubble. The fixture lacked the New outcome
and git-status routes; five git-status warnings were retained. This capture used
the existing base Demo fixture and does not qualify the separate Leader
memo/action display fixture. Actual source/build, DTO/helper hashes, screenshots,
accessibility observations and owned-server cleanup are bound in private capture
and independent review receipts. The release's full gate remains separate;
public deployment stays held until release artifacts are accepted and public.
