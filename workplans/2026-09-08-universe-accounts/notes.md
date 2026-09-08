# Findings

Current resource workers support codex, claude and local. Automatic quota capture
is Codex-specific. Verify official headless subscription and Grok Build contracts
before adding support or making account-readiness claims.

Official sources checked September 8, 2026:

- Codex native auth and state: https://learn.chatgpt.com/docs/auth
- Codex account/quota protocol: https://learn.chatgpt.com/docs/app-server
- Claude account-directory isolation: https://code.claude.com/docs/en/authentication
- Claude subscription notice: https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan
- Grok native protocol: https://docs.x.ai/build/cli/headless-scripting
- Grok configuration: https://docs.x.ai/build/settings/reference

Grok research agent verified installed 0.2.118 (1e1687c1cf6a), binary SHA256
2de5b9609a03492dd6b9e4cca9637d651fe998bb8371bf9f852e7b28b38c034e.
Help/version only, clean environment, temporary GROK_HOME and updater disabled;
no auth/model request. Top-level tool policy flags do not prove ACP enforcement.
Hub provider enum remains codex|claude|local. Grok is not routed through Claude.

Current Claude billing notice pauses the proposed June 15 change; do not implement
the superseded SDK credit table. Subscription login and API-key billing must not
be collapsed. No zero-inference Claude/Grok quota endpoint was established.
