/**
 * M6: Project Lifecycle — Scaffolder
 *
 * Materializes a ProjectTemplate onto disk for `ashlr new`, then best-effort
 * runs `git init` and registers the project in the ashlr index.
 *
 * SAFETY GUARDRAILS:
 *   - REFUSES to write if the target directory already exists (no clobber).
 *   - Writes ONLY under spec.dir; every TemplateFile path is resolved relative
 *     to spec.dir and rejected if it escapes the directory.
 *   - NEVER throws — all failures surface via the returned ScaffoldResult.
 */

import { execSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  writeFileSync,
  chmodSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import {
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path';

import type {
  ScaffoldSpec,
  ScaffoldResult,
  TemplateFile,
} from '../types.js';
import { getTemplate } from './templates.js';

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

/** The default category bucket for new projects. */
export function defaultCategory(): string {
  return 'side-projects';
}

/**
 * The canonical root under which all scaffolded projects must live:
 * ~/Desktop/github. Used as the allowed-root for the in-tree write guard.
 */
export function githubRoot(): string {
  return resolve(join(homedir(), 'Desktop', 'github'));
}

/**
 * Resolve the canonical target directory for a project under the
 * ~/Desktop/github/<category>/<name> tree.
 */
export function targetDir(name: string, category: string): string {
  return resolve(join(homedir(), 'Desktop', 'github', category, name));
}

/**
 * True when `child` resolves to a path strictly inside `parent`
 * (or equal to it). Used to keep all writes under spec.dir.
 */
function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

// ---------------------------------------------------------------------------
// git
// ---------------------------------------------------------------------------

function gitInit(dir: string): { ok: boolean; warning?: string } {
  try {
    execSync('git init', { cwd: dir, stdio: 'pipe', timeout: 30_000 });
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, warning: `git init failed: ${msg}` };
  }
}

// ---------------------------------------------------------------------------
// stack recipe detection (warning-only; provisioning is done by the CLI layer)
// ---------------------------------------------------------------------------

function stackInstalled(): boolean {
  try {
    const out = execSync('which stack 2>/dev/null', { encoding: 'utf8' }).trim();
    return out.length > 0;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// index registration (best-effort; never blocks scaffold success)
// ---------------------------------------------------------------------------

/**
 * Register the new project in the ashlr index, SYNCHRONOUSLY.
 *
 * buildIndex / writeIndex / loadConfig are all synchronous in the real
 * index-engine, so registration completes before scaffoldProject returns and
 * the `registered` flag deterministically reflects the outcome (M6 contract).
 *
 * Modules are loaded via createRequire so this stays synchronous; failures and
 * the (test-only) async-buildIndex case surface as a non-fatal warning with
 * registered:false rather than blocking or throwing.
 */
function registerInIndex(): { registered: boolean; warning?: string } {
  try {
    const require = createRequire(import.meta.url);
    const indexMod = require('../index-engine.js') as {
      buildIndex: (cfg?: unknown) => unknown;
      writeIndex: (index: unknown) => void;
    };

    let configMod: { loadConfig?: () => unknown } | null = null;
    try {
      configMod = require('../config.js') as { loadConfig?: () => unknown };
    } catch {
      configMod = null;
    }

    const { buildIndex, writeIndex } = indexMod;

    let cfg: unknown = undefined;
    if (configMod && typeof configMod.loadConfig === 'function') {
      try {
        cfg = configMod.loadConfig();
      } catch {
        cfg = undefined;
      }
    }

    const built = buildIndex(cfg);
    // The real buildIndex is synchronous. If a caller (or a test mock) returns a
    // Promise, we cannot await it on this synchronous path — report it as a
    // non-fatal skip rather than registering a half-built index.
    if (built instanceof Promise) {
      return {
        registered: false,
        warning: 'index registration skipped: buildIndex returned a Promise (async index-engine)',
      };
    }
    writeIndex(built);
    return { registered: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { registered: false, warning: `index registration skipped: ${msg}` };
  }
}

// ---------------------------------------------------------------------------
// scaffoldProject
// ---------------------------------------------------------------------------

/** Synchronous index-registration function shape (injectable for tests). */
export type IndexRegistrar = () => { registered: boolean; warning?: string };

/**
 * Scaffold a project from its template into spec.dir.
 *
 * Returns a ScaffoldResult; never throws. Index registration runs
 * SYNCHRONOUSLY before returning, so `result.registered` deterministically
 * reflects the real outcome (M6 contract).
 *
 * @param register Optional injected registrar (defaults to the real
 *   createRequire-based synchronous registration). Tests inject a stub here
 *   because vitest's `vi.mock` intercepts dynamic `import()` but NOT
 *   `createRequire`, so the real index-engine cannot be mocked otherwise.
 */
export function scaffoldProject(
  spec: ScaffoldSpec,
  register: IndexRegistrar = registerInIndex,
): ScaffoldResult {
  const result: ScaffoldResult = {
    ok: false,
    dir: spec.dir,
    filesWritten: [],
    gitInitialized: false,
    mcpWired: false,
    registered: false,
    warnings: [],
  };

  try {
    // SAFETY (defense-in-depth): the write-performing layer self-defends. Refuse
    // any spec.dir that is not the cwd-relative `--here` form AND not strictly
    // inside ~/Desktop/github/. This stops out-of-tree creation even if a CLI
    // caller forgets to validate (e.g. a crafted --category). spec.allowAnyRoot
    // is the explicit opt-out used by hermetic tmp-dir tests.
    if (!spec.allowAnyRoot) {
      const root = githubRoot();
      const inTree = spec.dir === root || spec.dir.startsWith(root + sep);
      const here = isInside(resolve(process.cwd()), spec.dir);
      if (!inTree && !here) {
        result.error =
          `Refusing to scaffold outside the github tree: ${spec.dir} ` +
          `(allowed root: ${root}).`;
        return result;
      }
    }

    // SAFETY: refuse to overwrite an existing directory.
    if (existsSync(spec.dir)) {
      result.error = `Target directory already exists: ${spec.dir}. Refusing to overwrite.`;
      return result;
    }

    // Resolve the template.
    const template = getTemplate(spec.templateId);
    if (!template) {
      result.error = `Unknown template: "${spec.templateId}".`;
      return result;
    }

    // Build the file list.
    let files: TemplateFile[];
    try {
      files = template.files({ name: spec.name, category: spec.category });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      result.error = `Template "${spec.templateId}" failed to produce files: ${msg}`;
      return result;
    }

    // Create the root directory.
    mkdirSync(spec.dir, { recursive: true });

    // Write each file, guarding against path escape.
    let mcpWired = false;
    for (const file of files) {
      const targetPath = resolve(spec.dir, file.path);

      if (!isInside(spec.dir, targetPath)) {
        result.warnings.push(
          `skipped file outside project dir: ${file.path}`,
        );
        continue;
      }

      mkdirSync(dirname(targetPath), { recursive: true });
      writeFileSync(targetPath, file.content);

      if (typeof file.mode === 'number') {
        try {
          chmodSync(targetPath, file.mode);
        } catch {
          // mode is best-effort; ignore on platforms that reject it
        }
      }

      result.filesWritten.push(targetPath);

      // Detect the .mcp.json wiring the ashlr gateway.
      if (targetPath === resolve(spec.dir, '.mcp.json')) {
        try {
          const parsed = JSON.parse(file.content) as {
            mcpServers?: Record<string, unknown>;
          };
          if (parsed.mcpServers && 'ashlr' in parsed.mcpServers) {
            mcpWired = true;
          }
        } catch {
          // not valid JSON — leave mcpWired false
        }
      }
    }
    result.mcpWired = mcpWired;

    // stack recipe: warn (only) when requested but stack is not installed.
    if (spec.stackRecipe) {
      if (!stackInstalled()) {
        result.warnings.push(
          `stack recipe "${spec.stackRecipe}" requested but \`stack\` is not installed — skipping provisioning.`,
        );
      }
    }

    // git init (best-effort).
    if (spec.git) {
      const git = gitInit(spec.dir);
      result.gitInitialized = git.ok;
      if (git.warning) {
        result.warnings.push(git.warning);
      }
    }

    // Index registration (synchronous — buildIndex/writeIndex are sync). Doing
    // this inline makes `result.registered` deterministically reflect the real
    // outcome before we return, satisfying the M6 contract. Never throws.
    let reg: { registered: boolean; warning?: string };
    try {
      reg = register();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      reg = { registered: false, warning: `index registration skipped: ${msg}` };
    }
    if (reg.warning) {
      result.warnings.push(reg.warning);
    }
    result.registered = reg.registered;

    result.ok = true;
    return result;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    result.error = `Scaffold failed: ${msg}`;
    result.ok = false;
    return result;
  }
}
