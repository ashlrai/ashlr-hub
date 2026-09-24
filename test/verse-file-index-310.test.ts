/**
 * Review 3.10 c12: the composer's `@` file index must never block the Verse
 * server. A chat rooted at a non-git folder used to be listed by ONE
 * synchronous readdirSync walk (55–255 ms of a frozen event loop per walk,
 * repeated every 30 s cache expiry). Now:
 *   - the walk is async and time-sliced (bounded by files, directories and a deadline);
 *   - an expired listing is served while a fresh one is built (stale-while-revalidate).
 *
 * Pure filesystem work under a tmp dir (HOME is isolated by test/setup/home.ts).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createFileIndex, defaultListFiles, walkFiles } from '../src/core/verse/file-index.js';

let root: string;
let big: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'file-index-'));
  mkdirSync(join(root, 'src', 'deep'), { recursive: true });
  mkdirSync(join(root, 'node_modules', 'pkg'), { recursive: true });
  mkdirSync(join(root, '.hidden'), { recursive: true });
  writeFileSync(join(root, 'README.md'), 'x');
  writeFileSync(join(root, 'src', 'a.ts'), 'x');
  writeFileSync(join(root, 'src', 'deep', 'b.ts'), 'x');
  writeFileSync(join(root, 'node_modules', 'pkg', 'index.js'), 'x');
  writeFileSync(join(root, '.hidden', 'secret'), 'x');
  symlinkSync(root, join(root, 'src', 'loop'));

  // A non-git tree big enough that the old synchronous walk stalled the loop for tens of ms.
  big = mkdtempSync(join(tmpdir(), 'file-index-big-'));
  for (let d = 0; d < 1_500; d += 1) {
    const dir = join(big, `pkg-${d % 30}`, `mod-${d}`);
    mkdirSync(dir, { recursive: true });
    for (let f = 0; f < 8; f += 1) writeFileSync(join(dir, `file-${f}.ts`), '');
  }
}, 60_000); // 12k fixture files: generous under a loaded machine

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(big, { recursive: true, force: true });
});

describe('walkFiles (non-git roots)', () => {
  it('lists files breadth-first, skipping dot-dirs, node_modules and symlinks', async () => {
    const files = await walkFiles(root);
    expect(files.sort()).toEqual(['README.md', 'src/a.ts', 'src/deep/b.ts']);
    // The not-a-git-work-tree path of the default lister is this walk.
    expect((await defaultListFiles(root)).sort()).toEqual(files.sort());
  });

  it('is bounded by the file limit and by its deadline', async () => {
    expect(await walkFiles(big, { limit: 100 })).toHaveLength(100);
    let t = 0;
    // Every clock read advances 1 s: the 2 s deadline stops the walk after a directory or two.
    const partial = await walkFiles(big, { deadlineMs: 2_000, now: () => (t += 1_000) });
    expect(partial.length).toBeLessThan(40);
  });

  // retry: a wall-clock probe can be descheduled by an unrelated load spike;
  // the old synchronous walk failed this on every attempt (one 55+ ms stall).
  it('never blocks the event loop past the 20 ms budget on a 12,000-file tree', { retry: 2 }, async () => {
    let maxGap = 0;
    let last = performance.now();
    let probing = true;
    const probe = (): void => {
      const n = performance.now();
      maxGap = Math.max(maxGap, n - last);
      last = n;
      if (probing) setImmediate(probe);
    };
    setImmediate(probe);
    const started = performance.now();
    const files = await walkFiles(big);
    const took = performance.now() - started;
    probing = false;
    expect(files).toHaveLength(12_000);
    console.log(`[c12] async walk of 12,000 files: ${took.toFixed(0)} ms total, longest loop stall ${maxGap.toFixed(1)} ms`);
    expect(maxGap).toBeLessThan(20);
  });
});

describe('createFileIndex — stale-while-revalidate', () => {
  it('serves an expired listing at once and swaps in the fresh one when it lands', async () => {
    let now = 0;
    let version = 1;
    let release: (() => void) | null = null;
    const index = createFileIndex({
      now: () => now,
      list: async () => {
        const v = version;
        if (v > 1) await new Promise<void>((resolve) => { release = resolve; });
        return [`v${v}.ts`];
      },
    });
    expect((await index.search(['/r'], '')).files.map((f) => f.path)).toEqual(['v1.ts']);
    now = 31_000;
    version = 2;
    // The refresh is still running (it never resolves until released), yet the answer is immediate.
    expect((await index.search(['/r'], '')).files.map((f) => f.path)).toEqual(['v1.ts']);
    expect(release).not.toBeNull();
    release!();
    await new Promise((resolve) => setImmediate(resolve));
    expect((await index.search(['/r'], '')).files.map((f) => f.path)).toEqual(['v2.ts']);
  });

  it('starts one refresh per root at a time, and a failed refresh keeps the old listing', async () => {
    let now = 0;
    let calls = 0;
    let fail = false;
    const index = createFileIndex({
      now: () => now,
      list: async () => {
        calls += 1;
        if (fail) throw new Error('walk failed');
        return ['old.ts'];
      },
    });
    await index.search(['/r'], '');
    now = 31_000;
    fail = true;
    await Promise.all([index.search(['/r'], ''), index.search(['/r'], ''), index.search(['/r'], '')]);
    expect(calls).toBe(2);
    await new Promise((resolve) => setImmediate(resolve));
    expect((await index.search(['/r'], '')).files.map((f) => f.path)).toEqual(['old.ts']);
  });
});
