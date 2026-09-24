/**
 * `ashlr verse` CLI command — open the Ashlr Verse operator console.
 *
 * Usage:
 *   ashlr verse [--port N] [--no-open] [--json]
 *
 * This is `ashlr serve` with dispatch forced ON (Verse sessions are
 * mutations: they spawn vendor CLIs that edit the chosen project), serving
 * the console at /verse/ and opening it in the default browser unless
 * --no-open. Everything else — loopback-only bind, Host allowlist, read
 * token + short-lived read cookie, separate raw mutation token — is exactly
 * serve.ts's behaviour; this module only changes the defaults and the banner.
 *
 * Exit codes:
 *   0  clean shutdown (SIGINT)
 *   1  error (bad args / server failed to start)
 *   2  bad usage
 */

import { parsePositiveInt } from './args.js';
import { openBrowser } from './serve.js';
import { makeColors, isTty } from './ui.js';

const { bold, dim, red, green, cyan, yellow, gray } = makeColors(isTty());

const DEFAULT_PORT = 7777;

// ---------------------------------------------------------------------------
// Lazy imports (mirror serve.ts so the CLI degrades if a module is missing)
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

export interface VerseOptions {
  port: number;
  open: boolean;
  json: boolean;
  /** Run the native account-metadata collectors in this process. */
  accounts: boolean;
  /** Collector cadence in seconds (30-3600). One cycle is ~10 spawns and $0. */
  accountsPollSeconds: number;
  /** Suspend polling after this many minutes with no client interest. */
  accountsIdleMinutes: number;
}

/** The existing collector cadence, in seconds. */
export const VERSE_DEFAULT_ACCOUNTS_POLL_SECONDS = 30;
export const VERSE_DEFAULT_ACCOUNTS_IDLE_MINUTES = 5;

export function parseVerseArgs(args: string[]): VerseOptions | { error: string; code: number } {
  let port = DEFAULT_PORT;
  let open = true;
  let json = false;
  let accounts = true;
  let accountsPollSeconds = VERSE_DEFAULT_ACCOUNTS_POLL_SECONDS;
  let accountsIdleMinutes = VERSE_DEFAULT_ACCOUNTS_IDLE_MINUTES;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === '--port' || arg === '-p') {
      const result = parsePositiveInt('port', args[++i]);
      if ('error' in result) return { error: result.error, code: 2 };
      port = result.n;

    } else if (arg === '--no-accounts') {
      accounts = false;

    } else if (arg === '--accounts-poll') {
      const result = parsePositiveInt('accounts-poll', args[++i]);
      if ('error' in result) return { error: result.error, code: 2 };
      if (result.n < 30 || result.n > 3600) {
        return { error: '--accounts-poll must be between 30 and 3600 seconds', code: 2 };
      }
      accountsPollSeconds = result.n;

    } else if (arg === '--accounts-idle') {
      const result = parsePositiveInt('accounts-idle', args[++i]);
      if ('error' in result) return { error: result.error, code: 2 };
      if (result.n < 1 || result.n > 720) {
        return { error: '--accounts-idle must be between 1 and 720 minutes', code: 2 };
      }
      accountsIdleMinutes = result.n;

    } else if (arg === '--no-open') {
      open = false;

    } else if (arg === '--open' || arg === '-o') {
      open = true;

    } else if (arg === '--json') {
      json = true;

    } else if (arg === '--help' || arg === '-h') {
      return { error: '', code: 0 }; // signal to print usage

    } else if (arg !== undefined && arg.startsWith('-')) {
      return { error: `Unknown flag: ${arg}`, code: 2 };
    }
  }

  return { port, open, json, accounts, accountsPollSeconds, accountsIdleMinutes };
}

export function verseUrlFor(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/verse/`;
}

// ---------------------------------------------------------------------------
// V3.10 background services
// ---------------------------------------------------------------------------

type AshlrConfig = import('../core/types.js').AshlrConfig;

/**
 * The server-lifetime services a Verse server runs beside HTTP. Each one
 * otherwise starts on its FIRST request — so the first page load paid for it
 * (a 370–600 ms synchronous cold scan of Claude usage on the first
 * /bootstrap), and anything nobody had opened yet simply did not run:
 *   - account health (A2): the 10-minute status-command sweep the readiness
 *     gate and the desktop's notifications read;
 *   - Claude usage (A3): the async cold scan, primed so no request pays it;
 *   - reasoning maintenance (A7): ingest + retention every 10 minutes;
 *   - budget capacity publisher (A9): the snapshot the fleet's fail-closed
 *     budget gate reads — without it Claude autonomy is blocked whenever
 *     nobody has the budget panel open.
 * Every loader is a seam for tests; the defaults are the real modules.
 */
export interface VerseBackgroundDeps {
  loadHealth?: () => Promise<{ startVerseHealth: (cfg: AshlrConfig) => unknown; stopVerseHealth: () => void }>;
  loadClaudeUsage?: () => Promise<{ primeClaudeUsage: () => Promise<void> }>;
  loadReasoning?: () => Promise<{ scheduleReasoningMaintenance: (cfg?: unknown) => void; resetReasoningApiState: () => void }>;
  loadBudget?: () => Promise<{ startBudgetCapacityPublisher: (cfg: AshlrConfig) => () => void }>;
  /**
   * Run the services that probe or publish ACCOUNT state (health sweep,
   * budget capacity publisher). False under `--no-accounts`: that flag says
   * "this server does not watch accounts", and a throwaway server publishing
   * an all-unknown capacity snapshot would overwrite the live server's and
   * hold the fleet's budget gate shut until the next real tick. Default true.
   */
  accountServices?: boolean;
  /** One line per service that could not start (never fatal). */
  log?: (message: string) => void;
}

export interface VerseBackgroundServices {
  /** Services that started, in start order (for the banner and tests). */
  readonly started: readonly string[];
  /** Stop every started service, newest first. Idempotent; never throws. */
  stop(): void;
}

export async function startVerseBackgroundServices(
  cfg: AshlrConfig,
  deps: VerseBackgroundDeps = {},
): Promise<VerseBackgroundServices> {
  const log = deps.log ?? (() => {});
  const started: string[] = [];
  const stoppers: Array<{ name: string; stop: () => void }> = [];

  // Each service is independent: one that fails to load or start is reported
  // and skipped, and the console runs without it (every one of them also
  // starts lazily on its own first request, so nothing is lost for good).
  const attempt = async (name: string, run: () => Promise<(() => void) | null>): Promise<void> => {
    try {
      const stop = await run();
      started.push(name);
      if (stop) stoppers.push({ name, stop });
    } catch (err) {
      log(`${name} did not start: ${err instanceof Error ? err.message : 'unknown error'}`);
    }
  };

  const accountServices = deps.accountServices !== false;
  if (accountServices) await attempt('health', async () => {
    const mod = await (deps.loadHealth ?? (() => import('../core/verse/health-api.js')))();
    mod.startVerseHealth(cfg);
    return () => mod.stopVerseHealth();
  });
  await attempt('claude-usage', async () => {
    const mod = await (deps.loadClaudeUsage ?? (() => import('../core/fabric/claude-usage.js')))();
    // NOT awaited: the scan reads every recent Claude transcript (~0.5 s, in
    // small async slices). Awaiting it would hold the banner and the browser
    // open for no reason; primeClaudeUsage never rejects, the catch is a belt.
    void mod.primeClaudeUsage().catch(() => {});
    return null;
  });
  await attempt('reasoning', async () => {
    const mod = await (deps.loadReasoning ?? (() => import('../core/reasoning/reasoning-api.js')))();
    mod.scheduleReasoningMaintenance(cfg);
    // The module's only stop is its reset (clears the timer and caches),
    // which is exactly what shutdown wants.
    return () => mod.resetReasoningApiState();
  });
  if (accountServices) await attempt('budget', async () => {
    const mod = await (deps.loadBudget ?? (() => import('../core/routing/budget-api.js')))();
    return mod.startBudgetCapacityPublisher(cfg);
  });

  let stopped = false;
  return {
    started,
    stop() {
      if (stopped) return;
      stopped = true;
      for (const { name, stop } of [...stoppers].reverse()) {
        try { stop(); } catch (err) {
          log(`${name} did not stop cleanly: ${err instanceof Error ? err.message : 'unknown error'}`);
        }
      }
    },
  };
}

// ---------------------------------------------------------------------------
// cmdVerse
// ---------------------------------------------------------------------------

export async function cmdVerse(args: string[]): Promise<number> {
  const parsed = parseVerseArgs(args);

  if ('error' in parsed) {
    if (parsed.code === 0) {
      printUsage();
      return 0;
    }
    console.error(red('error: ') + parsed.error);
    console.error(dim('Run `ashlr verse --help` for usage.'));
    return parsed.code;
  }

  const { port, open, json, accounts, accountsPollSeconds, accountsIdleMinutes } = parsed;

  let loadConfig: Awaited<ReturnType<typeof importLoadConfig>>;
  try {
    loadConfig = await importLoadConfig();
  } catch (err) {
    console.error(red('error: ') + 'Failed to load config module: ' + String(err));
    return 1;
  }
  const cfg = loadConfig();

  let startServer: Awaited<ReturnType<typeof importStartServer>>;
  try {
    startServer = await importStartServer();
  } catch (err) {
    console.error(red('error: ') + 'verse command requires src/core/web/server.ts.\n' + String(err));
    return 1;
  }

  // Verse is a mutation surface by definition: dispatch is always on.
  const allowDispatch = true;

  let handle: import('../core/types.js').WebServerHandle;
  try {
    handle = await startServer(cfg, { port, open, allowDispatch });
  } catch (err) {
    console.error(red('error: ') + 'Failed to start server: ' + String(err));
    return 1;
  }

  const verseUrl = verseUrlFor(handle.url);

  // V3.10 crash handlers: a fatal exception is written to ~/.ashlr/verse/verse.log
  // and every running turn is settled + its process group killed BEFORE the
  // process exits, so no vendor CLI is left editing files under launchd. A
  // stray promise rejection is logged and survived. See verse-log.ts.
  //
  // The reasoning store batches live steps (250 ms / 64 steps). The engine
  // flushes it from `interruptAll`/`close`; the explicit flush here also
  // covers a crash before any engine exists and closes the tap's open turns.
  // Resolved NOW, not in the handler: onFatal must stay synchronous.
  let flushReasoning: () => void = () => {};
  try {
    const { flushVerseReasoning } = await import('../core/reasoning/ingest-verse.js');
    flushReasoning = () => { try { flushVerseReasoning(); } catch { /* exiting */ } };
  } catch {
    // No reasoning store: nothing to flush.
  }
  let uninstallCrashHandlers: () => void = () => {};
  try {
    const { installVerseCrashHandlers } = await import('../core/verse/verse-log.js');
    const { peekVerseEngine } = await import('../core/verse/verse-api.js');
    uninstallCrashHandlers = installVerseCrashHandlers({
      onFatal: (reason) => {
        // Turns first: settling them emits their final events into the tap.
        try { peekVerseEngine()?.interruptAll?.(reason); } finally { flushReasoning(); }
      },
    });
  } catch {
    // Without the handlers the server still runs; it only loses the crash log.
  }

  // ── Native account metadata collectors ───────────────────────────────────
  //
  // `ResourceConnectionMonitor` keeps its results IN MEMORY ONLY and is
  // otherwise served solely by the separate resource-console process, so the
  // only way Claude windows and Grok auth state reach Verse is for THIS server
  // to run the collectors. The lease is exclusive per root: if
  // `ashlr resource-console` already holds it, the collector degrades to
  // read-only shared evidence and says which collector owns the data.
  //
  // Cost per cycle: ~9-10 short-lived metadata-only process spawns, ZERO tokens
  // and ZERO paid quota. Polling suspends after `--accounts-idle` with no
  // client interest so a backgrounded app never spawns processes forever.
  let collectorClose: (() => Promise<void>) | null = null;
  let collectorBanner: string | null = null;
  if (accounts) {
    try {
      const { startVerseAccountCollector, setVerseAccountCollector } = await import('../core/verse/accounts.js');
      const { resolveAccountsRoot } = await import('../core/verse/seats.js');
      const collector = await startVerseAccountCollector({
        accountsRoot: resolveAccountsRoot(cfg),
        pollIntervalMs: accountsPollSeconds * 1_000,
        idleSuspendMs: accountsIdleMinutes * 60_000,
        log: (message) => { if (!json) console.error(dim(`  ${message}`)); },
      });
      setVerseAccountCollector(collector);
      collectorClose = async () => {
        setVerseAccountCollector(null);
        // close() releases the lease and tolerates an `uncertain` sample:
        // the monitor throws in that case, and exiting cleanly still matters.
        await collector.close();
      };
      const status = collector.status();
      collectorBanner = status.note;
    } catch (err) {
      // A collector failure must never take the console down with it — every
      // account simply reads as unknown until it is fixed.
      collectorBanner = 'Account telemetry unavailable: ' + (err instanceof Error ? err.message : 'unknown error');
    }
  }

  // ── V3.10 background services (health, usage prime, reasoning, budget) ──
  //
  // After the collector, so the first health sweep and the first capacity
  // snapshot read live account telemetry rather than "unknown".
  const background = await startVerseBackgroundServices(cfg, {
    accountServices: accounts,
    log: (message) => { if (!json) console.error(dim(`  ${message}`)); },
  });

  // ── Output (same token wording as serve.ts) ──────────────────────────────

  if (json) {
    const out: Record<string, unknown> = {
      url: handle.url,
      verseUrl,
      consoleUrl: `${handle.url}/next/`,
      port: handle.port,
      allowDispatch,
      readToken: handle.readToken,
      readTokenHeader: 'X-Ashlr-Token',
      token: handle.token,
      tokenHeader: 'X-Ashlr-Token',
      accountTelemetry: accounts,
      accountTelemetryNote: collectorBanner,
    };
    console.log(JSON.stringify(out));
  } else {
    console.log('');
    console.log(bold('  Ashlr Verse') + '  ' + cyan(verseUrl));
    console.log('');
    console.log(`  ${green('✓')} Listening on ${cyan(handle.url)}`);
    console.log(`  ${dim('Bound to 127.0.0.1 only — not externally reachable.')}`);
    console.log('');

    console.log(`  ${dim('Read token')}  ${bold(handle.readToken)}`);
    console.log(`  ${dim('Read header:')} X-Ashlr-Token: ${handle.readToken}`);
    console.log(`  ${dim('The browser exchanges it for a short-lived, read-only HttpOnly cookie.')}`);
    console.log('');

    console.log(`  ${yellow('⚠')}  ${bold('Dispatch enabled')} ${gray('(always on for Verse — sessions edit the chosen project)')}`);
    console.log(`  ${dim('Mutation token')}  ${bold(handle.token)}`);
    console.log(`  ${dim('Mutations require this separate token; the read token and cookie cannot mutate.')}`);
    console.log(`  ${dim('Never share either token or expose the server to other hosts.')}`);
    console.log('');

    if (collectorBanner) {
      console.log(`  ${dim('Account telemetry')}  ${gray(collectorBanner)}`);
      console.log(`  ${dim(`Metadata-only probes every ${accountsPollSeconds}s — zero tokens, zero paid quota.`)}`);
      console.log('');
    }

    console.log(`  ${dim('Press Ctrl-C to stop.')}`);
    console.log('');
  }

  // ── Open browser ──────────────────────────────────────────────────────────

  if (open) {
    try {
      await openBrowser(verseUrl);
      if (!json) console.error(dim(`  Opening ${verseUrl} in your browser…`));
    } catch {
      if (!json) console.error(dim(`  Could not open browser automatically. Navigate to ${verseUrl}`));
    }
  }

  // ── Keep alive until SIGINT ───────────────────────────────────────────────

  await new Promise<void>((resolve) => {
    const onSignal = async () => {
      if (!json) {
        process.stderr.write('\n');
        console.error(dim('  Stopping server…'));
      }
      // Background timers stop first, so no health sweep or capacity tick
      // fires into a collector or server that is half closed.
      background.stop();
      try {
        // Release the metadata lease BEFORE the HTTP server goes away, so a
        // waiting `ashlr resource-console` can take ownership immediately.
        if (collectorClose) await collectorClose();
      } catch {
        // `ResourceConnectionMonitor.close()` throws when a sample ended
        // `uncertain`. That is logged inside the collector; exit cleanly.
      }
      try {
        await handle.close();
      } catch {
        // ignore close errors on shutdown
      }
      // After close(): the engine's own close has settled running turns into
      // the reasoning tap; this writes whatever is still batched.
      flushReasoning();
      resolve();
    };

    process.once('SIGINT', () => void onSignal());
    process.once('SIGTERM', () => void onSignal());
  });

  uninstallCrashHandlers();
  if (!json) console.error(dim('  Server stopped.'));
  return 0;
}

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------

function printUsage(): void {
  console.log('');
  console.log(bold('  ashlr verse') + dim(' [--port N] [--no-open] [--json]'));
  console.log('');
  console.log('  Open the Ashlr Verse console: project + seat (Claude / Codex / Grok / local Ollama)');
  console.log('  multi-turn agent sessions served by the local dashboard server at /verse/.');
  console.log('');
  console.log('  ' + bold('Options:'));
  console.log(`    ${cyan('--port N')}     TCP port to bind on 127.0.0.1 (default ${DEFAULT_PORT})`);
  console.log(`    ${cyan('--no-open')}    Do not open the browser automatically`);
  console.log(`    ${cyan('--json')}       Print startup info (url, verseUrl, tokens) as JSON`);
  console.log(`    ${cyan('--no-accounts')}      Do not run the native account-metadata collectors`);
  console.log(`    ${cyan('--accounts-poll S')}  Collector cadence in seconds (30-3600, default ${VERSE_DEFAULT_ACCOUNTS_POLL_SECONDS})`);
  console.log(`    ${cyan('--accounts-idle M')}  Pause polling after M idle minutes (1-720, default ${VERSE_DEFAULT_ACCOUNTS_IDLE_MINUTES})`);
  console.log('');
  console.log('  ' + bold('Notes:'));
  console.log(`    ${dim('• Equivalent to `ashlr serve --allow-dispatch --open` pointed at /verse/')}`);
  console.log(`    ${dim('• Binds 127.0.0.1 ONLY; read + mutation tokens are printed at startup')}`);
  console.log(`    ${dim('• Seats come from ~/.ashlr/account-connections/connections.json + Ollama')}`);
  console.log(`    ${dim('• Account probes are metadata-only: zero tokens and zero paid quota')}`);
  console.log(`    ${dim('• The metadata lease is exclusive per root; `ashlr resource-console` wins')}`);
  console.log('');
}
