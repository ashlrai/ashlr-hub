export interface ReleaseTestFile { project: string; file: string }
export interface ReleaseTestAssignment extends ReleaseTestFile { group: 'ordinary' | 'native' }
export interface ReleaseTestCoverage {
  schemaVersion: 1;
  kind: 'release-test-coverage-inventory';
  scope: 'hypothetical-whole-file-partition';
  testsExecuted: false;
  gateAttestation: false;
  default: ReleaseTestFile[];
  groups: { ordinary: ReleaseTestFile[]; native: ReleaseTestFile[] };
  counts: { default: number; ordinary: number; native: number };
}
export function verifyReleaseTestCoverage(discovered: unknown, nativeCandidates: unknown, assignments: unknown): ReleaseTestCoverage;
export function proposeReleaseTestCoverage(discovered: unknown, nativeCandidates?: unknown): ReleaseTestCoverage;
export function discoverReleaseTestFiles(root: string): Promise<ReleaseTestFile[]>;
