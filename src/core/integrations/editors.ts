/**
 * core/integrations/editors.ts — Editor MCP gateway wiring (M18).
 *
 * detectEditors(): detect which of claude / codex / cursor are present by
 *   their config directories or files.
 *
 * wireEditor(target, opts): wire the ashlr MCP gateway entry into one editor's
 *   mcpServers config, reusing the M3 install pattern (backup-first, deep-merge,
 *   idempotent, never clobbers existing servers). LOCAL only. `opts.configPath`
 *   overrides the default path so tests can run against TEMP files.
 *
 * SAFETY RULES (matching M3 contract):
 *   - Parse the config file FIRST; abort without writing on malformed JSON.
 *   - Backup (.bak) ONLY after a clean parse.
 *   - Idempotent: re-running when the entry is already present is a no-op.
 *   - Never clobber other mcpServers entries or other top-level config keys.
 *   - Never throws — all errors are caught and returned as {ok:false, detail}.
 *   - LOCAL only: writes only the target editor's config file.
 *
 * Genome note: ~/.ashlr already serves as the genome store; no extra wiring
 * is needed here — the mcpServers entry is sufficient for the gateway.
 */

import { readFileSync, writeFileSync, existsSync, copyFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';

// ---------------------------------------------------------------------------
// Editor config paths
// ---------------------------------------------------------------------------

const HOME = homedir();

/**
 * Default config file paths for each supported editor target.
 * Claude Code: ~/.claude/settings.json (preferred; falls back to ~/.claude.json)
 * Codex:       ~/.codex/config.json
 * Cursor:      ~/.cursor/mcp.json
 */
const DEFAULT_CONFIG_PATHS: Record<'claude' | 'codex' | 'cursor', string> = {
  claude: join(HOME, '.claude', 'settings.json'),
  codex:  join(HOME, '.codex', 'config.json'),
  cursor: join(HOME, '.cursor', 'mcp.json'),
};

/**
 * Config directory presence checks for detectEditors.
 * An editor is "detected" if its primary config directory (or file) exists.
 */
const DETECTION_PATHS: Record<'claude' | 'codex' | 'cursor', string[]> = {
  claude: [join(HOME, '.claude'), join(HOME, '.claude.json')],
  codex:  [join(HOME, '.codex')],
  cursor: [join(HOME, '.cursor')],
};

// ---------------------------------------------------------------------------
// Config file shape
// ---------------------------------------------------------------------------

/** Shape of a single mcpServers entry. */
interface McpServerEntry {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

/** Top-level config shape (only what we care about; all other keys preserved). */
interface ConfigFileShape {
  mcpServers?: Record<string, McpServerEntry>;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Sentinel for malformed JSON (matches M3 pattern)
// ---------------------------------------------------------------------------

class ConfigParseError extends Error {
  constructor(public readonly path: string) {
    super(`config is not valid JSON: ${path}`);
    this.name = 'ConfigParseError';
  }
}

// ---------------------------------------------------------------------------
// Internal helpers (same contract as M3)
// ---------------------------------------------------------------------------

/**
 * Parse a target config file.
 *   - absent or empty            → {} (fresh config, may safely create)
 *   - present + valid JSON       → parsed object
 *   - present + unparseable JSON → throws ConfigParseError (caller must abort;
 *     we NEVER derive a merged write from a file we failed to parse)
 */
function parseConfigFile(filePath: string): ConfigFileShape {
  if (!existsSync(filePath)) return {};
  const raw = readFileSync(filePath, 'utf8').trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw) as ConfigFileShape;
  } catch {
    throw new ConfigParseError(filePath);
  }
}

/**
 * Backup a config file to <path>.bak.
 * If a .bak already exists, rotate it to <path>.bak.<timestamp> first so a
 * second run never destroys an earlier backup (best-effort; never blocks write).
 */
function backupConfig(configPath: string): void {
  const bakPath = configPath + '.bak';
  if (existsSync(bakPath)) {
    try {
      copyFileSync(bakPath, `${bakPath}.${Date.now()}`);
    } catch {
      // Best-effort — never block on backup-of-backup failure.
    }
  }
  copyFileSync(configPath, bakPath);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Detect which editors are installed on this machine by checking for the
 * presence of their primary config directory or config file.
 *
 * Returns a subset of ['claude', 'codex', 'cursor'].
 * Never throws.
 */
export function detectEditors(): string[] {
  const detected: string[] = [];
  const targets = ['claude', 'codex', 'cursor'] as const;

  for (const target of targets) {
    const paths = DETECTION_PATHS[target];
    const found = paths.some(p => existsSync(p));
    if (found) {
      detected.push(target);
    }
  }

  return detected;
}

/**
 * Wire the ashlr MCP gateway into one editor's mcpServers config.
 *
 * Follows the M3 install pattern exactly:
 *   1. Parse FIRST — abort without any write if config is malformed JSON.
 *   2. Backup (.bak) after a clean parse, only if the file exists.
 *   3. Idempotency — if the "ashlr" entry already matches, return ok without writing.
 *   4. Deep-merge — spread existing config + mcpServers, add/update only "ashlr".
 *   5. Write the merged result as pretty-printed JSON.
 *
 * @param target    - Editor to wire: 'claude' | 'codex' | 'cursor'
 * @param opts.configPath - Override the default config path (use a TEMP path in tests).
 * @returns { ok: boolean; detail: string } — never throws.
 */
export async function wireEditor(
  target: 'claude' | 'codex' | 'cursor',
  opts: { configPath?: string },
): Promise<{ ok: boolean; detail: string }> {
  const configPath = opts.configPath ?? DEFAULT_CONFIG_PATHS[target];

  // The gateway entry we install — command via PATH so any editor resolves it.
  const gatewayEntry: McpServerEntry = {
    command: 'ashlr',
    args:    ['mcp'],
  };

  // ── 1. Parse FIRST — abort on malformed input, before any write/backup ────
  let existing: ConfigFileShape;
  try {
    existing = parseConfigFile(configPath);
  } catch (err) {
    if (err instanceof ConfigParseError) {
      return {
        ok:     false,
        detail: `refusing to write: ${configPath} is not valid JSON; restore it or pass a clean configPath.`,
      };
    }
    // Unexpected read error (permissions, etc.)
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, detail: `failed to read config: ${msg}` };
  }

  // ── 2. Backup (only after a clean parse, only if file exists) ─────────────
  if (existsSync(configPath)) {
    try {
      backupConfig(configPath);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, detail: `backup failed: ${msg}` };
    }
  } else {
    // Ensure the parent directory exists so the write succeeds.
    try {
      mkdirSync(dirname(configPath), { recursive: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, detail: `could not create config directory: ${msg}` };
    }
  }

  // ── 3. Idempotency check ───────────────────────────────────────────────────
  const existingServers = existing.mcpServers ?? {};
  const existingEntry = existingServers['ashlr'];

  if (existingEntry) {
    const same =
      existingEntry.command === gatewayEntry.command &&
      JSON.stringify(existingEntry.args ?? []) === JSON.stringify(gatewayEntry.args ?? []);

    if (same) {
      return {
        ok:     true,
        detail: `already wired — no changes needed (${configPath})`,
      };
    }
    // Entry exists but differs — will update below.
  }

  // ── 4. Deep-merge: add/update "ashlr" key only, preserve all others ───────
  const merged: ConfigFileShape = {
    ...existing,
    mcpServers: {
      ...existingServers,
      ashlr: gatewayEntry,
    },
  };

  // ── 5. Write ───────────────────────────────────────────────────────────────
  try {
    writeFileSync(configPath, JSON.stringify(merged, null, 2) + '\n', 'utf8');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, detail: `write failed: ${msg}` };
  }

  const action = existingEntry ? 'updated' : 'wired';
  return {
    ok:     true,
    detail: `${action} ashlr gateway → ${configPath}`,
  };
}
