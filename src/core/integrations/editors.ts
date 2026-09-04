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
  closeSync,
  constants as fsConstants,
  existsSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  unlinkSync,
  writeSync,
  type BigIntStats,
} from 'node:fs';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';

import { fsyncDirectory } from '../util/durability.js';

export type EditorTarget = 'claude' | 'codex' | 'cursor';

export const ASHLR_HUB_MCP_SERVER = 'ashlr-hub';
const MAX_COMMAND_OUTPUT_BYTES = 256 * 1024;
const MAX_JSON_CONFIG_BYTES = 4 * 1024 * 1024;
const COMMAND_TIMEOUT_MS = 15_000;
const COMMAND_TERMINATION_GRACE_MS = 1_000;
const PRIVATE_FILE_MODE = 0o600;

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

interface EditorConfigTestHooks {
  beforeJsonConfigPublish?: () => void;
  commandTimeoutMs?: number;
  commandTerminationGraceMs?: number;
}

let editorConfigTestHooks: EditorConfigTestHooks | undefined;

/** Test-only seam for deterministic filesystem-race and subprocess coverage. */
export function setEditorConfigTestHooksForTests(hooks?: EditorConfigTestHooks): void {
  if (process.env.NODE_ENV !== 'test') throw new Error('editor config hooks are test-only');
  editorConfigTestHooks = hooks;
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

interface MissingConfigSnapshot { found: false }

interface ExistingConfigSnapshot {
  found: true;
  stat: BigIntStats;
  bytes: Buffer;
}

type ConfigSnapshot = MissingConfigSnapshot | ExistingConfigSnapshot;

function currentUserOwns(stat: BigIntStats): boolean {
  return typeof process.getuid !== 'function' || stat.uid === BigInt(process.getuid());
}

function sameFile(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function safeConfigFile(stat: BigIntStats): boolean {
  return stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1n && currentUserOwns(stat);
}

function sameSnapshot(left: BigIntStats, right: BigIntStats): boolean {
  return sameFile(left, right) && left.size === right.size &&
    left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

function readConfigSnapshot(filePath: string): ConfigSnapshot {
  let fd: number | undefined;
  try {
    const noFollow = typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0;
    try {
      fd = openSync(filePath, fsConstants.O_RDONLY | noFollow);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { found: false };
      throw error;
    }
    const opened = fstatSync(fd, { bigint: true });
    const named = lstatSync(filePath, { bigint: true });
    if (!safeConfigFile(opened) || !safeConfigFile(named) ||
      opened.size > BigInt(MAX_JSON_CONFIG_BYTES) || !sameSnapshot(opened, named)) {
      throw new Error(`refusing unsafe JSON config: ${filePath}`);
    }
    const bytes = Buffer.alloc(Number(opened.size));
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (count <= 0) throw new Error(`JSON config read made no progress: ${filePath}`);
      offset += count;
    }
    if (readSync(fd, Buffer.alloc(1), 0, 1, bytes.length) !== 0) {
      throw new Error(`JSON config grew while reading it: ${filePath}`);
    }
    const after = fstatSync(fd, { bigint: true });
    const namedAfter = lstatSync(filePath, { bigint: true });
    if (!safeConfigFile(after) || !safeConfigFile(namedAfter) ||
      !sameSnapshot(opened, after) || !sameSnapshot(after, namedAfter)) {
      throw new Error(`JSON config changed while reading it: ${filePath}`);
    }
    return { found: true, stat: after, bytes };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function parseJsonConfig(filePath: string): { config: ConfigFileShape; snapshot: ConfigSnapshot } {
  const snapshot = readConfigSnapshot(filePath);
  if (!snapshot.found) return { config: {}, snapshot };
  const raw = snapshot.bytes.toString('utf8').trim();
  if (!raw) return { config: {}, snapshot };

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
  return { config: parsed as ConfigFileShape, snapshot };
}

function rejectUserControlledSymlinkAncestors(directory: string): void {
  let current = directory;
  while (true) {
    const stat = lstatSync(current, { bigint: true });
    // Root-owned platform aliases such as macOS /var -> private/var are part of
    // the trusted OS namespace. A symlink owned by this process' user is
    // mutable by that same user and therefore not accepted in a config path.
    if (stat.isSymbolicLink() && currentUserOwns(stat)) {
      throw new Error(`refusing user-controlled symlink in JSON config path: ${current}`);
    }
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

function snapshotStillCurrent(configPath: string, expected: ConfigSnapshot): boolean {
  try {
    const current = lstatSync(configPath, { bigint: true });
    return expected.found && safeConfigFile(current) && sameSnapshot(expected.stat, current);
  } catch (error) {
    return !expected.found && (error as NodeJS.ErrnoException).code === 'ENOENT';
  }
}

function publishJsonConfig(
  configPath: string,
  bytes: Buffer,
  expected: ConfigSnapshot,
  beforePublish?: () => void,
): void {
  const directory = dirname(configPath);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  rejectUserControlledSymlinkAncestors(directory);
  const directoryBefore = lstatSync(directory, { bigint: true });
  if (!directoryBefore.isDirectory() || directoryBefore.isSymbolicLink() || !currentUserOwns(directoryBefore)) {
    throw new Error(`refusing unsafe JSON config directory: ${directory}`);
  }
  const temporary = join(directory,
    `.${basename(configPath)}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`);
  let fd: number | undefined;
  let temporaryIdentity: BigIntStats | undefined;
  let published = false;
  try {
    const noFollow = typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0;
    fd = openSync(temporary,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | noFollow,
      PRIVATE_FILE_MODE);
    temporaryIdentity = fstatSync(fd, { bigint: true });
    if (!safeConfigFile(temporaryIdentity) || temporaryIdentity.size !== 0n) {
      throw new Error('refusing unsafe JSON config temporary file');
    }
    let offset = 0;
    while (offset < bytes.length) {
      const count = writeSync(fd, bytes, offset, bytes.length - offset, offset);
      if (count <= 0) throw new Error('JSON config write made no progress');
      offset += count;
    }
    if (process.platform !== 'win32') fchmodSync(fd, PRIVATE_FILE_MODE);
    fsyncSync(fd);
    const written = fstatSync(fd, { bigint: true });
    const namedTemporary = lstatSync(temporary, { bigint: true });
    const directoryBeforePublish = lstatSync(directory, { bigint: true });
    if (!safeConfigFile(written) || !safeConfigFile(namedTemporary) ||
      !sameFile(temporaryIdentity, written) || !sameSnapshot(written, namedTemporary) ||
      written.size !== BigInt(bytes.length) || !sameFile(directoryBefore, directoryBeforePublish)) {
      throw new Error('JSON config paths changed during write');
    }
    // Node has no portable compare-and-rename primitive. This revalidation
    // catches a completed editor/agent replacement before publication, but it
    // is not an authorization boundary against a malicious same-UID process
    // acting between this check and rename (that process can write the config
    // directly anyway). The last observable seam is exposed for deterministic
    // regression coverage rather than implying stronger kernel-level CAS.
    beforePublish?.();
    if (!snapshotStillCurrent(configPath, expected)) {
      throw new Error('JSON config changed before publication');
    }
    renameSync(temporary, configPath);
    published = true;
    const installed = lstatSync(configPath, { bigint: true });
    const openedAfterPublish = fstatSync(fd, { bigint: true });
    const directoryAfterPublish = lstatSync(directory, { bigint: true });
    if (!safeConfigFile(installed) || !safeConfigFile(openedAfterPublish) ||
      !sameFile(written, installed) || installed.size !== written.size ||
      !sameSnapshot(installed, openedAfterPublish) ||
      !sameFile(directoryBefore, directoryAfterPublish)) {
      throw new Error('JSON config installation identity check failed');
    }
    fsyncDirectory(directory);
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* preserve the persistence failure */ }
    }
    if (!published && temporaryIdentity) {
      try {
        const named = lstatSync(temporary, { bigint: true });
        if (safeConfigFile(named) && sameFile(named, temporaryIdentity)) unlinkSync(temporary);
      } catch { /* exact temporary already absent or replaced */ }
    }
  }
}

function backupConfig(configPath: string, capturedBytes?: Buffer): void {
  const source = capturedBytes === undefined ? readConfigSnapshot(configPath) : undefined;
  const bytes = capturedBytes ?? (source?.found ? source.bytes : undefined);
  if (!bytes) throw new Error(`config disappeared before backup: ${configPath}`);

  const bakPath = `${configPath}.bak`;
  const previous = readConfigSnapshot(bakPath);
  if (previous.found) {
    const archivePath = `${bakPath}.${Date.now()}.${randomBytes(8).toString('hex')}`;
    publishJsonConfig(archivePath, previous.bytes, { found: false });
  }
  publishJsonConfig(bakPath, bytes, previous);
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
      detached: process.platform !== 'win32',
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    let terminationResult: CommandResult | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (result: CommandResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer !== undefined) clearTimeout(killTimer);
      resolve(result);
    };

    // A detached POSIX child leads a new process group, so signals cover any
    // helpers it launches while mutating the registry. Node has no equivalent
    // portable process-tree primitive on Windows; child.kill is the bounded
    // direct-process fallback there.
    const signalProcessTree = (signal: 'SIGTERM' | 'SIGKILL'): void => {
      if (process.platform !== 'win32' && child.pid !== undefined) {
        try {
          process.kill(-child.pid, signal);
          return;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ESRCH') return;
          // Fall through to the direct child when group signaling is denied or
          // unavailable. The later close event still remains the settle gate.
        }
      }
      try { child.kill(signal); } catch { /* close remains the proof of release */ }
    };

    const terminate = (launchError: string): void => {
      if (terminationResult !== undefined) return;
      terminationResult = { ok: false, code: null, stdout, stderr, launchError };
      signalProcessTree('SIGTERM');
      killTimer = setTimeout(() => {
        signalProcessTree('SIGKILL');
      }, editorConfigTestHooks?.commandTerminationGraceMs ?? COMMAND_TERMINATION_GRACE_MS);
    };

    const timer = setTimeout(() => {
      terminate('command timed out after 15 seconds');
    }, editorConfigTestHooks?.commandTimeoutMs ?? COMMAND_TIMEOUT_MS);
    const capture = (current: string, chunk: Buffer): string | null => {
      if (Buffer.byteLength(current) + chunk.length > MAX_COMMAND_OUTPUT_BYTES) return null;
      return current + chunk.toString();
    };
    child.stdout.on('data', (chunk: Buffer) => {
      if (terminationResult !== undefined) return;
      const next = capture(stdout, chunk);
      if (next === null) {
        terminate('command output exceeded 256 KiB safety limit');
      } else {
        stdout = next;
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (terminationResult !== undefined) return;
      const next = capture(stderr, chunk);
      if (next === null) {
        terminate('command output exceeded 256 KiB safety limit');
      } else {
        stderr = next;
      }
    });
    child.once('error', error => {
      if (terminationResult !== undefined) return;
      finish({ ok: false, code: null, stdout, stderr, launchError: error.message });
    });
    child.once('close', code => {
      if (terminationResult !== undefined) {
        // The direct child may close while a same-group helper remains alive.
        // A final hard group signal prevents a surviving helper from mutating
        // config after this failure is reported.
        signalProcessTree('SIGKILL');
        finish(terminationResult);
        return;
      }
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
  let snapshot: ConfigSnapshot;
  try {
    ({ config: existing, snapshot } = parseJsonConfig(configPath));
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
    if (snapshot.found) backupConfig(configPath, snapshot.bytes);
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
    publishJsonConfig(
      configPath,
      Buffer.from(`${JSON.stringify(merged, null, 2)}\n`, 'utf8'),
      snapshot,
      editorConfigTestHooks?.beforeJsonConfigPublish,
    );
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
