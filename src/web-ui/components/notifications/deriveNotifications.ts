/**
 * components/notifications/deriveNotifications.ts — pure, framework-free
 * transform from the backend snapshots the app already fetches into the
 * attention queue the notification centre shows. No React, no fetch, no
 * timers here — trivially unit-testable, matching the split cache.ts /
 * auth-store.ts already use for framework-free stores.
 *
 * Every rule below is grounded in a field the fleet already computes,
 * per the build brief: `fleet.nextActions` / `fleet.autonomousShipReadiness`
 * are the exact data the legacy dashboard's "Needs you" deck reads
 * (buildOperatorBriefingModel, public/app.js:7438-7494); `control.security`
 * and `control.limits` are existing Mission Control sections; run failures
 * and the pending-proposal backlog come from resources every other view
 * already fetches (`runsQuery`, `inboxQuery`). Nothing here invents new
 * backend computation — it only re-prioritizes what already exists into one
 * queue instead of requiring the operator to notice it across five tabs.
 */
import type { ControlSnapshot, FleetStatus, RunState } from '../../data/api-types.js';
import type { InboxProposal } from '../../data/queries.js';
import type { AppNotification, NotificationSeverity } from './types.js';

export interface DeriveInputs {
  control?: ControlSnapshot;
  fleet?: FleetStatus;
  runs?: RunState[];
  inbox?: { pending: number; proposals: InboxProposal[] };
}

/** A running run with no observed update for this long is worth flagging
 * even if nobody has the live stream open watching it — this is what makes
 * "what happened overnight" catch a wedged 3am run instead of requiring the
 * operator to have been staring at a stream panel when it stalled. */
const RUN_STALL_NOTIFY_MS = 3 * 60 * 1000;
/** A pending proposal sitting this long escalates from medium to high. */
const PROPOSAL_BACKLOG_ESCALATE_MS = 2 * 60 * 60 * 1000;
/** A failed/aborted run older than this is history, not something that
 * still "needs you" right now — see the run-failure rule below. */
const RUN_FAILURE_NOTIFY_WINDOW_MS = 24 * 60 * 60 * 1000;

function fleetActionHref(id: string): string {
  const lower = id.toLowerCase();
  if (lower.includes('proposal') || lower.includes('inbox')) return '/inbox';
  if (lower.includes('security') || lower.includes('audit')) return '/control/security';
  if (lower.includes('evidence') || lower.includes('fleet') || lower.includes('queue')) return '/control/fleet';
  return '/control/daemon';
}

export function deriveNotifications(input: DeriveInputs): AppNotification[] {
  const out: AppNotification[] = [];
  const now = Date.now();

  // ── 1. fleet.nextActions — the fleet's own priority-ranked to-do list. ──
  for (const action of input.fleet?.nextActions ?? []) {
    out.push({
      id: `next-action-${action.id}`,
      category: 'action-required',
      severity: action.priority,
      title: action.label,
      detail: action.detail,
      ts: new Date(now).toISOString(),
      actionHref: fleetActionHref(action.id),
      actionLabel: 'Inspect',
    });
  }

  // ── 2. Autonomous ship readiness — blocked/unknown verdicts. ──
  const readiness = input.fleet?.autonomousShipReadiness;
  if (readiness) {
    if (readiness.verdict === 'blocked' && readiness.topBlocker) {
      out.push({
        id: `readiness-blocked-${readiness.topBlocker.id}`,
        category: 'readiness',
        severity: readiness.topBlocker.severity,
        title: 'Autonomous readiness is blocked',
        detail: readiness.topBlocker.detail,
        ts: readiness.freshness.generatedAt,
        actionHref: '/control/fleet',
        actionLabel: 'Inspect fleet',
      });
    } else if (readiness.verdict === 'unknown') {
      out.push({
        id: 'readiness-unknown',
        category: 'readiness',
        severity: 'medium',
        title: 'Autonomous readiness is unknown',
        detail: 'Fresh, authoritative state is required before autonomous operation can be treated as clear.',
        ts: readiness.freshness.generatedAt,
        actionHref: '/control/fleet',
        actionLabel: 'Inspect fleet',
      });
    }
  }

  // ── 3. Security findings. ──
  const security = input.control?.security;
  if (security?.available) {
    if (security.counts.critical > 0) {
      const top = security.findings.find((f) => f.severity === 'critical');
      out.push({
        id: 'security-critical',
        category: 'security',
        severity: 'critical',
        title: `${security.counts.critical} critical security finding${security.counts.critical === 1 ? '' : 's'}`,
        detail: top ? `${top.repo}: ${top.title}` : 'See the security backlog for details.',
        ts: new Date(now).toISOString(),
        actionHref: '/control/security',
        actionLabel: 'Review findings',
      });
    } else if (security.counts.high > 0) {
      const top = security.findings.find((f) => f.severity === 'high');
      out.push({
        id: 'security-high',
        category: 'security',
        severity: 'high',
        title: `${security.counts.high} high-severity security finding${security.counts.high === 1 ? '' : 's'}`,
        detail: top ? `${top.repo}: ${top.title}` : 'See the security backlog for details.',
        ts: new Date(now).toISOString(),
        actionHref: '/control/security',
        actionLabel: 'Review findings',
      });
    }
  }

  // ── 4. Budget / rate limits. ──
  for (const limit of input.control?.limits ?? []) {
    if (limit.standing === 'over') {
      out.push({
        id: `budget-over-${limit.backend}-${limit.window}`,
        category: 'budget',
        severity: 'high',
        title: `${limit.backend} is over its ${limit.window} limit`,
        detail: `${limit.used.toLocaleString()} / ${limit.max.toLocaleString()} used.`,
        ts: new Date(now).toISOString(),
        actionHref: '/control/daemon',
        actionLabel: 'Review usage',
      });
    } else if (limit.standing === 'warn') {
      out.push({
        id: `budget-warn-${limit.backend}-${limit.window}`,
        category: 'budget',
        severity: 'medium',
        title: `${limit.backend} is approaching its ${limit.window} limit`,
        detail: `${limit.used.toLocaleString()} / ${limit.max.toLocaleString()} used.`,
        ts: new Date(now).toISOString(),
        actionHref: '/control/daemon',
        actionLabel: 'Review usage',
      });
    }
  }

  // ── 5. Daemon health — the source itself being degraded is actionable. ──
  const daemon = input.control?.daemon;
  if (daemon && (daemon.sourceQuality.sourceState !== 'healthy' || daemon.sourceQuality.complete === false)) {
    const reason = daemon.sourceQuality.reason;
    out.push({
      id: 'daemon-health-degraded',
      category: 'daemon-health',
      severity: reason === 'missing' || reason === 'unavailable' ? 'high' : 'medium',
      title: 'Daemon state cannot be confirmed',
      detail: reason ? `Source: ${reason}.` : 'The daemon state source is degraded or incomplete.',
      ts: new Date(now).toISOString(),
      actionHref: '/control/daemon',
      actionLabel: 'Inspect daemon',
      sourceQuality: daemon.sourceQuality,
    });
  }

  // ── 6. Pending-proposal backlog. ──
  if (input.inbox && input.inbox.pending > 0) {
    const oldest = input.inbox.proposals.reduce<number | null>((min, p) => {
      const t = new Date(p.createdAt).getTime();
      return min === null || t < min ? t : min;
    }, null);
    const ageMs = oldest !== null ? now - oldest : 0;
    const severity: NotificationSeverity = ageMs > PROPOSAL_BACKLOG_ESCALATE_MS ? 'high' : 'medium';
    out.push({
      id: 'proposal-backlog',
      category: 'proposal',
      severity,
      title: `${input.inbox.pending} proposal${input.inbox.pending === 1 ? '' : 's'} awaiting review`,
      detail:
        ageMs > PROPOSAL_BACKLOG_ESCALATE_MS
          ? `Oldest has been waiting ${Math.round(ageMs / (60 * 60 * 1000))}h.`
          : 'Approve, reject, or leave for autonomous handling per policy.',
      ts: oldest !== null ? new Date(oldest).toISOString() : new Date(now).toISOString(),
      actionHref: '/inbox',
      actionLabel: 'Open inbox',
    });
  }

  // ── 7. Run failures (recent window only) and silent stalls. ──
  // `runs` is a plain last-200 list with no recency filter server-side — on
  // a real fleet that easily spans weeks (verified live against an
  // operator's actual `ashlr serve`: /api/runs returned runs from three
  // weeks earlier). Without a window, every historical failure would sit in
  // the attention queue forever, which is exactly the "nag" the
  // non-negotiables rule out. Old failures are still fully visible in the
  // Work Journal (its whole point is unbounded-by-recency history) — the
  // notification centre only surfaces ones recent enough to plausibly still
  // need a human's attention.
  for (const run of input.runs ?? []) {
    if (run.status === 'failed' || run.status === 'aborted') {
      if (now - new Date(run.updatedAt).getTime() > RUN_FAILURE_NOTIFY_WINDOW_MS) continue;
      out.push({
        id: `run-failed-${run.id}`,
        category: 'run',
        severity: run.status === 'failed' ? 'high' : 'medium',
        title: `Run ${run.status}: ${run.goal}`,
        detail: run.result ?? run.terminationReason ?? `Run ${run.id} ${run.status}.`,
        ts: run.updatedAt,
        actionHref: `/work/runs/${run.id}`,
        actionLabel: 'Open run',
      });
      continue;
    }
    if (run.status === 'running') {
      const age = now - new Date(run.updatedAt).getTime();
      if (age > RUN_STALL_NOTIFY_MS) {
        out.push({
          id: `run-stalled-${run.id}`,
          category: 'run',
          severity: 'medium',
          title: `No update from a running run in ${Math.round(age / 60_000)}m`,
          detail: run.goal,
          ts: run.updatedAt,
          actionHref: `/work/runs/${run.id}`,
          actionLabel: 'Watch live',
        });
      }
    }
  }

  return out;
}

/** Sort worst-first, then most-recent-first within a severity band —
 * matches SEVERITY_ORDER so the list reads top-to-bottom as "most urgent
 * first" the same way everywhere it's rendered. */
export function sortNotifications(items: AppNotification[]): AppNotification[] {
  const rank: Record<NotificationSeverity, number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
  return [...items].sort((a, b) => {
    const s = rank[a.severity] - rank[b.severity];
    if (s !== 0) return s;
    return new Date(b.ts).getTime() - new Date(a.ts).getTime();
  });
}
