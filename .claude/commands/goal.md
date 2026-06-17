---
description: Create, plan, and advance an ashlr goal — sandboxed, proposal-only, routed across the polyglot backend fleet (M55).
argument-hint: "<objective>" [--project <repo>] [--allow-cloud]
---

Run the ashlr **goal conductor** for this objective:

$ARGUMENTS

Execute it:

```bash
ashlr goal $ARGUMENTS
```

`ashlr goal` creates a goal, plans it into milestones, and advances the next
milestone as a **sandboxed, proposal-only** run — routed across the polyglot
backend roster (local · Hermes · Claude · Codex · NVIDIA NIMs · Kimi K2.7 · …) by
capability and trust tier. **Nothing is applied to the working tree or `main`** —
the run files a PENDING proposal.

After it completes, summarize the proposal that was filed and remind the user to
review it with `ashlr inbox`. The kill-switch (`~/.ashlr/KILL`) halts everything.
