/** Reconstruct seed feedback from raw history, never a recursive campaign projection. */
import { canonical, digest } from './artifacts.js';
import { campaignDirectory, foldCampaignEvents, readCampaignEvents } from './campaign-store.js';
import { validateUniverseSeedContext } from './seed-context.js';
import type { ManifestRecord } from './store.js';
import type { UniverseRun, UniverseSeedContext } from './types.js';

/** Callers verify manifest/seed custody independently. Reading this function does
 * not acquire ownership, measure code or authorize execution. Legacy runs remain
 * unpinned; only newly started eligible runs capture the returned context.
 */
export function readCampaignSeedContext(run: UniverseRun, record: ManifestRecord, root: string): UniverseSeedContext | undefined {
  if (!run.campaign || !run.feedbackEnabled) return undefined;
  const directory = campaignDirectory(run.campaign.id, { root });
  const events = readCampaignEvents(directory);
  const folded = foldCampaignEvents(events);
  const created = folded.created;
  if (created.definition.id !== run.campaign.id || created.definitionDigest !== run.campaign.definitionDigest ||
      created.definition.universeId !== run.universeId || run.universeId !== record.manifest.id ||
      created.manifestDigest !== record.manifestDigest || run.manifestDigest !== record.manifestDigest ||
      created.comparatorDigest !== record.comparatorDigest || run.comparatorDigest !== record.comparatorDigest) {
    throw new Error('Campaign seed context identity does not match its run');
  }
  if (created.definition.measureSeed !== true || !created.definition.feedback) return undefined;
  const seed = folded.seedEvaluation;
  const step = folded.steps.find(value => value.runId === run.id);
  const resultEvent = events.find(value => value.kind === 'seed-evaluation-result');
  const runStart = Date.parse(run.startedAt);
  if (!seed?.result || seed.result.status !== 'measured' || seed.result.measurement === null ||
      seed.result.processGroupSettlement !== 'group-exit-confirmed' || seed.result.reason !== null ||
      seed.intent.seedArtifactDigest !== record.seedArtifact.digest ||
      !step || step.ordinal !== run.campaign.ordinal || step.generation !== run.generation ||
      !resultEvent || resultEvent.sequence >= step.sequence ||
      !Number.isFinite(runStart) || Date.parse(seed.result.finishedAt) > Date.parse(step.at) ||
      Date.parse(step.at) > runStart) throw new Error('Campaign seed context requires measured evidence preceding its exact run');
  const context = validateUniverseSeedContext({ schemaVersion: 1,
    source: { universeId: run.universeId, campaignId: run.campaign.id,
      definitionDigest: created.definitionDigest, manifestDigest: record.manifestDigest,
      comparatorDigest: record.comparatorDigest, seedArtifactDigest: record.seedArtifact.digest,
      intentDigest: digest(canonical(seed.intent)), resultDigest: digest(canonical(seed.result)) },
    measurement: { ...seed.result.measurement, diagnostics: seed.result.measurement.diagnostics ?? [] } });
  if (canonical(readCampaignEvents(directory)) !== canonical(events)) {
    throw new Error('Campaign seed evidence changed during context reconstruction');
  }
  return context;
}
