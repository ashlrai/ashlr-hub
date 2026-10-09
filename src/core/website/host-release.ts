/** Host-owned public website operations. Requests contain source hints, never deployment authority. */
import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { homedir } from 'node:os';
import { canonicalJson } from '../authority/canonical-json.js';
import { authorityDir, ensureAuthorityDir, readPrivateText, writePrivateAtomically } from '../authority/ledger.js';
import { currentStandingPolicy, evaluateStandingAuthority } from '../authority/effective-config.js';
import type { EffectivePolicy, StandingWebsitePublication } from '../authority/types.js';
import { acquireLocalStoreLock, releaseLocalStoreLock } from '../fleet/local-store-lock.js';
import { killSwitchOn } from '../sandbox/policy.js';

export const WEBSITE_PROFILE = Object.freeze({
  name: 'phantom-public-web' as const, repo: 'ashlrai/phantom-secrets', repoId: 1194099157,
  ownerId: 258113726, branch: 'main', root: 'apps/web', projectRootDirectory: null, scope: 'evero',
  projectId: 'prj_JWhwNui15SqYFzeBInVdUlqrOdd2', cliVersion: '63.1.0',
  cliIntegrity: 'sha512-JQvJODfMeBGejhW1nfu0zfczU8I0NiARD3FilxuBjFeMtEzgK2LeBD6RC1yyhwR8mVQzod/p/SbjyDNFx11njQ==',
  primaryDomain: 'phm.dev', routes: ['/', '/secrets'], recipe: 'phantom-public-web-v1',
});
export type WebsiteMode = 'auto' | 'paused' | 'off';
export type WebsitePhase = 'queued' | 'qualifying' | 'building' | 'upload-sent' | 'staged' | 'promote-sent' | 'published' | 'held' | 'failed' | 'upload-unknown' | 'promotion-unknown' | 'promoted-unverified';
export interface WebsiteCommission {
  v: 1; profile: typeof WEBSITE_PROFILE; actorId: string; teamId: string;
  /** Complete domain set affected by promote, not only the marketing hostname. */
  domains: string[]; projectSettings: Record<string, unknown>; publicBuildEnv: Record<string, string>;
  toolchain: { node: string; nodeSha256: string; cli: string; treeSha256: string; image: string; docker: string; dockerSha256: string };
  profileDigest: string;
  builderQualification: { source: WebsiteSource; outputDigest: string; image: string };
}
export interface WebsiteSource { merge: string; head: string; base: string; tree: string; pr: number; rulesDigest: string }
export interface WebsiteOperation {
  v: 1; id: string; revision: string; profileDigest: string; phase: WebsitePhase;
  at: string; reason: string | null; source?: WebsiteSource; outputDigest?: string;
  deploymentId?: string; deploymentUrl?: string; previousAliases?: Record<string, string | null>;
}
interface WebsiteState { v: 1; mode: WebsiteMode; generation: number; operations: WebsiteOperation[] }
export function websiteDigest(value: unknown): string { return createHash('sha256').update(canonicalJson(value)).digest('hex'); }
export function websiteToolsDir(): string { return join(homedir(), '.ashlr', 'website-tools'); }
function statePath(): string { return join(authorityDir(), 'website-publication.json'); }
function commissionPath(): string { return join(authorityDir(), 'website-commission.json'); }
const SHA = /^[a-f0-9]{40}$/;
const HEX = /^[a-f0-9]{64}$/;
function ownObject(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
function strictRead(path: string): unknown {
  const read = readPrivateText(path, 8 * 1024 * 1024);
  if (read.state === 'missing') return null;
  if (read.state !== 'ok') throw new Error('Website private state is unavailable');
  try { return JSON.parse(read.text); } catch { throw new Error('Website private state is invalid'); }
}
function readState(): WebsiteState {
  const value = strictRead(statePath());
  if (value === null) return { v: 1, mode: 'off', generation: 0, operations: [] };
  if (!ownObject(value) || value['v'] !== 1 || !['auto', 'paused', 'off'].includes(String(value['mode'])) ||
      !Number.isSafeInteger(value['generation']) || Number(value['generation']) < 0 || !Array.isArray(value['operations']) ||
      value['operations'].some((op) => !ownObject(op) || op['v'] !== 1 || !HEX.test(String(op['id'])) || !SHA.test(String(op['revision'])) ||
        !HEX.test(String(op['profileDigest'])) || !['queued','qualifying','building','upload-sent','staged','promote-sent','published','held','failed','upload-unknown','promotion-unknown','promoted-unverified'].includes(String(op['phase'])))) {
    throw new Error('Website private operation state is invalid');
  }
  return value as unknown as WebsiteState;
}
function changeState<T>(fn: (state: WebsiteState) => T): T {
  ensureAuthorityDir();
  const lock = acquireLocalStoreLock(join(authorityDir(), 'website-state.lock'), 0, { anchorPath: homedir(), exactPrivateStorage: true });
  if (!lock) throw new Error('Website state is busy');
  try { const state = readState(); const result = fn(state); writePrivateAtomically(statePath(), `${canonicalJson(state)}\n`); return result; }
  finally { releaseLocalStoreLock(lock); }
}
/** Local commissioning metadata is only meaningful when its digest is in the actual signed grant. */
export function readWebsiteCommission(): WebsiteCommission | null {
  const value = strictRead(commissionPath());
  if (value === null) return null;
  if (!ownObject(value) || value['v'] !== 1 || !ownObject(value['profile']) || websiteDigest(value['profile']) !== websiteDigest(WEBSITE_PROFILE) ||
      typeof value['actorId'] !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value['actorId']) ||
      typeof value['teamId'] !== 'string' || !/^team_[A-Za-z0-9]+$/.test(value['teamId']) || !Array.isArray(value['domains']) ||
      value['domains'].length === 0 || value['domains'].some((d) => typeof d !== 'string' || !/^[a-z0-9.-]+$/.test(d)) ||
      !value['domains'].includes(WEBSITE_PROFILE.primaryDomain) || new Set(value['domains']).size !== value['domains'].length ||
      !ownObject(value['builderQualification']) || !HEX.test(String(value['builderQualification']['outputDigest'])) || value['builderQualification']['image'] !== (ownObject(value['toolchain']) ? value['toolchain']['image'] : null) ||
      !ownObject(value['projectSettings']) || !ownObject(value['publicBuildEnv']) || !ownObject(value['toolchain']) || !HEX.test(String(value['profileDigest']))) {
    throw new Error('Website commissioning metadata is invalid');
  }
  const { profileDigest, ...payload } = value;
  if (websiteDigest(payload) !== profileDigest) throw new Error('Website commissioning metadata changed');
  return value as unknown as WebsiteCommission;
}
/** Only the host metadata/tool qualifier calls this; CLI accepts no arbitrary JSON profile. */
export function saveWebsiteCommission(value: WebsiteCommission): void {
  const { profileDigest, ...payload } = value;
  if (websiteDigest(payload) !== profileDigest || websiteDigest(value.profile) !== websiteDigest(WEBSITE_PROFILE)) throw new Error('Invalid website commissioning pins');
  ensureAuthorityDir();
  writePrivateAtomically(commissionPath(), `${canonicalJson(value)}\n`);
  readWebsiteCommission();
}
export function websiteScope(value: WebsiteCommission): StandingWebsitePublication {
  return { profile: WEBSITE_PROFILE.name, profileDigest: value.profileDigest, mode: 'automatic' };
}
export function assertWebsiteAuthority(commission: WebsiteCommission, generation?: number): void {
  const policy = evaluateStandingAuthority({ mode: 'fresh', surface: 'running' }).policy;
  const state = readState();
  if (killSwitchOn() || !policy || policy.switch !== 'autonomous' || !Number.isFinite(Date.parse(policy.expiresAt)) || Date.parse(policy.expiresAt) <= Date.now() ||
      policy.websitePublication?.profile !== WEBSITE_PROFILE.name || policy.websitePublication.profileDigest !== commission.profileDigest ||
      policy.websitePublication.mode !== 'automatic' || !policy.repos.some((r) => r.nameWithOwner === WEBSITE_PROFILE.repo) ||
      state.mode !== 'auto' || (generation !== undefined && generation !== state.generation)) throw new Error('Website publication is held by current authority or operating mode');
}
export function setWebsiteMode(mode: WebsiteMode): { mode: WebsiteMode; generation: number } {
  if (!['auto', 'paused', 'off'].includes(mode)) throw new Error('Website mode must be Auto, Paused or Off');
  if (mode === 'auto') {
    const commission = readWebsiteCommission();
    const policy = evaluateStandingAuthority({ mode: 'fresh', surface: 'running' }).policy;
    if (!commission || !policy || policy.websitePublication?.profileDigest !== commission.profileDigest || policy.websitePublication.profile !== WEBSITE_PROFILE.name) {
      throw new Error('Commission website publication before enabling Auto');
    }
  }
  // Persist lowering first. Every contact freshly rereads this generation.
  return changeState((state) => { if (state.mode !== mode) state.generation++; state.mode = mode; return { mode, generation: state.generation }; });
}
export function websiteStatus(policyOverride?: EffectivePolicy | null): { mode: WebsiteMode; phase: string; reason: string | null; revision: string | null } {
  try {
    const state = readState(); const last = state.operations.at(-1);
    const commission = readWebsiteCommission();
    let reason: string | null = null;
    if (!commission) reason = 'Website publication has not been commissioned';
    else {
      // Display is cheap. Only provider-contact fences require a fresh, uncached authority evaluation.
      const policy = policyOverride === undefined ? currentStandingPolicy() : policyOverride;
      if (state.mode !== 'auto' || killSwitchOn() || !policy || policy.switch !== 'autonomous' ||
          !Number.isFinite(Date.parse(policy.expiresAt)) || Date.parse(policy.expiresAt) <= Date.now() ||
          policy.websitePublication?.profileDigest !== commission.profileDigest || policy.websitePublication.profile !== WEBSITE_PROFILE.name) reason = 'Website publication is paused, stopped or awaiting a valid grant';
    }
    return { mode: state.mode, phase: reason ? 'held' : last?.phase ?? 'idle', reason: reason ?? last?.reason ?? null, revision: last?.revision ?? null };
  } catch { return { mode: 'off', phase: 'held', reason: 'Website publication state is unavailable', revision: null }; }
}
export function requestWebsitePublication(input: unknown): { status: 'queued' | 'held' | 'already-recorded'; operationId: string | null } {
  if (!ownObject(input) || Object.keys(input).sort().join(',') !== 'expectedMerge,profile' || input['profile'] !== WEBSITE_PROFILE.name || !SHA.test(String(input['expectedMerge']))) throw new Error('Expected the fixed website profile and exact merged revision');
  const commission = readWebsiteCommission();
  if (!commission) return { status: 'held', operationId: null };
  try { assertWebsiteAuthority(commission); } catch { return { status: 'held', operationId: null }; }
  return changeState((state) => {
    const revision = String(input['expectedMerge']); const id = websiteDigest({ profileDigest: commission.profileDigest, revision });
    if (state.operations.some((op) => op.id === id)) return { status: 'already-recorded' as const, operationId: id };
    state.operations.push({ v: 1, id, revision, profileDigest: commission.profileDigest, phase: 'queued', at: new Date().toISOString(), reason: null });
    return { status: 'queued' as const, operationId: id };
  });
}
export interface OutputEntry { path: string; kind: 'file' | 'directory'; mode: number; size: number; sha256: string | null }
/** Complete inventory; a symlink, special file, hard link or changing file refuses publication. */
export function inventoryWebsiteOutput(root: string): { entries: OutputEntry[]; digest: string } {
  const entries: OutputEntry[] = [];
  const visit = (path: string): void => {
    const before = lstatSync(path, { bigint: true });
    const name = relative(root, path).split('\\').join('/');
    if (before.isSymbolicLink() || (!before.isDirectory() && !before.isFile()) || (before.isFile() && before.nlink !== 1n)) throw new Error('Website output contains an unsupported path');
    if (before.isDirectory()) {
      entries.push({ path: name, kind: 'directory', mode: Number(before.mode & 0o777n), size: 0, sha256: null });
      for (const child of readdirSync(path).sort()) visit(join(path, child));
    } else {
      const bytes = readFileSync(path); const after = lstatSync(path, { bigint: true });
      if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) throw new Error('Website output changed during inventory');
      entries.push({ path: name, kind: 'file', mode: Number(before.mode & 0o777n), size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
    }
    const after = lstatSync(path, { bigint: true });
    if (before.dev !== after.dev || before.ino !== after.ino || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) throw new Error('Website output changed during inventory');
  };
  visit(root);
  if (!entries.some((e) => e.path === 'config.json' && e.kind === 'file')) throw new Error('Vercel output config is missing');
  return { entries, digest: websiteDigest(entries) };
}
export interface WebsiteHostAdapter {
  currentMerge(): Promise<string>;
  qualifySource(revision: string): Promise<WebsiteSource>;
  build(op: WebsiteOperation, source: WebsiteSource): Promise<string>;
  identities(): Promise<void>;
  aliases(): Promise<Record<string, string | null>>;
  stage(op: WebsiteOperation, authorize: () => Promise<void>): Promise<{ id: string; url: string }>;
  validateStage(op: WebsiteOperation): Promise<void>;
  promote(op: WebsiteOperation, authorize: () => Promise<void>): Promise<void>;
  published(op: WebsiteOperation): Promise<boolean>;
  output(op: WebsiteOperation): string;
}
/** Public source evidence has no power to bypass a fresh policy/mode/output/contact fence. */
export async function drainWebsitePublication(adapter: WebsiteHostAdapter, signal?: AbortSignal): Promise<void> {
  const commission = readWebsiteCommission(); if (!commission) return;
  try { assertWebsiteAuthority(commission); } catch { return; }
  ensureAuthorityDir();
  const lock = acquireLocalStoreLock(join(authorityDir(), 'website-worker.lock'), 0, { anchorPath: homedir(), exactPrivateStorage: true });
  if (!lock) return;
  let op: WebsiteOperation | undefined;
  try {
    const generation = readState().generation;
    const authorized = (): void => { if (signal?.aborted) throw new Error('Website operation was stopped'); assertWebsiteAuthority(commission, generation); };
    authorized();
    const latest = await adapter.currentMerge(); authorized();
    requestWebsitePublication({ profile: WEBSITE_PROFILE.name, expectedMerge: latest });
    op = readState().operations.find((row) => row.profileDigest === commission.profileDigest && ['upload-sent','upload-unknown','promote-sent','promotion-unknown','promoted-unverified'].includes(row.phase));
    if (op) {
      // A sent operation is reconciled, never blindly repeated after restart.
      if (op.deploymentId && await adapter.published(op)) patchOperation(op, { phase: 'published', reason: null });
      else patchOperation(op, { phase: op.phase.startsWith('upload') ? 'upload-unknown' : 'promotion-unknown', reason: 'Provider contact needs reconciliation; no mutation was retried' });
      return;
    }
    op = readState().operations.find((row) => row.revision === latest && row.profileDigest === commission.profileDigest && (['queued','qualifying','building','staged'].includes(row.phase) || (row.phase === 'held' && !!row.deploymentId)));
    if (!op) return;
    patchOperation(op, { phase: 'qualifying' });
    const source = await adapter.qualifySource(op.revision); authorized();
    if (op.outputDigest && op.source && websiteDigest(source) !== websiteDigest(op.source)) throw new Error('Website persisted source qualification changed');
    patchOperation(op, { source, phase: 'building' });
    // A known frozen output survives a restart. Its complete pin is freshly checked before reuse.
    const outputDigest = op.outputDigest ?? await adapter.build(op, source); authorized();
    if (inventoryWebsiteOutput(adapter.output(op)).digest !== outputDigest) throw new Error('Website persisted output changed');
    patchOperation(op, { outputDigest });
    await adapter.identities(); authorized();
    const previousAliases = op.previousAliases ?? await adapter.aliases(); authorized();
    patchOperation(op, { previousAliases });
    const beforeContact = async (): Promise<void> => {
      authorized(); await adapter.identities();
      const fresh = await adapter.qualifySource(op!.revision); authorized();
      if (websiteDigest(fresh) !== websiteDigest(source) || inventoryWebsiteOutput(adapter.output(op!)).digest !== op!.outputDigest) throw new Error('Website source or frozen output changed');
    };
    const authorizeContact = async (): Promise<void> => {
      await beforeContact();
      if (websiteDigest(await adapter.aliases()) !== websiteDigest(previousAliases)) throw new Error('Website production aliases changed before contact');
      authorized();
    };
    await authorizeContact();
    if (!op.deploymentId) {
      patchOperation(op, { phase: 'upload-sent' });
      const staged = await adapter.stage(op, authorizeContact);
      patchOperation(op, { phase: 'staged', deploymentId: staged.id, deploymentUrl: staged.url });
    } else patchOperation(op, { phase: 'staged' });
    await adapter.validateStage(op); authorized();
    await authorizeContact();
    patchOperation(op, { phase: 'promote-sent' });
    await adapter.promote(op, authorizeContact);
    // Read-only reconciliation continues after contact even if Stop lands.
    if (await adapter.published(op)) patchOperation(op, { phase: 'published', reason: null });
    else patchOperation(op, { phase: 'promoted-unverified', reason: 'Promotion sent; production routes are not verified' });
  } catch (error) {
    // Adapter failures never return child output. Expose only its source-owned diagnostic vocabulary.
    const reason = error instanceof Error && /^Website [A-Za-z0-9 ,;/.:-]{1,180}$/.test(error.message) ? error.message : 'Website qualification or provider contact failed';
    if (op) patchOperation(op, { phase: op.phase === 'upload-sent' ? 'upload-unknown' : op.phase === 'promote-sent' ? 'promotion-unknown' : 'held', reason });
  } finally { releaseLocalStoreLock(lock); }
}
function patchOperation(op: WebsiteOperation, patch: Partial<WebsiteOperation>): void {
  changeState((state) => {
    const actual = state.operations.find((row) => row.id === op.id);
    if (!actual) throw new Error('Website operation disappeared');
    Object.assign(actual, patch, { at: new Date().toISOString() }); Object.assign(op, actual);
  });
}
let active: Promise<void> | null = null;
export function scheduleWebsitePublication(signal?: AbortSignal): Promise<void> {
  if (!active) active = import('./host-adapter.js').then(async ({ createWebsiteHostAdapter }) => {
    const commission = readWebsiteCommission(); if (commission) await drainWebsitePublication(createWebsiteHostAdapter(commission, signal), signal);
  }).catch(() => undefined).finally(() => { active = null; });
  return active;
}
