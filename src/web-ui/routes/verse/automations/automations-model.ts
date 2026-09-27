/**
 * routes/verse/automations/automations-model.ts — pure helpers for the
 * Automations section: the form ⇄ definition mapping, plain-language stats
 * and the tone of a firing's state. No React, no fetch.
 *
 * The form is deliberately simple (text fields, a few selects). The server
 * validates the whole definition and answers a plain sentence on a mistake,
 * so the form only shapes values — it never decides what is allowed.
 */
import type {
  AutomationFiringState,
  AutomationInput,
  AutomationLane,
  AutomationStats,
  AutomationTriggerKind,
  AutomationTriageConfig,
  AutomationV1,
} from '../../../../core/automations/types.js';
import type { Tone } from '../../../components/primitives/StatusBadge.js';

export const LANE_LABEL: Readonly<Record<AutomationLane, string>> = {
  fleet: 'Fleet',
  cloud: 'Claude cloud',
  devin: 'Devin',
  'leader-review': 'Review first',
};

export const LANE_HINT: Readonly<Record<AutomationLane, string>> = {
  fleet: 'Queued for the local fleet — free, dispatched under the standing grant.',
  cloud: 'A Claude cloud session — spends credits; held to the self-improvement caps.',
  devin: 'A Devin session — spends ACUs; needs the Devin fleet opt-in.',
  'leader-review': 'Waits in Needs-you until you approve it.',
};

export const TRIGGER_LABEL: Readonly<Record<AutomationTriggerKind, string>> = {
  'github-issues': 'GitHub issues with a label',
  'ci-red': 'Red default branch (failing checks)',
  schedule: 'Schedule (RRULE)',
  webhook: 'Local webhook (n8n, Linear bridge…)',
  telegram: 'Telegram /task',
};

export interface AutomationForm {
  id: string | null;
  name: string;
  enabled: boolean;
  triggerKind: AutomationTriggerKind;
  labels: string;
  query: string;
  includePrs: boolean;
  branch: string;
  rrule: string;
  pollMinutes: string;
  lane: AutomationLane;
  repos: string;
  instructions: string;
  playbookId: string;
  maxConcurrent: string;
  maxPerDay: string;
  queueDepth: string;
  spendCapUsd: string;
  dedupeKey: string;
  /** Not edited here (CLI / API); carried through unchanged on save. */
  triage: AutomationTriageConfig | null;
}

export function formFrom(source: AutomationInput | AutomationV1, id: string | null = null): AutomationForm {
  const t = source.trigger;
  return {
    id,
    name: source.name,
    enabled: source.enabled,
    triggerKind: t.kind,
    labels: t.kind === 'github-issues' ? t.labels.join(', ') : 'ashlr',
    query: t.kind === 'github-issues' ? t.query ?? '' : '',
    includePrs: t.kind === 'github-issues' ? t.includePrs : false,
    branch: t.kind === 'ci-red' ? t.branch ?? '' : '',
    rrule: t.kind === 'schedule' ? t.rrule : 'FREQ=DAILY;BYHOUR=2;BYMINUTE=0',
    pollMinutes: String(t.kind === 'github-issues' || t.kind === 'ci-red' ? t.pollMinutes : 15),
    lane: source.lane,
    repos: source.repos.join(', '),
    instructions: source.instructions,
    playbookId: source.playbookId ?? '',
    maxConcurrent: String(source.maxConcurrent),
    maxPerDay: String(source.maxPerDay),
    queueDepth: String(source.queueDepth),
    spendCapUsd: String(source.spendCapUsd),
    dedupeKey: source.dedupeKey ?? '',
    triage: source.triage ?? null,
  };
}

const list = (text: string): string[] => text.split(',').map((s) => s.trim()).filter((s) => s !== '');

function num(text: string, name: string): number | string {
  const n = Number(text.trim());
  return text.trim() === '' || !Number.isFinite(n) ? `${name} must be a number.` : n;
}

/** Shape the form into a definition body; the server does the real validation. */
export function inputFromForm(form: AutomationForm): { ok: true; input: Record<string, unknown> } | { ok: false; error: string } {
  if (form.name.trim() === '') return { ok: false, error: 'Give the automation a name.' };
  const repos = list(form.repos);
  if (repos.length === 0) return { ok: false, error: 'List at least one repo (owner/name), or * for every repo in the standing grant.' };
  const numbers: Record<string, number> = {};
  for (const [key, label] of [['maxConcurrent', 'Max in flight'], ['maxPerDay', 'Max per day'], ['queueDepth', 'Queue depth'], ['spendCapUsd', 'Spend cap']] as const) {
    const v = num(form[key], label);
    if (typeof v === 'string') return { ok: false, error: v };
    numbers[key] = v;
  }
  let trigger: Record<string, unknown>;
  switch (form.triggerKind) {
    case 'github-issues': {
      const poll = num(form.pollMinutes, 'Check every');
      if (typeof poll === 'string') return { ok: false, error: poll };
      trigger = { kind: 'github-issues', labels: list(form.labels), query: form.query.trim() === '' ? null : form.query.trim(), includePrs: form.includePrs, pollMinutes: poll };
      break;
    }
    case 'ci-red': {
      const poll = num(form.pollMinutes, 'Check every');
      if (typeof poll === 'string') return { ok: false, error: poll };
      trigger = { kind: 'ci-red', branch: form.branch.trim() === '' ? null : form.branch.trim(), pollMinutes: poll };
      break;
    }
    case 'schedule':
      trigger = { kind: 'schedule', rrule: form.rrule.trim() };
      break;
    default:
      trigger = { kind: form.triggerKind };
  }
  return {
    ok: true,
    input: {
      name: form.name.trim(),
      enabled: form.enabled,
      trigger,
      lane: form.lane,
      playbookId: form.playbookId.trim() === '' ? null : form.playbookId.trim(),
      repos,
      instructions: form.instructions,
      ...numbers,
      dedupeKey: form.dedupeKey.trim() === '' ? null : form.dedupeKey.trim(),
      triage: form.triage,
    },
  };
}

/** "in 12 min", "3 h ago", "just now", "—". */
export function relativeTime(iso: string | null, nowMs: number): string {
  if (!iso) return '—';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '—';
  const diff = t - nowMs;
  const mins = Math.round(Math.abs(diff) / 60_000);
  if (mins < 1) return diff >= 0 ? 'now' : 'just now';
  const span = mins < 60 ? `${mins} min` : mins < 48 * 60 ? `${Math.round(mins / 60)} h` : `${Math.round(mins / 1440)} d`;
  return diff >= 0 ? `in ${span}` : `${span} ago`;
}

export function successLabel(stats: AutomationStats): string {
  if (stats.successRate === null) return 'no results yet';
  return `${Math.round(stats.successRate * 100)}% (${stats.succeeded} of ${stats.succeeded + stats.failed})`;
}

export function spendLabel(automation: Pick<AutomationV1, 'spendCapUsd' | 'lane'>, stats: AutomationStats): string {
  if (automation.lane === 'fleet' || automation.lane === 'leader-review') {
    return stats.spentThisMonthUsd > 0 ? `$${stats.spentThisMonthUsd.toFixed(2)} this month` : 'no paid spend';
  }
  return `$${stats.spentThisMonthUsd.toFixed(2)} of $${automation.spendCapUsd.toFixed(2)} this month`;
}

const FIRING_TONE: Readonly<Record<AutomationFiringState, Tone>> = {
  queued: 'neutral',
  dispatching: 'running',
  dispatched: 'running',
  'awaiting-review': 'warning',
  succeeded: 'success',
  failed: 'danger',
  refused: 'danger',
  dropped: 'neutral',
  rejected: 'neutral',
};

export function firingTone(state: AutomationFiringState): Tone {
  return FIRING_TONE[state] ?? 'unknown';
}

export const FIRING_LABEL: Readonly<Record<AutomationFiringState, string>> = {
  queued: 'Queued',
  dispatching: 'Sending',
  dispatched: 'Running',
  'awaiting-review': 'Needs review',
  succeeded: 'Done',
  failed: 'Failed',
  refused: 'Refused',
  dropped: 'Dropped',
  rejected: 'Rejected',
};

/** https links only — a firing's source or lane link is shown as a link, never anything else. */
export function safeHref(url: string | null | undefined): string | null {
  return typeof url === 'string' && /^https:\/\/[^\s]+$/.test(url) ? url : null;
}
