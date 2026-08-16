# Notes: Ashlr Hub Production Autonomy Continuation

## Starting Point
- PR #310 was last verified open, clean, mergeable, with all 15 current checks successful at `17835bb86703a459c8be56b80f8baa6721c3ab1b`.
- The prior source branch is isolated from the Claude Code-owned dirty checkout.
- npm candidate `@ashlr/hub@3.2.6` was previously verified, while `latest` remained `3.0.1`.

## Authority Boundaries
- Source merge is not resident activation.
- Release publication is not npm `latest` promotion.
- A conductor source path is not live authority until a reviewed trust root and exact one-shot permit are provisioned and consumed.

## Investigation Log
- Protected master before merge was exactly `80d49d718d893d0cb02f85a62cd9d2691f4f39c3`.
- PR #310 merged as `99adb0dc2b7445f11a4eb7bbfe3ca70cc511b0c3` with ordered parents `[80d49d7, 17835bb8]`; the merge tree exactly equals the reviewed head tree.
- Installed CLI is still `3.1.0`; the active pointer targets release `18a60269037009d20162f3339236af35221e25d2`.
- Resident daemon is stopped. Autonomous readiness is blocked, queue/resource evidence is degraded, and dispatch-production evidence has four invalid rows.
- Starting the existing runtime would activate outdated code into a degraded evidence state, so activation remains held.
