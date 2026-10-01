/**
 * core/verse/agents/workspace-config.ts — a repo's `.ashlr/verse/workspace.json`
 * (the Conductor `.conductor/settings.toml` / Superset `.superset/config.json`
 * / Cursor `.cursor/worktrees.json` idea, in Verse's own shape):
 *
 *   {
 *     "setup":   "npm ci",
 *     "run":     [{ "name": "Dev server", "command": "npm run dev -- --port $ASHLR_PORT" }],
 *     "archive": "docker compose down",
 *     "copy":    [".env", ".env.local"],
 *     "ports":   10
 *   }
 *
 * Every field is optional; a repo with no file gets the defaults (no scripts,
 * copy `.env` when it exists, ten ports). A field that is wrong is IGNORED
 * with a warning the page shows — a typo in one script must not stop a new
 * agent from starting.
 *
 * THE SCRIPTS ARE THE REPO'S OWN — the same trust as its package.json
 * scripts, which the operator's own `npm run` already executes. They run in
 * the agent's worktree, never in the main checkout, with the workspace env
 * below; the operator starts each one (New agent runs setup; Run buttons run
 * the rest; Archive runs archive).
 *
 * `copy` entries are repo-relative FILE paths (no globs, no `..`, never under
 * `.git`), copied only when the source exists in the main checkout — the
 * `.worktreeinclude` idea for the gitignored files a fresh worktree lacks.
 *
 * PURE apart from `readWorkspaceConfig` (one bounded async read).
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  DEFAULT_WORKSPACE_PORTS,
  MAX_COPY_ENTRIES,
  MAX_RUN_SCRIPTS,
  MAX_SCRIPT_CHARS,
  MAX_WORKSPACE_PORTS,
  WORKSPACE_CONFIG_RELATIVE_PATH,
  WORKSPACE_PORT_BASE,
  WORKSPACE_PORT_CEILING,
  type WorkspaceConfig,
  type WorkspaceConfigRead,
  type WorkspaceEnv,
  type WorkspaceRunScript,
} from './types.js';

const CONFIG_MAX_BYTES = 64 * 1024;
const KNOWN_KEYS = new Set(['setup', 'run', 'archive', 'copy', 'ports']);

export const DEFAULT_WORKSPACE_CONFIG: WorkspaceConfig = Object.freeze({
  setup: null,
  run: [],
  archive: null,
  copy: ['.env'],
  ports: DEFAULT_WORKSPACE_PORTS,
}) as WorkspaceConfig;

function script(value: unknown, field: string, warnings: string[]): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') {
    warnings.push(`${field} must be a command string; ignored.`);
    return null;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > MAX_SCRIPT_CHARS || trimmed.includes('\0')) {
    warnings.push(`${field} is longer than ${MAX_SCRIPT_CHARS} characters (or holds a NUL); ignored.`);
    return null;
  }
  return trimmed;
}

/**
 * A copy entry the workspace may receive: a relative file path with no `..`
 * segment, no leading `/` or `~`, nothing under `.git`, no glob characters.
 */
export function isSafeCopyPath(raw: unknown): raw is string {
  if (typeof raw !== 'string') return false;
  const path = raw.trim();
  if (path.length === 0 || path.length > 256) return false;
  if (path.startsWith('/') || path.startsWith('~') || path.startsWith('-') || /^[A-Za-z]:/.test(path)) return false;
  if (/[*?[\]{}\0\\]/.test(path)) return false;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(path)) return false;
  const segments = path.split('/');
  if (segments.some((s) => s === '..' || s === '.' || s === '')) return false;
  if (segments[0]!.toLowerCase() === '.git') return false;
  return true;
}

/** Parse a workspace.json body (already JSON-decoded). Never throws. */
export function parseWorkspaceConfig(raw: unknown): WorkspaceConfigRead {
  const warnings: string[] = [];
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { config: { ...DEFAULT_WORKSPACE_CONFIG, copy: [...DEFAULT_WORKSPACE_CONFIG.copy] }, source: 'default', warnings: ['workspace.json is not a JSON object; using the defaults.'] };
  }
  const r = raw as Record<string, unknown>;
  for (const key of Object.keys(r)) if (!KNOWN_KEYS.has(key)) warnings.push(`Unknown key "${key.slice(0, 40)}" ignored.`);

  const run: WorkspaceRunScript[] = [];
  if (r['run'] !== undefined) {
    const entries = Array.isArray(r['run']) ? r['run'] : typeof r['run'] === 'string' ? [r['run']] : null;
    if (!entries) warnings.push('run must be a list of { name, command } (or one command string); ignored.');
    for (const [i, entry] of (entries ?? []).entries()) {
      if (run.length >= MAX_RUN_SCRIPTS) {
        warnings.push(`Only the first ${MAX_RUN_SCRIPTS} run scripts are used.`);
        break;
      }
      if (typeof entry === 'string') {
        const command = script(entry, `run[${i}]`, warnings);
        if (command) run.push({ name: run.length === 0 ? 'Run' : `Run ${run.length + 1}`, command });
        continue;
      }
      if (entry === null || typeof entry !== 'object') {
        warnings.push(`run[${i}] must be { name, command }; ignored.`);
        continue;
      }
      const e = entry as Record<string, unknown>;
      const command = script(e['command'], `run[${i}].command`, warnings);
      if (!command) continue;
      const name = typeof e['name'] === 'string' && e['name'].trim() ? e['name'].trim().slice(0, 40) : `Run ${run.length + 1}`;
      run.push({ name, command });
    }
  }

  let copy = [...DEFAULT_WORKSPACE_CONFIG.copy];
  if (r['copy'] !== undefined) {
    if (!Array.isArray(r['copy'])) {
      warnings.push('copy must be a list of repo-relative file paths; using [".env"].');
    } else {
      copy = [];
      for (const entry of r['copy']) {
        if (copy.length >= MAX_COPY_ENTRIES) {
          warnings.push(`Only the first ${MAX_COPY_ENTRIES} copy entries are used.`);
          break;
        }
        if (!isSafeCopyPath(entry)) {
          warnings.push(`copy entry ${JSON.stringify(String(entry).slice(0, 60))} is not a plain repo-relative file path; ignored.`);
          continue;
        }
        const clean = entry.trim();
        if (!copy.includes(clean)) copy.push(clean);
      }
    }
  }

  let ports = DEFAULT_WORKSPACE_PORTS;
  if (r['ports'] !== undefined) {
    const n = r['ports'];
    if (typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= MAX_WORKSPACE_PORTS) ports = n;
    else warnings.push(`ports must be a whole number from 0 to ${MAX_WORKSPACE_PORTS}; using ${DEFAULT_WORKSPACE_PORTS}.`);
  }

  return {
    config: {
      setup: script(r['setup'], 'setup', warnings),
      run,
      archive: script(r['archive'], 'archive', warnings),
      copy,
      ports,
    },
    source: 'file',
    warnings,
  };
}

/** Read `<root>/.ashlr/verse/workspace.json` (async, bounded). A missing file is the defaults. */
export async function readWorkspaceConfig(root: string): Promise<WorkspaceConfigRead> {
  let text: string;
  try {
    const buf = await readFile(join(root, WORKSPACE_CONFIG_RELATIVE_PATH));
    if (buf.length > CONFIG_MAX_BYTES) {
      return { config: { ...DEFAULT_WORKSPACE_CONFIG, copy: [...DEFAULT_WORKSPACE_CONFIG.copy] }, source: 'default', warnings: ['workspace.json is larger than 64 KB; using the defaults.'] };
    }
    text = buf.toString('utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    const warnings = code === 'ENOENT' || code === 'ENOTDIR' ? [] : ['workspace.json could not be read; using the defaults.'];
    return { config: { ...DEFAULT_WORKSPACE_CONFIG, copy: [...DEFAULT_WORKSPACE_CONFIG.copy] }, source: 'default', warnings };
  }
  try {
    return parseWorkspaceConfig(JSON.parse(text));
  } catch {
    return { config: { ...DEFAULT_WORKSPACE_CONFIG, copy: [...DEFAULT_WORKSPACE_CONFIG.copy] }, source: 'default', warnings: ['workspace.json is not valid JSON; using the defaults.'] };
  }
}

/** The env every script and terminal tab of a workspace gets. */
export function workspaceEnv(input: { path: string; name: string; rootPath: string; portBase: number; portCount: number }): WorkspaceEnv {
  return {
    ASHLR_WORKSPACE_PATH: input.path,
    ASHLR_WORKSPACE_NAME: input.name,
    ASHLR_ROOT_PATH: input.rootPath,
    ASHLR_PORT: String(input.portBase),
    ASHLR_PORT_COUNT: String(input.portCount),
  };
}

/**
 * A physical resource refusal, rather than a limit on the number of agents.
 * The API's existing public-error handler exposes only this fixed message.
 */
export class WorkspacePortsExhaustedError extends Error {
  readonly status = 409;
  readonly code = 'AGENT_PORTS_EXHAUSTED';

  constructor() {
    super('No free workspace port range is available. Archive an unused workspace or configure this repository with ports: 0 if it needs no dedicated ports.');
    this.name = 'WorkspacePortsExhaustedError';
  }
}

/** Zero-port workspaces have no reservation, even though ASHLR_PORT is set. */
export function portBlockAvailable(base: number, count: number, taken: ReadonlyArray<{ base: number; count: number }>): boolean {
  if (count === 0) return true;
  if (!Number.isSafeInteger(base) || !Number.isSafeInteger(count) || count < 1 || count > MAX_WORKSPACE_PORTS
    || base < WORKSPACE_PORT_BASE || base + count > WORKSPACE_PORT_CEILING) return false;
  return !taken.some((t) => t.count > 0 && base < t.base + t.count && t.base < base + count);
}

/**
 * The first free block of `count` ports at or above WORKSPACE_PORT_BASE that
 * overlaps no block in `taken`. Blocks are aligned to `max(count, 10)` so a
 * workspace keeps a recognisable range (41000, 41010, …). `count` 0 still
 * gets a base (ASHLR_PORT is always set) but reserves nothing.
 */
export function allocatePortBlock(count: number, taken: ReadonlyArray<{ base: number; count: number }>): number {
  if (count === 0) return WORKSPACE_PORT_BASE;
  if (!Number.isSafeInteger(count) || count < 1 || count > MAX_WORKSPACE_PORTS) throw new WorkspacePortsExhaustedError();
  const stride = Math.max(DEFAULT_WORKSPACE_PORTS, count);
  for (let base = WORKSPACE_PORT_BASE; base + count <= WORKSPACE_PORT_CEILING; base += stride) {
    if (portBlockAvailable(base, count, taken)) return base;
  }
  throw new WorkspacePortsExhaustedError();
}

/** A workspace slug from a title: `fix-login-redirect`, ≤ 40 chars, never empty. */
export function slugifyAgentName(title: string, now: Date = new Date()): string {
  const base = title
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
  if (base.length > 0 && /^[a-z0-9]/.test(base)) return base;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `agent-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
}

/** `name`, or `name-2`, `name-3`… — the first that `taken` does not contain. */
export function uniqueSlug(name: string, taken: (candidate: string) => boolean): string {
  if (!taken(name)) return name;
  for (let i = 2; i < 1000; i += 1) {
    const candidate = `${name.slice(0, 56)}-${i}`;
    if (!taken(candidate)) return candidate;
  }
  return `${name.slice(0, 48)}-${Date.now().toString(36)}`;
}
