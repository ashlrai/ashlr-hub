/**
 * CLI handler for `ashlr local-runtime` — supervise the local serving runtime.
 *
 * The runtime is a llama.cpp `llama-server` bound to loopback, serving the
 * Qwen3.8 GGUF that Ollama already downloaded, across N continuous-batching
 * slots. docs/LOCAL-FLEET.md has the measurement that forced this design:
 * Ollama refuses parallel requests for this model architecture, so four agents
 * queue (3.7 / 7.6 / 11.4 / 15.2s); llama-server finishes all four together
 * (8.6 / 8.9 / 9.0 / 9.0s) off ONE 27 GB copy of the weights.
 *
 * Usage:
 *   ashlr local-runtime status  [--json]
 *   ashlr local-runtime start   [--port N] [--slots N] [--ctx N] [--model REF] [--wait-ms N]
 *   ashlr local-runtime stop    [--port N] [--force]
 *   ashlr local-runtime restart [same flags as start]
 *   ashlr local-runtime install [--port N] [--slots N] [--ctx N] [--model REF]
 *   ashlr local-runtime uninstall
 *   ashlr local-runtime logs    [--lines N]
 *   ashlr local-runtime resolve-model [--model REF]
 *
 * SAFETY INVARIANTS enforced at this layer:
 *
 *  - `install` writes a launchd plist to ~/Library/LaunchAgents/, which is
 *    OUTSIDE this repository and outside ~/.ashlr. It happens only on the
 *    explicit `install` verb, the absolute path is always printed, and
 *    `uninstall` reverses it completely.
 *
 *  - `install` is REFUSED while ~/.ashlr/KILL is engaged. A launch agent is
 *    standing authority to bring a serving runtime up at every login without
 *    anyone present; that is exactly what the kill switch withholds. This
 *    command NEVER creates, removes or edits the sentinel — clearing it is the
 *    operator's decision, made with `ashlr enroll kill off`.
 *
 *  - `start` / `stop` / `status` are manual, attended operations on a local
 *    inference server and are not gated on the switch; a model server serving
 *    a request is not autonomous dispatch. The switch state is nevertheless
 *    reported in `status` so it is never a surprise.
 *
 *  - Nothing here reads or writes ~/.ashlr/config.json. Configuration is read
 *    through loadConfigReadOnly().
 *
 * Exit codes: 0 success, 1 runtime error/refusal, 2 bad usage.
 */

import { readFileSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { loadConfigReadOnly } from '../core/config.js';
import { readKillSwitch } from '../core/sandbox/policy.js';
import {
  RUNTIME_SHAPES,
  resolveRuntimeShape,
  reshapeBlockedBy,
  contextPerAgent,
  describeShape,
} from '../core/local-runtime/llama/shapes.js';
import {
  anthropicProxyHostInvocation,
  anthropicProxyLogPaths,
  buildLlamaServerArgs,
  installAnthropicProxyAgent,
  installLaunchAgent,
  isLoopbackHost,
  launchAgentInstalled,
  launchAgentLoaded,
  launchAgentLogPaths,
  launchAgentPlistPath,
  resolveLlamaRuntimeConfig,
  resolveOllamaModelBlob,
  restartLocalRuntime,
  startLocalRuntime,
  statusLocalRuntime,
  stopLocalRuntime,
  uninstallAnthropicProxyAgent,
  uninstallLaunchAgent,
} from '../core/local-runtime/llama/index.js';
import type {
  LifecycleOptions,
  LlamaRuntimeConfig,
  LlamaRuntimeSnapshot,
} from '../core/local-runtime/llama/index.js';
import { makeColors, isTty } from './ui.js';

const USAGE = `usage: ashlr local-runtime <status|start|stop|restart|install|uninstall|logs|resolve-model> [options]

  status                 Health, model, slots, uptime. --json for the typed snapshot.
  start                  Launch llama-server (or adopt one already on the port).
  stop                   Terminate it cleanly and release the port. --force for an unowned one.
  restart                stop then start.
  reshape <plan|execute> Re-divide the context between agents. Refuses while slots are busy.
                           plan     1 slot  x 262,144 - read widely, plan, review
                           execute  4 slots x  65,536 - targeted edits in parallel
  install                Write + load a launchd agent so it runs 24/7. Refused while KILL is engaged.
  uninstall              Boot out and remove the launch agent.
  logs                   Tail the runtime's stderr log.
  resolve-model          Print the current GGUF blob path for a model reference.
                         Used by the launch agent's shim, so a re-pulled model
                         does not leave a 24/7 job pointed at a collected blob.

options:
  --port N               TCP port (default 8080)
  --slots N              Concurrent slots to request (default 4)
  --ctx N                Total context shared across slots (default 262144).
                         Divided by --slots: 4 slots gives each agent 65536.
                         Use --slots 1 for one agent with the whole window.
  --model REF            Ollama model reference to serve (default: the hub's local model)
  --model-path PATH      Serve this GGUF directly, bypassing Ollama's store
  --wait-ms N            How long start waits for /health (default 300000)
  --lines N              Lines of log to show (logs; default 40)
  --force                stop: terminate a llama-server we have no record for
  --json                 Machine-readable output`;

/** Parse `--flag value` pairs without a dependency. Unknown flags are usage errors. */
interface ParsedFlags {
  json: boolean;
  force: boolean;
  /** Bare words after the subcommand, in order. */
  positionals: string[];
  port?: number;
  slots?: number;
  ctx?: number;
  model?: string;
  modelPath?: string;
  waitMs?: number;
  lines?: number;
  error?: string;
}

function parseFlags(args: string[]): ParsedFlags {
  const out: ParsedFlags = { json: false, force: false, positionals: [] };

  const num = (raw: string | undefined, name: string, min: number, max: number): number | undefined => {
    const value = Number.parseInt(raw ?? '', 10);
    if (!Number.isInteger(value) || value < min || value > max) {
      out.error = `${name} expects an integer between ${min} and ${max}`;
      return undefined;
    }
    return value;
  };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] as string;
    switch (arg) {
      case '--json': out.json = true; break;
      case '--force': out.force = true; break;
      case '--port': out.port = num(args[++i], '--port', 1, 65_535); break;
      case '--slots': out.slots = num(args[++i], '--slots', 1, 64); break;
      case '--ctx': out.ctx = num(args[++i], '--ctx', 512, 4_194_304); break;
      case '--wait-ms': out.waitMs = num(args[++i], '--wait-ms', 1_000, 3_600_000); break;
      case '--lines': out.lines = num(args[++i], '--lines', 1, 5_000); break;
      case '--model': {
        const value = args[++i];
        if (!value || value.startsWith('--')) { out.error = '--model expects a value'; break; }
        out.model = value;
        break;
      }
      case '--model-path': {
        const value = args[++i];
        if (!value || value.startsWith('--')) { out.error = '--model-path expects a value'; break; }
        out.modelPath = value;
        break;
      }
      default:
        // A bare word is a positional, not a bad flag. `reshape <plan|execute>`
        // takes one; rejecting it here made the subcommand unreachable.
        if (typeof arg === 'string' && !arg.startsWith('-')) {
          out.positionals.push(arg);
          break;
        }
        out.error = `unknown option "${arg}"`;
    }
    if (out.error) break;
  }
  return out;
}

/** Turn parsed flags into the runtime overrides the supervisor accepts. */
function runtimeOverrides(flags: ParsedFlags): Partial<LlamaRuntimeConfig> {
  const overrides: Partial<LlamaRuntimeConfig> = {};
  if (flags.port !== undefined) overrides.port = flags.port;
  if (flags.slots !== undefined) overrides.slots = flags.slots;
  if (flags.ctx !== undefined) overrides.context = flags.ctx;
  if (flags.model !== undefined) overrides.modelRef = flags.model;
  if (flags.modelPath !== undefined) overrides.modelPath = flags.modelPath;
  return overrides;
}

/** Human-readable duration. */
function humanDuration(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return 'unknown';
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

/** Render a snapshot for a terminal. */
function printSnapshot(snapshot: LlamaRuntimeSnapshot): void {
  const c = makeColors(isTty());
  const stateLabel =
    snapshot.state === 'up' ? c.green('up')
      : snapshot.state === 'loading' ? c.yellow('loading')
        : snapshot.state === 'down' ? c.red('down')
          : c.dim('unknown');

  console.log(`local runtime  ${stateLabel}  ${c.dim(snapshot.origin)}`);
  console.log(`  engine       llama-server (OpenAI-compatible at ${snapshot.baseUrl})`);
  console.log(`  model        ${snapshot.modelName ?? c.dim('unknown')}${snapshot.quant ? c.dim(` (${snapshot.quant})`) : ''}`);

  // Slots are printed with their provenance because a number whose source is
  // 'unknown' must not be mistaken for a measured one.
  const slots = snapshot.slots;
  const slotText = slots.configured === null
    ? c.dim('unknown — do not size a fleet from this')
    : `${slots.busy ?? '?'} busy / ${slots.configured} total ${c.dim(`(from /${slots.source})`)}`;
  console.log(`  slots        ${slotText}`);

  console.log(`  context      ${snapshot.contextPerSlot ?? '?'} per slot${
    snapshot.contextTotal ? c.dim(` (${snapshot.contextTotal} total)`) : ''}`);
  console.log(`  process      ${snapshot.pid === null ? c.dim('not managed by ashlr') : `pid ${snapshot.pid} (${snapshot.owner})`}`);
  console.log(`  uptime       ${humanDuration(snapshot.uptimeMs)}`);
  console.log(`  launch agent ${snapshot.launchAgentInstalled
    ? `${c.green('installed')} ${launchAgentLoaded() ? c.dim('(loaded)') : c.yellow('(not loaded)')}`
    : c.dim('not installed — this runtime stops when the machine restarts')}`);
  if (snapshot.killSwitchEngaged) {
    console.log(`  kill switch  ${c.yellow('engaged')} ${c.dim('(~/.ashlr/KILL — autonomous operation is withheld)')}`);
  }
  if (snapshot.lastError) {
    console.log(`  last error   ${c.dim(snapshot.lastError)}`);
  }
}

/**
 * `reshape` — re-divide the runtime's context between agents.
 *
 * Reshaping RESTARTS llama-server, so a slot that is generating loses its turn
 * mid-stream and the agent sees a truncated response rather than an error it
 * can act on. `reshapeBlockedBy` is what stops that happening silently, and
 * `--force` is the deliberate override.
 */
async function cmdReshape(
  flags: ParsedFlags,
  options: LifecycleOptions,
  args: readonly string[],
): Promise<number> {
  const shape = resolveRuntimeShape(args[0]);
  if (!shape) {
    console.error(
      `reshape needs a shape name.\n\n  ${describeShape(RUNTIME_SHAPES.plan)}\n`
      + `  ${describeShape(RUNTIME_SHAPES.execute)}`,
    );
    return 2;
  }

  const live = await statusLocalRuntime(options);
  const block = reshapeBlockedBy({
    target: shape,
    capacity: live.slots ?? null,
    currentContextPerSlot: live.contextPerSlot ?? null,
  });

  if (block && !flags.force) {
    console.error(`reshape refused: ${block.detail}`);
    if (block.kind === 'busy') console.error('Wait for those turns, or pass --force to end them.');
    return 1;
  }

  const per = contextPerAgent(shape).toLocaleString('en-US');
  console.log(
    `reshaping to ${shape.name}: ${shape.slots} slot${shape.slots === 1 ? '' : 's'} x ${per} tokens each`,
  );

  return await runLifecycle('restart', flags, {
    ...options,
    runtime: { ...options.runtime, slots: shape.slots, context: shape.context },
  });
}

/** `status` — read-only. */
async function cmdStatus(flags: ParsedFlags, options: LifecycleOptions): Promise<number> {
  const snapshot = await statusLocalRuntime(options);
  if (flags.json) {
    console.log(JSON.stringify(snapshot, null, 2));
    return 0;
  }
  printSnapshot(snapshot);
  if (snapshot.state !== 'up') {
    const c = makeColors(isTty());
    console.log(`\n${c.dim('start it with: ashlr local-runtime start')}`);
  }
  return snapshot.state === 'up' ? 0 : 1;
}

/** `start` / `restart` / `stop` share this reporting shape. */
async function runLifecycle(
  verb: 'start' | 'stop' | 'restart',
  flags: ParsedFlags,
  options: LifecycleOptions,
): Promise<number> {
  const result =
    verb === 'start' ? await startLocalRuntime(options)
      : verb === 'stop' ? await stopLocalRuntime(options)
        : await restartLocalRuntime(options);

  if (flags.json) {
    console.log(JSON.stringify(result, null, 2));
    return result.ok ? 0 : 1;
  }

  const c = makeColors(isTty());
  console.log(`${result.ok ? c.green('ok') : c.red(result.action)}  ${result.detail}`);
  if (verb !== 'stop') printSnapshot(result.snapshot);
  if (result.logs && !result.ok) {
    console.log(`\n${c.dim(`logs: ${result.logs.stderr}`)}`);
  }
  return result.ok ? 0 : 1;
}

/**
 * `install` — write and load the launch agent.
 *
 * Refused while the kill switch is engaged, and the refusal explains itself:
 * this is the one verb in the family that grants standing, unattended
 * authority, and the switch exists to withhold exactly that.
 */
async function cmdInstall(flags: ParsedFlags, runtime: LlamaRuntimeConfig): Promise<number> {
  const c = makeColors(isTty());
  const plistPath = launchAgentPlistPath();

  const kill = readKillSwitch();
  if (kill.state !== 'inactive') {
    const message =
      'refused: the ashlr kill switch is engaged (~/.ashlr/KILL). Installing a launch agent ' +
      'grants standing authority to bring the serving runtime up at every login, unattended — ' +
      'which is what that switch withholds. Clear it yourself with `ashlr enroll kill off` ' +
      'when you want 24/7 operation; this command will never touch the sentinel.\n' +
      `Meanwhile \`ashlr local-runtime start\` runs it for this session.\n` +
      `Would have written: ${plistPath}`;
    if (flags.json) {
      console.log(JSON.stringify({ ok: false, action: 'refused', detail: message, plistPath }, null, 2));
    } else {
      console.error(c.red('refused') + '  ' + message);
    }
    return 1;
  }

  if (runtime.binPath === null) {
    const message =
      'llama-server is not on PATH. Install llama.cpp (`brew install llama.cpp`) or set ' +
      'LLAMA_SERVER_BIN to its absolute path.';
    if (flags.json) console.log(JSON.stringify({ ok: false, action: 'refused', detail: message }, null, 2));
    else console.error(c.red('refused') + '  ' + message);
    return 1;
  }

  // A permanently-installed, LAN-exposed, UNAUTHENTICATED inference server is
  // not something an environment variable should be able to arrange. The
  // resolver already downgrades a non-loopback host unless the persisted
  // opt-in is present; reaching here with one means the opt-in IS present, and
  // this verb still refuses, because `install` is the one that makes it
  // permanent and unattended. `start` remains available for an attended run.
  if (!isLoopbackHost(runtime.host)) {
    const message =
      `refused: this would install a launch agent binding llama-server to ${runtime.host}, ` +
      'which is not loopback. llama-server has no authentication of any kind — anyone who ' +
      'can reach the port can run inference and read every slot\'s prompt via /slots — and ' +
      'a launch agent brings it back at every login, unattended. Bind it to 127.0.0.1, or run ' +
      '`ashlr local-runtime start` for an attended session you can see and stop.';
    if (flags.json) console.log(JSON.stringify({ ok: false, action: 'refused', detail: message }, null, 2));
    else console.error(c.red('refused') + '  ' + message);
    return 1;
  }

  // Resolve the GGUF now so a broken reference is refused at install time
  // rather than becoming a job that fails every ten seconds forever. The
  // resolved path is the shim's FAST PATH, not a frozen dependency: Ollama's
  // store is content-addressed, so the shim re-resolves `modelRef` at launch
  // whenever the blob it was given has been garbage collected by a re-pull.
  // An explicit --model-path is the operator's own choice and is never
  // second-guessed, so it disables re-resolution.
  const explicitModelPath = runtime.modelPath !== null;
  let modelPath = runtime.modelPath;
  if (modelPath === null) {
    const resolved = resolveOllamaModelBlob(runtime.modelRef);
    if (!resolved.ok) {
      if (flags.json) console.log(JSON.stringify({ ok: false, action: 'refused', detail: resolved.reason }, null, 2));
      else console.error(c.red('refused') + '  ' + resolved.reason);
      return 1;
    }
    modelPath = resolved.blobPath;
  }

  const logs = launchAgentLogPaths();
  const mutation = installLaunchAgent({
    binPath: runtime.binPath,
    args: buildLlamaServerArgs(runtime, modelPath),
    stdoutLog: logs.stdout,
    stderrLog: logs.stderr,
    workingDirectory: process.env['HOME'] ?? '/',
    modelRef: explicitModelPath ? null : runtime.modelRef,
    resolverCommand: explicitModelPath ? null : selfResolverCommand(),
  });

  // The Anthropic lane gets its OWN job. Without it a launchd-managed runtime
  // serves the OpenAI-compatible lane and nothing else: the shim `exec`s
  // llama-server and never re-enters the hub, so the proxy Claude Code needs
  // has no host at all and `resolveLocalAnthropicBaseUrl` names a dead port.
  // That gap is what a hand-started scratch script was filling.
  const proxyInvocation = anthropicProxyHostInvocation({
    host: runtime.host,
    port: runtime.anthropicPort,
    upstreamPort: runtime.port,
  });
  const proxyLogs = anthropicProxyLogPaths();
  const proxyMutation = installAnthropicProxyAgent({
    command: proxyInvocation.command,
    args: proxyInvocation.args,
    host: runtime.host,
    port: runtime.anthropicPort,
    upstreamPort: runtime.port,
    workingDirectory: process.env['HOME'] ?? '/',
    stdoutLog: proxyLogs.stdout,
    stderrLog: proxyLogs.stderr,
  });

  if (flags.json) {
    console.log(JSON.stringify({ ...mutation, logs, proxy: { ...proxyMutation, logs: proxyLogs } }, null, 2));
    return mutation.ok && proxyMutation.ok ? 0 : 1;
  }

  console.log(`${mutation.ok ? c.green('ok') : c.red('failed')}  ${mutation.detail}`);
  console.log(`${proxyMutation.ok ? c.green('ok') : c.red('failed')}  ${proxyMutation.detail}`);
  console.log('');
  console.log(c.yellow('This wrote files OUTSIDE the repository, in your login configuration:'));
  console.log(`  ${mutation.plistPath}`);
  console.log(`  ${proxyMutation.plistPath}`);
  console.log(c.dim('  Remove them with: ashlr local-runtime uninstall'));
  console.log(c.dim(`  Logs:  ${logs.stdout}`));
  console.log(c.dim(`         ${logs.stderr}`));
  console.log(c.dim(`         ${proxyLogs.stdout}`));
  console.log(c.dim(`         ${proxyLogs.stderr}`));
  console.log(c.dim(`  Anthropic clients: http://${runtime.host}:${runtime.anthropicPort}/v1`));
  return mutation.ok && proxyMutation.ok ? 0 : 1;
}

/**
 * How to invoke THIS hub again from a login-time shell.
 *
 * The launch agent's shim calls it to re-resolve the model blob. `argv[1]` is
 * the script entry point for a normal Node run and is absent for a packaged
 * single-file binary, where `execPath` is the CLI itself — both spellings are
 * absolute, which matters because launchd gives the job a minimal PATH.
 * Returns null when neither can be trusted, which makes the shim fall back to
 * the frozen path instead of running something unexpected.
 */
function selfResolverCommand(): readonly string[] | null {
  const exec = process.execPath;
  if (typeof exec !== 'string' || !isAbsolute(exec)) return null;
  const entry = process.argv[1];
  if (typeof entry === 'string' && isAbsolute(entry)) {
    try {
      if (statSync(entry).isFile()) return [exec, entry, 'local-runtime', 'resolve-model'];
    } catch {
      // Fall through to the bare executable.
    }
  }
  // A packaged binary: `execPath` IS ashlr, so it takes the subcommand itself.
  return entry === undefined ? [exec, 'local-runtime', 'resolve-model'] : null;
}

/**
 * `resolve-model` — print the absolute GGUF blob path for a model reference.
 *
 * Exists for the launch agent's shim (see `buildLaunchAgentShim`), which runs
 * with a minimal environment at login and needs today's content-addressed blob
 * rather than the one that was current at install time. Read-only: it resolves
 * a manifest and prints a path, and prints NOTHING but that path on stdout so
 * the shim can consume it directly.
 */
function cmdResolveModel(flags: ParsedFlags, runtime: LlamaRuntimeConfig): number {
  if (runtime.modelPath !== null) {
    try {
      if (statSync(runtime.modelPath).isFile()) {
        console.log(runtime.modelPath);
        return 0;
      }
    } catch {
      // Reported below as unresolvable.
    }
    console.error(`configured modelPath does not exist: ${runtime.modelPath}`);
    return 1;
  }
  const resolved = resolveOllamaModelBlob(runtime.modelRef);
  if (!resolved.ok) {
    if (flags.json) console.log(JSON.stringify({ ok: false, detail: resolved.reason }, null, 2));
    else console.error(resolved.reason);
    return 1;
  }
  if (flags.json) {
    console.log(JSON.stringify({ ok: true, modelRef: runtime.modelRef, blobPath: resolved.blobPath }, null, 2));
    return 0;
  }
  console.log(resolved.blobPath);
  return 0;
}

/** `uninstall` — boot the job out and delete the plist. */
function cmdUninstall(flags: ParsedFlags): number {
  const mutation = uninstallLaunchAgent();
  // Both jobs go, always. Leaving the proxy behind would keep a KeepAlive
  // listener forwarding to a port whose llama-server was just removed.
  const proxyMutation = uninstallAnthropicProxyAgent();
  if (flags.json) {
    console.log(JSON.stringify({ ...mutation, proxy: proxyMutation }, null, 2));
    return mutation.ok && proxyMutation.ok ? 0 : 1;
  }
  const c = makeColors(isTty());
  console.log(`${mutation.ok ? c.green('ok') : c.red('failed')}  ${mutation.detail}`);
  console.log(c.dim(`  ${mutation.plistPath}`));
  console.log(`${proxyMutation.ok ? c.green('ok') : c.red('failed')}  ${proxyMutation.detail}`);
  console.log(c.dim(`  ${proxyMutation.plistPath}`));
  return mutation.ok && proxyMutation.ok ? 0 : 1;
}

/** `logs` — tail the runtime's stderr. */
function cmdLogs(flags: ParsedFlags): number {
  const { stderr } = launchAgentLogPaths();
  const lines = flags.lines ?? 40;
  try {
    statSync(stderr);
  } catch {
    console.error(`no runtime log yet at ${stderr}`);
    return 1;
  }
  try {
    const text = readFileSync(stderr, 'utf8').split('\n');
    console.log(text.slice(Math.max(0, text.length - lines)).join('\n').trimEnd());
    return 0;
  } catch (err: unknown) {
    console.error(`could not read ${stderr}: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

/**
 * Entry point. Never throws: every expected failure is an exit code plus a
 * sentence explaining what to do next.
 */
export async function cmdLocalRuntime(args: string[]): Promise<number> {
  const [subcommand, ...rest] = args;

  if (!subcommand || subcommand === 'help' || subcommand === '--help' || subcommand === '-h') {
    console.log(USAGE);
    return subcommand ? 0 : 2;
  }

  const flags = parseFlags(rest);
  if (flags.error) {
    console.error(`${flags.error}\n\n${USAGE}`);
    return 2;
  }

  const cfg = loadConfigReadOnly();
  const overrides = runtimeOverrides(flags);
  const runtime: LlamaRuntimeConfig = { ...resolveLlamaRuntimeConfig(cfg), ...overrides };
  const options: LifecycleOptions = {
    cfg,
    runtime: overrides,
    force: flags.force,
    ...(flags.waitMs !== undefined ? { timeoutMs: flags.waitMs } : {}),
  };

  try {
    switch (subcommand) {
      case 'status': return await cmdStatus(flags, options);
      case 'start': return await runLifecycle('start', flags, options);
      case 'stop': return await runLifecycle('stop', flags, options);
      case 'restart': return await runLifecycle('restart', flags, options);
      case 'reshape': return await cmdReshape(flags, options, flags.positionals);
      case 'install': return await cmdInstall(flags, runtime);
      case 'uninstall': return cmdUninstall(flags);
      case 'logs': return cmdLogs(flags);
      case 'resolve-model': return cmdResolveModel(flags, runtime);
      default:
        console.error(`unknown subcommand "${subcommand}"\n\n${USAGE}`);
        return 2;
    }
  } catch (err: unknown) {
    // A throw here is a bug, not an expected state — report it as one rather
    // than letting a stack trace be the user interface.
    console.error(`local-runtime failed unexpectedly: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

/** True when the launch agent is present — exported for the doctor surface. */
export function localRuntimeLaunchAgentInstalled(): boolean {
  return launchAgentInstalled();
}
