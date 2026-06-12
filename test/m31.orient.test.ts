/**
 * M31 — buildOrientation (src/core/orient.ts).
 *
 * Hermetic: tmp HOME per test; orientation must be read-only and best-effort —
 * empty stores yield a valid empty result, never an exception.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import { makeFixture, makeCfg, type H1Fixture } from './helpers/h1-fixture.js';
import { buildOrientation } from '../src/core/orient.js';

let fx: H1Fixture;

beforeEach(() => {
  expect.hasAssertions();
  fx = makeFixture();
});

afterEach(() => {
  fx.cleanup();
});

describe('buildOrientation — empty stores', () => {
  it('returns a valid, empty orientation and never throws', async () => {
    const o = await buildOrientation(makeCfg());
    expect(o.generatedAt).toBeTruthy();
    expect(o.repo).toBeNull();
    // genomeHits is environment-sensitive (recall also surfaces project-local
    // stores discoverable from cwd) — assert shape, not emptiness.
    expect(Array.isArray(o.genomeHits)).toBe(true);
    expect(o.health).toBeNull();
    expect(o.backlogItems).toEqual([]);
    expect(o.pendingProposals).toBe(0);
  });

  it('resolves a relative repo argument to an absolute path', async () => {
    const o = await buildOrientation(makeCfg(), '.');
    expect(o.repo).toBe(process.cwd());
  });
});

describe('buildOrientation — seeded stores', () => {
  it('surfaces genome hits, backlog items, and pending proposals', async () => {
    // Genome hub entry
    const genomeDir = join(fx.ashlrDir, 'genome');
    mkdirSync(genomeDir, { recursive: true });
    writeFileSync(
      join(genomeDir, 'hub.jsonl'),
      JSON.stringify({
        id: 'g1',
        project: null,
        source: 'hub',
        title: 'myrepo deployment convention',
        text: 'myrepo deploys via vercel',
        tags: [],
        ts: new Date().toISOString(),
      }) + '\n',
    );

    // Persisted backlog scoped to the repo
    const repoPath = join(fx.home, 'myrepo');
    mkdirSync(repoPath, { recursive: true });
    writeFileSync(
      join(fx.ashlrDir, 'backlog.json'),
      JSON.stringify({
        generatedAt: new Date().toISOString(),
        repos: [repoPath],
        items: [
          {
            id: `${repoPath}:todo:1`,
            repo: repoPath,
            source: 'todo',
            title: 'fix the thing',
            detail: '',
            value: 4,
            effort: 2,
            score: 8,
            tags: [],
            ts: new Date().toISOString(),
          },
        ],
      }),
    );

    // One pending proposal
    const { createProposal } = await import('../src/core/inbox/store.js');
    createProposal({
      repo: null,
      origin: 'manual',
      kind: 'note',
      title: 'pending note',
      summary: 'test',
    });

    const o = await buildOrientation(makeCfg(), repoPath);
    expect(o.repo).toBe(repoPath);
    expect(o.genomeHits.length).toBeGreaterThan(0);
    expect(o.backlogItems).toHaveLength(1);
    expect(o.backlogItems[0]!.title).toBe('fix the thing');
    expect(o.pendingProposals).toBe(1);
  });

  it('filters backlog items to the requested repo', async () => {
    mkdirSync(fx.ashlrDir, { recursive: true });
    const repoA = join(fx.home, 'repoA');
    const repoB = join(fx.home, 'repoB');
    const mkItem = (repo: string, n: number) => ({
      id: `${repo}:todo:${n}`,
      repo,
      source: 'todo',
      title: `item ${n}`,
      detail: '',
      value: 3,
      effort: 3,
      score: 5,
      tags: [],
      ts: new Date().toISOString(),
    });
    writeFileSync(
      join(fx.ashlrDir, 'backlog.json'),
      JSON.stringify({
        generatedAt: new Date().toISOString(),
        repos: [repoA, repoB],
        items: [mkItem(repoA, 1), mkItem(repoB, 2), mkItem(repoB, 3)],
      }),
    );

    const o = await buildOrientation(makeCfg(), repoB);
    expect(o.backlogItems).toHaveLength(2);
    for (const item of o.backlogItems) expect(item.title).not.toBe('item 1');
  });

  it('is read-only: a full orientation writes nothing new under ~/.ashlr except audit', async () => {
    const before = existsSync(fx.ashlrDir) ? readdirSync(fx.ashlrDir).sort() : [];
    await buildOrientation(makeCfg(), fx.home);
    const after = existsSync(fx.ashlrDir) ? readdirSync(fx.ashlrDir).sort() : [];
    expect(after).toEqual(before);
  });
});
