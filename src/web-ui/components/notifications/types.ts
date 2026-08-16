/**
 * components/notifications/types.ts — the notification centre's own vocab.
 *
 * Severity deliberately reuses `FleetNextAction.priority`'s four-level scale
 * (`critical | high | medium | low`, src/core/fleet/status.ts:455-462) plus
 * one addition, `info`, for passive/no-action items — this is the SAME
 * scale the legacy dashboard's "Needs you" deck already computes
 * (buildOperatorBriefingModel in public/app.js), reused per the build brief
 * rather than inventing a parallel one. `severityToTone` below maps it onto
 * the app-wide `StatusBadge` tone vocabulary so a notification's color never
 * disagrees with what the same severity means anywhere else in the UI.
 */
import type { Tone } from '../primitives/StatusBadge.js';
import type { SourceQuality } from '../../data/api-types.js';

export type NotificationSeverity = 'critical' | 'high' | 'medium' | 'low' | 'info';

export const SEVERITY_ORDER: NotificationSeverity[] = ['critical', 'high', 'medium', 'low', 'info'];

export function severityToTone(severity: NotificationSeverity): Tone {
  switch (severity) {
    case 'critical':
      return 'danger';
    case 'high':
      return 'warning';
    case 'medium':
      return 'running';
    case 'low':
      return 'neutral';
    case 'info':
      return 'info';
  }
}

export type NotificationCategory =
  | 'action-required'
  | 'readiness'
  | 'security'
  | 'budget'
  | 'daemon-health'
  | 'proposal'
  | 'run'
  | 'log-source';

export const NOTIFICATION_CATEGORY_LABEL: Record<NotificationCategory, string> = {
  'action-required': 'Action required',
  readiness: 'Autonomous readiness',
  security: 'Security',
  budget: 'Budget & limits',
  'daemon-health': 'Daemon health',
  proposal: 'Proposals',
  run: 'Runs',
  'log-source': 'Log source',
};

export interface AppNotification {
  /** Stable per-underlying-issue id (e.g. `run-failed-r_123`) — re-deriving
   * with the same id updates the existing entry in place instead of
   * duplicating it; the id disappearing from a fresh derive means the
   * underlying issue resolved, and the store retires it automatically. */
  id: string;
  category: NotificationCategory;
  severity: NotificationSeverity;
  title: string;
  detail: string;
  /** ISO timestamp of the underlying event, when known; falls back to first-seen. */
  ts: string;
  /** Hash-router path to jump straight to the relevant view. */
  actionHref?: string;
  actionLabel?: string;
  /** Present when the notification is itself ABOUT degraded/unknown source
   * data (e.g. "daemon state unknown") — distinct from Epistemic's per-field
   * withholding, this is the notification centre surfacing the gap as an
   * actionable "go check" item rather than staying silent about it. */
  sourceQuality?: SourceQuality;
}
