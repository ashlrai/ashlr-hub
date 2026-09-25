/**
 * routes/verse/cloud/cloud-fixtures.test-support.ts — CloudOverviewResponse
 * builders for the cloud lane's tests (3.11 unit C3), plus one fetch stub
 * that answers GET /api/verse/cloud and records every POST.
 *
 * Every body here is shaped by the frozen contract (core/cloud/types.ts), so
 * a contract change breaks these at compile time instead of drifting.
 */
import { vi } from 'vitest';
import {
  CLOUD_BALANCE_URL,
  DEFAULT_CLOUD_BUDGET,
  type CloudBudgetV1,
  type CloudBudgetView,
  type CloudOverviewResponse,
  type CloudTaskV1,
} from '../../../../core/cloud/types.js';

export const HOUR = 3_600_000;

export const ESTIMATE_NOTE = "Estimated at $3 per session — Claude doesn't expose the credit balance. Check it on claude.ai and adjust here.";

export function budget(over: Partial<CloudBudgetV1> = {}, selfImprove: Partial<CloudBudgetV1['selfImprove']> = {}): CloudBudgetV1 {
  return {
    ...DEFAULT_CLOUD_BUDGET,
    ...over,
    selfImprove: { ...DEFAULT_CLOUD_BUDGET.selfImprove, ...selfImprove },
    updatedAt: '2026-09-24T12:00:00.000Z',
  };
}

export function budgetView(over: Partial<CloudBudgetView> = {}): CloudBudgetView {
  const b = over.budget ?? budget();
  const spent = over.estimatedSpentUsd ?? 9;
  return {
    creditsTotalUsd: b.creditsTotalUsd,
    estimatedSpentUsd: spent,
    estimatedRemainingUsd: b.creditsTotalUsd - spent,
    sessionsToday: 3,
    selfImproveToday: 1,
    running: 0,
    canLaunch: { ok: true, reason: null },
    canSelfImprove: { ok: true, reason: null },
    estimateNote: ESTIMATE_NOTE,
    balanceUrl: CLOUD_BALANCE_URL,
    ...over,
    budget: b,
  };
}

let seq = 0;
/** A task in `state`, created `agoMs` before `now`. Ids follow CLOUD_TASK_ID_PATTERN. */
export function task(state: CloudTaskV1['state'], over: Partial<CloudTaskV1> = {}, now = Date.now(), agoMs = 5 * 60_000): CloudTaskV1 {
  seq += 1;
  const id = over.id ?? `ct_20260924T2331_${String(seq).padStart(6, '0')}`;
  const at = new Date(now - agoMs).toISOString();
  const started = state !== 'queued' && state !== 'launching' && state !== 'failed';
  return {
    v: 1,
    id,
    repo: 'ashlrai/ashlr-hub',
    baseBranch: 'master',
    branch: `ashlr-cloud/${id}`,
    title: 'Fix the flaky tracker test',
    prompt: 'Fix the flaky tracker test.',
    origin: 'operator',
    requestedBy: 'mason',
    seat: 'claude-a',
    sessionId: started ? 'session_01ABC' : null,
    sessionUrl: started ? 'https://claude.ai/code/session_01ABC?from=cli&m=0' : null,
    state,
    stateReason: null,
    failure: null,
    createdAt: at,
    launchedAt: started ? at : null,
    updatedAt: at,
    pr: null,
    report: null,
    estimatedCostUsd: 3,
    backlogItemId: null,
    needsYouId: null,
    ...over,
  };
}

export function overview(over: Partial<CloudOverviewResponse> = {}): CloudOverviewResponse {
  return {
    generatedAt: new Date().toISOString(),
    seat: { id: 'claude-a', ready: true, reason: null },
    budget: budgetView(),
    tasks: [],
    backlog: {
      items: [
        { id: 'si-tests', title: 'Tighten the tracker tests', prompt: 'Tighten the tracker tests.', area: 'tests', priority: 1, claimedBy: null, lastState: null },
      ],
      nextUp: 'si-tests',
    },
    ...over,
  };
}

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });

export interface CloudStub {
  posted: { url: string; body: Record<string, unknown> }[];
  fetchMock: ReturnType<typeof vi.fn>;
  /** Replace what GET /api/verse/cloud answers from now on. */
  setOverview: (next: CloudOverviewResponse | null) => void;
}

/**
 * GET /api/verse/cloud answers `initial` (null → 404, "not in this build");
 * other GETs answer from `routes` by exact path prefix or 404. POSTs are
 * recorded and answered by `post` (default `{ ok: true }`).
 */
export function stubCloudFetch(
  initial: CloudOverviewResponse | null,
  options: { post?: (url: string, body: Record<string, unknown>) => Response | undefined; routes?: Record<string, unknown> } = {},
): CloudStub {
  let current = initial;
  const posted: CloudStub['posted'] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (init?.method === 'POST') {
      const body = init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
      posted.push({ url, body });
      return options.post?.(url, body) ?? json({ ok: true });
    }
    const path = url.split('?')[0]!;
    if (path === '/api/verse/cloud') return current ? json(current) : json({ error: 'not found' }, 404);
    for (const [prefix, answer] of Object.entries(options.routes ?? {})) {
      if (path === prefix || path.startsWith(`${prefix}/`)) return json(answer);
    }
    return json({ error: 'not found' }, 404);
  });
  vi.stubGlobal('fetch', fetchMock);
  return { posted, fetchMock, setOverview: (next) => { current = next; } };
}

export { json };
