import { parsePreparationEvidenceOptions, preparationEvidenceFailure } from './universe-preparation-evidence.js';
import { readPreparationEvidenceFile } from './universe-preparation-measurement.js';

const COMMAND = 'preparation-measurement-compare';
const USAGE = `usage: ashlr universe preparation-measurement-compare <candidateUniverseId>
  --root <canonical absolute directory> --capture <id>
  --calibration <canonical absolute calibration.json> [--json]

Compare a retained settled candidate capture to a caller-supplied calibration.
Verify matching workload identity and frozen artifact scope; only preparation
source content may differ. Every measured region must avoid regression.
Diagnostic only: the descriptor is not installed acceptance authority. No scoring,
selection, execution, provider calls, delivery or automatic retries occur.
Exit codes: 0 improved/unchanged diagnostic, 1 regressed/unavailable, 2 invalid arguments.
`;

export async function cmdUniversePreparationMeasurementCompare(args: string[]): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) { console.log(USAGE); return 0; }
  let selected;
  try { selected = parsePreparationEvidenceOptions(args, 'compare'); }
  catch { return preparationEvidenceFailure(args.includes('--json'), COMMAND, 'INVALID_ARGUMENTS'); }
  try {
    const { MAX_PREPARATION_CALIBRATION_BYTES } = await import('../core/universe/preparation-measurement-calibration.js');
    const { compareCapturedPreparationMeasurement } = await import('../core/universe/preparation-measurement-candidate-comparison.js');
    const result = compareCapturedPreparationMeasurement({ root: selected.root, universeId: selected.universeId,
      captureId: selected.captures[0]!, calibration: readPreparationEvidenceFile(selected.calibration!, MAX_PREPARATION_CALIBRATION_BYTES) });
    console.log(selected.json ? JSON.stringify(result) : [
      'Preparation comparison · diagnostic only; not acceptance or delivery authority.',
      'Calibration: caller-supplied diagnostic input, not an installed trusted baseline.',
      `Result: ${result.result} · reason: ${result.reason ?? 'none'}`,
      ...(result.evidence ? [
        `Recorded candidate: ${result.evidence.universeId}/${result.evidence.captureId}`,
        `Artifact scope: ${result.evidence.fileCount} files checked; preparation source ${result.evidence.targetChanged ? 'changed' : 'unchanged'}`,
      ] : []),
      ...(result.comparison ? [
        `Broker processes: ${result.comparison.processTotal.baseline} → ${result.comparison.processTotal.candidate} (delta ${result.comparison.processTotal.delta})`,
        `Regressed regions: ${result.comparison.regressions.length}; positive deltas mean more processes`,
        ...result.comparison.regions.map(region => `  ${region.key}: ${region.baselineProcesses} → ${region.candidateProcesses}; blob subset delta ${region.blobProcessDelta}`),
      ] : ['Comparable measurement unavailable; no improvement inferred.']),
    ].join('\n'));
    return result.result === 'improved' || result.result === 'unchanged' ? 0 : 1;
  } catch { return preparationEvidenceFailure(selected.json, COMMAND, 'EVIDENCE_UNAVAILABLE'); }
}
