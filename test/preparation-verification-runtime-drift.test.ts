/** Real confined calls: one stale control must fail the same refusal criterion as the baseline satisfies. */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readPreparedResourceEngineeringMetadata } from '../src/core/resources/engineering-preparation.js';
import { createPreparationCandidateHarness, snapshotPreparationFixture } from './helpers/preparation-candidate-harness.js';
import { createPreparationMutationInterceptor } from './helpers/preparation-mutation-interceptor.js';
import { preparationManagerFixture } from './helpers/preparation-workflow-manager-fixture.js';

const repository = dirname(dirname(fileURLToPath(import.meta.url)));
const supported = process.platform === 'darwin' && Number(process.versions.node.split('.')[0]) >= 24;
const finalCapture = "if (capture(options, successor).plan.planDigest !== expectedPlanDigest) fail('CONFLICT', 'Preparation inputs changed during inspection');";
let harness: Awaited<ReturnType<typeof createPreparationCandidateHarness>> | undefined;

beforeAll(async () => {
  if (supported) harness = await createPreparationCandidateHarness(repository);
}, 30000);
afterAll(() => { harness?.close(); });

describe.runIf(supported)('candidate-linked during-call runtime drift', () => {
  it.each(['baseline', 'stale-final-capture'] as const)(
    '%s: independently checks refusal after a previously healthy call', async kind => {
      if (!harness) throw new Error('Candidate harness was not initialized');
      const fixtureRoot = join(harness.root, kind); mkdirSync(fixtureRoot, { mode: 0o700 });
      const fixture = await preparationManagerFixture(fixtureRoot);
      const input = fixture.bundleInput;
      const expected = readPreparedResourceEngineeringMetadata(input);
      const runtimeFile = fixture.options.config.resourceRuntime;
      const runtimeBytes = readFileSync(runtimeFile);
      const intentFile = join(input.output, 'intent.json');
      const before = snapshotPreparationFixture(fixtureRoot);
      let mutated: ReturnType<typeof snapshotPreparationFixture> | undefined;
      const interceptor = createPreparationMutationInterceptor({
        run: harness.run, toolPath: harness.toolPath, fixtureRoot,
        matches: request => request.file === '/bin/ls' && request.args[0] === '-lde' &&
          request.args.slice(1).includes(intentFile),
        mutate() {
          // Intent inspection follows the successful initial capture, generated
          // enrollment/evidence checks and receipt comparison. The child is
          // waiting for the original ACL result; no candidate callback exists.
          fixture.save(runtimeFile, { ...fixture.runtime, capacityWaitMs: 1000 });
          mutated = snapshotPreparationFixture(fixtureRoot);
        },
      });
      expect(harness.source.split(finalCapture)).toHaveLength(2);
      const source = kind === 'baseline' ? harness.source : harness.source.replace(finalCapture,
        '// Deliberately stale test control: reuse the initial capture instead of revalidating.');
      const child = await harness.session(source, fixtureRoot, interceptor.run);
      try {
        expect(snapshotPreparationFixture(fixtureRoot)).toEqual(before);
        const healthy = await child.call('metadata', input);
        expect(healthy.error).toBeUndefined();
        expect(healthy.value).toEqual(expected);
        expect(healthy.measurement.processes).toBeGreaterThan(0);
        expect(snapshotPreparationFixture(fixtureRoot)).toEqual(before);

        // The same child already succeeded with these exact inputs. Arm only
        // now so initialization/healthy reads cannot satisfy the mutation proof.
        interceptor.arm();
        const changed = await child.call('metadata', input);
        interceptor.assertInjected();
        expect(interceptor.injections()).toBe(1);
        expect(mutated).toBeDefined();
        expect(mutated).not.toEqual(before);
        expect(snapshotPreparationFixture(fixtureRoot)).toEqual(mutated);
        expect(changed.measurement.processes).toBeGreaterThan(0);
        const refused = changed.error === 'candidate-threw' && !Object.hasOwn(changed, 'value');
        expect(refused).toBe(kind === 'baseline');
        if (kind === 'baseline') expect(changed.error).toBe('candidate-threw');
        else {
          // A harness/transport failure cannot stand in for this negative
          // control: it must demonstrably return the old successful metadata.
          expect(changed.error).toBeUndefined();
          expect(changed.value).toEqual(expected);
        }
        const ledger = child.measurementLedger();
        expect(ledger.requests.map(row => row.method)).toEqual(['metadata', 'metadata']);
        expect(ledger.processes).toBe(healthy.measurement.processes + changed.measurement.processes);
        expect(ledger.blobProcesses).toBe(healthy.measurement.blobProcesses + changed.measurement.blobProcesses);
      } finally {
        // Restore only after confirmed session close, never while the candidate
        // may still be reading. Compare the deliberate mutation before restore.
        await child.close();
        const afterClose = snapshotPreparationFixture(fixtureRoot);
        writeFileSync(runtimeFile, runtimeBytes);
        expect(afterClose).toEqual(mutated ?? before);
      }
    }, 240000);
});
