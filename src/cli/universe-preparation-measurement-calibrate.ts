import { parsePreparationEvidenceOptions, preparationEvidenceFailure } from './universe-preparation-evidence.js';

const COMMAND = 'preparation-measurement-calibrate';
const USAGE = `usage: ashlr universe preparation-measurement-calibrate <universeId>
  --root <canonical absolute directory> --capture <id1> --capture <id2> --capture <id3>
  --expected-source-digest <sha256> [--json]

Read three distinct settled diagnostic captures and their current frozen seed.
Require identical workload identity, artifact, and complete measurement vectors.
--json emits the deterministic calibration descriptor; preserve it for comparison.
Diagnostic only: this does not install scoring authority or accept a candidate.
No execution, provider calls, account changes, store writes or automatic retries.
Exit codes: 0 calibration emitted, 1 unavailable evidence, 2 invalid arguments.
`;

export async function cmdUniversePreparationMeasurementCalibrate(args: string[]): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) { console.log(USAGE); return 0; }
  let selected;
  try { selected = parsePreparationEvidenceOptions(args, 'calibrate'); }
  catch { return preparationEvidenceFailure(args.includes('--json'), COMMAND, 'INVALID_ARGUMENTS'); }
  try {
    const { calibratePreparationMeasurements } = await import('../core/universe/preparation-measurement-calibration.js');
    const result = calibratePreparationMeasurements({ root: selected.root, universeId: selected.universeId,
      captureIds: selected.captures as [string, string, string], expectedSourceDigest: selected.sourceDigest! });
    console.log(selected.json ? JSON.stringify(result) : [
      'Preparation calibration · diagnostic only; not installed scoring authority.',
      `Universe: ${selected.universeId} · distinct captures: 3`,
      `Baseline source SHA256: ${selected.sourceDigest}`,
      'Artifact inventory and full measurement vectors verified against retained captures.',
      'Use --json to emit the descriptor for captured-candidate comparison.',
    ].join('\n'));
    return 0;
  } catch { return preparationEvidenceFailure(selected.json, COMMAND, 'EVIDENCE_UNAVAILABLE'); }
}
