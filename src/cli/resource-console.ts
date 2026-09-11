import { isAbsolute, parse as parsePath, resolve } from 'node:path';

const USAGE = `usage: ashlr resources pool console --root ABS --pool ABS --bindings ABS --observations ABS [--port N] [--json]
       add --execute --workspace ABS [--max-parallel N] to enable foreground queued tasks
       add --projects ABS to pin additional projects while keeping --workspace as default
       add --engineering ABS to expose explicitly enrolled evaluated engineering actions
       add --engineering-preparation ABS to prepare objectives from trusted work profiles
       add --engineering-supervision ABS to run a digest-confirmed engineering queue automatically
       add --quota-config ABS to refresh explicitly pinned Codex account metadata
       add --connections-config ABS to monitor explicit Codex/Claude/Grok accounts
       add --allocation-controls for usage ceilings, whole-account pauses and General/Spark reservations

The dedicated resource desk runs on 127.0.0.1, with an explicit pool and store.
Read-only by default; startup never discovers accounts, logs in, or installs a service.
--quota-config opts into native metadata reads without generation, including in
read-only mode. It creates a private control root/collector lock, checks reported
account hints, and refreshes selected quotas while this process runs. Native
clients may maintain their own auth/cache state. Unavailable managed workers are
blocked even if unknown quota is otherwise allowed. No account independence is
inferred. Omit both metadata options to keep provider-free observation mode.
Execution is an explicit capability for the configured workspaces. It can consume native
provider allowances and edit the selected workspace when a queued task requests workspace-write.
--projects requires --execute and --workspace. Its private JSON file contains
{schemaVersion:1,projects:[{id,label,workspace}]} with at most 31 additional projects;
the ID default is reserved. Browser requests select IDs, never arbitrary paths.
Projects share the same supervisor, resource ledger, account limits and collector.
Registered catalogs also enable explicit control-token-unlocked project file previews.
Browsing reads local source without invoking a worker; attaching and sending are separate.
Project selection binds task context and working directory, not a filesystem sandbox.
--engineering requires --execute and --projects. Its private JSON file contains
{schemaVersion:1,enrollments:[{id,projectId,graphId,graphRoot,host}]}.
Without --engineering-supervision, startup validates enrollment without running a graph. An explicit control-unlocked
start selects an enrollment ID and digest, never browser-supplied paths or commands.
Engineering shares this pool's ledger and limits; acceptance means fixed checks
and delivery to an enrolled local branch, not merge, push or deployment.
--engineering-preparation requires --execute and --projects. Its private JSON
pins {schemaVersion:1,outputRoot,resourceRuntime,profiles:[{id,label,acceptance,recipe}]}.
Profiles fix the project, seed commit, evaluator, files, workers and budgets.
The workspace supplies only an objective ID, profile ID, name and objective text;
delivery uses a new codex/<objective-id> branch. Check is read-only. By default,
prepare writes the bundle and immutable registration without starting it. Completed registrations
reload on restart. Run the prepared plan separately unless the host enables
autoAdmitPrepared in its bounded supervision policy. That mode admits prepared
objectives automatically without another Run action. Changed profiles or
incomplete evidence remain held; queue admission is not execution success.
--engineering-supervision requires --engineering or --engineering-preparation. Its private JSON pins a queue:
{schemaVersion:1,id,maxDurationMs,pollIntervalMs,maxConcurrent,maxAttemptsPerEnrollment,
enrollments:[{enrollmentId,expectedEnrollmentDigest}]}.
Optional maxEnrollments (1..32) enables append-only admission and an empty initial
queue. Optional autoAdmitPrepared:true also requires preparation profiles and
maxEnrollments. New work consumes the original deadline and retained queue capacity;
completed entries, pauses and attempts are never reset. Omit both fields for a fixed queue.
It can launch or recover those plans without a browser click while this console
runs. Original supervision and graph deadlines survive restart. Uncertain work
is not replayed; unchanged unresolved evidence cannot cause repeated attempts.
Pause new launches through the console; pausing does not cancel active work.
Omit the flag to disable the automatic caller. No OS service is installed.
Queued intents and pause state are durable; previously dispatching work is never
silently replayed after restart. Ordinary output is bounded and session-only;
opt-in transcripts persist locally until deleted. Accepted follow-ups freeze copied
context independently of later deletion of their source transcripts.
--port accepts 0..65535, default 0. --max-parallel accepts 1..16, default 4.
Connections are informational native metadata only, separate from worker admission.
Policy controls persist revision-checked usage ceilings, whole-account pauses and
per-account General/Spark reservations for new tasks. A reservation excludes its
quota scope; it does not grant access to the other scope. Whole-account pauses
still block both General and Spark, and all existing quota and capacity limits apply.
Controls do not enable execution, reset quota, stop in-flight tasks or authorize overage.
Private read and control tokens are printed once, never placed in URLs.
SIGINT/SIGTERM abort and await owned work before closing. No resident fleet activation.
Exit codes: 0 clean shutdown/help, 1 startup/shutdown failure, 2 invalid arguments.
`;
class UsageError extends Error {}
type Options = { help: true } | { help: false; root: string; poolFile: string; bindingsFile: string;
  observationsFile: string; quotaConfigFile?: string; connectionsConfigFile?: string; projectsFile?: string; engineeringFile?: string; engineeringPreparationFile?: string; engineeringSupervisionFile?: string; allocationControls?: boolean;
  port: number; execute: boolean; workspace?: string; maxParallel?: number; json: boolean };

function path(value: string): string {
  if (!isAbsolute(value) || resolve(value) === parsePath(value).root || Buffer.byteLength(value) > 4_096) {
    throw new UsageError('Console paths must be explicit absolute non-root paths');
  }
  return resolve(value);
}
function parse(args: string[]): Options {
  if (args.length > 30 || args.some((arg) => typeof arg !== 'string' || arg.length > 4_096 ||
      [...arg].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) >= 127 && char.charCodeAt(0) <= 159)) ||
    Buffer.byteLength(args.join('\0')) > 32 * 1024) throw new UsageError('Arguments exceed the bounded text contract');
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) return { help: true };
  const values = new Map<string, string>(); let execute = false; let json = false; let allocationControls = false;
  for (let index = 0; index < args.length; index++) {
    const flag = args[index]!;
    if (flag === '--execute') { if (execute) throw new UsageError('Duplicate console option'); execute = true; continue; }
    if (flag === '--json') { if (json) throw new UsageError('Duplicate console option'); json = true; continue; }
    if (flag === '--allocation-controls') { if (allocationControls) throw new UsageError('Duplicate console option'); allocationControls = true; continue; }
    if (!['--root', '--pool', '--bindings', '--observations', '--port', '--workspace', '--max-parallel', '--quota-config', '--connections-config', '--projects', '--engineering', '--engineering-preparation', '--engineering-supervision'].includes(flag) || values.has(flag)) {
      throw new UsageError('Unknown or duplicate console option');
    }
    const value = args[++index];
    if (!value || value.startsWith('-')) throw new UsageError('Console option requires a value'); values.set(flag, value);
  }
  if (['--root', '--pool', '--bindings', '--observations'].some((key) => !values.has(key))) {
    throw new UsageError('Explicit root, pool, bindings and observations paths are required');
  }
  if (execute ? !values.has('--workspace') : values.has('--workspace') || values.has('--max-parallel') || values.has('--projects')) {
    throw new UsageError('Execution requires --execute with --workspace; projects and parallelism are execution-only');
  }
  if ((values.has('--engineering') || values.has('--engineering-preparation')) && (!execute || !values.has('--projects'))) {
    throw new UsageError('Engineering requires --execute and an explicit --projects catalog');
  }
  if (values.has('--engineering-supervision') && !values.has('--engineering') && !values.has('--engineering-preparation')) {
    throw new UsageError('Engineering supervision requires an explicit engineering catalog or preparation profiles');
  }
  const portText = values.get('--port') ?? '0'; const parallelText = values.get('--max-parallel') ?? '4';
  if (!/^(0|[1-9]\d{0,4})$/.test(portText) || Number(portText) > 65_535 ||
    !/^[1-9]\d?$/.test(parallelText) || Number(parallelText) > 16) throw new UsageError('Invalid port or parallel limit');
  return { help: false, root: path(values.get('--root')!), poolFile: path(values.get('--pool')!),
    bindingsFile: path(values.get('--bindings')!), observationsFile: path(values.get('--observations')!),
    ...(values.has('--quota-config') ? { quotaConfigFile: path(values.get('--quota-config')!) } : {}),
    ...(values.has('--connections-config') ? { connectionsConfigFile: path(values.get('--connections-config')!) } : {}),
    ...(values.has('--projects') ? { projectsFile: path(values.get('--projects')!) } : {}),
    ...(values.has('--engineering') ? { engineeringFile: path(values.get('--engineering')!) } : {}),
    ...(values.has('--engineering-preparation') ? { engineeringPreparationFile: path(values.get('--engineering-preparation')!) } : {}),
    ...(values.has('--engineering-supervision') ? { engineeringSupervisionFile: path(values.get('--engineering-supervision')!) } : {}),
    ...(allocationControls ? { allocationControls: true } : {}),
    port: Number(portText), execute, ...(execute ? { workspace: path(values.get('--workspace')!), maxParallel: Number(parallelText) } : {}), json };
}

export async function cmdResourceConsole(args: string[]): Promise<number> {
  let announced = false;
  try {
    const options = parse(args); if (options.help) { console.log(USAGE); return 0; }
    const controller = new AbortController();
    let handle: { close(): Promise<void> } | undefined; let closing: Promise<void> | undefined;
    let stopped!: () => void; const stopRequested = new Promise<void>((resolve) => { stopped = resolve; });
    const stop = () => {
      controller.abort();
      if (!handle || closing) return;
      closing = Promise.resolve().then(() => handle!.close()); void closing.then(stopped, stopped);
    };
    const interrupt = () => stop(); const terminate = () => stop();
    process.on('SIGINT', interrupt); process.on('SIGTERM', terminate);
    try {
      const { startResourceConsoleServer } = await import('../core/web/resource-console-server.js');
      if (controller.signal.aborted) return 0;
      const { help: _help, json, ...serverOptions } = options;
      const server = await startResourceConsoleServer({ ...serverOptions, signal: controller.signal }); handle = server;
      if (controller.signal.aborted) stop();
      else {
        const startup = { ...server.scope, url: server.url, consoleUrl: server.consoleUrl, port: server.port,
          readToken: server.readToken, controlToken: server.controlToken, tokenHeader: 'X-Ashlr-Token' };
        console.log(json ? JSON.stringify(startup) : [
          `Resource desk: ${server.consoleUrl}`, `Pool: ${server.scope.poolId}`, `Store: ${server.scope.root}`,
          `Private read token: ${server.readToken}`,
          ...(server.scope.quotaRefreshEnabled ? ['Native Codex metadata refresh is configured; inspect collector status in the console. Task execution is separate.'] : []),
          ...(server.scope.connectionsEnabled ? ['Native account metadata monitoring is configured; inspect collector status in the console.'] : []),
          ...(server.controlToken ? [`Private control token: ${server.controlToken}`] : []),
          ...(server.scope.allocationWritable ? ['Usage allocation and worker access controls are enabled; in-flight tasks are unaffected.'] : []),
          ...(server.scope.engineeringSupported ? ['Enrolled evaluated engineering actions are available for explicit control-unlocked start.'] : []),
          ...(server.scope.engineeringPreparationSupported ? ['Trusted objective preparation profiles are available; preparation does not start work.'] : []),
          ...(server.scope.engineeringSupervisionSupported ? ['Digest-confirmed engineering supervision is configured and may launch automatically; inspect its live status and original deadline.'] : []),
          ...(!server.scope.readOnly ? [`Execution workspace: ${server.scope.workspace}`,
            'Durable queued tasks may execute while this foreground console is running.'] : ['Task execution is disabled.']),
          'Paste tokens into the console; they are never included in URLs.',
          'Press Ctrl-C to abort owned work and close. No resident service is installed.',
        ].join('\n')); announced = true;
      }
      await stopRequested; await closing; return 0;
    } finally {
      try { if (handle) { stop(); await closing; } }
      finally { process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', terminate); }
    }
  } catch (error) {
    const message = error instanceof UsageError ? error.message : 'Resource console could not start or stop';
    if (args.includes('--json')) {
      if (announced) console.error(JSON.stringify({ error: message })); else console.log(JSON.stringify({ error: message }));
    } else console.error(`resources pool console: ${message}`);
    return error instanceof UsageError ? 2 : 1;
  }
}
