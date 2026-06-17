---
description: Run the autonomous ashlr fleet over every enrolled repo — one tick or continuous, proposal-only (M55).
argument-hint: [--watch] [--dry-run]
---

Run the ashlr **fleet conductor**:

```bash
ashlr loop $ARGUMENTS
```

`ashlr loop` renders the live control plane (per-backend throughput, queue depth,
quota, merges-to-`main` today) and then runs the autonomous fleet over every
enrolled repo: it discovers work, routes each item across the polyglot roster by
trust tier, runs it **sandboxed**, and files **PENDING proposals** — nothing is
applied by default. Default is a single tick; pass `--watch` for the continuous
loop, `--dry-run` to plan without dispatching.

It respects the kill-switch (`~/.ashlr/KILL`) and the daily budget. After it runs,
report the fleet status and any proposals filed (review via `ashlr inbox`).
