/**
 * How to spawn the Anthropic proxy host, from ANY caller.
 *
 * ## The defect this module exists to not repeat
 *
 * `verse-detached-proxy-wip` (commit c7853f0a) built the child argv from
 * `process.argv[1]`, i.e. "re-run whatever script this process was started
 * from, with proxy flags appended". That is correct exactly once — when the
 * running process is the `ashlr` CLI — and wrong for every other caller. The
 * Verse web server, which is the long-lived host this feature exists to serve,
 * has its OWN argv[1]; the spawn therefore re-ran the Verse server with
 * `--anthropic-port N` appended, which it ignored before exiting, and the
 * parent reported `the Anthropic proxy host exited while starting`.
 *
 * The rule that follows, and the reason this file is separate from the
 * supervisor: **the child is resolved from THIS MODULE'S OWN LOCATION, never
 * from how the parent process happened to be launched.** `import.meta.url` is
 * a property of the code; `argv[1]` is a property of the invocation. Only the
 * first is stable across callers.
 *
 * ## Three shipping runtimes, three invocations
 *
 * Deliberately the same shape as {@link import('../../resources/probe-helper-invocation.js').probeHelperArgv},
 * which solved this for the account probes, and it reuses that module's
 * predicates rather than re-deriving the `/$bunfs/` sentinel:
 *
 *   dev / tsx    → `node --eval` with tsx registered, importing the sibling .ts
 *   npm dist     → `node <sibling .js on disk>`
 *   Bun binary   → this same binary re-entered on a fixed flag
 *
 * The Bun case exists because `bun build --compile` collapses every bundled
 * module's `import.meta.url` onto `file:///$bunfs/root/<binary>`, a virtual
 * root with no on-disk files — so the sibling-path spelling the other two
 * runtimes use resolves to a path that cannot be spawned. That is the same
 * defect this repo has shipped three times (the Codex probe, the Grok probe,
 * and cutoff capture), which is why it is handled here on day one.
 */

import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  bundledIntoSingleFileBinary,
  insideSingleFileBinaryRoot,
} from '../../resources/probe-helper-invocation.js';

/**
 * Internal re-entry flag for the compiled-binary case.
 *
 * Absent from command parsing, help output and completions, so it is
 * unreachable from normal CLI use. Unlike the probe-helper flags it DOES take
 * operands (`--port`, `--host`, `--upstream`), following the precedent of
 * `--_cutoff-checkpoint-worker`. Every operand is re-validated by the host
 * itself — the port through an integer range check, the bind host through
 * `gateBindHost`, which no argument can talk out of loopback — so influence
 * over this argv cannot widen the listener's exposure.
 */
export const ANTHROPIC_PROXY_HOST_FLAG = '--_anthropic-proxy-host';

/** The sibling module that actually runs the listener. */
const HOST_MODULE_BASENAME = 'anthropic-proxy-process';

/**
 * Build the argv that runs the Anthropic proxy host for the current runtime.
 *
 * `moduleUrl` defaults to this module's own URL and is a parameter only so the
 * three branches can be unit-tested without stubbing `import.meta`, which is
 * not stubbable. Callers should not pass it.
 *
 * The returned `command` is always `process.execPath`, which is the one path
 * that is real on disk in all three runtimes.
 */
export function anthropicProxyHostArgv(moduleUrl: string = import.meta.url): string[] {
  // Running from TypeScript source: the sibling is a .ts file, which bare
  // `node` cannot execute. Register tsx in the child exactly as the account
  // probes do, then import the sibling by URL.
  if (moduleUrl.endsWith('.ts')) {
    const loader = pathToFileURL(createRequire(moduleUrl).resolve('tsx/esm/api')).href;
    const source = new URL(`./${HOST_MODULE_BASENAME}.ts`, moduleUrl).href;
    return [
      process.execPath,
      '--input-type=module',
      '--eval',
      `import { register } from ${JSON.stringify(loader)}; register(); await import(${JSON.stringify(source)});`,
    ];
  }

  // Inside a single-file bundle no sibling file exists on disk. `execPath` is
  // the real binary and re-entering it on the fixed flag is the only spelling
  // that resolves. Checked BEFORE the on-disk branch, because that branch
  // would otherwise hand back a `/$bunfs/...` path that cannot be spawned.
  if (bundledIntoSingleFileBinary(moduleUrl) || insideSingleFileBinaryRoot(moduleUrl)) {
    return [process.execPath, ANTHROPIC_PROXY_HOST_FLAG];
  }

  // Ordinary compiled output: the sibling .js sits next to this file.
  return [process.execPath, fileURLToPath(new URL(`./${HOST_MODULE_BASENAME}.js`, moduleUrl))];
}

/** What the parent wants the child to serve. */
export interface AnthropicProxyHostOptions {
  /** Bind host for the proxy. Still gated to loopback by the child. */
  host?: string;
  /** Port for the proxy itself. */
  port?: number;
  /** llama-server's port, i.e. what the proxy forwards to. */
  upstreamPort?: number;
}

/**
 * Configuration is passed to the child through the ENVIRONMENT, not argv.
 *
 * ## Measured, because the obvious spelling does not work
 *
 * The three runtimes disagree about argv in ways that silently corrupt an
 * operand tail:
 *
 *   `node <file> --port N`            → operands begin at argv[2]
 *   `node --eval "…" -- --port N`     → operands begin at argv[1]; without the
 *                                        `--`, node rejects the run outright
 *                                        with `node: bad option: --port`
 *   `<binary> --_flag --port N`       → the CLI strips its own flag first
 *
 * Three different offsets and one hard failure, so any single `slice()` is
 * wrong in at least one shipping runtime — and wrong in the quiet way, where
 * the child starts on defaults and serves the wrong port.
 *
 * The environment has none of that: it is a flat map, identical in all three,
 * and `config.ts` ALREADY defines these three variables with exactly the
 * precedence wanted here (environment beats config beats default). So the
 * child needs no argument plumbing at all — it calls
 * `resolveLlamaRuntimeConfig` like everything else and gets the right answer,
 * which keeps the single-source-of-truth rule that module is built around.
 */
export function anthropicProxyHostEnvironment(
  options: AnthropicProxyHostOptions = {},
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  if (options.host !== undefined) env['ASHLR_LOCAL_RUNTIME_HOST'] = options.host;
  if (options.port !== undefined) env['ASHLR_LOCAL_RUNTIME_ANTHROPIC_PORT'] = String(options.port);
  if (options.upstreamPort !== undefined) {
    env['ASHLR_LOCAL_RUNTIME_PORT'] = String(options.upstreamPort);
  }
  return env;
}

/** The complete spawn description for the Anthropic proxy host. */
export function anthropicProxyHostInvocation(
  options: AnthropicProxyHostOptions = {},
  moduleUrl: string = import.meta.url,
): { command: string; args: string[]; env: NodeJS.ProcessEnv } {
  const [command, ...args] = anthropicProxyHostArgv(moduleUrl);
  return {
    command: command as string,
    args,
    env: anthropicProxyHostEnvironment(options),
  };
}
