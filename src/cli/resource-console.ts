import { isAbsolute, parse as parsePath, resolve } from 'node:path';

const USAGE = `usage: ashlr resources pool console --root ABS --pool ABS --bindings ABS --observations ABS [--port N] [--json]
       add --execute --workspace ABS [--max-parallel N] to enable foreground queued tasks

The dedicated resource desk runs on 127.0.0.1, with an explicit pool and store.
Read-only by default; startup never discovers accounts, logs in, or installs a service.
Execution is an explicit capability for the fixed workspace. It can consume native
provider allowances and edit that workspace when a queued task requests workspace-write.
Queued intents and pause state are durable; previously dispatching work is never
silently replayed after restart. Output is bounded and retained for this session only.
--port accepts 0..65535, default 0. --max-parallel accepts 1..16, default 4.
Private read and control tokens are printed once, never placed in URLs.
SIGINT/SIGTERM abort and await owned work before closing. No resident fleet activation.
Exit codes: 0 clean shutdown/help, 1 startup/shutdown failure, 2 invalid arguments.
`;
class UsageError extends Error {}
type Options = { help: true } | { help: false; root: string; poolFile: string; bindingsFile: string;
  observationsFile: string; port: number; execute: boolean; workspace?: string; maxParallel?: number; json: boolean };

function path(value: string): string {
  if (!isAbsolute(value) || resolve(value) === parsePath(value).root || Buffer.byteLength(value) > 4_096) {
    throw new UsageError('Console paths must be explicit absolute non-root paths');
  }
  return resolve(value);
}
function parse(args: string[]): Options {
  if (args.length > 24 || args.some((arg) => typeof arg !== 'string' || arg.length > 4_096 ||
      [...arg].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) >= 127 && char.charCodeAt(0) <= 159)) ||
    Buffer.byteLength(args.join('\0')) > 32 * 1024) throw new UsageError('Arguments exceed the bounded text contract');
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) return { help: true };
  const values = new Map<string, string>(); let execute = false; let json = false;
  for (let index = 0; index < args.length; index++) {
    const flag = args[index]!;
    if (flag === '--execute') { if (execute) throw new UsageError('Duplicate console option'); execute = true; continue; }
    if (flag === '--json') { if (json) throw new UsageError('Duplicate console option'); json = true; continue; }
    if (!['--root', '--pool', '--bindings', '--observations', '--port', '--workspace', '--max-parallel'].includes(flag) || values.has(flag)) {
      throw new UsageError('Unknown or duplicate console option');
    }
    const value = args[++index];
    if (!value || value.startsWith('-')) throw new UsageError('Console option requires a value'); values.set(flag, value);
  }
  if (['--root', '--pool', '--bindings', '--observations'].some((key) => !values.has(key))) {
    throw new UsageError('Explicit root, pool, bindings and observations paths are required');
  }
  if (execute ? !values.has('--workspace') : values.has('--workspace') || values.has('--max-parallel')) {
    throw new UsageError('Execution requires --execute with --workspace; parallelism is execution-only');
  }
  const portText = values.get('--port') ?? '0'; const parallelText = values.get('--max-parallel') ?? '4';
  if (!/^(0|[1-9]\d{0,4})$/.test(portText) || Number(portText) > 65_535 ||
    !/^[1-9]\d?$/.test(parallelText) || Number(parallelText) > 16) throw new UsageError('Invalid port or parallel limit');
  return { help: false, root: path(values.get('--root')!), poolFile: path(values.get('--pool')!),
    bindingsFile: path(values.get('--bindings')!), observationsFile: path(values.get('--observations')!),
    port: Number(portText), execute, ...(execute ? { workspace: path(values.get('--workspace')!), maxParallel: Number(parallelText) } : {}), json };
}

export async function cmdResourceConsole(args: string[]): Promise<number> {
  let announced = false;
  try {
    const options = parse(args); if (options.help) { console.log(USAGE); return 0; }
    const controller = new AbortController();
    let handle: { close(): Promise<void> } | undefined; let closing: Promise<void> | undefined;
    let stopped!: () => void; const stopRequested = new Promise<void>((resolve) => { stopped = resolve; });
    const stop = () => {
      controller.abort();
      if (!handle || closing) return;
      closing = Promise.resolve().then(() => handle!.close()); void closing.then(stopped, stopped);
    };
    const interrupt = () => stop(); const terminate = () => stop();
    process.on('SIGINT', interrupt); process.on('SIGTERM', terminate);
    try {
      const { startResourceConsoleServer } = await import('../core/web/resource-console-server.js');
      if (controller.signal.aborted) return 0;
      const { help: _help, json, ...serverOptions } = options;
      const server = await startResourceConsoleServer({ ...serverOptions, signal: controller.signal }); handle = server;
      if (controller.signal.aborted) stop();
      else {
        const startup = { ...server.scope, url: server.url, consoleUrl: server.consoleUrl, port: server.port,
          readToken: server.readToken, controlToken: server.controlToken, tokenHeader: 'X-Ashlr-Token' };
        console.log(json ? JSON.stringify(startup) : [
          `Resource desk: ${server.consoleUrl}`, `Pool: ${server.scope.poolId}`, `Store: ${server.scope.root}`,
          `Private read token: ${server.readToken}`,
          ...(server.controlToken ? [`Private control token: ${server.controlToken}`, `Execution workspace: ${server.scope.workspace}`,
            'Durable queued tasks may execute while this foreground console is running.'] : ['Read-only. Task execution is disabled.']),
          'Paste tokens into the console; they are never included in URLs.',
          'Press Ctrl-C to abort owned work and close. No resident service is installed.',
        ].join('\n')); announced = true;
      }
      await stopRequested; await closing; return 0;
    } finally {
      try { if (handle) { stop(); await closing; } }
      finally { process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', terminate); }
    }
  } catch (error) {
    const message = error instanceof UsageError ? error.message : 'Resource console could not start or stop';
    if (args.includes('--json')) {
      if (announced) console.error(JSON.stringify({ error: message })); else console.log(JSON.stringify({ error: message }));
    } else console.error(`resources pool console: ${message}`);
    return error instanceof UsageError ? 2 : 1;
  }
}
