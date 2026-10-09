/**
 * `ashlr verse` CLI command — open the Phantom operator console.
 *
 * Usage:
 *   ashlr verse [--port N] [--no-open] [--json]
 *   ashlr verse --remote-config <private-json-file>  (explicit phone gateway)
 *   ashlr verse remote <invite|pending|approve|deny|revoke|devices>
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
  remoteConfig: string | null;
  /** Private startup-token handshake for the native app's own sidecar. */
  desktopTokenHandoff: boolean;
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
  let remoteConfig: string | null = null;
  let desktopTokenHandoff = false;

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

    } else if (arg === '--remote-config') {
      const path = args[++i];
      if (!path || path.startsWith('-')) return { error: '--remote-config requires a private JSON file path', code: 2 };
      remoteConfig = path;

    } else if (arg === '--desktop-token-handoff') {
      desktopTokenHandoff = true;

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

  if (desktopTokenHandoff && (!json || !remoteConfig)) {
    return { error: '--desktop-token-handoff requires --json and --remote-config', code: 2 };
  }
  return { port, open, json, accounts, accountsPollSeconds, accountsIdleMinutes, remoteConfig, desktopTokenHandoff };
}

/** Remote service logs omit Hub tokens; only the native app's private stdout
 * handshake may receive them when it owns both the desktop and phone gateway. */
export function verseStartupTokenFields(remote: boolean, desktopTokenHandoff: boolean,
  tokens: { readToken: string; token: string }) {
  return remote && !desktopTokenHandoff ? {} : {
    readToken: tokens.readToken, readTokenHeader: 'X-Ashlr-Token',
    token: tokens.token, tokenHeader: 'X-Ashlr-Token',
  };
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
 *     nobody has the budget panel open;
 *   - retro sweep (3.15): task ends → Lessons, hourly, even when nobody opens
 *     Lessons.
 * Every loader is a seam for tests; the defaults are the real modules.
 */
export interface VerseBackgroundDeps {
  loadHealth?: () => Promise<{ startVerseHealth: (cfg: AshlrConfig) => unknown; stopVerseHealth: () => void }>;
  loadClaudeUsage?: () => Promise<{ primeClaudeUsage: () => Promise<void> }>;
  loadReasoning?: () => Promise<{ scheduleReasoningMaintenance: (cfg?: unknown) => void; resetReasoningApiState: () => void }>;
  loadBudget?: () => Promise<{ startBudgetCapacityPublisher: (cfg: AshlrConfig) => () => void }>;
  loadApps?: () => Promise<{ warmVerseApps: (cfg: AshlrConfig) => Promise<void> }>;
  loadWiki?: () => Promise<{ scheduleWikiAutoRefresh: (cfg: AshlrConfig) => (() => void) | null }>;
  loadAutomations?: () => Promise<{ scheduleAutomationsTick: () => (() => void) | null }>;
  loadRetroSweep?: () => Promise<{ scheduleRetroSweep: (cfg: AshlrConfig) => (() => void) | null }>;
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
  await attempt('apps', async () => {
    const mod = await (deps.loadApps ?? (() => import('../core/verse/apps-api.js')))();
    // NOT awaited, like the usage prime: the cold Apps collect (login-shell
    // PATH probe, version reads, loopback probes) took 1.35–1.8 s when the
    // first GET /api/verse/apps paid for it. Warmed here, that request is
    // served from a finished — or joins the in-flight — collect. Status
    // commands and loopback GETs only; warmVerseApps never rejects.
    void mod.warmVerseApps(cfg).catch(() => {});
    return null;
  });
  // 3.15: keep EXISTING repo wikis fresh — one stale repo per interval, its
  // stale pages only, on a small page budget, through the seat routing (local
  // first, never Claude). Never creates a wiki nobody asked for; off with
  // foundry.wiki.autoRefresh=false. A throwaway --no-accounts server does not
  // run it: background model work belongs to the live console.
  if (accountServices) await attempt('wiki', async () => {
    const mod = await (deps.loadWiki ?? (() => import('../core/knowledge/wiki/jobs.js')))();
    return mod.scheduleWikiAutoRefresh(cfg);
  });
  // 3.15 automations: one tick a minute polls due triggers (labelled issues,
  // red default branches, schedules) and hands queued firings to their lanes
  // through the lanes' own entry points — grant, KILL and budgets included.
  // Live console only (not --no-accounts); never in a test process.
  if (accountServices) await attempt('automations', async () => {
    const mod = await (deps.loadAutomations ?? (() => import('../core/automations/scheduler.js')))();
    return mod.scheduleAutomationsTick();
  });
  // 3.15 Lessons: sweep task ends into retros + suggested knowledge without
  // waiting for someone to open Lessons. First tick minutes after start (never
  // during startup), then hourly; skips while a user sweep runs. Live console
  // only; never in a test process. server.ts close() also stops it.
  if (accountServices) await attempt('retro-sweep', async () => {
    const mod = await (deps.loadRetroSweep ?? (() => import('../core/learn/retro/sweep-timer.js')))();
    return mod.scheduleRetroSweep(cfg);
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
  if (args[0] === 'remote') {
    const { cmdVerseRemote } = await import('./verse-remote.js');
    return cmdVerseRemote(args.slice(1));
  }
  const parsed = parseVerseArgs(args);

  if ('error' in parsed) {
    if (parsed.code === 0) {
      printUsage();
      return 0;
    }
    console.error(red('error: ') + parsed.error);
    console.error(dim('Run `phm verse --help` for usage.'));
    return parsed.code;
  }

  const { port, open, json, accounts, accountsPollSeconds, accountsIdleMinutes, remoteConfig, desktopTokenHandoff } = parsed;

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

  let remote: Awaited<ReturnType<typeof import('../core/web/remote-runtime.js')['startRemoteRuntime']>> | null = null;
  if (remoteConfig) {
    try {
      const { startRemoteRuntime } = await import('../core/web/remote-runtime.js');
      remote = await startRemoteRuntime(remoteConfig, handle);
    } catch (error) {
      console.error(red('error: ') + 'Remote gateway could not start: ' + String(error));
      await handle.close();
      return 1;
    }
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
      ...verseStartupTokenFields(remote !== null, desktopTokenHandoff, handle),
      accountTelemetry: accounts,
      accountTelemetryNote: collectorBanner,
      remoteGateway: remote ? { url: remote.gateway.url, publicOrigin: remote.publicOrigin,
        operatorSocket: remote.admin.path } : null,
    };
    console.log(JSON.stringify(out));
  } else {
    console.log('');
    console.log(bold('  Phantom') + '  ' + cyan(verseUrl));
    console.log('');
    console.log(`  ${green('✓')} Listening on ${cyan(handle.url)}`);
    console.log(`  ${dim('Bound to 127.0.0.1 only — not externally reachable.')}`);
    console.log('');

    if (remote) {
      console.log(`  ${dim('Local Phantom credentials are withheld from remote service output.')}`);
    } else {
      console.log(`  ${dim('Read token')}  ${bold(handle.readToken)}`);
      console.log(`  ${dim('Read header:')} X-Ashlr-Token: ${handle.readToken}`);
      console.log(`  ${dim('The browser exchanges it for a short-lived, read-only HttpOnly cookie.')}`);
      console.log('');
      console.log(`  ${yellow('⚠')}  ${bold('Dispatch enabled')} ${gray('(always on for Phantom — sessions edit the chosen project)')}`);
      console.log(`  ${dim('Mutation token')}  ${bold(handle.token)}`);
      console.log(`  ${dim('Mutations require this separate token; the read token and cookie cannot mutate.')}`);
      console.log(`  ${dim('Never share either token or expose the server to other hosts.')}`);
    }
    console.log('');

    if (remote) {
      console.log(`  ${green('✓')} Phone gateway on ${cyan(remote.gateway.url)} (loopback only)`);
      console.log(`  ${dim('Public Access origin:')} ${remote.publicOrigin}`);
      console.log(`  ${dim('Mac operator commands:')} phm verse remote pending | invite | approve | revoke`);
      console.log(`  ${dim('Tunnel and DNS require separate provisioning; this listener is not public by itself.')}`);
      console.log('');
    }

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
        if (remote) await remote.close();
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
  console.log(bold('  phm verse') + dim(' [--port N] [--no-open] [--json]'));
  console.log(dim('  Phantom CLI (ashlr remains compatible)'));
  console.log('');
  console.log('  Open the Phantom console: project + seat (Claude / Codex / Grok / local Ollama)');
  console.log('  multi-turn agent sessions served by the local dashboard server at /verse/.');
  console.log('');
  console.log('  ' + bold('Options:'));
  console.log(`    ${cyan('--port N')}     TCP port to bind on 127.0.0.1 (default ${DEFAULT_PORT})`);
  console.log(`    ${cyan('--no-open')}    Do not open the browser automatically`);
  console.log(`    ${cyan('--json')}       Print startup info (url, verseUrl, tokens) as JSON`);
  console.log(`    ${cyan('--remote-config FILE')}  Start separate loopback phone gateway with private Access config`);
  console.log(`    ${cyan('remote <command>')}  Mac-only invite, inspect, approve, deny, or revoke phone devices`);
  console.log(`    ${cyan('--no-accounts')}      Do not run the native account-metadata collectors`);
  console.log(`    ${cyan('--accounts-poll S')}  Collector cadence in seconds (30-3600, default ${VERSE_DEFAULT_ACCOUNTS_POLL_SECONDS})`);
  console.log(`    ${cyan('--accounts-idle M')}  Pause polling after M idle minutes (1-720, default ${VERSE_DEFAULT_ACCOUNTS_IDLE_MINUTES})`);
  console.log('');
  console.log('  ' + bold('Notes:'));
  console.log(`    ${dim('• Equivalent to `phm serve --allow-dispatch --open` pointed at /verse/')}`);
  console.log(`    ${dim('• Binds 127.0.0.1 ONLY; read + mutation tokens are printed at startup')}`);
  console.log(`    ${dim('• Seats come from ~/.ashlr/account-connections/connections.json + Ollama')}`);
  console.log(`    ${dim('• Account probes are metadata-only: zero tokens and zero paid quota')}`);
  console.log(`    ${dim('• The metadata lease is exclusive per root; `phm resources pool console` wins')}`);
  console.log('');
}
