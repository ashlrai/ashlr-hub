import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  claimSimpleConductorTask,
  readSimpleConductorTasks,
  reconcileSimpleConductorTask,
  settleSimpleConductorTask,
  simpleConductorTaskGenerationId,
  type TaskSpec,
} from '../src/core/simple-conductor-task-store.js';
import { ensureProposalInbox, inboxDir } from '../src/core/inbox/store.js';

const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;
let home: string;

function path(): string {
  return join(home, '.ashlr', 'tasks.json');
}

function task(overrides: Partial<TaskSpec> = {}): TaskSpec {
  return {
    id: 'task-1',
    repo: '/tmp/enrolled-repo',
    instruction: 'repair the failing verifier',
    ...overrides,
  };
}

function writeTasks(tasks: TaskSpec[] | string): void {
  const dir = join(home, '.ashlr');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(path(), typeof tasks === 'string' ? tasks : `${JSON.stringify(tasks, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
}

function persisted(): TaskSpec[] {
  return JSON.parse(readFileSync(path(), 'utf8')) as TaskSpec[];
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'm471-conductor-'));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
});

afterEach(() => {
  process.env.HOME = originalHome;
  process.env.USERPROFILE = originalUserProfile;
  rmSync(home, { recursive: true, force: true });
});

describe('M471 simple-conductor transactional settlement', () => {
  it('bootstraps a present private proposal inbox and rejects path replacement', () => {
    mkdirSync(join(home, '.ashlr'), { mode: 0o700 });
    expect(ensureProposalInbox()).toBe(true);
    expect(existsSync(inboxDir())).toBe(true);

    rmSync(inboxDir(), { recursive: true, force: true });
    writeFileSync(inboxDir(), 'not a directory', { mode: 0o600 });
    expect(ensureProposalInbox()).toBe(false);
  });

  it('fails closed on malformed and duplicate task stores', () => {
    writeTasks('{not-json');
    expect(readSimpleConductorTasks()).toEqual({
      ok: false,
      reason: 'task store contains malformed JSON',
    });

    writeTasks([task(), task({ instruction: 'different generation' })]);
    expect(readSimpleConductorTasks()).toEqual({
      ok: false,
      reason: 'task store contains duplicate id task-1',
    });

    writeTasks([task({ engine: 'unregistered-engine' as never })]);
    expect(readSimpleConductorTasks()).toEqual({
      ok: false,
      reason: 'task store is not a bounded valid task array',
    });
  });

  it('persists the attempt and lease before exposure and refuses a concurrent claim', () => {
    const row = task();
    const generationId = simpleConductorTaskGenerationId(row);
    writeTasks([row]);

    const first = claimSimpleConductorTask(row.id, generationId, 1_000);
    expect(first.ok).toBe(true);
    expect(persisted()[0]).toEqual(expect.objectContaining({
      attempts: 1,
      dispatchedAt: new Date(1_000).toISOString(),
      dispatchLease: expect.objectContaining({ generationId }),
    }));

    expect(claimSimpleConductorTask(row.id, generationId, 2_000)).toEqual({
      ok: false,
      reason: 'busy',
      detail: 'task has an active dispatch lease',
    });
  });

  it('settles only the exact generation and lease token', () => {
    const row = task();
    const generationId = simpleConductorTaskGenerationId(row);
    writeTasks([row]);
    const claimed = claimSimpleConductorTask(row.id, generationId, 1_000);
    if (!claimed.ok) throw new Error(claimed.detail);

    expect(settleSimpleConductorTask({ ...claimed.claim, token: 'wrong-token' }, {
      done: true,
      proposalId: 'proposal-wrong',
    })).toEqual({
      ok: false,
      reason: 'changed',
      detail: 'task generation or dispatch lease changed',
    });
    expect(persisted()[0].done).toBeUndefined();

    const settled = settleSimpleConductorTask(claimed.claim, {
      done: true,
      proposalId: 'proposal-1',
    });
    expect(settled.ok).toBe(true);
    expect(persisted()[0]).toEqual(expect.objectContaining({
      attempts: 1,
      done: true,
      proposalId: 'proposal-1',
    }));
    expect(persisted()[0].dispatchLease).toBeUndefined();
  });

  it('detects an ABA-style task generation change during dispatch', () => {
    const row = task();
    const generationId = simpleConductorTaskGenerationId(row);
    writeTasks([row]);
    const claimed = claimSimpleConductorTask(row.id, generationId, 1_000);
    if (!claimed.ok) throw new Error(claimed.detail);

    const [claimedRow] = persisted();
    writeTasks([{ ...claimedRow, instruction: 'replacement objective' }]);
    expect(settleSimpleConductorTask(claimed.claim, {
      done: true,
      proposalId: 'proposal-stale',
    })).toEqual({
      ok: false,
      reason: 'changed',
      detail: 'task generation or dispatch lease changed',
    });
    expect(persisted()[0].instruction).toBe('replacement objective');
    expect(persisted()[0].proposalId).toBeUndefined();
    const replacement = persisted()[0];
    expect(claimSimpleConductorTask(
      replacement.id,
      simpleConductorTaskGenerationId(replacement),
      2_000,
    ).ok).toBe(true);
  });

  it('rejects mutable row drift even when logical generation is unchanged', () => {
    const row = task();
    const generationId = simpleConductorTaskGenerationId(row);
    writeTasks([row]);
    const claimed = claimSimpleConductorTask(row.id, generationId, 1_000);
    if (!claimed.ok) throw new Error(claimed.detail);

    const [claimedRow] = persisted();
    writeTasks([{ ...claimedRow, priority: 99 }]);
    expect(settleSimpleConductorTask(claimed.claim, {
      done: true,
      proposalId: 'proposal-drifted',
    })).toEqual({
      ok: false,
      reason: 'changed',
      detail: 'task generation or dispatch lease changed',
    });
    expect(persisted()[0].priority).toBe(99);
    expect(persisted()[0].proposalId).toBeUndefined();
  });

  it('requires reconciliation after expiry but permits authoritative projection', () => {
    const row = task();
    const generationId = simpleConductorTaskGenerationId(row);
    writeTasks([row]);
    const first = claimSimpleConductorTask(row.id, generationId, 0);
    if (!first.ok) throw new Error(first.detail);

    expect(reconcileSimpleConductorTask(row.id, generationId, {
      done: true,
      proposalId: 'proposal-active',
    }, 1_000)).toEqual({
      ok: false,
      reason: 'changed',
      detail: 'task has an active dispatch lease',
    });

    expect(claimSimpleConductorTask(row.id, generationId, 25 * 60 * 60_000)).toEqual({
      ok: false,
      reason: 'reconciliation-required',
      detail: 'task dispatch lease expired without terminal authority',
    });
    expect(reconcileSimpleConductorTask(row.id, generationId, {
      done: true,
      proposalId: 'proposal-reconciled',
    }, 25 * 60 * 60_000)).toEqual(expect.objectContaining({ ok: true }));
    expect(persisted()[0]).toEqual(expect.objectContaining({
      attempts: 1,
      done: true,
      proposalId: 'proposal-reconciled',
    }));
  });

  it('keeps logical generation stable across mutable settlement metadata', () => {
    const row = task();
    const generationId = simpleConductorTaskGenerationId(row);
    expect(simpleConductorTaskGenerationId({
      ...row,
      attempts: 9,
      done: true,
      proposalId: 'proposal-9',
      lastError: 'old failure',
    })).toBe(generationId);
    expect(simpleConductorTaskGenerationId({ ...row, engine: 'codex' })).not.toBe(generationId);
    expect(simpleConductorTaskGenerationId({ ...row, instruction: 'new objective' })).not.toBe(generationId);
  });
});
