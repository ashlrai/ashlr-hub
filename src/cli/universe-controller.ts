import { isAbsolute, parse as parsePath, resolve } from 'node:path';
import { readControllerRecoveryDiagnostic } from '../core/universe/controller-recovery-error.js';
import {
  readUniversePortfolioController, runUniversePortfolioController, requestUniversePortfolioControllerControl, validateUniversePortfolioDefinition,
  type UniverseCampaignDeliveryPlan,
} from '../core/universe/index.js';

const USAGE = `usage: ashlr universe controller run --manifest <private absolute JSON>
       [--root <absolute private directory>] [--resource-runtime <private absolute JSON>]
       [--delivery-plan <private absolute JSON>] [--json]
       ashlr universe controller status <id> [--root <absolute private directory>] [--json]
       ashlr universe controller drain <id> --root <absolute private directory> [--json]
       ashlr universe controller resume <id> --drain-sequence <number>
       --root <absolute private directory> [--json]

  run     Execute or reconcile the explicitly enrolled campaign graph
  status  Read the persisted controller evidence without starting work
  drain   Stop new admission; already admitted work and planned delivery may finish
  resume  Reopen an acknowledged drain; does not start a process or reset budgets
  help    Show this help

The manifest is an owner-only (0600) regular JSON file at most 256 KiB with the
existing portfolio schema: schemaVersion, id, tasks, maxParallel, maxDurationMs.
All paths must be canonical absolute paths. --root defaults to ~/.ashlr/universe.
The first run pins the definition and optional delivery plan. Repeat the exact
manifest and delivery intent on restart; existing experiments are not rewritten.
The original persisted deadline includes downtime and is not renewed by restart.
Never-dispatched campaigns wait for a busy Universe execution lock within that
same deadline. No dispatch intent or worker request is recorded while waiting.
After control-lock contention, admission rechecks campaign and prerequisite
evidence before recording intent; waiting never preserves a stale dispatch check.
Changed evidence, owner pauses and uncertain ownership do not authorize a retry.
Already settled work is reconciled; uncertain or paused work is not automatically
retried. An in-flight record is evidence of an attempt, not proof of a live worker.
Lost controller receipts can be recovered only from an exact dispatch-attributed
completed campaign and any required existing delivery. No worker or branch is
recreated by recovery. Legacy or mismatched intents remain unresolved.
Run may reclaim a proven-dead controller record-writer lock when no record is
staged. It never discards staged records or repairs unknown lock ownership.
Status does not clear locks; leftover writer locks can make evidence unavailable.
Known recovery failures include a bounded reasonCode and nextStep in JSON output.
These diagnostics do not authorize deletion, publication repair, or worker retry.
The optional delivery plan is private JSON at most 64 KiB. Planned local branch
handoffs gate downstream work; no push, merge, deployment or acceptance is implied.
Repeat --resource-runtime for every intended resource-pool invocation; its private
locator is not stored in the controller. Account reserves and policy still apply.
SIGINT/SIGTERM requests cancellation and waits for started work to settle.
Campaign pause/stop targets only that campaign, not the entire controller.
Wait for acknowledged campaign status; a successful request is not worker exit.
Held prerequisites block dependants; independent ready work may continue.
Pausing queued work changes its pinned evidence and can make this controller
unavailable. Use controller drain to preserve the pending queue instead.
Drain is durable and ordered against dispatch intent, not worker start. An intent
recorded before drain remains admitted and may start afterward. A drain receipt
is not an acknowledgement: inspect status until control.acknowledgedAt is set.
Unsettled intents remain unresolved, never acknowledged merely because no worker
is visible. Resume requires the exact acknowledged control.sequence and starts
no work. Then run the original manifest and intended runtime/delivery options.
Drain/resume require an explicit root and never initialize a missing controller.
Old binaries cannot read new control records; do not downgrade a controlled ledger.
This is an explicitly awaited foreground controller, not a resident daemon or
discovery of new campaigns. Status never starts work or reconciles writes.
Exit codes: run 0 completed, 1 incomplete/unavailable/timed-out, 130 cancelled;
            status 0 healthy evidence (even incomplete), 1 missing/degraded;
            drain/resume 0 control recorded/replayed (not completion), 1 refused;
            all commands 2 invalid arguments or private manifests.
`;

class UsageError extends Error {}
class CancellationError extends Error {}

interface Options {
  command: 'run' | 'status' | 'drain' | 'resume' | 'help';
  id?: string;
  manifest?: string;
  root?: string;
  resourceRuntime?: string;
  deliveryPlanPath?: string;
  drainSequence?: number;
  json: boolean;
}

function containsControls(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code < 32 || (code >= 127 && code <= 159);
  });
}

function canonicalAbsolutePath(value: string): boolean {
  return isAbsolute(value) && resolve(value) === value && parsePath(value).root !== value &&
    Buffer.byteLength(value, 'utf8') <= 4_096 && !containsControls(value);
}

function parse(args: string[]): Options {
  const positional: string[] = [];
  const values = new Map<string, string>();
  let json = false;
  let help = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (containsControls(arg)) throw new UsageError('Arguments must not contain control characters');
    if (arg === '--help' || arg === '-h') {
      if (help) throw new UsageError('--help may only be specified once');
      help = true;
    } else if (arg === '--json') {
      if (json) throw new UsageError('--json may only be specified once');
      json = true;
    } else if (['--root', '--manifest', '--resource-runtime', '--delivery-plan'].includes(arg)) {
      if (values.has(arg)) throw new UsageError(`${arg} may only be specified once`);
      const value = args[++index];
      if (!value || !canonicalAbsolutePath(value)) {
        throw new UsageError(`${arg} requires a bounded private canonical absolute path`);
      }
      values.set(arg, value);
    } else if (arg === '--drain-sequence') {
      if (values.has(arg)) throw new UsageError('--drain-sequence may only be specified once');
      const value = args[++index];
      if (!value || !/^[1-9][0-9]{0,2}$/.test(value) || Number(value) > 511) {
        throw new UsageError('--drain-sequence requires a recorded positive sequence below 512');
      }
      values.set(arg, value);
    } else if (arg.startsWith('-')) throw new UsageError('Unknown controller option');
    else positional.push(arg);
  }
  const command = positional[0];
  if (command !== undefined && !['run', 'status', 'drain', 'resume', 'help'].includes(command)) {
    throw new UsageError('Expected controller run, status, drain, resume, or help');
  }
  if (command === 'status' && [...values.keys()].some((key) => key !== '--root')) {
    throw new UsageError('controller status only accepts --root and --json');
  }
  const named = command === 'status' || command === 'drain' || command === 'resume';
  if (values.has('--drain-sequence') && command !== 'resume') throw new UsageError('--drain-sequence is only valid for controller resume');
  if ((command === 'drain' || command === 'resume') && [...values.keys()].some((key) => key !== '--root' && key !== '--drain-sequence')) {
    throw new UsageError('Controller controls do not accept manifests, delivery plans, or resource runtimes');
  }
  if (positional.length > (named ? 2 : 1)) throw new UsageError('Unexpected controller positional argument');
  if (help || command === 'help') return { command: 'help', json: false };
  if (named) {
    const id = positional[1];
    if (!id || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(id)) throw new UsageError('Controller command requires a bounded controller id');
    if (command !== 'status' && !values.has('--root')) throw new UsageError('Controller controls require --root <absolute private directory>');
    if (command === 'resume' && !values.has('--drain-sequence')) throw new UsageError('controller resume requires --drain-sequence from acknowledged status');
    return { command, id, root: values.get('--root'), json,
      ...(command === 'resume' ? { drainSequence: Number(values.get('--drain-sequence')) } : {}) };
  }
  if (command !== 'run') throw new UsageError('Expected controller run or status');
  const manifest = values.get('--manifest');
  if (!manifest) throw new UsageError('controller run requires --manifest <private absolute JSON>');
  return { command, manifest, root: values.get('--root'), resourceRuntime: values.get('--resource-runtime'),
    deliveryPlanPath: values.get('--delivery-plan'), json };
}

function render(report: ReturnType<typeof readUniversePortfolioController>): string {
  return [
    `${report.controllerId} · portfolio controller · ${report.status} · source ${report.sourceState}`,
    `Definition: ${report.definitionDigest ?? 'unavailable'}`,
    `Created: ${report.createdAt ?? 'unavailable'} · original deadline: ${report.deadlineAt ?? 'unavailable'}`,
    `Observed: ${report.observedAt}`,
    ...(report.control ? [`Admission: ${report.control.mode} · control sequence: ${report.control.sequence}`,
      `Control requested: ${report.control.requestedAt} · drained acknowledgement: ${report.control.acknowledgedAt ?? 'not recorded'}`] : []),
    ...report.outcomes.map((outcome) => `  ${outcome.campaignId} · ${outcome.state} · ${outcome.attempted ? 'attempted' : 'not attempted'} · ${outcome.reasonCode}` +
      `\n    Campaign digest: ${outcome.campaignDigest ?? 'unavailable'} · delivery digest: ${outcome.deliveryDigest ?? 'none'}`),
    ...report.reasons,
    'The original deadline includes downtime; restarting does not renew resource allowance.',
    'In-flight evidence is not proof of a live worker. Uncertain or paused work is not automatically retried.',
    'Only explicitly enrolled campaigns are coordinated. No resident daemon or new-campaign discovery is installed.',
    'Local completion and delivery are not production acceptance, remote push, merge, or deployment.',
  ].join('\n');
}

/** Await the owned foreground run, including cancellation settlement, before removing signal handlers. */
export async function cmdUniverseController(args: string[]): Promise<number> {
  try {
    const options = parse(args);
    if (options.command === 'help') { console.log(USAGE); return 0; }
    if (options.command === 'drain' || options.command === 'resume') {
      let receipt;
      try {
        receipt = requestUniversePortfolioControllerControl(options.id!, options.command, { root: options.root,
          ...(options.drainSequence === undefined ? {} : { expectedDrainSequence: options.drainSequence }) });
      } catch {
        throw new Error('Controller control refused; inspect its recorded state, acknowledgement and ownership before retrying');
      }
      console.log(options.json ? JSON.stringify(receipt, null, 2) : [
        `${receipt.controllerId} · ${receipt.action} ${receipt.changed ? 'recorded' : 'already recorded'} · sequence ${receipt.sequence}`,
        options.command === 'drain' ? 'Request recorded, not proof of completed draining. Inspect controller status for acknowledgement.' :
          'Admission reopened; no worker was started. Run the original manifest and intended runtime configuration to continue.',
        'The original deadline and held attempts are unchanged.',
      ].join('\n'));
      return 0;
    }
    if (options.command === 'status') {
      let report: ReturnType<typeof readUniversePortfolioController>;
      try { report = readUniversePortfolioController(options.id!, { root: options.root }); }
      catch { throw new Error('Portfolio controller evidence unavailable'); }
      console.log(options.json ? JSON.stringify(report, null, 2) : render(report));
      return report.sourceState === 'healthy' ? 0 : 1;
    }
    const { readResourceJson } = await import('../core/resources/pool-runtime.js');
    let definition;
    try { definition = validateUniversePortfolioDefinition(readResourceJson(options.manifest!, 256 * 1024)); }
    catch { throw new UsageError('Invalid or unavailable private portfolio manifest'); }
    let deliveryPlan: UniverseCampaignDeliveryPlan | undefined;
    if (options.deliveryPlanPath !== undefined) {
      const { validateUniverseCampaignDeliveryPlan } = await import('../core/universe/campaign-delivery.js');
      try {
        deliveryPlan = validateUniverseCampaignDeliveryPlan(readResourceJson(options.deliveryPlanPath, 64 * 1024),
          definition.tasks.map((task) => task.campaignId));
      } catch { throw new UsageError('Invalid or unavailable private campaign delivery plan'); }
    }
    const controller = new AbortController();
    const abort = (): void => controller.abort();
    process.once('SIGINT', abort);
    process.once('SIGTERM', abort);
    try {
      let report: Awaited<ReturnType<typeof runUniversePortfolioController>>;
      try {
        report = await runUniversePortfolioController(definition, { root: options.root, signal: controller.signal,
          ...(options.resourceRuntime === undefined ? {} : { resourceRuntime: options.resourceRuntime }),
          ...(deliveryPlan === undefined ? {} : { deliveryPlan }) });
      } catch (error) {
        if (controller.signal.aborted) throw new CancellationError('Portfolio controller cancelled; inspect persisted evidence before retrying');
        // Only this run boundary recognizes internal recovery diagnostics. Read
        // canonical fields from the classifier, never a mutable error message.
        const diagnostic = readControllerRecoveryDiagnostic(error);
        if (diagnostic) {
          if (options.json) console.log(JSON.stringify({ error: diagnostic.message, reasonCode: diagnostic.code, nextStep: diagnostic.nextStep }));
          else console.error(`universe controller: [${diagnostic.code}] ${diagnostic.message}\nNext step: ${diagnostic.nextStep}`);
          return 1;
        }
        throw new Error('Portfolio controller execution unavailable');
      }
      console.log(options.json ? JSON.stringify(report, null, 2) : render(report));
      return report.status === 'completed' ? 0 : report.status === 'cancelled' ? 130 : 1;
    } finally {
      process.removeListener('SIGINT', abort);
      process.removeListener('SIGTERM', abort);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Portfolio controller unavailable';
    if (args.includes('--json')) console.log(JSON.stringify({ error: message }));
    else console.error(`universe controller: ${message}`);
    return error instanceof UsageError ? 2 : error instanceof CancellationError ? 130 : 1;
  }
}
