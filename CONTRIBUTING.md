# Contributing to ashlr-hub

ashlr-hub is the local kernel for Ashlr Universe, built contract-first in TypeScript with a React operations console. This guide covers source development and local verification, not provider commissioning or production publication. See the [documentation map](docs/README.md) for the current runtime and operator guides.

---

## Prerequisites

- **Node.js 22.15+** for the package runtime. A release gate can require stricter, exact tool versions; use the [release policy](docs/RELEASING.md#local-verification-for-the-340-successor) for release verification.
- **git** on `PATH`
- `~/.local/bin` on your `PATH` if you want to install the CLI locally
- Optional (only exercised at runtime by specific commands): `phantom`, `ollama`, LM Studio, `gh`, `vercel`, `claude`, `codex`. None are required to build or test.

The backend uses TypeScript/ESM, `tsx`, Vitest and ESLint. The web console uses
React, Vite, Testing Library and jsdom. [package.json](package.json) and the
lockfile are the canonical dependency inventory; do not maintain another version
list in a guide.

---

## Setup

```sh
npm ci          # clean, lockfile-exact install of devDependencies
```

Run verification locally; GitHub Actions are repository-disabled and are not a
prerequisite for contributing. The tracked historical `Dependency Audit` workflow
is a reference, not a currently running check. Dependency changes must keep the
affected manifest and lockfile consistent, including separately packaged Raycast
or desktop dependencies when those are in scope.

The package bundles its declared runtime dependencies for offline installation.
See [Dependency boundary](#dependency-boundary) below.

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
| `npm test` | Run the backend unit and real-I/O lanes once (`vitest run`); web tests are separate |
| `npm run test:serial` | Run tests without file parallelism — required for tests that touch the same home dir |
| `npm run test:ci` | Run backend lanes locally with isolated test homes, inactivity detection and a hard runtime cap |
| `npm run test:web` | Run the separate jsdom/Testing Library console suite |
| `npm run dev:web` | Run the Vite development server; it does not commission providers or enable dispatch |
| `npm run lint` | ESLint plus the real-I/O lane membership guard |
| `npm run check:docs` | Validate operator documentation file links and anchors locally, without network requests |
| `npm run typecheck` | Strict backend and web type checks, without emitting files |
| `npm run build` | Compile backend, copy assets, build the web console, then generate dependency inventory and Git build identity in `dist/` |

`bin/ashlr` is a thin ESM shim that imports `dist/cli/index.js`, so the installed binary always runs the compiled output. For fast iteration, use `npm run dev` (runs `src/cli/index.ts` directly through `tsx`).

### Definition of green

A source change is locally verified when these checks pass:

```sh
npm run typecheck
npm run lint
npm run test:ci
npm run test:web
npm run check:docs
npm run build
```

Preserve meaningful coverage. Backend tests live under `test/`; DOM tests live
beside the web features under `src/web-ui/`. Start with focused tests while
iterating, then run the applicable full gates. Report skipped or unavailable
platform checks separately. A passing source suite is not installed-artifact,
provider, production or user-acceptance evidence. Release work uses the stronger
[local production gate](docs/RELEASING.md#local-verification-for-the-340-successor).

### Running tests hermetically on the local host

```sh
npm run test:ci
```

Despite its name, `test:ci` is a local command. It isolates HOME/ASHLR_HOME and
exits with code 124 if Vitest produces no output for
`ASHLR_TEST_CI_IDLE_TIMEOUT_MS` (default 5 minutes) or exceeds
`ASHLR_TEST_CI_TIMEOUT_MS` (default 30 minutes). The diagnostics distinguish an
inactive process from an actively progressing suite that reaches the hard cap;
only inactivity after Vitest's final summary is evidence of a possible leaked
handle. The runner preserves the separate worker limits of the unit and
serialized real-I/O lanes defined in [vitest.config.ts](vitest.config.ts).

The tracked hosted workflows retain Ubuntu and Windows portability definitions
as historical contracts. Their presence is not evidence that those jobs ran.
Do not enable or dispatch GitHub Actions to complete a local change.

---

## Conventions

### ESM / NodeNext — `.js` import extensions

The project is `"type": "module"` with `module`/`moduleResolution` set to `NodeNext`. **Always import sibling modules with the `.js` extension**, even though the source file is `.ts`:

```ts
import { getGitStatus } from './git.js';        // not './git' or './git.ts'
import type { AshlrConfig } from './types.js';
```

NodeNext resolution requires this at runtime for the backend. The separately
configured `src/web-ui/` tree uses Vite's bundler resolution; follow its existing
imports and never introduce Node-only runtime imports into browser modules.

### Strict TypeScript

`tsconfig.json` enables `strict`, plus `noImplicitOverride`, `noUnusedLocals`, `noUnusedParameters`, and `noFallthroughCasesInSwitch`. Write code that passes `npm run typecheck` with zero suppressions. Avoid `any`; use the canonical types owned by the relevant subsystem.

### Dependency boundary

`src/core/` and `src/cli/` primarily use Node builtins. The declared runtime
dependencies are `@modelcontextprotocol/sdk` for MCP, `marked` for external-skill
Markdown analysis, and `tar` for managed-runtime archives. They are bundled in
the package and verified by the release dependency inventory. **Do not add a
runtime dependency casually:** reuse an existing utility first, and change the
dependency contract, lockfile, inventory and verification together if a new
dependency is justified. React/Vite build dependencies do not make Node-only
core modules safe to import into the browser.

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

1. **Use the owning subsystem's canonical types.** `src/core/types.ts` holds shared Hub types. Universe, Resources and local-runtime also own focused type modules; import their existing contracts instead of duplicating them or growing a global catch-all. Browser consumers should use type-only imports for server DTOs.

2. **`CONTRACT.md` plus per-milestone files** (`docs/contracts/CONTRACT-M<N>.md`) are the binding interface spec. Each pins the exported function signatures and type shapes a milestone's modules must satisfy. Do not change an exported signature without updating the corresponding contract file in the same change.

3. **Build to the contract.** Implement against the declared signatures so that modules written independently compose cleanly.

When changing a public surface, identify its owning type module and any binding
contract, update those together, then implement and test. Routine changes do not
require a new milestone document when an existing canonical contract is enough.

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
8. **Merge requires explicit policy and verification.** Default tier mode requires frontier provenance and a matching `mergeAuthority` entry. Opt-in verification/evidence modes have their own stricter gates; no producer verdict, test result or documentation change grants authority by itself. See the [README safety model](README.md#safety-model) and `test/m47.*`, `test/m153.*`, `test/m307.*`.
9. **Self-improvement cannot self-disarm.** Self-target diffs must pass the suite flag-off and flag-on. Safety-test-weakening diffs refused. Test: `test/m54.*`.
10. **Preserve the declared dependency boundary.** Manifest, lockfile and packaged dependency inventory must agree; do not bypass the associated tests.

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
- A commit must preserve the [local verification gates](#definition-of-green), including web and documentation checks when those surfaces change.
- Do not commit `dist/` (it is git-ignored) or machine-specific paths.
- Milestone commits follow the pattern: `feat: M<N> <short description>` and update the milestone row in the relevant `docs/SPEC-V*.md`.

---

## Project layout

```
src/
├── cli/           # Thin argv dispatchers — parse, delegate to core, format output
├── core/
│   ├── types.ts   # Shared Hub types; subsystems also own focused contracts
│   ├── universe/  # Experiments, evaluation, campaigns, archive, graph, delivery
│   ├── resources/ # Worker bindings, quota admission, ledger, foreground queue
│   ├── local-runtime/ # Pinned package install, verification and rollback
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
├── web-ui/        # React console, feature-local DOM tests, Vite entrypoints
├── raycast/       # Separate package (React/Raycast extension)
└── tui/           # Terminal UI renderer
test/              # Vitest suites organized by milestone
docs/
├── README.md      # Canonical documentation map
├── contracts/     # CONTRACT-M<N>.md — binding interface specs per milestone
├── SPEC-V4-FOUNDRY.md
├── SPEC-V5-OPEN-FLEET.md
├── SPEC-V6-VERIFICATION.md
└── ARCHITECTURE.md
```

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full module map and the autonomous loop.
