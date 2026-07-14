/**
 * test/m89.pulse-export.test.ts — M89: Fleet→Pulse OTLP exporter unit tests.
 *
 * CONTRACT verified:
 *  1. buildFleetSpans produces exact OTLP shape from seeded daemon-state/proposals.
 *  2. Attributes: ashlr.source='ashlr-fleet', gen_ai.system, gen_ai.usage.*,
 *     ashlr.fleet.event, ashlr.fleet.repo, ashlr.fleet.outcome, ashlr.fleet.cost_usd,
 *     ashlr.fleet.ref_id all present.
 *  3. spanId is DETERMINISTIC for the same (ref_id, event).
 *  4. exportToPulse no-ops (no throw) when ASHLR_PULSE_PAT is absent.
 *  5. exportToPulse no-ops (no throw) when cfg.pulse.enabled is false.
 *  6. exportToPulse never throws on unreachable endpoint (fetch mock).
 *  7. --dry-run path: buildFleetSpans returns parseable payload (no network).
 *
 * NO real network calls are made.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import {
  signLocalMergeIntent,
  signLocalRealizedMergeReceipt,
} from '../src/core/foundry/provenance.js';

// ---------------------------------------------------------------------------
// Helpers to seed daemon state + proposals into a tmp HOME
// ---------------------------------------------------------------------------

let tmpHome: string;
let origHome: string;

function seedDaemonState(ticks: object[]): void {
  const dir = join(tmpHome, '.ashlr');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'daemon.json'),
    JSON.stringify({
      running: false,
      pid: null,
      startedAt: null,
      lastTickAt: null,
      todayDate: '2026-06-01',
      todaySpentUsd: 0.0042,
      itemsProcessed: 1,
      ticks,
    }),
    'utf8',
  );
}

function seedProposal(id: string, fields: object): void {
  const dir = join(tmpHome, '.ashlr', 'inbox');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${id}.json`),
    JSON.stringify({
      id,
      origin: 'daemon',
      kind: 'diff',
      title: 'Test proposal',
      summary: 'A test proposal for M89',
      status: 'pending',
      repo: '/Users/test/my-repo',
      createdAt: '2026-06-01T12:00:00.000Z',
      ...fields,
    }),
    'utf8',
  );
}

function git(repo: string, args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    stdio: 'pipe',
  }).trim();
}

function seedAuthenticatedRealizedProposal(
  id: string,
  observedAt: string,
  createdAt = '2026-06-01T13:00:00.000Z',
): void {
  const repo = join(tmpHome, `repo-${id}`);
  mkdirSync(repo, { recursive: true });
  execFileSync('git', ['init', '--initial-branch=main', repo], { stdio: 'pipe' });
  git(repo, ['config', 'user.email', 'pulse-test@ashlr.test']);
  git(repo, ['config', 'user.name', 'Pulse Test']);
  writeFileSync(join(repo, 'README.md'), '# base\n', 'utf8');
  git(repo, ['add', 'README.md']);
  git(repo, ['commit', '-m', 'base']);
  const baseBeforeOid = git(repo, ['rev-parse', 'HEAD']);
  git(repo, ['checkout', '-b', 'proposal']);
  writeFileSync(join(repo, 'README.md'), '# landed\n', 'utf8');
  git(repo, ['add', 'README.md']);
  git(repo, ['commit', '-m', 'proposal']);
  const proposalHeadOid = git(repo, ['rev-parse', 'HEAD']);
  git(repo, ['checkout', 'main']);
  git(repo, ['merge', '--no-ff', 'proposal', '-m', 'merge proposal']);
  const mergeCommitOid = git(repo, ['rev-parse', 'HEAD']);
  const diffHash = 'a'.repeat(64);
  const unsignedIntent = {
    schemaVersion: 1 as const,
    branch: 'proposal',
    base: 'main',
    baseBeforeOid,
    proposalHeadOid,
    diffHash,
    evidencePackDigest: 'b'.repeat(64),
    authorizationId: 'c'.repeat(32),
    authorizedAt: observedAt,
  };
  const intentAttestation = signLocalMergeIntent(id, repo, unsignedIntent);
  const localMergeIntent = { ...unsignedIntent, attestation: intentAttestation };
  const unsignedRealized = {
    schemaVersion: 1 as const,
    source: 'local-default-branch' as const,
    base: 'main',
    baseBeforeOid,
    proposalHeadOid,
    mergeCommitOid,
    observedAt,
    proposalId: id,
    diffHash,
    intentAttestation,
  };
  const attestation = signLocalRealizedMergeReceipt(id, repo, unsignedRealized);

  seedProposal(id, {
    kind: 'patch',
    status: 'applied',
    repo,
    createdAt,
    decidedAt: observedAt,
    diffHash,
    verifyResult: { passed: true, baseHead: baseBeforeOid, diffHash },
    localMergeIntent,
    realizedMerge: { ...unsignedRealized, attestation },
  });
}

// ---------------------------------------------------------------------------
// Setup: redirect HOME to tmp directory for each test
// ---------------------------------------------------------------------------

beforeEach(() => {
  tmpHome = join(tmpdir(), `m89-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tmpHome, { recursive: true });
  origHome = process.env['HOME'] ?? '';
  process.env['HOME'] = tmpHome;
  // Ensure ASHLR_PULSE_PAT is unset by default
  delete process.env['ASHLR_PULSE_PAT'];
});

afterEach(() => {
  process.env['HOME'] = origHome;
  if (existsSync(tmpHome)) {
    rmSync(tmpHome, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Import the module under test (after HOME is patched)
// ---------------------------------------------------------------------------

async function getPulseExport() {
  // Dynamic import to pick up the patched HOME at call time.
  // Vitest module cache means we need to use the same import path each time;
  // state re-reading is handled by the underlying loadDaemonState / listProposals
  // which resolve paths at call time via homedir().
  return import('../src/core/fleet/pulse-export.js');
}

// ---------------------------------------------------------------------------
// 1. buildFleetSpans — basic shape from empty state
// ---------------------------------------------------------------------------

describe('buildFleetSpans — shape', () => {
  it('returns a valid OTLP payload envelope even with no data', async () => {
    const { buildFleetSpans } = await getPulseExport();
    const payload = buildFleetSpans();

    expect(payload).toHaveProperty('resourceSpans');
    expect(Array.isArray(payload.resourceSpans)).toBe(true);
    expect(payload.resourceSpans).toHaveLength(1);
    expect(payload.resourceSpans[0]).toHaveProperty('scopeSpans');
    expect(payload.resourceSpans[0]!.scopeSpans).toHaveLength(1);
    expect(payload.resourceSpans[0]!.scopeSpans[0]).toHaveProperty('spans');
    expect(Array.isArray(payload.resourceSpans[0]!.scopeSpans[0]!.spans)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2. buildFleetSpans — tick span attributes
// ---------------------------------------------------------------------------

describe('buildFleetSpans — tick spans', () => {
  it('emits a fleet.tick span with all required attributes', async () => {
    seedDaemonState([
      {
        ts: '2026-06-01T10:00:00.000Z',
        itemsConsidered: 2,
        proposalsCreated: 1,
        spentUsd: 0.0012,
        reason: 'ok',
        backends: { claude: 1 },
      },
    ]);

    const { buildFleetSpans } = await getPulseExport();
    const payload = buildFleetSpans();
    const spans = payload.resourceSpans[0]!.scopeSpans[0]!.spans;

    const tickSpan = spans.find((s) => s.name === 'fleet.tick');
    expect(tickSpan).toBeDefined();

    const attrMap: Record<string, unknown> = {};
    for (const a of tickSpan!.attributes) {
      const val = 'stringValue' in a.value ? a.value.stringValue : a.value.intValue;
      attrMap[a.key] = val;
    }

    expect(attrMap['ashlr.source']).toBe('ashlr-fleet');
    expect(attrMap['gen_ai.system']).toBe('claude');
    expect(typeof attrMap['gen_ai.usage.input_tokens']).toBe('number');
    expect(typeof attrMap['gen_ai.usage.output_tokens']).toBe('number');
    expect(attrMap['ashlr.fleet.event']).toBe('tick');
    expect(typeof attrMap['ashlr.fleet.repo']).toBe('string');
    expect(attrMap['ashlr.fleet.outcome']).toBe('ok');
    expect(typeof attrMap['ashlr.fleet.cost_usd']).toBe('string');
    expect(attrMap['ashlr.fleet.ref_id']).toBe('2026-06-01T10:00:00.000Z');
  });

  it('keeps tick.merged as operational activity without synthesizing landed work', async () => {
    seedDaemonState([
      {
        ts: '2026-06-01T11:00:00.000Z',
        itemsConsidered: 1,
        proposalsCreated: 1,
        spentUsd: 0.002,
        reason: 'ok',
        merged: 1,
      },
    ]);

    const { buildFleetSpans } = await getPulseExport();
    const spans = buildFleetSpans().resourceSpans[0]!.scopeSpans[0]!.spans;
    expect(spans.filter((s) => s.name === 'fleet.tick')).toHaveLength(1);
    expect(spans.some((s) => s.name === 'fleet.merge')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 3. buildFleetSpans — proposal span attributes
// ---------------------------------------------------------------------------

describe('buildFleetSpans — proposal spans', () => {
  it('emits an explicit degraded-source diagnostic when proposal evidence is unreadable', async () => {
    const dir = join(tmpHome, '.ashlr', 'inbox');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'corrupt.json'), '{not-json', 'utf8');

    const { buildFleetSpans } = await getPulseExport();
    const spans = buildFleetSpans().resourceSpans[0]!.scopeSpans[0]!.spans;
    const diagnostic = spans.find((span) => span.name === 'fleet.diagnostic');
    expect(diagnostic).toBeDefined();
    const attrs = Object.fromEntries(diagnostic!.attributes.map((attr) => [
      attr.key,
      'stringValue' in attr.value ? attr.value.stringValue : attr.value.intValue,
    ]));
    expect(attrs).toMatchObject({
      'ashlr.fleet.event': 'diagnostic',
      'ashlr.fleet.outcome': 'degraded-source',
      'ashlr.fleet.ref_id': 'proposal-source',
      'ashlr.fleet.diagnostic.source': 'proposals',
      'ashlr.fleet.diagnostic.source_state': 'degraded',
      'ashlr.fleet.diagnostic.complete': 'false',
    });
    expect(spans.some((span) => span.name === 'fleet.proposal')).toBe(false);
  });

  it('emits a fleet.proposal span with correct attributes', async () => {
    seedProposal('prop-test-000001-abcd', {
      status: 'pending',
      engineModel: 'claude:claude-sonnet-4-6',
      repo: '/Users/test/my-repo',
      createdAt: '2026-06-01T12:00:00.000Z',
    });

    const { buildFleetSpans } = await getPulseExport();
    const spans = buildFleetSpans().resourceSpans[0]!.scopeSpans[0]!.spans;
    const propSpan = spans.find((s) => s.name === 'fleet.proposal');
    expect(propSpan).toBeDefined();

    const attrMap: Record<string, unknown> = {};
    for (const a of propSpan!.attributes) {
      attrMap[a.key] = 'stringValue' in a.value ? a.value.stringValue : a.value.intValue;
    }

    expect(attrMap['ashlr.source']).toBe('ashlr-fleet');
    expect(attrMap['gen_ai.system']).toBe('claude');
    expect(attrMap['ashlr.fleet.event']).toBe('proposal');
    expect(attrMap['ashlr.fleet.repo']).toBe('my-repo');
    expect(attrMap['ashlr.fleet.outcome']).toBe('pending');
    expect(attrMap['ashlr.fleet.ref_id']).toBe('prop-test-000001-abcd');
  });

  it('maps applied status to fleet.merge', async () => {
    seedAuthenticatedRealizedProposal(
      'prop-applied-000001-abcd',
      '2026-06-01T13:05:00.000Z',
    );

    const { buildFleetSpans } = await getPulseExport();
    const spans = buildFleetSpans().resourceSpans[0]!.scopeSpans[0]!.spans;
    const mergeSpan = spans.find((s) => s.name === 'fleet.merge');
    expect(mergeSpan).toBeDefined();
    const attrMap: Record<string, unknown> = {};
    for (const a of mergeSpan!.attributes) {
      attrMap[a.key] = 'stringValue' in a.value ? a.value.stringValue : a.value.intValue;
    }
    expect(attrMap['ashlr.fleet.outcome']).toBe('merged');
    expect(mergeSpan!.startTimeUnixNano).toBe(String(Date.parse('2026-06-01T13:05:00.000Z') * 1_000_000));
  });

  it('does not project authenticated evidence with a future observation time as landed', async () => {
    seedAuthenticatedRealizedProposal(
      'prop-applied-future-0001',
      '2099-06-01T13:05:00.000Z',
    );

    const { buildFleetSpans } = await getPulseExport();
    const spans = buildFleetSpans().resourceSpans[0]!.scopeSpans[0]!.spans;
    expect(spans.some((span) => span.name === 'fleet.merge')).toBe(false);
  });

  it('keeps applied-without-witness visible as proposal lifecycle activity', async () => {
    seedProposal('prop-applied-legacy-0001', {
      status: 'applied',
      createdAt: '2026-06-01T13:00:00.000Z',
    });

    const { buildFleetSpans } = await getPulseExport();
    const spans = buildFleetSpans().resourceSpans[0]!.scopeSpans[0]!.spans;
    const lifecycle = spans.find((span) => span.name === 'fleet.proposal');
    expect(lifecycle).toBeDefined();
    const attrs = Object.fromEntries(lifecycle!.attributes.map((attr) => [
      attr.key,
      'stringValue' in attr.value ? attr.value.stringValue : attr.value.intValue,
    ]));
    expect(attrs['ashlr.fleet.outcome']).toBe('applied');
    expect(spans.some((span) => span.name === 'fleet.merge')).toBe(false);
  });

  it('maps rejected status to fleet.decline', async () => {
    seedProposal('prop-rejected-000001-abcd', {
      status: 'rejected',
      createdAt: '2026-06-01T14:00:00.000Z',
      decidedAt: '2026-06-01T14:10:00.000Z',
    });

    const { buildFleetSpans } = await getPulseExport();
    const spans = buildFleetSpans().resourceSpans[0]!.scopeSpans[0]!.spans;
    const declineSpan = spans.find((s) => s.name === 'fleet.decline');
    expect(declineSpan).toBeDefined();
    const attrMap: Record<string, unknown> = {};
    for (const a of declineSpan!.attributes) {
      attrMap[a.key] = 'stringValue' in a.value ? a.value.stringValue : a.value.intValue;
    }
    expect(attrMap['ashlr.fleet.outcome']).toBe('rejected');
  });
});

// ---------------------------------------------------------------------------
// 4. Deterministic spanId
// ---------------------------------------------------------------------------

describe('buildFleetSpans — deterministic spanId', () => {
  it('produces the same spanId for the same ref_id + event across two calls', async () => {
    seedDaemonState([
      {
        ts: '2026-06-01T09:00:00.000Z',
        itemsConsidered: 1,
        proposalsCreated: 1,
        spentUsd: 0.001,
        reason: 'ok',
      },
    ]);

    const { buildFleetSpans } = await getPulseExport();
    const spans1 = buildFleetSpans().resourceSpans[0]!.scopeSpans[0]!.spans;
    const spans2 = buildFleetSpans().resourceSpans[0]!.scopeSpans[0]!.spans;

    const tick1 = spans1.find((s) => s.name === 'fleet.tick');
    const tick2 = spans2.find((s) => s.name === 'fleet.tick');

    expect(tick1).toBeDefined();
    expect(tick2).toBeDefined();
    expect(tick1!.spanId).toBe(tick2!.spanId);
    // 16 hex chars = 8 bytes
    expect(tick1!.spanId).toMatch(/^[0-9a-f]{16}$/);
    // traceId = 32 hex chars = 16 bytes
    expect(tick1!.traceId).toMatch(/^[0-9a-f]{32}$/);
  });

  it('emits one authenticated proposal merge despite duplicate tick merge aggregates', async () => {
    seedDaemonState([
      {
        ts: '2026-06-02T08:00:00.000Z',
        itemsConsidered: 1,
        proposalsCreated: 1,
        spentUsd: 0.001,
        reason: 'ok',
        merged: 1,
      },
      {
        ts: '2026-06-02T08:01:00.000Z',
        itemsConsidered: 1,
        proposalsCreated: 0,
        spentUsd: 0,
        reason: 'ok',
        merged: 1,
      },
    ]);
    seedAuthenticatedRealizedProposal(
      'prop-dedup-merge-0001',
      '2026-06-02T08:02:00.000Z',
      '2026-06-01T13:00:00.000Z',
    );

    const { buildFleetSpans } = await getPulseExport();
    const spans = buildFleetSpans().resourceSpans[0]!.scopeSpans[0]!.spans;
    expect(spans.filter((s) => s.name === 'fleet.tick')).toHaveLength(2);
    expect(spans.filter((s) => s.name === 'fleet.merge')).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 5. sinceTs filter
// ---------------------------------------------------------------------------

describe('buildFleetSpans — sinceTs filter', () => {
  it('excludes ticks before sinceTs', async () => {
    seedDaemonState([
      { ts: '2026-05-01T00:00:00.000Z', itemsConsidered: 0, proposalsCreated: 0, spentUsd: 0, reason: 'ok' },
      { ts: '2026-06-15T00:00:00.000Z', itemsConsidered: 1, proposalsCreated: 0, spentUsd: 0, reason: 'ok' },
    ]);

    const { buildFleetSpans } = await getPulseExport();
    const spans = buildFleetSpans('2026-06-01T00:00:00.000Z').resourceSpans[0]!.scopeSpans[0]!.spans;

    // Only the June tick should be present
    expect(spans).toHaveLength(1);
    const attrMap: Record<string, unknown> = {};
    for (const a of spans[0]!.attributes) {
      attrMap[a.key] = 'stringValue' in a.value ? a.value.stringValue : a.value.intValue;
    }
    expect(attrMap['ashlr.fleet.ref_id']).toBe('2026-06-15T00:00:00.000Z');
  });

  it('drops malformed and future tick timestamps, including merge aggregates', async () => {
    seedDaemonState([
      { ts: 'not-a-time', itemsConsidered: 0, proposalsCreated: 0, spentUsd: 0, reason: 'ok', merged: 9 },
      { ts: '2099-01-01T00:00:00.000Z', itemsConsidered: 0, proposalsCreated: 0, spentUsd: 0, reason: 'ok', merged: 9 },
    ]);

    const { buildFleetSpans } = await getPulseExport();
    const spans = buildFleetSpans().resourceSpans[0]!.scopeSpans[0]!.spans;
    expect(spans).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 6. exportToPulse — no-op when PAT missing
// ---------------------------------------------------------------------------

describe('exportToPulse — no-op safety', () => {
  it('does not throw when ASHLR_PULSE_PAT is absent', async () => {
    delete process.env['ASHLR_PULSE_PAT'];
    const { exportToPulse } = await getPulseExport();
    await expect(
      exportToPulse({ pulse: { enabled: true, endpoint: 'http://localhost:9999' } }),
    ).resolves.toBeDefined(); // returns boolean (false when no-op)
  });

  it('does not throw when cfg.pulse.enabled is false', async () => {
    process.env['ASHLR_PULSE_PAT'] = 'test-pat';
    const { exportToPulse } = await getPulseExport();
    await expect(
      exportToPulse({ pulse: { enabled: false, endpoint: 'http://localhost:9999' } }),
    ).resolves.toBeDefined();
  });

  it('does not throw when cfg.pulse is absent', async () => {
    process.env['ASHLR_PULSE_PAT'] = 'test-pat';
    const { exportToPulse } = await getPulseExport();
    // AshlrConfig without pulse field — cast to satisfy type
    await expect(exportToPulse({} as never)).resolves.toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// 7. exportToPulse — never throws on unreachable endpoint (mock fetch)
// ---------------------------------------------------------------------------

describe('exportToPulse — network resilience', () => {
  it('does not throw when fetch rejects (unreachable endpoint)', async () => {
    process.env['ASHLR_PULSE_PAT'] = 'test-pat';

    // Mock global fetch to simulate network failure
    const mockFetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    vi.stubGlobal('fetch', mockFetch);

    const { exportToPulse } = await getPulseExport();
    await expect(
      exportToPulse({ pulse: { enabled: true, endpoint: 'http://localhost:9999' } }),
    ).resolves.toBeDefined(); // returns false on failure, never throws
  });

  it('does not throw when fetch returns a non-2xx status', async () => {
    process.env['ASHLR_PULSE_PAT'] = 'test-pat';

    const mockFetch = vi.fn().mockResolvedValue(
      new Response('Unauthorized', { status: 401 }),
    );
    vi.stubGlobal('fetch', mockFetch);

    const { exportToPulse } = await getPulseExport();
    await expect(
      exportToPulse({ pulse: { enabled: true, endpoint: 'http://localhost:9999' } }),
    ).resolves.toBeDefined();
  });

  it('POSTs to /api/otlp/v1/traces with correct headers when PAT is set', async () => {
    process.env['ASHLR_PULSE_PAT'] = 'secret-pat-value';

    const mockFetch = vi.fn().mockResolvedValue(
      new Response('{}', { status: 200 }),
    );
    vi.stubGlobal('fetch', mockFetch);

    seedDaemonState([
      { ts: '2026-06-01T10:00:00.000Z', itemsConsidered: 1, proposalsCreated: 1, spentUsd: 0.001, reason: 'ok' },
    ]);

    const { exportToPulse } = await getPulseExport();
    await exportToPulse({ pulse: { enabled: true, endpoint: 'http://localhost:9999' } });

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://localhost:9999/api/otlp/v1/traces');
    expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer secret-pat-value');
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');

    // Verify body is valid OTLP JSON with correct shape
    const body = JSON.parse(init.body as string) as { resourceSpans: unknown[] };
    expect(body).toHaveProperty('resourceSpans');
    expect(Array.isArray(body.resourceSpans)).toBe(true);

    // PAT must NOT appear in the body or URL
    expect(init.body as string).not.toContain('secret-pat-value');
    expect(url).not.toContain('secret-pat-value');
  });

  it('dry-run does not call fetch', async () => {
    process.env['ASHLR_PULSE_PAT'] = 'test-pat';

    const mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);

    const { exportToPulse } = await getPulseExport();
    // Capture stdout
    const written: string[] = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    vi.spyOn(process.stdout, 'write').mockImplementation((s) => { written.push(String(s)); return true; });

    await exportToPulse({ pulse: { enabled: true } }, { dryRun: true });

    expect(mockFetch).not.toHaveBeenCalled();
    const out = written.join('');
    const parsed = JSON.parse(out) as { resourceSpans: unknown[] };
    expect(parsed).toHaveProperty('resourceSpans');

    vi.restoreAllMocks();
    void origWrite;
  });
});
