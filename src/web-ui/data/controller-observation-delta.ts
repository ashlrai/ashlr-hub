import type { UniversePortfolioControllerView } from '../../core/web/universe-console-types.js';

type View = UniversePortfolioControllerView;
export interface ControllerObservationChange {
  key: string;
  label: string;
  before: string;
  after: string;
  campaignId?: string;
}
export interface ControllerObservationDelta {
  kind: 'baseline' | 'incomparable' | 'compared';
  notice: string | null;
  clockWarning: boolean;
  changes: ControllerObservationChange[];
  changedCampaigns: number;
}

const recorded = (value: string | number | null | undefined): string => value == null ? 'Not recorded' : String(value);
const members = (values: readonly string[]): string => [...new Set(values)].sort().join(', ') || 'None recorded';
const stateLabel: Record<View['outcomes'][number]['state'], string> = {
  pending: 'Pending', held: 'Held', completed: 'Completed', 'in-flight': 'Unresolved intent',
};

/** Compares accepted read evidence, never inferring intervening events, execution or liveness. */
export function compareControllerObservations(previous: View | null, current: View): ControllerObservationDelta {
  const empty = { clockWarning: false, changes: [], changedCampaigns: 0 };
  if (!previous) return { ...empty, kind: 'baseline', notice: 'First accepted observation. Refresh this controller explicitly to compare recorded evidence.' };
  if (previous.controllerId !== current.controllerId || previous.createdAt !== current.createdAt) {
    return { ...empty, kind: 'incomparable', notice: 'Controller identity or registration timestamp changed. Registration continuity is not established; these observations are not compared.' };
  }

  const changes: ControllerObservationChange[] = [];
  const change = (key: string, label: string, before: string, after: string, campaignId?: string) => {
    if (before !== after) changes.push({ key, label, before, after, ...(campaignId ? { campaignId } : {}) });
  };
  const notices: string[] = [];
  if (previous.sourceState !== 'healthy' || current.sourceState !== 'healthy') {
    notices.push('One or both observations contain missing or degraded evidence. Absence from an observation does not establish deletion, completion or execution.');
  }
  if (current.createdAt === null) notices.push('The registration timestamp is not recorded. Registration continuity is not established.');
  if (previous.deadlineAt !== current.deadlineAt) notices.push('The recorded deadline changed. This difference does not establish registration continuity or renew execution authority.');
  change('controller:status', 'Recorded controller status', previous.status, current.status);
  change('controller:health', 'Evidence health', previous.sourceState, current.sourceState);
  change('controller:deadline', 'Recorded deadline', recorded(previous.deadlineAt), recorded(current.deadlineAt));
  change('controller:reasons', 'Evidence reasons', members(previous.reasons), members(current.reasons));
  for (const [field, label] of [
    ['mode', 'Admission mode'], ['sequence', 'Admission sequence'],
    ['requestedAt', 'Admission requested at'], ['acknowledgedAt', 'Admission acknowledged at'],
  ] as const) change(`control:${field}`, label, recorded(previous.control?.[field]), recorded(current.control?.[field]));

  const previousOutcomes = new Map(previous.outcomes.map((outcome) => [outcome.campaignId, outcome]));
  const currentOutcomes = new Map(current.outcomes.map((outcome) => [outcome.campaignId, outcome]));
  // Current declared order first, followed by IDs no longer observed; never pair rows by index.
  const campaignIds = [...currentOutcomes.keys(), ...[...previousOutcomes.keys()].filter((id) => !currentOutcomes.has(id))];
  for (const id of campaignIds) {
    const before = previousOutcomes.get(id); const after = currentOutcomes.get(id);
    if (!before || !after) {
      change(`campaign:${id}:presence`, 'Campaign presence', before ? 'Present' : 'Not observed', after ? 'Present' : 'Not observed', id);
      continue;
    }
    change(`campaign:${id}:state`, 'Recorded state', stateLabel[before.state], stateLabel[after.state], id);
    change(`campaign:${id}:reason`, 'Recorded reason', before.reasonCode, after.reasonCode, id);
    change(`campaign:${id}:attempted`, 'Campaign-call intent', before.attempted ? 'Recorded' : 'Not recorded', after.attempted ? 'Recorded' : 'Not recorded', id);
  }
  change('controller:campaign-order', 'Recorded campaign order', previous.outcomes.map((row) => row.campaignId).join(', ') || 'None recorded', current.outcomes.map((row) => row.campaignId).join(', ') || 'None recorded');
  change('controller:topology', 'Dependency evidence', previous.topology ? 'Available' : 'Unavailable', current.topology ? 'Available' : 'Unavailable');
  if (previous.topology && current.topology) {
    const previousTopology = new Map(previous.topology.map((node) => [node.campaignId, node]));
    for (const node of current.topology) {
      const before = previousTopology.get(node.campaignId);
      // Membership already records presence; a missing row is not an empty dependency list.
      if (!before) continue;
      change(`campaign:${node.campaignId}:dependencies`, 'Direct dependencies', members(before.dependsOn), members(node.dependsOn), node.campaignId);
      change(`campaign:${node.campaignId}:prerequisites`, 'Effective prerequisites', members(before.prerequisites), members(node.prerequisites), node.campaignId);
    }
  }
  return { kind: 'compared', notice: notices.join(' ') || null,
    clockWarning: Date.parse(current.observedAt) <= Date.parse(previous.observedAt), changes,
    changedCampaigns: new Set(changes.flatMap((row) => row.campaignId ? [row.campaignId] : [])).size };
}
