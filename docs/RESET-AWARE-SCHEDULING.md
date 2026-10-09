# Reset-aware fleet scheduling

Phantom helps the fleet select useful work that can finish before a qualified
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
rolling recovery windows do not qualify as fixed weekly deadlines. Codex requires
a current account-matched native Plus/Pro report, the selected Codex bucket and
a provider-reported 10,080-minute secondary allowance window. Its actual future
weekly deadline is retained without inventing a start; an arbitrary reset
timestamp or credit balance does not qualify.
Cloud-credit estimates, tracked Devin ACUs and local-model readiness are not
expiring subscription balances.

## Subscription allowance versus credits

Track each native account independently. A reset time belongs to the observed
account and window; another account at the same provider does not inherit it.
Quota percentages are subscription capacity, not dollars or a token balance.
Current Codex credit units remain separate, even when the subscription window
is exhausted. Reserve shrinking requires a current provider-enforced subscription-only boundary; a selected subscription cost basis alone cannot prove that a turn will never spill into credits.

Deadline preference requires the effective subscription cost basis. A billing
date attached to a paid-credit, per-token or free lane does not establish an
expiring subscription allowance or enter the reset-timing advice. Ordinary
admitted routing remains available. Purchased credits are excluded from reset
spend-down. Gifted credits would need
both account-specific gift provenance and a verified future expiration before
they could receive expiry priority. This release does not have that native gift
expiry evidence: Claude cloud balances are operator-tracked estimates, and
Devin ACUs are tracked usage rather than self-serve subscription quota. Neither
gets an invented reset deadline. Devin's existing authorized native and hosted
work paths remain available; this release has no account-qualified self-serve
included-quota adapter, so Pro/Max subscription deadlines remain unknown here.

Vendor billing mechanics checked October 1, 2026:
[OpenAI uses included usage before credits](https://help.openai.com/en/articles/12642688-using-credits-for-flexible-usage-in-chatgpt-personal-plans).
[Devin separates resetting subscription quota from purchased credits, which roll over and never expire](https://docs.devin.ai/admin/billing/self-serve).
These general rules do not establish a particular account's current balance,
reset or gift expiration.

The estimate compares observed work duration with the remaining time. It reports
likely, uncertain, unlikely or unknown fit. The dispatch ledger currently pools
observations across accounts when account attribution is unavailable; resource details say
so. A quota percentage is never converted into a token allowance. These estimates
cannot promise that all remaining allowance will be consumed or that unused
allowance cannot carry over.

## API promotions

Claude API promotions are a separate funding lane. A recorded API expiry can support a duration-fit advisory when its balance, date and matching task history are known. It never becomes subscription headroom, a free lane or a percentage quota. The current router and signed subscription grant keep API execution held; recording a balance cannot activate it.

Before automatic API useful work can run, Phantom needs a source-owned fresh billing reader proving promotion-only prepaid funding, matching organization/workspace/credential identity and positive signed API authority. Purchased funding, invoicing, auto-reload, unknown evidence or an expired admission cutoff block spending. A date-only UTC expiry uses the start of that day as the admission cutoff, explicitly distinct from a provider-reported instant. Future grants must be observed; billing cycles do not manufacture balances. See [resource evidence](RESOURCE-EVIDENCE.md#claude-api-promotional-grants) for the reservation and display boundaries.

## Decisions and execution

The selected-batch planner can reorder comparable eligible choices so work with
an observed fit gets earlier access to a qualified deadline. Within each fit
class, priority rises continuously as the remaining time approaches the observed
75th-percentile duration; there is no fixed urgency horizon. Likely-to-finish
work stays ahead of uncertain work. Unknown history does not make a distant
deadline urgent. Ordinary admitted routing still uses headroom, independent
funding and explicit preferences when scheduling evidence is incomplete. This is a preference during normal fleet ticks,
not a promise to consume every remaining token. Once an eligible selected task
has a compatible observed duration, an existing abortable fleet park can shorten
to its next duration-derived boundary. No extra service or periodic provider
request is created; the next tick still revalidates all admission evidence.

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

## Allowance before resets

The global control and per-account overrides save enrollment separately from the
ordinary reserve. An absent global preference retains legacy deadline priority
without silently enabling reserve shrinking. Explicit **Off** disables both for
new scheduling and contacts; it does not stop ordinary fleet work. An account
override cannot bypass global Off.

With explicit enrollment, current task duration controls the reserve: the saved
reserve begins shrinking when the remaining time reaches twice the observed
75th-percentile duration, reaching the signed minimum at one duration. The
saved value is unchanged. Every binding usage window, account enablement, coding
role, signed floor, short-window ceiling and native throttle still applies.
Configured enrollment does not activate a paused grant. A signed 40% minimum
still holds 40%; lowering it requires review and approval in the existing grant
editor. This feature never changes a grant or provider billing.

Claude's quota-only native report can establish the billing boundary when its
current `rate_limits.extra_usage.is_enabled` is literally false and native account
identity matches before and after the report. The optional report, account and
usage reading must remain fresh at every new contact. This billing report is
not an execution binding: the actual producer must use the same independently
verified account and credential profile. Phantom's macOS host-owned native CLI
adapter uses a broker and isolated tool workers; each launch still needs an
independently matched account and credential profile. A native profile alone
does not remove the guard. Without a verified execution match, the source reports
`execution-unbound` and retains the saved reserve. Missing, malformed, enabled
or account-swapped data restores the saved reserve. Codex, Grok and Devin have no
verified no-spillover boundary in this source and remain held for reserve
shrinking. Grok's on-demand UI setting alone is not billing enforcement.
[Claude documents that disabling usage credits leaves included plan usage](https://support.claude.com/en/articles/12429409-manage-usage-credits-for-paid-claude-plans).

The production fleet does not yet supply the native execution-match source
required by reserve shrinking. Enrolling an account therefore does not establish
live tapering, even when Claude's billing report is valid. Connecting that source
needs the original collector identity evidence carried to the selected native
invocation; the historical reading cache cannot provide it. Codex's
credits-disabled boundary currently has a validator but no native writer.
Ordinary admitted work and qualified deadline priority remain available.

A selected task needs compatible completed engine/model/task-kind observations;
missing history keeps the saved reserve and ordinary admitted work can build
observations. Exact immutable attempt records can attribute explicitly bound
Grok runs to an opaque account hash. Unbound or conflicting records remain
labelled pooled. No quota percentage is converted to tokens or dollars, and no
made-up cold-start duration is used. Purchased and tracked cloud credits are
excluded from this enrollment.

The single-run, swarm and best-of-N entry points carry a caller-owned admission
fence. Current settings, account identity, billing boundary, model, quota, Stop
and signed authority are checked again before a new supported provider contact
or native launch. Native CLI internal inference sends rely on the provider's
verified credits-disabled billing boundary; opaque adapter retries cannot be
intercepted by this caller fence. Existing native throttles can prevent complete
allowance consumption, and no zero-billing guarantee is claimed for unsupported
provider paths.

Historical dispatch explanations record the selected account's saved reserve,
effective task reserve, signed floor, deadline and observed sample coverage. They
are metadata for inspection, never reusable admission authority. Resource GETs
show saved enrollment and constraints; without a current selected task they do
not claim an applied effective reserve.

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
