import { createHash } from 'node:crypto';
import { lstatSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { canonical, defaultUniverseRoot, inspectPrivateDirectory } from './artifacts.js';
import { campaignDirectory, foldCampaignEvents, projectCampaign, readCampaignEvents } from './campaign-store.js';
import { buildUniverseCampaignComparison } from './comparison.js';
import type { UniverseCampaignComparison, UniverseComparisonArmSource } from './comparison-types.js';
import { readUniverseDeliveries } from './delivery.js';
import { manifestRecord, projectUniverse, readRecords, universePath } from './store.js';
import type { UniverseStoreOptions } from './types.js';

interface Sample { source: UniverseComparisonArmSource; fingerprint: string }

function presentPrivatePaths(paths: string[]): boolean {
  for (const path of paths) {
    try { lstatSync(path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
    inspectPrivateDirectory(path);
  }
  return true;
}

/** Existing ledger codecs enforce their file, byte, shape and private-path bounds. */
function sample(campaignId: string, root: string): Sample {
  const source: UniverseComparisonArmSource = { campaignId, sourceState: 'missing', campaign: null,
    universe: null, seedDigest: null, deliveryReport: null, reasons: [] };
  const hash = createHash('sha256');
  let failure = 'Campaign evidence is unavailable or invalid';
  try {
    const directory = campaignDirectory(campaignId, { root });
    if (presentPrivatePaths([root, join(root, 'campaigns'), directory])) {
      source.sourceState = 'degraded';
      const events = readCampaignEvents(directory);
      // Hash records individually rather than building another ledger-sized string.
      for (const event of events) hash.update(canonical(event)).update('\n');
      const created = foldCampaignEvents(events).created;
      if (created.definition.id !== campaignId) throw new Error('Campaign identity mismatch');
      failure = 'Pinned Universe evidence is unavailable or invalid';
      const universeDirectory = universePath(root, created.definition.universeId);
      if (!presentPrivatePaths([join(root, 'universes'), universeDirectory])) throw new Error('Pinned Universe missing');
      const records = readRecords(universeDirectory);
      for (const record of records) hash.update(canonical(record)).update('\n');
      const manifest = manifestRecord(universeDirectory, records);
      if (manifest.manifest.id !== created.definition.universeId) throw new Error('Universe identity mismatch');
      source.seedDigest = manifest.seedArtifact.digest;
      source.universe = projectUniverse(universeDirectory, records);
      source.campaign = projectCampaign(events, source.universe);
      failure = 'Local delivery evidence is unavailable or invalid';
      source.deliveryReport = readUniverseDeliveries(created.definition.universeId, { root });
      if (source.universe.sourceState === 'healthy' && source.campaign.sourceState === 'healthy' &&
          source.deliveryReport.sourceState !== 'degraded') source.sourceState = 'healthy';
      else source.reasons.push('Selected campaign, Universe, or local delivery evidence is degraded');
    }
  } catch {
    source.sourceState = 'degraded';
    source.reasons.push(failure);
  }
  // Includes live-owner projection and delivery verification, not only durable bytes.
  hash.update(canonical(source));
  return { source, fingerprint: hash.digest('hex') };
}

/**
 * Observe exactly two selected sources, then recheck each once. This is a bounded
 * sampling check, not a storage lock or a claim that evidence cannot change later.
 * No global inventory, model calls, candidate execution, or store creation occurs.
 */
export function readUniverseCampaignComparison(baselineId: string, challengerId: string,
  options: UniverseStoreOptions = {}): UniverseCampaignComparison {
  const root = resolve(options.root ?? defaultUniverseRoot());
  campaignDirectory(baselineId, { root });
  campaignDirectory(challengerId, { root });
  if (baselineId === challengerId) throw new Error('Comparison requires two distinct campaign ids');
  const baseline = sample(baselineId, root);
  const challenger = sample(challengerId, root);
  for (const initial of [baseline, challenger]) {
    const checked = sample(initial.source.campaignId, root);
    if (initial.fingerprint !== checked.fingerprint) {
      initial.source.sourceState = 'degraded';
      initial.source.reasons = ['Selected evidence changed while the comparison was sampled'];
    }
  }
  return buildUniverseCampaignComparison(baseline.source, challenger.source);
}
