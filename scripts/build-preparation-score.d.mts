import type { PreparationMeasurementCalibrationRequest } from '../src/core/universe/preparation-measurement-calibration.js';
export interface PreparationScoreManifest {
  schemaVersion: 1;
  id: 'preparation-process-score-v1';
  files: Array<{ name: string; digest: string }>;
}
export function buildPreparationScoreBundle(options: {
  repository: string; measurementDirectory: string; calibrationFile: string; output: string;
}): Promise<PreparationScoreManifest>;
export function buildPreparationScoringBuiltin(options: {
  measurementDirectory: string; capture: PreparationMeasurementCalibrationRequest;
}): Promise<PreparationScoreManifest>;
