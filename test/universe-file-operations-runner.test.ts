import { afterEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readUniverseOverview, runUniverse } from '../src/core/universe/index.js';
import * as broker from '../src/core/universe/model-candidate.js';
import { fileOperationsContextDigest } from '../src/core/universe/file-operations-context.js';
import { newGenerationReceipt } from '../src/core/universe/generation.js';
import { fileOperationsFixture, fixtureSnapshot, sha256 } from './helpers/universe-file-operations-fixture.js';

type Fixture = Awaited<ReturnType<typeof fileOperationsFixture>>;
const fixtures: Fixture[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const fixture of fixtures.splice(0)) await fixture.dispose();
});

describe.runIf(process.platform === 'darwin')('frozen file-operation candidate admission', () => {
  it.each(['undeclared-change', 'executable-change'] as const)(
    'does not evaluate or admit a broker-success snapshot with %s', async (change) => {
      const fixture = await fileOperationsFixture({ kind: 'delete', generations: 1 });
      fixtures.push(fixture);
      const before = fixtureSnapshot(fixture.repo);
      // Deliberately violate the internal broker postcondition to exercise the
      // runner's independent frozen-snapshot check, not a real model endpoint.
      vi.spyOn(broker, 'generateModelCandidate').mockImplementation(async (config, context) => {
        const content = 'console.log(1);\n';
        writeFileSync(join(context.candidatePath, 'entry.mjs'), content);
        if (change === 'undeclared-change') writeFileSync(join(context.candidatePath, 'contract.txt'), 'Changed contract\n');
        else chmodSync(join(context.candidatePath, 'entry.mjs'), 0o700);
        return { ...newGenerationReceipt(config), status: 'succeeded', requestStarted: true,
          promptDigest: 'a'.repeat(64), responseDigest: 'b'.repeat(64), durationMs: 1,
          usage: { state: 'reported', inputTokens: 20, outputTokens: 10 }, changedFiles: ['entry.mjs'],
          fileOperations: { schemaVersion: 1, contextDigest: fileOperationsContextDigest(context.fileOperationsContext!),
            operations: [{ op: 'replace', path: 'entry.mjs',
              beforeDigest: sha256("import {value} from './legacy.mjs'; console.log(value);\n"), afterDigest: sha256(content) }] } };
      });
      const run = await runUniverse(fixture.manifest.id, fixture);
      expect(run.trials).toHaveLength(1);
      expect(run.trials[0]).toMatchObject({ status: 'failed', artifact: null, selected: false, metrics: {}, score: null });
      expect(run.trials[0]!.error).toMatch(/artifact changes|before and after states/);
      const summary = readUniverseOverview(fixture).universes[0]!;
      expect(summary.sourceState).toBe('healthy');
      expect(summary.elites).toEqual([]);
      expect(summary.runs).toEqual([run]);
      expect(fixture.requests).toHaveLength(0);
      expect(fixtureSnapshot(fixture.repo)).toEqual(before);
    });
});
