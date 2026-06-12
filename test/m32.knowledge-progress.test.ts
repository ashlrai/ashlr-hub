/**
 * M32 — buildKnowledge onProgress callback (src/core/knowledge/index.ts).
 *
 * Hermetic: tmp HOME + disposable enrolled repo. Asserts monotonic per-repo
 * progress and that a throwing callback never violates the never-throws
 * contract of the build.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { makeFixture, type H1Fixture } from './helpers/h1-fixture.js';
import { buildKnowledge, type KnowledgeProgress } from '../src/core/knowledge/index.js';

let fx: H1Fixture;

beforeEach(() => {
  expect.hasAssertions();
  fx = makeFixture();
});

afterEach(() => {
  fx.cleanup();
});

describe('buildKnowledge onProgress', () => {
  it('emits one event per enrolled repo with monotonic indices', async () => {
    const repoA = fx.makeRepo();
    const repoB = fx.makeRepo();
    repoA.writeFile('src/a.ts', 'export const a = 1;\n');
    repoB.writeFile('src/b.ts', 'export const b = 2;\n');
    repoA.enroll();
    repoB.enroll();

    const events: KnowledgeProgress[] = [];
    const result = await buildKnowledge({ onProgress: (ev) => events.push(ev) });

    expect(result.repos).toBe(2);
    expect(events).toHaveLength(2);
    expect(events[0]!.repoIndex).toBe(1);
    expect(events[1]!.repoIndex).toBe(2);
    for (const ev of events) {
      expect(ev.repoCount).toBe(2);
      expect(typeof ev.newChunks).toBe('number');
      expect(ev.repo.length).toBeGreaterThan(0);
    }
  }, 30_000);

  it('a throwing callback never breaks the build', async () => {
    const repo = fx.makeRepo();
    repo.writeFile('src/x.ts', 'export const x = 1;\n');
    repo.enroll();

    const result = await buildKnowledge({
      onProgress: () => { throw new Error('callback exploded'); },
    });
    expect(result.repos).toBe(1);
  }, 30_000);

  it('emits nothing with empty enrollment', async () => {
    const events: KnowledgeProgress[] = [];
    const result = await buildKnowledge({ onProgress: (ev) => events.push(ev) });
    expect(result).toEqual({ repos: 0, chunks: 0 });
    expect(events).toHaveLength(0);
  });
});
