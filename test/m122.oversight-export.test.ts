/**
 * test/m122.oversight-export.test.ts — M122: Oversight snapshot export unit tests.
 *
 * CONTRACT verified:
 *  1. buildOversightSnapshot with empty HOME → valid snapshot, null manager, null vision.
 *  2. buildOversightSnapshot with seeded manager report → ship/review/noise/harmful counts correct.
 *  3. buildOversightSnapshot with seeded goal → goals.active and progressPct computed.
 *  4. buildOversightSnapshot with seeded vision → vision.northStar populated.
 *  5. exportOversight no-op when pulse disabled.
 *  6. exportOversight no-op when ASHLR_PULSE_PAT absent.
 *  7. exportOversight POSTs to /api/oversight with correct headers.
 *
 * NO real network calls are made.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';

// ---------------------------------------------------------------------------
// HOME isolation
// ---------------------------------------------------------------------------

let tmpHome: string;
let origHome: string;

const MANAGER_REPORT = {
  generatedAt: '2026-06-01T00:00:00.000Z',
  window: '7d',
  metrics: {
    window: '7d',
    proposalsCreated: 5,
    merged: 3,
    rejected: 1,
    pending: 1,
    withDiff: 4,
    emptyRate: 0.2,
    trivialRatio: 0.1,
    acceptRate: 0.6,
    rejectRate: 0.2,
    verifyPassRate: 0.8,
    avgDiffLines: 20,
    byEngine: {},
    byRepo: {},
  },
  verdicts: [
    { proposalId: 'p1', verdict: 'ship',   value: 4, correctness: 4, scope: 2, alignment: 4, rationale: 'good',    wouldMerge: true  },
    { proposalId: 'p2', verdict: 'review', value: 3, correctness: 3, scope: 3, alignment: 3, rationale: 'ok',      wouldMerge: false },
    { proposalId: 'p3', verdict: 'noise',  value: 1, correctness: 2, scope: 1, alignment: 2, rationale: 'trivial', wouldMerge: false },
  ],
  wins: ['p1: add auth'],
  concerns: [],
  recommendations: ['tune prompts'],
  narrative: 'Fleet nominal.',
  judgeEngine: 'claude-opus-4-5',
};

const VISION_SPEC = {
  northStar: 'Ship AI-native dev tools used by 10k devs',
  endState: 'Autonomous fleet handles 80% of routine coding tasks',
  priorities: ['fleet quality', 'pulse visibility'],
  ambitionLevel: 'ambitious',
};

function seedManagerReport(report = MANAGER_REPORT): void {
  const dir = join(tmpHome, '.ashlr', 'manager');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, '2026-06-01T00-00-00-000Z.json'), JSON.stringify(report), 'utf8');
}

function seedGoal(id: string, overrides: object = {}): void {
  const dir = join(tmpHome, '.ashlr', 'goals');
  mkdirSync(dir, { recursive: true });
  const goal = {
    id,
    objective: 'Test goal',
    project: null,
    status: 'active',
    milestones: [
      { id: `${id}-m0`, title: 'Done milestone',    order: 0, status: 'done',    createdAt: '2026-06-01T00:00:00.000Z', updatedAt: '2026-06-01T00:00:00.000Z', detail: '', specId: null, swarmId: null, proposalId: null },
      { id: `${id}-m1`, title: 'Pending milestone', order: 1, status: 'pending', createdAt: '2026-06-01T00:00:00.000Z', updatedAt: '2026-06-01T00:00:00.000Z', detail: '', specId: null, swarmId: null, proposalId: null },
    ],
    createdAt: '2026-06-01T00:00:00.000Z',
    updatedAt: '2026-06-01T00:00:00.000Z',
    ...overrides,
  };
  writeFileSync(join(dir, `${id}.json`), JSON.stringify(goal), 'utf8');
}

function seedVision(spec = VISION_SPEC): void {
  const dir = join(tmpHome, '.ashlr', 'vision');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, '2026-06-01T00-00-00-000Z.json'), JSON.stringify(spec), 'utf8');
}

beforeEach(() => {
  tmpHome = join(tmpdir(), `m122-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tmpHome, { recursive: true });
  origHome = process.env['HOME'] ?? '';
  process.env['HOME'] = tmpHome;
  delete process.env['ASHLR_PULSE_PAT'];
});

afterEach(() => {
  process.env['HOME'] = origHome;
  if (existsSync(tmpHome)) {
    rmSync(tmpHome, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});

// Dynamic import helper (picks up patched HOME at call time)
async function getOversightExport() {
  return import('../src/core/fleet/oversight-export.js');
}

// ---------------------------------------------------------------------------
// 1. buildOversightSnapshot — empty HOME
// ---------------------------------------------------------------------------

describe('buildOversightSnapshot — empty HOME', () => {
  it('returns a valid snapshot with zeroed scorecard, null manager, null vision', async () => {
    const { buildOversightSnapshot } = await getOversightExport();
    const snapshot = buildOversightSnapshot({});

    expect(snapshot).toHaveProperty('generatedAt');
    expect(typeof snapshot.generatedAt).toBe('string');
    expect(snapshot).toHaveProperty('scorecard');
    expect(snapshot.scorecard).toHaveProperty('proposalsCreated');
    expect(snapshot.manager).toBeNull();
    expect(snapshot.vision).toBeNull();
    expect(snapshot.goals.active).toBe(0);
    expect(snapshot.goals.done).toBe(0);
    expect(snapshot.goals.progressPct).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 2. buildOversightSnapshot — seeded manager report
// ---------------------------------------------------------------------------

describe('buildOversightSnapshot — manager report', () => {
  it('counts ship/review/noise/harmful from verdicts array', async () => {
    seedManagerReport();
    const { buildOversightSnapshot } = await getOversightExport();
    const snapshot = buildOversightSnapshot({});

    expect(snapshot.manager).not.toBeNull();
    expect(snapshot.manager!.shipped).toBe(1); // 1 'ship' verdict
    expect(snapshot.manager!.review).toBe(1);  // 1 'review' verdict
    expect(snapshot.manager!.noise).toBe(1);   // 1 'noise' verdict
    expect(snapshot.manager!.harmful).toBe(0); // 0 'harmful'
    expect(snapshot.manager!.recommendations).toEqual(['tune prompts']);
    expect(snapshot.manager!.generatedAt).toBe('2026-06-01T00:00:00.000Z');
  });

  it('handles a report with no verdicts array gracefully', async () => {
    const badReport = { generatedAt: '2026-06-02T00:00:00.000Z', recommendations: [] };
    seedManagerReport(badReport as typeof MANAGER_REPORT);
    const { buildOversightSnapshot } = await getOversightExport();
    const snapshot = buildOversightSnapshot({});

    expect(snapshot.manager).not.toBeNull();
    expect(snapshot.manager!.shipped).toBe(0);
    expect(snapshot.manager!.harmful).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 3. buildOversightSnapshot — seeded goal
// ---------------------------------------------------------------------------

describe('buildOversightSnapshot — goals', () => {
  it('counts active goals and computes progressPct from milestones', async () => {
    seedGoal('test-goal-abc123');
    const { buildOversightSnapshot } = await getOversightExport();
    const snapshot = buildOversightSnapshot({});

    expect(snapshot.goals.active).toBe(1);
    expect(snapshot.goals.done).toBe(0);
    // 1 of 2 milestones done → fractionDone = 0.5 → progressPct = 50
    expect(snapshot.goals.progressPct).toBe(50);
  });

  it('counts done goals correctly', async () => {
    seedGoal('active-goal-000001', { status: 'active' });
    seedGoal('done-goal-000002', { status: 'done' });
    const { buildOversightSnapshot } = await getOversightExport();
    const snapshot = buildOversightSnapshot({});

    expect(snapshot.goals.active).toBe(1);
    expect(snapshot.goals.done).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 4. buildOversightSnapshot — seeded vision
// ---------------------------------------------------------------------------

describe('buildOversightSnapshot — vision', () => {
  it('populates vision from the most recent vision file', async () => {
    seedVision();
    const { buildOversightSnapshot } = await getOversightExport();
    const snapshot = buildOversightSnapshot({});

    expect(snapshot.vision).not.toBeNull();
    expect(snapshot.vision!.northStar).toBe('Ship AI-native dev tools used by 10k devs');
    expect(snapshot.vision!.ambitionLevel).toBe('ambitious');
    expect(typeof snapshot.vision!.progressPct).toBe('number');
  });

  it('returns null vision when no vision files exist', async () => {
    const { buildOversightSnapshot } = await getOversightExport();
    const snapshot = buildOversightSnapshot({});
    expect(snapshot.vision).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 5 + 6. exportOversight — no-op safety
// ---------------------------------------------------------------------------

describe('exportOversight — no-op safety', () => {
  it('returns false when cfg.pulse.enabled is false', async () => {
    const { exportOversight } = await getOversightExport();
    const result = await exportOversight({ pulse: { enabled: false, endpoint: 'http://localhost:9999' } });
    expect(result).toBe(false);
  });

  it('returns false when cfg.pulse is absent', async () => {
    const { exportOversight } = await getOversightExport();
    const result = await exportOversight({});
    expect(result).toBe(false);
  });

  it('returns false when ASHLR_PULSE_PAT is absent', async () => {
    delete process.env['ASHLR_PULSE_PAT'];
    const { exportOversight } = await getOversightExport();
    const result = await exportOversight({ pulse: { enabled: true, endpoint: 'http://localhost:9999' } });
    expect(result).toBe(false);
  });

  it('does not throw when fetch rejects (unreachable endpoint)', async () => {
    process.env['ASHLR_PULSE_PAT'] = 'test-pat';
    const mockFetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    vi.stubGlobal('fetch', mockFetch);

    const { exportOversight } = await getOversightExport();
    await expect(
      exportOversight({ pulse: { enabled: true, endpoint: 'http://localhost:9999' } }),
    ).resolves.toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 7. exportOversight — POST shape
// ---------------------------------------------------------------------------

describe('exportOversight — POST to /api/oversight', () => {
  it('POSTs to /api/oversight with correct headers and body', async () => {
    process.env['ASHLR_PULSE_PAT'] = 'secret-oversight-pat';
    const mockFetch = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', mockFetch);

    const { exportOversight } = await getOversightExport();
    const result = await exportOversight({ pulse: { enabled: true, endpoint: 'http://localhost:9999' } });

    expect(result).toBe(true);
    expect(mockFetch).toHaveBeenCalledOnce();

    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://localhost:9999/api/oversight');
    expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer secret-oversight-pat');
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');

    // Body must contain a snapshot key
    const body = JSON.parse(init.body as string) as { snapshot: unknown };
    expect(body).toHaveProperty('snapshot');
    expect(body.snapshot).toHaveProperty('scorecard');
    expect(body.snapshot).toHaveProperty('goals');

    // PAT must NOT appear in body or URL
    expect(init.body as string).not.toContain('secret-oversight-pat');
    expect(url).not.toContain('secret-oversight-pat');
  });

  it('returns false on non-2xx response', async () => {
    process.env['ASHLR_PULSE_PAT'] = 'test-pat';
    const mockFetch = vi.fn().mockResolvedValue(new Response('Unauthorized', { status: 401 }));
    vi.stubGlobal('fetch', mockFetch);

    const { exportOversight } = await getOversightExport();
    const result = await exportOversight({ pulse: { enabled: true, endpoint: 'http://localhost:9999' } });
    expect(result).toBe(false);
  });
});
