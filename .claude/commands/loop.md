---
description: Preview one dormant ashlr conductor tick; production compiled roots admit dry-run only.
argument-hint: [--dry-run]
---

Preview the ashlr **fleet conductor** without dispatching:

```bash
ashlr loop --dry-run
```

The production compiled conductor trust roots are empty. Non-dry `ashlr loop`
and `ashlr loop --watch` therefore refuse before dispatch or proposal creation;
this slash command must not pass through non-dry arguments. The dry-run renders
the control-plane snapshot and shows what an admitted tick would consider
without starting a resident loop, dispatching work, or filing a proposal.

After it runs, report the preview and current fleet status. Do not claim that a
proposal was filed. For live owner-invoked proposal work, use `/goal` or the
explicit `ashlr run`/`ashlr swarm` commands.
