/**
 * Editor MCP gateway wiring (M18).
 *
 * Each client has a different supported user-level registry:
 *   - Claude Code: ~/.claude.json (mcpServers)
 *   - Codex / ChatGPT Desktop: ~/.codex/config.toml, managed by `codex mcp`
 *   - Cursor: ~/.cursor/mcp.json (mcpServers)
 *
 * Codex is intentionally delegated to its official CLI so this module never
 * attempts to parse and rewrite a user's TOML configuration. JSON registries
 * retain the established parse-first, backup-first, deep-merge contract.
 */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';

export type EditorTarget = 'claude' | 'codex' | 'cursor';

export const ASHLR_HUB_MCP_SERVER = 'ashlr-hub';
const MAX_COMMAND_OUTPUT_BYTES = 256 * 1024;

const HOME = homedir();

const DEFAULT_CONFIG_PATHS: Record<EditorTarget, string> = {
  claude: join(HOME, '.claude.json'),
  codex: join(HOME, '.codex', 'config.toml'),
  cursor: join(HOME, '.cursor', 'mcp.json'),
};

const DETECTION_PATHS: Record<EditorTarget, string[]> = {
  claude: [join(HOME, '.claude'), join(HOME, '.claude.json')],
  codex: [join(HOME, '.codex')],
  cursor: [join(HOME, '.cursor')],
};

interface McpServerEntry {
  type?: 'stdio';
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

interface ConfigFileShape {
  mcpServers?: Record<string, McpServerEntry>;
  [key: string]: unknown;
}

interface CommandResult {
  ok: boolean;
  code: number | null;
  stdout: string;
  stderr: string;
  launchError?: string;
}

type CommandRunner = (
  executable: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv },
) => Promise<CommandResult>;

export interface WireEditorOptions {
  /** Hermetic override. Codex overrides must still be named config.toml. */
  configPath?: string;
  /** Test seam; production uses the local vendor CLI. */
  runCommand?: CommandRunner;
}

class ConfigParseError extends Error {
  constructor(public readonly path: string, detail = 'config is not valid JSON') {
    super(`${detail}: ${path}`);
    this.name = 'ConfigParseError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseJsonConfig(filePath: string): ConfigFileShape {
  if (!existsSync(filePath)) return {};
  const raw = readFileSync(filePath, 'utf8').trim();
  if (!raw) return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ConfigParseError(filePath);
  }

  if (!isRecord(parsed)) {
    throw new ConfigParseError(filePath, 'config root must be a JSON object');
  }
  if (parsed['mcpServers'] !== undefined && !isRecord(parsed['mcpServers'])) {
    throw new ConfigParseError(filePath, 'mcpServers must be a JSON object');
  }
  return parsed as ConfigFileShape;
}

function backupConfig(configPath: string): void {
  const bakPath = `${configPath}.bak`;
  if (existsSync(bakPath)) {
    try {
      copyFileSync(bakPath, `${bakPath}.${Date.now()}`);
    } catch {
      // Best effort only; the current config backup below remains mandatory.
    }
  }
  copyFileSync(configPath, bakPath);
}

function sameStringArray(left: unknown, right: string[]): boolean {
  return Array.isArray(left)
    && left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function sameJsonEntry(entry: McpServerEntry | undefined, expected: McpServerEntry): boolean {
  if (entry?.command !== expected.command
    || !sameStringArray(entry.args ?? [], expected.args ?? [])) return false;
  if (expected.type !== undefined && entry.type !== undefined && entry.type !== expected.type) return false;
  if (entry.env !== undefined) {
    if (!isRecord(entry.env) || Object.keys(entry.env).length > 0) return false;
  }
  return true;
}

async function defaultCommandRunner(
  executable: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv },
): Promise<CommandResult> {
  return await new Promise((resolve) => {
    const child = spawn(executable, args, {
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (result: CommandResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      finish({ ok: false, code: null, stdout, stderr, launchError: 'command timed out after 15 seconds' });
    }, 15_000);
    const capture = (current: string, chunk: Buffer): string | null => {
      if (Buffer.byteLength(current) + chunk.length > MAX_COMMAND_OUTPUT_BYTES) return null;
      return current + chunk.toString();
    };
    child.stdout.on('data', (chunk: Buffer) => {
      const next = capture(stdout, chunk);
      if (next === null) {
        child.kill('SIGTERM');
        finish({ ok: false, code: null, stdout, stderr, launchError: 'command output exceeded 256 KiB safety limit' });
      } else {
        stdout = next;
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      const next = capture(stderr, chunk);
      if (next === null) {
        child.kill('SIGTERM');
        finish({ ok: false, code: null, stdout, stderr, launchError: 'command output exceeded 256 KiB safety limit' });
      } else {
        stderr = next;
      }
    });
    child.once('error', error => {
      finish({ ok: false, code: null, stdout, stderr, launchError: error.message });
    });
    child.once('close', code => {
      finish({ ok: code === 0, code, stdout, stderr });
    });
  });
}

function parseCodexEntry(stdout: string): McpServerEntry | null {
  try {
    const parsed = JSON.parse(stdout) as unknown;
    if (!isRecord(parsed) || !isRecord(parsed['transport'])) return null;
    const transport = parsed['transport'];
    if (transport['type'] !== 'stdio' || typeof transport['command'] !== 'string') return null;
    const args = transport['args'];
    if (!Array.isArray(args) || !args.every(value => typeof value === 'string')) return null;
    return { type: 'stdio', command: transport['command'], args: args as string[] };
  } catch {
    return null;
  }
}

function codexConfigError(result: CommandResult): boolean {
  const output = `${result.stderr}\n${result.stdout}`;
  return /(?:error|failed) (?:loading|parsing) config\.toml|toml parse/i.test(output);
}

function codexServerNotFound(result: CommandResult): boolean {
  const output = `${result.stderr}\n${result.stdout}`;
  return new RegExp(`no MCP server named ['"]${ASHLR_HUB_MCP_SERVER}['"] found`, 'i').test(output);
}

async function wireCodex(configPath: string, runCommand: CommandRunner): Promise<{ ok: boolean; detail: string }> {
  if (basename(configPath) !== 'config.toml') {
    return {
      ok: false,
      detail: `Codex config override must end in config.toml; got ${configPath}`,
    };
  }

  const env = { ...process.env, CODEX_HOME: dirname(configPath) };
  const getArgs = ['mcp', 'get', ASHLR_HUB_MCP_SERVER, '--json'];
  const expected: McpServerEntry = { type: 'stdio', command: 'ashlr', args: ['mcp'] };
  const current = await runCommand('codex', getArgs, { env });

  if (current.launchError) {
    return { ok: false, detail: `Codex CLI unavailable: ${current.launchError}` };
  }
  if (current.ok) {
    const entry = parseCodexEntry(current.stdout);
    if (sameJsonEntry(entry ?? undefined, expected)) {
      return { ok: true, detail: `already wired — no changes needed (${configPath})` };
    }
    return {
      ok: false,
      detail: `${ASHLR_HUB_MCP_SERVER} already exists with a different Codex configuration; inspect it with codex mcp get ${ASHLR_HUB_MCP_SERVER} --json`,
    };
  }
  if (codexConfigError(current)) {
    return { ok: false, detail: `refusing to write: Codex could not parse ${configPath}` };
  }
  if (!codexServerNotFound(current)) {
    const detail = current.stderr.trim() || current.stdout.trim() || `exit ${current.code ?? 'unknown'}`;
    return { ok: false, detail: `could not inspect Codex MCP registry; refusing to write: ${detail}` };
  }

  try {
    if (existsSync(configPath)) {
      backupConfig(configPath);
    } else {
      mkdirSync(dirname(configPath), { recursive: true });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, detail: `could not prepare Codex config: ${msg}` };
  }

  const added = await runCommand(
    'codex',
    ['mcp', 'add', ASHLR_HUB_MCP_SERVER, '--', 'ashlr', 'mcp'],
    { env },
  );
  if (!added.ok) {
    const detail = added.launchError ?? added.stderr.trim() ?? added.stdout.trim() ?? `exit ${added.code ?? 'unknown'}`;
    return { ok: false, detail: `codex mcp add failed: ${detail}` };
  }

  const verified = await runCommand('codex', getArgs, { env });
  const verifiedEntry = verified.ok ? parseCodexEntry(verified.stdout) : null;
  if (!sameJsonEntry(verifiedEntry ?? undefined, expected)) {
    return {
      ok: false,
      detail: `Codex registration command completed but ${ASHLR_HUB_MCP_SERVER} could not be verified`,
    };
  }

  return {
    ok: true,
    detail: `wired ${ASHLR_HUB_MCP_SERVER} via codex mcp → ${configPath}`,
  };
}

function wireJsonEditor(
  target: 'claude' | 'cursor',
  configPath: string,
): { ok: boolean; detail: string } {
  const gatewayEntry: McpServerEntry = target === 'claude'
    ? { type: 'stdio', command: 'ashlr', args: ['mcp'], env: {} }
    : { command: 'ashlr', args: ['mcp'] };

  let existing: ConfigFileShape;
  try {
    existing = parseJsonConfig(configPath);
  } catch (err) {
    if (err instanceof ConfigParseError) {
      return { ok: false, detail: `refusing to write: ${err.message}` };
    }
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, detail: `failed to read config: ${msg}` };
  }

  const existingServers = existing.mcpServers ?? {};
  const existingEntry = existingServers[ASHLR_HUB_MCP_SERVER];
  if (sameJsonEntry(existingEntry, gatewayEntry)) {
    return { ok: true, detail: `already wired — no changes needed (${configPath})` };
  }
  if (Object.prototype.hasOwnProperty.call(existingServers, ASHLR_HUB_MCP_SERVER)) {
    return {
      ok: false,
      detail: `${ASHLR_HUB_MCP_SERVER} already exists with a different ${target} configuration; refusing to overwrite it`,
    };
  }

  try {
    if (existsSync(configPath)) {
      backupConfig(configPath);
    } else {
      mkdirSync(dirname(configPath), { recursive: true });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, detail: `could not prepare config: ${msg}` };
  }

  const merged: ConfigFileShape = {
    ...existing,
    mcpServers: {
      ...existingServers,
      [ASHLR_HUB_MCP_SERVER]: gatewayEntry,
    },
  };

  try {
    writeFileSync(configPath, `${JSON.stringify(merged, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, detail: `write failed: ${msg}` };
  }

  return {
    ok: true,
    detail: `wired ${ASHLR_HUB_MCP_SERVER} gateway → ${configPath}`,
  };
}

export function detectEditors(): string[] {
  const detected: string[] = [];
  const targets: EditorTarget[] = ['claude', 'codex', 'cursor'];
  for (const target of targets) {
    if (DETECTION_PATHS[target].some(configPath => existsSync(configPath))) {
      detected.push(target);
    }
  }
  return detected;
}

export async function wireEditor(
  target: EditorTarget,
  opts: WireEditorOptions,
): Promise<{ ok: boolean; detail: string }> {
  const configPath = opts.configPath ?? DEFAULT_CONFIG_PATHS[target];
  try {
    if (target === 'codex') {
      return await wireCodex(configPath, opts.runCommand ?? defaultCommandRunner);
    }
    return wireJsonEditor(target, configPath);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, detail: `editor wiring failed: ${msg}` };
  }
}
