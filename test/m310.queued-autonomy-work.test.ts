import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { makeFixture, type H1Fixture } from './helpers/h1-fixture.js';
import { buildBacklog } from '../src/core/portfolio/backlog.js';
import { scanQueuedAutonomyWork } from '../src/core/portfolio/scanners.js';
import type { WorkItem } from '../src/core/types.js';

let fx: H1Fixture;

beforeEach(() => {
  expect.hasAssertions();
  fx = makeFixture();
});

afterEach(() => {
  fx.cleanup();
});

function item(repo: string, id: string, overrides: Partial<WorkItem> = {}): WorkItem {
  return {
    id,
    repo,
    source: 'invent',
    title: `Implement queued autonomy item ${id}`,
    detail: 'Implement a focused code change that improves autonomous engineering reliability.',
    value: 5,
    effort: 2,
    score: 2.5,
    tags: ['generative', 'bold'],
    ts: '2026-07-02T00:00:00.000Z',
    ...overrides,
  };
}

function writeJson(path: string, data: unknown): void {
  mkdirSync(fx.ashlrDir, { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2), 'utf8');
}

describe('queued autonomy work scanner', () => {
  it('rehydrates self-heal and invent items for the scanned enrolled repo only', async () => {
    const repo = fx.makeRepo();
    const otherRepo = fx.makeRepo();
    repo.enroll();
    otherRepo.enroll();

    const heal = item(repo.dir, 'heal-1', { source: 'self', tags: ['self-heal', 'verify'] });
    const invent = item(repo.dir, 'invent-1');
    const wrongRepo = item(otherRepo.dir, 'invent-other');
    const lowSignal = item(repo.dir, 'todo-1', { source: 'todo', tags: ['todo'] });

    writeJson(join(fx.ashlrDir, 'self-heal-queue.json'), [heal, wrongRepo]);
    writeJson(join(fx.ashlrDir, 'backlog.json'), {
      generatedAt: '2026-07-02T00:00:00.000Z',
      repos: [repo.dir, otherRepo.dir],
      items: [invent, lowSignal],
    });

    const found = await scanQueuedAutonomyWork(repo.dir);

    expect(found.map((x) => x.id)).toEqual(['heal-1', 'invent-1']);
  });

  it('preserves queued autonomy items through a full backlog refresh', async () => {
    const repo = fx.makeRepo();
    repo.enroll();

    const heal = item(repo.dir, 'heal-build-1', {
      source: 'self',
      title: 'Repair failing autonomous daemon verification',
      tags: ['self-heal', 'daemon'],
    });
    const invent = item(repo.dir, 'invent-build-1', {
      title: 'Add autonomous work selection telemetry',
      tags: ['generative', 'selection'],
    });

    writeJson(join(fx.ashlrDir, 'self-heal-queue.json'), [heal]);
    writeJson(join(fx.ashlrDir, 'backlog.json'), {
      generatedAt: '2026-07-02T00:00:00.000Z',
      repos: [repo.dir],
      items: [invent],
    });

    const backlog = await buildBacklog({
      repos: [repo.dir],
      minItemValue: 2,
      cfg: { foundry: { feedbackEnabled: false } },
      listPendingProposals: () => [],
    });

    expect(backlog.items.some((x) => x.id === 'heal-build-1')).toBe(true);
    expect(backlog.items.some((x) => x.id === 'invent-build-1')).toBe(true);
  });
});
