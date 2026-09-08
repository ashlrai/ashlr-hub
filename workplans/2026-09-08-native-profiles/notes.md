# Findings

User currently switches two Codex accounts in the desktop app. Previous work
verified help-only Grok ACP support, not a runnable Hub Grok transport.

Reuse: existing private-directory inspection, durable writes, trusted native
bindings, environment sanitation and launcher-compatibility checks. Preparation
is separate from legacy resource-monitor configuration and pool enrollment.

Decision: generate standalone owner-private launchers with native exec, not
shell snippets or credential copies. This preserves native stdin and process
ownership. Codex uses separate state with file credentials and ChatGPT login;
Claude uses separate Claude and Anthropic state directories. Authentication
remains a native interactive step, not a status inferred from directory creation.

Actual local commissioning: prepared two Codex profiles and one Claude profile;
help compatibility passed on Codex 0.136.0 and Claude 2.1.257. First Codex login
opened a native browser flow, which reached an empty account-selection form.
No authenticated account, independent subscription capacity, quota or inference
was established at this source checkpoint. Existing desktop login was untouched.

Grok research found a plausible native headless JSON transport. Its documented
upstream source differs from the installed version, and usage/protocol semantics
need offline fixtures plus a separately authenticated acceptance test. See
[the evidence and proposed contract](grok-research.md); no Grok adapter is enabled.
