/**
 * core/tools-registry.ts — Detect installed ashlr ecosystem tools + versions.
 *
 * Probes each known tool via the platform PATH locator + a `--version` invocation
 * (version string). Fast, synchronous, and NEVER throws — a missing or broken
 * tool yields { installed: false, version: null, path: null }.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, win32 } from 'node:path';
import type { ToolInfo, ToolsRegistry } from './types.js';

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface ToolSpec {
  /** Stable id for the ToolInfo record. */
  id: string;
  /** Display name. */
  name: string;
  /**
   * Binary candidates to probe through PATH, in priority order.
   * The first hit wins.
   */
  binaries: string[];
  /**
   * Optional override for the version-extraction call.
   * Defaults to `[binary, '--version']`.
   * Pass `null` to skip the version probe entirely (path-only detection).
   */
  versionArgs?: string[] | null;
  /**
   * Optional post-processor for raw version output.
   * Receives trimmed stdout+stderr combined. Returns a clean version string
   * or null when no version can be parsed.
   */
  parseVersion?: (raw: string) => string | null;
  /**
   * When true, the binary name collides with a common system tool (e.g. `stack`
   * is Haskell's build tool, `ac` is login-accounting). A PATH lookup alone is
   * NOT enough to claim the ashlr tool is installed — we require a parseable
   * version probe so a system binary of the same name is not falsely reported.
   */
  ambiguous?: boolean;
  /**
   * For desktop app tools (e.g. Tauri apps) that install as .app bundles on
   * macOS and have no CLI binary in PATH. Paths are checked with existsSync in
   * order; the first existing path is used as the resolved path. When set,
   * `binaries` is ignored and version is always null (no CLI to query).
   */
  appPaths?: string[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const LOCATOR_TIMEOUT_MS = 3_000;
const VERSION_TIMEOUT_MS = 3_000;

/**
 * Resolve the absolute path of a binary using the platform PATH locator.
 * Returns null when the binary is not found or when the locator fails/times out.
 * Never throws.
 */
function findBinary(binary: string): string | null {
  try {
    let locator = 'which';
    let query = binary;
    if (process.platform === 'win32') {
      const systemRoot = process.env.SystemRoot ?? process.env.WINDIR;
      if (!systemRoot || !win32.isAbsolute(systemRoot)) return null;
      locator = win32.join(systemRoot, 'System32', 'where.exe');
      // The $PATH: prefix excludes the current directory from where.exe lookup.
      query = `$PATH:${binary}`;
    }
    const result = execFileSync(locator, [query], {
      encoding: 'utf8',
      timeout: LOCATOR_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return result.split(/\r?\n/u).map(line => line.trim()).find(Boolean) ?? null;
  } catch {
    return null;
  }
}

/**
 * Run a command and return its combined stdout+stderr as a trimmed string.
 * Returns null on any failure (non-zero exit, timeout, ENOENT, etc.).
 * Never throws.
 */
function runVersionCmd(args: string[]): string | null {
  if (args.length === 0) return null;
  const [cmd, ...rest] = args as [string, ...string[]];
  try {
    const stdout = execFileSync(cmd, rest, {
      encoding: 'utf8',
      timeout: VERSION_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return stdout.trim() || null;
  } catch (err: unknown) {
    // execFileSync throws on non-zero exit; stderr is often in err.stderr
    if (err !== null && typeof err === 'object') {
      const e = err as { stderr?: unknown; stdout?: unknown };
      const combined = [e.stdout, e.stderr]
        .map((v) => (typeof v === 'string' ? v.trim() : ''))
        .filter(Boolean)
        .join('\n');
      return combined || null;
    }
    return null;
  }
}

/**
 * Generic semver/version extractor: returns the first `X.Y.Z` or `X.Y` match
 * found in the raw string, or the whole trimmed string when no match exists
 * (capped at 80 chars to avoid swallowing multi-line output).
 */
function extractSemver(raw: string): string | null {
  if (!raw) return null;
  // Strip ANSI color codes so a colored CLI error never leaks into the version.
  // eslint-disable-next-line no-control-regex
  const clean = raw.replace(/\x1b\[[0-9;]*m/g, '');
  const match = clean.match(/\d+\.\d+(?:\.\d+)?(?:[-+][^\s]+)?/);
  if (match) return match[0];
  const firstLine = clean.split('\n')[0]?.trim();
  if (!firstLine) return null;
  // Reject obvious error/usage output (no version present) rather than showing it.
  if (/error|unknown|usage|illegal|not found|command/i.test(firstLine)) return null;
  return firstLine.slice(0, 80);
}

/**
 * Probe a tool whose presence is determined by a filesystem path (e.g. a macOS
 * .app bundle) rather than a CLI binary in PATH.
 * Returns the first existing path from the list, or null if none found.
 * Never throws.
 */
function probeAppPath(appPaths: string[]): string | null {
  for (const p of appPaths) {
    try {
      if (existsSync(p)) return p;
    } catch {
      // existsSync can throw on permission errors; treat as not-found
    }
  }
  return null;
}

/**
 * Try to read a version from a local package.json for the ashlr-hub binary,
 * walking up from the resolved executable's location.
 * Returns null on any failure.
 */
function ashlrHubVersionFromPackageJson(resolvedPath: string | null): string | null {
  if (!resolvedPath) return null;
  // The binary lives at <root>/bin/ashlr; package.json is at <root>/package.json
  // Try a few levels up.
  let dir = resolvedPath;
  for (let i = 0; i < 5; i++) {
    const parent = join(dir, '..');
    if (parent === dir) break;
    dir = parent;
    try {
      const raw = readFileSync(join(dir, 'package.json'), 'utf8');
      const pkg = JSON.parse(raw) as Record<string, unknown>;
      if (typeof pkg['version'] === 'string') return pkg['version'];
    } catch {
      // keep climbing
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Tool catalogue
// ---------------------------------------------------------------------------

const TOOL_SPECS: ToolSpec[] = [
  // ── phantom ───────────────────────────────────────────────────────────────
  {
    id: 'phantom',
    name: 'Phantom (secrets manager)',
    binaries: ['phantom'],
    parseVersion: extractSemver,
  },

  // ── ashlr-hub (this binary) ───────────────────────────────────────────────
  {
    id: 'ashlr-hub',
    name: 'ashlr-hub',
    binaries: ['ashlr'],
    // `ashlr --version` may work; if not, probeTool falls back to package.json.
    // No parseVersion override needed — probeTool defaults to extractSemver.
  },

  // ── ashlrcode CLI ─────────────────────────────────────────────────────────
  // NOTE: the generic `ac` alias was dropped — on macOS/Linux `ac` is the
  // system login-accounting binary (/usr/sbin/ac), which produced a false
  // 'ashlrcode installed' with a junk path/version. Probe the real name only.
  {
    id: 'ashlrcode',
    name: 'ashlrcode',
    binaries: ['ashlrcode'],
    parseVersion: extractSemver,
  },

  // ── ashlr-plugin (Claude Code MCP plugin) ─────────────────────────────────
  {
    id: 'ashlr-plugin',
    name: 'ashlr-plugin (Claude Code MCP)',
    binaries: ['ashlr', 'ashlr-plugin'],
    parseVersion: extractSemver,
  },

  // ── aw / ashlr-workbench ──────────────────────────────────────────────────
  {
    id: 'aw',
    name: 'ashlr-workbench (aw)',
    binaries: ['aw', 'ashlr-workbench'],
    parseVersion: extractSemver,
  },

  // ── stack ─────────────────────────────────────────────────────────────────
  // `stack` collides with the Haskell build tool — require a parseable version
  // before claiming installed (see ToolSpec.ambiguous).
  {
    id: 'stack',
    name: 'stack',
    binaries: ['stack'],
    parseVersion: extractSemver,
    ambiguous: true,
  },

  // ── pulse / pulse-agent ───────────────────────────────────────────────────
  {
    id: 'pulse',
    name: 'pulse-agent',
    binaries: ['pulse', 'pulse-agent'],
    parseVersion: extractSemver,
  },

  // ── morphkit ─────────────────────────────────────────────────────────────
  {
    id: 'morphkit',
    name: 'morphkit',
    binaries: ['morphkit'],
    parseVersion: extractSemver,
  },

  // ── binshield ─────────────────────────────────────────────────────────────
  {
    id: 'binshield',
    name: 'binshield',
    binaries: ['binshield'],
    parseVersion: extractSemver,
  },

  // ── ashlr-md ─────────────────────────────────────────────────────────────
  // ashlr-md is a Tauri desktop APP, not a CLI — there is no `ashlr-md` binary
  // in PATH. Detection uses filesystem presence of the .app bundle on macOS.
  // Version is always null (no CLI to query); path points to the app bundle.
  {
    id: 'ashlr-md',
    name: 'ashlr-md',
    binaries: [],
    versionArgs: null,
    appPaths: [
      '/Applications/Ashlr MD.app',
      `${process.env['HOME'] ?? ''}/Applications/Ashlr MD.app`,
    ],
  },
];

// ---------------------------------------------------------------------------
// Probe a single tool
// ---------------------------------------------------------------------------

/**
 * Probe a single ToolSpec and return a ToolInfo.
 * Never throws.
 */
function probeTool(spec: ToolSpec): ToolInfo {
  // App-type tools (e.g. Tauri desktop apps) are detected by filesystem path,
  // not by a CLI binary in PATH. Short-circuit before the locator probe.
  if (spec.appPaths && spec.appPaths.length > 0) {
    const appPath = probeAppPath(spec.appPaths);
    if (appPath) {
      return { id: spec.id, name: spec.name, installed: true, version: null, path: appPath };
    }
    return { id: spec.id, name: spec.name, installed: false, version: null, path: null };
  }

  // 1. Resolve the binary path (first candidate the platform locator finds).
  let resolvedPath: string | null = null;
  let resolvedBinary: string | null = null;
  for (const bin of spec.binaries) {
    const p = findBinary(bin);
    if (p) {
      resolvedPath = p;
      resolvedBinary = bin;
      break;
    }
  }

  if (!resolvedPath || !resolvedBinary) {
    return { id: spec.id, name: spec.name, installed: false, version: null, path: null };
  }

  // 2. Version probe.
  let version: string | null = null;

  if (spec.versionArgs !== null) {
    // Execute the located path, not a second PATH lookup that could resolve a
    // different file. Windows script shims fail closed because no shell is used.
    const args: string[] = spec.versionArgs ?? [resolvedPath, '--version'];
    const raw = runVersionCmd(args);

    if (raw) {
      version = spec.parseVersion ? spec.parseVersion(raw) : extractSemver(raw);
    }

    // Special case: ashlr-hub / ashlr-plugin share the `ashlr` binary, whose
    // `--version` may be unsupported; fall back to a nearby package.json.
    if (!version && (spec.id === 'ashlr-hub' || spec.id === 'ashlr-plugin')) {
      version = ashlrHubVersionFromPackageJson(resolvedPath);
    }
  }

  // Ambiguous binary names (e.g. `stack`) collide with common system tools.
  // PATH lookup succeeding is NOT proof the ashlr tool is present — require a
  // parseable version, else report not-installed to avoid false positives that
  // inflate installedCount and falsely pass the doctor 'ashlr-tools-installed'
  // check.
  if (spec.ambiguous && !version) {
    return { id: spec.id, name: spec.name, installed: false, version: null, path: null };
  }

  return { id: spec.id, name: spec.name, installed: true, version, path: resolvedPath };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Detect installed ecosystem tools + versions via PATH lookup + --version or
 * filesystem presence for desktop app tools (e.g. ashlr-md .app bundle).
 * Fast and NEVER throws — a missing tool yields { installed:false, version:null,
 * path:null }. Detects: phantom, ashlr/ashlr-plugin, stack, pulse/pulse-agent,
 * ashlrcode, aw (ashlr-workbench), morphkit, binshield, ashlr-md (app), ashlr-hub.
 */
export function getToolsRegistry(): ToolsRegistry {
  const tools: ToolInfo[] = [];

  for (const spec of TOOL_SPECS) {
    try {
      tools.push(probeTool(spec));
    } catch {
      // Should never happen (probeTool never throws), but belt-and-suspenders.
      tools.push({
        id: spec.id,
        name: spec.name,
        installed: false,
        version: null,
        path: null,
      });
    }
  }

  const installedCount = tools.filter((t) => t.installed).length;
  return { tools, installedCount };
}
