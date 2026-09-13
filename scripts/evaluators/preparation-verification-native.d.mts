export interface PreparationGitPin { path: string; digest: string }
/** Read-only closed-location selection; an unsafe existing location never falls back. */
export function resolvePreparationGit(): PreparationGitPin;
/** Re-resolves and verifies the exact current selection and file content. */
export function assertPreparationGit(pin: unknown): void;
