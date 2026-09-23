/**
 * Entry point for the Anthropic proxy host child process.
 *
 * Deliberately three lines of behaviour and no logic. It is the module
 * `proxy-invocation.ts` spawns by path (dev and dist) or reaches by re-entry
 * flag (Bun binary), and it SELF-EXECUTES on import — the same split the
 * account probes use, where `*-account-probe.ts` holds the logic and
 * `*-account-probe-process.ts` is the entry.
 *
 * The split exists so the host is testable. A module that starts a listener at
 * import time cannot be unit-tested; `anthropic-proxy-host.ts` exports the
 * parsing and the bind so a test can drive them on an ephemeral port, and this
 * file is the only thing that turns them into a running process.
 */

import { runAnthropicProxyHost } from './anthropic-proxy-host.js';

// No argv is read. Host, proxy port and upstream port arrive through the
// environment, which is the only channel whose shape is identical in all three
// runtimes — see `anthropicProxyHostEnvironment` for the measurement that
// ruled out an operand tail.
await runAnthropicProxyHost();
