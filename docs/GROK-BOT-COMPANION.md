# Grok Bot beside Ashlr Verse

Grok Bot and Grok Build are separate products. Verse runs the **Grok Build CLI**
as a local project seat and reads its account observations. Grok Bot runs Bots on
a persistent cloud computer with its own conversation, usage, and approvals.
Grok Bot availability does not add a Verse seat or a known amount of Verse
capacity. An xAI API key is a third, metered route; Verse must not silently use
it when either subscription product is unavailable. Check the **actual seat's**
execution identity before a Grok Build turn: an unpinned `grok` command may
select `XAI_API_KEY` even when a separate subscription profile is configured.

## Useful setup today

1. In Grok Bot, create one Bot called **Verse release reviewer**. Give it a
   narrow job: independently inspect an exact GitHub PR head SHA, its checks,
   test receipts, changed files, and deployment evidence. Connect only the
   GitHub plugin and, when needed, the Vercel plugin through Grok Bot's
   Marketplace. Authenticate in the provider's own browser flow, then verify
   that each plugin lists working tools before assigning work. If Vercel
   authentication is unavailable, leave deployment claims unverified and
   provide the exact deployment URL for manual inspection. Give neither plugin
   broader write scope than the work requires.
2. Put this standing boundary in its Bot description:

   > Review Ashlr Verse changes as an independent reviewer. Quote the exact
   > repository, PR number, head SHA, check run, and deployment ID for every
   > release conclusion. Separate verified facts, inferences, and missing
   > evidence. Propose fixes or a review comment, but ask before posting,
   > merging, changing permissions, publishing packages, or deploying. Never
   > treat a green source build as proof that npm, the installed app, or the
   > public site is live. Never request or disclose credentials or signing
   > grants. Keep the final result concise and reviewable.

3. Give it one exact task, such as: “Review `ashlrai/ashlr-hub` PR `<number>` at
   head `<full SHA>`. Find correctness, security, and release risks. Verify the
   required checks from their actual GitHub runs. Return actionable findings
   with file and line links, and list which installed-product, registry, and
   production claims remain unverified. Do not write or publish.”
4. Compare each finding with the current PR head. A Bot result is a proposal,
   not a gate receipt. Apply fixes in an isolated checkout, rerun the affected
   tests and exact release gate, then update the PR. Keep Verse's Mac-side
   authority and signing controls in place.

This is a supported **companion workflow**, not a two-way Bot integration.
The Grok Bot app can continue work while the Mac sleeps, but its cloud computer
does not inherit the Mac's private Verse filesystem or its Touch ID grant.
`remote.ashlr.ai` is the human phone surface; do not hand the Bot a paired phone
session or use a human browser cookie as an agent credential.

### Optional one-way webhook handoff

[Grok Bot routines](https://cursor.com/help/grok-bot/routines) can start a named
Bot from an authenticated webhook. Ask the Bot to add a webhook trigger to a
narrow review routine. The Grok Bot **desktop** app shows the routine's POST URL
and secret key; the sender uses `Authorization: Bearer <key>` and may include a
JSON body with the exact repository, PR number, head SHA, and review scope.
Keep the key in a secret store, never in a repository, task prompt, or browser
URL. The phone app shows routine run history, but Cursor documents the URL and
key in the desktop routine details.

HTTP 200 means Grok Bot **accepted and started** a run. It is not completion,
review evidence, or a result. Read the Bot's chat and run history for the
outcome; no documented Bot result-polling API exists. Verse 3.16 does not yet
send these webhooks or import Bot results, so use the Bot app directly until a
separate connector is implemented and accepted end to end.

## Durable learning with evidence

Grok Bot's role memory can retain review preferences. Keep changing product
facts in GitHub and Verse, then have the Bot reopen those sources on each
consequential review. Save a repeatable review skill only after one reviewed
task has met its acceptance criteria. Routines should initially stop at a
reviewable report. Any Bot suggestion for Verse's `AGENTS.md`, routing, or
policy remains a proposal: Verse's Growth → Lessons queue and release gates
decide whether that knowledge is admitted. This preserves learning without
turning one Bot's recollection into authority.

## A possible future Verse connector

The webhook above is a supported **one-way dispatch** path, not a Bot
conversation, completion, or usage API. Grok Bot also supports plugins and the
user's Cursor MCP policy can admit a custom MCP server. That is an **incoming
tool surface** for a Bot, not an API that lets Verse create Bots or read their
conversations. A two-way Verse connector needs a separately authenticated
result callback, a real Grok Bot plugin test, and an independently reviewed
security contract:

- Give it a separate service identity and a small read-only projection of
  agent state, PR evidence, and needs-you summaries. Do not reuse phone pairing,
  browser cookies, read or mutation tokens, or the general Verse API.
- Define exact tool names, input schemas, bounded output, rate limits, audit
  receipts, and revocation. Exclude raw transcripts, credentials, local paths,
  standing grants, approval decisions, stops, merges, and deployment actions
  until each has its own explicit authority design and test.
- Serve it through an authenticated HTTPS endpoint. Prove that an untrusted
  client cannot call adjacent Verse routes, and test from a real Grok Bot
  plugin before marking it available.
- Keep Grok Bot status **external / unobserved** until a supported status or
  usage contract exists. No screen scraping, private endpoint calls, or
  inferred headroom from a subscription badge.

## Sources and limits

- [Grok Bot overview](https://docs.x.ai/grok-bot/overview) and
  [plans](https://x.ai/news/grok-bot-more-plans) describe the cloud computer,
  mobile app, and separate usage.
- [Create and manage Bots](https://docs.x.ai/grok-bot/bots) describes durable
  roles, memory, shared computer, and template sharing.
- [Settings and notifications](https://docs.x.ai/grok-bot/settings-and-notifications)
  and [team controls](https://docs.x.ai/grok-bot/teams-and-enterprises) describe
  plugins, the Cursor MCP policy, and the Admin API's settings scope.
- [Approvals, security, and privacy](https://docs.x.ai/grok-bot/approvals-security-and-privacy)
  describes Bot approval boundaries.
- [Grok Bot routines](https://cursor.com/help/grok-bot/routines) documents
  webhook triggers, desktop URL/key access, and the start-only meaning of 200.

No public Grok Bot result or status API is documented in these sources as of
2026-09-28. Recheck vendor documentation before building a two-way adapter.
