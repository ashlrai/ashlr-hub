/**
 * routes/work/swarms/SwarmDag.tsx — ported from the hand-rolled SVG DAG at
 * src/core/web/public/app.js:1334-1493 (`buildSwarmDag`). The layout
 * algorithm (phase-column layout, tasks stacked within a column, cubic-
 * bezier dependency edges with an arrowhead marker) is unchanged — it was
 * self-contained and worth keeping rather than reinventing. Two deliberate
 * departures from the original:
 *
 *  1. Color: the legacy version hardcoded its own STATUS_COLOR map
 *     (app.js:40-49), which is exactly the "two files disagree about what a
 *     status color means" bug DESIGN.md's status-color section documents.
 *     This version routes every node through `statusToTone()` instead, so a
 *     DAG node and a <StatusBadge/> for the same status always render the
 *     same color from the one place that owns the mapping.
 *  2. Interactivity: the legacy DAG had none (no click/hover/focus). Each
 *     node here is a real SVG <a> to `#{taskAnchorPrefix}-{taskId}`, making
 *     every node keyboard-reachable (Tab + Enter) and jumping to that task's
 *     row in the plain-text task list rendered alongside the DAG — so the
 *     graph is a navigation aid, not the only way to reach a task's detail.
 */
import type { ReactNode } from 'react';
import { statusToTone } from '../../../components/primitives/StatusBadge.js';
import type { SwarmPlan, SwarmTaskRun } from '../../../data/api-types.js';
import styles from './SwarmDag.module.css';

const PHASE_ORDER: Record<string, number> = { scaffold: 0, build: 1, integrate: 2, verify: 3, review: 4 };

export interface DagTaskNode {
  id: string;
  phase: string;
  goal: string;
  deps: string[];
  status: string;
}

/**
 * Merge plan tasks (spec: goal/deps/phase) with runtime tasks (status) —
 * same precedence as the legacy merge (app.js:1339-1346): spec first, then
 * runtime fields overlay it by id.
 */
export function mergeSwarmTasks(plan: SwarmPlan | undefined, taskRuns: SwarmTaskRun[]): DagTaskNode[] {
  const map = new Map<string, DagTaskNode>();
  for (const s of plan?.tasks ?? []) {
    map.set(s.id, { id: s.id, phase: s.phase, goal: s.goal, deps: s.deps, status: 'pending' });
  }
  for (const r of taskRuns) {
    const existing = map.get(r.id);
    map.set(r.id, {
      id: r.id,
      phase: r.phase || existing?.phase || 'build',
      goal: existing?.goal ?? '',
      deps: existing?.deps ?? [],
      status: r.status,
    });
  }
  return Array.from(map.values());
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

const NODE_W = 140;
const NODE_H = 48;
const H_GAP = 60;
const V_GAP = 20;
const PAD = 20;

interface NodePos {
  x: number;
  y: number;
  cx: number;
  cy: number;
}

export function SwarmDag({
  tasks,
  taskAnchorPrefix = 'dag-task',
}: {
  tasks: DagTaskNode[];
  taskAnchorPrefix?: string;
}): ReactNode {
  if (tasks.length === 0) {
    return <p className={styles.empty}>No tasks in this swarm.</p>;
  }

  const phaseGroups = new Map<string, DagTaskNode[]>();
  for (const t of tasks) {
    const ph = t.phase || 'build';
    const list = phaseGroups.get(ph) ?? [];
    list.push(t);
    phaseGroups.set(ph, list);
  }
  const phases = Array.from(phaseGroups.keys()).sort((a, b) => (PHASE_ORDER[a] ?? 99) - (PHASE_ORDER[b] ?? 99));

  const colX = new Map<string, number>();
  let x = PAD;
  for (const ph of phases) {
    colX.set(ph, x);
    x += NODE_W + H_GAP;
  }
  const totalW = x + PAD;

  const nodePos = new Map<string, NodePos>();
  for (const ph of phases) {
    let y = PAD;
    for (const t of phaseGroups.get(ph)!) {
      const px = colX.get(ph)!;
      nodePos.set(t.id, { x: px, y, cx: px + NODE_W / 2, cy: y + NODE_H / 2 });
      y += NODE_H + V_GAP;
    }
  }
  const totalH = Math.max(...Array.from(nodePos.values()).map((p) => p.y + NODE_H)) + PAD * 2;

  const edges: { key: string; d: string }[] = [];
  for (const t of tasks) {
    const to = nodePos.get(t.id);
    if (!to) continue;
    for (const depId of t.deps) {
      const from = nodePos.get(depId);
      if (!from) continue;
      const x1 = from.x + NODE_W;
      const y1 = from.cy;
      const x2 = to.x;
      const y2 = to.cy;
      const mx = (x1 + x2) / 2;
      edges.push({ key: `${depId}->${t.id}`, d: `M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}` });
    }
  }

  return (
    <svg
      width={totalW}
      height={totalH}
      viewBox={`0 0 ${totalW} ${totalH}`}
      className={styles.svg}
      role="img"
      aria-label="Swarm task dependency graph"
    >
      <defs>
        <marker id="dag-arrow" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto">
          <path d="M0,0 L0,6 L8,3 z" className={styles.arrowHead} />
        </marker>
      </defs>

      {phases.map((ph) => (
        <text key={ph} x={colX.get(ph)! + NODE_W / 2} y={PAD - 6} textAnchor="middle" className={styles.phaseLabel}>
          {ph}
        </text>
      ))}

      {edges.map((e) => (
        <path key={e.key} d={e.d} className={styles.edge} fill="none" markerEnd="url(#dag-arrow)" />
      ))}

      {tasks.map((t) => {
        const pos = nodePos.get(t.id);
        if (!pos) return null;
        const tone = statusToTone(t.status);
        return (
          <g key={t.id} transform={`translate(${pos.x},${pos.y})`}>
            <a href={`#${taskAnchorPrefix}-${encodeURIComponent(t.id)}`} className={styles.nodeLink}>
              <title>{`${t.id} — ${t.goal} (${t.status})`}</title>
              <rect width={NODE_W} height={NODE_H} rx={6} ry={6} className={`${styles.nodeRect} ${styles[tone]}`} />
              <circle cx={10} cy={NODE_H / 2} r={4} className={`${styles.statusDot} ${styles[tone]}`} />
              <text x={20} y={17} className={styles.nodeId}>
                {truncate(t.id, 18)}
              </text>
              <text x={20} y={33} className={styles.nodeGoal}>
                {truncate(t.goal, 20)}
              </text>
            </a>
          </g>
        );
      })}
    </svg>
  );
}
