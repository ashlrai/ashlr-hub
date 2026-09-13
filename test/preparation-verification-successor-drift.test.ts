/** Candidate-linked, same-call source drift. This is a correctness control,
 * not a score or a claim about one particular final-return guard. */
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPreparationCandidateHarness, snapshotPreparationFixture } from './helpers/preparation-candidate-harness.js';
import { createPreparationMutationInterceptor } from './helpers/preparation-mutation-interceptor.js';
import { preparationSuccessorFixture } from './helpers/preparation-workflow-successor-fixture.js';

const repository = dirname(dirname(fileURLToPath(import.meta.url)));
const supported = process.platform === 'darwin' && Number(process.versions.node.split('.')[0]) >= 24;
let harness: Awaited<ReturnType<typeof createPreparationCandidateHarness>> | undefined;
let fixture: Awaited<ReturnType<typeof preparationSuccessorFixture>>;

beforeAll(async () => {
  if (!supported) return;
  harness = await createPreparationCandidateHarness(repository);
  const base = join(harness.root, 'successor'); mkdirSync(base, { mode: 0o700 });
  fixture = await preparationSuccessorFixture(base);
}, 120000);
afterAll(() => { harness?.close(); });

function withoutSourceRechecks(source: string): string {
  const original = 'const assertSource = () => {\n' +
    "    if (canonical(readUniverseCampaignDeliverySource(source, requestDigest)) !== canonical(origin)) fail('CONFLICT', 'Successor source changed');\n" +
    '  };';
  expect(source.split(original)).toHaveLength(2);
  // Keep the real initial origin read. Only subsequent source revalidation is
  // deliberately broken; a successful healthy read proves this is runnable.
  return source.replace(original, 'const assertSource = () => { /* deliberate stale-origin control */ };');
}

describe.runIf(supported)('candidate-linked successor source drift within a read', () => {
  it.each(['baseline', 'stale-source'] as const)('%s distinguishes source drift after a successful intermediate read', async kind => {
    const f = fixture; const h = harness!;
    const input = { ...f.options, expectedPlanDigest: f.plan.planDigest };
    // Metadata deliberately excludes these two full-report fields by contract.
    // All remaining identity, lineage, policy and status fields are compared.
    const expected = { ...Object.fromEntries(Object.entries(f.prepared)
      .filter(([key]) => key !== 'commissioning' && key !== 'consoleArguments')), disposition: 'replayed' };
    const intent = join(f.options.output, 'intent.json');
    let mutated: unknown;
    const interceptor = createPreparationMutationInterceptor({
      run: h.run, toolPath: h.toolPath, fixtureRoot: f.base,
      matches: request => request.file === '/bin/ls' && request.args[0] === '-lde' && request.args.includes(intent),
      mutate: () => {
        expect(f.git('rev-parse', '--verify', 'refs/heads/codex/upstream')).toBe(f.receipt.commit);
        f.git('update-ref', 'refs/heads/codex/upstream', f.revision);
        expect(f.git('rev-parse', '--verify', 'refs/heads/codex/upstream')).toBe(f.revision);
        mutated = snapshotPreparationFixture(f.base);
      },
    });
    const before = snapshotPreparationFixture(f.base);
    const text = kind === 'baseline' ? h.source : withoutSourceRechecks(h.source);
    const child = await h.session(text, f.base, interceptor.run);
    try {
      expect(snapshotPreparationFixture(f.base)).toEqual(before);
      const healthy = await child.call('successor-metadata', input);
      expect(healthy.error).toBeUndefined(); expect(healthy.value).toEqual(expected);
      expect(interceptor.injections()).toBe(0);
      expect(snapshotPreparationFixture(f.base)).toEqual(before);

      // The ACL read of this exact intent file happens after initial source
      // capture and receipt comparison, before the remaining source checks.
      // No ordinal Git count or production function-call count selects it.
      interceptor.arm();
      const changed = await child.call('successor-metadata', input);
      interceptor.assertInjected(); expect(interceptor.injections()).toBe(1);
      expect(mutated).toBeDefined();
      if (kind === 'baseline') {
        expect(changed.error).toBe('candidate-threw'); expect(changed.value).toBeUndefined();
      } else {
        expect(changed.error).toBeUndefined(); expect(changed.value).toEqual(expected);
      }
      expect(f.git('rev-parse', '--verify', 'refs/heads/codex/upstream')).toBe(f.revision);
      expect(snapshotPreparationFixture(f.base)).toEqual(mutated);
      expect(existsSync(f.ledger)).toBe(false);
      await child.close();
      interceptor.assertInjected();
      expect(snapshotPreparationFixture(f.base)).toEqual(mutated);
      expect(existsSync(f.ledger)).toBe(false);
    } finally {
      // Never restore fixture evidence while a candidate can still inspect it.
      await child.close();
      f.git('update-ref', 'refs/heads/codex/upstream', f.receipt.commit);
    }
  }, 360000);
});
