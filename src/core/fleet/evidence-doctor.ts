import { readAgentActionsDetailed } from './agent-action-ledger.js';
import { readBestOfNRecordsDetailed } from './best-of-n-ledger.js';
import { readDecisionsDetailed } from './decisions-ledger.js';
import { readDispatchManifestEventsDetailed } from './dispatch-manifest.js';
import { readDispatchProductionEventsDetailed } from './dispatch-production-ledger.js';
import {
  DISPATCH_PRODUCTION_INVALID_REASON_CODES,
  type DispatchProductionInvalidReasonCount,
} from './dispatch-production-ledger.js';
import { readJudgeTracesDetailed } from './judge-trace.js';
import { readAutonomyEvidencePacksDetailed } from '../autonomy/evidence-pack.js';

export const FLEET_EVIDENCE_SOURCES = [
  'decisions',
  'judge-traces',
  'agent-actions',
  'dispatch-production',
  'dispatch-manifests',
  'best-of-n',
  'autonomy-packs',
] as const;

export type FleetEvidenceSource = typeof FLEET_EVIDENCE_SOURCES[number];
export type FleetEvidenceDiagnosisState =
  | 'healthy'
  | 'cold-start'
  | 'transient-retry-recovered'
  | 'hard-cap-exceeded'
  | 'manual-inspection-required';

export interface FleetEvidenceDiagnosisQuality {
  sourceState: 'missing' | 'healthy' | 'degraded';
  sourcePresent: boolean;
  complete: boolean;
  stopReasons: string[];
  filesRead: number;
  bytesRead: number;
  rowsScanned: number;
  invalidRows: number;
  unreadableFiles: number;
}

export interface FleetEvidenceDiagnosis {
  schemaVersion: 1;
  source: FleetEvidenceSource;
  state: FleetEvidenceDiagnosisState;
  deep: boolean;
  attempts: 1 | 2;
  mutable: false;
  quality: FleetEvidenceDiagnosisQuality;
  diagnostics?: {
    authority: 'observation-only';
    bounded: true;
    invalidReasonCounts: DispatchProductionInvalidReasonCount[];
    attributedInvalidRows: number;
    withheldInvalidRows: number;
  };
  detail: string;
}

interface EvidenceReaderResult extends FleetEvidenceDiagnosisQuality {
  invalidReasonCounts?: DispatchProductionInvalidReasonCount[];
}

type EvidenceReader = (deep: boolean) => EvidenceReaderResult;

export interface FleetEvidenceDoctorDeps {
  readers?: Partial<Record<FleetEvidenceSource, EvidenceReader>>;
}

const DEEP = {
  limit: 100_000,
  maxFiles: 366,
  maxBytes: 256 * 1024 * 1024,
  maxRows: 1_000_000,
} as const;

function qualityOf(value: FleetEvidenceDiagnosisQuality): FleetEvidenceDiagnosisQuality {
  return {
    sourceState: value.sourceState,
    sourcePresent: value.sourcePresent,
    complete: value.complete,
    stopReasons: [...value.stopReasons],
    filesRead: value.filesRead,
    bytesRead: value.bytesRead,
    rowsScanned: value.rowsScanned,
    invalidRows: value.invalidRows,
    unreadableFiles: value.unreadableFiles,
  };
}

function autonomyPacksQuality(deep: boolean): FleetEvidenceDiagnosisQuality {
  const value = readAutonomyEvidencePacksDetailed(deep ? DEEP.maxFiles : undefined);
  const stopReasons: string[] = [];
  if (value.limitExceeded) stopReasons.push('bounded-limit');
  if (value.invalidFiles > 0) stopReasons.push('invalid-file');
  if (value.unreadableFiles > 0) stopReasons.push('unreadable-file');
  return {
    sourceState: value.sourceState,
    sourcePresent: value.sourcePresent,
    complete: value.complete,
    stopReasons,
    filesRead: value.filesRead,
    bytesRead: value.bytesRead,
    rowsScanned: value.filesRead,
    invalidRows: value.invalidFiles,
    unreadableFiles: value.unreadableFiles,
  };
}

function dispatchProductionQuality(deep: boolean): EvidenceReaderResult {
  const value = readDispatchProductionEventsDetailed({ ...(deep ? DEEP : {}), inspectionOnly: true });
  return {
    ...qualityOf(value),
    invalidReasonCounts: value.invalidReasonCounts,
  };
}

const DEFAULT_READERS: Record<FleetEvidenceSource, EvidenceReader> = {
  decisions: (deep) => qualityOf(readDecisionsDetailed(deep ? DEEP : {})),
  'judge-traces': (deep) => qualityOf(readJudgeTracesDetailed(deep ? DEEP : {})),
  'agent-actions': (deep) => qualityOf(readAgentActionsDetailed({ ...(deep ? DEEP : {}), inspectionOnly: true })),
  'dispatch-production': dispatchProductionQuality,
  'dispatch-manifests': (deep) => qualityOf(readDispatchManifestEventsDetailed({
    ...(deep ? DEEP : {}), inspectionOnly: true,
  })),
  'best-of-n': (deep) => qualityOf(readBestOfNRecordsDetailed({
    ...(deep ? DEEP : {}), inspectionOnly: true,
  })),
  'autonomy-packs': autonomyPacksQuality,
};

function dispatchDiagnostics(
  source: FleetEvidenceSource,
  deep: boolean,
  value: EvidenceReaderResult,
): FleetEvidenceDiagnosis['diagnostics'] | undefined {
  if (source !== 'dispatch-production' || !deep) return undefined;
  const invalidRows = Number.isSafeInteger(value.invalidRows) && value.invalidRows > 0
    ? value.invalidRows
    : 0;
  const allowed = new Set<string>(DISPATCH_PRODUCTION_INVALID_REASON_CODES);
  const rows = value.invalidReasonCounts;
  if (!Array.isArray(rows)) {
    return {
      authority: 'observation-only', bounded: true, invalidReasonCounts: [],
      attributedInvalidRows: 0, withheldInvalidRows: invalidRows,
    };
  }
  const byReason = new Map<string, number>();
  for (const row of rows) {
    if (!row || !allowed.has(row.reason) || !Number.isSafeInteger(row.count) || row.count <= 0 ||
      byReason.has(row.reason)) {
      return {
        authority: 'observation-only', bounded: true, invalidReasonCounts: [],
        attributedInvalidRows: 0, withheldInvalidRows: invalidRows,
      };
    }
    byReason.set(row.reason, row.count);
  }
  const invalidReasonCounts = DISPATCH_PRODUCTION_INVALID_REASON_CODES
    .flatMap((reason) => byReason.has(reason) ? [{ reason, count: byReason.get(reason)! }] : []);
  const attributedInvalidRows = invalidReasonCounts.reduce((sum, row) => sum + row.count, 0);
  if (attributedInvalidRows > invalidRows) {
    return {
      authority: 'observation-only', bounded: true, invalidReasonCounts: [],
      attributedInvalidRows: 0, withheldInvalidRows: invalidRows,
    };
  }
  return {
    authority: 'observation-only', bounded: true, invalidReasonCounts,
    attributedInvalidRows, withheldInvalidRows: invalidRows - attributedInvalidRows,
  };
}

function diagnosisState(quality: FleetEvidenceDiagnosisQuality): FleetEvidenceDiagnosisState {
  if (quality.sourceState === 'missing') return 'cold-start';
  if (quality.sourceState === 'healthy' && quality.complete) return 'healthy';
  if (quality.stopReasons.some((reason) =>
    reason === 'file-limit' || reason === 'byte-limit' || reason === 'row-limit' ||
    reason === 'event-limit' || reason === 'bounded-limit')) {
    return 'hard-cap-exceeded';
  }
  return 'manual-inspection-required';
}

function diagnosisDetail(state: FleetEvidenceDiagnosisState, quality: FleetEvidenceDiagnosisQuality): string {
  switch (state) {
    case 'healthy':
      return `bounded read complete across ${quality.filesRead} file(s) and ${quality.rowsScanned} row(s)`;
    case 'cold-start':
      return 'no ledger exists yet; no evidence was fabricated';
    case 'transient-retry-recovered':
      return 'a second bounded read succeeded; no durable repair was performed';
    case 'hard-cap-exceeded':
      return `bounded read stopped at ${quality.stopReasons.join(', ') || 'a hard limit'}`;
    case 'manual-inspection-required':
      return `source remains fail-closed (${quality.invalidRows} invalid, ${quality.unreadableFiles} unreadable)`;
  }
}

export function diagnoseFleetEvidence(
  source: FleetEvidenceSource,
  opts: { deep?: boolean; deps?: FleetEvidenceDoctorDeps } = {},
): FleetEvidenceDiagnosis {
  const deep = opts.deep === true;
  const reader = opts.deps?.readers?.[source] ?? DEFAULT_READERS[source];
  let read = reader(deep);
  let quality = qualityOf(read);
  let diagnostics = dispatchDiagnostics(source, deep, read);
  let state = diagnosisState(quality);
  let attempts: 1 | 2 = 1;
  if (state === 'manual-inspection-required' && quality.stopReasons.includes('io-error')) {
    attempts = 2;
    const retried = reader(deep);
    const retryState = diagnosisState(retried);
    read = retried;
    quality = qualityOf(retried);
    diagnostics = dispatchDiagnostics(source, deep, read);
    state = retryState === 'healthy' ? 'transient-retry-recovered' : retryState;
  }
  return {
    schemaVersion: 1,
    source,
    state,
    deep,
    attempts,
    mutable: false,
    quality,
    ...(diagnostics ? { diagnostics } : {}),
    detail: diagnosisDetail(state, quality),
  };
}

export function isFleetEvidenceSource(value: string): value is FleetEvidenceSource {
  return (FLEET_EVIDENCE_SOURCES as readonly string[]).includes(value);
}
