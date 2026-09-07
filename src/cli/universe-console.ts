import { isAbsolute, parse as parsePath, resolve } from 'node:path';

const USAGE = `usage: ashlr universe console --root <absolute> [--port N] [--json]

Start a read-only Universe console in the foreground on 127.0.0.1.
An explicit absolute private root is required; no default root is substituted.
--port accepts 0..65535 and defaults to 0 (an available ephemeral port).
--json emits one startup record with the bound URLs and private read token.
The token is never placed in a URL. Keep it private and paste it into the console.
No browser is opened, provider contacted, experiment executed, or service installed.
SIGINT/SIGTERM close this console and are awaited. This does not activate the
general Hub dashboard or qualify a local candidate for production.
Exit codes: 0 clean shutdown/help, 1 startup/shutdown failure, 2 invalid arguments.
`;

class UsageError extends Error {}
type Options = { help: true } | { help: false; root: string; port: number; json: boolean };

function controls(value: string): boolean {
  return [...value].some((character) => character.charCodeAt(0) < 32 ||
    character.charCodeAt(0) >= 127 && character.charCodeAt(0) <= 159);
}

function parse(args: string[]): Options {
  if (args.length > 16 || args.some((arg) => typeof arg !== 'string' || arg.length > 4_096 || controls(arg)) ||
      Buffer.byteLength(args.join('\0'), 'utf8') > 16 * 1024) {
    throw new UsageError('Arguments exceed the bounded text contract');
  }
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) return { help: true };
  const values = new Map<string, string>();
  let json = false;
  for (let index = 0; index < args.length; index++) {
    const flag = args[index]!;
    if (flag === '--json') {
      if (json) throw new UsageError('--json may only be specified once');
      json = true; continue;
    }
    if (!['--root', '--port'].includes(flag) || values.has(flag)) {
      throw new UsageError('Unknown or duplicate console option');
    }
    const value = args[++index];
    if (!value?.trim() || value.startsWith('-')) throw new UsageError('Console option requires a value');
    values.set(flag, value);
  }
  const root = values.get('--root');
  if (!root || !isAbsolute(root) || Buffer.byteLength(root, 'utf8') > 4_096 || resolve(root) === parsePath(root).root) {
    throw new UsageError('--root requires an absolute private directory, not the filesystem root');
  }
  const portText = values.get('--port') ?? '0';
  if (!/^(0|[1-9]\d{0,4})$/.test(portText) || Number(portText) > 65_535) {
    throw new UsageError('--port requires an integer from 0 through 65535');
  }
  // Match the server's lexical scope identity without resolving symlinks or
  // touching the selected store. Startup and authenticated metadata agree.
  return { help: false, root: resolve(root), port: Number(portText), json };
}

/** No general dashboard/config import occurs before the explicit console scope is validated. */
export async function cmdUniverseConsole(args: string[]): Promise<number> {
  let startupPrinted = false;
  try {
    const options = parse(args);
    if (options.help) { console.log(USAGE); return 0; }
    let handle: { close(): Promise<void> } | undefined;
    let stopping = false;
    let closing: Promise<void> | undefined;
    let stopped!: () => void;
    const stopRequested = new Promise<void>((done) => { stopped = done; });
    const stop = (): void => {
      stopping = true;
      if (!handle || closing) return;
      // Defer the call so even a synchronous close failure is handled, and
      // coalesce both signals onto this exact server's one close operation.
      closing = Promise.resolve().then(() => handle!.close());
      void closing.then(stopped, stopped);
    };
    const interrupt = (): void => stop();
    const terminate = (): void => stop();
    process.on('SIGINT', interrupt);
    process.on('SIGTERM', terminate);
    try {
      const { startUniverseConsoleServer } = await import('../core/web/universe-console-server.js');
      if (stopping) return 0;
      const server = await startUniverseConsoleServer({ root: options.root, port: options.port });
      handle = server;
      if (stopping) stop();
      else {
        const startup = { schemaVersion: 1, mode: 'universe', root: options.root, readOnly: true,
          url: server.url, consoleUrl: server.consoleUrl, port: server.port,
          readToken: server.readToken, readTokenHeader: 'X-Ashlr-Token' };
        console.log(options.json ? JSON.stringify(startup) : [
          `Universe console (read-only): ${server.consoleUrl}`,
          `Root: ${options.root}`,
          `Private read token: ${server.readToken}`,
          'Paste the token into the console; it is never included in the URL.',
          'Foreground only. Press Ctrl-C to close. No experiment execution or service activation.',
        ].join('\n'));
        startupPrinted = true;
      }
      await stopRequested;
      await closing;
      return 0;
    } finally {
      try {
        if (handle) { stop(); await closing; }
      } finally {
        process.removeListener('SIGINT', interrupt);
        process.removeListener('SIGTERM', terminate);
      }
    }
  } catch (error) {
    const message = error instanceof UsageError ? error.message : 'Universe console could not start or stop';
    if (args.includes('--json')) {
      // Once startup is announced, leave stdout as one machine-readable record.
      if (startupPrinted) console.error(JSON.stringify({ error: message }));
      else console.log(JSON.stringify({ error: message }));
    } else console.error(`universe console: ${message}`);
    return error instanceof UsageError ? 2 : 1;
  }
}
