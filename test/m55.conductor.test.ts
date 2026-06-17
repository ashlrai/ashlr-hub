/**
 * M55 — the `ashlr goal` + `ashlr loop` conductor.
 *
 * Hermetic; no spawn, no dispatch. Proves the conductor is proposal-first by
 * construction: a SOURCE grep-guard (the daemon-no-primitive / preflight
 * precedent) asserts neither cli module imports an outward-mutation primitive,
 * and the early-return paths (usage / --help) dispatch nothing.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

const OUTWARD_PRIMITIVES: RegExp[] = [
  /applyProposal/,
  /inbox\/apply/,
  /git\s+push/,
  /gh\s+pr\s+create/,
  /createPr\b/,
  /\bdeploy\s*\(/,
  /mergeProposal/,
  /autoMerge\s*\(/,
  /ship-deploy|shipDeploy|startShip\b/,
];

describe('M55 — conductor carries NO outward-mutation primitive (source guard)', () => {
  for (const f of ['goal.ts', 'loop.ts']) {
    it(`cli/${f} imports no apply/merge/createPr/push/deploy primitive`, () => {
      const src = readFileSync(resolve(HERE, `../src/cli/${f}`), 'utf8');
      for (const re of OUTWARD_PRIMITIVES) {
        expect(re.test(src), `${f} unexpectedly matched ${re}`).toBe(false);
      }
    });
  }
});

describe('M55 — conductor modules export their commands', () => {
  it('goal.ts exports cmdGoal; loop.ts exports cmdLoop', async () => {
    const goal = await import('../src/cli/goal.js');
    const loop = await import('../src/cli/loop.js');
    expect(typeof goal.cmdGoal).toBe('function');
    expect(typeof loop.cmdLoop).toBe('function');
  });
});

describe('M55 — early-return paths dispatch nothing (hermetic)', () => {
  it('cmdGoal with no objective returns usage exit code 2', async () => {
    const { cmdGoal } = await import('../src/cli/goal.js');
    expect(await cmdGoal([])).toBe(2);
  });

  it('cmdGoal --help returns 0', async () => {
    const { cmdGoal } = await import('../src/cli/goal.js');
    expect(await cmdGoal(['--help'])).toBe(0);
  });

  it('cmdLoop --help returns 0', async () => {
    const { cmdLoop } = await import('../src/cli/loop.js');
    expect(await cmdLoop(['--help'])).toBe(0);
  });
});
