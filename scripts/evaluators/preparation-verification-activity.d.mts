export interface BuiltinActivityOwner {
  schemaVersion: 1;
  invocationId: string;
  implementationDigest: string;
  deadlineAt: string;
}
export interface BuiltinActivityLifecycle {
  prepare(): { spawned(pgid: number): void; settled(receipt: 'not-started' | 'group-exit-confirmed'): void };
}
export function initializeBuiltinActivity(root: string, owner: BuiltinActivityOwner): void;
export function createBuiltinActivityTracker(root: string): {
  owner: Readonly<BuiltinActivityOwner>;
  lifecycle(kind: 'candidate' | 'tool'): BuiltinActivityLifecycle;
  complete(): void;
};
export function inspectBuiltinActivity(root: string, expectedOwner: BuiltinActivityOwner): boolean;
