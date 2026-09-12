import type { PreparationTypecheckProject } from '../src/core/universe/preparation-typecheck-project.js';
/** Trusted source authoring only; does not write or install a snapshot. */
export function authorPreparationTypecheckProject(options: {
  repository: string;
  expectedSourceSha256: string;
  /** Production calibration inventory; installed node_modules remains separately trusted and pinned. */
  expectedFiles?: ReadonlyArray<{ path: string; executable: boolean; bytes: number; sha256: string }>;
}): Promise<PreparationTypecheckProject>;
