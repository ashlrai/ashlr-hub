import { validOutcomeManagerState } from './outcome-manager-types.js';
import { acquireLocalStoreLockWithOutcome, ownsLocalStoreLock, releaseLocalStoreLock } from '../fleet/local-store-lock.js';
import { isAbsolute, join, normalize, resolve } from 'node:path';
import { inspectPrivateDirectory, privateDirectory } from '../universe/artifacts.js';
import { readImmutablePrivateRecords, recoverImmutablePrivateRecordStore, writeImmutablePrivateRecord,
  type ImmutablePrivateRecordCodec, type ImmutablePrivateRecordStoreConfig } from '../util/immutable-private-record-store.js';
import { validateEcosystemMissionGraph } from '../vision/mission-graph.js';
import { normalizeOutcomeScope, outcomeCanonical, outcomeDigest, outcomeGraphObjective, outcomeHash, outcomeIdentity, outcomeToken,
  type OutcomeRead, type OutcomeRecord, type OutcomeState, type OutcomeWrite } from './outcome-types.js';

function validState(state: OutcomeState): boolean {
  if (!state || ![1, 2].includes(state.schemaVersion) ||
      (state.schemaVersion === 1 ? Object.hasOwn(state, 'manager') : !state.manager || !validOutcomeManagerState(state.manager, state)) || !outcomeIdentity(state.id) ||
      !Number.isSafeInteger(state.revision) || state.revision < 1 ||
      !Number.isSafeInteger(state.scopeRevision) || state.scopeRevision < 1 ||
      !Number.isSafeInteger(state.planRevision) || state.planRevision < 0 ||
      typeof state.paused !== 'boolean' || !Array.isArray(state.activeNodeIds) ||
      new Set(state.activeNodeIds).size !== state.activeNodeIds.length || !state.nodes || Array.isArray(state.nodes)) return false;
  try {
    if (outcomeCanonical(normalizeOutcomeScope(state.scope)) !== outcomeCanonical(state.scope) ||
        outcomeDigest(state.scope) !== state.scopeDigest ||
        !(state.graphDigest === null || outcomeHash(state.graphDigest))) return false;
    for (const [id, node] of Object.entries(state.nodes)) {
      if (!outcomeHash(id) || node.id !== id || !outcomeHash(node.semanticDigest) || !node.basis ||
          !outcomeHash(node.basis.scopeDigest) || !outcomeHash(node.basis.graphDigest) ||
          !Number.isSafeInteger(node.basis.scopeRevision) || node.basis.scopeRevision < 1 || node.basis.scopeRevision > state.scopeRevision ||
          !Number.isSafeInteger(node.basis.planRevision) || node.basis.planRevision < 1 || node.basis.planRevision > state.planRevision ||
          !Array.isArray(node.basis.dependencies) || node.basis.dependencies.some(dep => !state.nodes[dep]) ||
          !node.materialization || node.materialization.goalId !== `outcome-${id}` || node.materialization.milestoneId !== `milestone-${id}` ||
          !['intent', 'linked'].includes(node.materialization.state) || !Array.isArray(node.attempts)) return false;
      const semantic = { definition: node.basis.definition, dependencies: node.basis.dependencies };
      if (outcomeDigest(semantic) !== node.semanticDigest ||
          outcomeDigest([state.id, node.basis.scopeDigest, node.basis.scopeRevision, node.semanticDigest]) !== id) return false;
      const seen = new Set<string>();
      for (const attempt of node.attempts) {
        if (!outcomeToken(attempt.id) || seen.has(attempt.id) || typeof attempt.executionRepo !== 'string' ||
            !isAbsolute(attempt.executionRepo) || normalize(attempt.executionRepo) !== attempt.executionRepo || attempt.executionRepo.includes('\0') ||
            attempt.workItemId !== `goal:${node.materialization.goalId}:${node.materialization.milestoneId}` ||
            attempt.generationId !== `outcome:v1:${outcomeDigest([id, attempt.id])}` ||
            !(attempt.runId === null || outcomeToken(attempt.runId)) || !(attempt.proposalId === null || outcomeToken(attempt.proposalId)) ||
            !Array.isArray(attempt.providerRunIds) || attempt.providerRunIds.some(runId => !outcomeToken(runId)) ||
            new Set(attempt.providerRunIds).size !== attempt.providerRunIds.length ||
            !(attempt.terminalRunId === null || attempt.providerRunIds.includes(attempt.terminalRunId)) ||
            (attempt.runId === null ? attempt.providerRunIds.length !== 0 || attempt.terminalRunId !== null : !attempt.providerRunIds.includes(attempt.runId)) ||
            !['claimed', 'running', 'proposed', 'failed', 'aborted', 'complete'].includes(attempt.state) ||
            (['claimed', 'running'].includes(attempt.state) && (attempt.terminalRunId !== null || attempt.proposalId !== null)) ||
            (attempt.state === 'claimed' && attempt.runId !== null) || (attempt.state === 'running' && attempt.runId === null) ||
            (['proposed', 'failed', 'complete'].includes(attempt.state) && attempt.terminalRunId === null) ||
            (['proposed', 'complete'].includes(attempt.state) && attempt.proposalId === null) ||
            (['failed', 'aborted'].includes(attempt.state) && attempt.proposalId !== null) ||
            (attempt.state === 'aborted' && attempt.runId !== null && attempt.terminalRunId === null)) return false;
        seen.add(attempt.id);
      }
      if (node.humanApproval !== null && (!node.humanApproval || !outcomeHash(node.humanApproval.receiptDigest) ||
          node.basis.definition.kind !== 'human-gate')) return false;
      if (node.completion && (!outcomeToken(node.completion.proposalId) || typeof node.completion.mergeIdentity !== 'string' ||
          !node.attempts.some(attempt => attempt.id === node.completion!.attemptId && attempt.state === 'complete' &&
            attempt.proposalId === node.completion!.proposalId))) return false;
    }
    if (state.activeNodeIds.some(id => !state.nodes[id] || state.nodes[id]!.basis.scopeDigest !== state.scopeDigest ||
        state.nodes[id]!.basis.scopeRevision !== state.scopeRevision)) return false;
    if (state.graphDigest !== null) {
      if (!state.graph || state.graph.graphDigest !== state.graphDigest || state.graph.missionKey !== state.id ||
          state.graph.objective !== outcomeGraphObjective(state) || validateEcosystemMissionGraph(state.graph).length ||
          state.graph.nodes.length !== state.activeNodeIds.length || state.activeNodeIds.some(id => {
        const node = state.nodes[id]!;
        return !state.graph!.nodes.some(definition => outcomeCanonical(definition) === outcomeCanonical(node.basis.definition)) ||
          node.basis.definition.repo !== null && !state.scope.targetRepos.includes(node.basis.definition.repo) ||
          node.basis.dependencies.some(dep => !state.activeNodeIds.includes(dep)) ||
          outcomeCanonical(node.basis.definition.dependsOn.slice().sort()) !== outcomeCanonical(
            node.basis.dependencies.map(dep => state.nodes[dep]!.basis.definition.key).sort());
      })) return false;
    } else if (state.activeNodeIds.length || state.graph !== null) return false;
    return true;
  } catch { return false; }
}
function parse(value: unknown): OutcomeRecord | null {
  try {
    const record = value as OutcomeRecord;
    if (!record || ![1, 2].includes(record.schemaVersion) || record.schemaVersion !== record.state?.schemaVersion || !Number.isSafeInteger(record.revision) || record.revision < 1 ||
        !outcomeToken(record.commandId) || !outcomeHash(record.requestDigest) ||
        !(record.previousDigest === null || outcomeHash(record.previousDigest)) || !validState(record.state) ||
        record.state.revision !== record.revision || !outcomeHash(record.digest)) return null;
    const { digest, ...payload } = record;
    return digest === outcomeDigest(payload) ? record : null;
  } catch { return null; }
}
const codec: ImmutablePrivateRecordCodec<OutcomeRecord> = {
  parse, serialize: value => `${outcomeCanonical(value)}\n`, recordId: value => String(value.revision),
  recordFileName: value => `${String(value.revision).padStart(16, '0')}.json`,
  isRecordFileName: name => /^\d{16}\.json$/.test(name), stageToken: value => value.digest,
  equivalent: (a, b) => outcomeCanonical(a) === outcomeCanonical(b), compare: (a, b) => a.revision - b.revision,
};

/** One outcome per private directory. Bounds are filesystem admission bounds, never agent budgets.
 * Full-state immutable revisions avoid a mutable head pointer and its crash window. */
export class OutcomeStore {
  readonly directory: string;
  constructor(directory: string) { this.directory = resolve(directory); }
  private config(): ImmutablePrivateRecordStoreConfig<OutcomeRecord> {
    return { label: 'Outcome coordinator', anchorPath: this.directory, rootPath: join(this.directory, 'ledger'),
      lockFileName: '.records.lock', maxRecordBytes: 1024 * 1024, defaultMaxFiles: 100000, hardMaxFiles: 100000,
      defaultMaxBytes: 1024 * 1024 * 1024, hardMaxBytes: 1024 * 1024 * 1024,
      codecForRead: () => codec, codecForWrite: () => codec };
  }
  read(): OutcomeRead {
    try {
      inspectPrivateDirectory(this.directory);
      const result = readImmutablePrivateRecords(this.config(), { requireComplete: true });
      if (result.sourceState === 'missing') return { sourceState: 'missing', state: null, records: [] };
      if (!result.complete || result.sourceState !== 'healthy') return { sourceState: 'degraded', state: null, records: [] };
      const commands = new Set<string>();
      for (const [index, record] of result.records.entries()) {
        if (record.revision !== index + 1 || record.previousDigest !== (index ? result.records[index - 1]!.digest : null) ||
            commands.has(record.commandId) || (index && record.state.id !== result.records[0]!.state.id)) {
          return { sourceState: 'degraded', state: null, records: [] };
        }
        commands.add(record.commandId);
      }
      const last = result.records.at(-1);
      return last ? { sourceState: 'healthy', state: last.state, records: result.records } :
        { sourceState: 'missing', state: null, records: [] };
    } catch (error) {
      return { sourceState: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'degraded', state: null, records: [] };
    }
  }
  /** Synchronous pure mutation; no external side effects inside the transaction. Retrying a
   * command returns its original snapshot even if later commands have advanced the outcome. */
  transact(commandId: string, expectedRevision: number, request: unknown,
    update: (current: OutcomeState | null) => OutcomeState | null, fence: () => boolean = () => true): OutcomeWrite {
    return this.transactLocked(commandId, expectedRevision, request, update, fence);
  }
  /** Host-only historical result join. Read the current revision under the
   * same outer lock so an unrelated scope edit cannot discard terminal truth.
   * Operator commands and planning always retain explicit revision CAS. */
  transactCurrent(commandId: string, request: unknown,
    update: (current: OutcomeState | null) => OutcomeState | null, fence: () => boolean = () => true): OutcomeWrite {
    return this.transactLocked(commandId, null, request, update, fence);
  }
  private transactLocked(commandId: string, expectedRevision: number | null, request: unknown,
    update: (current: OutcomeState | null) => OutcomeState | null, fence: () => boolean): OutcomeWrite {
    try { privateDirectory(this.directory); } catch { return { ok: false, reason: 'invalid' }; }
    const acquired = acquireLocalStoreLockWithOutcome(join(this.directory, '.outcome.lock'), 0,
      { anchorPath: this.directory, exactPrivateStorage: true });
    if (acquired.state !== 'acquired') return { ok: false, reason: acquired.state === 'contended' ? expectedRevision === null ? 'lock-conflict' : 'conflict' : 'storage-failed' };
    try {
      const revision = expectedRevision ?? this.read().state?.revision ?? 0;
      return this.transactOwned(commandId, revision, request, update,
        () => ownsLocalStoreLock(acquired.lock) && fence() === true);
    } finally { releaseLocalStoreLock(acquired.lock); }
  }
  private transactOwned(commandId: string, expectedRevision: number, request: unknown,
    update: (current: OutcomeState | null) => OutcomeState | null, fence: () => boolean): OutcomeWrite {
    if (!outcomeToken(commandId) || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0) return { ok: false, reason: 'invalid' };
    let requestDigest: string;
    try { requestDigest = outcomeDigest(request); privateDirectory(this.directory); } catch { return { ok: false, reason: 'invalid' }; }
    const recovery = recoverImmutablePrivateRecordStore(this.config());
    if (!['clean', 'recovered', 'missing'].includes(recovery)) return { ok: false, reason: 'unknown-source' };
    const read = this.read();
    if (read.sourceState === 'degraded') return { ok: false, reason: 'unknown-source' };
    const previous = read.records.at(-1);
    const replay = read.records.find(record => record.commandId === commandId);
    if (replay) return replay.requestDigest === requestDigest ? { ok: true, disposition: 'replayed', state: replay.state } : { ok: false, reason: 'conflict' };
    if ((read.state?.revision ?? 0) !== expectedRevision) return { ok: false, reason: 'conflict' };
    let state: OutcomeState | null;
    try {
      if (fence() !== true) return { ok: false, reason: 'held' };
      state = update(read.state ? structuredClone(read.state) : null);
    } catch { return { ok: false, reason: 'invalid' }; }
    if (!state) return { ok: false, reason: 'held' };
    state.revision = expectedRevision + 1;
    const payload = { schemaVersion: state.schemaVersion, revision: state.revision, previousDigest: previous?.digest ?? null,
      commandId, requestDigest, state };
    const record = { ...payload, digest: outcomeDigest(payload) };
    if (!parse(record)) return { ok: false, reason: 'invalid' };
    let refusal: 'held' | 'storage-failed' = 'storage-failed';
    const disposition = writeImmutablePrivateRecord(this.config(), record, { prepublish: () => {
      if (fence() !== true) { refusal = 'held'; return false; }
      return true;
    } });
    if (disposition === 'recorded' || disposition === 'replayed') return { ok: true, disposition, state };
    if (disposition === 'invalid') return { ok: false, reason: 'invalid' };
    const latest = this.read();
    if (latest.records.some(item => item.commandId === commandId && item.requestDigest === requestDigest)) {
      return { ok: true, disposition: 'replayed', state: latest.records.find(item => item.commandId === commandId)!.state };
    }
    return { ok: false, reason: disposition === 'conflicted' ? 'conflict' : refusal };
  }
}
