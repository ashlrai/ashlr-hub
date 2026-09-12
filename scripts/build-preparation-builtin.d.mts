/** Authoring-only declaration; no candidate or runtime build entrypoint. */
export const PREPARATION_BUILTIN_ID: 'preparation-measurement-v1';
export const PREPARATION_BUILTIN_FILES: readonly string[];
export function buildPreparationVerificationBridge(repository: string, outfile: string): Promise<void>;
export function buildPreparationBuiltin(): Promise<{
  schemaVersion: number;
  id: 'preparation-measurement-v1';
  files: Array<{ name: string; digest: string }>;
}>;
