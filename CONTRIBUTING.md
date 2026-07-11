# Contributing to ashlr-hub

ashlr-hub is an autonomous engineering fleet + local command center, built contract-first in TypeScript (strict ESM, Node 22+). This guide covers the dev environment, conventions, the contracts-first workflow, and the safety invariants contributors must never weaken.

---

## Prerequisites

- **Node.js 22+** (`engines.node` is `>=22`; CI and the build assume it)
- **git** on `PATH`
- `~/.local/bin` on your `PATH` if you want to install the CLI locally
- Optional (only exercised at runtime by specific commands): `phantom`, `ollama`, LM Studio, `gh`, `vercel`, `claude`, `codex`. None are required to build or test.

The toolchain is intentionally lean: `typescript`, `tsx`, `vitest`, and `eslint`/`typescript-eslint` are the only devDependencies.

---

## Setup

```sh
npm ci          # clean, lockfile-exact install of devDependencies
```

The only runtime dependency is `@modelcontextprotocol/sdk` (MCP gateway). See "Zero-runtime-dep core" below.

To install the CLI while developing:

```sh
./install.sh    # builds dist/, symlinks bin/ashlr → ~/.local/bin/ashlr, smoke-tests ashlr help
```

`install.sh` is idempotent — re-run it after pulling changes.

---

## Everyday commands

| Command | What it does |
|---------|-------------|
| `npm run dev` | Run the CLI from source via `tsx` (no compile step). E.g. `npm run dev -- status` |
| `npm test` | Run the full vitest suite once (`vitest run`) |
| `npm run test:serial` | Run tests without file parallelism — required for tests that touch the same home dir |
| `npm run test:ci` | Run the hermetic serial suite with isolated HOME, inactivity detection, and a hard runtime cap |
| `npm run lint` | ESLint over the repo |
| `npm run typecheck` | `tsc --noEmit` — strict type check, no emit |
| `npm run build` | `tsc -p tsconfig.json` + `scripts/copy-assets.mjs` → `dist/` |

`bin/ashlr` is a thin ESM shim that imports `dist/cli/index.js`, so the installed binary always runs the compiled output. For fast iteration, use `npm run dev` (runs `src/cli/index.ts` directly through `tsx`).

### Definition of green

A change is ready when all four pass:

```sh
npm run typecheck && npm run lint && npm run test:ci && npm run build
```

The test suite must stay green and must not shrink (900+ tests across `test/`). Tests are organized by milestone (`m4.*.test.ts`, `m45.*.test.ts`, …) plus hardening suites (`h1.*` through `h8.*`).

### Running tests hermetically (CI-safe)

```sh
npm run test:ci
```

This is the canonical CI invocation. It isolates HOME/ASHLR_HOME and exits with code 124 if Vitest produces no output for `ASHLR_TEST_CI_IDLE_TIMEOUT_MS` (default 5 minutes) or exceeds `ASHLR_TEST_CI_TIMEOUT_MS` (default 15 minutes). The diagnostics distinguish an inactive process from an actively progressing suite that reaches the hard cap; only inactivity after Vitest's final summary is evidence of a possible leaked handle.

Ubuntu runs the complete suite and is the exhaustive CI authority. Windows runs a named cross-platform portability corpus in three fixed, disjoint serial partitions covering home isolation, path and command resolution, Git worktrees and patching, verification processes, merge authority, remote handoff, telemetry, and watchdog behavior. The CI guard verifies every declared test path exists and appears exactly once. POSIX-only permission, symlink, sandbox, and process fixtures remain in the Ubuntu suite; the Windows jobs validate portable product contracts without sharing mutable HOME state between tests.

---

## Conventions

### ESM / NodeNext — `.js` import extensions

The project is `"type": "module"` with `module`/`moduleResolution` set to `NodeNext`. **Always import sibling modules with the `.js` extension**, even though the source file is `.ts`:

```ts
import { getGitStatus } from './git.js';        // not './git' or './git.ts'
import type { AshlrConfig } from './types.js';
```

This is non-negotiable — NodeNext resolution requires it at runtime.

### Strict TypeScript

`tsconfig.json` enables `strict`, plus `noImplicitOverride`, `noUnusedLocals`, `noUnusedParameters`, and `noFallthroughCasesInSwitch`. Write code that passes `npm run typecheck` with zero suppressions. Avoid `any`; prefer the canonical types in `src/core/types.ts`.

### Zero-runtime-dep core

Everything under `src/core/` and `src/cli/` is built on **Node builtins only**. The single allowed runtime dependency, `@modelcontextprotocol/sdk`, is confined to the MCP layer (`mcp-gateway.ts`, `run/agent-loop.ts`). **Do not add new runtime dependencies.** If you reach for a library, reconsider — the design goal is a portable, fast, dependency-free binary. This invariant is enforced by a dependency-manifest grep-guard in the test suite.

### One module per file

Each subsystem is a single focused module that owns one responsibility. CLI command handlers live in `src/cli/` and stay thin — they parse argv and delegate to `core/`. `src/core/` subsystems do not reach into CLI modules.

### Hermetic vitest tests

Tests must be hermetic. Drive code through injected config and temp directories; fixtures live in `test/fixtures/`. A test must pass identically on any machine and in CI. Never read from or assert against the user's actual home directory or model endpoints. Use `test/helpers/` for fixture building.

### No personal absolute paths in source

Resolve runtime paths from `os.homedir()`. Use homedir-relative placeholders (`~/Desktop`, `/Users/you/...`) in docs and comments. The config layer already does this; don't bypass it.

### Author attribution

Author attribution (Mason Wyatt / `masonwyatt23` / ashlr.ai) is intentional and must be preserved in source headers and package metadata.

---

## Contracts-first pattern

ashlr-hub is built **contract-first**: interfaces and types are authored before code, so multiple agents can build disjoint modules in parallel without colliding.

1. **`src/core/types.ts` is THE CONTRACT.** It holds every shared type (`AshlrConfig`, `IndexedItem`, `AshlrIndex`, `DoctorReport`, `RunState`, `ActivityRollup`, `Goal`, `WorkItem`, `SwarmState`, genome types, fleet types, …). Import these types — **never redefine them** in another module.

2. **`CONTRACT.md` plus per-milestone files** (`docs/contracts/CONTRACT-M<N>.md`) are the binding interface spec. Each pins the exported function signatures and type shapes a milestone's modules must satisfy. Do not change an exported signature without updating the corresponding contract file in the same change.

3. **Build to the contract.** Implement against the declared signatures so that modules written independently compose cleanly.

When you add a milestone or change a public surface: update `types.ts` and the relevant `CONTRACT-M<N>.md` first, then implement, then test.

---

## Safety invariants contributors must never weaken

The following invariants are enforced by named adversarial tests. A PR that weakens any of them will not be accepted — and the fleet's own self-improvement harness (M54) is also blocked from doing so:

1. **Proposal-only floor.** The daemon source may import no merge/apply primitive. Auto-merge is a separate gated module, default off. Test: `test/h1.daemon-gates.test.ts` (source-scan grep-guard) + `test/m48.automerge-pass.test.ts`.
2. **Enrollment gate.** Only enrolled repos receive autonomous work. Test: `test/h6.*`.
3. **Kill-switch always halts.** `~/.ashlr/KILL` present must stop every backend and every repo. Test: `test/m48.*` kill-all.
4. **Sandboxed-with-diff-capture only.** In the autonomous loop, external engines run only through `runEngineSandboxed`. No raw-external path. Sandbox-creation failure is terminal, never a silent fallback. Test: `test/m45.*` no-raw-fallback test.
5. **Git push blocked from sandbox.** The pre-push hook + credential strip must fail every push from a worktree. Test: `test/m45.*` pre-push test.
6. **Only the diff is consumed.** No transcript, no live-tree write escapes the sandbox. Test: `test/m45.*` diff-only test.
7. **Immutable signed provenance.** `{engineModel, engineTier}` is write-once and HMAC-signed. The merge gate must verify the HMAC. Test: `test/m47.*`, `test/m47-1.*`.
8. **Merge-to-main requires frontier + verification.** CI green AND `mergeAuthority` match required. Local/mid refused regardless. Test: `test/m47.*` trust-and-verify test.
9. **Self-improvement cannot self-disarm.** Self-target diffs must pass the suite flag-off and flag-on. Safety-test-weakening diffs refused. Test: `test/m54.*`.
10. **Zero new runtime deps.** Test: dependency-manifest grep-guard in the suite.

If you are adding a new safety invariant, the pattern is: add the invariant to `docs/SPEC-V*.md`, write the named adversarial test first, then implement.

---

## Adding a new backend engine

Backends are registered in `src/core/run/engine-registry.ts`. To add a new one:

1. Add an entry to `ENGINE_REGISTRY` with `id`, `bin`/`apiBase`, `tier` (`local | mid | frontier`), and `buildArgv`.
2. If it is API-based (OpenAI-compatible), confirm it works through the existing `provider-client.ts` path.
3. Add a `cfg.foundry.engines` example to `docs/examples/foundry.config.json`.
4. Add a test that asserts the new entry resolves to byte-identical argv and that its tier is correct.

No changes to `buildEngineCommand`, `engineInstalled`, or `engineTierOf` should be necessary — they read the registry.

## Adding a new scanner

Portfolio scanners live in `src/core/portfolio/scanners.ts`. Each scanner is a function that returns `WorkItem[]`. Add your scanner, register it in the scanner list, and add a test with a mock repo fixture.

## Adding a new comms transport

Comms transports live in `src/core/integrations/`. Implement the `CommsBridge` interface from `src/core/types.ts`, register it in `comms/dispatch.ts` based on `cfg.comms.channel`, and add a hermetic test with a mock transport.

---

## Commit style

- Keep commits focused and atomic; one logical change per commit.
- Use a concise, imperative subject line (e.g. `add genome embedding rerank fallback`), with a body explaining the "why" when it is not obvious.
- A commit must leave the tree green (typecheck + lint + test + build).
- Do not commit `dist/` (it is git-ignored) or machine-specific paths.
- Milestone commits follow the pattern: `feat: M<N> <short description>` and update the milestone row in the relevant `docs/SPEC-V*.md`.

---

## Project layout

```
src/
├── cli/           # Thin argv dispatchers — parse, delegate to core, format output
├── core/
│   ├── types.ts   # THE contract — every shared type
│   ├── run/       # Agent orchestrator, sandboxed engine, router, best-of-N
│   ├── swarm/     # Multi-agent swarm runner, signing, gates, rollback
│   ├── fleet/     # Manager judge, router, quota, feedback, learned routing
│   ├── goals/     # Goal store, milestone planner, conductor, advance
│   ├── vision/    # Elon strategist, end-state spec, playbook
│   ├── inbox/     # Proposal lifecycle: merge, apply, store
│   ├── sandbox/   # OS-level confinement: worktree, confine, audit, policy
│   ├── genome/    # Shared memory: store, recall, consolidate, playbook
│   ├── integrations/  # Telegram, iMessage, GitHub, Vercel, editors, Phantom
│   ├── comms/     # Bidirectional comms dispatch and handlers
│   ├── daemon/    # Continuous autonomous operator loop
│   ├── portfolio/ # Backlog scanners, value filter, EDV verify
│   ├── observability/ # Telemetry, spend rollup, budget alerts, OTLP
│   ├── learn/     # Reflect, playbooks, tuning
│   └── ...        # config, git, classify, index-engine, providers, doctor, mcp, …
├── raycast/       # Separate package (React/Raycast extension)
└── tui/           # Terminal UI renderer
test/              # Vitest suites organized by milestone
docs/
├── contracts/     # CONTRACT-M<N>.md — binding interface specs per milestone
├── SPEC-V4-FOUNDRY.md
├── SPEC-V5-OPEN-FLEET.md
├── SPEC-V6-VERIFICATION.md
└── ARCHITECTURE.md
```

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full module map and the autonomous loop.
