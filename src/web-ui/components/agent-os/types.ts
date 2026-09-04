export type EvidenceState = 'complete' | 'pending' | 'incomplete' | 'unknown';

export interface LivingEndStateSummary {
  northStar: string;
  currentBottleneck: string;
  revisionLabel: string;
  evidenceState: EvidenceState;
}

export interface CapabilityLaneSummary {
  lane: 'codex' | 'claude' | 'local';
  label: string;
  state: 'ready' | 'tight' | 'unavailable' | 'unknown';
  headroom: 'ample' | 'usable' | 'tight' | 'none' | 'unknown';
  resetUrgency: 'now' | 'soon' | 'later' | 'none' | 'unknown';
  resetLabel: string;
  allocationLabel: string;
}

export interface ActiveValueBetSummary {
  key: string;
  title: string;
  valueCase: string;
  allocationLabel: string;
  decision: 'continue' | 'observing' | 'hold';
  assurance: 'fast-path' | 'targeted' | 'deep';
  outcome: {
    state: 'pending' | 'effective' | 'refuted' | 'unknown';
    label: string;
  };
  evidence: {
    state: EvidenceState;
    label: string;
  };
}

export interface ExceptionFirstAction {
  kind: 'exception' | 'attention' | 'clear';
  title: string;
  reason: string;
  evidenceState: EvidenceState;
}

/**
 * Values-free view contract. It deliberately has no prompt, account,
 * execution-identity, filesystem-path, credential, secret, or effect-control
 * fields. Callers must provide already-redacted display text.
 */
export interface AgentOsCockpitSnapshot {
  sourceState: 'healthy' | 'degraded' | 'unknown';
  livingEndState: LivingEndStateSummary;
  capabilitySpectrum: readonly CapabilityLaneSummary[];
  activeValueBets: readonly ActiveValueBetSummary[];
  nextAction: ExceptionFirstAction | null;
}
