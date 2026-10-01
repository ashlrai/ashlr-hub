# Reset-aware fleet scheduling

Verse 3.20 helps the fleet select useful work that can finish before a qualified
account deadline. Work for me keeps the selected tasks, eligible accounts and
current routing policies together. Opening resource details only reads recorded evidence;
it does not start work or call a decision model.

## What the fleet knows

| Evidence | How it is used |
|---|---|
| Fresh account windows and reserves | Determine current admitted headroom across all binding windows. |
| Provider-reported fixed-period start and end | Establish a current deadline without guessing a period from a percentage. |
| Qualified native subscription weekly deadline | Preserve the actual reset timestamp and plan qualification without inventing a start. |
| Completed engine/model/task-kind observations | Estimate duration and reported tokens with quartiles and sample counts. |
| Missing model, history, tokens or deadline | Remain unknown; ordinary admitted routing can continue. |

Grok's structured account report can supply fixed weekly or monthly period bounds.
Claude's structured native usage report requires the supported CLI version,
matching native account and Pro/Max plan, a current weekly-all meter and a
successful quota-only result with no inference. Legacy prose, API plans and
rolling recovery windows do not qualify as fixed weekly deadlines. Codex reset
timestamps alone do not establish whether its window is fixed or rolling.
Cloud-credit estimates, tracked Devin ACUs and local-model readiness are not
expiring subscription balances.

The estimate compares observed work duration with the remaining time. It reports
likely, uncertain, unlikely or unknown fit. The dispatch ledger currently pools
observations across accounts when account attribution is unavailable; resource details say
so. A quota percentage is never converted into a token allowance. These estimates
cannot promise that all remaining allowance will be consumed or that unused
allowance cannot carry over.

## Decisions and execution

The selected-batch planner can reorder comparable eligible choices so work with
an observed fit gets earlier access to a qualified deadline. Within each fit
class, priority rises continuously as the remaining time approaches the observed
75th-percentile duration; there is no fixed urgency horizon. Likely-to-finish
work stays ahead of uncertain work. Unknown history does not make a distant
deadline urgent. Existing quality-tier placement and ordinary routing remain
when evidence is incomplete. This is a preference during normal fleet ticks,
not a promise to wake at an exact instant or consume every remaining token.

Optional Jev advice uses a closed list of eligible task/account pairs. The wire
request contains bounded task-kind and scheduling metadata; task prompts, account
names, paths and internal identifiers stay local. Advice is cached and shared
for the same context. An unsupported choice, low confidence, failure or expired
context falls back to ordinary routing. Large inventories use ordinary routing
when the provider's choice protocol cannot represent the whole set.

The fleet checks current configuration, selected model, account capacity, Stop
and authority again after asynchronous work. Jev advice does not widen authority
or reserve a provider's quota. New metered advice needs an available positive
signed metered allowance. Its existing decision ledger is separate from dispatch
accounting; it is not an aggregate provider invoice or dollar reservation.

## Preferences and recorded evidence

Jev's daily-call preference accepts a nonnegative safe integer or **No preference
limit**. Zero stops new decision calls; null removes that call-count comparison.
It does not enable Jev, supply a key, clear Stop or change the standing grant.
Save changes through Usage or the Jev panel; unsupported servers and failed
readback preserve the draft.

Resources and Fleet capacity details distinguish current quota from the last recorded selected-task forecast
and advice. Historical token/cost coverage is labelled. Concrete Jev response
models use known rates; moving aliases and missing usage keep cost unknown unless
both operator rates are configured. Old rows are never repriced automatically.

Regression tests use offline fake clocks and provider metadata. Explicit online
coding runs use `ashlr benchmark run`; saved report comparison remains offline.
See [the harness guide](AGENT-HARNESS-EVOLUTION.md) and the
[recorded local qualification](https://github.com/ashlrai/ashlr-hub/blob/master/benchmarks/local-qualification-2026-10-01.json).
