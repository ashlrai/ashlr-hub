import type { PreparationTypecheckProject } from '../src/core/universe/preparation-typecheck-project.js';
/** Trusted source authoring only; does not write or install a snapshot. */
export function authorPreparationTypecheckProject(options: {
  repository: string;
  expectedSourceSha256: string;
}): Promise<PreparationTypecheckProject>;
