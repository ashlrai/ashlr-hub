/**
 * M29 CLI tests — `ashlr digest` (cmdDigest).
 *
 * SAFETY GUARDRAILS (mirrors the M26/M27/M28 test discipline):
 *  - HOME is overridden to a tmp dir so NO real ~/.ashlr state is touched.
 *  - buildDigest is MOCKED to return a deterministic DigestReport — no real
 *    snapshot, no enrolled-repo scan, no model.
 *  - notify is MOCKED (spied) — NEVER a real webhook POST. The spy asserts the
 *    NO-OUTWARD-BY-DEFAULT invariant: notify is reached ONLY behind --notify.
 *  - deliverDigest is MOCKED to write a real LOCAL artifact under the tmp HOME's
 *    ~/.ashlr/digests/ (proving "writes a local digest") and to invoke the
 *    notify spy ONLY when opts.notify === true (proving the opt-in gate). It
 *    NEVER mutates a repo, never writes config, never applies a proposal.
 *  - getActiveClient is SPIED to throw — the default path must NEVER construct a
 *    client, proving LOCAL-FIRST (zero cloud calls with --allow-cloud off).
 *
 * Coverage (the four required cases + invariant proofs):
 *  - default run: writes a LOCAL digest artifact, PRINTS it, does NOT notify.
 *  - --notify: triggers EXACTLY ONE notify attempt; default path triggers zero.
 *  - --allow-cloud OFF: no cloud/model client is ever constructed.
 *  - --json: emits valid JSON (the DigestReport) and writes nothing extra.
 *  - bad usage / help exit codes.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type {
  DigestReport,
  DigestDeliveryResult,
  PortfolioSummary,
} from '../src/core/types.js';

// ---------------------------------------------------------------------------
// HOME isolation — before any module resolves homedir().
// ---------------------------------------------------------------------------

const origHome = process.env.HOME;

let tmpHome: string;

function digestsDirPath(): string {
  return path.join(tmpHome, '.ashlr', 'digests');
}

// ---------------------------------------------------------------------------
// Deterministic fixtures.
// ---------------------------------------------------------------------------

function fixturePortfolio(): PortfolioSummary {
  return {
    health: {
      reposScored: 2,
      averageScore: 72,
      averageGrade: 'C',
      worstRepos: [{ repo: '/tmp/repo-a', score: 55, grade: 'F' }],
    },
    goalsInFlight: [
      {
        goalId: 'g1',
        objective: 'Ship the new auth flow',
        status: 'active',
        fractionDone: 0.5,
        proposed: 1,
        totalMilestones: 2,
        nextActionable: 'Wire the callback',
      },
    ],
    backlogTop: [{ title: 'Fix flaky test', repo: '/tmp/repo-a', score: 88 }],
    cost: { window: '7d', spentUsd: 1.2345, localSavingsUsd: 0.5, projectedMonthlyUsd: 5.29 },
    effectiveness: { successRate: 0.8, effectivenessDeltaPct: 2.5, headline: 'Effectiveness up 2.5 pts' },
    today: {
      previousAt: null,
      pendingProposalsDelta: null,
      dirtyReposDelta: null,
      spendUsdDelta: null,
      healthScoreDelta: null,
      goalsInFlightDelta: null,
    },
  };
}

function fixtureReport(window: '7d' | '30d' = '7d'): DigestReport {
  return {
    generatedAt: '2026-06-10T12:00:00.000Z',
    date: '2026-06-10',
    window,
    portfolio: fixturePortfolio(),
    repos: { total: 3, dirty: 1, stale: 0 },
    pendingProposals: 2,
    daemon: { running: true, todaySpentUsd: 0.42 },
    headline: 'Today: 3 repos, 2 pending proposals, $1.2345 spent.',
  };
}

// ---------------------------------------------------------------------------
// Mocks — declared before the lazy core imports happen inside cmdDigest.
// ---------------------------------------------------------------------------

// notify spy: NEVER posts. Returns false (the strict no-op default for an
// unconfigured webhook) unless a test opts it into "configured" success.
const mockNotify = vi.fn(async (_text: string, _cfg: unknown) => false);

vi.mock('../src/core/integrations/notify.js', () => ({
  notify: (...args: unknown[]) => mockNotify(args[0] as string, args[1]),
}));

// getActiveClient spy: the default path must NEVER construct a client.
const mockGetActiveClient = vi.fn(async () => {
  throw new Error('getActiveClient must NOT be called on the default (local-first) path');
});

vi.mock('../src/core/run/provider-client.js', () => ({
  getActiveClient: (...args: unknown[]) => mockGetActiveClient(...args),
}));

// buildDigest mock: deterministic report; never touches disk / model / repos.
const mockBuildDigest = vi.fn(
  async (_cfg: unknown, opts?: { window?: '7d' | '30d'; allowCloud?: boolean }) =>
    fixtureReport(opts?.window ?? '7d'),
);

vi.mock('../src/core/digest/build.js', () => ({
  buildDigest: (...args: unknown[]) =>
    mockBuildDigest(args[0], args[1] as { window?: '7d' | '30d'; allowCloud?: boolean } | undefined),
}));

// deliverDigest mock: ALWAYS writes a real LOCAL artifact under the tmp HOME's
// digests dir (proving "writes a local digest"), and invokes the notify spy
// ONLY when opts.notify === true (the opt-in gate — exactly as the real
// deliver.ts must). It NEVER mutates a repo / config / proposal.
const mockDeliverDigest = vi.fn(
  async (
    report: DigestReport,
    cfg: unknown,
    opts?: { notify?: boolean },
  ): Promise<DigestDeliveryResult> => {
    const dir = digestsDirPath();
    fs.mkdirSync(dir, { recursive: true });
    const stem = String(Date.parse(report.generatedAt));
    const jsonPath = path.join(dir, `${stem}.json`);
    const markdownPath = path.join(dir, `${stem}.md`);
    fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2) + '\n', 'utf8');
    fs.writeFileSync(markdownPath, `# ${report.headline}\n`, 'utf8');
    let notified = false;
    // The SINGLE outward path — reached ONLY behind the explicit opt-in flag.
    if (opts?.notify === true) {
      const { notify } = await import('../src/core/integrations/notify.js');
      notified = await notify(report.headline, cfg as never);
    }
    return { jsonPath, markdownPath, notified };
  },
);

vi.mock('../src/core/digest/deliver.js', () => ({
  deliverDigest: (...args: unknown[]) =>
    mockDeliverDigest(
      args[0] as DigestReport,
      args[1],
      args[2] as { notify?: boolean } | undefined,
    ),
  renderDigestText: (r: DigestReport) => `# ${r.headline}\n`,
}));

// ---------------------------------------------------------------------------
// Import after mocks.
// ---------------------------------------------------------------------------

import { cmdDigest } from '../src/cli/digest.js';

// ---------------------------------------------------------------------------
// stdout/stderr capture.
// ---------------------------------------------------------------------------

let stdout = '';
let stderr = '';
let outSpy: ReturnType<typeof vi.spyOn>;
let errSpy: ReturnType<typeof vi.spyOn>;

function captureIO(): void {
  stdout = '';
  stderr = '';
  outSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    stdout += String(chunk);
    return true;
  });
  errSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
    stderr += String(chunk);
    return true;
  });
}

function restoreIO(): void {
  outSpy?.mockRestore();
  errSpy?.mockRestore();
}

/** Files written under the tmp HOME's ~/.ashlr/digests/, or [] when none. */
function digestArtifacts(): string[] {
  const dir = digestsDirPath();
  return fs.existsSync(dir) ? fs.readdirSync(dir) : [];
}

// ---------------------------------------------------------------------------
// Lifecycle.
// ---------------------------------------------------------------------------

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-m29-home-'));
  process.env.HOME = tmpHome;
  mockNotify.mockReset();
  mockNotify.mockResolvedValue(false); // strict no-op default (unconfigured)
  mockGetActiveClient.mockClear();
  mockBuildDigest.mockClear();
  mockDeliverDigest.mockClear();
});

afterEach(() => {
  restoreIO();
  process.env.HOME = origHome;
  try {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

// ---------------------------------------------------------------------------
// Tests.
// ---------------------------------------------------------------------------

describe('cmdDigest — default path (local write, NO outward call)', () => {
  it('writes a LOCAL digest artifact, prints it, and does NOT notify', async () => {
    captureIO();
    const code = await cmdDigest([]);
    expect(code).toBe(0);

    // A local artifact was written under ~/.ashlr/digests/ (json + md).
    const files = digestArtifacts();
    expect(files.some((f) => f.endsWith('.json'))).toBe(true);
    expect(files.some((f) => f.endsWith('.md'))).toBe(true);

    // It printed the digest (headline is present in human output).
    expect(stdout).toContain('Today: 3 repos');
    expect(stdout).toMatch(/Saved/);

    // CRITICAL: the default path is NO-OUTWARD — notify was NEVER reached.
    expect(mockNotify).not.toHaveBeenCalled();
    // And it built + delivered exactly once each.
    expect(mockBuildDigest).toHaveBeenCalledTimes(1);
    expect(mockDeliverDigest).toHaveBeenCalledTimes(1);
    // deliverDigest was called with notify:false (opt-out by default).
    const opts = mockDeliverDigest.mock.calls[0]![2] as { notify?: boolean };
    expect(opts.notify).toBe(false);
  });

  it('default build uses the 7d window, narrative:false, allowCloud:false', async () => {
    captureIO();
    await cmdDigest([]);
    const opts = mockBuildDigest.mock.calls[0]![1] as { window?: string; narrative?: boolean; allowCloud?: boolean };
    expect(opts.window).toBe('7d');
    expect(opts.narrative).toBe(false);
    expect(opts.allowCloud).toBe(false);
  });

  it('--narrative is threaded into buildDigest as narrative:true', async () => {
    captureIO();
    await cmdDigest(['--narrative']);
    const opts = mockBuildDigest.mock.calls[0]![1] as { narrative?: boolean; allowCloud?: boolean };
    expect(opts.narrative).toBe(true);
    expect(opts.allowCloud).toBe(false);
  });
});

describe('cmdDigest — --notify (OPT-IN outward path)', () => {
  it('triggers EXACTLY ONE notify attempt', async () => {
    captureIO();
    const code = await cmdDigest(['--notify']);
    expect(code).toBe(0);

    // The single outward path was reached exactly once.
    expect(mockNotify).toHaveBeenCalledTimes(1);
    const opts = mockDeliverDigest.mock.calls[0]![2] as { notify?: boolean };
    expect(opts.notify).toBe(true);
  });

  it('surfaces a no-op note when --notify is set but no webhook is configured', async () => {
    mockNotify.mockResolvedValue(false); // unconfigured => strict no-op
    captureIO();
    await cmdDigest(['--notify']);
    // notify() was attempted but returned false (nothing sent).
    expect(mockNotify).toHaveBeenCalledTimes(1);
    expect(stdout).toMatch(/no webhook is configured|nothing was sent/i);
  });

  it('reports delivery when a webhook is configured and notify succeeds', async () => {
    mockNotify.mockResolvedValue(true); // simulate a configured + reachable webhook
    captureIO();
    await cmdDigest(['--notify']);
    expect(mockNotify).toHaveBeenCalledTimes(1);
    expect(stdout).toMatch(/delivered/i);
  });
});

describe('cmdDigest — --allow-cloud OFF makes no cloud call', () => {
  it('never constructs a model client on the default path', async () => {
    captureIO();
    const code = await cmdDigest([]);
    expect(code).toBe(0);
    // LOCAL-FIRST: the CLI itself never touches getActiveClient (the optional
    // narrative lives in buildDigest, which is mocked here). The default path
    // makes ZERO cloud calls.
    expect(mockGetActiveClient).not.toHaveBeenCalled();
  });

  it('prints a privacy warning ONLY when --narrative + --allow-cloud are both set (human mode)', async () => {
    captureIO();
    const code = await cmdDigest(['--narrative', '--allow-cloud']);
    expect(code).toBe(0);
    expect(stderr).toMatch(/--allow-cloud are set|cloud model/);
    // Both flags are threaded into buildDigest.
    const opts = mockBuildDigest.mock.calls[0]![1] as { narrative?: boolean; allowCloud?: boolean };
    expect(opts.narrative).toBe(true);
    expect(opts.allowCloud).toBe(true);
    // Still NO outward webhook call without --notify.
    expect(mockNotify).not.toHaveBeenCalled();
  });

  it('--allow-cloud alone (no --narrative) prints NO cloud-model warning', async () => {
    captureIO();
    const code = await cmdDigest(['--allow-cloud']);
    expect(code).toBe(0);
    // No narrative requested => allow-cloud is inert => no cloud-model warning.
    expect(stderr).not.toMatch(/cloud model/);
    expect(mockNotify).not.toHaveBeenCalled();
  });
});

describe('cmdDigest — --json', () => {
  it('emits valid JSON (the DigestReport) on stdout', async () => {
    captureIO();
    const code = await cmdDigest(['--json']);
    expect(code).toBe(0);

    // stdout is exactly one JSON line — parseable and the right shape.
    const parsed = JSON.parse(stdout.trim()) as DigestReport;
    expect(parsed.date).toBe('2026-06-10');
    expect(parsed.window).toBe('7d');
    expect(parsed.headline).toContain('Today: 3 repos');
    expect(parsed.portfolio.health.reposScored).toBe(2);

    // The local artifact was still written; the human banner was NOT printed.
    expect(digestArtifacts().some((f) => f.endsWith('.json'))).toBe(true);
    expect(stdout).not.toMatch(/Saved/);
    // --json + no --notify => no privacy warning, no outward call.
    expect(mockNotify).not.toHaveBeenCalled();
  });

  it('respects --window 30d in the JSON payload', async () => {
    captureIO();
    const code = await cmdDigest(['--json', '--window', '30d']);
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout.trim()) as DigestReport;
    expect(parsed.window).toBe('30d');
  });
});

describe('cmdDigest — usage / help', () => {
  it('--help returns 0 and prints usage', async () => {
    captureIO();
    const code = await cmdDigest(['--help']);
    expect(code).toBe(0);
    expect(stdout).toMatch(/ashlr digest/);
    // Help must not build/deliver/notify anything.
    expect(mockBuildDigest).not.toHaveBeenCalled();
    expect(mockDeliverDigest).not.toHaveBeenCalled();
    expect(mockNotify).not.toHaveBeenCalled();
  });

  it('a bad --window value returns 2', async () => {
    captureIO();
    const code = await cmdDigest(['--window', 'yearly']);
    expect(code).toBe(2);
    expect(stderr).toMatch(/--window expects 7d or 30d/);
  });

  it('an unknown flag returns 2', async () => {
    captureIO();
    const code = await cmdDigest(['--frobnicate']);
    expect(code).toBe(2);
    expect(stderr).toMatch(/Unknown flag/);
  });
});
