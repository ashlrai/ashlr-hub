# CONTRACT-M6 — Project Lifecycle (`ashlr new` + `ashlr ship`)

All shared types live in `src/core/types.ts` (M6 section). Build agents import
from there and MUST NOT redefine shapes. Each module below is built by exactly
one agent that writes ONLY its own file(s). Zero new runtime deps. No commits.

## Types added to `src/core/types.ts`

- `TemplateFile { path:string; content:string; mode?:number }`
- `ProjectTemplate { id:string; title:string; description:string; files(ctx:{name:string;category:string}):TemplateFile[] }`
- `ScaffoldSpec { name:string; category:string; templateId:string; dir:string; git:boolean; stackRecipe?:string }`
- `ScaffoldResult { ok:boolean; dir:string; filesWritten:string[]; gitInitialized:boolean; mcpWired:boolean; registered:boolean; error?:string; warnings:string[] }`
- `ShipCheck { id:string; label:string; status:'pass'|'warn'|'fail'|'skip'; detail:string; fix?:string }`
- `ShipGate { checks:ShipCheck[]; summary:{pass:number;warn:number;fail:number;skip:number}; passed:boolean }`
- `ShipResult { gate:ShipGate; deployTarget:string|null; deployDryRun:boolean; deployRan:boolean; deployDetail:string }`

## Module signatures (EXACT — implement against these)

All import paths use `.js` extensions (NodeNext ESM).

### `src/core/lifecycle/templates.ts`
```ts
import type { ProjectTemplate } from '../types.js';

export const TEMPLATES: ProjectTemplate[];
export function getTemplate(id: string): ProjectTemplate | null;
export function listTemplates(): { id: string; title: string; description: string }[];
```
- `TEMPLATES` carries the four starters: `node-cli`, `mcp-server`, `next-app`,
  `minimal`. Each is a complete agentic-engineering starter whose `files(ctx)`
  returns: `CLAUDE.md` preset, `.mcp.json` wiring the ashlr gateway,
  `.ashlrcode/genome/` stub, `README.md`, `package.json`, `.gitignore`, and a
  minimal entry point. Pure data — no filesystem or network access.
- `getTemplate(id)` returns the matching template or `null`.
- `listTemplates()` returns id/title/description for each template (no `files`).

### `src/core/lifecycle/scaffold.ts`
```ts
import type { ScaffoldSpec, ScaffoldResult } from '../types.js';

export function scaffoldProject(spec: ScaffoldSpec): ScaffoldResult;
export function defaultCategory(): string;
export function targetDir(name: string, category: string): string;
```
- `scaffoldProject(spec)` REFUSES if `spec.dir` already exists (returns
  `{ ok:false, error:'…' }`, writes nothing). Writes only under `spec.dir`.
  Materializes the template's files, optionally `git init` (when `spec.git`),
  wires `.mcp.json` (sets `mcpWired`), registers in the index (sets
  `registered`), and optionally runs the `stack` recipe when `spec.stackRecipe`
  is set AND `stack` is installed (warning otherwise). Never throws.
- `defaultCategory()` returns `'side-projects'`.
- `targetDir(name, category)` returns the absolute path
  `<github root>/<category>/<name>` (under `~/Desktop/github`).

### `src/core/lifecycle/ship.ts`
```ts
import type { ShipGate } from '../types.js';

export async function runShipGate(
  projectPath: string,
  opts: { strict: boolean },
): Promise<ShipGate>;

export async function deploy(
  projectPath: string,
  target: string,
  opts: { confirm: boolean },
): Promise<{ ran: boolean; dryRun: boolean; detail: string }>;
```
- `runShipGate` is READ-ONLY. Runs a supply-chain check (`binshield` if
  installed, else a built-in dependency sanity check) plus `test`/`lint`/`build`
  for each npm script that exists. Produces a `ShipGate` with per-check status
  and a roll-up summary. `passed` is false when any check `fail`s; in `strict`
  mode any `fail` is terminal for the caller's exit code.
- `deploy` DRY-RUN BY DEFAULT: only runs the real deploy when `opts.confirm` is
  true. Targets: `vercel` / `stack` / `morphkit` / `gh`. Delegates to the named
  tool when installed; `morphkit` absent → guidance string ("morphkit not
  installed — see morphkit.dev"). Detect every tool at runtime via `which`.
  Returns `{ ran, dryRun, detail }`.

### `src/cli/new.ts`
```ts
export async function cmdNew(args: string[]): Promise<number>;
```
- Parses: `<name> [--template <t>] [--category <c>] [--stack <recipe>] [--here]
  [--no-git]`. Resolves spec (default category `side-projects`, default template
  `minimal`; `--here` scaffolds into cwd). Calls `scaffoldProject`, prints the
  result, returns process exit code (0 ok, non-zero on refusal/failure).

### `src/cli/ship.ts`
```ts
export async function cmdShip(args: string[]): Promise<number>;
```
- Parses: `[path] [--gate] [--deploy <target>] [--strict] [--confirm]`. Runs
  `runShipGate` (path defaults to cwd), prints the gate, then — when `--deploy`
  is given — calls `deploy` (DRY-RUN unless `--confirm`). Returns exit code:
  non-zero when `--strict` and the gate has any `fail`, else 0.

## Guardrails (top priority)
- `ashlr new` REFUSES to overwrite an existing directory; writes only under the
  chosen target dir.
- `ashlr ship` NEVER deploys, pushes, creates a repo, or runs any
  outward-facing/destructive action UNLESS `--confirm`. Default is DRY-RUN
  (print exactly what WOULD run). The gate/scan is read-only.
- Tool availability is detected at runtime via `which`. Currently present:
  `stack`, `vercel`, `gh`. Absent: `binshield` (use built-in dep check),
  `morphkit` (print guidance).
