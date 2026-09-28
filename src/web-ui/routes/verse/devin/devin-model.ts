/**
 * routes/verse/devin/devin-model.ts — pure view logic for the Devin lane
 * (3.15; server: core/devin/devin-api.ts).
 *
 * The overview is narrowed field by field: a server without the route (404)
 * is "not in this build", an unknown shape shows nothing rather than a guess.
 * Browser-safe: type-only imports from core.
 */
import {
  DEVIN_PROMPT_MAX_CHARS,
  DEVIN_USAGE_URL,
  type DevinBudgetView,
  type DevinOverviewResponse,
  type DevinStatus,
  type DevinTaskV1,
} from '../../../../core/devin/types.js';
import type { ResourceReadinessRow } from '../../../../core/routing/readiness-types.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

const isVerdict = (value: unknown): boolean =>
  isRecord(value) && typeof value['ready'] === 'boolean' && typeof value['tone'] === 'string' && typeof value['word'] === 'string' && typeof value['detail'] === 'string';

/** Just enough structure that no render can crash; null when it is not a Devin overview. */
export function narrowDevinOverview(raw: unknown): DevinOverviewResponse | null {
  if (!isRecord(raw)) return null;
  const { status, budget, tasks } = raw;
  if (!isRecord(status) || typeof status['enabled'] !== 'boolean' || typeof status['connected'] !== 'boolean' || typeof status['state'] !== 'string') return null;
  if (!isVerdict(status['chat']) || !isVerdict(status['fleet'])) return null;
  if (!isRecord(budget) || !isRecord(budget['canLaunch']) || !isRecord(budget['budget'])) return null;
  for (const key of ['acuBudgetTotal', 'acuUsed', 'acuRemaining', 'acuToday', 'acuInFlight', 'estimatedUsdUsed', 'sessionsToday', 'running']) {
    if (typeof budget[key] !== 'number' || !Number.isFinite(budget[key])) return null;
  }
  if (!Array.isArray(tasks) || !tasks.every((t) => isRecord(t) && typeof t['id'] === 'string' && typeof t['state'] === 'string')) return null;
  return raw as unknown as DevinOverviewResponse;
}

/**
 * 3.15: the Devin CLI's model catalog in one line for the Resources card —
 * "Models: SWE-2 (free) + 51 paid families" and "Default: SWE-2 High (Free)".
 * Null when the server sent no (or a malformed) summary. Pure.
 */
export function devinModelsLines(models: unknown): { catalog: string; defaultLine: string; stale: boolean } | null {
  if (!isRecord(models)) return null;
  const free = Array.isArray(models['freeFamilies']) ? models['freeFamilies'].filter((f): f is string => typeof f === 'string' && f.length > 0 && f.length <= 120) : null;
  const paid = models['paidFamilyCount'];
  const def = models['defaultModel'];
  if (free === null || typeof paid !== 'number' || !Number.isInteger(paid) || paid < 0 || !isRecord(def) || typeof def['label'] !== 'string') return null;
  const freePart = free.length > 0 ? free.map((f) => `${f} (free)`).join(', ') : null;
  const paidPart = paid > 0 ? `${paid} paid famil${paid === 1 ? 'y' : 'ies'}` : null;
  const catalog = `Models: ${[freePart, paidPart].filter(Boolean).join(' + ') || 'none listed'}`;
  const price = def['free'] === true ? 'Free' : typeof def['price'] === 'string' && def['price'] ? def['price'] : null;
  const defaultLine = `Default: ${def['label']}${price ? ` (${price})` : ''}`;
  return { catalog, defaultLine, stale: models['source'] === 'fallback' };
}

/** "12 ACUs", "1 ACU", "2.5 ACUs". */
export function formatAcu(value: number): string {
  const v = Math.max(0, Math.round(value * 100) / 100);
  return `${v} ACU${v === 1 ? '' : 's'}`;
}

/** https only, on the expected host — a link the page may open. */
export function safeDevinHref(url: string | null | undefined, host: 'app.devin.ai' | 'github.com'): string | null {
  if (typeof url !== 'string' || url.length > 2_048) return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && parsed.hostname === host ? parsed.toString() : null;
  } catch {
    return null;
  }
}

export const DEVIN_USAGE_LINK = DEVIN_USAGE_URL;

/** ok / tight / limit for the meter, from what is left. */
export function acuLevel(budget: Pick<DevinBudgetView, 'acuBudgetTotal' | 'acuRemaining' | 'paused'>): 'ok' | 'tight' | 'limit' {
  if (budget.paused || budget.acuRemaining <= 0 || budget.acuBudgetTotal <= 0) return 'limit';
  return (budget.acuRemaining / budget.acuBudgetTotal) * 100 < 20 ? 'tight' : 'ok';
}

/** The card's headline state. */
export function devinHeadline(status: Pick<DevinStatus, 'state' | 'enabled' | 'connected'>): { word: string; tone: 'success' | 'warning' | 'danger' | 'neutral' } {
  switch (status.state) {
    case 'ready': return { word: 'Connected', tone: 'success' };
    case 'unreachable': return { word: 'Key refused', tone: 'danger' };
    case 'not-connected': return { word: 'Not connected', tone: 'warning' };
    default: return { word: status.connected ? 'Turned off' : 'Not set up', tone: 'neutral' };
  }
}

/**
 * The drawer's readiness row for Devin, built from the server's own verdicts
 * (core/devin/service.ts devinStatus) so ReadinessLines lays it out exactly
 * like every other resource. `engine` is not shown by the lines; `kind`
 * 'cloud' keeps the reading caveat hidden (Devin has no usage window).
 */
export function devinReadinessRow(status: Pick<DevinStatus, 'chat' | 'fleet'>): ResourceReadinessRow {
  return {
    id: 'devin',
    label: 'Devin',
    engine: 'devin',
    kind: 'cloud',
    reading: { state: 'live', at: null, note: null },
    chat: status.chat,
    fleet: status.fleet,
  };
}

/** Sessions waiting for Mason (a reply box on the card). */
export function waitingTasks(tasks: readonly DevinTaskV1[]): DevinTaskV1[] {
  return tasks.filter((task) => task.state === 'blocked' && task.sessionId !== null).slice(0, 5);
}

export interface RunInDevinInputs {
  overview: DevinOverviewResponse | null;
  overviewReason: string | null;
  repo: string | null;
  rootsLoading: boolean;
  prompt: string;
}

const COUNT = new Intl.NumberFormat('en-US');

/** Null when "Run in Devin" may be pressed; otherwise the sentence saying why not. */
export function runInDevinBlock(inputs: RunInDevinInputs): string | null {
  if (!inputs.overview) return inputs.overviewReason ?? 'The Devin lane did not answer.';
  const { status, budget } = inputs.overview;
  if (!status.connected) return 'Devin is not connected. Run `ashlr devin connect` in a terminal.';
  if (!status.enabled) return 'The Devin lane is turned off (`ashlr devin enable`).';
  if (status.state === 'unreachable') return status.reason;
  if (!inputs.repo) {
    return inputs.rootsLoading ? "Reading this chat's project…" : "This chat's project has no GitHub origin, so Devin has nothing to work on.";
  }
  if (!budget.canLaunch.ok) return budget.canLaunch.reason ?? 'The Devin budget does not allow another session right now.';
  if (!inputs.prompt.trim()) return 'Type the task in the message box first.';
  if (inputs.prompt.trim().length > DEVIN_PROMPT_MAX_CHARS) {
    return `The message is over ${COUNT.format(DEVIN_PROMPT_MAX_CHARS)} characters — trim it to run it in Devin.`;
  }
  return null;
}
