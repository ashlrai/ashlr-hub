# Resource-aware engineering execution: research synthesis

Audience: Ashlr's owner and engineering maintainers. Date: September 7, 2026.

## Executive answer

Use independent owner-authenticated native workers plus an explicit local model
adapter, with admission and accounting separate from authentication. Do not create
a subscription-backed API proxy. Resource percentages, operator task counts,
parallel slots, transport-reported tokens, and verified accepted engineering work
are different measurements. A task must remain pinned to one admitted worker.

The implemented standalone foreground pool follows this boundary while leaving
Universe's existing generation/evaluator/replay contract unchanged. It is source
implementation plus deterministic acceptance, not live multi-account deployment.

## Claim ledger

All sources below accessed September 7, 2026. Native CLI help was independently
checked at Codex 0.136.0 and Claude Code 2.1.257. No auth files were read.

| Claim | Primary source | Confidence / qualification |
| --- | --- | --- |
| Codex has subscription and API authentication | [OpenAI authentication](https://learn.chatgpt.com/docs/auth) | High; no account-specific eligibility established |
| Codex supports native noninteractive execution | [OpenAI non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode) | High; local help flags also checked |
| Codex quota primary/secondary and multi-bucket records are distinct | [App Server](https://learn.chatgpt.com/docs/app-server) | High; no fixed token conversion or account discovery inferred |
| Claude supports isolated authenticated configuration directories | [Claude authentication](https://code.claude.com/docs/en/authentication) | High technical; not blanket pooling permission |
| Native end-user CLI use differs from credential intermediation | [Claude legal/compliance](https://code.claude.com/docs/en/legal-and-compliance) | High text; deployment-specific terms remain owner responsibility |
| Proposed SDK monthly credits were paused, not activated | [June 16 notice](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan) | High; root verified notice before historical table |
| Fable allowance shares Max weekly capacity, with possible paid continuation | [Fable plan guide](https://support.claude.com/en/articles/15424964-claude-fable-models-on-your-plan) | High plan distinction; native wire bucket name unresolved |
| Status-line quota fields can independently disappear | [Status line](https://code.claude.com/docs/en/statusline) | High; headless status-line polling not assumed |
| Claude events use nested rate_limit_info | [Official SDK parser](https://raw.githubusercontent.com/anthropics/claude-agent-sdk-python/main/src/claude_agent_sdk/_internal/message_parser.py) and [types](https://raw.githubusercontent.com/anthropics/claude-agent-sdk-python/main/src/claude_agent_sdk/types.py) | Source contract; future safe opaque names retained |
| Native flags do not independently prove OS confinement | [CLI reference](https://code.claude.com/docs/en/cli-reference) and [programmatic execution](https://code.claude.com/docs/en/headless) | High; managed settings/wrappers remain trusted code |
| Non-Claude models are not supported behind Claude Code gateways | [Gateway guide](https://code.claude.com/docs/en/llm-gateway) | High; separate local adapter selected |

## Material findings and decisions

Existing Hub backend quotas collapse accounts, and Execution Identity V1 is
explicitly shadow-only. Existing Universe generation receipts bind one local
endpoint/model and one request per trial. Neither contract should be silently
relaxed to implement account balancing. An explicit resource task is a distinct
small execution surface with private durable reservations and native adapters.

Account aliases share declared capacity and known denials. Partial/expired quota
updates cannot clear prior blocks. Optional unknown-quota bootstrap is separately
operator-capped and never relabels unknown as a measured zero. Freshness is not
file mtime. Native task caps are not hidden per-request caps, and native output
token limits are observed cutoffs, not prepaid token reservations.

Initial review found and corrected: undersized native output capture; missing
post-response deadline check; token-pair overflow; missing macOS private-storage
anchor; overwritten omitted/unknown quota windows; mixed-age recovery; blocked
alias bypass; and writable task/accounting-store overlap. Exact verification
counts and final source/artifact identity belong in the release handoff.

## Limitations and stop reason

No complete independently queryable Claude daily/model limit inventory was
established. Fable's wire label remains unknown; no numeric entitlement is baked
into code. No owner account was enrolled or contacted. Generic permission for
multi-account subscription pooling was not established. The observed third-party
balancer project was not supplied, so no claim about its implementation is made.

Research stopped after primary sources established executable contracts and the
consequential billing/freshness limitations. Further broad searches would not
change this bounded implementation. The canonical user-facing artifact is
`docs/RESOURCE-POOLS.md`; it contains operation examples and dated source links.
