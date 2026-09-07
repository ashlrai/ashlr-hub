# Resource commissioning notes

## Sources

- Official Codex app-server documentation opened September 7, 2026:
  https://learn.chatgpt.com/docs/app-server
- Source baseline: merged resource intelligence PR #366.

## Findings

- Native worker bindings already use explicit command prefixes, sanitized child
  environment and bounded process cleanup. Quota normalization is currently pure.
- Codex quota reads need explicit bucket selection; Claude event observations
  only describe observed windows and must not refresh unseen windows.

## Design

- Fixed no-generation helper under existing process ownership; no generic IPC
  execution hook. Explicit Codex bucket IDs and before/after reported identity.
- Independent transient admission constraint after ledger merge, not synthetic
  failure health readings or rewritten provider timestamps.
- Foreground optional collector uses one lease and pre-contact durable pending
  marker. Native cleanup uncertainty or crash requires reconciliation.
- Default console stays provider-free. Managed collector errors withhold new
  admission while stop controls and in-flight ownership remain available.

## Live metadata acceptance

- Source CLI default Codex launcher: observed reported Pro metadata and one
  selected `codex` window in 1.088 seconds on September 7. No model task was
  created. This proves only that exact launcher's metadata compatibility.
- Private report retained outside Git under
  `/Users/masonwyatt/.codex/artifacts/ashlr-resource-commissioning.pGyhpb`.
- No second Codex account, Claude subscription or local model was commissioned
  by this turn. No background service was installed.
- GitHub Actions remains disabled; pre-existing medium Rust glib alert 32 open.
