/**
 * 3.16 "run many agents" — the Agents board's pure half
 * (core/verse/agents/board.ts, checks.ts, workspace-config.ts, actions.ts):
 * which column every card lands in and why, the Needs-you items it files
 * (validated against the drawer's own contract), spend at list price, the
 * workspace.json parser, port blocks, and the Auto-merge verdict.
 */
import { describe, expect, it } from 'vitest';

import { buildBoard, agentNeedsYouItems, placeCard, sessionSpend, countColumns, type BoardInput } from '../src/core/verse/agents/board.js';
import { autoMergeVerdict, actionsRunId, checkRows, prComments, requiredAutoMergeChecks, type MergeVerdictInput } from '../src/core/verse/agents/checks.js';
import { extractPlan, lastActivityLine, planApprovedPrompt, planRequestPrompt } from '../src/core/verse/agents/actions.js';
import { scriptEnv, terminalCommand } from '../src/core/verse/agents/scripts.js';
import { blankAgent, normalizeAgentRecord } from '../src/core/verse/agents/store.js';
import type { AgentChecksSummary, AgentRecord } from '../src/core/verse/agents/types.js';
import {
  allocatePortBlock,
  isSafeCopyPath,
  parseWorkspaceConfig,
  portBlockAvailable,
  slugifyAgentName,
  uniqueSlug,
  workspaceEnv,
  WorkspacePortsExhaustedError,
} from '../src/core/verse/agents/workspace-config.js';
import type { VerseEvent, VerseSession } from '../src/core/verse/types.js';
import { isNeedsYouItem } from '../src/core/verse/workbench-types.js';
import type { VerseGitPr } from '../src/core/verse/workbench-types.js';

const NOW = Date.parse('2026-09-27T12:00:00Z');

function session(over: Partial<VerseSession> = {}): VerseSession {
  return {
    id: 'vs_1',
    title: 'Fix login',
    projectPath: '/Users/x/.ashlr-worktrees/repo/fix-login',
    engine: 'claude',
    accountId: 'a',
    seatId: 'claude',
    model: 'claude-sonnet-5',
    nativeSessionId: null,
    createdAt: '2026-09-27T10:00:00Z',
    updatedAt: '2026-09-27T11:00:00Z',
    status: 'idle',
    turnCount: 2,
    usage: { inputTokens: 1_000_000, outputTokens: 100_000, cacheReadTokens: 0, cacheCreationTokens: 0, contextTokens: 0, contextWindow: null },
    lastError: null,
    ...over,
  };
}

function agent(over: Partial<AgentRecord> = {}): AgentRecord {
  return {
    ...blankAgent({ id: 'ag_0123456789abcdef', title: 'Fix login', at: '2026-09-27T10:00:00Z' }),
    sessionId: 'vs_1',
    workspace: { rootPath: '/r/repo', path: '/Users/x/.ashlr-worktrees/repo/fix-login', branch: 'verse/fix-login', name: 'fix-login', portBase: 41000, portCount: 10, baseSha: null },
    ...over,
  };
}

const PRICE = { inPerM: 3, outPerM: 15 };
const noChecks: AgentChecksSummary | null = null;

function place(s: VerseSession | null, a: AgentRecord | null, extra: { unread?: boolean; archived?: boolean; resolvedTurn?: number | null; checks?: AgentChecksSummary | null } = {}) {
  return placeCard({
    session: s,
    agent: a,
    unread: extra.unread ?? false,
    archived: extra.archived ?? false,
    resolvedTurn: extra.resolvedTurn ?? null,
    checks: extra.checks ?? noChecks,
    spend: sessionSpend(s, a?.spendCapUsd ?? null, () => PRICE),
  });
}

function checks(over: Partial<AgentChecksSummary> = {}): AgentChecksSummary {
  return { pr: { number: 7, url: 'https://github.com/o/r/pull/7', state: 'open', title: 'x' }, ci: 'passing', dirty: 0, ahead: 0, comments: 0, checkedAt: null, ...over };
}

describe('placeCard — the column rules', () => {
  it('Working: a running turn, a running setup, a plan being written', () => {
    expect(place(session({ status: 'running' }), agent())).toMatchObject({ column: 'working', reason: 'running' });
    const setup = agent({ scripts: [{ id: 'r', kind: 'setup', name: 'setup', via: 'process', tabId: null, state: 'running', exitCode: null, startedAt: '', endedAt: null }] });
    expect(place(session(), setup)).toMatchObject({ column: 'working', reason: 'setup-running' });
    const drafting = agent({ plan: { enabled: true, state: 'drafting', text: null, turn: 0 } });
    expect(place(session({ status: 'running' }), drafting)).toMatchObject({ column: 'working', reason: 'plan-drafting' });
  });

  it('Needs you: failed (until resolved), plan ready, cap reached, setup failed, red CI with no auto-fix left, conflicts', () => {
    expect(place(session({ status: 'error' }), null)).toMatchObject({ column: 'needs-you', reason: 'failed' });
    // Resolving at the current turn takes it out; a later failure brings it back.
    expect(place(session({ status: 'error', turnCount: 2 }), null, { resolvedTurn: 2 }).column).not.toBe('needs-you');
    expect(place(session({ status: 'error', turnCount: 3 }), null, { resolvedTurn: 2 }).column).toBe('needs-you');
    expect(place(session(), agent({ plan: { enabled: true, state: 'awaiting-approval', text: 'p', turn: 0 } }))).toMatchObject({ column: 'needs-you', reason: 'plan-ready' });
    // 1M in × $3 + 100k out × $15 = $4.50 ≥ $4 cap.
    expect(place(session(), agent({ spendCapUsd: 4 }))).toMatchObject({ column: 'needs-you', reason: 'spend-cap' });
    const failedSetup = agent({ pendingPrompt: 'do it', scripts: [{ id: 'r', kind: 'setup', name: 'setup', via: 'process', tabId: null, state: 'failed', exitCode: 1, startedAt: '', endedAt: '' }] });
    expect(place(session({ turnCount: 0 }), failedSetup)).toMatchObject({ column: 'needs-you', reason: 'setup-failed' });
    expect(place(session(), agent(), { checks: checks({ ci: 'failing' }) })).toMatchObject({ column: 'needs-you', reason: 'ci-failed' });
    expect(place(session(), agent({ autoFix: true, autoFixAttempts: 3 }), { checks: checks({ ci: 'failing' }) })).toMatchObject({ column: 'needs-you', reason: 'ci-failed' });
    expect(place(session(), agent({ loopNote: 'Auto-merge was refused: GitHub says this PR has conflicts with its base.' }), { checks: checks() }).reason).toBe('merge-blocked');
  });

  it('Working, not Needs you, while Auto-fix still has attempts, or Auto-merge waits on CI', () => {
    expect(place(session(), agent({ autoFix: true, autoFixAttempts: 1 }), { checks: checks({ ci: 'failing' }) })).toMatchObject({ column: 'working', reason: 'ci-running' });
    expect(place(session(), agent({ autoMerge: true }), { checks: checks({ ci: 'pending' }) })).toMatchObject({ column: 'working', reason: 'ci-running' });
  });

  it('Ready for review: an open PR, an unread finish, work not yet in a PR; Done otherwise', () => {
    expect(place(session(), agent(), { checks: checks() })).toMatchObject({ column: 'review', reason: 'pr-open' });
    expect(place(session(), null, { unread: true })).toMatchObject({ column: 'review', reason: 'unread' });
    expect(place(session(), agent(), { checks: checks({ pr: null, ci: 'none', dirty: 2 }) })).toMatchObject({ column: 'review', reason: 'changes' });
    expect(place(session(), agent(), { checks: checks({ pr: { number: 7, url: 'https://x', state: 'merged', title: '' } }) })).toMatchObject({ column: 'done', reason: 'merged' });
    expect(place(session(), null)).toMatchObject({ column: 'done', reason: 'idle' });
    expect(place(session({ status: 'running' }), agent(), { archived: true })).toMatchObject({ column: 'done', reason: 'archived' });
  });

  it('marking read never moves a Needs-you card: read state is not an input to those rules', () => {
    for (const unread of [true, false]) {
      expect(place(session({ status: 'error' }), null, { unread }).column).toBe('needs-you');
      expect(place(session(), agent({ plan: { enabled: true, state: 'awaiting-approval', text: 'p', turn: 0 } }), { unread }).column).toBe('needs-you');
    }
  });
});

describe('buildBoard', () => {
  const base: Omit<BoardInput, 'sessions' | 'agents'> = {
    unread: () => false,
    archivedChat: () => false,
    pinnedChat: () => false,
    resolvedTurn: () => null,
    checks: () => null,
    live: () => null,
    lastActivity: () => 'Wrote the fix',
    priceOf: () => PRICE,
    now: NOW,
  };

  it('shows every chat, binds agents to theirs, and keeps an agent whose chat is gone', () => {
    const cards = buildBoard({
      ...base,
      sessions: [session(), session({ id: 'vs_2', title: 'Other', status: 'running', updatedAt: '2026-09-27T11:30:00Z' })],
      agents: [agent(), agent({ id: 'ag_fedcba9876543210', sessionId: 'vs_gone', title: 'Orphan' })],
    });
    expect(cards.map((c) => c.id)).toEqual(['chat:vs_2', 'ag_fedcba9876543210', 'ag_0123456789abcdef']);
    const bound = cards.find((c) => c.agentId === 'ag_0123456789abcdef')!;
    expect(bound).toMatchObject({ sessionId: 'vs_1', branch: 'verse/fix-login', repo: 'repo', lastActivity: 'Wrote the fix' });
    expect(bound.spend.usd).toBeCloseTo(4.5, 4);
    expect(countColumns(cards)).toEqual({ working: 1, 'needs-you': 1, review: 0, done: 1 });
  });

  it('files valid Needs-you items for plans, spend (80% and 100%), setup and CI — never for a failed turn (C1 covers it)', () => {
    const cards = buildBoard({
      ...base,
      checks: (id) => (id === 'ag_cccccccccccccccc' ? checks({ ci: 'failing' }) : null),
      sessions: [
        session({ id: 'a', status: 'error' }),
        session({ id: 'b' }),
        session({ id: 'c' }),
        session({ id: 'd' }),
        session({ id: 'e' }),
      ],
      agents: [
        agent({ id: 'ag_aaaaaaaaaaaaaaaa', sessionId: 'a' }),
        agent({ id: 'ag_bbbbbbbbbbbbbbbb', sessionId: 'b', plan: { enabled: true, state: 'awaiting-approval', text: '1. Do it', turn: 1 } }),
        agent({ id: 'ag_cccccccccccccccc', sessionId: 'c' }),
        agent({ id: 'ag_dddddddddddddddd', sessionId: 'd', spendCapUsd: 5 }), // $4.50 of $5 = 90%
        agent({ id: 'ag_eeeeeeeeeeeeeeee', sessionId: 'e', spendCapUsd: 2 }), // over
      ],
    });
    const items = agentNeedsYouItems(cards, new Date(NOW).toISOString());
    for (const item of items) expect(isNeedsYouItem(item), JSON.stringify(item)).toBe(true);
    const kinds = items.map((i) => `${i.kind}:${i.subject.sessionId}:${i.severity}`).sort();
    expect(kinds).toEqual(['agent-ci:c:warn', 'agent-plan:b:warn', 'agent-spend:d:warn', 'agent-spend:e:high']);
    const plan = items.find((i) => i.kind === 'agent-plan')!;
    expect(plan.actions.map((a) => a.kind)).toEqual(['approve', 'reject']);
    expect(plan.actions[0]!.request).toEqual({ method: 'POST', path: '/api/verse/agents/ag_bbbbbbbbbbbbbbbb/plan', body: { action: 'approve' } });
  });
});

describe('spend', () => {
  it('prices input + cache writes at the input rate, cache reads at a tenth, and says null without a price', () => {
    const s = session({ usage: { inputTokens: 100_000, outputTokens: 10_000, cacheReadTokens: 1_000_000, cacheCreationTokens: 100_000, contextTokens: 0, contextWindow: null } });
    const spend = sessionSpend(s, 1, () => PRICE);
    // (200k × 3 + 1M × 0.3 + 10k × 15) / 1M = 0.6 + 0.3 + 0.15
    expect(spend.usd).toBeCloseTo(1.05, 4);
    expect(spend.fraction).toBeCloseTo(1.05, 4);
    expect(sessionSpend(s, 1, () => null)).toMatchObject({ usd: null, fraction: null, tokens: 1_210_000 });
  });
});

describe('workspace.json', () => {
  it('parses every field and ignores (with a warning) what is wrong', () => {
    const read = parseWorkspaceConfig({
      setup: 'npm ci',
      run: [{ name: 'Dev', command: 'npm run dev -- --port $ASHLR_PORT' }, 'npm test', { name: 'bad' }],
      archive: 'docker compose down',
      copy: ['.env', '.env.local', '../secret', '/etc/passwd', '.git/config', 'a/*.env'],
      ports: 20,
      extra: 1,
    });
    expect(read.source).toBe('file');
    expect(read.config).toEqual({
      setup: 'npm ci',
      run: [{ name: 'Dev', command: 'npm run dev -- --port $ASHLR_PORT' }, { name: 'Run 2', command: 'npm test' }],
      archive: 'docker compose down',
      copy: ['.env', '.env.local'],
      ports: 20,
    });
    expect(read.warnings.length).toBeGreaterThanOrEqual(5);
    expect(parseWorkspaceConfig([]).source).toBe('default');
    expect(parseWorkspaceConfig({ ports: 999 }).config.ports).toBe(10);
  });

  it('refuses copy paths that escape the repo', () => {
    for (const bad of ['..', '../x', 'a/../b', '/abs', '~/x', '.git/HEAD', '-rf', 'a\\b', 'x*', '']) expect(isSafeCopyPath(bad), bad).toBe(false);
    for (const good of ['.env', 'config/local.json', '.env.development.local']) expect(isSafeCopyPath(good), good).toBe(true);
  });

  it('hands out non-overlapping port blocks from 41000, and names slugs', () => {
    expect(allocatePortBlock(10, [])).toBe(41_000);
    expect(allocatePortBlock(10, [{ base: 41_000, count: 10 }])).toBe(41_010);
    expect(allocatePortBlock(10, [{ base: 41_000, count: 10 }, { base: 41_020, count: 10 }])).toBe(41_010);
    expect(allocatePortBlock(25, [{ base: 41_000, count: 10 }])).toBe(41_025);
    expect(slugifyAgentName('Fix the Login redirect!')).toBe('fix-the-login-redirect');
    expect(slugifyAgentName('✨', new Date(2026, 8, 27, 9, 5))).toBe('agent-20260927-0905');
    expect(uniqueSlug('a', (c) => c === 'a' || c === 'a-2')).toBe('a-3');
    expect(workspaceEnv({ path: '/w', name: 'n', rootPath: '/r', portBase: 41000, portCount: 10 })).toEqual({
      ASHLR_WORKSPACE_PATH: '/w', ASHLR_WORKSPACE_NAME: 'n', ASHLR_ROOT_PATH: '/r', ASHLR_PORT: '41000', ASHLR_PORT_COUNT: '10',
    });
  });

  it('never passes the sidecar’s own ASHLR_* settings to a script, and builds a quoted terminal line', () => {
    const env = scriptEnv(workspaceEnv({ path: '/w', name: 'n', rootPath: '/r', portBase: 1, portCount: 0 }), { PATH: '/bin', ASHLR_TOKEN: 'secret', ashlr_x: 'y' });
    expect(env['ASHLR_TOKEN']).toBeUndefined();
    expect(env['ashlr_x']).toBeUndefined();
    expect(env['ASHLR_WORKSPACE_PATH']).toBe('/w');
    expect(env['PATH']).toBe('/bin');
    const line = terminalCommand({ kind: 'setup', command: "echo 'hi' && npm ci", env: workspaceEnv({ path: '/w x', name: 'n', rootPath: '/r', portBase: 1, portCount: 0 }) });
    expect(line.startsWith('env ')).toBe(true);
    expect(line.endsWith('; exit')).toBe(true);
    expect(line).toContain("'ASHLR_WORKSPACE_PATH=/w x'");
    expect(terminalCommand({ kind: 'run', command: 'npm run dev', env: workspaceEnv({ path: '/w', name: 'n', rootPath: '/r', portBase: 1, portCount: 0 }) })).not.toContain('; exit');
  });

  it('refuses a saturated physical range, allocates the last free block and respects partial overlaps', () => {
    const full = Array.from({ length: 380 }, (_, i) => ({ base: 41_000 + i * 50, count: 50 }));
    expect(() => allocatePortBlock(50, full)).toThrow(WorkspacePortsExhaustedError);
    expect(allocatePortBlock(50, full.slice(0, -1))).toBe(59_950);
    expect(portBlockAvailable(59_950, 50, full.slice(0, -1))).toBe(true);
    expect(portBlockAvailable(59_951, 50, [])).toBe(false);
    expect(portBlockAvailable(41_010, 10, [{ base: 41_019, count: 10 }])).toBe(false);
    expect(portBlockAvailable(41_010, 10, [{ base: 41_000, count: 10 }, { base: 41_020, count: 10 }])).toBe(true);
    for (const count of [NaN, Infinity, -1, 1.5, 51]) expect(() => allocatePortBlock(count, [])).toThrow(WorkspacePortsExhaustedError);
  });

  it('keeps zero-port workspaces unreserved even when every physical range is taken', () => {
    const full = Array.from({ length: 380 }, (_, i) => ({ base: 41_000 + i * 50, count: 50 }));
    expect(allocatePortBlock(0, full)).toBe(41_000);
    expect(portBlockAvailable(41_000, 0, full)).toBe(true);
    expect(allocatePortBlock(10, [{ base: 41_000, count: 0 }])).toBe(41_000);
  });
});

describe('Auto-merge verdict', () => {
  const pr: VerseGitPr = { number: 7, title: 't', url: 'https://github.com/o/r/pull/7', state: 'open', checks: 'passing', mergeable: true, headSha: 'a'.repeat(40), baseRef: 'main', headRef: 'verse/x' };
  const base: MergeVerdictInput = { autoMerge: true, killOn: false, pr, branch: 'verse/x', files: ['src/a.ts'], selfRepo: false, selfRepoMode: null, protectedHit: null, requiredChecks: ['CI'], checks: [{ name: 'CI', state: 'passing', url: null }] };

  it('allows only a green, mergeable, unprotected PR — in words either way', () => {
    expect(autoMergeVerdict(base)).toMatchObject({ allowed: true });
    expect(autoMergeVerdict({ ...base, autoMerge: false }).allowed).toBe(false);
    expect(autoMergeVerdict({ ...base, killOn: true }).reason).toMatch(/kill switch/);
    expect(autoMergeVerdict({ ...base, pr: { ...pr, checks: 'pending' } }).reason).toMatch(/still running/);
    expect(autoMergeVerdict({ ...base, pr: { ...pr, checks: 'failing' } }).allowed).toBe(false);
    expect(autoMergeVerdict({ ...base, pr: { ...pr, mergeable: false } }).reason).toMatch(/conflicts/);
    expect(autoMergeVerdict({ ...base, pr: { ...pr, state: 'draft' } }).allowed).toBe(false);
    expect(autoMergeVerdict({ ...base, protectedHit: { path: '.github/workflows/ci.yml', why: 'CI config' } }).reason).toMatch(/\.github\/workflows\/ci\.yml/);
  });

  it('lands ashlr-hub itself only under a grant whose self-land policy is merge-non-authority', () => {
    expect(autoMergeVerdict({ ...base, selfRepo: true, selfRepoMode: null }).reason).toMatch(/no standing grant/);
    expect(autoMergeVerdict({ ...base, selfRepo: true, selfRepoMode: 'propose-only' }).reason).toMatch(/propose-only/);
    expect(autoMergeVerdict({ ...base, selfRepo: true, selfRepoMode: 'merge-non-authority' }).allowed).toBe(true);
  });

  it('holds auto-merge when only preview checks passed or a required code check is stale', () => {
    expect(autoMergeVerdict({ ...base, requiredChecks: [], checks: [{ name: 'Vercel', state: 'passing', url: null }] }).reason).toMatch(/preview deployment/);
    expect(autoMergeVerdict({ ...base, checks: [{ name: 'Vercel', state: 'passing', url: null }] }).reason).toMatch(/CI has not passed/);
    expect(autoMergeVerdict({ ...base, checks: [{ name: 'CI', state: 'pending', url: null }] }).allowed).toBe(false);
    expect(autoMergeVerdict({ ...base, checks: [...base.checks, ...base.checks] }).allowed).toBe(false);
  });

  it('treats a missing or malformed owner code-gate setting as auto-merge off', () => {
    expect(requiredAutoMergeChecks(undefined)).toEqual([]);
    expect(requiredAutoMergeChecks('CI, Typecheck')).toEqual(['CI', 'Typecheck']);
    expect(requiredAutoMergeChecks('CI,')).toEqual([]);
  });

  it('reads CI rows, run ids and review comments', () => {
    const rows = checkRows([
      { __typename: 'CheckRun', name: 'test', status: 'COMPLETED', conclusion: 'FAILURE', detailsUrl: 'https://github.com/o/r/actions/runs/123/job/9' },
      { __typename: 'CheckRun', name: 'lint', status: 'IN_PROGRESS', conclusion: '' },
      { __typename: 'StatusContext', context: 'vercel', state: 'SUCCESS', targetUrl: 'https://vercel.com/x' },
      { name: 'skip', status: 'COMPLETED', conclusion: 'SKIPPED' },
    ]);
    expect(rows.map((r) => `${r.name}:${r.state}`)).toEqual(['test:failing', 'lint:pending', 'vercel:passing', 'skip:skipped']);
    expect(actionsRunId(rows[0]!.url)).toBe('123');
    expect(actionsRunId('https://evil.example/actions/runs/1')).toBeNull();
    const comments = prComments({
      comments: [{ author: { login: 'mason' }, body: 'Rename this. token=ghp_' + 'a'.repeat(36), createdAt: '2026-09-27T10:00:00Z' }],
      reviews: [{ author: { login: 'bot' }, body: '', state: 'CHANGES_REQUESTED', submittedAt: '2026-09-27T11:00:00Z' }],
    });
    expect(comments.map((c) => c.author)).toEqual(['mason', 'bot']);
    expect(comments[0]!.body).not.toContain('ghp_aaaa');
    expect(comments[1]!.body).toBe('Requested changes.');
  });
});

describe('plans and activity lines', () => {
  const ev = (e: Partial<VerseEvent> & { type: VerseEvent['type'] }, seq: number) => ({ seq, at: '', turnId: 't', ...e }) as VerseEvent;

  it('takes ExitPlanMode’s plan when the seat used it, else the plan turn’s last message', () => {
    const events: VerseEvent[] = [
      ev({ type: 'user-message', text: 'old' }, 1),
      ev({ type: 'assistant-message', text: 'old answer' }, 2),
      ev({ type: 'user-message', text: planRequestPrompt('do it') }, 3),
      ev({ type: 'assistant-message', text: 'Here is my plan:\n1. a' }, 4),
    ];
    expect(extractPlan(events, 1)).toBe('Here is my plan:\n1. a');
    const withTool = [...events, ev({ type: 'tool-use', toolUseId: 'u', name: 'ExitPlanMode', input: { plan: '1. edit a.ts\n2. test' } }, 5)];
    expect(extractPlan(withTool, 1)).toBe('1. edit a.ts\n2. test');
    expect(extractPlan(events.slice(0, 3), 1)).toBeNull();
    expect(planRequestPrompt('X')).toMatch(/Do not edit/);
    expect(planApprovedPrompt('1. a')).toMatch(/Approved plan/);
    expect(lastActivityLine([ev({ type: 'assistant-message', text: 'Done.\n\n**All tests pass**' }, 1)])).toBe('All tests pass');
  });

  it('repairs an old or partial record instead of dropping it', () => {
    const rec = normalizeAgentRecord({ id: 'ag_0123456789abcdef', title: 'x', scripts: [{ id: 'r', kind: 'setup', state: 'running' }] });
    expect(rec).not.toBeNull();
    expect(rec!.plan).toEqual({ enabled: false, state: 'none', text: null, turn: null });
    // A run the previous process was watching cannot still be watched.
    expect(rec!.scripts[0]!.state).toBe('failed');
    expect(normalizeAgentRecord({ id: 'nope' })).toBeNull();
  });
});
