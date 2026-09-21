/**
 * The proxy host process — what `ashlr local-runtime --_proxy-host` runs.
 *
 * This module IS the 24/7 local-agent story. Before it existed the Anthropic
 * normalising proxy was an in-process singleton: a long-lived host kept it up,
 * but `ashlr local-runtime start` set `process.exitCode`, returned to the shell
 * and took the listener with it — llama-server survived (it is detached), so
 * the operator was left with a serving runtime Claude Code could not talk to
 * and no way to fix it but to keep a scratch script alive by hand.
 *
 * The fix is the one the runtime it fronts already uses: a detached child with
 * an ownership record. This file is that child's whole body.
 *
 * WHAT DOES NOT CROSS THE ARGV BOUNDARY, and why it is the point:
 *
 *   The bind host. Argv carries two integers — the proxy's port and
 *   llama-server's — and nothing else. The host is re-derived HERE from the
 *   persisted config and re-gated by `gateBindHost`, so there is no argument,
 *   environment variable or spawn site anywhere that can put this listener on
 *   the network. Neither this proxy nor llama-server behind it has any
 *   authentication of any kind: whoever reaches the port can run inference and
 *   read every slot's prompt. Leaving loopback still requires the persisted
 *   `models.llamaServer.allowNonLoopback: true` opt-in and nothing else.
 *
 *   (Re-gating here is belt AND braces: `startAnthropicProxy` gates its own
 *   `host` argument too. Two gates on one value is deliberate — this is a
 *   detached, unattended process, and the cost of the redundancy is one
 *   function call.)
 */

import { loadConfigReadOnly } from '../../config.js';
import { startAnthropicProxy } from './anthropic-proxy.js';
import {
  allowsNonLoopback,
  gateBindHost,
  originFor,
  resolveLlamaRuntimeConfig,
} from './config.js';
import {
  ANTHROPIC_PROXY_PORT_FLAG,
  ANTHROPIC_PROXY_UPSTREAM_PORT_FLAG,
} from './proxy-process.js';

/** Signals that mean "shut down cleanly", i.e. what `stop` sends. */
const SHUTDOWN_SIGNALS: readonly NodeJS.Signals[] = ['SIGTERM', 'SIGINT', 'SIGHUP'];

/** The two integers the host accepts. Nothing else is a valid invocation. */
export interface ProxyHostArgs {
  port: number;
  upstreamPort: number;
}

/**
 * Parse the host's argv.
 *
 * PURE and strict: an unknown flag, a repeat, a missing value or an
 * out-of-range integer is a refusal, not a default. This argv is written by
 * this program for this program, so anything unexpected means the two halves
 * have drifted — and a proxy that silently binds a port nobody asked for is
 * worse than one that refuses to start and says so in its log.
 */
export function parseProxyHostArgs(args: readonly string[]): ProxyHostArgs | { error: string } {
  let port: number | undefined;
  let upstreamPort: number | undefined;

  const integer = (raw: string | undefined, flag: string): number | { error: string } => {
    const value = Number.parseInt(raw ?? '', 10);
    if (!Number.isInteger(value) || value < 1 || value > 65_535) {
      return { error: `${flag} expects a port between 1 and 65535` };
    }
    return value;
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] as string;
    if (arg !== ANTHROPIC_PROXY_PORT_FLAG && arg !== ANTHROPIC_PROXY_UPSTREAM_PORT_FLAG) {
      return { error: `unexpected argument "${arg}"` };
    }
    const parsed = integer(args[index + 1], arg);
    if (typeof parsed !== 'number') return parsed;
    index += 1;
    if (arg === ANTHROPIC_PROXY_PORT_FLAG) {
      if (port !== undefined) return { error: `${arg} given twice` };
      port = parsed;
    } else {
      if (upstreamPort !== undefined) return { error: `${arg} given twice` };
      upstreamPort = parsed;
    }
  }

  if (port === undefined) return { error: `${ANTHROPIC_PROXY_PORT_FLAG} is required` };
  if (upstreamPort === undefined) {
    return { error: `${ANTHROPIC_PROXY_UPSTREAM_PORT_FLAG} is required` };
  }
  return { port, upstreamPort };
}

/**
 * Run the proxy until a shutdown signal arrives. Resolves with an exit code.
 *
 * Never throws: this process has no terminal to print a stack trace to, so
 * every failure is a line in the stderr log and a non-zero code the supervisor
 * can see through the ownership record going stale.
 */
export async function runAnthropicProxyHost(args: readonly string[]): Promise<number> {
  const parsed = parseProxyHostArgs(args);
  if ('error' in parsed) {
    console.error(`anthropic-proxy host: ${parsed.error}`);
    return 2;
  }

  const cfg = loadConfigReadOnly();
  const runtime = resolveLlamaRuntimeConfig(cfg);
  // Re-gated rather than trusted. `resolveLlamaRuntimeConfig` already applied
  // the rule, but this process is detached and unattended, so the value is
  // re-checked at the point of use where the refusal can still be logged.
  const { host, downgradedFrom } = gateBindHost(runtime.host, allowsNonLoopback(cfg));

  // TWO sources of "a non-loopback host was refused", and both are reported:
  //
  //   `runtime.hostDowngradedFrom` is the resolver's own refusal — the one that
  //   actually fires in practice, because `resolveLlamaRuntimeConfig` gates
  //   before it returns. It carries the host that was REQUESTED (via
  //   ASHLR_LOCAL_RUNTIME_HOST or models.llamaServer.host), which is the only
  //   spelling worth printing: by the time the value reaches `gateBindHost`
  //   below it has already been replaced.
  //
  //   `downgradedFrom` is this module's own re-gate. It cannot fire while the
  //   resolver gates first, and that is exactly why it stays: it is the
  //   assertion that this detached, unattended process never binds a host it
  //   did not check itself, and it would fire the day someone hands this
  //   function an ungated host.
  const refused = runtime.hostDowngradedFrom ?? downgradedFrom;
  if (refused !== null) {
    console.error(
      `anthropic-proxy host: refused the non-loopback bind host '${refused}'; ` +
        `binding ${host} instead. llama-server and this proxy have no authentication of any ` +
        'kind, so leaving loopback requires the persisted opt-in ' +
        'models.llamaServer.allowNonLoopback=true.',
    );
  }

  const upstreamOrigin = originFor(host, parsed.upstreamPort);

  let handle;
  try {
    handle = await startAnthropicProxy({
      cfg,
      host,
      port: parsed.port,
      upstreamOrigin,
      // The whole reason this process exists. Without it Node sees an empty
      // event loop and exits before serving a single request.
      holdProcessOpen: true,
    });
  } catch (err: unknown) {
    console.error(
      `anthropic-proxy host: could not bind ${host}:${parsed.port} — ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
    return 1;
  }

  console.log(
    `anthropic-proxy host: listening on ${handle.origin} -> ${handle.upstreamOrigin} ` +
      `(pid ${process.pid}, started ${new Date().toISOString()})`,
  );

  await new Promise<void>((done) => {
    let shuttingDown = false;
    const shutdown = (signal: NodeJS.Signals): void => {
      if (shuttingDown) return;
      shuttingDown = true;
      console.log(`anthropic-proxy host: ${signal} received, releasing ${handle.origin}`);
      // `close()` cuts live SSE sockets as well as the listener, so this is
      // bounded even with a generation in flight. Once it resolves nothing
      // ref'd is left and Node exits on its own.
      void handle.close().then(
        () => done(),
        () => done(),
      );
    };
    for (const signal of SHUTDOWN_SIGNALS) process.on(signal, shutdown);
  });

  return 0;
}
