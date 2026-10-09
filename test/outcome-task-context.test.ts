import { chmodSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appendTaskContextEvent, createTaskContextEvent } from '../src/core/context/task-temporal-context.js';
import { OutcomeCoordinator } from '../src/core/goals/outcome-coordinator.js';
import { outcomeDirectory } from '../src/core/goals/outcome-runtime.js';
import { OutcomeStore } from '../src/core/goals/outcome-store.js';
import { readOutcomeTaskContext, outcomeTaskContextRef, outcomeTaskPublicId, LOCAL_CONTEXT_ACCOUNT } from '../src/core/verse/outcome-task-context.js';
import * as actions from '../src/core/fleet/agent-action-ledger.js';

let home: string, repo: string;
beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'outcome-task-context-'))); chmodSync(home, 0o700);
  vi.stubEnv('HOME', home); vi.stubEnv('USERPROFILE', home); vi.stubEnv('ASHLR_HOME', join(home, '.ashlr'));
  mkdirSync(join(home, '.ashlr'), { mode: 0o700 }); repo = join(home, 'repo'); mkdirSync(repo);
  writeFileSync(join(home, '.ashlr', 'enrollment.json'), JSON.stringify({ repos: [repo] }), { mode: 0o600 });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); rmSync(home, { recursive: true, force: true }); });
function fixture() {
  const store = new OutcomeStore(outcomeDirectory('one')), coordinator = new OutcomeCoordinator(store);
  const scope = { desiredOutcome: 'Improve useful work', targetRepos: [repo], acceptance: ['Verified useful result'] };
  expect(coordinator.start({ commandId: 'start', expectedRevision: 0 }, 'one', scope).ok).toBe(true);
  expect(coordinator.refinePlan({ commandId: 'plan', expectedRevision: 1 }, { missionKey: 'one', title: 'Plan',
    objective: scope.desiredOutcome, createdAt: '2026-10-08T10:00:00.000Z',
    nodes: [{ kind: 'work', key: 'build', title: 'Build', objective: 'Improve implementation', deliverable: 'Useful change',
      riskClass: 'low', targetRepo: repo, dependsOn: [], acceptance: ['Meaningful tests pass'] }] },
  { sourceState: 'healthy', complete: true, repos: [repo] }).ok).toBe(true);
  const node = store.read().state!.nodes[store.read().state!.activeNodeIds[0]!]!;
  return { store, coordinator, node, input: { outcomeId: 'one', taskId: node.id } };
}
describe('actual outcome task context boundary', () => {
  it('reads exact saved task scope and honestly reports missing ledgers without writing on read', () => {
    const f = fixture(), before = readdirSync(join(home, '.ashlr'));
    const result = readOutcomeTaskContext(f.input);
    expect(result.ok).toBe(true); if (!result.ok) return;
    expect(result.context).toMatchObject({ outcomeId: 'one', taskId: outcomeTaskPublicId(f.node.id), active: true, coverage: { complete: false } });
    expect(result.context.current[0]).toMatchObject({ occurredAt: null, temporalResolution: 'unknown', source: { accountRef: LOCAL_CONTEXT_ACCOUNT } });
    expect(result.context.sources).toContainEqual({ source: 'private-task-context', sourceState: 'missing', complete: false, stopReasons: [] });
    expect(readdirSync(join(home, '.ashlr'))).toEqual(before);
  });
  it('refuses missing or cross-outcome tasks and unavailable/revoked enrollment', () => {
    const f = fixture();
    expect(readOutcomeTaskContext({ ...f.input, outcomeId: 'missing' })).toEqual({ ok: false, reason: 'not-found' });
    expect(readOutcomeTaskContext({ ...f.input, taskId: 'f'.repeat(64) })).toEqual({ ok: false, reason: 'not-found' });
    writeFileSync(join(home, '.ashlr', 'enrollment.json'), JSON.stringify({ repos: [] }), { mode: 0o600 });
    expect(readOutcomeTaskContext(f.input)).toEqual({ ok: false, reason: 'unenrolled' });
    writeFileSync(join(home, '.ashlr', 'enrollment.json'), '{broken', { mode: 0o600 });
    expect(readOutcomeTaskContext(f.input)).toEqual({ ok: false, reason: 'unknown-source' });
  });
  it('includes scoped private local evidence but never imports an unqualified external account', () => {
    const f = fixture(), taskRef = outcomeTaskContextRef('one', f.node.id);
    const record = createTaskContextEvent({ taskRef,
      source: { kind: 'project-memory', provider: 'phantom', accountRef: LOCAL_CONTEXT_ACCOUNT, objectRef: 'note', revisionRef: 'one' },
      sourceRefs: ['phantom:memory:note:one'], occurredAt: null, observedAt: new Date().toISOString(), validFrom: null,
      validUntil: null, kind: 'upsert', epistemic: 'recorded', content: 'Private scoped note.', supersedes: [] });
    const root = dirname(dirname(outcomeDirectory('one')));
    expect(appendTaskContextEvent({ root, event: record, stillAuthorized: () => true })).toBe('recorded');
    const other = createTaskContextEvent({ ...record, source: { ...record.source, accountRef: 'other-account' }, content: 'Other account inbox.' });
    expect(appendTaskContextEvent({ root, event: other, stillAuthorized: () => true })).toBe('recorded');
    const result = readOutcomeTaskContext(f.input); expect(result.ok).toBe(true); if (!result.ok) return;
    expect(result.context.current.some(item => item.content === 'Private scoped note.')).toBe(true);
    expect(JSON.stringify(result)).not.toContain('Other account inbox.');
  });
  it('selects only exact task attempt identities in their execution repository and preserves partial-read state', () => {
    const f = fixture(), node = f.node;
    expect(f.coordinator.linkMaterialization({ commandId: 'link', expectedRevision: 2 }, node.id, node.materialization.goalId,
      node.materialization.milestoneId, { stillAuthorized: () => true, matchesPersistedGoal: () => true }).ok).toBe(true);
    expect(f.coordinator.claimRunReady({ commandId: 'claim', expectedRevision: 3 }, node.id, repo, 'run-one',
      { stillAuthorized: () => true, executionRepoAllowed: () => true }).ok).toBe(true);
    const ledger = vi.spyOn(actions, 'readAgentActionsDetailed').mockImplementation(options => {
      const base: actions.AgentActionEvent = { schemaVersion: 1, ts: '2026-10-08T10:00:00Z', actor: 'agent', kind: 'dispatch',
        outcome: 'started', action: 'dispatch', summary: 'Run started.', repo, runId: 'run-one' };
      const rows = [base, { ...base, repo: join(home, 'other') }, { ...base, runId: 'unrelated' }];
      expect(options?.inspectionOnly).toBe(true);
      return { events: rows.filter(options!.filter!), sourceState: 'healthy', sourcePresent: true, complete: false,
        stopReasons: ['byte-limit'], filesRead: 1, bytesRead: 20, rowsScanned: 3, invalidRows: 0, unreadableFiles: 0 };
    });
    const result = readOutcomeTaskContext(f.input); expect(result.ok).toBe(true); if (!result.ok) return;
    expect(ledger).toHaveBeenCalledOnce();
    expect(result.context.current.filter(item => item.source.objectRef.startsWith('agent-action:'))).toHaveLength(1);
    expect(result.context.coverage).toMatchObject({ complete: false, stopReasons: expect.arrayContaining(['agent-action-ledger:byte-limit']) });
    expect(result.context.current.find(item => item.source.objectRef.startsWith('agent-action:'))!.content).toContain('started');
    expect(result.context.current.find(item => item.source.objectRef.startsWith('agent-action:'))!.content).not.toContain('complete');
  });
});
