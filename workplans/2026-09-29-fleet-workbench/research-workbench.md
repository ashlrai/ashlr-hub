# Workbench and skill portability research

Reviewed September 29, 2026. External source files were read as evidence, not executed or installed.

## Ponytail

[Ponytail](https://github.com/DietrichGebert/ponytail) is an instruction and lifecycle-hook package, not a session-management desktop workbench. The inspected shallow checkout pins commit `e3ba2aa6f1e6f0bc4d69eb09c9f0d0a93af56156`; its Codex manifest reports version 4.10.0.

The [README](https://github.com/DietrichGebert/ponytail/blob/e3ba2aa6f1e6f0bc4d69eb09c9f0d0a93af56156/README.md) emphasizes reusing existing code and native platform capabilities, retaining input validation, accessibility and data-loss protection. Its performance figures describe its own benchmark; they do not establish measured gains for Ashlr or every model. Relevant inspiration is consistent instruction delivery across agent hosts, with an explicit mode and off switch.

The [Codex manifest](https://github.com/DietrichGebert/ponytail/blob/e3ba2aa6f1e6f0bc4d69eb09c9f0d0a93af56156/.codex-plugin/plugin.json) names a shared skills directory and host-specific hooks. [The hook definition](https://github.com/DietrichGebert/ponytail/blob/e3ba2aa6f1e6f0bc4d69eb09c9f0d0a93af56156/hooks/claude-codex-hooks.json) handles session start, subagent start and prompt submission with bounded command timeouts. [Runtime code](https://github.com/DietrichGebert/ponytail/blob/e3ba2aa6f1e6f0bc4d69eb09c9f0d0a93af56156/hooks/ponytail-runtime.js) emits different context envelopes for Codex, Claude, Copilot, Cursor and Qoder; mode state lives in a host-specific directory. These are compatibility adapters, not proof that all hosts consume the same hook schema.

Its [MCP implementation](https://github.com/DietrichGebert/ponytail/blob/e3ba2aa6f1e6f0bc4d69eb09c9f0d0a93af56156/ponytail-mcp/index.js) exposes an instruction prompt and a read-only instruction tool over stdio. This gives clients with only MCP access a portable, explicitly invoked path. Its [MIT license](https://github.com/DietrichGebert/ponytail/blob/e3ba2aa6f1e6f0bc4d69eb09c9f0d0a93af56156/LICENSE) permits reuse subject to retaining the notice. No source was copied into Hub and no lifecycle hooks were enabled.

## Requested agent-skills repository

`https://github.com/adysomani/agent-skills` could not be inspected. An unauthenticated `git clone --depth 1` returned `Repository not found`; browser retrieval failed and an exact-name search yielded no result. This could mean the path changed or the repository is private. Its code, license, capabilities and compatibility remain unverified. Do not silently substitute another author's similarly named project.

## Existing Hub patterns to reuse

* `src/web-ui/routes/verse/apps/McpGroup.tsx` already shows what each seat actually loads, explains configured-but-unused servers, and adds configuration through a digest-bound propose/disclose/apply flow. Keep that pattern for portable instruction tools.
* `src/web-ui/routes/verse/agent-tools/AgentToolsSheet.tsx` already exposes terminal/browser/computer grants for a specific session, explains unavailable adapters, and applies revocation immediately. Skills must not silently widen those tool grants.
* `src/core/plugins/registry.ts` separates manifest discovery from code loading and requires explicit enabled names, integrity pins and declared capabilities. Its current integrity contract covers the entry file only; do not reuse it as a claim that a multi-file external skill tree is fully pinned.
* `src/core/fleet/external-skill-git-capture.ts`, `external-skill-artifact-firewall.ts`, `external-skill-audit.ts` and `external-skill-custody-attestation.ts` provide more suitable existing custody machinery for external instruction trees.
* `src/core/fleet/skill-library.ts` and `skill-records.ts` retain verified learning and scope. No skill-installation or portability browser was found in the existing Verse Apps section during this pass.

## Concrete next workbench improvement

Add a compact Skills section to Apps, using the existing disclosure sheet and row primitives. Each skill should show source/version/digest, license, where it is enabled, which seat adapters actually load it, and whether it is instructions-only or executes hooks. Start with an inert inventory backed by actual discovery rather than assumed compatibility. A deliberate install action should stage a pinned artifact, disclose hooks/config changes, pass the existing audit machinery, and apply through a digest-bound proposal. Model/seat changes should recompute actual compatibility. Session detail should show which skills were included in that turn.

Use an instruction-only or MCP path where a host cannot consume lifecycle hooks. Preserve existing scope and tools grants. This would make portability observable and reviewable while retaining host-native behavior. It requires its own API and UI implementation; this investigation did not claim it shipped.

## Current shipped-scope fixes in this branch

The phone session check now retains a valid mounted screen during its near-expiry probe, checks only once per deadline, closes at the deadline even if the network stalls, and ignores superseded authenticated responses. Failed first prompts stay in New agent, with the opened chat retained for retry instead of duplicate creation. The admin socket startup accepts disappearance between stat and connect while retaining ownership/mode/inode checks before unlink. Focused async and backend regressions cover these behaviors.
