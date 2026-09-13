/** Browser-safe observations. No configuration paths, prompts, tokens or authority. */
export interface EngineeringMissionSnapshot {
  schemaVersion: 1; missionId: string; configDigest: string; controllerId: string;
  revision: number; enabled: boolean; autoStart: boolean;
  state: 'idle' | 'running' | 'stopping' | 'completed' | 'stopped' | 'held' | 'closed';
  phase: string | null; scope: number; maxScopes: number; deadlineAt: string;
  sampledAt: string; remainingMs: number;
  lastOutcome: { state: 'completed' | 'stopped' | 'held'; reason: string; scopesReserved: number } | null;
}
export interface EngineeringMissionCommand {
  expectedControllerId: string; expectedConfigDigest: string; expectedRevision: number;
}
