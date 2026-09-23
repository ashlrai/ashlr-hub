/**
 * The Anthropic proxy as a PROCESS, rather than as a listener inside someone
 * else's process.
 *
 * ## Why this file exists
 *
 * `anthropic-proxy.ts` documents its own scope honestly: "the listener lives
 * in THIS process". That is the right design for what it is, and it is also
 * the reason the feature was shipped-but-absent. The two hosts that could keep
 * it alive both fail in practice:
 *
 *   - `ashlr local-runtime start` is a one-shot CLI. It brings the proxy up
 *     and then exits, taking it with it.
 *   - the launch agent runs `/bin/sh <shim>` which `exec`s llama-server
 *     directly and never re-enters the hub, so a launchd-managed runtime — the
 *     only kind that is actually always-on — has no proxy at all.
 *
 * So the Anthropic lane's endpoint was a port nothing listened on, and the
 * gap was filled by a hand-started scratch script outside the repository.
 * This module is that script's committed, supervised replacement: the SAME
 * `startAnthropicProxy` the tests already cover, hosted by a process whose
 * only job is to host it.
 *
 * ## It re-uses, it does not re-implement
 *
 * Every byte of request handling comes from `anthropic-proxy.ts`. Nothing is
 * normalised here. If this file ever grows request logic, the lane has two
 * implementations again and the scratch-script problem has simply moved.
 */

import { originFor, resolveLlamaRuntimeConfig } from './config.js';
import { startAnthropicProxy } from './anthropic-proxy.js';
import type { AnthropicProxyHandle } from './anthropic-proxy.js';
import { loadConfigReadOnly } from '../../config.js';

/**
 * Start the listener and resolve once it is bound.
 *
 * ## There is no argument parsing here, on purpose
 *
 * The parent passes host, proxy port and upstream port through the
 * ENVIRONMENT (see `anthropicProxyHostEnvironment`), because the three
 * shipping runtimes disagree about argv offsets and `node --eval` rejects a
 * trailing operand tail outright. `config.ts` already reads exactly those
 * three variables with the precedence wanted here, so resolving through
 * `resolveLlamaRuntimeConfig` gives the correct answer in every runtime AND
 * keeps this process from becoming a second opinion about where the proxy
 * belongs.
 *
 * Exported separately from {@link runAnthropicProxyHost} so a test can await
 * the handle, assert on the bound port and close it, without the signal
 * handlers and keep-alive timer a real process needs.
 */
export async function startAnthropicProxyHost(): Promise<AnthropicProxyHandle> {
  // READ-ONLY deliberately. `loadConfig()` seeds directories and repairs
  // state; this process starts at every login and must never be the thing
  // that rewrites the operator's config.json as a side effect of booting.
  let cfg;
  try {
    cfg = loadConfigReadOnly();
  } catch {
    // A host that cannot read config still has defaults, and a lane that
    // refuses to start because config.json is mid-write is worse than one
    // that starts on the documented defaults.
    cfg = undefined;
  }
  const runtime = resolveLlamaRuntimeConfig(cfg);

  return startAnthropicProxy({
    cfg,
    host: runtime.host,
    port: runtime.anthropicPort,
    upstreamOrigin: originFor(runtime.host, runtime.port),
  });
}

/**
 * Run as a process: bind, announce, and stay up until signalled.
 *
 * ## The keep-alive timer is load-bearing, and was measured
 *
 * `startAnthropicProxy` calls `server.unref()` on purpose — without it
 * `ashlr local-runtime start` never returns to the shell, which that file
 * documents. The consequence for a STANDALONE host is that the listening
 * socket no longer holds the process open, so the event loop empties and the
 * process exits immediately after binding. Observed directly: a host script
 * that awaited the handle and did nothing else bound the port and exited
 * before a request could be sent.
 *
 * A ref'd timer is therefore what makes this a server rather than a very short
 * program. Unref'ing the listener and re-anchoring the process here is also
 * the honest split: the listener's lifetime is the PROCESS's lifetime, and
 * this process exists for nothing else.
 */
export async function runAnthropicProxyHost(): Promise<void> {
  const handle = await startAnthropicProxyHost();

  // stdout is the launch agent's log. One line, so `local-runtime logs` shows
  // where the lane actually landed rather than where it was asked to land.
  process.stdout.write(
    `[ashlr anthropic-proxy] listening on ${handle.origin} -> ${handle.upstreamOrigin}\n`,
  );
  if (handle.hostDowngradedFrom !== null) {
    process.stderr.write(
      `[ashlr anthropic-proxy] refused non-loopback bind '${handle.hostDowngradedFrom}';` +
        ` bound ${handle.host} instead (this listener has no authentication)\n`,
    );
  }

  const keepAlive = setInterval(() => {}, 1 << 30);

  let shuttingDown = false;
  const shutdown = (signal: NodeJS.Signals): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    process.stdout.write(`[ashlr anthropic-proxy] ${signal}; closing\n`);
    // Bounded: `close()` cuts keep-alive and SSE connections rather than
    // waiting for them to go idle, which an streaming client never does.
    void handle.close().finally(() => {
      clearInterval(keepAlive);
      // Exit 0 on a signal. launchd's KeepAlive is unconditional, so the exit
      // code does not decide whether it comes back — but a non-zero code for
      // an orderly stop would make every `logs` read look like a crash.
      process.exit(0);
    });
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}
