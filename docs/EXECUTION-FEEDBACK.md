# Recorded fleet execution feedback

Execution feedback connects terminal producer records to the existing retrospective sweep and Leader evidence. Reading it runs no provider, model, repair, or dispatch. It does not change permissions, spend, account readiness, or routing credit.

The projection separates proposal production, producer failure, cancellation, refusal, empty diff, disabled proposal filing, and unknown outcome. A produced proposal is **not** a verified change, merge, successful deployment, or beneficial production outcome. Those stages remain recorded by their existing proposal and authority readers.

Only current writer envelopes with matching attempt, run, trajectory, outcome, and summary count. Identical replays count once. Conflicting finals for the same attempt are withheld rather than resolved by arrival order. Legacy envelopes, unreadable files, truncated reads, and invalid or future timestamps make exact totals unknown. `observedCounts` remains a qualified lower bound; a missing store is not a measured zero.

The metadata view contains opaque case hashes and finite outcome fields. Raw prompts, errors, repository paths, account identities, run IDs, and tool payloads are excluded. Authorized internal callers can resolve a case through `lookupExecutionFeedback` to its real run and attempt trajectory. This is recorded local correlation, not signed authority or proof of provider identity.

The retrospective sweep records an observed engine, sandbox, or capture failure only when no proposal was recorded and the proposal inventory was completely inspected. A late proposal must match **both** run and attempt trajectory to suppress this no-proposal learning path. Partial proposal reads hold it. An already saved failure remains a historical observation; distinct later verification or merge outcomes retain their own records.

These failure retros contain no inferred code or authentication diagnosis, no sharper prompt, and no knowledge candidates. They skip the optional model and Jev refinement passes. The existing stable retrospective ID, sweep single-flight, private storage, retention, and review flow handle replay and persistence.

The Leader receives aggregate metadata as untrusted evidence. Failed attempts after its last run can use the existing insight trigger. Daily preferences, retries, hash coalescing, signed authority, account and spend admission still apply. Trigger and prompt collection share one bounded read in a tick; source failure remains unknown. No separate paid wake-up is added.

The worker reader uses a fixed seven-day window and existing bounded inspection-only dispatch/inbox readers. A retrospective sweep uses its existing thirty-day window. Coverage reflects those windows and reader byte/file/row limits; it does not claim whole-history completeness. Usage, tokens, duration, causal repair success, and positive post-merge credit are not synthesized by this projection.

```mermaid
flowchart TD
  Terminal["Terminal dispatch ledger\nexact recorded attempts"] --> Projection["Metadata projection\npartial totals remain unknown"]
  Inbox["Inspected proposal inventory\nexact run and trajectory joins"] --> Projection
  Projection --> Worker["Read-only worker\nno provider or model calls"]
  Worker --> UI["Lazy Fleet feedback view\nrecorded outcomes, not shipping proof"]
  Projection --> Retro["Existing retrospective sweep\ndeterministic failure case, no model pass"]
  Projection --> Leader["Leader evidence and existing insight trigger"]
  Retro --> Lessons["Stored outcome and lessons views\nno inferred code fix or prompt"]
  Leader --> Admission["Existing cadence, account, spend\nand signed permission checks"]
  Admission --> Dispatch["Existing dispatch\nmodel call only when admitted"]
  Dispatch --> Terminal
  Dispatch --> Verify["Existing proposal verification and merge gates"]
  Verify --> Future["Recorded verification, merge and watch outcomes\nseparate evidence; no positive credit inferred"]
```

Opening the view does not traverse the dispatch path. The Leader may use recorded evidence in an already permitted run; neither a retrospective nor an observed failure bypasses admission or proves that a repair worked.


## Inspect a recorded execution case

The authorized case-detail GET is `/api/verse/fleet/live/feedback/cases/:caseId`, using the opaque `h:…:…:…:…` identity returned by the summary. It accepts no caller-selected repository, history window, file path or URL. A cold read returns a warming state immediately while the existing bounded read worker inspects local evidence. The last selected case can remain explicitly stale while it refreshes; source failures remain unavailable. Reading a case starts no model, provider request, repair, merge or deployment.

The timeline joins a real terminal attempt to proposals only by exact run and trajectory. Local verification reports its actual verification time and remains unbound when the diff bytes/hash or base evidence is missing or mismatched. An actual readable run and proposal can link to their existing local views. Validated repository and positive PR-number records produce canonical GitHub PR links. Recorded authority-ledger landings are distinguished from persistence-authenticated local or host realized-merge receipts; a broken chain cannot establish a ledger merge or revert. Post-merge CI and local suite results remain separate, so `unknown` CI plus a passing suite is not reported as successful GitHub checks.

Partial proposal history, unreadable ledger sources, malformed records and conflicting bindings have independent coverage. Missing timestamps stay unknown; the reading time never becomes a verification or merge time. The shared worker's existing timeout and heap boundaries contain expensive history inspection; these are read limits, not account or work quotas. No new case-count truncation is introduced. Detail responses project only closed outcome fields and fixed navigation links, excluding prompts, diffs, raw errors, account identities, grant IDs and repository paths.

A merge or green post-merge observation is not shipping proof. Case details explicitly say release/deployment is not recorded. Current durable records also lack workflow/check-run IDs, so this view neither fabricates GitHub Actions links nor fetches them when opened.
