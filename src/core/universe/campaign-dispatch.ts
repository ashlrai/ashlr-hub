import { canonical, digest } from './artifacts.js';
import { campaignDirectory, readCampaignEvents, readUniverseCampaign, validCampaignDispatchId } from './campaign-store.js';
import type { UniverseCampaignSummary } from './types.js';

export interface UniverseCampaignDispatchExpectation {
  dispatchId: string;
  intentAt: string;
  universeId: string;
  definitionDigest: string;
  manifestDigest: string;
  comparatorDigest: string;
  recordsDigest: string;
}

/** Read-only attribution, not recovery execution. A later completed snapshot alone
 * cannot prove that an interrupted controller owns the campaign's completion.
 * Legacy or ambiguous histories deliberately return no proof.
 */
export function readCompletedUniverseCampaignDispatch(id: string, expected: UniverseCampaignDispatchExpectation,
  options: { root: string }): { campaign: UniverseCampaignSummary; recordsDigest: string } | null {
  try {
    const pin = { ...expected };
    const intentMs = Date.parse(pin.intentAt);
    if (!validCampaignDispatchId(pin.dispatchId) || !Number.isFinite(intentMs) || new Date(intentMs).toISOString() !== pin.intentAt ||
        !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(pin.universeId) ||
        [pin.definitionDigest, pin.manifestDigest, pin.comparatorDigest, pin.recordsDigest].some((value) => !/^[a-f0-9]{64}$/.test(value))) return null;
    const directory = campaignDirectory(id, options);
    const records = readCampaignEvents(directory);
    const created = records[0];
    if (created?.kind !== 'created' || created.definition.id !== id || created.definition.universeId !== pin.universeId ||
        created.definitionDigest !== pin.definitionDigest || created.manifestDigest !== pin.manifestDigest ||
        created.comparatorDigest !== pin.comparatorDigest) return null;
    const startIndex = records.findIndex((event) => event.kind === 'started' && event.dispatchId === pin.dispatchId);
    if (startIndex < 1 || digest(canonical(records.slice(0, startIndex))) !== pin.recordsDigest) return null;
    const suffix = records.slice(startIndex);
    const settled = suffix.at(-1);
    if (suffix.length < 2 || settled?.kind !== 'settled' || settled.state !== 'completed' || settled.dispatchId !== pin.dispatchId ||
        suffix.slice(1, -1).some((event) => event.kind !== 'step')) return null;
    let previousAt = pin.intentAt;
    const observedAt = new Date().toISOString();
    for (const event of suffix) {
      if (event.at < previousAt || event.at > observedAt) return null;
      previousAt = event.at;
    }
    const recordsDigest = digest(canonical(records));
    const campaign = readUniverseCampaign(id, options);
    if (campaign.sourceState !== 'healthy' || campaign.state !== 'completed' || campaign.definition.id !== id ||
        campaign.definition.universeId !== pin.universeId || campaign.definitionDigest !== pin.definitionDigest ||
        campaign.manifestDigest !== pin.manifestDigest || campaign.comparatorDigest !== pin.comparatorDigest ||
        digest(canonical(readCampaignEvents(directory))) !== recordsDigest ||
        canonical(readUniverseCampaign(id, options)) !== canonical(campaign) ||
        digest(canonical(readCampaignEvents(directory))) !== recordsDigest) return null;
    return { campaign, recordsDigest };
  } catch { return null; }
}
