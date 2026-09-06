/** Bounded replay of the original real-utility benchmark; never edits Hub source. */
/* global AbortController */
import console from 'node:console';
import process from 'node:process';
import { randomUUID } from 'node:crypto';
import { defaultUniverseRoot, initUniverse, initUniverseCampaign, readUniverseOverview, runUniverseCampaign } from '../../src/core/universe/index.ts';
import { manifestRecord, universePath } from '../../src/core/universe/store.ts';

if (process.platform !== 'darwin') throw new Error('Native macOS evaluator required');
const root = defaultUniverseRoot();
const original = manifestRecord(universePath(root, 'canary-format-date-sn3izw'));
const id = `campaign-calendar-${randomUUID().slice(0, 8)}`;
const manifest = { ...original.manifest, id, name: 'Autonomous calendar correctness campaign',
  budget: { maxTrials: 1, maxDurationMs: 210_000, trialTimeoutMs: 180_000, maxParallel: 1 },
  variants: [{ id: 'local-calendar-fix', niche: 'correctness',
    hypothesis: 'Validate exact date shape and Gregorian calendar correctness while preserving every other export and all surrounding source text. Use previous recorded outcomes to correct mistakes. Return the full replacement file in the prescribed edits JSON.',
    generation: { kind: 'local-chat', endpoint: 'http://127.0.0.1:11434/v1', model: 'qwen3-coder:30b',
      files: ['format.ts'], maxOutputTokens: 4096 } }],
};
initUniverse(manifest, { root });
const definition = { schemaVersion: 1, id, universeId: id, feedback: true,
  budget: { maxGenerations: 3, maxDurationMs: 600_000, maxModelRequests: 3, maxStagnantGenerations: 3, maxReportedTokens: 20_000 } };
const initial = initUniverseCampaign(definition, { root });
console.log(JSON.stringify({ stage: 'registered', id, comparatorDigest: initial.comparatorDigest, definition }));
const controller = new AbortController();
const cancel = () => controller.abort();
process.once('SIGINT', cancel);
process.once('SIGTERM', cancel);
try {
  const campaign = await runUniverseCampaign(id, { root, signal: controller.signal });
  const universe = readUniverseOverview({ root }).universes.find((item) => item.manifest.id === id);
  console.log(JSON.stringify({ stage: 'finished', campaign, universe }, null, 2));
  if (campaign.sourceState !== 'healthy' || ['failed', 'interrupted'].includes(campaign.state)) process.exitCode = 1;
} finally {
  process.removeListener('SIGINT', cancel);
  process.removeListener('SIGTERM', cancel);
}
