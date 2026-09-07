import { spawn } from 'node:child_process';
import { constants } from 'node:os';
import { isAbsolute } from 'node:path';
import { installLocalRuntime, readLocalRuntimeStatus, resolveLocalRuntime, rollbackLocalRuntime,
  type LocalRuntimeStatus, type LocalRuntimeResolution } from '../core/local-runtime/store.js';

const USAGE = `usage: ashlr runtime <command>

  install --store <absolute> --artifact <absolute> --sha256 <64 hex>
          --revision <40 hex> --version <version> [--json]
  status --store <absolute> [--json]
  rollback --store <absolute> [--json]
  run --store <absolute> -- universe <args>
  help

Install an exact pinned, unsigned local candidate; inspect it or select the
previous verified installation. This is not production qualification, registry
publication, or resident-service activation. No global command or service is changed.
The foreground run command only forwards Universe. Operational commands require
one explicit absolute --root <private directory>; help-only commands are exempt.
The selected package and Node interpreter are verified once immediately before
launch and pinned for that process lifetime. No HOME is substituted. NODE_OPTIONS
and NODE_PATH are removed from the child environment. Child exit codes propagate;
signal exits use 128 + signal number. SIGINT/SIGTERM are forwarded and awaited.
An unresponsive child gets five seconds to stop, then that exact child is killed;
a repeated interrupt also escalates. This launcher does not claim process-tree cleanup.
Exit codes: 0 success, 1 unavailable/degraded/failed, 2 invalid arguments.
`;

class UsageError extends Error {}
type Options = { command: 'help'; json: false } | {
  command: 'install' | 'status' | 'rollback' | 'run'; store: string; json: boolean;
  artifactPath?: string; sha256?: string; revision?: string; version?: string; forwarded: string[];
};
function controls(value: string): boolean {
  return [...value].some((character) => character.charCodeAt(0) < 32 ||
    character.charCodeAt(0) >= 127 && character.charCodeAt(0) <= 159);
}
function absolutePath(value: string | undefined, flag: string): string {
  if (!value || !isAbsolute(value) || value.length > 4_096 || controls(value)) {
    throw new UsageError(`${flag} requires a bounded absolute path without control characters`);
  }
  return value;
}

/** Recognize only unambiguous help requests; flags mixed with help cannot bypass root validation. */
function helpOnly(args: string[]): boolean {
  if (args.length === 1 && ['help', '--help', '-h'].includes(args[0]!)) return true;
  const command = args[0];
  if (args.length === 2 && ['demo', 'init', 'run', 'status', 'archive', 'campaign', 'portfolio', 'deliver',
    'deliveries', 'graph', 'compare'].includes(command ?? '') && ['--help', '-h'].includes(args[1]!)) return true;
  return args.length === 2 && ['campaign', 'portfolio'].includes(command ?? '') && args[1] === 'help';
}

function validateForwarded(args: string[]): void {
  if (args[0] !== 'universe') throw new UsageError('run only accepts -- universe <args>');
  const universe = args.slice(1);
  if (universe.includes('--')) throw new UsageError('A second separator is not accepted in Universe arguments');
  if (helpOnly(universe)) return;
  if (universe.some((arg) => ['--help', '-h'].includes(arg)) || universe[0] === 'help' ||
      ['campaign', 'portfolio'].includes(universe[0] ?? '') && universe[1] === 'help') {
    throw new UsageError('Help must be an unambiguous help-only Universe command');
  }
  const roots = universe.reduce<number[]>((indexes, arg, index) => arg === '--root' ? [...indexes, index] : indexes, []);
  if (roots.length !== 1) throw new UsageError('Universe operations require exactly one explicit --root <absolute private directory>');
  absolutePath(universe[roots[0]! + 1], '--root');
}

function parse(args: string[]): Options {
  if (args.length > 256 || args.some((arg) => typeof arg !== 'string' || arg.length > 4_096 || controls(arg)) ||
      Buffer.byteLength(args.join('\0'), 'utf8') > 64 * 1024) throw new UsageError('Arguments exceed the bounded text contract');
  if (args.length === 0 || (args.length === 1 && ['help', '--help', '-h'].includes(args[0]!)) ||
      (args.length === 2 && ['install', 'status', 'rollback', 'run'].includes(args[0]!) && ['--help', '-h'].includes(args[1]!))) {
    return { command: 'help', json: false };
  }
  const command = args[0];
  if (!['install', 'status', 'rollback', 'run'].includes(command ?? '')) throw new UsageError('Unknown runtime command');
  const separator = args.indexOf('--');
  if (command === 'run' ? separator < 0 : separator >= 0) throw new UsageError('Only run requires a -- universe separator');
  const options = new Map<string, string>();
  let json = false;
  const end = separator < 0 ? args.length : separator;
  const allowed = command === 'install' ? ['--store', '--artifact', '--sha256', '--revision', '--version'] : ['--store'];
  for (let index = 1; index < end; index++) {
    const flag = args[index]!;
    if (flag === '--json') {
      if (json || command === 'run') throw new UsageError('--json is permitted once for install, status, or rollback');
      json = true; continue;
    }
    if (!allowed.includes(flag) || options.has(flag)) throw new UsageError('Unknown or duplicate runtime option');
    const value = args[++index];
    if (index >= end || !value?.trim() || value.startsWith('-')) throw new UsageError('Runtime option requires a value');
    options.set(flag, value);
  }
  const store = absolutePath(options.get('--store'), '--store');
  const forwarded = separator < 0 ? [] : args.slice(separator + 1);
  if (command === 'run') validateForwarded(forwarded);
  if (command === 'install') {
    const artifactPath = absolutePath(options.get('--artifact'), '--artifact');
    const sha256 = options.get('--sha256'); const revision = options.get('--revision'); const version = options.get('--version');
    if (!sha256 || !/^[0-9a-f]{64}$/.test(sha256)) throw new UsageError('--sha256 requires exactly 64 lowercase hexadecimal characters');
    if (!revision || !/^[0-9a-f]{40}$/.test(revision)) throw new UsageError('--revision requires exactly 40 lowercase hexadecimal characters');
    if (!version?.trim() || version.length > 128) throw new UsageError('--version requires a bounded exact package version');
    // The archive verifier is the authoritative version/package-identity validator.
    return { command, store, artifactPath, sha256, revision, version, json, forwarded };
  }
  return { command: command as 'status' | 'rollback' | 'run', store, json, forwarded };
}

function render(status: LocalRuntimeStatus): string {
  const lines = [`Local runtime · ${status.sourceState}`, `Store: ${status.store}`];
  for (const [label, installation] of [['Current', status.current], ['Previous', status.previous]] as const) {
    if (!installation) { lines.push(`${label}: none`); continue; }
    // The store verifies each non-null installation independently, even if the
    // other selection is unavailable and makes the overall status degraded.
    lines.push(`${label} verified candidate: ${installation.version} · ${installation.revision}`,
      `  SHA-256: ${installation.sha256}`, `  Executable: ${installation.binPath}`,
      `  Node: ${installation.nodePath} · ${installation.nodeVersion}`);
  }
  if (status.reasons.length) lines.push(...status.reasons.map((reason) => `Evidence: ${reason}`));
  lines.push('Unsigned pinned local candidate; not production qualification, registry publication, or service activation.');
  return lines.join('\n');
}

async function runSelected(resolution: LocalRuntimeResolution, forwarded: string[]): Promise<number> {
  const env = { ...process.env };
  delete env.NODE_OPTIONS; delete env.NODE_PATH;
  return new Promise<number>((resolveDone, reject) => {
    const child = spawn(resolution.nodePath, [resolution.binPath, ...forwarded], {
      cwd: process.cwd(), env, stdio: 'inherit', shell: false, windowsHide: true,
    });
    let settled = false;
    let exited = false;
    let cancellationRequested = false;
    let escalation: ReturnType<typeof setTimeout> | undefined;
    const killExactChild = (): void => {
      if (settled || exited) return;
      try { child.kill('SIGKILL'); } catch { /* No authority to signal any other process. */ }
    };
    const forward = (signal: NodeJS.Signals): void => {
      if (settled || exited) return;
      if (cancellationRequested) { killExactChild(); return; }
      cancellationRequested = true;
      escalation = setTimeout(killExactChild, 5_000);
      try { child.kill(signal); } catch { /* Await this exact child's exit; never signal a broader process set. */ }
    };
    const interrupt = (): void => forward('SIGINT');
    const terminate = (): void => forward('SIGTERM');
    const cleanup = (): void => {
      process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', terminate);
      if (escalation) clearTimeout(escalation);
    };
    process.on('SIGINT', interrupt); process.on('SIGTERM', terminate);
    child.once('error', () => {
      if (settled) return;
      settled = true; cleanup(); reject(new Error('Selected local runtime could not start'));
    });
    child.once('exit', () => {
      exited = true;
      if (escalation) clearTimeout(escalation);
    });
    child.once('close', (code, signal) => {
      if (settled) return;
      settled = true; cleanup();
      resolveDone(code !== null ? code : signal ? 128 + (constants.signals[signal] ?? 1) : 1);
    });
  });
}

/** Installation is explicit; forwarding never falls back to the source checkout or another runtime. */
export async function cmdRuntime(args: string[]): Promise<number> {
  try {
    const options = parse(args);
    if (options.command === 'help') { console.log(USAGE); return 0; }
    if (options.command === 'run') {
      const selected = resolveLocalRuntime(options.store);
      return await runSelected(selected, options.forwarded);
    }
    const status = options.command === 'install'
      ? await installLocalRuntime({ store: options.store, artifactPath: options.artifactPath!, sha256: options.sha256!,
        revision: options.revision!, version: options.version! })
      : options.command === 'rollback' ? rollbackLocalRuntime(options.store) : readLocalRuntimeStatus(options.store);
    console.log(options.json ? JSON.stringify(status, null, 2) : render(status));
    return status.sourceState === 'healthy' ? 0 : 1;
  } catch (error) {
    const message = error instanceof UsageError ? error.message : 'Local runtime unavailable or operation failed';
    const separator = args.indexOf('--');
    if (args.slice(0, separator < 0 ? args.length : separator).includes('--json')) console.log(JSON.stringify({ error: message }));
    else console.error(`runtime: ${message}`);
    return error instanceof UsageError ? 2 : 1;
  }
}
