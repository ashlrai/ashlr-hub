import { lstatSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { readImmutablePrivateRecords, writeImmutablePrivateRecord,
  type ImmutablePrivateRecordCodec, type ImmutablePrivateRecordStoreConfig } from '../util/immutable-private-record-store.js';
import { canonical, defaultUniverseRoot, digest, inspectPrivateDirectory, readArtifactSnapshot } from './artifacts.js';
import { deliveryGit } from './delivery-git.js';
import { assertUniverseExecution, withUniverseExecution } from './execution.js';
import { assertComparatorUnchanged, manifestRecord, projectUniverse, readRecords, universePath, type ManifestRecord } from './store.js';
import type { UniverseStoreOptions, UniverseSummary } from './types.js';

export interface UniverseDeliveryReceipt {
  schemaVersion: 1;
  id: string;
  universeId: string;
  trialId: string;
  runId: string;
  niche: string;
  manifestDigest: string;
  comparatorDigest: string;
  artifactDigest: string;
  repo: string;
  branch: string;
  baseCommit: string;
  commit: string;
  tree: string;
  changedFiles: string[];
  status: 'pending' | 'delivered' | 'unchanged';
  createdAt: string;
  completedAt: string | null;
}
export interface UniverseDeliveryReport {
  deliveries: UniverseDeliveryReceipt[];
  sourceState: 'missing' | 'healthy' | 'degraded';
  reasons: string[];
}
type RecordEntry = { id: string; kind: 'intent' | 'receipt'; delivery: UniverseDeliveryReceipt };
const HASH = /^[a-f0-9]{64}$/;
const OID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const TRIAL_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;
const MAX_DELIVERIES = 128;

export function validUniverseDeliveryBranch(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 192 && value.startsWith('codex/') &&
    ![...value].some((part) => part.charCodeAt(0) <= 32 || part.charCodeAt(0) === 127 || '~^:?*[\\'.includes(part)) &&
    !value.includes('..') && !value.includes('@{') && !value.endsWith('.') &&
    value.split('/').every((part) => !!part && !part.startsWith('.') && !part.endsWith('.lock'));
}
function timestamp(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}
function deliveryId(universeId: string, branch: string): string { return digest(canonical({ domain: 'universe-delivery-v1', universeId, branch })); }
function parse(value: unknown): RecordEntry | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (Object.keys(row).sort().join(',') !== 'delivery,id,kind' || !['intent', 'receipt'].includes(String(row.kind)) ||
      row.delivery === null || typeof row.delivery !== 'object' || Array.isArray(row.delivery)) return null;
  const d = row.delivery as Record<string, unknown>;
  const keys = ['schemaVersion', 'id', 'universeId', 'trialId', 'runId', 'niche', 'manifestDigest', 'comparatorDigest',
    'artifactDigest', 'repo', 'branch', 'baseCommit', 'commit', 'tree', 'changedFiles', 'status', 'createdAt', 'completedAt'];
  if (Object.keys(d).length !== keys.length || Object.keys(d).some((key) => !keys.includes(key)) || d.schemaVersion !== 1 ||
      typeof d.universeId !== 'string' || !ID.test(d.universeId) || typeof d.trialId !== 'string' || !TRIAL_ID.test(d.trialId) ||
      typeof d.runId !== 'string' || !TRIAL_ID.test(d.runId) || typeof d.niche !== 'string' || !ID.test(d.niche) ||
      !validUniverseDeliveryBranch(d.branch) || d.id !== deliveryId(d.universeId, d.branch) || row.id !== `${d.id}.${row.kind}` ||
      !['manifestDigest', 'comparatorDigest', 'artifactDigest'].every((key) => typeof d[key] === 'string' && HASH.test(d[key])) ||
      !['baseCommit', 'commit', 'tree'].every((key) => typeof d[key] === 'string' && OID.test(d[key])) ||
      typeof d.repo !== 'string' || d.repo.length > 4_096 || !d.repo.startsWith('/') || d.repo.includes('\0') ||
      !Array.isArray(d.changedFiles) || d.changedFiles.length > 16_384 || new Set(d.changedFiles).size !== d.changedFiles.length ||
      !d.changedFiles.every((path) => typeof path === 'string' && path.length > 0 && path.length <= 4_096 && !path.includes('\0')) ||
      !timestamp(d.createdAt) || !['pending', 'delivered', 'unchanged'].includes(String(d.status)) ||
      (row.kind === 'intent' ? d.status !== 'pending' || d.completedAt !== null : d.status === 'pending' || !timestamp(d.completedAt)) ||
      (d.status === 'unchanged' && (d.changedFiles.length !== 0 || d.commit !== d.baseCommit)) ||
      (d.status === 'delivered' && d.changedFiles.length === 0)) return null;
  return value as RecordEntry;
}
const codec: ImmutablePrivateRecordCodec<RecordEntry> = {
  parse, serialize: (value) => `${canonical(value)}\n`, recordId: (value) => value.id,
  recordFileName: (value) => `${value.id}.json`, isRecordFileName: (name) => /^[a-f0-9]{64}\.(?:intent|receipt)\.json$/.test(name),
  stageToken: (value) => digest(canonical(value)), equivalent: (a, b) => canonical(a) === canonical(b),
};
function config(directory: string): ImmutablePrivateRecordStoreConfig<RecordEntry> {
  return { label: 'Universe delivery', anchorPath: directory, rootPath: join(directory, 'deliveries'), lockFileName: '.records.lock',
    maxRecordBytes: 1024 * 1024, defaultMaxFiles: MAX_DELIVERIES * 2, hardMaxFiles: MAX_DELIVERIES * 2,
    defaultMaxBytes: 32 * 1024 * 1024, hardMaxBytes: 32 * 1024 * 1024, codecForRead: () => codec, codecForWrite: () => codec };
}
function read(directory: string): UniverseDeliveryReceipt[] {
  inspectPrivateDirectory(directory);
  try { lstatSync(join(directory, 'deliveries')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  const result = readImmutablePrivateRecords(config(directory), { requireComplete: true });
  if (!result.complete || result.sourceState !== 'healthy') throw new Error('Universe delivery ledger is degraded');
  const intents = result.records.filter((row) => row.kind === 'intent');
  if (intents.length > MAX_DELIVERIES) throw new Error('Universe delivery capacity exhausted');
  for (const row of result.records.filter((item) => item.kind === 'receipt')) {
    const intent = intents.find((item) => item.delivery.id === row.delivery.id);
    if (!intent || canonical({ ...row.delivery, status: 'pending', completedAt: null }) !== canonical(intent.delivery)) {
      throw new Error('Delivery receipt does not match its durable intent');
    }
  }
  return intents.map((row) => result.records.find((item) => item.kind === 'receipt' && item.delivery.id === row.delivery.id)?.delivery ?? row.delivery)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}
function persist(directory: string, delivery: UniverseDeliveryReceipt): void {
  const kind = delivery.status === 'pending' ? 'intent' : 'receipt';
  if (!['recorded', 'replayed'].includes(writeImmutablePrivateRecord(config(directory), { id: `${delivery.id}.${kind}`, kind, delivery }))) {
    throw new Error('Universe delivery receipt could not be durably written');
  }
}
function changedPaths(git: ReturnType<typeof deliveryGit>, baseTree: string, tree: string): string[] {
  const base = new Map(git.entries(baseTree).map((entry) => [entry.path, `${entry.oid}:${entry.executable}`]));
  const next = new Map(git.entries(tree).map((entry) => [entry.path, `${entry.oid}:${entry.executable}`]));
  return [...new Set([...base.keys(), ...next.keys()])].filter((path) => base.get(path) !== next.get(path)).sort();
}
function commitBytes(delivery: Pick<UniverseDeliveryReceipt, 'id' | 'universeId' | 'trialId' | 'artifactDigest' | 'tree' | 'baseCommit'>, finishedAt: string): Buffer {
  const stamp = `${Math.floor(Date.parse(finishedAt) / 1000)} +0000`;
  return Buffer.from(`tree ${delivery.tree}\nparent ${delivery.baseCommit}\n` +
    `author Ashlr Universe <universe@ashlr.local> ${stamp}\ncommitter Ashlr Universe <universe@ashlr.local> ${stamp}\n\n` +
    `Universe elite delivery ${delivery.id}\n\nUniverse: ${delivery.universeId}\nTrial: ${delivery.trialId}\nArtifact-SHA256: ${delivery.artifactDigest}\n`, 'utf8');
}
function bindSource(delivery: UniverseDeliveryReceipt, universe: UniverseSummary, record: ManifestRecord): void {
  const run = universe.runs.find((item) => item.id === delivery.runId && item.status === 'completed');
  const trial = run?.trials.find((item) => item.id === delivery.trialId && item.selected && item.status === 'passed');
  if (!trial?.artifact || delivery.universeId !== record.manifest.id || delivery.niche !== trial.niche ||
      delivery.manifestDigest !== record.manifestDigest || delivery.comparatorDigest !== record.comparatorDigest ||
      delivery.artifactDigest !== trial.artifact.digest || delivery.repo !== record.manifest.seed.repo ||
      delivery.baseCommit !== record.manifest.seed.revision) throw new Error('Delivery provenance no longer matches verified experiment evidence');
  if (delivery.commit !== delivery.baseCommit) {
    const bytes = commitBytes(delivery, run!.finishedAt!);
    const expected = createHash(delivery.commit.length === 40 ? 'sha1' : 'sha256').update(`commit ${bytes.length}\0`).update(bytes).digest('hex');
    if (expected !== delivery.commit) throw new Error('Delivery commit identity is not the deterministic evidence-bound commit');
  }
  if (readArtifactSnapshot(trial.artifact.path).digest !== delivery.artifactDigest) throw new Error('Delivered archive is missing or changed');
}
function inspectGit(delivery: UniverseDeliveryReceipt, git = deliveryGit(delivery.repo)): void {
  if (git.oid(['rev-parse', '--verify', `${delivery.commit}^{commit}`]) !== delivery.commit ||
      git.oid(['rev-parse', '--verify', `${delivery.commit}^{tree}`]) !== delivery.tree || git.treeDigest(delivery.tree) !== delivery.artifactDigest) {
    throw new Error('Delivered Git commit or tree no longer matches the receipt');
  }
  const parents = git.text(['rev-list', '--parents', '-n', '1', delivery.commit]).split(' ');
  if (delivery.commit !== delivery.baseCommit && (parents.length !== 2 || parents[1] !== delivery.baseCommit)) throw new Error('Delivered Git parent changed');
  const baseTree = git.oid(['rev-parse', '--verify', `${delivery.baseCommit}^{tree}`]);
  if (canonical(changedPaths(git, baseTree, delivery.tree)) !== canonical(delivery.changedFiles)) throw new Error('Delivery changed-file evidence differs from its Git trees');
  const target = git.ref(delivery.branch);
  if (delivery.status === 'delivered' && target !== delivery.commit) throw new Error('Delivered branch is missing or has drifted');
  if (delivery.status === 'pending' && target !== null && target !== delivery.commit) throw new Error('Pending delivery branch conflicts with another ref');
}

/** Receipt inspection does not require the historical candidate to remain the current elite. */
export function readUniverseDeliveries(universeId: string, options: UniverseStoreOptions = {}): UniverseDeliveryReport {
  const deliveries: UniverseDeliveryReceipt[] = [];
  const reasons: string[] = [];
  try {
    if (!ID.test(universeId)) throw new Error('Invalid Universe id');
    const directory = universePath(resolve(options.root ?? defaultUniverseRoot()), universeId);
    try { lstatSync(directory); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { deliveries, sourceState: 'missing', reasons }; throw error; }
    deliveries.push(...read(directory));
    if (!deliveries.length) return { deliveries, sourceState: 'missing', reasons };
    const deadline = performance.now() + 10_000;
    const records = readRecords(directory);
    const record = manifestRecord(directory, records);
    const universe = projectUniverse(directory, records);
    if (universe.sourceState !== 'healthy') throw new Error('Delivery experiment evidence is degraded');
    const git = deliveryGit(record.manifest.seed.repo, deadline);
    for (const delivery of deliveries) {
      try {
        if (performance.now() >= deadline) throw new Error('Delivery inspection deadline exceeded');
        bindSource(delivery, universe, record);
        inspectGit(delivery, git);
      }
      catch (error) { reasons.push(`${delivery.branch}: ${error instanceof Error ? error.message : 'Delivery verification failed'}`); }
    }
    return { deliveries, sourceState: reasons.length ? 'degraded' : deliveries.length ? 'healthy' : 'missing', reasons };
  } catch (error) {
    reasons.push(error instanceof Error ? error.message : 'Delivery evidence unavailable');
    return { deliveries, sourceState: 'degraded', reasons };
  }
}

/** Deliver a current elite to a new local branch. Never checks out, pushes, merges, or executes candidate code. */
export async function deliverUniverseElite(universeId: string,
  options: UniverseStoreOptions & { trialId: string; branch: string }): Promise<UniverseDeliveryReceipt> {
  if (!ID.test(universeId) || !TRIAL_ID.test(options.trialId) || !validUniverseDeliveryBranch(options.branch)) throw new Error('Invalid Universe delivery identity or codex/ branch');
  return withUniverseExecution(universeId, options, async (lock) => {
    const directory = universePath(resolve(options.root ?? defaultUniverseRoot()), universeId);
    const records = readRecords(directory);
    const record = manifestRecord(directory, records);
    const universe = projectUniverse(directory, records);
    if (universe.sourceState !== 'healthy' || universe.activeRun) throw new Error('Universe delivery requires healthy, idle experiment evidence');
    assertComparatorUnchanged(record);
    const prior = read(directory);
    const existing = prior.find((receipt) => receipt.branch === options.branch);
    if (existing && existing.trialId !== options.trialId) throw new Error('Delivery branch is already bound to another trial');
    const run = universe.runs.find((item) => item.status === 'completed' && item.trials.some((trial) => trial.id === options.trialId && trial.selected));
    const trial = run?.trials.find((item) => item.id === options.trialId);
    if (!run || !trial?.artifact || trial.status !== 'passed' || (!existing && !universe.elites.some((elite) => elite.trialId === trial.id))) {
      throw new Error('Only a current independently selected elite can create a delivery');
    }
    const snapshot = readArtifactSnapshot(trial.artifact.path);
    if (snapshot.digest !== trial.artifact.digest) throw new Error('Elite artifact is missing or changed');
    const git = deliveryGit(record.manifest.seed.repo);
    git.invoke(['check-ref-format', '--branch', options.branch]);
    if (git.oid(['rev-parse', '--verify', `${record.manifest.seed.revision}^{commit}`]) !== record.manifest.seed.revision) throw new Error('Pinned seed commit changed');
    const baseTree = git.oid(['rev-parse', '--verify', `${record.manifest.seed.revision}^{tree}`]);
    if (git.treeDigest(baseTree) !== record.seedArtifact.digest) throw new Error('Pinned repository seed differs from experiment seed');
    if (existing) {
      bindSource(existing, universe, record);
      inspectGit(existing, git);
      if (existing.status !== 'pending') return existing;
    } else {
      if (prior.length >= MAX_DELIVERIES) throw new Error('Universe delivery capacity exhausted');
      if (git.ref(options.branch) !== null) throw new Error('Delivery refuses a pre-existing branch');
      git.assertNotCheckedOut(options.branch);
    }
    const tree = existing?.tree ?? git.writeTree(snapshot.entries);
    if (git.treeDigest(tree) !== snapshot.digest) throw new Error('Committed tree differs from the verified artifact');
    const changedFiles = changedPaths(git, baseTree, tree);
    const id = deliveryId(universeId, options.branch);
    const commit = existing?.commit ?? (tree === baseTree ? record.manifest.seed.revision : git.oid(['hash-object', '-t', 'commit', '-w', '--stdin'],
      commitBytes({ id, universeId, trialId: trial.id, artifactDigest: snapshot.digest, tree, baseCommit: record.manifest.seed.revision }, run.finishedAt!)));
    const intent: UniverseDeliveryReceipt = existing ?? { schemaVersion: 1, id, universeId, trialId: trial.id, runId: run.id, niche: trial.niche,
      manifestDigest: record.manifestDigest, comparatorDigest: record.comparatorDigest, artifactDigest: snapshot.digest,
      repo: record.manifest.seed.repo, branch: options.branch, baseCommit: record.manifest.seed.revision, commit, tree, changedFiles,
      status: 'pending', createdAt: new Date().toISOString(), completedAt: null };
    assertUniverseExecution(directory, lock);
    inspectGit(intent, git);
    if (!existing) persist(directory, intent);
    // The intent is durable before a branch can become visible. Crash recovery
    // accepts only this exact commit, never an unrelated existing branch.
    if (changedFiles.length) {
      const target = git.ref(options.branch);
      if (target !== null && target !== commit) throw new Error('Delivery branch conflicts with an existing ref');
      if (target === null) {
        assertUniverseExecution(directory, lock);
        git.assertNotCheckedOut(options.branch);
        await git.createRef(options.branch, commit);
      }
    }
    const completed: UniverseDeliveryReceipt = { ...intent, status: changedFiles.length ? 'delivered' : 'unchanged', completedAt: new Date().toISOString() };
    inspectGit(completed, git);
    assertUniverseExecution(directory, lock);
    persist(directory, completed);
    return completed;
  });
}
