/**
 * routes/verse/command/fetch-stub.test-support.ts — one fetch stub for the
 * four surface tests (unit C7). Routes answer from fixtures.test-support.ts
 * at a chosen shape (live / sparse / dark); any route can be overridden or
 * made absent (404, the "module not landed" case); POSTs are recorded.
 */
import { vi } from 'vitest';
import {
  activitySnapshot,
  authorityStatus,
  budgetView,
  fleetHistory,
  fleetLive,
  grantDraft,
  leaderState,
  learningState,
  reasoningDigest,
  seatHistory,
  setupReport,
  type FixtureKind,
} from './fixtures.test-support.js';

export type RouteAnswer = unknown | ((url: string) => Response);

export interface StubOptions {
  kind?: FixtureKind;
  /** Keyed by path prefix; `null` answers 404 (not landed). */
  routes?: Record<string, RouteAnswer | null>;
  post?: (url: string, body: Record<string, unknown>) => Response | undefined;
  now?: number;
}

export interface StubHandle {
  posted: { url: string; body: Record<string, unknown> }[];
  fetchMock: ReturnType<typeof vi.fn>;
}

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });

/**
 * The grant draft's refusal before setup (core/verse/authority-api.ts
 * AuthorityDraftError): no custody key is compiled in, so no grant can be
 * drafted and the "Autonomy is off" state asks for `ashlr authority setup`.
 */
export const draftRefused = (code = 'no-trust-roots') => () =>
  json({ code, error: 'No custody key is compiled into this build yet — run `ashlr authority setup` and merge the trust-root PR it opens.' }, 409);

export function surfaceRoutes(kind: FixtureKind, now: number): Record<string, unknown> {
  return {
    '/api/verse/authority/draft': grantDraft(now),
    '/api/verse/authority/setup': setupReport(),
    '/api/verse/authority': authorityStatus(kind, now),
    '/api/verse/fleet/live': fleetLive(kind, now),
    '/api/verse/fleet/history': fleetHistory(kind, now),
    '/api/verse/leader': leaderState(kind, now),
    '/api/verse/learning': learningState(kind, now),
    '/api/verse/activity': activitySnapshot(kind, now),
    '/api/verse/budget/preview': null,
    '/api/verse/budget/history': seatHistory(kind, now),
    '/api/verse/budget': budgetView(kind, now),
    '/api/reasoning/digest': reasoningDigest(kind, now),
    '/api/verse/overnight': { armed: false, run: null, repos: null, gate: null },
    '/api/models': { window: '30d', models: [], bestOfNSource: { sourceState: 'missing', sourcePresent: false, complete: true, stopReasons: [], filesRead: 0, bytesRead: 0, rowsScanned: 0, invalidRows: 0, unreadableFiles: 0 } },
  };
}

export function stubSurfaceFetch(options: StubOptions = {}): StubHandle {
  const now = options.now ?? Date.now();
  const table: Record<string, RouteAnswer | null> = { ...surfaceRoutes(options.kind ?? 'live', now), ...(options.routes ?? {}) };
  // Longest prefix first, so /authority/draft wins over /authority.
  const prefixes = Object.keys(table).sort((a, b) => b.length - a.length);
  const posted: StubHandle['posted'] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (init?.method === 'POST') {
      const body = init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
      posted.push({ url, body });
      return options.post?.(url, body) ?? json({ ok: true });
    }
    const path = url.split('?')[0]!;
    const prefix = prefixes.find((p) => path === p || path.startsWith(`${p}/`));
    if (prefix === undefined) return json({ error: 'not found' }, 404);
    const answer = table[prefix];
    if (answer === null) return json({ error: 'not found' }, 404);
    if (typeof answer === 'function') return (answer as (u: string) => Response)(url);
    return json(answer);
  });
  vi.stubGlobal('fetch', fetchMock);
  return { posted, fetchMock };
}
