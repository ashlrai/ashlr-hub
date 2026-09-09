import { isAbsolute, parse as parsePath, resolve } from 'node:path';
import {
  deliverUniverseIntegration, evaluateUniverseIntegration, handoffUniverseIntegration,
  readUniverseIntegrationDelivery, readUniverseIntegrationEvaluation,
  readUniverseIntegrationPlan, validateUniverseIntegrationDefinition, validateUniverseIntegrationDeliveryRequest,
  validateUniverseIntegrationEvaluationRequest, validateUniverseIntegrationHandoffRequest, type UniverseIntegrationDeliveryReceipt,
  type UniverseIntegrationDeliveryRequest, type UniverseIntegrationEvaluationResult, type UniverseIntegrationEvaluationRequest,
  type UniverseIntegrationPlan,
} from '../core/universe/index.js';

const MAX_MANIFEST_BYTES = 256 * 1024;
const USAGE = `usage: ashlr universe integration <command> --manifest <private absolute JSON>
       [--root <absolute private directory>] [--json]

  plan      Read a bounded combined-artifact composition plan without writing Git
  evaluate  Explicitly execute the target's pinned evaluator against the combined artifact
  inspect   Read a prior durable evaluation result without executing an evaluator
  deliver   Deliver a settled passing evaluation to a new local codex/ branch
  inspect-delivery  Read and verify completed local delivery evidence without writes
  handoff   Register a new downstream experiment from an explicitly pinned delivery

The manifest names one pinned seed repository/base and 2-8 delivered source
trees. Planning verifies source receipt pins and deterministic path overlays only.
Evaluate is a separate owner-invoked local action: it runs only the target
Universe's digest-pinned fixed evaluator and records a frozen private artifact
and evaluator result. Inspect reads that exact prior result and never executes
an evaluator. Deliver accepts only an exact, settled passing result digest and
writes a private delivery intent/receipt plus local Git objects/ref as needed;
it never reruns an evaluator or provider and never checks out, pushes, merges,
deploys, or establishes acceptance. If delivery is interrupted, inspect the
receipt and Git ref; interruption does not prove that a branch was not
published. A settled identical request replays verified evidence; unfinished
work is unresolved and is never retried automatically. Inspect-delivery reads
completed evidence only; it never creates a branch or settles pending work.
Handoff registers a new experiment with its own objective, evaluator, and budget;
it does not run that experiment or inherit the source score. Neither action
advances an existing branch or mutates an existing experiment. The manifest must be
an owner-only (0600) regular JSON file with a canonical absolute path, at most
256 KiB. --root defaults to ~/.ashlr/universe.
Exit codes: plan 0 composition-ready, 1 unavailable/conflicting sources;
            evaluate 0 passed, 1 rejected/failed/timed-out/unavailable,
            130 cancelled; inspect 0 readable, 1 unavailable, 2 invalid;
            deliver 0 delivered/unchanged, 1 pending/unavailable, 130 cancelled, 2 invalid;
            inspect-delivery 0 readable, 1 unavailable, 2 invalid;
            handoff 0 registered, 1 unavailable, 2 invalid.
All commands return 2 for invalid arguments or manifests.
`;

class UsageError extends Error {}
class CancellationError extends Error {}

interface Options {
  command: 'plan' | 'evaluate' | 'inspect' | 'deliver' | 'inspect-delivery' | 'handoff' | 'help';
  manifest?: string;
  root?: string;
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

function isActionCommand(value: string | undefined): value is Exclude<Options['command'], 'help'> {
  return value === 'plan' || value === 'evaluate' || value === 'inspect' || value === 'deliver' ||
    value === 'inspect-delivery' || value === 'handoff';
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
    } else if (arg === '--manifest' || arg === '--root') {
      if (values.has(arg)) throw new UsageError(`${arg} may only be specified once`);
      const value = args[++index];
      if (!value?.trim() || value.startsWith('-') || containsControls(value) || value.length > 4_096) {
        throw new UsageError(`${arg} requires a bounded path`);
      }
      if (arg === '--manifest' && !canonicalAbsolutePath(value)) {
        throw new UsageError('--manifest requires a private canonical absolute JSON path');
      }
      if (arg === '--root' && !canonicalAbsolutePath(value)) {
        throw new UsageError('--root requires a canonical absolute private directory');
      }
      values.set(arg, value);
    } else if (arg.startsWith('--manifest=') || arg.startsWith('--root=')) {
      throw new UsageError(`${arg.slice(0, arg.indexOf('='))} requires a separate path argument`);
    } else if (arg.startsWith('-')) throw new UsageError(`Unknown option: ${arg}`);
    else positional.push(arg);
  }
  if (positional.length > 1) throw new UsageError('integration accepts one command and no positional manifest');
  const command = positional[0];
  if (command !== undefined && !isActionCommand(command) && command !== 'help') {
    throw new UsageError('Expected integration plan, evaluate, inspect, deliver, inspect-delivery, handoff, or help');
  }
  if (help || command === 'help') return { command: 'help', json: false };
  if (!isActionCommand(command)) {
    throw new UsageError('Expected integration plan, evaluate, inspect, deliver, inspect-delivery, or handoff');
  }
  const manifest = values.get('--manifest');
  if (!manifest) throw new UsageError(`${command} requires --manifest <private absolute JSON>`);
  return { command, manifest, root: values.get('--root'), json };
}

function render(plan: UniverseIntegrationPlan): string {
  const target = plan.definition.target;
  return [
    `${plan.definition.id} · integration plan · source ${plan.sourceState}`,
    `Scope: ${plan.scope} · authority: ${plan.authority}`,
    `Target: ${target.repo} · base ${target.baseCommit} · allowed paths: ${target.allowedPaths.length}`,
    `Sources: ${plan.sources.length}`,
    ...plan.sources.map((source) => `  ${source.universeId} · ${source.state} · delivery ${source.deliveryId} · changed paths ${source.changedPathCount}`),
    `Composition: ${plan.compositionReady ? 'ready' : 'blocked'} · digest ${plan.compositionDigest ?? 'unavailable'}`,
    `Entries: ${plan.entries.length} deterministic overlay entries`,
    ...plan.entries.map((entry) => `  ${entry.path} · ${entry.oid ?? 'deleted'} · source deliveries ${entry.sourceDeliveryIds.join(', ') || 'none'}`),
    `Conflicts: ${plan.conflicts.length}`,
    ...plan.conflicts.map((conflict) => `  Conflict: ${conflict.code} · ${conflict.paths.join(', ') || 'path unavailable'}`),
    ...plan.reasons,
    'Read-only structural composition plan. No Git tree, ref, artifact, delivery, evaluator, provider, or deployment action was performed.',
    'Composition digest is a recipe identity only; readiness is not execution authorization, artifact acceptance, or production success.',
  ].join('\n');
}

function renderEvaluation(result: UniverseIntegrationEvaluationResult): string {
  return [
    `${result.id} · integration evaluation · ${result.status}`,
    `Request: ${result.requestDigest}`,
    `Pinned comparator: universe ${result.acceptance.universeId} · manifest ${result.acceptance.manifestDigest} · comparator ${result.acceptance.comparatorDigest}`,
    `Composition: ${result.compositionDigest ?? 'unavailable'}`,
    `Artifact: ${result.artifactPath ?? 'unavailable'} · digest ${result.artifactDigest ?? 'unavailable'}`,
    `Score: ${result.score ?? 'unavailable'}`,
    `Metrics: ${Object.keys(result.metrics).length ? JSON.stringify(result.metrics) : 'none'}`,
    `Elapsed: ${result.durationMs} ms · started ${result.startedAt} · finished ${result.finishedAt ?? 'unavailable'}`,
    ...(result.reason ? [`Reason: ${result.reason}`] : []),
    'Local fixed-evaluator execution only. The frozen artifact and result are private evidence, not acceptance or production authorization.',
    'No model generation, provider, scheduler, branch, Git ref/publication, delivery, or automatic retry occurred.',
  ].join('\n');
}

function renderInspection(inspection: Awaited<ReturnType<typeof readUniverseIntegrationEvaluation>>): string {
  const { request, result } = inspection;
  return [
    `${request.id} · integration evaluation inspection · ${result.status}`,
    `Result digest: ${inspection.resultDigest}`,
    `Request digest: ${result.requestDigest} · composition: ${result.compositionDigest}`,
    `Pinned comparator: universe ${result.acceptance.universeId} · manifest ${result.acceptance.manifestDigest} · comparator ${result.acceptance.comparatorDigest}`,
    `Artifact: ${result.artifactPath ?? 'unavailable'} · digest ${result.artifactDigest ?? 'unavailable'}`,
    `Score: ${result.score ?? 'unavailable'} · metrics: ${Object.keys(result.metrics).length ? JSON.stringify(result.metrics) : 'none'}`,
    `Elapsed: ${result.durationMs} ms · started ${result.startedAt} · finished ${result.finishedAt}`,
    ...(result.reason ? [`Reason: ${result.reason}`] : []),
    'Read-only prior fixed-evaluator evidence. No evaluator, model, provider, scheduler, branch, Git ref, or delivery action occurred.',
    'The result digest is evidence identity, not acceptance or production authorization.',
  ].join('\n');
}

function renderDelivery(receipt: UniverseIntegrationDeliveryReceipt): string {
  return [
    `${receipt.evaluationId} · integration delivery · ${receipt.status}`,
    `Branch: ${receipt.branch} · commit ${receipt.commit} · tree ${receipt.tree}`,
    `Repository: ${receipt.repo} · pinned base ${receipt.baseCommit}`,
    `Evaluation request: ${receipt.evaluationRequestDigest} · result: ${receipt.evaluationResultDigest}`,
    `Composition: ${receipt.compositionDigest} · artifact: ${receipt.artifactDigest}`,
    `Changed files: ${receipt.changedFiles.length}`,
    receipt.status === 'delivered' ? 'Local branch delivered. Checkout, index, and HEAD were not changed.' :
      receipt.status === 'unchanged' ? 'Combined artifact matches the pinned base; no branch was created.' :
        'Delivery intent recorded; branch publication is not confirmed.',
    'No evaluator or provider rerun occurred. No merge, push, deploy, or production acceptance occurred.',
    'If interrupted, inspect the durable receipt and Git ref; interruption does not prove that a branch was not published.',
  ].join('\n');
}

function evaluationExitCode(result: UniverseIntegrationEvaluationResult): number {
  return result.status === 'passed' ? 0 : result.status === 'cancelled' ? 130 : 1;
}

function renderDeliveryInspection(evidence: ReturnType<typeof readUniverseIntegrationDelivery>): string {
  const { receipt } = evidence;
  return [
    `${receipt.evaluationId} · integration delivery inspection · ${receipt.status}`,
    `Receipt digest: ${evidence.receiptDigest} · delivery ${receipt.id}`,
    `Repository: ${receipt.repo} · branch ${receipt.branch} · commit ${receipt.commit} · tree ${receipt.tree}`,
    `Pinned comparator: universe ${receipt.universeId} · manifest ${receipt.manifestDigest} · comparator ${receipt.comparatorDigest}`,
    `Artifact: ${receipt.artifactDigest} · composition ${receipt.compositionDigest}`,
    'Read-only completed delivery evidence. No branch creation, pending-work reconciliation, evaluator, provider, or experiment registration occurred.',
    'This receipt identifies a local delivery, not downstream execution or production acceptance.',
  ].join('\n');
}

function renderHandoff(result: Awaited<ReturnType<typeof handoffUniverseIntegration>>): string {
  return [
    `${result.targetUniverseId} · integration handoff · ${result.status}`,
    `New manifest: ${result.manifestDigest} · comparator: ${result.comparatorDigest}`,
    `Seed artifact: ${result.seedArtifactDigest}`,
    `Origin: universe ${result.origin.acceptanceUniverseId} · evaluation ${result.origin.evaluationId} · delivery ${result.origin.deliveryId}`,
    `Repository: ${result.origin.repo} · commit ${result.origin.commit} · tree ${result.origin.tree}`,
    `Delivery digest: ${result.origin.deliveryDigest} · handoff request: ${result.origin.requestDigest}`,
    'New downstream experiment registered with its own objective, evaluator, and budget. No source score was inherited.',
    'No experiment, evaluator, provider, or campaign was run. No existing experiment, branch, checkout, push, or deployment was changed.',
  ].join('\n');
}

/** Planning is read-only; evaluation is an explicit, bounded foreground action. */
export async function cmdUniverseIntegration(args: string[]): Promise<number> {
  try {
    const options = parse(args);
    if (options.command === 'help') { console.log(USAGE); return 0; }
    let input: unknown;
    try {
      const { readResourceJson } = await import('../core/resources/pool-runtime.js');
      input = readResourceJson(options.manifest!, MAX_MANIFEST_BYTES);
    } catch {
      throw new UsageError('Integration manifest is invalid or unavailable');
    }
    if (options.command === 'plan') {
      let definition;
      try { definition = validateUniverseIntegrationDefinition(input); }
      catch { throw new UsageError('Integration manifest is invalid or unavailable'); }
      let plan: UniverseIntegrationPlan;
      try {
        plan = readUniverseIntegrationPlan(definition, { root: options.root });
      } catch { throw new Error('Integration plan unavailable'); }
      console.log(options.json ? JSON.stringify(plan, null, 2) : render(plan));
      return plan.sourceState === 'healthy' && plan.compositionReady && plan.conflicts.length === 0 ? 0 : 1;
    }
    if (options.command === 'inspect') {
      let inspection: Awaited<ReturnType<typeof readUniverseIntegrationEvaluation>>;
      let request: UniverseIntegrationEvaluationRequest;
      try { request = validateUniverseIntegrationEvaluationRequest(input); }
      catch { throw new UsageError('Integration evaluation request is invalid or unavailable'); }
      try { inspection = readUniverseIntegrationEvaluation(request, { root: options.root }); }
      catch { throw new Error('Integration evaluation evidence unavailable'); }
      console.log(options.json ? JSON.stringify(inspection, null, 2) : renderInspection(inspection));
      return 0;
    }
    if (options.command === 'inspect-delivery') {
      let request: UniverseIntegrationDeliveryRequest;
      try { request = validateUniverseIntegrationDeliveryRequest(input); }
      catch { throw new UsageError('Integration delivery request is invalid or unavailable'); }
      let evidence: ReturnType<typeof readUniverseIntegrationDelivery>;
      try { evidence = readUniverseIntegrationDelivery(request, { root: options.root }); }
      catch { throw new Error('Integration delivery evidence unavailable'); }
      console.log(options.json ? JSON.stringify(evidence, null, 2) : renderDeliveryInspection(evidence));
      return 0;
    }
    if (options.command === 'handoff') {
      let request: ReturnType<typeof validateUniverseIntegrationHandoffRequest>;
      try { request = validateUniverseIntegrationHandoffRequest(input); }
      catch { throw new UsageError('Integration handoff request is invalid or unavailable'); }
      let result: Awaited<ReturnType<typeof handoffUniverseIntegration>>;
      try { result = await handoffUniverseIntegration(request, { root: options.root }); }
      catch { throw new Error('Integration handoff unavailable'); }
      console.log(options.json ? JSON.stringify(result, null, 2) : renderHandoff(result));
      return 0;
    }
    if (options.command === 'deliver') {
      let request: UniverseIntegrationDeliveryRequest;
      try { request = validateUniverseIntegrationDeliveryRequest(input); }
      catch { throw new UsageError('Integration delivery request is invalid or unavailable'); }
      const controller = new AbortController();
      const abort = (): void => controller.abort();
      process.once('SIGINT', abort);
      process.once('SIGTERM', abort);
      try {
        let receipt: UniverseIntegrationDeliveryReceipt;
        try {
          receipt = await deliverUniverseIntegration(request, { root: options.root, signal: controller.signal });
        } catch {
          throw controller.signal.aborted ? new CancellationError('Integration delivery cancelled; inspect the receipt and Git ref') :
            new Error('Integration delivery unavailable');
        }
        console.log(options.json ? JSON.stringify(receipt, null, 2) : renderDelivery(receipt));
        return receipt.status === 'pending' ? 1 : 0;
      } finally {
        process.removeListener('SIGINT', abort);
        process.removeListener('SIGTERM', abort);
      }
    }
    let request: UniverseIntegrationEvaluationRequest;
    try { request = validateUniverseIntegrationEvaluationRequest(input); }
    catch { throw new UsageError('Integration evaluation request is invalid or unavailable'); }
    const controller = new AbortController();
    const abort = (): void => controller.abort();
    process.once('SIGINT', abort);
    process.once('SIGTERM', abort);
    try {
      let result: UniverseIntegrationEvaluationResult;
      try {
        result = await evaluateUniverseIntegration(request, { root: options.root, signal: controller.signal });
      } catch {
        throw controller.signal.aborted ? new CancellationError('Integration evaluation cancelled') :
          new Error('Integration evaluation unavailable');
      }
      console.log(options.json ? JSON.stringify(result, null, 2) : renderEvaluation(result));
      return evaluationExitCode(result);
    } finally {
      process.removeListener('SIGINT', abort);
      process.removeListener('SIGTERM', abort);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (args.includes('--json')) console.log(JSON.stringify({ error: message }));
    else console.error(`universe integration: ${message}`);
    return error instanceof UsageError ? 2 : error instanceof CancellationError ? 130 : 1;
  }
}
