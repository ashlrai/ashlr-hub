/** Published website facts are presentation data, never installer or deployment authority. */
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { canonicalJson } from '../authority/canonical-json.js';
import { authorityDir, ensureAuthorityDir, readPrivateText, writePrivateAtomically } from '../authority/ledger.js';
import { acquireLocalStoreLock, releaseLocalStoreLock } from '../fleet/local-store-lock.js';
import { acquireOutwardMutationFence, releaseOutwardMutationFence } from '../sandbox/mutation-fence.js';
import { defaultReleaseArticlesDeps, type ReleaseArticlesDeps } from '../release-articles.js';
import { verifyLatestWorkbenchRelease } from '../release-public-facts.js';

const REPOSITORY = 'ashlrai/phantom-secrets';
const PREFIX = 'website-release-metadata:';
const INTERVAL_MS = 60_000;
const MAX_BYTES = 1024 * 1024;
interface MetadataAttempt {
  version: string; factsDigest: string; observedAt: string; attempted: boolean; taskId: string | null;
}
interface MetadataState { v: 1; lastCheckAt: string | null; attempts: MetadataAttempt[] }
export interface WebsiteReleaseMetadataResult {
  phase: 'held' | 'waiting' | 'queued' | 'awaiting-source';
  reason: string | null; taskId: string | null;
}
export type WebsiteReleaseMetadataDeps = Pick<ReleaseArticlesDeps,
  'now' | 'reader' | 'policy' | 'stopped' | 'stopEpoch' | 'enrolled' | 'queue' | 'enqueue'> & {
  /** Host closure binds current commissioned Auto/profile/generation; requests cannot supply it. */
  publicationBinding(): string | null;
};
export function defaultWebsiteReleaseMetadataDeps(publicationBinding: () => string | null): WebsiteReleaseMetadataDeps {
  return { ...defaultReleaseArticlesDeps(), publicationBinding };
}
export function websiteReleaseMetadataPath(): string { return join(authorityDir(), 'website-release-metadata.json'); }
function stamp(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 40 && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}
function readState(): MetadataState {
  const read = readPrivateText(websiteReleaseMetadataPath(), MAX_BYTES);
  if (read.state === 'missing') return { v: 1, lastCheckAt: null, attempts: [] };
  if (read.state !== 'ok') throw new Error('Website release metadata state is unavailable');
  const raw = JSON.parse(read.text) as MetadataState;
  if (!raw || Object.keys(raw).sort().join(',') !== 'attempts,lastCheckAt,v' || raw.v !== 1 ||
      (raw.lastCheckAt !== null && !stamp(raw.lastCheckAt)) || !Array.isArray(raw.attempts) || raw.attempts.some((a) =>
        !a || Object.keys(a).sort().join(',') !== 'attempted,factsDigest,observedAt,taskId,version' ||
        typeof a.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(a.version) || !/^[a-f0-9]{64}$/.test(a.factsDigest) ||
        !stamp(a.observedAt) || typeof a.attempted !== 'boolean' || (a.taskId !== null && (typeof a.taskId !== 'string' || a.taskId.length > 200))) ||
      new Set(raw.attempts.map((a) => a.factsDigest)).size !== raw.attempts.length) throw new Error('Website release metadata state is invalid');
  return raw;
}
function writeState(state: MetadataState): void {
  const text = `${canonicalJson(state)}\n`;
  if (Buffer.byteLength(text) > MAX_BYTES) throw new Error('Website release metadata state is full');
  writePrivateAtomically(websiteReleaseMetadataPath(), text);
}
function authorityBinding(deps: WebsiteReleaseMetadataDeps, signal?: AbortSignal): string | null {
  try {
    const publication = deps.publicationBinding(); const policy = deps.policy();
    if (!publication || signal?.aborted || deps.stopped() || !policy || policy.switch !== 'autonomous' ||
        !Number.isFinite(Date.parse(policy.expiresAt)) || Date.parse(policy.expiresAt) <= deps.now() ||
        !policy.repos.some((r) => r.nameWithOwner === REPOSITORY && r.stage === 'merge') || !deps.enrolled().includes(REPOSITORY)) return null;
    const { computedAt: _computedAt, ...stable } = policy;
    return createHash('sha256').update(canonicalJson({ publication, policy: stable, stopEpoch: deps.stopEpoch() })).digest('hex');
  } catch { return null; }
}
const result = (phase: WebsiteReleaseMetadataResult['phase'], reason: string | null = null, taskId: string | null = null): WebsiteReleaseMetadataResult => ({ phase, reason, taskId });
function newer(a: string, b: string): boolean {
  const x = a.split('.').map(BigInt); const y = b.split('.').map(BigInt);
  for (let i = 0; i < 3; i++) { if (x[i] !== y[i]) return x[i]! > y[i]!; }
  return false;
}

/** Independent of company articles. Queueing source work never means the website is published. */
export async function syncWebsiteReleaseMetadata(deps: WebsiteReleaseMetadataDeps, signal?: AbortSignal): Promise<WebsiteReleaseMetadataResult> {
  const binding = authorityBinding(deps, signal);
  if (!binding) return result('held', 'Website metadata maintenance needs current commissioned Auto and enrolled merge authority.');
  ensureAuthorityDir();
  const lock = acquireLocalStoreLock(join(authorityDir(), 'website-release-metadata.lock'), 0, { anchorPath: homedir(), exactPrivateStorage: true });
  if (!lock) return result('waiting', 'Website metadata maintenance is already running.');
  try {
    const state = readState(); const now = deps.now();
    if (state.lastCheckAt !== null && Date.parse(state.lastCheckAt) <= now && now - Date.parse(state.lastCheckAt) < INTERVAL_MS) return result('waiting');
    if (authorityBinding(deps, signal) !== binding) return result('held', 'Website metadata authority changed.');
    state.lastCheckAt = new Date(now).toISOString(); writeState(state);
    let release;
    try { release = await verifyLatestWorkbenchRelease(deps.reader, now, signal); }
    catch { return result('held', 'Latest published Phantom release could not be verified. Prior website metadata is unchanged.'); }
    if (authorityBinding(deps, signal) !== binding) return result('held', 'Website metadata authority changed.');
    if (state.attempts.some((a) => newer(a.version, release.version))) return result('held', 'Latest public release would downgrade recorded website maintenance.');
    const queue = deps.queue();
    if (!queue.ok) return result('held', 'Website metadata task queue is unavailable.');
    let attempt = state.attempts.find((a) => a.factsDigest === release.factsDigest);
    const existing = queue.tasks.find((t) => t.repo === REPOSITORY && t.dedupeKey === `${PREFIX}${release.factsDigest}`);
    if (existing) {
      if (!attempt) { attempt = { version: release.version, factsDigest: release.factsDigest, observedAt: release.observedAt, attempted: true, taskId: existing.id }; state.attempts.push(attempt); }
      attempt.attempted = true; attempt.taskId = existing.id; writeState(state);
      if (['failed', 'cancelled'].includes(existing.status)) return result('held', 'Previous website metadata task needs review.', existing.id);
      return result(['queued', 'parked', 'dispatched'].includes(existing.status) ? 'queued' : 'awaiting-source', null, existing.id);
    }
    // Queue retention or a crash must never erase an attempted outward write.
    if (attempt?.attempted) return result('awaiting-source', 'Recorded website metadata work needs source/deployment reconciliation.', attempt.taskId);
    const active = queue.tasks.find((t) => t.repo === REPOSITORY && t.dedupeKey?.startsWith(PREFIX) && ['queued', 'parked', 'dispatched'].includes(t.status));
    if (active) return result('waiting', 'An earlier website metadata task is still active.', active.id);
    const fence = acquireOutwardMutationFence();
    if (!fence) return result('held', 'Website metadata enqueue is held.');
    try {
      if (authorityBinding(deps, signal) !== binding) return result('held', 'Website metadata authority changed.');
      if (!attempt) { attempt = { version: release.version, factsDigest: release.factsDigest, observedAt: release.observedAt, attempted: false, taskId: null }; state.attempts.push(attempt); }
      attempt.attempted = true; writeState(state);
      let queued;
      try {
        queued = deps.enqueue({ repo: REPOSITORY, source: 'backlog', requestedBy: 'daemon', difficulty: 'low', value: 3,
          title: `Refresh Phantom ${release.version} website release metadata`, dedupeKey: `${PREFIX}${release.factsDigest}`,
          detail: `Refresh only apps/web/src/lib/workbench-release.json using fresh host-owned phm release-articles metadata --json. Expected public release data: ${JSON.stringify(release)}. Reobserve before editing; if latest changed, use its freshly verified record, never downgrade an existing newer record. If verification fails, leave prior metadata unchanged. This verifies public GitHub/source/CI/Audit/npm metadata, not original archive bytes, installer authority or installed acceptance. Preserve independent Secrets public-release.ts, Cloud/account flows and SEO. No company article, teaser, newsletter, outreach or paid artwork. Use normal source commit/PR/required checks/protected merge and the commissioned host website publisher; do not deploy directly. Task completion is not live publication.` });
      } catch { return result('held', 'Website metadata enqueue outcome is unknown; no replay will be attempted.'); }
      if (!queued.ok) { attempt.attempted = false; writeState(state); return result('held', 'Website metadata enqueue was refused.'); }
      attempt.taskId = queued.task.id; writeState(state); return result('queued', null, queued.task.id);
    } finally { releaseOutwardMutationFence(fence); }
  } finally { releaseLocalStoreLock(lock); }
}
