/**
 * V3.10 Track B unit U4 — the post-merge watch (src/core/fleet/post-merge-watch.ts).
 *
 * SPEC-310B §7 key tests for U4:
 *   - red → revert + quarantine + repair task;
 *   - only fleet commits are reverted;
 *   - the escalation ladder (second quarantine in 7 d → owner-hold; 2 repos
 *     red in 6 h → kill);
 *   - 3 reverts in 24 h → kill;
 *   - failed revert → halt (owner-hold + global soft kill + halt record).
 * Plus the honesty rules: nothing ledgered while a watch is pending, no
 * evidence at the deadline is RED ("unproven"), inherited red never reverts,
 * a flaky suite must fail twice, a red revert is never reverted.
 *
 * Hermetic: every outward dependency (GitHub, the suite, U3's revert lander,
 * U5's task queue, the kill switch) is injected. The watch store and the
 * REAL hold store (fleet/quarantine.ts) live under the isolated HOME
 * (test/setup/home.ts); the authority ledger is mocked for the hold store's
 * own appends (B-U1 builds it in parallel).
 */
import { mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { LedgerReadResult } from '../src/core/authority/types.js';
import type {
  FleetTask,
  FleetTaskInput,
  LandingRecord,
  PostMergeResult,
} from '../src/core/fleet/fleet-types.js';

const holdLedger: { kind: string; data: unknown }[] = [];
vi.mock('../src/core/authority/ledger.js', () => ({
  appendLedger: (input: { kind: string; data: unknown }) => {
    holdLedger.push(input);
    return { ok: true, entry: input };
  },
  readLedger: async () => { throw new Error('not implemented (test)'); },
  currentLedgerHead: () => null,
}));
vi.mock('../src/core/authority/effective-config.js', () => ({
  currentStandingPolicy: () => null,
}));
// Partial mock (importOriginal): sandbox/confine.ts and autonomous-env.ts read
// the real CUSTODY_DATA_DIR_RELATIVE / CUSTODY_HELPER_PATH at module load.
vi.mock('../src/core/authority/custody-client.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/core/authority/custody-client.js')>()),
  githubToken: async () => ({ token: 'ghs_testtoken_not_real', expiresAt: null }),
}));
// By default U3's landFleetRevert is absent in this fixture (the default lander
// must say so and escalate); a test can install one through `hostMerge.lander`.
const hostMerge = vi.hoisted(() => ({
  lander: undefined as undefined | ((...args: unknown[]) => unknown),
  // R3b: the production soft kill revokes armed merges through
  // authority/clamp.ts revokeArmedMerges → this export (dynamic import).
  revokeCalls: [] as string[],
}));
vi.mock('../src/core/fleet/host-merge.js', () => ({
  closeFleetPr: async () => { throw new Error('unused'); },
  reopenFleetPr: async () => { throw new Error('unused'); },
  get landFleetRevert() {
    return hostMerge.lander;
  },
  revokeArmedHostMerges: (reason: string) => {
    hostMerge.revokeCalls.push(reason);
    return { revoked: 1, failed: [] };
  },
}));

const watch = await import('../src/core/fleet/post-merge-watch.js');
const { authorityStateDir, listRepoHolds } = await import('../src/core/fleet/quarantine.js');
const {
  advancePostMergeWatches,
  classifyCi,
  fleetRevertRefusal,
  githubCiStatus,
  landRevertViaHostMerge,
  listPostMergeWatches,
  postMergeGreenPct,
  postMergeWatchPath,
  registerLanding,
  FLEET_BOT_LOGIN,
} = watch;
type Deps = import('../src/core/fleet/post-merge-watch.js').PostMergeWatchDeps;
type CiObservation = import('../src/core/fleet/post-merge-watch.js').CiObservation;
type SuiteRun = import('../src/core/fleet/post-merge-watch.js').SuiteRun;
type CommitInfo = import('../src/core/fleet/post-merge-watch.js').CommitInfo;
type FleetRevertOutcome = import('../src/core/fleet/post-merge-watch.js').FleetRevertOutcome;
type FleetRevertRequest = import('../src/core/fleet/post-merge-watch.js').FleetRevertRequest;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const MIN = 60_000;
const H = 60 * MIN;
const T0 = Date.parse('2026-09-24T10:00:00.000Z');
const at = (ms: number): string => new Date(ms).toISOString();
const sha = (c: string): string => c.repeat(40);
const GRANT = '0123456789abcdef0123456789abcdef';

function landing(over: Partial<LandingRecord> = {}): LandingRecord {
  const repo = over.repo ?? 'ashlrai/ashlrcode';
  const pr = over.prNumber ?? 12;
  const mergeSha = over.mergeSha ?? sha('a');
  return {
    v: 1,
    id: `${repo}#${pr}@${mergeSha.slice(0, 12)}`,
    kind: 'merge',
    repo,
    baseBranch: 'main',
    prNumber: pr,
    headSha: sha('c'),
    mergeSha,
    proposalId: 'prop-1',
    revertsLandingId: null,
    grantId: GRANT,
    rolloutStageId: '2a',
    gatesDigest: 'd'.repeat(64),
    ledgerHead: 'e'.repeat(64),
    enforcement: 'server',
    risk: 'low',
    files: 2,
    linesAdded: 10,
    linesDeleted: 1,
    producer: { engine: 'local-coder', model: 'qwen', family: 'local', seatId: null },
    judgeId: 'grok-cli:grok-4',
    proposedAt: at(T0 - 30 * MIN),
    landedAt: at(T0),
    watchUntil: at(T0 + 2 * H),
    ...over,
  };
}

function fleetCommit(l: LandingRecord, parent = sha('b'), over: Partial<CommitInfo> = {}): CommitInfo {
  return {
    sha: l.mergeSha,
    parents: [parent],
    authorLogin: FLEET_BOT_LOGIN,
    authorName: 'ashlr-fleet[bot]',
    authorEmail: '123+ashlr-fleet[bot]@users.noreply.github.com',
    message: `fix: tidy (#${l.prNumber})\n\nAshlr-Grant: ${l.grantId}\nAshlr-Gates: ${l.gatesDigest}\nAshlr-Ledger-Head: ${l.ledgerHead}\n`,
    ...over,
  };
}

const GREEN: CiObservation = { state: 'green', failing: [], detail: '3 check(s) green' };
const PENDING: CiObservation = { state: 'pending', failing: [], detail: '1 check(s) still running' };
const redCi = (...names: string[]): CiObservation => ({ state: 'red', failing: names, detail: `CI failing: ${names.join(', ')}` });
const PASS: SuiteRun = { result: 'pass', detail: 'green', commandsRun: 3 };
const FAIL: SuiteRun = { result: 'fail', detail: '`npm test` failed: expected 1 to be 2', commandsRun: 2 };
const NOT_RUN: SuiteRun = { result: 'not-run', detail: 'no fleet mirror', commandsRun: 0 };

interface Harness {
  deps: Partial<Deps>;
  now: { ms: number };
  ci: Map<string, CiObservation>;
  suite: Map<string, SuiteRun[]>;
  commits: Map<string, CommitInfo>;
  ledger: { kind: string; data: unknown }[];
  landRevert: ReturnType<typeof vi.fn>;
  enqueue: ReturnType<typeof vi.fn>;
  softKill: ReturnType<typeof vi.fn>;
  recordHalt: ReturnType<typeof vi.fn>;
  killOn: { v: boolean };
  ledgerUp: { v: boolean };
}

function revertOf(l: LandingRecord, revertSha = sha('f')): LandingRecord {
  return {
    ...l,
    id: `${l.repo}#${l.prNumber + 100}@${revertSha.slice(0, 12)}`,
    kind: 'revert',
    prNumber: l.prNumber + 100,
    headSha: sha('9'),
    mergeSha: revertSha,
    proposalId: null,
    revertsLandingId: l.id,
    producer: null,
    judgeId: null,
    landedAt: at(T0 + 10 * MIN),
    watchUntil: at(T0 + 10 * MIN + 2 * H),
  };
}

function harness(): Harness {
  const h: Harness = {
    deps: {},
    now: { ms: T0 + 20 * MIN },
    ci: new Map(),
    suite: new Map(),
    commits: new Map(),
    ledger: [],
    landRevert: vi.fn(async (req: FleetRevertRequest): Promise<FleetRevertOutcome> => ({ ok: true, landing: revertOf(req.landing) })),
    enqueue: vi.fn((input: FleetTaskInput) => ({ ok: true as const, deduped: false, task: { id: `task-${input.landingId}` } as FleetTask })),
    softKill: vi.fn((reason: string) => ({ ok: true, changed: true, reason })),
    recordHalt: vi.fn(),
    killOn: { v: false },
    ledgerUp: { v: true },
  };
  // Reverts (revertOf's default SHA) verify green unless a test says otherwise.
  h.ci.set(sha('f'), GREEN);
  h.suite.set(sha('f'), [PASS]);
  h.deps = {
    now: () => h.now.ms,
    ciStatus: async (_repo, s) => h.ci.get(s) ?? { state: 'unknown', failing: [], detail: 'no fixture' },
    readCommit: async (_repo, s) => h.commits.get(s) ?? null,
    runSuiteAt: async (_repo, s) => {
      const queue = h.suite.get(s);
      if (!queue || queue.length === 0) return NOT_RUN;
      return queue.length === 1 ? queue[0]! : queue.shift()!;
    },
    landRevert: h.landRevert as unknown as Deps['landRevert'],
    enqueueRepairTask: h.enqueue as unknown as Deps['enqueueRepairTask'],
    softKill: h.softKill as unknown as Deps['softKill'],
    killActive: () => h.killOn.v,
    appendLedger: (input) => {
      if (!h.ledgerUp.v) return { ok: false, reason: 'ledger offline (test)' };
      h.ledger.push({ kind: input.kind, data: input.data });
      return { ok: true };
    },
    readLedger: undefined,
    recordHalt: h.recordHalt as unknown as Deps['recordHalt'],
  };
  return h;
}

const kinds = (h: Harness): string[] => h.ledger.map((r) => r.kind);
const results = (h: Harness): PostMergeResult[] =>
  h.ledger.filter((r) => r.kind === 'post-merge:result').map((r) => r.data as PostMergeResult);
const holdKinds = (repo: string, nowMs: number): string[] =>
  listRepoHolds({ nowMs }).filter((x) => x.repo === repo).map((x) => x.kind).sort();

beforeEach(() => {
  holdLedger.length = 0;
  hostMerge.revokeCalls.length = 0;
  rmSync(authorityStateDir(), { recursive: true, force: true });
});
afterEach(() => {
  rmSync(authorityStateDir(), { recursive: true, force: true });
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Pure pieces
// ---------------------------------------------------------------------------

describe('classifyCi', () => {
  it('red beats pending beats cancelled beats green; stale is ignored; nothing is none', () => {
    expect(classifyCi([], []).state).toBe('none');
    expect(classifyCi([{ name: 'test', status: 'completed', conclusion: 'success' }], []).state).toBe('green');
    expect(classifyCi([{ name: 't', status: 'completed', conclusion: 'skipped' }, { name: 's', status: 'completed', conclusion: 'stale' }], []).state).toBe('green');
    expect(classifyCi([{ name: 't', status: 'in_progress', conclusion: null }, { name: 'u', status: 'completed', conclusion: 'success' }], []).state).toBe('pending');
    expect(classifyCi([{ name: 't', status: 'completed', conclusion: 'cancelled' }, { name: 'u', status: 'completed', conclusion: 'success' }], []).state).toBe('unknown');
    const red = classifyCi(
      [{ name: 'test', status: 'completed', conclusion: 'failure' }, { name: 'lint', status: 'queued', conclusion: null }],
      [{ context: 'ci/legacy', state: 'error' }],
    );
    expect(red).toMatchObject({ state: 'red', failing: ['ci/legacy', 'test'] });
    expect(classifyCi([], [{ context: 'x', state: 'pending' }]).state).toBe('pending');
    expect(classifyCi([{ name: 't', status: 'completed', conclusion: 'timed_out' }], []).state).toBe('red');
  });
});

describe('fleetRevertRefusal — only fleet commits are ever reverted', () => {
  const l = landing();
  it('accepts the bot-authored squash commit carrying this grant', () => {
    expect(fleetRevertRefusal(fleetCommit(l), l)).toBeNull();
    // GitHub could not map the author, but the bot noreply identity matches.
    expect(fleetRevertRefusal(fleetCommit(l, sha('b'), { authorLogin: null }), l)).toBeNull();
  });
  it.each([
    ['a human author', { authorLogin: 'masonwyatt', authorEmail: 'mason@example.com' }, /not authored by ashlr-fleet\[bot\]/],
    ['an unmapped non-bot email', { authorLogin: null, authorEmail: 'someone@example.com' }, /not authored/],
    ['no Ashlr-Grant trailer', { message: 'fix: tidy\n' }, /no Ashlr-Grant trailer/],
    ['another grant', { message: 'fix\n\nAshlr-Grant: ffffffffffffffffffffffffffffffff\n' }, /does not match grant/],
    ['a trailer only mentioned mid-line', { message: 'fix: see Ashlr-Grant: x\n' }, /no Ashlr-Grant trailer/],
    ['two parents', { parents: [sha('b'), sha('c')] }, /2 parents/],
    ['a different SHA', { sha: sha('9') }, /GitHub returned/],
  ])('refuses %s', (_label, over, re) => {
    expect(fleetRevertRefusal(fleetCommit(l, sha('b'), over as Partial<CommitInfo>), l)).toMatch(re);
  });
  it('never reverts a revert', () => {
    const r = revertOf(l);
    expect(fleetRevertRefusal({ ...fleetCommit(l), sha: r.mergeSha }, r)).toMatch(/never itself reverted/);
  });
});

describe('githubCiStatus (read-only; token from custody)', () => {
  it('reads check runs + statuses, pages past 100, and never echoes the token', async () => {
    const calls: { url: string; auth: string }[] = [];
    const page = (n: number, count: number, total: number): unknown => ({
      total_count: total,
      check_runs: Array.from({ length: count }, (_, i) => ({ name: `c${n}-${i}`, status: 'completed', conclusion: n === 2 && i === 0 ? 'failure' : 'success' })),
    });
    const fetchImpl = vi.fn(async (url: string, init: { headers: Record<string, string> }) => {
      calls.push({ url, auth: init.headers['Authorization']! });
      const body = url.includes('/check-runs') ? (url.endsWith('&page=1') ? page(1, 100, 101) : page(2, 1, 101)) : { statuses: [] };
      return { ok: true, status: 200, json: async () => body };
    });
    const ci = await githubCiStatus('ashlrai/ashlrcode', sha('a'), fetchImpl);
    expect(ci).toMatchObject({ state: 'red', failing: ['c2-0'] });
    expect(calls.map((c) => c.url)).toEqual([
      `https://api.github.com/repos/ashlrai/ashlrcode/commits/${sha('a')}/check-runs?per_page=100&page=1`,
      `https://api.github.com/repos/ashlrai/ashlrcode/commits/${sha('a')}/check-runs?per_page=100&page=2`,
      `https://api.github.com/repos/ashlrai/ashlrcode/commits/${sha('a')}/status?per_page=100`,
    ]);
    expect(calls.every((c) => c.auth === 'Bearer ghs_testtoken_not_real')).toBe(true);
    expect(JSON.stringify(ci)).not.toContain('ghs_');
  });
  it('an HTTP error throws without the body (the watch reads that as unknown)', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 502, json: async () => ({ message: 'secret-ish body' }) }));
    await expect(githubCiStatus('ashlrai/ashlrcode', sha('a'), fetchImpl)).rejects.toThrow(/^GitHub answered HTTP 502$/);
    await expect(githubCiStatus('not a repo', sha('a'), fetchImpl)).rejects.toThrow(/owner\/name/);
  });
});

describe('landRevertViaHostMerge', () => {
  afterEach(() => { hostMerge.lander = undefined; });

  it('without U3\'s landFleetRevert export the answer is a NON-retryable unavailable (escalates)', async () => {
    const out = await landRevertViaHostMerge({ landing: landing(), reason: 'r', idempotencyKey: 'revert:x', actor: 'post-merge-watch' });
    expect(out).toMatchObject({ ok: false, code: 'unavailable', retryable: false });
  });

  it('calls U3\'s lander with a SHORT per-call wait so a slow CI never blocks the tick (INT3)', async () => {
    const lander = vi.fn(async () => ({ ok: false, code: 'pending', retryable: true, reason: 'checks running' }));
    hostMerge.lander = lander;
    const req = { landing: landing(), reason: 'r', idempotencyKey: 'revert:x', actor: 'post-merge-watch' as const };
    const out = await landRevertViaHostMerge(req);
    expect(out).toMatchObject({ ok: false, code: 'pending' });
    expect(lander).toHaveBeenCalledWith(req, { maxWaitMs: watch.REVERT_TICK_WAIT_MS });
    expect(watch.REVERT_TICK_WAIT_MS).toBeLessThanOrEqual(60_000);
  });
});

// ---------------------------------------------------------------------------
// Registration and the store
// ---------------------------------------------------------------------------

describe('registration and store', () => {
  it('registerLanding is idempotent and refuses malformed landings', () => {
    const l = landing();
    expect(registerLanding(l, { nowMs: T0 })).toEqual({ ok: true, registered: true });
    expect(registerLanding(l, { nowMs: T0 })).toEqual({ ok: true, registered: false });
    expect(registerLanding({ ...l, mergeSha: 'abc' }, { nowMs: T0 })).toMatchObject({ ok: false });
    expect(registerLanding({ ...l, repo: 'nope' }, { nowMs: T0 })).toMatchObject({ ok: false });
    const views = listPostMergeWatches();
    expect(views).toHaveLength(1);
    expect(views[0]).toMatchObject({ landingId: l.id, phase: 'watching', suite: 'pending', verdict: null });
    if (process.platform !== 'win32') expect(statSync(postMergeWatchPath()).mode & 0o777).toBe(0o600);
  });

  it('clamps an absurd watchUntil to 24 h and falls back to 2 h when missing', () => {
    expect(watch.effectiveWatchUntil(landing({ watchUntil: at(T0 + 90 * 24 * H) }))).toBe(at(T0 + 24 * H));
    expect(watch.effectiveWatchUntil(landing({ watchUntil: 'garbage' }))).toBe(at(T0 + 2 * H));
  });

  it('an idle pass (nothing ever landed) writes nothing at all', async () => {
    const h = harness();
    const r = await advancePostMergeWatches({ deps: h.deps });
    expect(r).toMatchObject({ ok: true, open: 0, finalized: [] });
    expect(() => statSync(postMergeWatchPath())).toThrow();
  });

  it('a corrupt store fails the pass CLOSED (the caller holds production)', async () => {
    mkdirSync(dirname(postMergeWatchPath()), { recursive: true, mode: 0o700 });
    writeFileSync(postMergeWatchPath(), '{"v":1,"watches":"nope"}', { mode: 0o600 });
    const r = await advancePostMergeWatches({ deps: harness().deps });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/malformed watch/);
    expect(() => listPostMergeWatches()).toThrow(/unknown/);
  });

  it('discovers landings from the ledger that the afterLanding hook missed, once', async () => {
    const h = harness();
    const l = landing();
    const entries = [
      { v: 1, seq: 7, at: at(T0), actor: 'daemon', grantId: GRANT, repo: l.repo, prevHash: '0'.repeat(64), hash: '1'.repeat(64), kind: 'merge:landed', data: l },
    ];
    const reads: unknown[] = [];
    h.deps.readLedger = async (o) => {
      reads.push(o);
      return { entries: (o.sinceSeq ?? 0) > 7 ? [] : entries, head: null, chain: 'ok', brokenAtSeq: null, reason: null } as unknown as LedgerReadResult;
    };
    h.ci.set(l.mergeSha, PENDING);
    h.suite.set(l.mergeSha, [PASS]);
    const first = await advancePostMergeWatches({ deps: h.deps });
    expect(first.discovered).toBe(1);
    const second = await advancePostMergeWatches({ deps: h.deps });
    expect(second.discovered).toBe(0);
    expect(reads[1]).toMatchObject({ sinceSeq: 8 });
    expect(listPostMergeWatches()).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Green paths and honesty
// ---------------------------------------------------------------------------

describe('green and pending', () => {
  it('suite pass + CI green ⇒ one green post-merge:result, no holds, no revert', async () => {
    const h = harness();
    const l = landing();
    registerLanding(l, { nowMs: T0 });
    h.ci.set(l.mergeSha, GREEN);
    h.suite.set(l.mergeSha, [PASS]);
    const r = await advancePostMergeWatches({ deps: h.deps });
    expect(r.finalized).toHaveLength(1);
    expect(results(h)).toEqual([expect.objectContaining({ landingId: l.id, verdict: 'green', ci: 'green', suite: 'pass' })]);
    expect(h.landRevert).not.toHaveBeenCalled();
    expect(listRepoHolds({ nowMs: h.now.ms })).toEqual([]);
    expect(postMergeGreenPct({ sinceMs: T0 - H, nowMs: h.now.ms })).toEqual({ finished: 1, green: 1, pct: 100 });
  });

  it('while CI is pending NOTHING is ledgered — a pending watch is never counted green', async () => {
    const h = harness();
    const l = landing();
    registerLanding(l, { nowMs: T0 });
    h.ci.set(l.mergeSha, PENDING);
    h.suite.set(l.mergeSha, [PASS]);
    const r = await advancePostMergeWatches({ deps: h.deps });
    expect(r.open).toBe(1);
    expect(h.ledger).toEqual([]);
    expect(postMergeGreenPct({ sinceMs: T0 - H, nowMs: h.now.ms }).pct).toBeNull();
    // Deadline passes with CI still pending: green on the suite's evidence, ci recorded as unknown.
    h.now.ms = T0 + 2 * H + MIN;
    await advancePostMergeWatches({ deps: h.deps });
    expect(results(h)).toEqual([expect.objectContaining({ verdict: 'green', ci: 'unknown', suite: 'pass' })]);
  });

  it('no evidence at the deadline is RED ("unproven"): quarantine, but no revert and no kill', async () => {
    const h = harness();
    const l = landing();
    registerLanding(l, { nowMs: T0 });
    h.now.ms = T0 + 3 * H;
    await advancePostMergeWatches({ deps: h.deps });
    expect(results(h)).toEqual([expect.objectContaining({ verdict: 'red', suite: 'not-run', ci: 'unknown' })]);
    expect(results(h)[0]!.detail).toMatch(/^unproven/);
    expect(holdKinds(l.repo, h.now.ms)).toEqual(['quarantine']);
    expect(h.landRevert).not.toHaveBeenCalled();
    expect(h.softKill).not.toHaveBeenCalled();
    expect(listPostMergeWatches()[0]).toMatchObject({ outcome: 'unproven', phase: 'done' });
  });

  it('flake guard: a suite that fails once then passes is green, never reverted', async () => {
    const h = harness();
    const l = landing();
    registerLanding(l, { nowMs: T0 });
    h.ci.set(l.mergeSha, GREEN);
    h.suite.set(l.mergeSha, [FAIL, PASS]);
    await advancePostMergeWatches({ deps: h.deps });
    expect(results(h)).toEqual([expect.objectContaining({ verdict: 'green' })]);
    expect(results(h)[0]!.detail).toMatch(/flake/);
    expect(h.landRevert).not.toHaveBeenCalled();
  });

  it('a single failure with no budget to confirm waits for the next pass instead of reverting', async () => {
    const h = harness();
    const l = landing();
    registerLanding(l, { nowMs: T0 });
    h.ci.set(l.mergeSha, PENDING);
    h.suite.set(l.mergeSha, [FAIL]);
    await advancePostMergeWatches({ deps: h.deps, maxSuiteRuns: 1 });
    expect(h.landRevert).not.toHaveBeenCalled();
    expect(h.ledger).toEqual([]);
    h.commits.set(l.mergeSha, fleetCommit(l));
    h.suite.set(sha('b'), [PASS]);
    await advancePostMergeWatches({ deps: h.deps, maxSuiteRuns: 2 });
    expect(h.landRevert).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Red → revert + quarantine + repair
// ---------------------------------------------------------------------------

describe('red → revert + quarantine + repair task', () => {
  it('CI red on the merge SHA (green on the parent): quarantine, revert, repair task, watch the revert', async () => {
    const h = harness();
    const l = landing();
    registerLanding(l, { nowMs: T0 });
    h.ci.set(l.mergeSha, redCi('test'));
    h.ci.set(sha('b'), GREEN);
    h.suite.set(l.mergeSha, [PASS]);
    h.commits.set(l.mergeSha, fleetCommit(l));

    const r = await advancePostMergeWatches({ deps: h.deps });

    expect(r.reverted).toEqual([l.id]);
    expect(h.landRevert).toHaveBeenCalledTimes(1);
    const req = h.landRevert.mock.calls[0]![0] as FleetRevertRequest;
    expect(req).toMatchObject({ landing: { id: l.id }, idempotencyKey: `revert:${l.id}`, actor: 'post-merge-watch' });
    expect(kinds(h)).toEqual(['post-merge:result', 'revert:landed']);
    expect(results(h)[0]).toMatchObject({ verdict: 'red', ci: 'red' });

    // Quarantine for 6 h, recorded against this landing.
    const holds = listRepoHolds({ nowMs: h.now.ms });
    expect(holds).toEqual([expect.objectContaining({ kind: 'quarantine', repo: l.repo, landingId: l.id, until: at(h.now.ms + 6 * H) })]);
    expect(listRepoHolds({ nowMs: h.now.ms + 6 * H })).toEqual([]);

    // Repair task via U5, idempotent on the landing.
    expect(h.enqueue).toHaveBeenCalledTimes(1);
    expect(h.enqueue.mock.calls[0]![0]).toMatchObject({
      repo: l.repo, source: 'repair', requestedBy: 'post-merge-watch', landingId: l.id, dedupeKey: `repair:${l.id}`,
    });
    expect(h.softKill).not.toHaveBeenCalled();

    // The revert itself is now watched.
    const views = listPostMergeWatches();
    expect(views.map((v) => [v.kind, v.phase, v.outcome])).toEqual([
      ['merge', 'done', 'reverted'],
      ['revert', 'watching', null],
    ]);
  });

  it('suite red twice at the merge SHA and green at the parent is the landing\'s fault', async () => {
    const h = harness();
    const l = landing();
    registerLanding(l, { nowMs: T0 });
    h.ci.set(l.mergeSha, PENDING);
    h.suite.set(l.mergeSha, [FAIL, FAIL]);
    h.suite.set(sha('b'), [PASS]);
    h.commits.set(l.mergeSha, fleetCommit(l));
    const r = await advancePostMergeWatches({ deps: h.deps });
    expect(r.suiteRuns).toBe(3);
    expect(r.reverted).toEqual([l.id]);
    expect(results(h)[0]).toMatchObject({ verdict: 'red', suite: 'fail' });
  });

  it('a transient GitHub read of the commit defers the revert (repo stays quarantined) and retries', async () => {
    const h = harness();
    const l = landing();
    registerLanding(l, { nowMs: T0 });
    h.ci.set(l.mergeSha, redCi('test'));
    h.suite.set(l.mergeSha, [PASS]);
    await advancePostMergeWatches({ deps: h.deps });
    expect(h.landRevert).not.toHaveBeenCalled();
    expect(holdKinds(l.repo, h.now.ms)).toEqual(['quarantine']);
    expect(listPostMergeWatches()[0]).toMatchObject({ phase: 'reverting' });
    h.commits.set(l.mergeSha, fleetCommit(l));
    await advancePostMergeWatches({ deps: h.deps });
    expect(h.landRevert).toHaveBeenCalledTimes(1);
    expect(listPostMergeWatches()[0]).toMatchObject({ phase: 'done', outcome: 'reverted' });
  });
});

describe('only fleet commits are reverted', () => {
  it('a red landing whose commit GitHub attributes to a human is NOT reverted: owner-hold + soft kill', async () => {
    const h = harness();
    const l = landing();
    registerLanding(l, { nowMs: T0 });
    h.ci.set(l.mergeSha, redCi('test'));
    h.ci.set(sha('b'), GREEN);
    h.suite.set(l.mergeSha, [PASS]);
    h.commits.set(l.mergeSha, fleetCommit(l, sha('b'), { authorLogin: 'masonwyatt', authorEmail: 'm@example.com' }));
    const r = await advancePostMergeWatches({ deps: h.deps });
    expect(h.landRevert).not.toHaveBeenCalled();
    expect(kinds(h)).toEqual(['post-merge:result', 'revert:failed', 'kill:on']);
    expect(holdKinds(l.repo, h.now.ms)).toEqual(['owner-hold', 'quarantine']);
    expect(h.softKill).toHaveBeenCalledTimes(1);
    expect(r.softKilled).toBe(true);
    expect(listPostMergeWatches()[0]).toMatchObject({ outcome: 'revert-refused' });
  });

  it('inherited red (the same check red on the parent) quarantines but never reverts or counts', async () => {
    const h = harness();
    const l = landing();
    registerLanding(l, { nowMs: T0 });
    h.ci.set(l.mergeSha, redCi('test'));
    h.ci.set(sha('b'), redCi('test'));
    h.suite.set(l.mergeSha, [PASS]);
    h.commits.set(l.mergeSha, fleetCommit(l));
    await advancePostMergeWatches({ deps: h.deps });
    expect(h.landRevert).not.toHaveBeenCalled();
    expect(results(h)[0]!.detail).toMatch(/already red at parent/);
    expect(holdKinds(l.repo, h.now.ms)).toEqual(['quarantine']);
    expect(listPostMergeWatches()[0]).toMatchObject({ outcome: 'inherited-red' });

    // A second repo's inherited red does not trip the "2 repos red in 6 h" kill.
    const l2 = landing({ repo: 'ashlrai/binshield', mergeSha: sha('7') });
    registerLanding(l2, { nowMs: T0 });
    h.ci.set(l2.mergeSha, redCi('build'));
    h.commits.set(l2.mergeSha, fleetCommit(l2, sha('6')));
    h.ci.set(sha('6'), redCi('build'));
    h.suite.set(l2.mergeSha, [PASS]);
    await advancePostMergeWatches({ deps: h.deps });
    expect(h.softKill).not.toHaveBeenCalled();
  });

  it('a suite that fails at the parent too is inherited', async () => {
    const h = harness();
    const l = landing();
    registerLanding(l, { nowMs: T0 });
    h.ci.set(l.mergeSha, GREEN);
    h.suite.set(l.mergeSha, [FAIL, FAIL]);
    h.suite.set(sha('b'), [FAIL]);
    h.commits.set(l.mergeSha, fleetCommit(l));
    await advancePostMergeWatches({ deps: h.deps });
    expect(h.landRevert).not.toHaveBeenCalled();
    expect(listPostMergeWatches()[0]).toMatchObject({ outcome: 'inherited-red' });
  });

  it('a red REVERT is never reverted: owner-hold + soft kill', async () => {
    const h = harness();
    const r0 = revertOf(landing());
    registerLanding(r0, { nowMs: T0 });
    h.now.ms = T0 + 30 * MIN;
    h.ci.set(r0.mergeSha, redCi('test'));
    h.suite.set(r0.mergeSha, [PASS]);
    await advancePostMergeWatches({ deps: h.deps });
    expect(h.landRevert).not.toHaveBeenCalled();
    expect(holdKinds(r0.repo, h.now.ms)).toEqual(['owner-hold']);
    expect(h.softKill).toHaveBeenCalledTimes(1);
    expect(listPostMergeWatches()[0]).toMatchObject({ outcome: 'revert-red' });
  });
});

// ---------------------------------------------------------------------------
// Failed revert → halt
// ---------------------------------------------------------------------------

describe('failed revert → halt', () => {
  function redLanding(h: Harness, over: Partial<LandingRecord> = {}): LandingRecord {
    const l = landing(over);
    registerLanding(l, { nowMs: T0 });
    h.ci.set(l.mergeSha, redCi('test'));
    h.suite.set(l.mergeSha, [PASS]);
    h.commits.set(l.mergeSha, fleetCommit(l));
    return l;
  }

  it('a conflicting revert: revert:failed, owner-hold, global soft kill, halt record', async () => {
    const h = harness();
    const l = redLanding(h);
    h.landRevert.mockResolvedValueOnce({ ok: false, code: 'conflict', retryable: false, reason: 'revert does not apply cleanly on main' });
    const r = await advancePostMergeWatches({ deps: h.deps });
    expect(kinds(h)).toEqual(['post-merge:result', 'revert:failed', 'kill:on']);
    expect(holdKinds(l.repo, h.now.ms)).toEqual(['owner-hold', 'quarantine']);
    expect(h.softKill).toHaveBeenCalledTimes(1);
    expect(h.recordHalt).toHaveBeenCalledWith(expect.objectContaining({ repos: [l.repo], landingIds: [l.id] }));
    expect(r.softKilled).toBe(true);
    expect(h.enqueue).not.toHaveBeenCalled();
    expect(listPostMergeWatches()[0]).toMatchObject({ outcome: 'revert-failed' });
  });

  it('transient failures are retried up to MAX_REVERT_ATTEMPTS, then escalate', async () => {
    const h = harness();
    const l = redLanding(h);
    h.landRevert.mockResolvedValue({ ok: false, code: 'github', retryable: true, reason: 'HTTP 502' });
    await advancePostMergeWatches({ deps: h.deps });
    await advancePostMergeWatches({ deps: h.deps });
    expect(h.softKill).not.toHaveBeenCalled();
    expect(listPostMergeWatches()[0]).toMatchObject({ phase: 'reverting' });
    await advancePostMergeWatches({ deps: h.deps });
    expect(h.landRevert).toHaveBeenCalledTimes(watch.MAX_REVERT_ATTEMPTS);
    expect(h.softKill).toHaveBeenCalledTimes(1);
    expect(holdKinds(l.repo, h.now.ms)).toEqual(['owner-hold', 'quarantine']);
  });

  it('a PENDING revert burns no attempt: it is retried every pass and lands when checks finish (INT3)', async () => {
    const h = harness();
    redLanding(h);
    h.landRevert.mockResolvedValue({ ok: false, code: 'pending', retryable: true, reason: 'required checks on revert PR #112 are still running' });
    for (let i = 0; i < watch.MAX_REVERT_ATTEMPTS + 2; i++) {
      await advancePostMergeWatches({ deps: h.deps });
      h.now.ms += 5 * MIN;
    }
    expect(h.softKill).not.toHaveBeenCalled();
    const pendingWatch = listPostMergeWatches().find((v) => v.kind === 'merge');
    expect(pendingWatch).toMatchObject({ phase: 'reverting' });
    h.landRevert.mockReset();
    h.landRevert.mockImplementation(async (req: FleetRevertRequest) => ({ ok: true, landing: revertOf(req.landing) }));
    await advancePostMergeWatches({ deps: h.deps });
    expect(listPostMergeWatches().find((v) => v.kind === 'merge')).toMatchObject({ outcome: 'reverted' });
    expect(kinds(h)).toContain('revert:landed');
    expect(h.softKill).not.toHaveBeenCalled();
  });

  it('a revert still pending past REVERT_PENDING_DEADLINE_MS is a failed revert: owner-hold + soft kill (INT3)', async () => {
    const h = harness();
    const l = redLanding(h);
    h.landRevert.mockResolvedValue({ ok: false, code: 'pending', retryable: true, reason: 'checks running' });
    await advancePostMergeWatches({ deps: h.deps }); // the revert starts here
    h.now.ms += watch.REVERT_PENDING_DEADLINE_MS - MIN;
    await advancePostMergeWatches({ deps: h.deps });
    expect(h.softKill).not.toHaveBeenCalled();
    h.now.ms += 2 * MIN;
    await advancePostMergeWatches({ deps: h.deps });
    expect(h.softKill).toHaveBeenCalledTimes(1);
    expect(holdKinds(l.repo, h.now.ms)).toEqual(['owner-hold', 'quarantine']);
    const failed = h.ledger.find((r) => r.kind === 'revert:failed')?.data as { reason: string };
    expect(failed.reason).toMatch(/\[pending\]/);
    expect(listPostMergeWatches().find((v) => v.kind === 'merge')).toMatchObject({ outcome: 'revert-failed' });
  });

  it('while Stop is on the revert waits (no attempt burned); it lands after Stop clears', async () => {
    const h = harness();
    redLanding(h);
    h.landRevert.mockResolvedValueOnce({ ok: false, code: 'killed', retryable: true, reason: 'KILL is on' });
    await advancePostMergeWatches({ deps: h.deps });
    await advancePostMergeWatches({ deps: h.deps });
    expect(h.softKill).not.toHaveBeenCalled();
    expect(listPostMergeWatches().find((v) => v.kind === 'merge')).toMatchObject({ outcome: 'reverted' });
  });

  it('a lander answer that is not a revert of THIS landing is a failure, not a revert', async () => {
    const h = harness();
    const l = redLanding(h);
    h.landRevert.mockResolvedValueOnce({ ok: true, landing: { ...revertOf(l), revertsLandingId: 'someone-else' } });
    await advancePostMergeWatches({ deps: h.deps });
    expect(kinds(h)).toContain('revert:failed');
    expect(h.softKill).toHaveBeenCalledTimes(1);
  });

  it('the production default lander (no U3 export yet) escalates rather than leaving a red repo open', async () => {
    const h = harness();
    const l = redLanding(h);
    h.deps.landRevert = landRevertViaHostMerge;
    await advancePostMergeWatches({ deps: h.deps });
    expect(holdKinds(l.repo, h.now.ms)).toEqual(['owner-hold', 'quarantine']);
    expect(h.softKill).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Escalation ladder
// ---------------------------------------------------------------------------

describe('escalation ladder', () => {
  function red(h: Harness, repo: string, c: string, prNumber: number, landedAtMs: number): LandingRecord {
    const l = landing({ repo, mergeSha: sha(c), prNumber, landedAt: at(landedAtMs), watchUntil: at(landedAtMs + 2 * H) });
    registerLanding(l, { nowMs: landedAtMs });
    h.ci.set(l.mergeSha, redCi('test'));
    h.suite.set(l.mergeSha, [PASS]);
    h.commits.set(l.mergeSha, fleetCommit(l));
    return l;
  }

  it('a second quarantine of the same repo within 7 days adds an owner-hold', async () => {
    const h = harness();
    const repo = 'ashlrai/ashlrcode';
    red(h, repo, '1', 1, T0);
    await advancePostMergeWatches({ deps: h.deps });
    expect(holdKinds(repo, h.now.ms)).toEqual(['quarantine']);

    h.now.ms = T0 + 3 * 24 * H; // the first quarantine has long expired
    red(h, repo, '2', 2, h.now.ms - 10 * MIN);
    const r = await advancePostMergeWatches({ deps: h.deps });
    expect(holdKinds(repo, h.now.ms)).toEqual(['owner-hold', 'quarantine']);
    expect(r.escalations.join('\n')).toMatch(/second quarantine within 7 days/);
    expect(h.softKill).not.toHaveBeenCalled();
  });

  it('…but not when the previous quarantine is older than 7 days', async () => {
    const h = harness();
    const repo = 'ashlrai/ashlrcode';
    red(h, repo, '1', 1, T0);
    await advancePostMergeWatches({ deps: h.deps });
    h.now.ms = T0 + 8 * 24 * H;
    red(h, repo, '2', 2, h.now.ms - 10 * MIN);
    await advancePostMergeWatches({ deps: h.deps });
    expect(holdKinds(repo, h.now.ms)).toEqual(['quarantine']);
  });

  it('2 different repos red within 6 h ⇒ global soft kill', async () => {
    const h = harness();
    red(h, 'ashlrai/ashlrcode', '1', 1, T0);
    red(h, 'ashlrai/binshield', '2', 2, T0 + MIN);
    const r = await advancePostMergeWatches({ deps: h.deps });
    expect(h.softKill).toHaveBeenCalledTimes(1);
    expect(h.softKill.mock.calls[0]![0]).toMatch(/2 repos went red within 6 h/);
    expect(r.softKilled).toBe(true);
  });

  it('3 reverts within 24 h ⇒ global soft kill (and not before the third)', async () => {
    const h = harness();
    const repos = ['ashlrai/ashlrcode', 'ashlrai/locus', 'ashlrai/binshield'];
    // 7 h apart so the 2-repos-in-6-h rule stays quiet; well inside 24 h.
    for (let i = 0; i < 3; i++) {
      h.now.ms = T0 + i * 7 * H + 20 * MIN;
      red(h, repos[i]!, String(i + 1), i + 1, T0 + i * 7 * H);
      await advancePostMergeWatches({ deps: h.deps });
      expect(h.softKill).toHaveBeenCalledTimes(i < 2 ? 0 : 1);
    }
    expect(h.softKill.mock.calls[0]![0]).toMatch(/3 fleet reverts within 24 h/);
    expect(h.landRevert).toHaveBeenCalledTimes(3);
  });

  it('reverts spread over more than 24 h never trip the rule', async () => {
    const h = harness();
    const repos = ['ashlrai/ashlrcode', 'ashlrai/locus', 'ashlrai/binshield'];
    for (let i = 0; i < 3; i++) {
      h.now.ms = T0 + i * 13 * H + 20 * MIN;
      red(h, repos[i]!, String(i + 1), i + 1, T0 + i * 13 * H);
      await advancePostMergeWatches({ deps: h.deps });
    }
    expect(h.softKill).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Ledger durability
// ---------------------------------------------------------------------------

describe('ledger durability', () => {
  it('rows the ledger refused are queued on the watch and flushed, in order, on a later pass', async () => {
    const h = harness();
    const l = landing();
    registerLanding(l, { nowMs: T0 });
    h.ci.set(l.mergeSha, redCi('test'));
    h.ci.set(sha('b'), GREEN);
    h.suite.set(l.mergeSha, [PASS]);
    h.commits.set(l.mergeSha, fleetCommit(l));
    h.ledgerUp.v = false;
    await advancePostMergeWatches({ deps: h.deps });
    expect(h.ledger).toEqual([]);
    expect(h.landRevert).toHaveBeenCalledTimes(1); // the safety action did not wait on the ledger
    h.ledgerUp.v = true;
    await advancePostMergeWatches({ deps: h.deps });
    expect(kinds(h).slice(0, 2)).toEqual(['post-merge:result', 'revert:landed']);
  });
});

// ---------------------------------------------------------------------------
// R3b: a soft kill also revokes ARMED host merges (Stop's companion)
// ---------------------------------------------------------------------------

describe('soft kill revokes armed host merges (R3b)', () => {
  function humanRedLanding(h: Harness): LandingRecord {
    const l = landing();
    registerLanding(l, { nowMs: T0 });
    h.ci.set(l.mergeSha, redCi('test'));
    h.ci.set(sha('b'), GREEN);
    h.suite.set(l.mergeSha, [PASS]);
    // Not provably the fleet's ⇒ owner-hold + soft kill, no revert attempt.
    h.commits.set(l.mergeSha, fleetCommit(l, sha('b'), { authorLogin: 'masonwyatt', authorEmail: 'm@example.com' }));
    return l;
  }

  it('the production default revokes through clamp.revokeArmedMerges → host-merge, after arming KILL', async () => {
    const h = harness();
    const order: string[] = [];
    h.softKill.mockImplementation((reason: string) => {
      order.push(`kill with ${hostMerge.revokeCalls.length} revocation(s) before it`);
      return { ok: true, changed: true, reason };
    });
    humanRedLanding(h);
    const r = await advancePostMergeWatches({ deps: h.deps });
    expect(h.softKill).toHaveBeenCalledTimes(1);
    expect(hostMerge.revokeCalls).toHaveLength(1);
    expect(hostMerge.revokeCalls[0]).toMatch(/^post-merge soft kill: ashlrai\/ashlrcode: red landing could not be proven fleet-authored/);
    expect(order).toEqual(['kill with 0 revocation(s) before it']);
    expect(r.escalations).toContain('revoked 1 armed fleet merge(s) after the soft kill');
    expect(r.softKilled).toBe(true);
  });

  it('an injected revoker is awaited once per soft kill; failures are reported, never fatal', async () => {
    const h = harness();
    const revoke = vi.fn(async () => ({ revoked: 0, failed: ['ashlrai/x#3: stale receipt'] }));
    h.deps.revokeArmedMerges = revoke;
    humanRedLanding(h);
    const r = await advancePostMergeWatches({ deps: h.deps });
    expect(revoke).toHaveBeenCalledTimes(1);
    expect(hostMerge.revokeCalls).toHaveLength(0);
    expect(r.ok).toBe(true);
    expect(r.escalations.some((e) => e.startsWith('could not revoke every armed fleet merge after the soft kill') && e.includes('stale receipt'))).toBe(true);
    expect(kinds(h)).toEqual(['post-merge:result', 'revert:failed', 'kill:on']);
  });

  it('a revoker that throws is contained: the pass still records the kill and the hold', async () => {
    const h = harness();
    h.deps.revokeArmedMerges = vi.fn(async () => { throw new Error('boom'); });
    const l = humanRedLanding(h);
    const r = await advancePostMergeWatches({ deps: h.deps });
    expect(r.ok).toBe(true);
    expect(r.softKilled).toBe(true);
    expect(holdKinds(l.repo, h.now.ms)).toEqual(['owner-hold', 'quarantine']);
    expect(r.escalations.some((e) => e.includes('could not revoke every armed fleet merge') && e.includes('boom'))).toBe(true);
  });

  it('revocation still runs when KILL could not be armed (it is then the only thing lowering authority)', async () => {
    const h = harness();
    h.softKill.mockImplementation(() => ({ ok: false, changed: false, reason: 'sentinel write failed' }));
    const revoke = vi.fn(async () => ({ revoked: 2, failed: [] }));
    h.deps.revokeArmedMerges = revoke;
    humanRedLanding(h);
    const r = await advancePostMergeWatches({ deps: h.deps });
    expect(revoke).toHaveBeenCalledTimes(1);
    expect(r.softKilled).toBe(false);
    expect(r.escalations).toContain('revoked 2 armed fleet merge(s) after the soft kill');
    // No kill:on row for a kill that did not arm.
    expect(kinds(h)).toEqual(['post-merge:result', 'revert:failed']);
  });

  it('a failed revert (conflict) revokes too — every soft-kill site goes through the same path', async () => {
    const h = harness();
    const revoke = vi.fn(async () => ({ revoked: 0, failed: [] }));
    h.deps.revokeArmedMerges = revoke;
    const l = landing();
    registerLanding(l, { nowMs: T0 });
    h.ci.set(l.mergeSha, redCi('test'));
    h.suite.set(l.mergeSha, [PASS]);
    h.commits.set(l.mergeSha, fleetCommit(l));
    h.landRevert.mockResolvedValueOnce({ ok: false, code: 'conflict', retryable: false, reason: 'revert does not apply cleanly on main' });
    await advancePostMergeWatches({ deps: h.deps });
    expect(h.softKill).toHaveBeenCalledTimes(1);
    expect(revoke).toHaveBeenCalledTimes(1);
  });
});
