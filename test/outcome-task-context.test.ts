import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appendTaskContextEvent, createTaskContextEvent } from '../src/core/context/task-temporal-context.js';
import { OutcomeCoordinator } from '../src/core/goals/outcome-coordinator.js';
import { outcomeDirectory } from '../src/core/goals/outcome-runtime.js';
import { OutcomeStore } from '../src/core/goals/outcome-store.js';
import { outcomeDigest } from '../src/core/goals/outcome-types.js';
import { readOutcomeTaskContext, outcomeTaskContextRef, outcomeTaskPublicId, LOCAL_CONTEXT_ACCOUNT } from '../src/core/verse/outcome-task-context.js';
import * as actions from '../src/core/fleet/agent-action-ledger.js';
import { callNativeTool, nativeToolSafety } from '../src/core/mcp-native.js';
import { loadConfig } from '../src/core/config.js';

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
  it('marks healthy-source historical queries incomplete and labels present metadata as current-read', () => {
    const f = fixture(), taskRef = outcomeTaskContextRef('one', f.node.id);
    const record = createTaskContextEvent({ taskRef,
      source: { kind: 'project-memory', provider: 'phantom', accountRef: LOCAL_CONTEXT_ACCOUNT, objectRef: 'past-note', revisionRef: 'one' },
      sourceRefs: ['phantom:memory:past-note:one'], occurredAt: '2026-10-08T09:00:00Z', observedAt: '2026-10-08T09:01:00Z',
      validFrom: null, validUntil: null, kind: 'upsert', epistemic: 'recorded', content: 'Recorded past note.', supersedes: [] });
    expect(appendTaskContextEvent({ root: dirname(dirname(outcomeDirectory('one'))), event: record, stillAuthorized: () => true })).toBe('recorded');
    vi.spyOn(actions, 'readAgentActionsDetailed').mockReturnValue({ events: [], sourceState: 'healthy', sourcePresent: true,
      complete: true, stopReasons: [], filesRead: 0, bytesRead: 0, rowsScanned: 0, invalidRows: 0, unreadableFiles: 0 });
    for (const cutoffs of [{ asOf: '2026-10-08T12:00:00Z' }, { observedThrough: '2026-10-08T12:00:00Z' }]) {
      const result = readOutcomeTaskContext({ ...f.input, ...cutoffs });
      expect(result.ok).toBe(true); if (!result.ok) continue;
      expect(result.context.sources.every(source => source.sourceState === 'healthy')).toBe(true);
      expect(result.context.coverage).toMatchObject({ complete: false, stopReasons: expect.arrayContaining([
        'outcome:unrecorded-historical-observation', 'agent-action-ledger:unrecorded-historical-observation']) });
      expect(result.context).toMatchObject({ metadataTemporalScope: 'current-read', outcomeRevision: 2, active: true });
      expect(result.context.snapshotObservedAt > '2026-10-08T12:00:00.000Z').toBe(true);
      expect(result.context.current.some(event => event.content === 'Recorded past note.')).toBe(true);
      if ('observedThrough' in cutoffs) expect(result.context.current.some(event => event.source.objectRef === taskRef)).toBe(false);
      else expect(result.context.current.find(event => event.source.objectRef === taskRef)).toMatchObject({ occurredAt: null, temporalResolution: 'unknown' });
    }
    const current = readOutcomeTaskContext(f.input);
    expect(current.ok).toBe(true); if (current.ok) expect(current.context.coverage.complete).toBe(true);
  });
  it('does not correlate repo A with the run or proposal identity from repo B, even with a matching work item', () => {
    const f = fixture(), otherRepo = join(home, 'other-repo'); mkdirSync(otherRepo);
    writeFileSync(join(home, '.ashlr', 'enrollment.json'), JSON.stringify({ repos: [repo, otherRepo] }), { mode: 0o600 });
    expect(f.coordinator.linkMaterialization({ commandId: 'link', expectedRevision: 2 }, f.node.id, f.node.materialization.goalId,
      f.node.materialization.milestoneId, { stillAuthorized: () => true, matchesPersistedGoal: () => true }).ok).toBe(true);
    expect(f.coordinator.claimRunReady({ commandId: 'claim', expectedRevision: 3 }, f.node.id, repo, 'run-a',
      { stillAuthorized: () => true, executionRepoAllowed: () => true }).ok).toBe(true);
    // Valid saved attempt histories may contain distinct repository executions. No provider is contacted by this fixture.
    expect(f.store.transact('history', 4, { kind: 'fixture-history' }, state => {
      if (!state) return null;
      const node = state.nodes[f.node.id]!, first = node.attempts[0]!;
      first.state = 'proposed'; first.terminalRunId = 'run-a'; first.proposalId = 'proposal-a';
      const id = outcomeDigest('second-attempt');
      node.attempts.push({ ...first, id, executionRepo: otherRepo, generationId: `outcome:v1:${outcomeDigest([node.id, id])}`,
        runId: 'run-b', providerRunIds: ['run-b'], terminalRunId: 'run-b', proposalId: 'proposal-b' });
      return state;
    }).ok).toBe(true);
    vi.spyOn(actions, 'readAgentActionsDetailed').mockImplementation(options => {
      const base: actions.AgentActionEvent = { schemaVersion: 1, ts: '2026-10-08T10:00:00Z', actor: 'agent', kind: 'dispatch',
        outcome: 'started', action: 'dispatch', summary: 'Recorded receipt.', repo };
      const rows = [{ ...base, runId: 'run-a' }, { ...base, repo: otherRepo, proposalId: 'proposal-b' },
        { ...base, runId: 'run-b' }, { ...base, proposalId: 'proposal-b' },
        { ...base, repo: otherRepo, runId: 'run-a' }, { ...base, repo: otherRepo, proposalId: 'proposal-a' },
        { ...base, itemId: `goal:${f.node.materialization.goalId}:${f.node.materialization.milestoneId}`, runId: 'run-b' },
        { ...base, runId: 'run-a', proposalId: 'proposal-b' }];
      return { events: rows.filter(options!.filter!), sourceState: 'healthy', sourcePresent: true, complete: true,
        stopReasons: [], filesRead: 1, bytesRead: 20, rowsScanned: rows.length, invalidRows: 0, unreadableFiles: 0 };
    });
    const result = readOutcomeTaskContext(f.input); expect(result.ok).toBe(true); if (!result.ok) return;
    const receipts = result.context.current.filter(event => event.source.objectRef.startsWith('agent-action:'));
    expect(receipts).toHaveLength(2);
    expect(receipts.map(event => JSON.parse(event.content))).toEqual(expect.arrayContaining([
      expect.objectContaining({ repo, runId: 'run-a', proposalId: null }),
      expect.objectContaining({ repo: otherRepo, runId: null, proposalId: 'proposal-b' })]));
  });
  it('returns a valid bounded native projection of a large fact with explicit partial coverage and source references', async () => {
    const f = fixture(); loadConfig();
    const record = createTaskContextEvent({ taskRef: outcomeTaskContextRef('one', f.node.id),
      source: { kind: 'project-memory', provider: 'phantom', accountRef: LOCAL_CONTEXT_ACCOUNT, objectRef: 'large-note', revisionRef: 'one' },
      sourceRefs: ['phantom:memory:large-note:one'], occurredAt: null, observedAt: new Date().toISOString(), validFrom: null,
      validUntil: null, kind: 'upsert', epistemic: 'recorded', content: 'Large scoped fact with useful words. '.repeat(1800), supersedes: [] });
    expect(appendTaskContextEvent({ root: dirname(dirname(outcomeDirectory('one'))), event: record, stillAuthorized: () => true })).toBe('recorded');
    const response = await callNativeTool('phm_task_context', { ...f.input, taskId: outcomeTaskPublicId(f.node.id) });
    expect(response.isError).not.toBe(true);
    const text = response.content[0]!.text, value = JSON.parse(text);
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(32 * 1024);
    expect(value.context).toMatchObject({ coverage: { complete: false, stopReasons: expect.arrayContaining(['native-output-byte-limit']) },
      outputProjection: { partial: true, excerptedContents: 1 } });
    expect(value.context.current.find((event: { eventId: string }) => event.eventId === record.eventId)).toMatchObject({
      sourceRefs: record.sourceRefs, contentComplete: false });
    expect(text).not.toContain('output truncated');
  });
  it('provides native read-only context under Stop without auditing private contents or changing local source files', async () => {
    const f = fixture();
    loadConfig(); // Normal native MCP startup already has configuration; this is not task-context storage.
    const privateText = 'PRIVATE-CONTEXT-MUST-NOT-REACH-AUDIT';
    const record = createTaskContextEvent({ taskRef: outcomeTaskContextRef('one', f.node.id),
      source: { kind: 'project-memory', provider: 'phantom', accountRef: LOCAL_CONTEXT_ACCOUNT, objectRef: 'private-note', revisionRef: 'one' },
      sourceRefs: ['phantom:memory:private-note:one'], occurredAt: null, observedAt: new Date().toISOString(), validFrom: null,
      validUntil: null, kind: 'upsert', epistemic: 'recorded', content: privateText, supersedes: [] });
    expect(appendTaskContextEvent({ root: dirname(dirname(outcomeDirectory('one'))), event: record, stillAuthorized: () => true })).toBe('recorded');
    writeFileSync(join(home, '.ashlr', 'KILL'), 'operator-stop', { mode: 0o600 });
    const before = readdirSync(join(home, '.ashlr'));
    expect(nativeToolSafety('phm_task_context')).toBe('read');
    const result = await callNativeTool('phm_task_context', { ...f.input, taskId: outcomeTaskPublicId(f.node.id), maxEvents: 10 });
    expect(result.isError).not.toBe(true);
    const value = JSON.parse(result.content[0]!.text);
    expect(value).toMatchObject({ ok: true, context: { taskId: outcomeTaskPublicId(f.node.id), coverage: { complete: false } } });
    expect(value.context.current[0].eventId).not.toContain('[REDACTED]');
    expect(result.content[0]!.text).toContain(privateText);
    // Native calls audit argument keys only; they do not persist the task result or private evidence.
    const after = readdirSync(join(home, '.ashlr'));
    expect(after.filter(name => name !== 'audit')).toEqual(before.filter(name => name !== 'audit'));
    const audit = readdirSync(join(home, '.ashlr', 'audit')).map(name => readFileSync(join(home, '.ashlr', 'audit', name), 'utf8')).join('\n');
    expect(audit).toContain('phm_task_context keys=maxEvents,outcomeId,taskId');
    expect(audit).not.toContain(privateText); expect(audit).not.toContain(outcomeTaskPublicId(f.node.id));
  });
  it('rejects native context account widening and unsafe IDs with a static error that contains no private path', async () => {
    const f = fixture();
    const result = await callNativeTool('phm_task_context', { ...f.input, taskId: outcomeTaskPublicId(f.node.id), accountRefs: ['other'] });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).not.toContain(home);
    expect(await callNativeTool('phm_task_context', { outcomeId: '../escape', taskId: 'unbound' })).toMatchObject({ isError: true });
  });
});
