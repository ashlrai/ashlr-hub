import { isAbsolute, parse as parsePath, resolve } from 'node:path';
import type { PreparationMeasurementCapture } from '../core/universe/preparation-measurement-capture-types.js';
import { parsePreparationMeasurementReport, summarizePreparationMeasurementReport } from '../core/universe/preparation-measurement-report.js';
import { validateFixedEvaluatorCustodyDiagnostics } from '../core/universe/fixed-evaluator-diagnostics.js';

const USAGE = `usage: ashlr universe preparation-measurement-capture <universeId>
       --root <canonical absolute directory> --capture <safe id> [--json | --report]

Run one installed preparation diagnostic against the registered frozen seed and
retain its report under the selected Universe. This executes local fixture and
verification processes; it is not the read-only report inspector.
The existing manifest fixes the evaluator and timeout. No model/provider request,
scored trial, selection, delivery, service activation or budget renewal is requested.

Use a stable capture ID. Exact completed replay reads retained evidence without
running again. Unfinished or uncertain work stays held; do not use a new ID to retry.
--report writes only valid retained report bytes, without a summary or added newline.
Default and --json output describe diagnostic capture, never acceptance or a score.
Exit codes: 0 reported checks satisfied, 1 failed/unavailable capture, 2 invalid arguments.
`;

interface Options { universeId: string; root: string; captureId: string; mode: 'human' | 'json' | 'report' }
const safeId = (value: string) => /^[a-z0-9][a-z0-9_-]{0,63}$/.test(value);
function options(args: string[]): Options {
  if (args.length > 8 || args.some(arg => typeof arg !== 'string' || Buffer.byteLength(arg) > 4096 ||
      [...arg].some(character => { const code = character.charCodeAt(0); return code < 32 || code >= 127 && code <= 159; }))) throw new Error();
  const universeId = args[0];
  if (!universeId || !safeId(universeId)) throw new Error();
  let root: string | undefined, captureId: string | undefined, mode: Options['mode'] = 'human';
  for (let index = 1; index < args.length; index++) {
    const flag = args[index];
    if (flag === '--root' && root === undefined) {
      root = args[++index];
      if (!root || !isAbsolute(root) || resolve(root) !== root || parsePath(root).root === root) throw new Error();
    } else if (flag === '--capture' && captureId === undefined) {
      captureId = args[++index]; if (!captureId || !safeId(captureId)) throw new Error();
    } else if ((flag === '--json' || flag === '--report') && mode === 'human') mode = flag === '--json' ? 'json' : 'report';
    else throw new Error();
  }
  if (!root || !captureId) throw new Error();
  return { universeId, root, captureId, mode };
}

function summary(value: PreparationMeasurementCapture) {
  const receipt = value.receipt;
  const measurement = receipt?.report ? summarizePreparationMeasurementReport(parsePreparationMeasurementReport(receipt.report.stdout)) : null;
  return { schemaVersion: 1, kind: 'preparation-measurement-capture-summary', scope: 'diagnostic-only',
    state: value.state, disposition: value.disposition, outcome: receipt?.outcome ?? null, reason: receipt?.reason ?? null,
    universeId: value.intent?.universeId ?? null, captureId: value.intent?.captureId ?? null,
    startedAt: value.intent?.startedAt ?? null, finishedAt: receipt?.finishedAt ?? null,
    deadlineAt: value.intent?.deadlineAt ?? null, manifestDigest: value.intent?.manifestDigest ?? null,
    comparatorDigest: value.intent?.comparatorDigest ?? null, identityVerified: receipt?.identityVerified ?? null,
    identityVerificationScope: 'recorded-attempt-only',
    processGroupSettlement: receipt?.processGroupSettlement ?? null,
    ...(receipt?.custodyDiagnostics === undefined ? {} : {
      custodyDiagnostics: validateFixedEvaluatorCustodyDiagnostics(receipt.custodyDiagnostics) }),
    report: receipt?.report ? { sha256: receipt.report.sha256, bytes: receipt.report.bytes,
      reportedChecksSatisfied: receipt.report.checksPassed, workload: measurement!.workload,
      qualificationStatus: measurement!.qualificationStatus } : null };
}

function failure(json: boolean, report: boolean, code: 'INVALID_ARGUMENTS' | 'CAPTURE_UNAVAILABLE' | 'REPORT_UNAVAILABLE') {
  if (json && !report) console.log(JSON.stringify({ scope: 'diagnostic-only', error: code }));
  else console.error(`universe preparation-measurement-capture: ${code === 'INVALID_ARGUMENTS' ? 'invalid arguments; use --help' : code === 'REPORT_UNAVAILABLE' ? 'no valid retained report available' : 'capture unavailable; inspect retained diagnostic custody before retrying'}`);
}

export async function cmdUniversePreparationMeasurementCapture(args: string[]): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) { console.log(USAGE); return 0; }
  let selected: Options;
  try { selected = options(args); }
  catch { failure(args.includes('--json'), args.includes('--report'), 'INVALID_ARGUMENTS'); return 2; }
  const controller = new AbortController(); const abort = () => controller.abort();
  process.once('SIGINT', abort); process.once('SIGTERM', abort);
  try {
    // Help and invalid options never load the effectful capture implementation.
    const { captureUniversePreparationMeasurement } = await import('../core/universe/preparation-measurement-capture.js');
    const result = await captureUniversePreparationMeasurement({ root: selected.root, universeId: selected.universeId,
      captureId: selected.captureId, signal: controller.signal });
    const report = result.receipt?.report;
    if (selected.mode === 'report') {
      if (!report) { failure(false, true, 'REPORT_UNAVAILABLE'); return 1; }
      await new Promise<void>((done, reject) => { process.stdout.write(report.stdout, error => error ? reject(error) : done()); });
    } else {
      const view = summary(result);
      console.log(selected.mode === 'json' ? JSON.stringify(view) : [
        'Preparation capture · diagnostic only; not a score or acceptance evidence.',
        `Capture: ${selected.captureId} · Universe: ${selected.universeId}`,
        `State: ${view.state} · disposition: ${view.disposition ?? 'unknown'} · outcome: ${view.outcome ?? 'unknown'}`,
        `Recorded attempt: ${view.startedAt ?? 'unknown'} → ${view.finishedAt ?? 'unfinished or unknown'}`,
        `Recorded process settlement: ${view.processGroupSettlement ?? 'unknown'} · recorded attempt identity verified: ${view.identityVerified ?? 'unknown'}`,
        ...(view.custodyDiagnostics ? [`Recorded custody boundary: ${view.custodyDiagnostics.boundary} · exit code: ${view.custodyDiagnostics.exitCode ?? 'unknown'}`] : []),
        'Identity verification describes the recorded attempt, not current runtime health; replay does not freshly reverify it.',
        `Reported checks: ${report ? report.checksPassed ? 'satisfied' : 'not satisfied' : 'unknown'}`,
        `Recorded workload: ${view.report?.workload ?? 'unknown'} · during-call qualification: ${view.report?.qualificationStatus ?? 'unknown'}`,
        `Retained report: ${report ? `${report.bytes} bytes · SHA256 ${report.sha256}` : 'unavailable'}`,
        `Diagnostic reason: ${view.reason ?? 'none reported'}`,
        'Use --report with the same capture ID to emit valid retained bytes. Unresolved custody is not permission to retry.',
      ].join('\n'));
    }
    return result.state === 'recorded' && result.receipt?.outcome === 'captured' && report?.checksPassed === true ? 0 : 1;
  } catch { failure(selected.mode === 'json', selected.mode === 'report', 'CAPTURE_UNAVAILABLE'); return 1; }
  finally { process.removeListener('SIGINT', abort); process.removeListener('SIGTERM', abort); }
}
