# CONTRACT-M70–M71 — wire the harness seams into commands

Turn the M68 (ashlr-md) and M69 (stack) integration seams into discoverable,
useful operator UX. Additive + opt-in + graceful-degrade; default output
byte-identical; never throws.

## M70 — ashlr-md in inbox/digest (`cli/inbox.ts`, `cli/digest.ts`)
- `ashlr inbox show <id> --open` (`--md` alias): build proposal markdown
  (`buildProposalMarkdown` — title + metadata table + summary + ```diff block +
  actions) and `presentMarkdown(...)` it into the ashlr-md viewer; falls back to
  the existing terminal render when ashlr-md is absent.
- `ashlr digest --open` (`--md`): render the digest markdown in ashlr-md, else
  terminal. Help text updated. Test: `m70.md-render` (14).

## M71 — stack step in onboard (`cli/onboard.ts`)
- `buildStackStep(repo?)` (pure, try/caught, never throws): stack absent → one
  dim install hint; present → "Services (stack)" with wired services (or setup
  hints `stack recommend`/`stack add`) + phantom auto-wire note; `.stack.toml`
  noted. Appended to both the yes-mode and interactive onboard paths (additive).
  Test: `m71.onboard-stack` (11).

## Verification
tsc + `eslint .` (0 errors) clean; m70+m71 (25) green; clean-HOME full suite 4194
pass (only the darwin-gated m52 probe, which skips on Linux CI). New flags live:
`ashlr inbox … --open`, `ashlr digest --open`. 0 new deps.

## Non-goals
Auto-opening without `--open` · stack auto-provision · GUI launches in tests.
