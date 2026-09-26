/**
 * routes/verse/fleet/live-model.ts — FleetLiveSnapshotV1 → chart props
 * (unit C7; SPEC-310B §6 Fleet, SPEC-310C §5). Shared by Command's 12 h
 * swimlane and every Fleet card, so both make the same decisions:
 *
 *   - rows are LANES × SLOTS: runs overlapping in one lane stack into
 *     numbered slot rows ("Grok · 2"), so a bar never hides behind another;
 *   - bar colour is STATUS (running amber, merged green, reverted red …);
 *     the lane's ENGINE is the tick + monogram beside its label;
 *   - queued and parked work draws as an outline (it holds a place; nothing
 *     runs) — the Parked Gantt runs from "parked since" to `nextEligibleAt`,
 *     and an unknown `nextEligibleAt` stays open-ended with "unknown" in words.
 *
 * Framework-free; tested directly.
 */
import type { FleetEngine, FleetGateFunnel, FleetLaneState, FleetLiveRun, FleetLiveSnapshotV1 } from '../../../../core/fleet/fleet-types.js';
import type { SeatDecision } from '../../../../core/routing/types.js';
import type { ChartEngine, ChartTone } from '../../../components/charts/colors.js';
import { CHART_NEUTRAL, seriesColor } from '../../../components/charts/colors.js';
import type { SwimlaneLane } from '../../../components/charts/Swimlane.js';
import type { FunnelStage } from '../../../components/charts/Funnel.js';
import type { BarStackSegment } from '../../../components/charts/BarStack.js';
import { laneReasonText, localTimes } from './why-seat-model.js';

export const LANE_ENGINE: Readonly<Record<FleetEngine, ChartEngine>> = {
  local: 'local',
  'grok-cli': 'grok',
  'claude-cli': 'claude',
  codex: 'codex',
};

export const LANE_LABEL: Readonly<Record<FleetEngine, string>> = {
  local: 'Local',
  'grok-cli': 'Grok',
  'claude-cli': 'Claude',
  codex: 'Codex',
};

/** A lane chip's words: "Local · off", "Grok · 1/2". The why is a separate line (`laneNotes`). */
export function laneChipText(lane: FleetLaneState): { name: string; slots: string } {
  return { name: LANE_LABEL[lane.lane], slots: lane.slots === 0 ? 'off' : `${lane.busy}/${lane.slots}` };
}

export interface LaneNote {
  /** The lanes this reason applies to, in strip order. */
  lanes: FleetEngine[];
  /** True when every lane shares it — then it is said once, without names. */
  all: boolean;
  reason: string;
}

/** A lane's cap reason as the operator reads it (`laneReasonText`); null when it has none. */
export function laneReason(lane: FleetLaneState): string | null {
  const reason = lane.capReason?.trim();
  return reason ? laneReasonText(reason) : null;
}

/**
 * Each distinct lane cap reason ONCE, with the lanes it covers, in the plain
 * words the server already wrote. A dark fleet gives every lane the same sentence; 3.10.0
 * repeated it inside every chip and truncated it there.
 */
export function laneNotes(lanes: readonly FleetLaneState[]): LaneNote[] {
  const byReason = new Map<string, FleetEngine[]>();
  for (const lane of lanes) {
    const reason = laneReason(lane);
    if (!reason) continue;
    const list = byReason.get(reason) ?? [];
    list.push(lane.lane);
    byReason.set(reason, list);
  }
  return [...byReason.entries()].map(([reason, covered]) => ({
    lanes: covered,
    all: covered.length === lanes.length && lanes.length > 1,
    reason,
  }));
}

/** The word a bar is labelled with: the outcome once it ended, else the phase. */
export function runStatus(run: FleetLiveRun): string {
  if (run.phase === 'queued' || run.phase === 'parked') return run.phase;
  if (run.phase === 'reverting') return 'reverting';
  return run.outcome ?? run.phase;
}

const TONES: Readonly<Record<string, ChartTone>> = {
  producing: 'running',
  verifying: 'running',
  judging: 'running',
  landing: 'running',
  watching: 'info',
  reverting: 'danger',
  merged: 'success',
  proposed: 'info',
  'owner-lane': 'warning',
  refused: 'warning',
  failed: 'danger',
  reverted: 'danger',
  cancelled: 'neutral',
  queued: 'neutral',
  parked: 'neutral',
};

export function runTone(status: string): ChartTone {
  return TONES[status] ?? 'unknown';
}

function startOf(run: FleetLiveRun): number | null {
  const t = Date.parse(run.startedAt ?? run.phaseStartedAt ?? '');
  return Number.isFinite(t) ? t : null;
}

function endOf(run: FleetLiveRun): number | null {
  if (!run.endedAt) return null;
  const t = Date.parse(run.endedAt);
  return Number.isFinite(t) ? t : null;
}

function runDetail(run: FleetLiveRun): string {
  const where = run.repo.includes('/') ? run.repo.split('/')[1] : run.repo;
  return [where, run.title, run.model, run.prNumber ? `PR #${run.prNumber}` : null].filter(Boolean).join(' · ');
}

const LANE_ORDER: readonly (FleetEngine | 'none')[] = ['local', 'grok-cli', 'claude-cli', 'codex', 'none'];

/**
 * Runs within [from, now] packed into lane × slot rows. `parkedAsGantt`
 * leaves parked runs out (the Fleet surface draws them in their own Gantt);
 * Command keeps them in, as outlines.
 */
export function laneRows(runs: readonly FleetLiveRun[], from: number, now: number, opts: { includeParked?: boolean } = {}): SwimlaneLane[] {
  const includeParked = opts.includeParked ?? true;
  const byLane = new Map<FleetEngine | 'none', FleetLiveRun[]>();
  for (const run of runs) {
    if (!includeParked && run.phase === 'parked') continue;
    const s = startOf(run);
    if (s === null) continue;
    const e = endOf(run) ?? now;
    if (e < from || s > now) continue;
    const key = run.lane ?? 'none';
    if (!byLane.has(key)) byLane.set(key, []);
    byLane.get(key)!.push(run);
  }
  const lanes: SwimlaneLane[] = [];
  for (const key of LANE_ORDER) {
    const list = byLane.get(key);
    if (!list?.length) continue;
    list.sort((a, b) => startOf(a)! - startOf(b)!);
    const slotEnds: number[] = [];
    const slotItems: FleetLiveRun[][] = [];
    for (const run of list) {
      const s = startOf(run)!;
      const e = endOf(run) ?? now;
      let slot = slotEnds.findIndex((end) => end <= s);
      if (slot === -1) {
        slot = slotEnds.length;
        slotEnds.push(e);
        slotItems.push([]);
      } else {
        slotEnds[slot] = e;
      }
      slotItems[slot]!.push(run);
    }
    const name = key === 'none' ? 'Unassigned' : LANE_LABEL[key];
    slotItems.forEach((items, i) => {
      lanes.push({
        id: `${key}:${i}`,
        label: slotItems.length > 1 ? `${name} · ${i + 1}` : name,
        ...(key === 'none' ? {} : { engine: LANE_ENGINE[key] }),
        items: items.map((run) => ({
          id: run.id,
          start: startOf(run)!,
          end: endOf(run),
          status: runStatus(run),
          detail: runDetail(run),
        })),
      });
    });
  }
  return lanes;
}

export interface GanttRow {
  lanes: SwimlaneLane[];
  from: number;
  to: number;
  /** Rows whose release time is unknown (drawn open-ended). */
  unknownRelease: number;
}

/**
 * The Parked Gantt: one row per parked item, from when it parked to when its
 * seat should free up. The window always shows "now" plus the furthest known
 * release (capped at 48 h — a week-long wait still reads, it just runs off
 * the right edge and the table carries the exact time).
 */
export function parkedGantt(runs: readonly FleetLiveRun[], now: number): GanttRow {
  const parked = runs.filter((r) => r.phase === 'parked' || r.hold !== null);
  const releases = parked.map((r) => (r.hold?.nextEligibleAt ? Date.parse(r.hold.nextEligibleAt) : NaN)).filter(Number.isFinite);
  const starts = parked.map((r) => startOf(r) ?? now);
  const from = Math.min(now - 60 * 60_000, ...starts);
  const to = Math.min(now + 48 * 3_600_000, Math.max(now + 2 * 3_600_000, ...releases));
  let unknownRelease = 0;
  const lanes: SwimlaneLane[] = parked.map((r) => {
    const release = r.hold?.nextEligibleAt ? Date.parse(r.hold.nextEligibleAt) : NaN;
    if (!Number.isFinite(release)) unknownRelease++;
    const where = r.repo.includes('/') ? r.repo.split('/')[1] : r.repo;
    return {
      id: r.id,
      label: `${where}: ${r.title}`,
      ...(r.lane ? { engine: LANE_ENGINE[r.lane] } : {}),
      items: [{
        id: r.id,
        start: startOf(r) ?? now,
        end: Number.isFinite(release) ? release : null,
        status: r.hold?.kind === 'split' ? 'split' : 'parked',
        outline: true,
        detail: `${localTimes(r.hold?.reason ?? 'parked', now)}${Number.isFinite(release) ? '' : ' · release time unknown'}`,
      }],
    };
  });
  return { lanes, from, to, unknownRelease };
}

// ---------------------------------------------------------------------------
// Gate funnel + refusal reasons
// ---------------------------------------------------------------------------

/** Gate names in operator words (the funnel's stage labels). */
export const GATE_LABEL: Readonly<Record<string, string>> = {
  G0: 'Authority',
  G1: 'Protected paths',
  G1b: 'Tamper',
  G2: 'Scope',
  G3: 'Verify',
  G4: 'Claims',
  G5: 'Blast radius',
  G6: 'Judge',
  G7: 'GitHub checks',
};

/** Entered G0, then how many passed each gate — a strictly narrowing pipeline. */
export function funnelStages(funnel: FleetGateFunnel | null): FunnelStage[] {
  if (!funnel || funnel.stages.length === 0) return [];
  return [
    { id: 'entered', label: 'Proposals', value: funnel.stages[0]!.entered },
    ...funnel.stages.map((s) => ({ id: s.gate, label: `${s.gate} ${GATE_LABEL[s.gate] ?? ''}`.trim(), value: s.passed })),
  ];
}

export interface RefusalStack {
  categories: string[];
  segments: BarStackSegment[];
  values: (number | null)[][];
  total: number;
}

/**
 * Refusals per gate, stacked by reason. The top five reasons (by count over
 * the window) keep FIXED identity slots — a reason's colour never changes
 * when another is filtered out — and the rest fold into a neutral "Other".
 */
export function refusalStack(funnel: FleetGateFunnel | null, topN = 5): RefusalStack {
  if (!funnel) return { categories: [], segments: [], values: [], total: 0 };
  const totals = new Map<string, { reason: string; count: number }>();
  for (const s of funnel.stages) for (const r of s.refusals) {
    const prev = totals.get(r.code);
    totals.set(r.code, { reason: prev?.reason ?? r.reason, count: (prev?.count ?? 0) + r.count });
  }
  const ranked = [...totals.entries()].sort((a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0]));
  const top = ranked.slice(0, topN).map(([code]) => code);
  const hasOther = ranked.length > topN;
  const segments: BarStackSegment[] = [
    ...top.map((code, i) => ({ id: code, label: totals.get(code)!.reason, color: seriesColor(i) })),
    ...(hasOther ? [{ id: '__other', label: 'Other reasons', color: CHART_NEUTRAL }] : []),
  ];
  const stages = funnel.stages.filter((s) => s.refusals.length > 0 || s.entered !== s.passed);
  return {
    categories: stages.map((s) => s.gate),
    segments,
    values: stages.map((s) => {
      const row = top.map((code) => s.refusals.find((r) => r.code === code)?.count ?? 0);
      if (hasOther) row.push(s.refusals.filter((r) => !top.includes(r.code)).reduce((n, r) => n + r.count, 0));
      return row;
    }),
    total: ranked.reduce((n, [, v]) => n + v.count, 0),
  };
}

/**
 * No run of any kind and no proposal at the gates: every chart card on Fleet
 * (live swimlane, gate funnel, refusals, parked) would be an empty state.
 */
export function nothingToDraw(fleet: FleetLiveSnapshotV1): boolean {
  return fleet.runs.length === 0 && funnelStages(fleet.funnel).length === 0 && refusalStack(fleet.funnel).total === 0;
}

/** The newest seat decision behind a live dispatch ("why this seat"). */
export function latestDecision(fleet: FleetLiveSnapshotV1 | null): { decision: SeatDecision; run: FleetLiveRun } | null {
  if (!fleet) return null;
  const withDecision = fleet.runs.filter((r) => r.seatDecision !== null);
  if (!withDecision.length) return null;
  withDecision.sort((a, b) => (startOf(b) ?? 0) - (startOf(a) ?? 0));
  const run = withDecision[0]!;
  return { decision: run.seatDecision!, run };
}
