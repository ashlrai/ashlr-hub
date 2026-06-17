# CONTRACT-M73 — `ashlr stack` command (provisioning from the hub)

Surface the ecosystem `stack` tool (service control plane) from ashlr-hub so the
operator provisions/inspects services without leaving the harness.

**Mason's hard rule:** read-only by default; the MUTATING actions (`add`, `apply`
— they provision real cloud resources + wire phantom) are confirm-gated and
refuse in a non-TTY without `--yes` (mirrors the inbox-approve guard). Never
auto-provisions. Never throws; stack-absent ⇒ clear install message.

## Surface (`cli/stack.ts` + `integrations/stack.ts` runner)
- READ-ONLY (no prompt): `ashlr stack [status] [--json]`, `list`, `providers`,
  `recommend`, `scan`, `doctor` → passthrough to the `stack` CLI.
- MUTATING (confirm-gated): `ashlr stack add <service>`, `ashlr stack apply
  [recipe]` → require interactive y/N confirm OR `--yes`; non-TTY without `--yes`
  → refuse (exit 2). Only then shell `stack add`/`stack apply`.
- `integrations/stack.ts` `stackRun(args)` — bounded spawnSync, never-throws,
  neutral (the CLI gates mutation before calling it).
- `cli/index.ts`: lazy `stack` dispatch.

## Verification (`test/m73.*`)
1. **Mutation is gated** — non-TTY without `--yes` refuses (exit 2) and never
   calls stackRun; confirm-decline aborts cleanly; `--yes` bypasses. → m73 (25).
2. **Read-only never prompts**; `--json` round-trips. → m73.
3. **stack-absent** ⇒ install message, exit non-zero, never throws. → m73.
4. tsc + `eslint .` clean (0 errors); clean-HOME full suite 4219 pass. Live:
   `ashlr stack --help`. 0 new deps.

## Non-goals
Auto-provisioning without confirm · reimplementing stack · changing stack's own
behavior.
