import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  agentSemanticEventId,
  agentSemanticModelFamily,
  agentSemanticSubjectRef,
  agentRunSemanticEvents,
  defineAgentSemanticEvents,
  sanitizeAgentSemanticEvents,
} from '../src/core/learning/agent-semantic-events.js';
import {
  decisionsDir,
  readDecisions,
  readDecisionsDetailed,
  recordDecision,
} from '../src/core/fleet/decisions-ledger.js';
import {
  agentActionsDir,
  readAgentActions,
  readAgentActionsDetailed,
  readAgentWorkspaceDetailed,
  recordAgentAction,
  summarizeAgentWorkspace,
  type AgentActionEvent,
} from '../src/core/fleet/agent-action-ledger.js';
import { managerSemanticEvents } from '../src/core/fleet/manager.js';
import { evaluateVerificationGate } from '../src/core/inbox/merge.js';
import type { AgentSemanticEventV1, Proposal } from '../src/core/types.js';

const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;
const originalAshlrHome = process.env.ASHLR_HOME;
const PROPOSAL_ID = 'prop-m435abc1-000001-aaaaaaaaaaaaaaaaaaaaaaaa';
let home: string;

function restore(name: 'HOME' | 'USERPROFILE' | 'ASHLR_HOME', value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function observation(sequence = 1): AgentSemanticEventV1 {
  const drafts = Array.from({ length: sequence }, () => ({
    kind: 'observation' as const,
    predicate: 'manager.score.correctness',
    metricCode: 'manager.correctness',
    value: 4,
    unit: 'score-1-5' as const,
  }));
  return defineAgentSemanticEvents({
    subjectRef: agentSemanticSubjectRef('proposal', PROPOSAL_ID),
    producerRole: 'manager',
    producerModelFamily: 'openai',
    producerVersion: 'test-semantic-v1',
  }, drafts)[sequence - 1]!;
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-m435-'));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.ASHLR_HOME = path.join(home, '.ashlr');
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  restore('HOME', originalHome);
  restore('USERPROFILE', originalUserProfile);
  restore('ASHLR_HOME', originalAshlrHome);
});

describe('M435 metadata-only agent semantic events', () => {
  it('builds deterministic opaque identities and a closed six-kind union', () => {
    const subjectRef = agentSemanticSubjectRef('proposal', PROPOSAL_ID);
    const events = defineAgentSemanticEvents({
      subjectRef,
      producerRole: 'manager',
      producerModelFamily: 'openai',
      producerVersion: 'test-semantic-v1',
    }, [
      { kind: 'intent', predicate: 'agent.intent.execute', objectiveCode: 'proposal.evaluate' },
      { kind: 'observation', predicate: 'manager.score.value', metricCode: 'manager.value', value: 4, unit: 'score-1-5' },
      { kind: 'prediction', predicate: 'manager.outcome.positive', outcomeCode: 'proposal.positive-outcome', probability: 0.8, horizon: 'post-merge' },
      { kind: 'action', predicate: 'verifier.run', actionCode: 'verification.execute', status: 'completed' },
      { kind: 'evidence', predicate: 'verification.result', evidenceCode: 'verification.merge-profile', result: 'supports' },
      { kind: 'challenge', predicate: 'manager.verdict.review', challengeCode: 'verdict.review', severity: 'medium' },
    ]);

    expect(sanitizeAgentSemanticEvents(events)).toEqual(events);
    expect(subjectRef).toBe(`proposal:${PROPOSAL_ID}`);
    expect(() => agentSemanticSubjectRef('proposal', 'private proposal title and goal')).toThrow();
    expect(() => agentSemanticSubjectRef('proposal', 'private-proposal-title-and-goal')).toThrow();
    const { eventId, ...unsigned } = events[0]!;
    expect(agentSemanticEventId(unsigned)).toBe(eventId);
  });

  it('uses bounded model tokens and rejects carrier-family mismatches', () => {
    expect(agentSemanticModelFamily('anthropic/claude-opus-4')).toBe('claude');
    expect(agentSemanticModelFamily('openai/gpt-5.5-codex')).toBe('openai');
    expect(agentSemanticModelFamily('notgpt-compatible')).toBe('unknown');
    expect(agentSemanticModelFamily('ollama/qwen3-coder')).toBe('local');
    const event = observation();
    expect(sanitizeAgentSemanticEvents([event], event.subjectRef, 'claude')).toBeUndefined();
    expect(sanitizeAgentSemanticEvents([event], event.subjectRef, 'openai', {
      producerRole: 'manager', producerVersion: 'manager-semantic-v1',
    })).toBeUndefined();
  });

  it('separates independent occurrences while preserving one batch identity', () => {
    const producer = {
      subjectRef: agentSemanticSubjectRef('proposal', PROPOSAL_ID),
      producerRole: 'manager' as const,
      producerModelFamily: 'openai' as const,
      producerVersion: 'test-semantic-v1' as const,
    };
    const draft = [{
      kind: 'action' as const,
      predicate: 'manager.judge.completed',
      actionCode: 'manager.judge',
      status: 'completed' as const,
    }];
    const first = defineAgentSemanticEvents(producer, draft);
    const second = defineAgentSemanticEvents(producer, draft);
    expect(first[0]?.sourceRef).not.toBe(second[0]?.sourceRef);
    expect(first[0]?.eventId).not.toBe(second[0]?.eventId);
    expect(new Set(first.map((event) => event.sourceRef)).size).toBe(1);
  });

  it('remints caller occurrence bits at the durable decision boundary', () => {
    const [input] = defineAgentSemanticEvents({
      subjectRef: agentSemanticSubjectRef('proposal', PROPOSAL_ID),
      producerRole: 'manager', producerModelFamily: 'openai',
      producerVersion: 'manager-semantic-v1',
    }, [{
      kind: 'action', predicate: 'manager.judge.completed',
      actionCode: 'manager.judge', status: 'completed',
    }]);
    recordDecision({
      ts: '2026-07-16T20:00:00.000Z', proposalId: PROPOSAL_ID,
      model: 'gpt-5.5', action: 'judged', semanticEvents: [input!],
      semanticEventsState: 'rejected',
    });
    const [persisted] = readDecisions();
    expect(persisted?.semanticEvents).toHaveLength(1);
    expect(persisted?.semanticEventsState).toBeUndefined();
    expect(persisted?.semanticEvents?.[0]?.sourceRef).not.toBe(input?.sourceRef);
    expect(persisted?.semanticEvents?.[0]?.eventId).not.toBe(input?.eventId);
  });

  it('persists run-bound agent work state without requiring a proposal identity', () => {
    const runId = 'run-m435-agent-terminal';
    const semanticEvents = agentRunSemanticEvents({
      runId,
      model: 'ollama/qwen3-coder',
      status: 'done',
      proposalCreated: false,
    });
    recordAgentAction({
      schemaVersion: 1,
      ts: '2026-07-16T20:00:02.000Z',
      actor: 'agent',
      kind: 'maintenance',
      outcome: 'no-proposal',
      action: 'sandboxed-engine:run',
      summary: 'closed metadata carrier',
      runId,
      model: 'ollama/qwen3-coder',
      semanticEvents,
    });

    const [persisted] = readAgentActions();
    expect(persisted?.proposalId).toBeUndefined();
    expect(persisted?.semanticEventsState).toBeUndefined();
    expect(persisted?.semanticEvents?.map((event) => event.kind))
      .toEqual(['intent', 'action', 'observation']);
    expect(persisted?.semanticEvents).toEqual([
      expect.objectContaining({
        subjectRef: `run:${runId}`,
        producerRole: 'agent',
        objectiveCode: 'work.execute',
      }),
      expect.objectContaining({ actionCode: 'agent.run', status: 'completed' }),
      expect.objectContaining({ metricCode: 'agent.proposal.created', value: 0, unit: 'boolean' }),
    ]);
    expect(persisted?.semanticEvents?.[0]?.sourceRef).not.toBe(semanticEvents[0]?.sourceRef);
    expect(JSON.stringify(persisted?.semanticEvents)).not.toMatch(
      /prompt|reasoning|rationale|diff|stdout|stderr|environment|file.?content/i,
    );
  });

  it('rejects run semantics whose opaque subject does not match the carrier run', () => {
    const semanticEvents = agentRunSemanticEvents({
      runId: 'run-m435-wrong-subject',
      model: 'gpt-5.5-codex',
      status: 'failed',
    });
    recordAgentAction({
      schemaVersion: 1,
      ts: '2026-07-16T20:00:03.000Z',
      actor: 'agent',
      kind: 'maintenance',
      outcome: 'failed',
      action: 'sandboxed-engine:run',
      summary: 'closed metadata carrier',
      runId: 'run-m435-actual-subject',
      model: 'gpt-5.5-codex',
      semanticEvents,
    });

    const [persisted] = readAgentActions();
    expect(persisted?.semanticEvents).toBeUndefined();
    expect(persisted?.semanticEventsState).toBe('rejected');
  });

  it('keeps nested run summaries bound to their carrier run identity', () => {
    const runId = 'run-m435-summary-owner';
    recordAgentAction({
      schemaVersion: 1,
      ts: '2026-07-16T20:00:03.500Z',
      actor: 'agent',
      kind: 'dispatch',
      outcome: 'no-proposal',
      action: 'sandboxed-engine:run',
      summary: 'closed metadata carrier',
      runId,
      runEventSummary: {
        runId: 'run-m435-summary-other',
        outcome: 'no-proposal',
        proposalCreated: false,
      },
    });

    const [persisted] = readAgentActions();
    expect(persisted).toMatchObject({ runId, trajectoryId: `run:${runId}` });
    expect(persisted?.runEventSummary).toBeUndefined();

    fs.writeFileSync(path.join(agentActionsDir(), '2026-07-16.jsonl'), `${JSON.stringify({
      schemaVersion: 1,
      ts: '2026-07-16T20:00:03.600Z',
      actor: 'agent', kind: 'dispatch', outcome: 'no-proposal',
      action: 'sandboxed-engine:run', summary: 'tampered metadata carrier',
      runId,
      runEventSummary: { runId: 'run-m435-summary-other', outcome: 'no-proposal' },
    })}\n`, { flag: 'a', mode: 0o600 });

    expect(readAgentActionsDetailed({ requireComplete: true })).toMatchObject({
      sourceState: 'degraded', complete: false, invalidRows: 1,
    });
    expect(readAgentActions({ requireComplete: true })).toEqual([]);
  });

  it('projects replay-idempotent run signals and collapses contradictions to unknown', () => {
    const runId = 'run-m435-workspace-signal';
    const completed = agentRunSemanticEvents({
      runId,
      model: 'ollama/qwen3-coder',
      status: 'done',
      proposalCreated: false,
    });
    const base: AgentActionEvent = {
      schemaVersion: 1,
      ts: '2026-07-16T20:00:04.000Z',
      actor: 'agent',
      kind: 'maintenance',
      outcome: 'no-proposal',
      action: 'sandboxed-engine:run',
      summary: 'closed metadata carrier',
      runId,
      model: 'ollama/qwen3-coder',
      semanticEvents: completed,
    };
    expect(summarizeAgentWorkspace([base, { ...base }]).runSignals).toEqual([{
      runId,
      terminal: 'completed',
      proposal: 'not-created',
      latestAt: base.ts,
    }]);

    const blocked = agentRunSemanticEvents({
      runId,
      model: 'ollama/qwen3-coder',
      status: 'aborted',
      proposalCreated: true,
    });
    const conflicted = summarizeAgentWorkspace([
      base,
      { ...base, ts: '2026-07-16T20:00:05.000Z', outcome: 'blocked', semanticEvents: blocked },
    ]);
    expect(conflicted.runSignals).toEqual([{
      runId,
      terminal: 'unknown',
      proposal: 'unknown',
      latestAt: '2026-07-16T20:00:05.000Z',
    }]);
    expect(JSON.stringify(conflicted.runSignals)).not.toMatch(
      /summary|prompt|reasoning|rationale|diff|stdout|stderr|environment|file.?content/i,
    );
  });

  it('excludes mismatched run subjects from the workspace signal projection', () => {
    const semanticEvents = agentRunSemanticEvents({
      runId: 'run-m435-signal-wrong',
      model: 'gpt-5.5-codex',
      status: 'done',
    });
    const workspace = summarizeAgentWorkspace([{
      schemaVersion: 1,
      ts: '2026-07-16T20:00:06.000Z',
      actor: 'agent',
      kind: 'maintenance',
      outcome: 'ok',
      action: 'sandboxed-engine:run',
      summary: 'closed metadata carrier',
      runId: 'run-m435-signal-actual',
      model: 'gpt-5.5-codex',
      semanticEvents,
    }]);
    expect(workspace.runSignalsState).toBe('available');
    expect(workspace.runSignals).toEqual([]);
  });

  it('withholds run signals when the physical agent-action source is degraded', () => {
    const runId = 'run-m435-degraded-signal';
    const recordedAt = new Date().toISOString();
    recordAgentAction({
      schemaVersion: 1,
      ts: recordedAt,
      actor: 'agent',
      kind: 'maintenance',
      outcome: 'ok',
      action: 'sandboxed-engine:run',
      summary: 'closed metadata carrier',
      runId,
      model: 'gpt-5.5-codex',
      semanticEvents: agentRunSemanticEvents({
        runId,
        model: 'gpt-5.5-codex',
        status: 'done',
      }),
    });
    fs.appendFileSync(
      path.join(agentActionsDir(), `${recordedAt.slice(0, 10)}.jsonl`),
      `${JSON.stringify({ schemaVersion: 1, invalid: true })}\n`,
    );

    const detailed = readAgentWorkspaceDetailed({ windowMs: 48 * 60 * 60 * 1000 });
    expect(detailed.sourceQuality).toMatchObject({ sourceState: 'degraded', complete: false });
    expect(detailed.workspace.runSignalsState).toBe('withheld');
    expect(detailed.workspace.runSignals).toEqual([]);
  });

  it('drops malformed nested events without dropping legacy carrier rows', () => {
    const valid = observation();
    const leaked = { ...observation(2), prompt: 'sk-live-secret raw prompt' };
    const forged = { ...observation(3), value: 1 };
    const invalidProbability = defineAgentSemanticEvents({
      subjectRef: valid.subjectRef,
      producerRole: 'manager',
      producerModelFamily: 'openai',
      producerVersion: 'test-semantic-v1',
    }, [{
      kind: 'prediction', predicate: 'manager.outcome.positive',
      outcomeCode: 'proposal.positive-outcome', probability: 0.8, horizon: 'post-merge',
    }])[0]!;
    (invalidProbability as { probability: number }).probability = 2;

    expect(sanitizeAgentSemanticEvents([valid, leaked, forged, invalidProbability])).toBeUndefined();

    recordDecision({
      ts: '2026-07-16T20:00:00.000Z',
      proposalId: PROPOSAL_ID,
      model: 'gpt-5.5',
      action: 'judged',
      semanticEvents: [valid, leaked as AgentSemanticEventV1],
    });
    const [decision] = readDecisions();
    expect(decision).toBeDefined();
    expect(decision?.semanticEvents).toBeUndefined();
    expect(decision?.semanticEventsState).toBe('rejected');

    recordAgentAction({
      schemaVersion: 1,
      ts: '2026-07-16T20:00:01.000Z',
      actor: 'judge',
      kind: 'judge',
      outcome: 'judged',
      action: 'manager:judge',
      summary: 'metadata carrier',
      proposalId: PROPOSAL_ID,
      model: 'gpt-5.5',
      semanticEvents: [valid, leaked as AgentSemanticEventV1],
    });
    const [action] = readAgentActions();
    expect(action).toBeDefined();
    expect(action?.semanticEvents).toBeUndefined();
    expect(action?.semanticEventsState).toBe('rejected');
    expect((readDecisions() as Array<typeof decision> & {
      sourceQuality?: { sourceState: string; semanticRejectedRows?: number };
    }).sourceQuality).toMatchObject({ sourceState: 'healthy', semanticRejectedRows: 1 });
    expect((readAgentActions() as Array<typeof action> & {
      sourceQuality?: { sourceState: string; semanticRejectedRows?: number };
    }).sourceQuality).toMatchObject({ sourceState: 'healthy', semanticRejectedRows: 1 });
    expect(JSON.stringify([decision, action])).not.toContain('sk-live-secret');
  });

  it('rejects 100,000 seeded raw-content canaries', () => {
    const valid = observation();
    for (let index = 0; index < 100_000; index += 1) {
      const candidate = {
        ...valid,
        [index % 2 === 0 ? 'content' : 'stdout']: `CANARY_${index}`,
      };
      expect(sanitizeAgentSemanticEvents([candidate])).toBeUndefined();
    }
  });

  it('projects a bounded Manager action and challenge without rationale or synthetic calibration', () => {
    const events = managerSemanticEvents({
      proposalId: PROPOSAL_ID,
      verdict: 'harmful',
      value: 2,
      correctness: 1,
      scope: 5,
      alignment: 1,
      wouldMerge: false,
    });
    expect(events.map((event) => event.kind)).toEqual(['action', 'challenge']);
    expect(events[0]).toMatchObject({ actionCode: 'manager.judge', status: 'completed' });
    expect(events[1]).toMatchObject({ severity: 'critical', challengeCode: 'verdict.harmful' });
    expect(JSON.stringify(events)).not.toMatch(/rationale|reasoning|prompt|diff|stdout|stderr/i);
    const repeated = managerSemanticEvents({
      proposalId: PROPOSAL_ID,
      verdict: 'harmful', value: 2, correctness: 1, scope: 5, alignment: 1, wouldMerge: false,
    });
    expect(repeated[0]?.eventId).not.toBe(events[0]?.eventId);
  });

  it('enforces exact cardinality, sequence, and numeric domains', () => {
    const producer = {
      subjectRef: agentSemanticSubjectRef('proposal', PROPOSAL_ID),
      producerRole: 'manager' as const,
      producerModelFamily: 'openai' as const,
      producerVersion: 'test-semantic-v1' as const,
    };
    const sixteen = defineAgentSemanticEvents(producer, Array.from({ length: 16 }, () => ({
      kind: 'action' as const,
      predicate: 'manager.judge.completed',
      actionCode: 'manager.judge',
      status: 'completed' as const,
    })));
    expect(sanitizeAgentSemanticEvents(sixteen, producer.subjectRef)).toHaveLength(16);
    expect(() => defineAgentSemanticEvents(producer, Array.from({ length: 17 }, () => ({
      kind: 'action' as const,
      predicate: 'manager.judge.completed',
      actionCode: 'manager.judge',
      status: 'completed' as const,
    })))).toThrow();
    expect(() => defineAgentSemanticEvents(producer, [{
      kind: 'action', predicate: 'attacker.covert.channel',
      actionCode: 'manager.judge', status: 'completed',
    } as never])).toThrow();
    expect(() => defineAgentSemanticEvents({
      ...producer,
      producerRole: 'agent',
      producerVersion: 'agent-semantic-v1',
    }, [{
      kind: 'action', predicate: 'manager.judge.completed',
      actionCode: 'agent.run', status: 'completed',
    }])).toThrow();
    const badSequence = sixteen.map((event) => ({ ...event }));
    badSequence[1]!.sequence = 1;
    expect(sanitizeAgentSemanticEvents(badSequence, producer.subjectRef)).toBeUndefined();
    const badScore = { ...observation(), value: 0 };
    expect(sanitizeAgentSemanticEvents([badScore], producer.subjectRef)).toBeUndefined();
  });

  it('rejects whole conflicting batches and marks malformed persisted rows degraded', () => {
    const valid = observation();
    const duplicate = [valid, valid];
    const unknownCode = { ...valid, predicate: 'attacker.covert.channel' };
    expect(sanitizeAgentSemanticEvents(duplicate)).toBeUndefined();
    expect(sanitizeAgentSemanticEvents([unknownCode])).toBeUndefined();
    expect(sanitizeAgentSemanticEvents([])).toBeUndefined();

    fs.mkdirSync(decisionsDir(), { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(decisionsDir(), '2026-07-16.jsonl'), `${JSON.stringify({
      ts: '2026-07-16T20:00:00.000Z', proposalId: PROPOSAL_ID, action: 'judged', model: 'gpt-5.5',
      semanticEvents: duplicate,
    })}\n`, { mode: 0o600 });
    const decisions = readDecisionsDetailed({ requireComplete: true });
    expect(decisions).toMatchObject({
      sourceState: 'degraded', complete: false, invalidRows: 1, decisions: [],
    });

    fs.mkdirSync(agentActionsDir(), { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(agentActionsDir(), '2026-07-16.jsonl'), `${JSON.stringify({
      schemaVersion: 1,
      ts: '2026-07-16T20:00:00.000Z',
      actor: 'judge', kind: 'judge', outcome: 'judged',
      action: 'manager:judge', summary: 'metadata carrier', proposalId: PROPOSAL_ID, model: 'gpt-5.5',
      semanticEvents: duplicate,
    })}\n`, { mode: 0o600 });
    const actions = readAgentActionsDetailed({ requireComplete: true });
    expect(actions).toMatchObject({
      sourceState: 'degraded', complete: false, invalidRows: 1, events: [],
    });
  });

  it('cannot turn semantic evidence into merge authority', () => {
    const [semanticEvidence] = defineAgentSemanticEvents({
      subjectRef: agentSemanticSubjectRef('proposal', PROPOSAL_ID),
      producerRole: 'verifier', producerModelFamily: 'local', producerVersion: 'test-semantic-v1',
    }, [{
      kind: 'evidence', predicate: 'verification.result',
      evidenceCode: 'verification.merge-profile', result: 'supports',
    }]);
    const proposal = {
      id: PROPOSAL_ID, repo: null, origin: 'agent', kind: 'patch', title: 'opaque',
      summary: '', status: 'pending', createdAt: '2026-07-16T20:00:00.000Z',
    } as Proposal;
    const verdict = evaluateVerificationGate(proposal, {} as never, [{
      action: 'judged',
      semanticEvents: [semanticEvidence],
    }] as unknown as Parameters<typeof evaluateVerificationGate>[2]);
    expect(verdict.authorized).toBe(false);
  });

  it('degrades rows whose parent id changes during canonical scrubbing', () => {
    const rawProposalId = 'a'.repeat(64);
    const event = {
      schemaVersion: 1, eventId: `ase-${'b'.repeat(64)}`, sequence: 1, kind: 'action',
      predicate: 'manager.judge.completed', subjectRef: `proposal:${rawProposalId}`,
      producerRole: 'manager', producerModelFamily: 'openai', producerVersion: 'test-semantic-v1',
      sourceRef: 'occurrence:11111111-1111-4111-8111-111111111111',
      actionCode: 'manager.judge', status: 'completed',
    } as AgentSemanticEventV1;
    fs.mkdirSync(decisionsDir(), { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(decisionsDir(), '2026-07-16.jsonl'), `${JSON.stringify({
      ts: '2026-07-16T20:00:00.000Z', proposalId: rawProposalId, action: 'judged',
      semanticEvents: [event],
    })}\n`, { mode: 0o600 });
    expect(readDecisionsDetailed({ requireComplete: true })).toMatchObject({
      sourceState: 'degraded', complete: false, invalidRows: 1, decisions: [],
    });

    fs.mkdirSync(agentActionsDir(), { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(agentActionsDir(), '2026-07-16.jsonl'), `${JSON.stringify({
      schemaVersion: 1, ts: '2026-07-16T20:00:00.000Z', actor: 'judge',
      kind: 'judge', outcome: 'judged', action: 'manager:judge', summary: 'metadata',
      proposalId: rawProposalId, semanticEvents: [event],
    })}\n`, { mode: 0o600 });
    expect(readAgentActionsDetailed({ requireComplete: true })).toMatchObject({
      sourceState: 'degraded', complete: false, invalidRows: 1, events: [],
    });
  });
});
