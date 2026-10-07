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
  type DevinSelfIdentitySummary,
  type DevinTaskV1,
} from '../../../../core/devin/types.js';
import type { ResourceReadinessRow } from '../../../../core/routing/readiness-types.js';
import { formatMetric } from '../../../components/charts/format-metric.js';
import type { DevinConsumptionSnapshot } from '../../../../core/devin/consumption.js';

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
  for (const key of ['reportedAcuUsed', 'unconfirmedAcuExposure']) {
    if (budget[key] !== undefined && (typeof budget[key] !== 'number' || !Number.isFinite(budget[key]) || budget[key] < 0)) return null;
  }
  if (!Array.isArray(tasks) || !tasks.every((t) => isRecord(t) && typeof t['id'] === 'string' && typeof t['state'] === 'string')) return null;
  return raw as unknown as DevinOverviewResponse;
}

/** Captured /self metadata only: no current principal, permission or funding claim. */
export function devinSelfIdentityEvidence(raw: unknown, now = Date.now()): DevinSelfIdentitySummary | null {
  if (!isRecord(raw) || raw['source'] !== 'devin-v3-self'
    || raw['principal'] !== 'service_user' && raw['principal'] !== 'pat_user') return null;
  const flags = ['hasServiceUserId', 'hasUserId', 'hasApiKeyId', 'hasOrgId', 'hasDevinSessionsOrgId'] as const;
  const keys = ['source', 'observedAt', 'principal', ...flags];
  if (Object.keys(raw).length !== keys.length || Object.keys(raw).some(key => !keys.includes(key))
    || flags.some(key => typeof raw[key] !== 'boolean')) return null;
  const at = typeof raw['observedAt'] === 'string' ? Date.parse(raw['observedAt']) : NaN;
  if (!Number.isFinite(now) || !Number.isFinite(at) || at > now
    || new Date(at).toISOString() !== raw['observedAt']) return null;
  if (raw['principal'] === 'service_user'
    ? raw['hasServiceUserId'] !== true || raw['hasUserId'] !== false || raw['hasApiKeyId'] !== false || raw['hasDevinSessionsOrgId'] !== false
    : raw['hasServiceUserId'] !== false || raw['hasUserId'] !== true || raw['hasApiKeyId'] !== true) return null;
  return raw as unknown as DevinSelfIdentitySummary;
}

/** Older servers combine unknown reservations with usage: never infer readings from that total. */
export function devinUsageEvidence(budget: DevinBudgetView): { reported: number; held: number; free: number } | null {
  const reported = budget.reportedAcuUsed;
  const held = budget.unconfirmedAcuExposure;
  if (typeof reported !== 'number' || !Number.isFinite(reported) || reported < 0 ||
    typeof held !== 'number' || !Number.isFinite(held) || held < 0) return null;
  return { reported, held, free: Math.max(0, Math.round((budget.acuBudgetTotal - reported - held) * 100) / 100) };
}

/** Independent metadata, never interpreted as personal CLI usage or remaining capacity. */
export function devinConsumptionEvidence(raw: unknown, now = Date.now()): { value: string; lines: string[]; stale: boolean; report: DevinConsumptionSnapshot['report'] } | null {
  if (!isRecord(raw) || raw['source'] !== 'devin-v3-organization-daily' || raw['scope'] !== 'organization'
    || raw['period'] !== 'all-available-reporting-dates' || raw['dateUnit'] !== 'provider-unspecified' || raw['dayBoundaryUtc'] !== '08:00'
    || !['not-checked', 'reading', 'ready', 'unavailable'].includes(String(raw['state']))) return null;
  const snapshot = raw as unknown as DevinConsumptionSnapshot;
  const lines = ['Organization API consumption · all available reporting dates · all products.',
    'Provider day boundary: 08:00 UTC; reporting date units are unspecified.',
    'Devin, Cascade and Terminal can be zero defaults when product data is unavailable; Automation and Review can be unreported.',
    'Balance, subscription limits and resets are not reported. No personal CLI allocation is inferred.'];
  if (snapshot.error) {
    if (!isRecord(snapshot.error) || typeof snapshot.error.reason !== 'string' || snapshot.error.reason.length > 500) return null;
    lines.push(snapshot.error.reason);
  }
  const report = snapshot.report;
  if (report === null) return { value: snapshot.state === 'reading' ? 'reading consumption…' : 'consumption not reported', lines, stale: false, report: null };
  if (!isRecord(report) || typeof report.totalAcus !== 'number' || !Number.isFinite(report.totalAcus) || report.totalAcus < 0
    || !Array.isArray(report.days) || !report.days.every(day => isRecord(day) && Number.isSafeInteger(day.date)
      && typeof day.acus === 'number' && Number.isFinite(day.acus) && day.acus >= 0 && isRecord(day.products)
      && (['devin', 'cascade', 'terminal', 'automation', 'review'] as const).every(key => day.products[key] === null
        || typeof day.products[key] === 'number' && Number.isFinite(day.products[key]) && day.products[key] >= 0))) return null;
  const fetched = typeof snapshot.fetchedAt === 'string' ? Date.parse(snapshot.fetchedAt) : NaN;
  const expires = typeof snapshot.expiresAt === 'string' ? Date.parse(snapshot.expiresAt) : NaN;
  if (!Number.isFinite(fetched) || !Number.isFinite(expires) || fetched > now || expires <= fetched) return null;
  const stale = snapshot.state !== 'ready' || snapshot.stale === true || expires <= now;
  lines.push(`Retrieved ${new Date(fetched).toLocaleString()}${stale ? ' · last reading, current consumption unconfirmed' : ' · retrieval is current; provider publication delay is unknown'}.`);
  lines.push(`${report.days.length} daily reporting bucket${report.days.length === 1 ? '' : 's'}; dates retained as provider values.`);
  return { value: report.days.length === 0 && report.totalAcus === 0 ? 'No consumption reported' : `${formatConsumptionAcu(report.totalAcus)} consumed${stale ? ' · last' : ''}`, lines, stale, report };
}

/** Display consumption with two significant figures; raw provider values remain unchanged. */
export function formatConsumptionAcu(value: number): string {
  return `${formatMetric(value)} ACU${value === 1 ? '' : 's'}`;
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
  const v = Math.max(0, value);
  return `${formatMetric(v)} ACU${v === 1 ? '' : 's'}`;
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
