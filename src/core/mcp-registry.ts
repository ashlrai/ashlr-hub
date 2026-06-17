/**
 * core/mcp-registry.ts — MCP server discovery registry.
 *
 * Scans known config file locations on this machine, extracts mcpServers
 * entries, deduplicates by name (first occurrence wins), and returns a
 * typed McpRegistry.  Never throws — unreadable or malformed files are
 * silently skipped.  Never prints or returns real env values; use
 * redactEnv() before displaying any spec.
 */

import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { McpRegistry, McpServerSpec } from './types.js';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * The known config file paths discovery scans, in scan order.  Absolute paths:
 *   ~/.claude.json, ~/.claude/settings.json, ~/.mcp.json,
 *   ~/.ashlrcode/settings.json, and ashlr-workbench agent settings.
 */
export function knownConfigPaths(): string[] {
  const home = homedir();
  return [
    join(home, '.claude.json'),
    join(home, '.claude', 'settings.json'),
    join(home, '.mcp.json'),
    join(home, '.ashlrcode', 'settings.json'),
    // ashlr-workbench agent settings (two candidate locations)
    join(home, '.ashlr-workbench', 'settings.json'),
    join(home, '.aw', 'settings.json'),
    // M66: hub-registered ecosystem servers live here; gateway aggregates them automatically.
    join(home, '.ashlr', 'settings.json'),
  ];
}

/**
 * Discover MCP servers already configured on this machine.
 *
 * Reads the known config paths (see knownConfigPaths), parses each
 * `mcpServers` object ({ <name>: { command, args, env? } }), and returns
 * deduped specs (dedupe by `name`; first occurrence wins, stable order).
 * Recognises the ashlr-plugin server (name "ashlr") and phantom
 * (name "phantom-secrets") when present.
 *
 * Never throws: unreadable/malformed configs are skipped silently.
 * When producing ANY printed/displayed form, redact every env value to '<set>'
 * via redactEnv().
 */
export function discoverMcpServers(paths?: string[]): McpRegistry {
  const seen = new Set<string>();
  const servers: McpServerSpec[] = [];

  // Paths may be injected (tests / callers that want a hermetic scan); default
  // to the machine's known config locations.
  const configPaths = paths ?? knownConfigPaths();

  for (const configPath of configPaths) {
    if (!existsSync(configPath)) continue;

    let parsed: unknown;
    try {
      const raw = readFileSync(configPath, 'utf8');
      parsed = JSON.parse(raw);
    } catch {
      // Unreadable or malformed — skip silently per contract.
      continue;
    }

    // Extract specs from all mcpServers objects in this file.
    const specsFromFile = extractSpecsFromConfig(parsed, configPath);
    for (const spec of specsFromFile) {
      if (!seen.has(spec.name)) {
        seen.add(spec.name);
        servers.push(spec);
      }
    }
  }

  return { servers };
}

/**
 * Return a copy of the spec with all env values replaced by the literal
 * string '<set>'.  Use this before printing or serialising for display.
 * Non-env fields are returned unchanged.
 */
export function redactEnv(spec: McpServerSpec): McpServerSpec {
  if (!spec.env || Object.keys(spec.env).length === 0) {
    return spec;
  }
  const redacted: Record<string, string> = {};
  for (const key of Object.keys(spec.env)) {
    redacted[key] = '<set>';
  }
  return { ...spec, env: redacted };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Shape of a single entry under an mcpServers map. */
interface RawServerEntry {
  command?: unknown;
  args?: unknown;
  env?: unknown;
}

/**
 * Extract McpServerSpec[] from a parsed config object.
 *
 * Handles two shapes Claude Code uses:
 *   1. Top-level `mcpServers` object.
 *   2. `projects[*].mcpServers` per-project objects.
 *
 * Also handles a flat top-level object that IS itself a server map
 * (some minimal configs omit the `mcpServers` wrapper).
 */
function extractSpecsFromConfig(parsed: unknown, source: string): McpServerSpec[] {
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return [];
  }

  const obj = parsed as Record<string, unknown>;
  const specs: McpServerSpec[] = [];

  // Shape 1: top-level mcpServers
  if (obj['mcpServers'] !== undefined) {
    const fromTop = specsFromMcpServersMap(obj['mcpServers'], source);
    specs.push(...fromTop);
  }

  // Shape 2: projects[*].mcpServers
  const projects = obj['projects'];
  if (projects !== null && typeof projects === 'object' && !Array.isArray(projects)) {
    const projectsMap = projects as Record<string, unknown>;
    for (const projectKey of Object.keys(projectsMap)) {
      const project = projectsMap[projectKey];
      if (project !== null && typeof project === 'object' && !Array.isArray(project)) {
        const proj = project as Record<string, unknown>;
        if (proj['mcpServers'] !== undefined) {
          const fromProject = specsFromMcpServersMap(proj['mcpServers'], source);
          specs.push(...fromProject);
        }
      }
    }
  }

  return specs;
}

/**
 * Convert a raw `mcpServers` value (expected: Record<string, RawServerEntry>)
 * into McpServerSpec[].  Skips any entry that lacks a usable `command` string.
 */
function specsFromMcpServersMap(raw: unknown, source: string): McpServerSpec[] {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return [];
  }

  const map = raw as Record<string, unknown>;
  const specs: McpServerSpec[] = [];

  for (const name of Object.keys(map)) {
    const entry = map[name];
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      continue;
    }

    const e = entry as RawServerEntry;

    // command is required and must be a string.
    if (typeof e.command !== 'string' || e.command.trim() === '') {
      continue;
    }

    // args: must be string[], default [].
    let args: string[] = [];
    if (Array.isArray(e.args)) {
      args = e.args.filter((a): a is string => typeof a === 'string');
    }

    // env: must be Record<string, string>, default undefined.
    let env: Record<string, string> | undefined;
    if (e.env !== null && typeof e.env === 'object' && !Array.isArray(e.env)) {
      const rawEnv = e.env as Record<string, unknown>;
      const safeEnv: Record<string, string> = {};
      for (const k of Object.keys(rawEnv)) {
        if (typeof rawEnv[k] === 'string') {
          safeEnv[k] = rawEnv[k] as string;
        }
      }
      if (Object.keys(safeEnv).length > 0) {
        env = safeEnv;
      }
    }

    const spec: McpServerSpec = {
      name,
      command: e.command.trim(),
      args,
      source,
    };
    if (env !== undefined) {
      spec.env = env;
    }

    specs.push(spec);
  }

  return specs;
}
