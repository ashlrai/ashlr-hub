# Resource readings and credit balances

Phantom keeps each account's subscription windows, native credit units, captured dollar balances, and operator estimates separate. The resource sidebar uses the same live capacity model as the resource drawer. Refreshing a reading does not renew its original observation or expiration.

On startup, a validated private reading cache can show last-known usage before native metadata collection completes. Gray meters say **last** and retain the original reading date. Fresh native readings replace them. Historical windows never supply live capacity, account authentication, usable-again times, routing eligibility, or reset spend-down pressure. An account switch or sign-out suppresses the previous account's values.

```mermaid
flowchart LR
  Native["Native account metadata"] --> Current["Current usage and account evidence"]
  Native --> History["Private last-known reading"]
  History --> Sidebar["Gray historical meter"]
  Current --> Sidebar
  Capture["Account-bound balance capture"] --> Credits["Separate recorded credit pools"]
  Credits --> Drawer["Expandable credit details"]
  Estimate["Operator cloud estimate"] --> Drawer
```

The private cache binds readings to the account, selected native profile, and a checked local identity. An unchanged local credential-file epoch can qualify historical association after restart; it does not prove a current provider login. Original timestamps remain unchanged. Bulk cache writes and file synchronization run asynchronously. The final ownership, account-generation, target-file, and temporary-file checks precede a short metadata commit without an intervening JavaScript yield. Files remain private, and a malformed or replaced cache is unavailable rather than silently overwritten.

## Different kinds of capacity

| Reading | Display | Meaning for autonomous scheduling |
| --- | --- | --- |
| Current subscription window | Native percentage and reported reset | Existing account, permission, and subscription admission apply |
| Historical subscription window | Gray dated reading | Display only; does not authorize work |
| Native Codex credit balance | Exact credit units and a labeled dollar reference when supported | Separate from the subscription; a balance does not authorize autonomous credit spending |
| Captured Claude cloud gift | Exact last-recorded dollars, cloud scope, and verified expiration if recorded | Historical balance evidence; capture does not activate gift spending |
| Captured purchased usage credits | Separate last-recorded dollars and expiration, if known | Does not acquire subscription reset urgency |
| Operator cloud estimate | **Cloud estimate**, with its estimate qualifier | Separate from a provider-reported wallet or captured balance |

Dollar references are not invoices, purchased-credit prices, or attributed task costs. Subscription percentages are not token counts. Different accounts remain independent, including accounts from the same provider. No account-count truncation is introduced by these views.

## Credit details

Opening Resources and then **Credit balances** mounts the recorded-balance reader. The authorized GET is `/api/verse/resources/credit-pools`; it accepts no query parameters, provider command, file path, or caller-selected identity. A cold request returns `warming` while the existing bounded worker reads private evidence. Stale and unavailable readings retain their qualifiers. The HTTP fast path uses existing in-memory collector status and identity snapshots.

Credit records project only their account ID, pool kind, exact amount, original capture time, scope, source, and expiration. Private identity digests, credential paths, and collection generations do not enter the response. Native account evidence verifies the association, not a manually captured monetary balance. Internal capture requires paired fresh native witnesses and a matching generation at publication. A changed or unknown identity hides the amounts. This read surface neither captures new balances nor changes provider billing.

The endpoint reads fixed local stores. Opening it does not start a model, provider probe, cloud scheduler, or dispatch. Missing records mean **unknown**, not zero dollars. A recorded deadline passing does not establish a newly refreshed balance or prove that a provider actually expired a grant.

For recorded attempt, verification, and GitHub outcomes, see [execution feedback](EXECUTION-FEEDBACK.md).
