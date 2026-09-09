import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { readImmutablePrivateRecords, writeImmutablePrivateRecord,
  type ImmutablePrivateRecordCodec, type ImmutablePrivateRecordStoreConfig } from '../util/immutable-private-record-store.js';
import { canonical, defaultUniverseRoot, digest, readArtifactSnapshot } from './artifacts.js';
import { deliveryGit } from './delivery-git.js';
import { assertUniverseExecution, withUniverseExecution } from './execution.js';
import { assertUniverseIntegrationEvaluationsSettled, readUniverseIntegrationEvaluation,
  validateUniverseIntegrationEvaluationRequest } from './integration-evaluate.js';
import type { UniverseIntegrationEvaluationEvidence, UniverseIntegrationEvaluationRequest } from './integration-evaluation-types.js';
import type { UniverseIntegrationDeliveryReceipt, UniverseIntegrationDeliveryRequest } from './integration-delivery-types.js';
import { validUniverseDeliveryBranch } from './delivery.js';
import { assertComparatorUnchanged, manifestRecord, projectUniverse, universePath } from './store.js';
import type { UniverseStoreOptions } from './types.js';

const HASH = /^[a-f0-9]{64}$/;
const OID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const MAX_DELIVERIES = 128;

type Entry =
  { id: string; kind: 'intent'; request: UniverseIntegrationDeliveryRequest; receipt: UniverseIntegrationDeliveryReceipt } |
  { id: string; kind: 'receipt'; request: UniverseIntegrationDeliveryRequest; receipt: UniverseIntegrationDeliveryReceipt };

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
function exact(value: Record<string, unknown>, keys: string[]): boolean {
  const own = Reflect.ownKeys(value);
  return own.length === keys.length && own.every((key) => typeof key === 'string' && keys.includes(key));
}
function timestamp(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}
function evaluationRequestDigest(request: UniverseIntegrationEvaluationRequest): string {
  return digest(canonical({ domain: 'universe-integration-evaluation-v1', request }));
}
function requestDigest(request: UniverseIntegrationDeliveryRequest): string {
  return digest(canonical({ domain: 'universe-integration-delivery-request-v1', request }));
}
function receiptId(universeId: string, branch: string): string {
  return digest(canonical({ domain: 'universe-integration-delivery-v1', universeId, branch }));
}

/** Validate one exact local branch publication request before any evidence or Git reads. */
export function validateUniverseIntegrationDeliveryRequest(value: unknown): UniverseIntegrationDeliveryRequest {
  if (!object(value) || !exact(value, ['schemaVersion', 'evaluation', 'expectedEvaluationDigest', 'branch', 'maxDurationMs']) ||
      value.schemaVersion !== 1 || typeof value.expectedEvaluationDigest !== 'string' || !HASH.test(value.expectedEvaluationDigest) ||
      !validUniverseDeliveryBranch(value.branch) || !Number.isSafeInteger(value.maxDurationMs) ||
      (value.maxDurationMs as number) < 1 || (value.maxDurationMs as number) > 120_000) {
    throw new Error('Invalid Universe integration delivery request');
  }
  return { schemaVersion: 1, evaluation: validateUniverseIntegrationEvaluationRequest(value.evaluation),
    expectedEvaluationDigest: value.expectedEvaluationDigest, branch: value.branch, maxDurationMs: value.maxDurationMs as number };
}
function validReceipt(value: unknown): value is UniverseIntegrationDeliveryReceipt {
  if (!object(value) || !exact(value, ['schemaVersion', 'id', 'requestDigest', 'evaluationRequestDigest', 'evaluationResultDigest',
    'universeId', 'evaluationId', 'manifestDigest', 'comparatorDigest', 'compositionDigest', 'artifactDigest', 'repo', 'branch',
    'baseCommit', 'commit', 'tree', 'changedFiles', 'status', 'createdAt', 'completedAt']) || value.schemaVersion !== 1 ||
    typeof value.id !== 'string' || !HASH.test(value.id) || typeof value.requestDigest !== 'string' || !HASH.test(value.requestDigest) ||
    !['evaluationRequestDigest', 'evaluationResultDigest', 'manifestDigest', 'comparatorDigest', 'compositionDigest', 'artifactDigest']
      .every((key) => typeof value[key] === 'string' && HASH.test(value[key] as string)) || typeof value.universeId !== 'string' ||
    !ID.test(value.universeId) || typeof value.evaluationId !== 'string' || !ID.test(value.evaluationId) || typeof value.repo !== 'string' ||
    !value.repo.startsWith('/') || value.repo.length < 1 || value.repo.length > 4_096 || value.repo.includes('\0') ||
    !validUniverseDeliveryBranch(value.branch) || !['baseCommit', 'commit', 'tree'].every((key) => typeof value[key] === 'string' && OID.test(value[key] as string)) ||
    !Array.isArray(value.changedFiles) || value.changedFiles.length > 8_192 || new Set(value.changedFiles).size !== value.changedFiles.length ||
    !value.changedFiles.every((path) => typeof path === 'string' && path.length > 0 && path.length <= 4_096 && !path.includes('\0')) ||
    !['pending', 'delivered', 'unchanged'].includes(String(value.status)) || !timestamp(value.createdAt) ||
    (value.completedAt !== null && !timestamp(value.completedAt))) return false;
  if (value.id !== receiptId(value.universeId, value.branch) ||
      (value.status === 'pending' ? value.completedAt !== null : value.completedAt === null)) return false;
  if (value.status === 'delivered' && value.changedFiles.length === 0) return false;
  return value.status !== 'unchanged' || (value.commit === value.baseCommit && value.changedFiles.length === 0);
}
function parse(value: unknown): Entry | null {
  if (!object(value) || !exact(value, ['id', 'kind', 'request', 'receipt']) || !['intent', 'receipt'].includes(String(value.kind)) ||
      typeof value.id !== 'string' || !object(value.receipt)) return null;
  let request: UniverseIntegrationDeliveryRequest;
  try { request = validateUniverseIntegrationDeliveryRequest(value.request); } catch { return null; }
  if (!validReceipt(value.receipt) || value.id !== `${value.receipt.id}.${value.kind}` || value.receipt.requestDigest !== requestDigest(request) ||
      value.receipt.evaluationRequestDigest !== evaluationRequestDigest(request.evaluation) || value.receipt.universeId !== request.evaluation.acceptance.universeId ||
      value.receipt.evaluationId !== request.evaluation.id || value.receipt.manifestDigest !== request.evaluation.acceptance.manifestDigest ||
      value.receipt.comparatorDigest !== request.evaluation.acceptance.comparatorDigest || value.receipt.compositionDigest !== request.evaluation.expectedCompositionDigest ||
      value.receipt.evaluationResultDigest !== request.expectedEvaluationDigest ||
      value.receipt.repo !== request.evaluation.integration.target.repo || value.receipt.baseCommit !== request.evaluation.integration.target.baseCommit ||
      value.receipt.branch !== request.branch || (value.kind === 'intent' ? value.receipt.status !== 'pending' : value.receipt.status === 'pending')) return null;
  return value as Entry;
}
const codec: ImmutablePrivateRecordCodec<Entry> = {
  parse, serialize: (value) => `${canonical(value)}\n`, recordId: (value) => value.id,
  recordFileName: (value) => `${value.id}.json`, isRecordFileName: (name) => /^[a-f0-9]{64}\.(?:intent|receipt)\.json$/.test(name),
  stageToken: (value) => digest(canonical(value)), equivalent: (left, right) => canonical(left) === canonical(right),
};
function config(directory: string): ImmutablePrivateRecordStoreConfig<Entry> {
  return { label: 'Universe integration delivery', anchorPath: directory, rootPath: join(directory, 'integration-deliveries'),
    lockFileName: '.records.lock', maxRecordBytes: 1024 * 1024, defaultMaxFiles: MAX_DELIVERIES * 2, hardMaxFiles: MAX_DELIVERIES * 2,
    defaultMaxBytes: 32 * 1024 * 1024, hardMaxBytes: 32 * 1024 * 1024, codecForRead: () => codec, codecForWrite: () => codec };
}
function readEntries(directory: string): Entry[] {
  const result = readImmutablePrivateRecords(config(directory), { requireComplete: true });
  if (result.sourceState === 'missing') return [];
  if (!result.complete || result.sourceState !== 'healthy') throw new Error('Integration delivery evidence unavailable');
  const intents = new Map(result.records.filter((item): item is Extract<Entry, { kind: 'intent' }> => item.kind === 'intent')
    .map((item) => [item.receipt.id, item]));
  for (const item of result.records) {
    if (item.kind !== 'receipt') continue;
    const intent = intents.get(item.receipt.id);
    const pending = { ...item.receipt, status: 'pending', completedAt: null };
    if (!intent || canonical(intent.request) !== canonical(item.request) || canonical(intent.receipt) !== canonical(pending)) {
      throw new Error('Integration delivery receipt does not match its durable intent');
    }
  }
  return result.records;
}
function capacityAvailable(directory: string, existing: Entry[], request: UniverseIntegrationDeliveryRequest,
  receipt: UniverseIntegrationDeliveryReceipt): boolean {
  const intent: Entry = { id: `${receipt.id}.intent`, kind: 'intent', request, receipt };
  const intentBytes = Buffer.byteLength(codec.serialize(intent), 'utf8');
  const completed: Entry = { id: `${receipt.id}.receipt`, kind: 'receipt', request,
    receipt: { ...receipt, status: receipt.changedFiles.length ? 'delivered' : 'unchanged', completedAt: '9999-12-31T23:59:59.999Z' } };
  const receiptBytes = Buffer.byteLength(codec.serialize(completed), 'utf8');
  const limits = config(directory);
  const used = existing.reduce((sum, item) => sum + Buffer.byteLength(codec.serialize(item), 'utf8'), 0);
  return intentBytes <= limits.maxRecordBytes && receiptBytes <= limits.maxRecordBytes &&
    used + intentBytes + receiptBytes <= limits.defaultMaxBytes;
}
function persist(directory: string, request: UniverseIntegrationDeliveryRequest, receipt: UniverseIntegrationDeliveryReceipt): void {
  const kind = receipt.status === 'pending' ? 'intent' : 'receipt';
  const disposition = writeImmutablePrivateRecord(config(directory), { id: `${receipt.id}.${kind}`, kind, request, receipt });
  if (!['recorded', 'replayed'].includes(disposition)) throw new Error('Integration delivery receipt could not be durably written');
}
function changedPaths(git: ReturnType<typeof deliveryGit>, baseTree: string, tree: string): string[] {
  const base = new Map(git.entries(baseTree).map((entry) => [entry.path, `${entry.oid}:${entry.executable}`]));
  const next = new Map(git.entries(tree).map((entry) => [entry.path, `${entry.oid}:${entry.executable}`]));
  return [...new Set([...base.keys(), ...next.keys()])].filter((path) => base.get(path) !== next.get(path)).sort();
}
function commitBytes(receipt: Pick<UniverseIntegrationDeliveryReceipt, 'id' | 'evaluationResultDigest' | 'artifactDigest' | 'compositionDigest' |
  'manifestDigest' | 'comparatorDigest' | 'tree' | 'baseCommit'>, finishedAt: string): Buffer {
  const stamp = `${Math.floor(Date.parse(finishedAt) / 1_000)} +0000`;
  return Buffer.from(`tree ${receipt.tree}\nparent ${receipt.baseCommit}\n` +
    `author Ashlr Integration <integration@ashlr.local> ${stamp}\ncommitter Ashlr Integration <integration@ashlr.local> ${stamp}\n\n` +
    `Universe integration delivery ${receipt.id}\n\nEvaluation-SHA256: ${receipt.evaluationResultDigest}\nArtifact-SHA256: ${receipt.artifactDigest}\n` +
    `Composition-SHA256: ${receipt.compositionDigest}\nManifest-SHA256: ${receipt.manifestDigest}\nComparator-SHA256: ${receipt.comparatorDigest}\n`, 'utf8');
}
function inspectGit(receipt: UniverseIntegrationDeliveryReceipt, git: ReturnType<typeof deliveryGit>, evaluationFinishedAt: string): void {
  if (git.oid(['rev-parse', '--verify', `${receipt.baseCommit}^{commit}`]) !== receipt.baseCommit ||
      git.oid(['rev-parse', '--verify', `${receipt.commit}^{commit}`]) !== receipt.commit ||
      git.oid(['rev-parse', '--verify', `${receipt.commit}^{tree}`]) !== receipt.tree || git.treeDigest(receipt.tree) !== receipt.artifactDigest) {
    throw new Error('Integration delivery Git evidence changed');
  }
  const baseTree = git.oid(['rev-parse', '--verify', `${receipt.baseCommit}^{tree}`]);
  if (canonical(changedPaths(git, baseTree, receipt.tree)) !== canonical(receipt.changedFiles)) throw new Error('Integration delivery changed-file evidence changed');
  if (receipt.status === 'unchanged' && receipt.tree !== baseTree) throw new Error('Integration delivery unchanged tree differs from its base');
  if (receipt.commit !== receipt.baseCommit) {
    const parents = git.text(['rev-list', '--parents', '-n', '1', receipt.commit]).split(' ');
    const bytes = commitBytes(receipt, evaluationFinishedAt);
    const expected = createHash(receipt.commit.length === 40 ? 'sha1' : 'sha256').update(`commit ${bytes.length}\0`).update(bytes).digest('hex');
    if (parents.length !== 2 || parents[1] !== receipt.baseCommit || expected !== receipt.commit) throw new Error('Integration delivery commit identity changed');
  }
  const target = git.ref(receipt.branch);
  if (receipt.status === 'delivered' && target !== receipt.commit) throw new Error('Integration delivery branch is missing or drifted');
  if (receipt.status === 'unchanged' && target !== null) throw new Error('Integration delivery unchanged branch is no longer absent');
  if (receipt.status === 'pending' && target !== null && target !== receipt.commit) throw new Error('Integration delivery pending branch conflicts with another ref');
}
function revalidate(request: UniverseIntegrationDeliveryRequest, root: string): { evidence: UniverseIntegrationEvaluationEvidence; snapshot: ReturnType<typeof readArtifactSnapshot> } {
  const evidence = readUniverseIntegrationEvaluation(request.evaluation, { root });
  if (canonical(evidence.request) !== canonical(request.evaluation) || evidence.resultDigest !== request.expectedEvaluationDigest || evidence.result.status !== 'passed' || evidence.result.artifactPath === null ||
      evidence.result.artifactDigest === null || evidence.result.compositionDigest !== request.evaluation.expectedCompositionDigest) {
    throw new Error('Integration delivery requires a verified passing evaluation result');
  }
  const snapshot = readArtifactSnapshot(evidence.result.artifactPath);
  if (snapshot.digest !== evidence.result.artifactDigest) throw new Error('Integration delivery artifact changed');
  return { evidence, snapshot };
}
function assertReceiptEvidence(receipt: UniverseIntegrationDeliveryReceipt, evidence: UniverseIntegrationEvaluationEvidence,
  snapshot: ReturnType<typeof readArtifactSnapshot>): void {
  const request = evidence.request;
  const result = evidence.result;
  if (receipt.evaluationRequestDigest !== evaluationRequestDigest(request) || receipt.evaluationResultDigest !== evidence.resultDigest ||
      receipt.universeId !== request.acceptance.universeId || receipt.evaluationId !== request.id ||
      receipt.manifestDigest !== request.acceptance.manifestDigest || receipt.comparatorDigest !== request.acceptance.comparatorDigest ||
      receipt.compositionDigest !== result.compositionDigest || receipt.artifactDigest !== snapshot.digest ||
      receipt.repo !== request.integration.target.repo || receipt.baseCommit !== request.integration.target.baseCommit) {
    throw new Error('Integration delivery receipt evidence no longer matches its evaluation');
  }
}

/** Publish a verified integration artifact once to a new local codex/ branch; never evaluates, selects, or pushes. */
export async function deliverUniverseIntegration(input: unknown,
  options: UniverseStoreOptions & { signal?: AbortSignal } = {}): Promise<UniverseIntegrationDeliveryReceipt> {
  const request = validateUniverseIntegrationDeliveryRequest(input);
  const root = resolve(options.root ?? defaultUniverseRoot());
  return withUniverseExecution(request.evaluation.acceptance.universeId, { root }, async (lock) => {
    const directory = universePath(root, request.evaluation.acceptance.universeId);
    const deadline = performance.now() + request.maxDurationMs;
    const check = (): void => {
      options.signal?.throwIfAborted();
      if (performance.now() >= deadline) throw new Error('Integration delivery deadline exhausted');
    };
    const assertOwned = (): void => { assertUniverseExecution(directory, lock); };
    const source = (): { evidence: UniverseIntegrationEvaluationEvidence; snapshot: ReturnType<typeof readArtifactSnapshot> } => {
      check(); assertOwned(); const value = revalidate(request, root); check(); assertOwned(); return value;
    };
    assertOwned(); check();
    assertUniverseIntegrationEvaluationsSettled(request.evaluation.acceptance.universeId, { root });
    const record = manifestRecord(directory);
    const universe = projectUniverse(directory);
    if (universe.sourceState !== 'healthy' || universe.activeRun || record.manifestDigest !== request.evaluation.acceptance.manifestDigest ||
        record.comparatorDigest !== request.evaluation.acceptance.comparatorDigest || record.manifest.seed.repo !== request.evaluation.integration.target.repo ||
        record.manifest.seed.revision !== request.evaluation.integration.target.baseCommit) throw new Error('Integration delivery requires healthy, idle acceptance evidence');
    assertComparatorUnchanged(record);
    const { evidence, snapshot } = source();
    const git = deliveryGit(record.manifest.seed.repo, deadline);
    git.invoke(['check-ref-format', '--branch', request.branch]);
    if (git.oid(['rev-parse', '--verify', `${record.manifest.seed.revision}^{commit}`]) !== record.manifest.seed.revision) {
      throw new Error('Integration delivery pinned base changed');
    }
    const baseTree = git.oid(['rev-parse', '--verify', `${record.manifest.seed.revision}^{tree}`]);
    const prior = readEntries(directory);
    const resolved = new Map(prior.filter((item) => item.kind === 'receipt').map((item) => [item.receipt.id, item]));
    const pending = prior.filter((item) => item.kind === 'intent' && !resolved.has(item.receipt.id));
    if (pending.some((item) => item.request.branch !== request.branch)) throw new Error('Integration delivery has an unresolved branch publication');
    const id = receiptId(request.evaluation.acceptance.universeId, request.branch);
    const existing = resolved.get(id) ?? pending.find((item) => item.receipt.id === id);
    if (existing && canonical(existing.request) !== canonical(request)) throw new Error('Integration delivery branch is already bound to another request');
    if (existing?.kind === 'receipt') {
      const current = source(); assertReceiptEvidence(existing.receipt, current.evidence, current.snapshot);
      inspectGit(existing.receipt, git, current.evidence.result.finishedAt); return existing.receipt;
    }
    if (!existing) {
      if (pending.length || prior.filter((item) => item.kind === 'intent').length >= MAX_DELIVERIES) throw new Error('Integration delivery capacity exhausted');
      if (git.ref(request.branch) !== null) throw new Error('Integration delivery refuses a pre-existing branch');
      git.assertNotCheckedOut(request.branch);
    }
    if (existing?.kind === 'intent') {
      assertReceiptEvidence(existing.receipt, evidence, snapshot);
      inspectGit(existing.receipt, git, evidence.result.finishedAt);
    }
    const tree = existing?.receipt.tree ?? git.writeTree(snapshot.entries);
    if (git.treeDigest(tree) !== snapshot.digest) throw new Error('Integration delivery tree differs from the verified artifact');
    const changedFiles = changedPaths(git, baseTree, tree);
    const requestDigestValue = requestDigest(request);
    const createdAt = existing?.receipt.createdAt ?? new Date().toISOString();
    const provisional: UniverseIntegrationDeliveryReceipt = { schemaVersion: 1, id, requestDigest: requestDigestValue,
      evaluationRequestDigest: evaluationRequestDigest(request.evaluation), evaluationResultDigest: evidence.resultDigest,
      universeId: request.evaluation.acceptance.universeId, evaluationId: request.evaluation.id,
      manifestDigest: request.evaluation.acceptance.manifestDigest, comparatorDigest: request.evaluation.acceptance.comparatorDigest,
      compositionDigest: request.evaluation.expectedCompositionDigest, artifactDigest: snapshot.digest, repo: record.manifest.seed.repo,
      branch: request.branch, baseCommit: record.manifest.seed.revision, commit: record.manifest.seed.revision, tree, changedFiles,
      status: 'pending', createdAt, completedAt: null };
    const commit = tree === baseTree ? provisional.baseCommit : git.oid(['hash-object', '-t', 'commit', '-w', '--stdin'],
      commitBytes(provisional, evidence.result.finishedAt));
    const intent = { ...provisional, commit };
    if (existing?.kind === 'intent' && canonical(existing.receipt) !== canonical(intent)) {
      throw new Error('Integration delivery pending intent no longer matches current evidence');
    }
    if (!existing && !capacityAvailable(directory, prior, request, intent)) throw new Error('Integration delivery receipt exceeds bounded evidence capacity');
    const before = source(); assertReceiptEvidence(intent, before.evidence, before.snapshot); inspectGit(intent, git, before.evidence.result.finishedAt);
    if (!existing) persist(directory, request, intent);
    if (changedFiles.length) {
      const target = git.ref(request.branch);
      if (target !== null && target !== intent.commit) throw new Error('Integration delivery branch conflicts with an existing ref');
      if (target === null) {
        git.assertNotCheckedOut(request.branch);
        await git.createRef(request.branch, intent.commit, () => { source(); assertOwned(); check(); });
      }
    }
    // Publication may have succeeded even if cancellation arrived afterwards.
    // Reconcile read-only evidence and the exact ref without treating abort as
    // proof of non-publication; only the durable receipt write follows.
    const after = changedFiles.length ? revalidate(request, root) : source();
    const settledGit = changedFiles.length ? deliveryGit(record.manifest.seed.repo, performance.now() + 5_000) : git;
    assertReceiptEvidence(intent, after.evidence, after.snapshot);
    const completed: UniverseIntegrationDeliveryReceipt = { ...intent, status: changedFiles.length ? 'delivered' : 'unchanged', completedAt: new Date().toISOString() };
    inspectGit(completed, settledGit, after.evidence.result.finishedAt); assertOwned(); persist(directory, request, completed);
    return completed;
  });
}
