/**
 * Needs-you producer for the leader-review lane: every firing waiting for
 * review is one item with Approve / Reject. activity-api.ts merges these
 * with the remote lanes' items (filed under `fleet`, kind `leader-question`
 * — no new contract kind).
 *
 * R1 contract: `needsYouItems()` is PURE and served from a cache; a stale
 * cache kicks off an async refresh off the caller's stack. The scheduler and
 * the review routes refresh it explicitly.
 */
import {
  isNeedsYouItem,
  NEEDS_YOU_DETAIL_MAX,
  NEEDS_YOU_TITLE_MAX,
  type NeedsYouItem,
} from '../verse/workbench-types.js';
import { readAutomations, readAutomationState } from './store.js';
import { VERSE_AUTOMATIONS_PATH, type AutomationFiringV1, type AutomationV1 } from './types.js';

const STALE_MS = 60_000;

let cache: NeedsYouItem[] = [];
let cachedAt = 0;
let refreshing: Promise<void> | null = null;

const cap = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

export function reviewNeedsYouItem(firing: AutomationFiringV1, automation: AutomationV1 | null): NeedsYouItem {
  const route = `${VERSE_AUTOMATIONS_PATH}/firings/${firing.id}`;
  const lane = automation && automation.lane !== 'leader-review' ? automation.lane : 'fleet';
  const detailParts = [`${automation?.name ?? firing.automationId} · ${firing.repo}`];
  if (firing.triage?.source === 'jev') detailParts.push(firing.triage.note);
  if (firing.source.url) detailParts.push(firing.source.url);
  return {
    id: `fleet:leader-question:automation-${firing.id}`,
    source: 'fleet',
    kind: 'leader-question',
    severity: 'info',
    title: cap(`Review: ${firing.title}`, NEEDS_YOU_TITLE_MAX),
    detail: cap(detailParts.join(' — '), NEEDS_YOU_DETAIL_MAX),
    since: firing.dispatchedAt ?? firing.createdAt,
    expiresAt: null,
    subject: { repo: firing.repo, pr: null, seatId: null, sessionId: null, engine: null },
    target: firing.source.url ? { kind: 'url', url: firing.source.url } : { kind: 'section', section: 'automations', anchor: firing.id },
    actions: [
      {
        kind: 'approve',
        label: `Approve → ${lane}`,
        request: { method: 'POST', path: `${route}/approve`, body: {} },
        confirm: {
          title: 'Hand this to the lane?',
          body: `The ${lane} lane gets this task. The standing grant, KILL and the lane's budget still apply.`,
          confirmLabel: 'Approve',
        },
        destructive: false,
      },
      {
        kind: 'reject',
        label: 'Reject',
        request: { method: 'POST', path: `${route}/reject`, body: {} },
        confirm: null,
        destructive: true,
      },
    ],
  };
}

export async function refreshAutomationsNeedsYou(): Promise<void> {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    try {
      const [{ automations }, state] = await Promise.all([readAutomations(), readAutomationState()]);
      const byId = new Map(automations.map((a) => [a.id, a]));
      cache = state.firings
        .filter((f) => f.state === 'awaiting-review')
        .map((f) => reviewNeedsYouItem(f, byId.get(f.automationId) ?? null))
        .filter(isNeedsYouItem);
      cachedAt = Date.now();
    } catch {
      // Keep the last good answer; the next poll retries.
    }
  })().finally(() => { refreshing = null; });
  return refreshing;
}

/** R1: pure, from cache (refreshed off-stack when older than a minute). */
export function needsYouItems(): NeedsYouItem[] {
  if (Date.now() - cachedAt > STALE_MS && !refreshing) void refreshAutomationsNeedsYou();
  return [...cache];
}

export function resetAutomationsNeedsYouForTest(): void {
  cache = [];
  cachedAt = 0;
  refreshing = null;
}
