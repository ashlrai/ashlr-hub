/**
 * V3.10 — default scans skip the fleet's own mirror clones.
 *
 * A standing grant enrolls ~/.ashlr/fleet/mirrors/<owner>__<repo> next to the
 * checkout Mason enrolled himself (src/core/fleet/mirrors.ts). Outside an
 * enrollment lens the knowledge index and the strategic context (and quality,
 * backlog, pulse-sync, invent — same `withoutFleetMirrors` rule) must scan the
 * checkout once, not the checkout plus its mirror. Inside the autonomous lane
 * every enrolled entry IS a mirror, so the lens's view is used untouched —
 * filtering there would leave the fleet with nothing to scan.
 *
 * Fixtures are plain directories (no `.git`), so nothing here spawns git.
 * HOME: test/setup/home.ts gives each worker one isolated home; every test
 * here relocates HOME to a fresh directory inside it so the enrollment
 * registry starts empty (the precondition asserts exactly two entries).
 */
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { mirrorPathFor, runInAutonomousLane } from '../src/core/fleet/mirrors.js';
import { buildKnowledge } from '../src/core/knowledge/index.js';
import { enroll, listEnrolled } from '../src/core/sandbox/policy.js';
import { gatherStrategicContext } from '../src/core/vision/context.js';

let checkout: string;
let mirror: string;
let savedHome: string | undefined;

function plantRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'README.md'), '# widget\n\nA small fixture repo for the scan-scope test.\n');
}

beforeEach(() => {
  savedHome = process.env.HOME;
  process.env.HOME = realpathSync(mkdtempSync(join(homedir(), 'scan-scope-')));
  const work = join(homedir(), 'work');
  mkdirSync(work, { recursive: true });
  checkout = realpathSync(mkdtempSync(join(work, 'widget-')));
  plantRepo(checkout);
  mirror = mirrorPathFor('acme/widget');
  plantRepo(mirror);
  mirror = realpathSync(mirror);
  expect(enroll(checkout).ok).toBe(true);
  expect(enroll(mirror).ok).toBe(true);
  // Precondition: the raw registry really holds both (the bug's shape).
  expect(listEnrolled().sort()).toEqual([checkout, mirror].sort());
});

afterEach(() => {
  process.env.HOME = savedHome;
});

describe('default scans outside a lens skip fleet mirrors', () => {
  it('strategic context lists the checkout once and never the mirror', async () => {
    const ctx = await gatherStrategicContext();
    const paths = ctx.repos.map((repo) => repo.path);
    expect(paths).toContain(checkout);
    expect(paths).not.toContain(mirror);
  });

  it('the knowledge index covers the checkout only', async () => {
    const built = await buildKnowledge();
    expect(built.repos).toBe(1);
  });

  it('an explicit repo list is honoured as given (only the default set is filtered)', async () => {
    const built = await buildKnowledge({ repos: [mirror] });
    expect(built.repos).toBe(1);
  });
});

describe('inside the autonomous lane the lens view is kept', () => {
  it('strategic context sees the mirror (the only thing the lane admits)', async () => {
    const ctx = await runInAutonomousLane(() => gatherStrategicContext());
    expect(ctx.repos.map((repo) => repo.path)).toEqual([mirror]);
  });

  it('the knowledge index still covers the mirror', async () => {
    const built = await runInAutonomousLane(() => buildKnowledge());
    expect(built.repos).toBe(1);
  });
});
