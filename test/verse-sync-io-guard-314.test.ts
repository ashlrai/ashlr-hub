/**
 * 3.14 — the regression guard for synchronous folder access in Verse route
 * files (scripts/check-verse-sync-io.mjs, run by `npm run lint` and the gate),
 * and the folder-io primitives the routes use instead.
 *
 * The guard exists because a synchronous fs or child-process call into a
 * folder macOS guards with a privacy prompt parks the sidecar's only thread
 * until the operator answers (3.13.0: ~3 minutes of a frozen app).
 */
import { describe, expect, it } from 'vitest';

import { ALLOW_MARKER, findSyncIoInSource, findVerseSyncIo, SYNC_HELPERS_WITH_ASYNC_TWIN } from '../scripts/check-verse-sync-io.mjs';
import {
  firstPendingFolder,
  FOLDER_IO_CONCURRENCY,
  folderIoLoad,
  mapLimited,
  probeFolderAccess,
  withFolderIo,
} from '../src/core/verse/folder-io.js';

type Violation = { line: number; call: string; kind: string };
const find = findSyncIoInSource as (source: string) => Violation[];

describe('check-verse-sync-io', () => {
  it('the Verse route files are clean today', () => {
    expect((findVerseSyncIo as () => unknown[])()).toEqual([]);
  });

  it('flags *Sync( calls and sync helpers that have an async twin', () => {
    const source = [
      "import { statSync } from 'node:fs';",
      'const a = statSync(p);',
      // Split so the real-io lane guard does not read this fixture text as a spawn.
      'const b = exec' + 'FileSync("git", []);',
      'const c = describeRoots(roots);',
      'const d = foo.getGitStatus(x);', // a method on something else: not the helper
      'const e = describeRootsAsync(roots);',
    ].join('\n');
    expect(find(source).map((v) => [v.line, v.call, v.kind])).toEqual([
      [2, 'statSync', 'sync-call'],
      [3, 'execFileSync', 'sync-call'],
      [4, 'describeRoots', 'sync-helper'],
    ]);
    expect(Object.keys(SYNC_HELPERS_WITH_ASYNC_TWIN)).toContain('checkWorkspaceRootPath');
  });

  it('ignores comments, strings, and function definitions', () => {
    const source = [
      '// statSync(p) in a comment',
      '/* readFileSync(p)',
      '   spans lines */',
      "const msg = 'do not call readdirSync(dir) here';",
      'const t = `describeRoots(${name})`;',
      'export function cachedPendingCount(): number { return 1; }',
      'function readSomethingSync(x: string) { return x; }',
    ].join('\n');
    expect(find(source)).toEqual([]);
  });

  it('accepts an allowlist comment with a real reason, on the line or the line above', () => {
    const ok = [
      `// ${ALLOW_MARKER} lstat of ~/.ashlr/KILL, a private control sentinel`,
      'const a = lstatSync(killSwitchPath());',
      `const b = readdirSync(inbox); // ${ALLOW_MARKER} the private proposal store under ~/.ashlr`,
    ].join('\n');
    expect(find(ok)).toEqual([]);
    const noReason = [`// ${ALLOW_MARKER} fine`, 'const a = lstatSync(p);'].join('\n');
    expect(find(noReason).map((v) => v.call)).toEqual(['lstatSync']);
    const tooFar = [`// ${ALLOW_MARKER} lstat of ~/.ashlr/KILL, a private control sentinel`, '', 'const a = lstatSync(p);'].join('\n');
    expect(find(tooFar).map((v) => v.line)).toEqual([3]);
  });
});

describe('folder-io', () => {
  it(`never runs more than ${FOLDER_IO_CONCURRENCY} folder operations at once, FIFO, and releases on rejection`, async () => {
    let peak = 0;
    const order: number[] = [];
    const releases: Array<() => void> = [];
    const jobs = Array.from({ length: 6 }, (_, i) => withFolderIo(async () => {
      peak = Math.max(peak, folderIoLoad().active);
      order.push(i);
      await new Promise<void>((resolve) => releases.push(resolve));
      if (i === 1) throw new Error('boom');
      return i;
    }));
    const settled = Promise.allSettled(jobs); // observe the rejection before it happens
    for (let round = 0; round < 6; round += 1) {
      while (releases.length === 0) await new Promise((r) => setImmediate(r));
      releases.shift()!();
    }
    const results = await settled;
    expect(peak).toBe(FOLDER_IO_CONCURRENCY);
    expect(order).toEqual([0, 1, 2, 3, 4, 5]);
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'rejected', 'fulfilled', 'fulfilled', 'fulfilled', 'fulfilled']);
    expect(folderIoLoad()).toEqual({ active: 0, waiting: 0 });
  });

  it('mapLimited keeps input order and its limit', async () => {
    let inFlight = 0;
    let peak = 0;
    const out = await mapLimited([5, 1, 3, 2], 2, async (n, i) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, n));
      inFlight -= 1;
      return `${i}:${n}`;
    });
    expect(out).toEqual(['0:5', '1:1', '2:3', '3:2']);
    expect(peak).toBe(2);
  });

  it('probeFolderAccess: ok, missing, and pending when the folder cannot be reached in time', async () => {
    expect(await probeFolderAccess(process.cwd())).toBe('ok');
    expect(await probeFolderAccess('/definitely/not/here')).toBe('missing');
    // Saturate the folder-io slots, as stats parked behind a prompt would.
    const releases: Array<() => void> = [];
    const blockers = Array.from({ length: FOLDER_IO_CONCURRENCY }, () =>
      withFolderIo(() => new Promise<void>((resolve) => releases.push(resolve))));
    try {
      const started = Date.now();
      expect(await probeFolderAccess(process.cwd(), 50)).toBe('pending');
      expect(Date.now() - started).toBeLessThan(1_000);
      expect(await firstPendingFolder([process.cwd(), '/tmp'], 50)).toBe(process.cwd());
    } finally {
      for (const release of releases) release();
      await Promise.all(blockers);
    }
    // The queued probes drain once the slots free up.
    for (let i = 0; i < 20 && folderIoLoad().active + folderIoLoad().waiting > 0; i += 1) await new Promise((r) => setTimeout(r, 5));
    expect(folderIoLoad()).toEqual({ active: 0, waiting: 0 });
    expect(await firstPendingFolder([process.cwd(), '/definitely/not/here'])).toBeNull();
  });
});
