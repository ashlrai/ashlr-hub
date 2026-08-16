/**
 * routes/fleet-dashboard/StatGrid.tsx — the glanceable header row: repos,
 * tools, activity, MCP health, genome, inbox. Pure presentation — the
 * parent view decides loading/refreshing/error.
 */
import type { DashboardSnapshot } from '../../data/api-types.js';
import { SkeletonCardGrid } from '../../components/primitives/Skeleton.js';
import styles from './StatGrid.module.css';

export function StatGridSkeleton() {
  return <SkeletonCardGrid count={6} />;
}

function Stat({ label, value, caption }: { label: string; value: string; caption?: string }) {
  return (
    <div className={styles.stat}>
      <span className={styles.statLabel}>{label}</span>
      <span className={styles.statValue}>{value}</span>
      {caption ? <span className={styles.statCaption}>{caption}</span> : null}
    </div>
  );
}

export function StatGrid({ snapshot }: { snapshot: DashboardSnapshot }) {
  const mcpUp = snapshot.mcp.filter((m) => m.ok).length;
  return (
    <div className={styles.grid}>
      <Stat
        label="Repos"
        value={String(snapshot.repos.total)}
        caption={`${snapshot.repos.dirty} dirty · ${snapshot.repos.stale} stale`}
      />
      <Stat label="Tools" value={`${snapshot.tools.installed}/${snapshot.tools.total}`} caption="installed" />
      <Stat
        label="Activity"
        value={String(snapshot.activity.sessions)}
        caption={`${snapshot.activity.tokens.toLocaleString()} tok · $${snapshot.activity.estCostUsd.toFixed(2)}`}
      />
      <Stat label="MCP" value={`${mcpUp}/${snapshot.mcp.length}`} caption="reachable" />
      <Stat
        label="Genome"
        value={String(snapshot.genome.entries)}
        caption={`${snapshot.genome.projects} projects`}
      />
      <Stat label="Inbox" value={String(snapshot.inbox.pending)} caption="pending" />
    </div>
  );
}
