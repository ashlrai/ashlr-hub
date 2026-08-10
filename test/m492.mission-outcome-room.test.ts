/**
 * Mission Outcome Room contract: a fail-closed, path-redacted, planning-only
 * projection plus its semantic/read-only Goals view.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';

const missionMocks = vi.hoisted(() => ({
  readLatestBriefingDetailed: vi.fn(),
  previewBriefingAdoption: vi.fn(),
  listGoalsDetailed: vi.fn(),
  readEnrollmentRegistry: vi.fn(),
  createProposalMilestoneCompletionPredicate: vi.fn(),
  goalFocusActiveThreshold: vi.fn(),
}));

vi.mock('../src/core/vision/strategist.js', () => ({
  readLatestBriefingDetailed: missionMocks.readLatestBriefingDetailed,
  previewBriefingAdoption: missionMocks.previewBriefingAdoption,
}));
vi.mock('../src/core/goals/store.js', () => ({
  listGoals: vi.fn(() => []),
  listGoalsDetailed: missionMocks.listGoalsDetailed,
  loadGoal: vi.fn(() => null),
  saveGoal: vi.fn(),
  createGoal: vi.fn(),
  goalsDir: () => '/tmp/goals',
}));
vi.mock('../src/core/goals/focus.js', () => ({
  goalFocusActiveThreshold: missionMocks.goalFocusActiveThreshold,
}));
vi.mock('../src/core/goals/advance.js', () => ({ progressOf: vi.fn() }));
vi.mock('../src/core/goals/completion.js', () => ({
  createProposalMilestoneCompletionPredicate: missionMocks.createProposalMilestoneCompletionPredicate,
}));
vi.mock('../src/core/sandbox/policy.js', () => ({
  listEnrolled: vi.fn(() => []),
  readEnrollmentRegistry: missionMocks.readEnrollmentRegistry,
  setKill: vi.fn(),
  isEnrolled: () => false,
  assertMayMutate: vi.fn(),
  enroll: vi.fn(),
  unenroll: vi.fn(),
  killSwitchOn: () => false,
  enrollmentPath: () => '/tmp/e.json',
  killSwitchPath: () => '/tmp/KILL',
}));

// Stable, side-effect-free stand-ins for api.ts transitive dependencies.
vi.mock('../src/core/dashboard.js', () => ({ buildSnapshot: vi.fn(async () => ({})) }));
vi.mock('../src/core/run/orchestrator.js', () => ({ listRuns: vi.fn(() => []), loadRun: vi.fn(() => null), runGoal: vi.fn() }));
vi.mock('../src/core/swarm/store.js', () => ({ listSwarms: vi.fn(() => []), loadSwarm: vi.fn(() => null) }));
vi.mock('../src/core/observability/rollup.js', () => ({ buildRollup: vi.fn(() => ({})) }));
vi.mock('../src/core/genome/store.js', () => ({ loadGenome: vi.fn(() => []) }));
vi.mock('../src/core/genome/recall.js', () => ({ recall: vi.fn(async () => []) }));
vi.mock('../src/core/inbox/store.js', () => ({ listProposals: vi.fn(() => []), loadProposal: vi.fn(() => null), setStatus: vi.fn() }));
vi.mock('../src/core/fleet/status.js', () => ({ buildFleetStatus: vi.fn(async () => ({})), readFleetDaemonStatus: vi.fn(() => null) }));
vi.mock('../src/core/web/control.js', () => ({ buildControlSnapshot: vi.fn(async () => ({})), buildFleetActivity: vi.fn(async () => ({})) }));
vi.mock('../src/cli/open.js', () => ({ openInEditor: vi.fn(), openInFinder: vi.fn(), openInTerminal: vi.fn(), editorDeepLink: vi.fn((path: string) => path) }));

import { handleApi } from '../src/core/web/api.js';

function baseConfig() {
  return {
    version: 1,
    roots: ['/tmp'],
    editor: 'cursor',
    staleDays: 30,
    categories: {},
    tidyRules: [],
    keepers: [],
    models: { lmstudio: 'http://localhost:1234', ollama: 'http://localhost:11434', providerChain: [] },
    telemetry: {},
    tools: {},
  };
}

interface CapturedResponse { statusCode: number; body: string; }

function request(method = 'GET'): { req: IncomingMessage; res: ServerResponse; captured: CapturedResponse } {
  const captured = { statusCode: 200, body: '' };
  const req = new EventEmitter() as IncomingMessage;
  req.method = method;
  req.url = '/api/vision/mission';
  req.headers = {};
  process.nextTick(() => req.emit('end'));
  const res = {
    headersSent: false,
    writeHead(status: number) { captured.statusCode = status; this.headersSent = true; },
    end(data?: string) { if (data) captured.body += data; },
    write() { return true; },
  } as unknown as ServerResponse;
  return { req, res, captured };
}

async function getMission(method = 'GET'): Promise<{ statusCode: number; body: any }> {
  const { req, res, captured } = request(method);
  await handleApi(req, res, baseConfig() as any, { token: 'test', allowDispatch: true });
  return { statusCode: captured.statusCode, body: JSON.parse(captured.body) };
}

let tmpHome: string;
let previousHome: string | undefined;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'ashlr-m492-'));
  previousHome = process.env.HOME;
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
  missionMocks.readLatestBriefingDetailed.mockReturnValue({
    briefing: null, sourceState: 'missing', sourcePresent: false, complete: true,
    reason: 'briefing-directory-missing', scannedEntries: 0, candidateFiles: 0,
    unreadableFiles: 0, limitExceeded: false,
  });
  missionMocks.listGoalsDetailed.mockReturnValue({
    goals: [], sourceState: 'missing', sourcePresent: false, complete: true,
    scannedFiles: 0, unreadableFiles: 0, limitExceeded: false,
  });
  missionMocks.readEnrollmentRegistry.mockReturnValue({ state: 'ready', repos: [], reason: 'missing-empty' });
  missionMocks.createProposalMilestoneCompletionPredicate.mockReturnValue(() => false);
  missionMocks.goalFocusActiveThreshold.mockReturnValue(1);
  missionMocks.previewBriefingAdoption.mockReturnValue({
    proposedCount: 0, createCount: 0, skipCount: 0, entries: [],
  });
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  rmSync(tmpHome, { recursive: true, force: true });
  vi.clearAllMocks();
});

function seedBriefingFile(contents = '{}'): void {
  const dir = join(tmpHome, '.ashlr', 'vision', 'briefings');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, '2026-08-09.json'), contents, 'utf8');
}

function briefing() {
  return {
    generatedAt: '2026-08-09T12:00:00.000Z',
    project: '/Users/masonwyatt/Desktop/github/dev-tools/ashlr-hub',
    currentState: 'The fleet ships useful work, but evidence is fragmented.',
    gapToVision: 'Humans cannot yet inspect a durable outcome contract.',
    proposedEvolution: { vision: 'Outcome-oriented autonomy' },
    recommendedDirection: ['Make one bounded mission legible end to end.'],
    newProblems: ['Evidence can be stale.'],
    questionsForMason: ['Is this the right business outcome?'],
    proposedGoals: [{
      key: 'contract',
      objective: 'Build the outcome contract',
      rationale: 'Make intent inspectable.',
      targetRepo: '/Users/masonwyatt/Desktop/github/dev-tools/ashlr-hub',
      dependsOn: [],
      deliverable: 'A read-only Outcome Room',
      acceptanceEvidence: ['API and UI tests pass'],
      riskClass: 'low',
      humanGate: true,
      outcome: {
        desiredOutcome: 'Mason can understand the fleet plan in one minute.',
        successSignals: ['The dependency order is explicit.'],
        guardrails: ['No execute control exists.'],
        internalMemo: 'sk-nested-secret',
      },
      apiKey: 'sk-super-secret',
    }],
  };
}

describe('GET /api/vision/mission', () => {
  it('returns an explicit missing state instead of a fabricated healthy empty', async () => {
    const result = await getMission();
    expect(result.statusCode).toBe(200);
    expect(result.body).toMatchObject({
      schemaVersion: 1,
      state: 'missing',
      authority: 'planning-only',
      briefing: null,
      preview: null,
      sources: { briefing: { sourceState: 'missing', sourcePresent: false, complete: true } },
    });
  });

  it('returns the briefing and compiler preview without concrete project paths or secrets', async () => {
    seedBriefingFile();
    missionMocks.readLatestBriefingDetailed.mockReturnValue({
      briefing: briefing(), sourceState: 'healthy', sourcePresent: true, complete: true,
      reason: 'latest-briefing-readable', scannedEntries: 1, candidateFiles: 1,
      unreadableFiles: 0, limitExceeded: false,
    });
    missionMocks.readEnrollmentRegistry.mockReturnValue({
      state: 'ready',
      repos: ['/Users/masonwyatt/Desktop/github/dev-tools/ashlr-hub'],
      reason: 'healthy',
    });
    missionMocks.previewBriefingAdoption.mockReturnValue({
      briefingGeneratedAt: '2026-08-09T12:00:00.000Z',
      goalSourceState: 'healthy',
      activeThreshold: 1,
      openGoalCount: 0,
      availableSlots: 1,
      proposedCount: 1,
      createCount: 1,
      skippedCount: 0,
      missionGraph: {
        state: 'valid', digest: 'a'.repeat(64), issues: [], status: 'complete',
        nodes: [{ key: 'contract', status: 'complete', blockedBy: [], internalReceipt: 'sk-lifecycle-secret' }],
      },
      entries: [{
        index: 0,
        objective: 'Build the outcome contract',
        targetRepo: '/Users/masonwyatt/Desktop/github/dev-tools/ashlr-hub',
        project: '/Users/masonwyatt/Desktop/github/dev-tools/ashlr-hub',
        disposition: 'create',
        reason: 'ready',
      }],
    });

    const result = await getMission();
    expect(result.body.state).toBe('healthy');
    expect(result.body.authority).toBe('planning-only');
    expect(result.body.briefing.project).toBe('ashlr-hub');
    expect(result.body.briefing.proposedGoals[0].targetRepo).toBe('ashlr-hub');
    expect(result.body.briefing.proposedGoals[0]).not.toHaveProperty('apiKey');
    expect(result.body.briefing.proposedGoals[0].outcome).not.toHaveProperty('internalMemo');
    expect(result.body.preview.entries[0]).toMatchObject({ targetRepo: 'ashlr-hub', disposition: 'create' });
    expect(result.body.preview.entries[0]).not.toHaveProperty('project');
    expect(result.body.preview.missionGraph).toMatchObject({
      state: 'valid', status: 'complete',
      nodes: [{ key: 'contract', status: 'complete', blockedBy: [] }],
    });
    expect(result.body.preview.missionGraph.nodes[0]).not.toHaveProperty('internalReceipt');
    expect(JSON.stringify(result.body)).not.toContain('/Users/masonwyatt/Desktop');
    expect(JSON.stringify(result.body)).not.toContain('sk-super-secret');
    expect(JSON.stringify(result.body)).not.toContain('sk-nested-secret');
    expect(JSON.stringify(result.body)).not.toContain('sk-lifecycle-secret');
    expect(missionMocks.previewBriefingAdoption).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ activeThreshold: 1, goalRealized: expect.any(Function) }),
    );
  });

  it('bounds and allowlists public lifecycle nodes and blocked-by keys', async () => {
    seedBriefingFile();
    missionMocks.readLatestBriefingDetailed.mockReturnValue({
      briefing: briefing(), sourceState: 'healthy', sourcePresent: true, complete: true,
      reason: 'latest-briefing-readable', scannedEntries: 1, candidateFiles: 1,
      unreadableFiles: 0, limitExceeded: false,
    });
    missionMocks.previewBriefingAdoption.mockReturnValue({
      briefingGeneratedAt: '2026-08-09T12:00:00.000Z', goalSourceState: 'healthy',
      activeThreshold: 1, openGoalCount: 0, availableSlots: 1,
      proposedCount: 1, createCount: 0, skippedCount: 1, entries: [],
      missionGraph: {
        state: 'valid', digest: 'b'.repeat(64), issues: [], status: 'in-progress',
        nodes: Array.from({ length: 25 }, (_, index) => ({
          key: `node-${index}`, status: 'blocked',
          blockedBy: Array.from({ length: 9 }, (_unused, dependency) => `dep-${dependency}`),
          internalReceipt: 'must-not-cross-api',
        })),
      },
    });

    const result = await getMission();
    expect(result.body.preview.missionGraph.nodes).toHaveLength(24);
    expect(result.body.preview.missionGraph.nodes[0]).toEqual({
      key: 'node-0', status: 'blocked',
      blockedBy: ['dep-0', 'dep-1', 'dep-2', 'dep-3', 'dep-4', 'dep-5', 'dep-6', 'dep-7'],
    });
    expect(JSON.stringify(result.body)).not.toContain('must-not-cross-api');
  });

  it('fails closed when enrollment authority is degraded', async () => {
    seedBriefingFile();
    missionMocks.readLatestBriefingDetailed.mockReturnValue({
      briefing: briefing(), sourceState: 'healthy', sourcePresent: true, complete: true,
      reason: 'latest-briefing-readable', scannedEntries: 1, candidateFiles: 1,
      unreadableFiles: 0, limitExceeded: false,
    });
    missionMocks.readEnrollmentRegistry.mockReturnValue({ state: 'degraded', reason: 'malformed-registry' });

    const result = await getMission();
    expect(result.body).toMatchObject({
      state: 'degraded',
      authority: 'planning-only',
      preview: null,
      sources: {
        enrollment: {
          sourceState: 'degraded', sourcePresent: true, complete: false,
          reason: 'malformed-registry',
        },
      },
    });
    expect(missionMocks.previewBriefingAdoption).not.toHaveBeenCalled();
  });

  it('reports an invalid mission graph as degraded instead of healthy', async () => {
    seedBriefingFile();
    missionMocks.readLatestBriefingDetailed.mockReturnValue({
      briefing: briefing(), sourceState: 'healthy', sourcePresent: true, complete: true,
      reason: 'latest-briefing-readable', scannedEntries: 1, candidateFiles: 1,
      unreadableFiles: 0, limitExceeded: false,
    });
    missionMocks.previewBriefingAdoption.mockReturnValue({
      proposedCount: 1, createCount: 0, skipCount: 1,
      missionGraph: { state: 'invalid', digest: null, issues: ['cyclic-dependency:nodes'] },
      entries: [{ index: 0, objective: 'Build the outcome contract', targetRepo: null, project: null, disposition: 'skip', reason: 'mission-graph-invalid' }],
    });

    const result = await getMission();
    expect(result.body).toMatchObject({
      state: 'degraded',
      preview: { missionGraph: { state: 'invalid', issues: ['cyclic-dependency:nodes'] } },
    });
  });

  it('reports degraded when briefing records exist but none are readable', async () => {
    seedBriefingFile('{broken');
    missionMocks.readLatestBriefingDetailed.mockReturnValue({
      briefing: null, sourceState: 'degraded', sourcePresent: true, complete: false,
      reason: 'briefing-records-unreadable', scannedEntries: 1, candidateFiles: 1,
      unreadableFiles: 1, limitExceeded: false,
    });
    const result = await getMission();
    expect(result.body).toMatchObject({
      state: 'degraded',
      authority: 'planning-only',
      briefing: null,
      preview: null,
      sources: { briefing: { sourceState: 'degraded', sourcePresent: true, complete: false } },
    });
  });

  it('has no mutation route even when dispatch is enabled', async () => {
    const result = await getMission('POST');
    expect(result.statusCode).toBe(404);
    expect(missionMocks.previewBriefingAdoption).not.toHaveBeenCalled();
  });
});

describe('Mission Outcome Room static UI contract', () => {
  const appSource = readFileSync(join(process.cwd(), 'src/core/web/public/app.js'), 'utf8');
  const cssSource = readFileSync(join(process.cwd(), 'src/core/web/public/styles.css'), 'utf8');

  it('loads the planning projection beside goals and renders it before goal cards', () => {
    expect(appSource).toContain("apiFetch('/api/vision/mission')");
    expect(appSource.indexOf('buildMissionOutcomeRoom(state.mission)')).toBeLessThan(appSource.indexOf("const grid = el('div', { cls: 'goals-grid' })"));
    expect(appSource).toContain('Planning only · no execution authority');
    expect(appSource).toContain('Mission contract · read-only');
    expect(appSource).toContain('No strategic briefing on record');
  });

  it('uses semantic headings and lists, explicit state text, and preserves focus', () => {
    expect(appSource).toContain("el('section',");
    expect(appSource).toContain("el('ol', { cls: 'mission-outcome__rail' })");
    expect(appSource).toContain("el('ul', {})");
    expect(appSource).toContain("role: 'status'");
    expect(appSource).toContain('Compiler preview: held');
    expect(appSource).toContain('Mission graph invalid. All planning nodes are held');
    expect(appSource).toContain('active-goal limit reached');
    expect(appSource).toContain('Mission lifecycle:');
    expect(appSource).toContain('Realized from verified goal evidence');
    expect(appSource).toContain('blocked by');
    expect(appSource).toContain("'data-focus-key': `goal-${g.id}-milestones`");
    expect(appSource).toContain('restoreMainViewState(main, viewState)');
    expect(appSource).toContain("role: 'progressbar'");
    expect(appSource).toContain("goalProgressBar(g.progress?.fractionDone ?? 0, g.objective)");
    expect(appSource).toContain("`${objective || 'Goal'} completion`");
  });

  it('contains no approve/execute control and keeps the dependency rail responsive', () => {
    const roomStart = appSource.indexOf('function buildMissionOutcomeRoom');
    const roomEnd = appSource.indexOf('function renderGoals', roomStart);
    const roomSource = appSource.slice(roomStart, roomEnd);
    expect(roomSource).not.toContain('apiPost(');
    expect(roomSource).not.toContain("el('button'");
    expect(cssSource).toContain('.mission-outcome__rail::before');
    expect(cssSource).toContain('@media (max-width: 800px)');
    expect(cssSource).toContain('.mission-outcome__evidence-grid { grid-template-columns: 1fr;');
    expect(cssSource).not.toContain('animation: mission');
  });
});
