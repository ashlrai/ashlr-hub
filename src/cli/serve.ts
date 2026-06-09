/**
 * `ashlr serve` CLI command — M14 local web dashboard.
 *
 * Usage:
 *   ashlr serve [--port N] [--open] [--allow-dispatch] [--json]
 *
 * Starts a localhost-only HTTP server (127.0.0.1 ONLY, never 0.0.0.0) that
 * serves:
 *   (a) a JSON read-only API at /api/*
 *   (b) a static single-page dashboard (assets bundled in the repo)
 *   (c) GET /api/events — Server-Sent Events live feed
 *
 * Security notes:
 *   - Bound exclusively to 127.0.0.1 (never externally reachable).
 *   - Host-header allowlist enforced in the server layer (anti DNS-rebinding).
 *   - Read-only by default; POST /api/run only when --allow-dispatch is set,
 *     protected by a per-session token printed at startup.
 *   - Ephemeral: Ctrl-C (SIGINT) triggers clean close() of listeners + SSE.
 *
 * Exit codes:
 *   0  clean shutdown (SIGINT)
 *   1  error (bad args / server failed to start)
 *   2  bad usage
 */

import { parsePositiveInt } from './args.js';
import { makeColors, isTty } from './ui.js';

const { bold, dim, red, green, cyan, yellow, gray } = makeColors(isTty());

const DEFAULT_PORT = 7777;

// ---------------------------------------------------------------------------
// Lazy import — server is built by the server agent (M14)
// ---------------------------------------------------------------------------

async function importStartServer() {
  const mod = await import('../core/web/server.js') as {
    startServer: (
      cfg: import('../core/types.js').AshlrConfig,
      opts: import('../core/types.js').WebServerOptions,
    ) => Promise<import('../core/types.js').WebServerHandle>;
  };
  return mod.startServer;
}

async function importLoadConfig() {
  const mod = await import('../core/config.js') as {
    loadConfig: () => import('../core/types.js').AshlrConfig;
  };
  return mod.loadConfig;
}

// ---------------------------------------------------------------------------
// Arg parser
// ---------------------------------------------------------------------------

interface ServeOptions {
  port: number;
  open: boolean;
  allowDispatch: boolean;
  json: boolean;
}

function parseArgs(args: string[]): ServeOptions | { error: string; code: number } {
  let port = DEFAULT_PORT;
  let open = false;
  let allowDispatch = false;
  let json = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === '--port' || arg === '-p') {
      const result = parsePositiveInt('port', args[++i]);
      if ('error' in result) return { error: result.error, code: 2 };
      port = result.n;

    } else if (arg === '--open' || arg === '-o') {
      open = true;

    } else if (arg === '--allow-dispatch') {
      allowDispatch = true;

    } else if (arg === '--json') {
      json = true;

    } else if (arg === '--help' || arg === '-h') {
      return { error: '', code: 0 }; // signal to print usage

    } else if (arg.startsWith('-')) {
      return { error: `Unknown flag: ${arg}`, code: 2 };
    }
  }

  return { port, open, allowDispatch, json };
}

// ---------------------------------------------------------------------------
// Browser opener (macOS: open, Linux: xdg-open, Windows: start)
// ---------------------------------------------------------------------------

async function openBrowser(url: string): Promise<void> {
  const { spawn } = await import('child_process');
  const platform = process.platform;
  const cmd = platform === 'darwin' ? 'open'
    : platform === 'win32' ? 'start'
    : 'xdg-open';
  // detach so the CLI process doesn't wait for the browser
  const child = spawn(cmd, [url], {
    detached: true,
    stdio: 'ignore',
    shell: platform === 'win32', // 'start' requires shell on Windows
  });
  child.unref();
}

// ---------------------------------------------------------------------------
// cmdServe
// ---------------------------------------------------------------------------

export async function cmdServe(args: string[]): Promise<number> {
  const parsed = parseArgs(args);

  // Usage/help shortcut or parse error
  if ('error' in parsed) {
    if (parsed.code === 0) {
      printUsage();
      return 0;
    }
    console.error(red('error: ') + parsed.error);
    console.error(dim('Run `ashlr serve --help` for usage.'));
    return parsed.code;
  }

  const { port, open, allowDispatch, json } = parsed;

  // Load config
  let loadConfig: Awaited<ReturnType<typeof importLoadConfig>>;
  try {
    loadConfig = await importLoadConfig();
  } catch (err) {
    console.error(red('error: ') + 'Failed to load config module: ' + String(err));
    return 1;
  }

  const cfg = loadConfig();

  // Load startServer
  let startServer: Awaited<ReturnType<typeof importStartServer>>;
  try {
    startServer = await importStartServer();
  } catch (err) {
    console.error(
      red('error: ') +
      'serve command requires src/core/web/server.ts (M14 module not yet built).\n' +
      String(err),
    );
    return 1;
  }

  // Start server
  let handle: import('../core/types.js').WebServerHandle;
  try {
    handle = await startServer(cfg, { port, open, allowDispatch });
  } catch (err) {
    console.error(red('error: ') + 'Failed to start server: ' + String(err));
    return 1;
  }

  // ── Output ────────────────────────────────────────────────────────────────

  if (json) {
    const out: Record<string, unknown> = {
      url: handle.url,
      port: handle.port,
      allowDispatch,
    };
    if (allowDispatch) {
      out.token = handle.token;
      out.tokenHeader = 'X-Ashlr-Token';
    }
    console.log(JSON.stringify(out));
  } else {
    console.log('');
    console.log(bold('  ashlr serve') + gray(' — local web dashboard'));
    console.log('');
    console.log(`  ${green('✓')} Listening on ${cyan(handle.url)}`);
    console.log(`  ${dim('Bound to 127.0.0.1 only — not externally reachable.')}`);
    console.log('');

    if (allowDispatch) {
      console.log(`  ${yellow('⚠')}  ${bold('Dispatch enabled')} (--allow-dispatch)`);
      console.log(`  ${dim('Session token')}  ${bold(handle.token)}`);
      console.log(`  ${dim('Required header:')} X-Ashlr-Token: ${handle.token}`);
      console.log('');
      console.log(`  ${dim('POST /api/run is live. Use the token above for all mutating requests.')}`);
      console.log(`  ${dim('Never share this token or expose the server to other hosts.')}`);
      console.log('');
    } else {
      console.log(`  ${dim('Read-only mode. Pass --allow-dispatch to enable POST /api/run.')}`);
      console.log('');
    }

    console.log(`  ${dim('Press Ctrl-C to stop.')}`);
    console.log('');
  }

  // ── Open browser ──────────────────────────────────────────────────────────

  if (open) {
    try {
      await openBrowser(handle.url);
      if (!json) {
        console.error(dim(`  Opening ${handle.url} in your browser…`));
      }
    } catch {
      // Non-fatal — user can navigate manually
      if (!json) {
        console.error(dim(`  Could not open browser automatically. Navigate to ${handle.url}`));
      }
    }
  }

  // ── Keep alive until SIGINT ───────────────────────────────────────────────

  await new Promise<void>((resolve) => {
    const onSignal = async () => {
      if (!json) {
        process.stderr.write('\n');
        console.error(dim('  Stopping server…'));
      }
      try {
        await handle.close();
      } catch {
        // ignore close errors on shutdown
      }
      resolve();
    };

    process.once('SIGINT', () => void onSignal());
    process.once('SIGTERM', () => void onSignal());
  });

  if (!json) {
    console.error(dim('  Server stopped.'));
  }

  return 0;
}

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------

function printUsage(): void {
  console.log('');
  console.log(bold('  ashlr serve') + dim(' [--port N] [--open] [--allow-dispatch] [--json]'));
  console.log('');
  console.log('  Start a localhost-only web dashboard and JSON API server.');
  console.log('');
  console.log('  ' + bold('Options:'));
  console.log(`    ${cyan('--port N')}            TCP port to bind on 127.0.0.1 (default ${DEFAULT_PORT})`);
  console.log(`    ${cyan('--open')}              Open the dashboard in your default browser after start`);
  console.log(`    ${cyan('--allow-dispatch')}    Enable POST /api/run (guarded by a per-session token)`);
  console.log(`    ${cyan('--json')}              Print startup info as JSON (machine-readable)`);
  console.log('');
  console.log('  ' + bold('Security:'));
  console.log(`    ${dim('• Binds 127.0.0.1 ONLY — never 0.0.0.0 / never externally reachable')}`);
  console.log(`    ${dim('• Host-header allowlist enforced (anti DNS-rebinding)')}`);
  console.log(`    ${dim('• Read-only by default; POST /api/run requires --allow-dispatch + session token')}`);
  console.log(`    ${dim('• Ephemeral: Ctrl-C triggers clean shutdown (SSE pollers closed)')}`);
  console.log('');
  console.log('  ' + bold('API routes (read-only):'));
  console.log(`    ${cyan('GET  /api/snapshot')}        Aggregated config + run/swarm/genome snapshot`);
  console.log(`    ${cyan('GET  /api/runs')}            List past runs`);
  console.log(`    ${cyan('GET  /api/run/:id')}         Single run detail`);
  console.log(`    ${cyan('GET  /api/swarms')}          List past swarms`);
  console.log(`    ${cyan('GET  /api/swarm/:id')}       Single swarm detail`);
  console.log(`    ${cyan('GET  /api/pulse?window=7d')} Activity rollup (1d / 7d / 30d)`);
  console.log(`    ${cyan('GET  /api/genome[?q=...]')} Genome entries (optional search query)`);
  console.log(`    ${cyan('GET  /api/events')}          Server-Sent Events live feed`);
  console.log('');
  console.log('  ' + bold('Dispatch route (--allow-dispatch only):'));
  console.log(`    ${cyan('POST /api/run')}             Launch ashlr run (requires X-Ashlr-Token header)`);
  console.log('');
  console.log('  ' + bold('Examples:'));
  console.log(`    ${cyan('ashlr serve')}                            # Start on port ${DEFAULT_PORT}, read-only`);
  console.log(`    ${cyan('ashlr serve --port 8080 --open')}         # Custom port + open browser`);
  console.log(`    ${cyan('ashlr serve --allow-dispatch')}           # Enable agent dispatch`);
  console.log(`    ${cyan('ashlr serve --json')}                     # Machine-readable startup output`);
  console.log('');
}
