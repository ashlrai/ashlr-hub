export const MAX_BUILTIN_ACTIVITIES: 8192;
export interface BuiltinActivityOwner {
  /** V2 requires a private invocation key and authenticates settlement-time observations. */
  schemaVersion: 1 | 2;
  invocationId: string;
  implementationDigest: string;
  deadlineAt: string;
}
export interface BuiltinActivityLifecycle {
  prepare(): { spawned(pgid: number): void; settled(receipt: 'not-started' | 'group-exit-confirmed'): void };
}
export function initializeBuiltinActivity(root: string, owner: BuiltinActivityOwner): void;
/** settlementKey is a private 32-byte hex key required only for a V2 owner. */
export function createBuiltinActivityTracker(root: string, settlementKey?: string): {
  owner: Readonly<BuiltinActivityOwner>;
  lifecycle(kind: 'candidate' | 'tool'): BuiltinActivityLifecycle;
  complete(): void;
};
export function inspectBuiltinActivity(root: string, expectedOwner: BuiltinActivityOwner, settlementKey?: string): boolean;
