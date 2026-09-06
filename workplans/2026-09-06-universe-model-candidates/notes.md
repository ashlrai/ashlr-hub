# Investigation notes

## Current state

The immutable Universe experiment kernel, CLI/SDK/console, and non-blocking web
read worker are merged. The canonical checkout contains unrelated workplans and
is preserved. Branch `codex/universe-model-candidates` starts from current master
in the existing isolated worktree. Agent findings and source-grounded decisions
established the additive local-model integration below.

## Implemented decision

Use the existing OpenAI-compatible client only at an explicitly configured
numeric-loopback HTTP endpoint. No tool calls, ambient provider credentials,
account discovery, downloads, or implicit provider fallback. The model receives
only declared parent text and returns strictly validated replacements; the
existing pinned evaluator and archive remain authoritative.

Generation receipts retain endpoint/model labels, content digests, duration,
changed paths and transport-reported token counters. No plaintext prompt or
response bodies are copied into receipts. Unknown or partial per-request usage
stays unavailable. Failed candidates still count reported usage. Replay derives
totals from durable trials and withholds aggregate totals unless the generation
completed, since a crash can lose an in-flight request's receipt.

## Independent findings resolved

- Fractional runner time budgets were rejected by the integer adapter contract;
  clamp them at the invocation boundary.
- Normalize broker endpoints without changing the immutable manifest input.
- Retain observed spend but reject a candidate on a completely reported output
  token overrun; this does not undo spend or prove provider-side enforcement.
- Preserve UTF-8 BOMs and revalidate all declared parents before any writes.
- Explicitly distinguish successful generation, fixed-evaluator pass, archive
  admission, source integration, and product/customer acceptance.

## Actual local-model evidence

The fixed real Hub utility canary retained its acceptance bar across a 7B model,
a 30B model, and a 30B critic-guided hypothesis. All three failed; 6,352 reported
generation tokens produced zero passing artifacts. See `canary-result.md` for
identities and results. No rejected candidate was applied. A small separately
authored `formatDayLabel` correction now rejects invalid date rollover and
preserves four-digit years, verified by another agent's regression suite.
