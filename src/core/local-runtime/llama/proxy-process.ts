/**
 * Identity and invocation for the DETACHED Anthropic proxy host process.
 *
 * Two jobs, both of which are "a pid is not an identity" problems:
 *
 *  1. HOW TO START ONE. The proxy runs as a child of the hub's own CLI, so
 *     something has to answer "what argv re-enters this program?" — and the
 *     answer differs in all three shipping runtimes. See
 *     {@link anthropicProxyHostInvocation}.
 *
 *  2. HOW TO RECOGNISE ONE. `proxy-supervisor.ts` must be able to adopt a proxy
 *     it did not spawn, refuse a listener it does not own, and terminate only
 *     what is genuinely ours after a pid has possibly been recycled. That is
 *     the same discipline process.ts applies to llama-server, with the same
 *     rule: EVERY condition must hold, because any one of them alone is
 *     forgeable by an unrelated command line.
 *
 * WHY THE ENTRY POINT IS A SUBCOMMAND AND NOT A TOP-LEVEL FLAG: the hub already
 * has internal re-entry flags (`--_cutoff-checkpoint-supervisor`, the probe
 * helpers), all dispatched from `src/cli/index.ts`. This one is reached as
 * `local-runtime --_proxy-host` instead, so the whole dispatch lives inside the
 * `local-runtime` command that owns it. The flag is operand-free apart from two
 * integers, absent from help and completions, and — the part that matters —
 * CANNOT carry a bind host. The child re-derives its host from the persisted
 * config and re-applies `gateBindHost`, so no argv anywhere can move the
 * listener off loopback. See proxy-host.ts.
 */

import { createRequire } from 'node:module';
import { isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  bundledIntoSingleFileBinary,
  insideSingleFileBinaryRoot,
} from '../../resources/probe-helper-invocation.js';
import { processTable } from './process.js';
import type { AnthropicProxyOwnershipRecord } from './types.js';

/** The `local-runtime` subcommand word that re-enters this program as a proxy. */
export const ANTHROPIC_PROXY_HOST_FLAG = '--_proxy-host';

/** The command word the internal flag lives under. */
export const ANTHROPIC_PROXY_COMMAND = 'local-runtime';

/** Flag naming the port the PROXY binds. */
export const ANTHROPIC_PROXY_PORT_FLAG = '--anthropic-port';

/** Flag naming the llama-server port the proxy forwards to. */
export const ANTHROPIC_PROXY_UPSTREAM_PORT_FLAG = '--upstream-port';

/** A proxy host process discovered by scanning the process table. */
export interface DiscoveredAnthropicProxy {
  pid: number;
  argv: string;
  /** Absolute executable path, recovered from argv[0]. */
  execPath: string;
}

/**
 * Argv (after argv[0]) for a proxy host serving `port` from `upstreamPort`.
 *
 * PURE, so the exact spelling is pinned by unit tests rather than discovered
 * from a running process — and so {@link argvMatchesProxyRecord} and this
 * function cannot drift apart into a supervisor that can start a proxy it can
 * never recognise again.
 */
export function anthropicProxyHostArgs(port: number, upstreamPort: number): string[] {
  return [
    ANTHROPIC_PROXY_COMMAND,
    ANTHROPIC_PROXY_HOST_FLAG,
    ANTHROPIC_PROXY_PORT_FLAG,
    String(port),
    ANTHROPIC_PROXY_UPSTREAM_PORT_FLAG,
    String(upstreamPort),
  ];
}

/** The runtime facts entry-point resolution depends on, injectable for tests. */
export interface HostInvocationContext {
  /** `process.execPath` — the real on-disk executable. */
  execPath: string;
  /** `process.argv[1]` — the entry script, absent for a packaged binary. */
  entry: string | undefined;
  /** `process.execArgv` — carries tsx's loader in dev. */
  execArgv: readonly string[];
  /** This module's own `import.meta.url`. The signal argv cannot fake. */
  moduleUrl: string;
  /**
   * The SPAWNER's working directory, which is what a bare loader specifier
   * would otherwise be resolved against. See {@link absoluteLoaderSpecifier}.
   */
  cwd: string;
}

/**
 * Pin a loader specifier to an absolute file URL.
 *
 * The child is spawned with `cwd: homedir()` — deliberately, because a detached
 * process must not hold a working directory that can be deleted out from under
 * it. That makes a BARE specifier a live bug: `node --import tsx/esm
 * src/cli/index.ts …` puts the literal string `tsx/esm` in `execArgv`, the
 * child resolves it from the home directory, finds no `node_modules/tsx`
 * there, and dies with ERR_MODULE_NOT_FOUND before it can even log why.
 *
 * (Not hypothetical: the supervisor test spawns the CLI exactly that way and
 * caught this. Running `tsx` through its own launcher happens to put ABSOLUTE
 * paths in execArgv, so the defect is invisible until someone uses the plain
 * `--import` spelling — a fine way to ship something that works on the
 * maintainer's machine and nowhere else.)
 *
 * Resolution failure returns the specifier untouched: a loader we could not
 * resolve is still more likely to work than one we dropped, and the child's
 * own error message is more useful than a silent omission.
 */
function absoluteLoaderSpecifier(specifier: string, cwd: string): string {
  if (specifier.startsWith('file://') || isAbsolute(specifier)) return specifier;
  try {
    // The filename is a resolution anchor, not a file that has to exist.
    return pathToFileURL(createRequire(join(cwd, 'noop.js')).resolve(specifier)).href;
  } catch {
    return specifier;
  }
}

/**
 * Forward only the loader flags a child genuinely needs to run our source.
 *
 * `--import` / `--require` is how tsx registers its TypeScript loader; without
 * them a child spawned in dev would be handed a `.ts` entry point that plain
 * Node refuses to parse. Everything else in `execArgv` (inspector ports above
 * all) is deliberately dropped: inheriting `--inspect` would make the child
 * fight the parent for the debug port and die.
 *
 * Every forwarded value is made absolute first — see
 * {@link absoluteLoaderSpecifier}.
 */
function childRuntimeArgs(execArgv: readonly string[], cwd: string): string[] {
  const args: string[] = [];
  for (let index = 0; index < execArgv.length; index += 1) {
    const arg = execArgv[index] as string;
    for (const flag of ['--import', '--require'] as const) {
      if (arg.startsWith(`${flag}=`)) {
        args.push(`${flag}=${absoluteLoaderSpecifier(arg.slice(flag.length + 1), cwd)}`);
      } else if (arg === flag) {
        const value = execArgv[index + 1];
        if (value !== undefined) args.push(flag, absoluteLoaderSpecifier(value, cwd));
        index += 1;
      }
    }
  }
  return args;
}

/**
 * Build the command + argv that re-enters this program as a proxy host.
 *
 * THREE SHIPPING RUNTIMES, and the middle one is the trap:
 *
 *   dev / tsx   → node <tsx --require/--import> src/cli/index.ts local-runtime …
 *   npm dist    → node dist/cli/index.js local-runtime …
 *   Bun binary  → <the binary itself> local-runtime …
 *
 * "Compiled" means: re-invoking `execPath` alone re-enters this program, so the
 * entry script must NOT be passed as a command word. Four independent signals
 * decide it, because each covers a case the others miss — this is the same
 * reasoning as `cutoffCaptureCliInvocation` in the daemon, and it is written
 * out again here rather than imported because that function's name, flag
 * argument and failure mode all belong to cutoff capture:
 *
 *   1. `bundledIntoSingleFileBinary(moduleUrl)` — INTRINSIC. Inside a Bun
 *      single-file binary every bundled module's URL collapses onto the virtual
 *      root, and that is true no matter how the process was invoked. This is
 *      the signal argv cannot fool.
 *   2. no `entry` at all — a packaged binary invoked with no script operand.
 *   3. `insideSingleFileBinaryRoot(entry)` — Bun sets argv[1] to
 *      `/$bunfs/root/_entry.js`, a path that does not exist on disk. Spawning
 *      it would hand the CLI a command word it parses as an unknown command and
 *      rejects with exit 2 — a proxy that never starts and never says why. This
 *      is also the only form a unit test can simulate, since `import.meta.url`
 *      cannot be stubbed.
 *   4. `entry === execPath` — a Node SEA, where argv[1] IS the executable and
 *      `import.meta.url` is an ordinary on-disk path.
 *
 * This repository has shipped the /$bunfs/root defect three times (both account
 * probes, then cutoff capture). Signals 1 and 3 are precisely what
 * probe-helper-invocation.ts exports to stop it happening a fourth.
 */
export function anthropicProxyHostInvocation(
  port: number,
  upstreamPort: number,
  context: HostInvocationContext,
): { command: string; args: string[] } {
  const hostArgs = anthropicProxyHostArgs(port, upstreamPort);
  const { entry } = context;

  const compiled =
    bundledIntoSingleFileBinary(context.moduleUrl) ||
    entry === undefined ||
    entry.length === 0 ||
    insideSingleFileBinaryRoot(entry) ||
    resolve(entry) === resolve(context.execPath);

  return {
    command: context.execPath,
    args: compiled
      ? hostArgs
      : [...childRuntimeArgs(context.execArgv, context.cwd), entry, ...hostArgs],
  };
}

/** This process's own facts, for the non-test call site. */
export function currentHostInvocationContext(moduleUrl: string): HostInvocationContext {
  return {
    execPath: process.execPath,
    entry: process.argv[1],
    execArgv: process.execArgv,
    moduleUrl,
    cwd: process.cwd(),
  };
}

/**
 * Does an argv line carry `--anthropic-port <n>` for exactly this port?
 *
 * Matches the `=` spelling too, so a hand-typed invocation is still recognised
 * as ours rather than becoming an unkillable stranger on our own port.
 */
export function argvBindsAnthropicPort(argv: string, port: number): boolean {
  const pattern = new RegExp(
    `(?:^|\\s)${ANTHROPIC_PROXY_PORT_FLAG}(?:=|\\s+)${port}(?:\\s|$)`,
  );
  return pattern.test(argv);
}

/**
 * Is this argv line a proxy host invocation (and not, say, a grep for one)?
 *
 * Requires BOTH the command word and the internal flag as standalone tokens.
 * The flag is undocumented and absent from help, parsing and completions, so an
 * argv carrying it is one this program wrote — but requiring the command word
 * as well keeps a stray mention in some other tool's arguments from being
 * mistaken for a process we may terminate.
 */
export function isAnthropicProxyHostArgv(argv: string): boolean {
  const tokens = argv.trim().split(/\s+/);
  return tokens.includes(ANTHROPIC_PROXY_COMMAND) && tokens.includes(ANTHROPIC_PROXY_HOST_FLAG);
}

/**
 * Does this argv line belong to the proxy host described by the record?
 *
 * Pure, so the rule is testable without a live process. Three independent facts
 * must all hold before the recorded pid may be signalled — the direct analogue
 * of {@link import('./process.js').argvMatchesRecord}:
 *
 *   1. argv[0] is the recorded executable,
 *   2. it is a proxy host invocation at all, and
 *   3. it binds the recorded proxy port.
 *
 * A recycled pid belongs to some other program, whose argv will not be our CLI
 * re-entering itself on our port — which is what makes recycling harmless.
 */
export function argvMatchesProxyRecord(
  argv: string,
  record: AnthropicProxyOwnershipRecord,
): boolean {
  const line = argv.trim();
  if (!line || !record.execPath) return false;
  if (line !== record.execPath && !line.startsWith(`${record.execPath} `)) return false;
  if (!isAnthropicProxyHostArgv(line)) return false;
  return argvBindsAnthropicPort(line, record.port);
}

/**
 * Find every live proxy host bound to `port`.
 *
 * Used to ADOPT a proxy this process did not spawn — the ordinary case, since
 * `ashlr local-runtime start` exits and the next invocation is a different
 * process entirely — and to let `stop` release the port afterwards.
 */
export function findAnthropicProxiesOnPort(port: number): DiscoveredAnthropicProxy[] {
  const found: DiscoveredAnthropicProxy[] = [];
  for (const { pid, argv } of processTable()) {
    if (!isAnthropicProxyHostArgv(argv)) continue;
    if (!argvBindsAnthropicPort(argv, port)) continue;
    const execPath = argv.split(/\s+/)[0] as string;
    // An argv[0] that is not an absolute path cannot be compared against a
    // record, and cannot be re-derived either; treat it as unidentifiable
    // rather than guessing, exactly as the llama-server scan does.
    if (!isAbsolute(execPath)) continue;
    found.push({ pid, argv, execPath });
  }
  return found;
}
