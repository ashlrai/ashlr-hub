import { canonical, digest, readArtifactSnapshot } from './artifacts.js';
import { ownCaptureData, preparationCaptureDirectory, projectPreparationCapture, readPreparationCaptureRecords,
  validatePreparationMeasurementCaptureRequest } from './preparation-measurement-capture-store.js';
import { parsePreparationMeasurementCalibration, preparationCalibrationWorkload } from './preparation-measurement-calibration.js';
import { comparePreparationScenarioVectors, extractPreparationScenarioVector,
  type PreparationMeasurementComparison } from './preparation-measurement-comparison.js';
import { parsePreparationMeasurementReport } from './preparation-measurement-report.js';

const TARGET = 'src/core/resources/engineering-preparation.ts';

export interface CapturedPreparationMeasurementComparisonRequest {
  root: string; universeId: string; captureId: string; calibration: string;
}
export interface CapturedPreparationMeasurementComparison {
  schemaVersion: 1;
  scope: 'diagnostic-only';
  calibrationAuthority: 'caller-supplied-diagnostic-input';
  result: 'improved' | 'unchanged' | 'regressed' | 'not-comparable';
  reason: 'invalid-calibration' | 'capture-unavailable' | 'capture-ineligible' | 'workload-mismatch' |
    'artifact-changed' | 'scope-mismatch' | 'evidence-changed' | null;
  identityVerificationScope: 'recorded-attempt-and-current-seed' | null;
  evidence: null | {
    universeId: string; captureId: string; calibrationDigest: string; reportDigest: string;
    baselineArtifactDigest: string; candidateArtifactDigest: string;
    baselineEvaluatorDigest: string; candidateEvaluatorDigest: string;
    implementationComparison: 'normalized-files-and-native-identities';
    fileCount: number; targetChanged: boolean; targetOnlyDifference: true;
    baselineSourceDigest: string; candidateSourceDigest: string;
  };
  comparison: PreparationMeasurementComparison | null;
}

/** Compare historical custody plus a current seed inventory. An unsigned calibration
 * is caller-supplied diagnostic input, never installed acceptance authority. */
export function compareCapturedPreparationMeasurement(input: CapturedPreparationMeasurementComparisonRequest): CapturedPreparationMeasurementComparison {
  let options: Record<string, unknown>;
  let request: ReturnType<typeof validatePreparationMeasurementCaptureRequest>;
  try {
    options = ownCaptureData(input, ['root', 'universeId', 'captureId', 'calibration']);
    request = validatePreparationMeasurementCaptureRequest({ root: options.root, universeId: options.universeId, captureId: options.captureId });
    if (typeof options.calibration !== 'string') throw new Error();
  } catch { throw new Error('Invalid captured preparation comparison request'); }
  const refused = (reason: NonNullable<CapturedPreparationMeasurementComparison['reason']>): CapturedPreparationMeasurementComparison => ({
    schemaVersion: 1, scope: 'diagnostic-only', calibrationAuthority: 'caller-supplied-diagnostic-input',
    result: 'not-comparable', reason, identityVerificationScope: null, evidence: null, comparison: null,
  });
  let reason: NonNullable<CapturedPreparationMeasurementComparison['reason']> = 'invalid-calibration';
  try {
    const calibration = parsePreparationMeasurementCalibration(options.calibration as string);
    reason = 'capture-unavailable';
    const directory = preparationCaptureDirectory(request);
    const records = readPreparationCaptureRecords(directory);
    const capture = projectPreparationCapture(records, request.captureId), { intent, receipt } = capture;
    if (!intent || !receipt || capture.state !== 'recorded' || receipt.outcome !== 'captured' || receipt.reason !== null ||
        !receipt.identityVerified || receipt.processGroupSettlement !== 'group-exit-confirmed' || !receipt.report?.checksPassed) return refused('capture-ineligible');
    reason = 'workload-mismatch';
    const candidateVector = extractPreparationScenarioVector(receipt.report.stdout);
    const evaluator = intent.evaluator;
    const candidateWorkload = preparationCalibrationWorkload(evaluator, parsePreparationMeasurementReport(receipt.report.stdout).workload);
    // The registry aggregate omits bundle installation paths, but binds the
    // manifest, code files and native executable identities. Preserve that pin.
    if (canonical(candidateWorkload) !== canonical(calibration.workload)) return refused('workload-mismatch');
    reason = 'artifact-changed';
    const snapshot = readArtifactSnapshot(intent.artifact.path);
    if (snapshot.digest !== intent.artifact.digest) return refused('artifact-changed');
    const files = snapshot.entries.map(entry => ({ path: entry.path, executable: entry.executable,
      bytes: entry.data.length, sha256: digest(entry.data) })).sort((a, b) => a.path.localeCompare(b.path));
    const target = files.find(file => file.path === TARGET);
    if (!target || files.length !== calibration.baseline.files.length || files.some((file, index) => {
      const baseline = calibration.baseline.files[index]!;
      return file.path !== baseline.path || file.executable !== baseline.executable ||
        file.path !== TARGET && canonical(file) !== canonical(baseline);
    })) return refused('scope-mismatch');
    const comparison = comparePreparationScenarioVectors(calibration.scenarios, candidateVector);
    reason = 'evidence-changed';
    // Read-only final joins: no cached old receipt or seed authorizes this result.
    if (canonical(readPreparationCaptureRecords(directory)) !== canonical(records) ||
        readArtifactSnapshot(intent.artifact.path).digest !== snapshot.digest) return refused('evidence-changed');
    return {
      schemaVersion: 1, scope: 'diagnostic-only', calibrationAuthority: 'caller-supplied-diagnostic-input',
      result: comparison.result, reason: null, identityVerificationScope: 'recorded-attempt-and-current-seed',
      evidence: { universeId: request.universeId, captureId: request.captureId, calibrationDigest: digest(canonical(calibration)),
        reportDigest: receipt.report.sha256, baselineArtifactDigest: calibration.baseline.artifactDigest, candidateArtifactDigest: snapshot.digest,
        baselineEvaluatorDigest: calibration.workload.digest, candidateEvaluatorDigest: evaluator.digest,
        implementationComparison: 'normalized-files-and-native-identities', fileCount: files.length,
        targetChanged: target.sha256 !== calibration.baseline.source.sha256, targetOnlyDifference: true,
        baselineSourceDigest: calibration.baseline.source.sha256, candidateSourceDigest: target.sha256 }, comparison,
    };
  } catch { return refused(reason); }
}
