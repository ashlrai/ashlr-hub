import { canonical, digest, MAX_ARTIFACT_BYTES } from './artifacts.js';
import * as delivery from './delivery.js';
import { deliveryGit, type GitTreeEntry } from './delivery-git.js';
import { fileOperationsPathKey, validFileOperationsPath } from './generation.js';
import type { UniverseIntegrationConflict, UniverseIntegrationDefinition, UniverseIntegrationEntry,
  UniverseIntegrationPlan, UniverseIntegrationSourceSummary } from './integration-types.js';
import type { UniverseStoreOptions } from './types.js';

const ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const OID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const MAX_SOURCES = 8;
const MAX_PATHS = 8_192;
const MAX_CONFLICTS = 128;

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
function exact(value: Record<string, unknown>, keys: string[]): boolean {
  const own = Reflect.ownKeys(value);
  return own.length === keys.length && own.every((key) => typeof key === 'string' && keys.includes(key));
}
function validPath(value: unknown): value is string {
  return validFileOperationsPath(value) && ![...value].some((part) => {
    const code = part.charCodeAt(0); return code >= 127 && code <= 159;
  });
}
function cloneDefinition(value: UniverseIntegrationDefinition): UniverseIntegrationDefinition {
  return { schemaVersion: 1, id: value.id, target: { repo: value.target.repo, baseCommit: value.target.baseCommit,
    allowedPaths: [...value.target.allowedPaths] }, sources: value.sources.map((source) => ({ ...source })) };
}

/** Validate an exact, detached integration request before any local observations. */
export function validateUniverseIntegrationDefinition(value: unknown): UniverseIntegrationDefinition {
  if (!object(value) || !exact(value, ['schemaVersion', 'id', 'target', 'sources']) || value.schemaVersion !== 1 ||
      typeof value.id !== 'string' || !ID.test(value.id) || !object(value.target) ||
      !exact(value.target, ['repo', 'baseCommit', 'allowedPaths']) || typeof value.target.repo !== 'string' ||
      value.target.repo.length < 1 || value.target.repo.length > 4_096 || !value.target.repo.startsWith('/') || value.target.repo.includes('\0') ||
      typeof value.target.baseCommit !== 'string' || !OID.test(value.target.baseCommit) || !Array.isArray(value.target.allowedPaths) ||
      value.target.allowedPaths.length < 1 || value.target.allowedPaths.length > MAX_PATHS || !Array.isArray(value.sources) ||
      value.sources.length < 2 || value.sources.length > MAX_SOURCES) {
    throw new Error('Invalid Universe integration: exact target, allowlist, and two to eight source pins required');
  }
  const allowedPaths = new Set<string>();
  for (const path of value.target.allowedPaths) {
    if (!validPath(path) || allowedPaths.has(path)) throw new Error('Invalid Universe integration: exact unique allowed paths required');
    allowedPaths.add(path);
  }
  const sources: UniverseIntegrationDefinition['sources'] = [];
  const seen = new Set<string>();
  for (const source of value.sources) {
    if (!object(source) || !exact(source, ['universeId', 'deliveryId', 'commit', 'tree']) || typeof source.universeId !== 'string' || !ID.test(source.universeId) ||
        typeof source.deliveryId !== 'string' || !/^[a-f0-9]{64}$/.test(source.deliveryId) ||
        typeof source.commit !== 'string' || !OID.test(source.commit) || typeof source.tree !== 'string' || !OID.test(source.tree)) {
      throw new Error('Invalid Universe integration: exact delivered source pins required');
    }
    const key = `${source.universeId}\0${source.deliveryId}`;
    if (seen.has(key)) throw new Error('Invalid Universe integration: duplicate source delivery pin');
    seen.add(key);
    sources.push({ universeId: source.universeId as string, deliveryId: source.deliveryId, commit: source.commit, tree: source.tree });
  }
  return { schemaVersion: 1, id: value.id, target: { repo: value.target.repo, baseCommit: value.target.baseCommit,
    allowedPaths: [...allowedPaths] }, sources };
}

type Overlay = { oid: string | null; executable: boolean | null; sourceDeliveryIds: string[] };

function changed(base: Map<string, GitTreeEntry>, next: GitTreeEntry[]): Array<{ path: string; oid: string | null; executable: boolean | null }> {
  const current = new Map(next.map((entry) => [entry.path, entry]));
  return [...new Set([...base.keys(), ...current.keys()])].sort().flatMap((path) => {
    const before = base.get(path); const after = current.get(path);
    return before?.oid === after?.oid && before?.executable === after?.executable ? [] : [{ path,
      oid: after?.oid ?? null, executable: after?.executable ?? null }];
  });
}
function sourceSummary(source: UniverseIntegrationDefinition['sources'][number], state: UniverseIntegrationSourceSummary['state'],
  receiptDigest: string | null = null, changedPathCount = 0): UniverseIntegrationSourceSummary {
  return { ...source, receiptDigest, state, changedPathCount };
}

/** Read targeted immutable receipt evidence and compose a bounded, non-mutating overlay recipe. */
export function readUniverseIntegrationPlan(input: unknown, options: UniverseStoreOptions = {}): UniverseIntegrationPlan {
  const definition = validateUniverseIntegrationDefinition(input);
  const reasons: string[] = [];
  const conflicts: UniverseIntegrationConflict[] = [];
  const summaries: UniverseIntegrationSourceSummary[] = [];
  const overlays = new Map<string, Overlay>();
  const allowedPaths = new Set(definition.target.allowedPaths);
  const reports = new Map<string, ReturnType<typeof delivery.readUniverseDeliveries>>();
  let targetGit: ReturnType<typeof deliveryGit> | null = null;
  let base: Map<string, GitTreeEntry> | null = null;
  const issue = (reason: string): void => { if (!reasons.includes(reason) && reasons.length < 64) reasons.push(reason); };
  const conflict = (value: UniverseIntegrationConflict): void => {
    if (conflicts.length < MAX_CONFLICTS && !conflicts.some((item) => canonical(item) === canonical(value))) conflicts.push(value);
    issue('composition-conflicts');
  };
  try {
    targetGit = deliveryGit(definition.target.repo);
    if (targetGit.oid(['rev-parse', '--verify', `${definition.target.baseCommit}^{commit}`]) !== definition.target.baseCommit) {
      throw new Error('base mismatch');
    }
    base = new Map(targetGit.entries(definition.target.baseCommit).map((entry) => [entry.path, entry]));
  } catch { issue('target-repository-or-base-unavailable'); }

  for (const source of definition.sources) {
    let report = reports.get(source.universeId);
    if (!report) {
      try { report = delivery.readUniverseDeliveries(source.universeId, options); reports.set(source.universeId, report); }
      catch { issue('source-delivery-unavailable'); summaries.push(sourceSummary(source, 'unavailable')); continue; }
    }
    if (!report || report.sourceState !== 'healthy') { issue('source-delivery-unavailable'); summaries.push(sourceSummary(source, 'unavailable')); continue; }
    const matches = report.deliveries.filter((receipt) => receipt.id === source.deliveryId);
    const receipt = matches.length === 1 ? matches[0]! : null;
    if (!receipt || receipt.status !== 'delivered' || receipt.universeId !== source.universeId || receipt.commit !== source.commit ||
        receipt.tree !== source.tree || receipt.repo !== definition.target.repo || receipt.baseCommit !== definition.target.baseCommit) {
      issue('source-delivery-pin-mismatch'); summaries.push(sourceSummary(source, 'mismatched')); continue;
    }
    const receiptDigest = digest(canonical(receipt));
    if (!targetGit || !base) { summaries.push(sourceSummary(source, 'unavailable', receiptDigest)); continue; }
    try {
      const edits = changed(base, targetGit.entries(receipt.tree));
      if (!edits.length) throw new Error('empty edit');
      if (edits.some((entry) => !allowedPaths.has(entry.path))) throw new Error('outside allowlist');
      // Validate the whole source diff before its first path can affect the
      // shared recipe; an invalid source must leave no partial overlay behind.
      for (const edit of edits) {
        const previous = overlays.get(edit.path);
        if (!previous) {
          overlays.set(edit.path, { oid: edit.oid, executable: edit.executable, sourceDeliveryIds: [source.deliveryId] });
        } else if (previous.oid === edit.oid && previous.executable === edit.executable) {
          previous.sourceDeliveryIds.push(source.deliveryId);
        } else {
          conflict({ code: 'path-conflict', paths: [edit.path], sourceDeliveryIds: [...previous.sourceDeliveryIds, source.deliveryId].sort() });
        }
      }
      summaries.push(sourceSummary(source, 'verified', receiptDigest, edits.length));
    } catch {
      issue('source-tree-or-allowlist-unavailable'); summaries.push(sourceSummary(source, 'unavailable', receiptDigest));
    }
  }

  const entries: UniverseIntegrationEntry[] = [...overlays.entries()].map(([path, entry]) => ({ path, oid: entry.oid,
    executable: entry.executable, sourceDeliveryIds: [...entry.sourceDeliveryIds].sort() })).sort((a, b) => a.path.localeCompare(b.path));
  if (targetGit && base && conflicts.length === 0 && summaries.every((summary) => summary.state === 'verified')) {
    const final = new Map(base);
    for (const entry of entries) {
      if (entry.oid === null) final.delete(entry.path);
      else final.set(entry.path, { path: entry.path, oid: entry.oid, executable: entry.executable! });
    }
    const finalEntries = [...final.values()].sort((a, b) => a.path.localeCompare(b.path));
    if (finalEntries.length > MAX_PATHS) issue('final-tree-entry-limit-exceeded');
    const folds = new Map<string, string>();
    const paths = new Set(finalEntries.map((entry) => entry.path));
    for (const entry of finalEntries) {
      const parts = entry.path.split('/');
      for (let index = 1; index <= parts.length; index++) {
        const segment = parts.slice(0, index).join('/');
        const folded = fileOperationsPathKey(segment);
        const prior = folds.get(folded);
        if (prior && prior !== segment) conflict({ code: 'case-fold-conflict', paths: [prior, segment].sort(), sourceDeliveryIds: [] });
        else folds.set(folded, segment);
      }
      for (let index = 1; index < parts.length; index++) {
        const parent = parts.slice(0, index).join('/');
        if (paths.has(parent)) conflict({ code: 'file-directory-conflict', paths: [parent, entry.path], sourceDeliveryIds: [] });
      }
    }
    if (finalEntries.some((entry) => !validPath(entry.path))) issue('final-tree-path-invalid');
    if (conflicts.length === 0 && finalEntries.length <= MAX_PATHS && !reasons.includes('final-tree-path-invalid')) {
      try {
        const oids = [...new Set(finalEntries.map((entry) => entry.oid))];
        const rows = oids.length === 0 ? [] : targetGit.invoke(['cat-file', '--batch-check=%(objectname) %(objecttype) %(objectsize)'],
          `${oids.join('\n')}\n`)!.toString('utf8').trim().split('\n').filter(Boolean);
        if (rows.length !== oids.length) throw new Error('batch mismatch');
        const sizes = new Map<string, number>();
        for (const row of rows) {
          const match = /^([a-f0-9]{40}|[a-f0-9]{64}) blob (0|[1-9][0-9]*)$/.exec(row);
          if (!match || !oids.includes(match[1]!)) throw new Error('invalid batch');
          sizes.set(match[1]!, Number(match[2]));
        }
        const total = finalEntries.reduce((sum, entry) => sum + (sizes.get(entry.oid) ?? Number.POSITIVE_INFINITY), 0);
        if (!Number.isSafeInteger(total) || total > MAX_ARTIFACT_BYTES) issue('final-tree-byte-limit-exceeded');
      } catch { issue('final-tree-content-unavailable'); }
    }
  }
  // Conflicts are healthy observations of verified source evidence, not a
  // source-read failure. They still prevent a usable composition recipe.
  const sourceState: UniverseIntegrationPlan['sourceState'] = reasons.some((reason) => reason !== 'composition-conflicts') ? 'degraded' : 'healthy';
  const compositionReady = sourceState === 'healthy' && conflicts.length === 0 && summaries.every((summary) => summary.state === 'verified');
  const compositionDigest = compositionReady ? digest(canonical({ domain: 'universe-integration-recipe-v1', definition, sources: summaries, entries, conflicts })) : null;
  return { schemaVersion: 1, scope: 'same-repository-pinned-base-overlay', authority: 'observation-only', definition: cloneDefinition(definition),
    sourceState, reasons, sources: summaries, entries, conflicts, compositionDigest, compositionReady };
}
