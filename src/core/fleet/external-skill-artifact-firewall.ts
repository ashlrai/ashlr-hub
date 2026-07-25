import { createHash } from 'node:crypto';

import { projectExternalSkillCandidateMetadata } from './external-skill-audit.js';

const PROTOCOL = 'external-skill-artifact-firewall-v1' as const;
const PROJECTION_POLICY = 'skill-frontmatter-metadata-v1' as const;
const MAX_BUNDLE_BYTES = 24 * 1024 * 1024;
const MAX_MARKER_BYTES = 16 * 1024;
const MAX_ARTIFACTS = 2_048;
const MAX_PROJECTED_SKILLS = 128;
const MAX_DEPTH = 12;
const MAX_JSON_DEPTH = 8;
const MAX_JSON_NODES = 32_768;
const MAX_PATH_BYTES = 4_096;
const MAX_ARTIFACT_BYTES = 256 * 1024;
const MAX_TOTAL_BYTES = 16 * 1024 * 1024;
const DIGEST = /^[a-f0-9]{64}$/;
const SHA1_OID = /^[a-f0-9]{40}$/;
const SHA256_OID = /^[a-f0-9]{64}$/;
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const WINDOWS_DEVICE =
  /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu;
const INPUT_KEYS = [
  'firstBundleBytes',
  'firstMarkerBytes',
  'secondBundleBytes',
  'secondMarkerBytes',
] as const;
const BUNDLE_KEYS = [
  'commitOid',
  'commitTreeOid',
  'entries',
  'objectFormat',
  'packSubdirHash',
  'packTreeOid',
  'portablePackDigest',
  'schemaVersion',
] as const;
const ENTRY_KEYS = [
  'byteLength',
  'contentBase64',
  'contentDigest',
  'gitOid',
  'kind',
  'mode',
  'path',
] as const;
const MARKER_KEYS = [
  'bundleDigest',
  'captureDigest',
  'custodyAuthenticated',
  'executionEligible',
  'fileCount',
  'policyEligible',
  'portablePackDigest',
  'promotionEligible',
  'schemaVersion',
  'sourceIdentity',
  'symlinkCount',
  'totalBytes',
] as const;
const TYPED_ARRAY_PROTOTYPE = Object.getPrototypeOf(Uint8Array.prototype) as object;
const TYPED_ARRAY_BYTE_LENGTH_GETTER = Object.getOwnPropertyDescriptor(
  TYPED_ARRAY_PROTOTYPE,
  'byteLength',
)?.get;
const TYPED_ARRAY_BUFFER_GETTER = Object.getOwnPropertyDescriptor(
  TYPED_ARRAY_PROTOTYPE,
  'buffer',
)?.get;
const TYPED_ARRAY_SET = Uint8Array.prototype.set;
const CAPTURE_RECEIPT_DIGEST_DOMAIN = Buffer.from(
  'ashlr:external-skill-capture-receipt:v1\0',
  'utf8',
);

export const EXTERNAL_SKILL_ARTIFACT_CLASSES = [
  'directory',
  'skill-entry',
  'skill-support',
  'reference',
  'eval-contract',
  'eval-fixture',
  'license',
  'documentation',
  'instruction-surface',
  'executable-surface',
  'plugin-manifest',
  'repository-metadata',
  'symlink',
  'unknown',
] as const;

export type ExternalSkillArtifactClassV1 =
  typeof EXTERNAL_SKILL_ARTIFACT_CLASSES[number];

export type ExternalSkillArtifactKindV1 = 'directory' | 'file' | 'symlink';
export type ExternalSkillArtifactModeV1 = '040000' | '100644' | '100755' | '120000';

export interface ExternalSkillArtifactFirewallInputV1 {
  firstBundleBytes: Uint8Array;
  secondBundleBytes: Uint8Array;
  firstMarkerBytes: Uint8Array;
  secondMarkerBytes: Uint8Array;
}

export interface ExternalSkillArtifactClassCountV1 {
  artifactClass: ExternalSkillArtifactClassV1;
  count: number;
  bytes: number;
}

interface ExternalSkillArtifactAuthorityBoundaryV1 {
  authority: 'observation-only';
  executionAuthority: false;
  exposureAuthority: false;
  routingAuthority: false;
  learningAuthority: false;
  policyAuthority: false;
  promotionAuthority: false;
  proposalAuthority: false;
  verificationAuthority: false;
  mergeAuthority: false;
  releaseAuthority: false;
  deploymentAuthority: false;
  transitionAuthority: false;
  revocationAuthority: false;
  rawContentReturned: false;
  pathsReturned: false;
  referenceExpansion: false;
  distinctReadReceiptsVerified: false;
  captureReceiptBindingVerified: false;
  custodyAuthenticated: false;
  auditReceiptBindingVerified: false;
  sourceCompletenessVerified: false;
  sourceProvenanceVerified: false;
  licensePolicyVerified: false;
  runtimeConsumerVerified: false;
  artifactNamesReturned: false;
  projectedTextReturned: false;
  sourceIdentityReturned: false;
}

export type ExternalSkillArtifactFirewallReasonV1 =
  | 'inventory-classified'
  | 'unknown-artifacts'
  | 'projection-invalid'
  | 'invalid-input';

export type ExternalSkillArtifactFirewallResultV1 =
  ExternalSkillArtifactAuthorityBoundaryV1 & {
    schemaVersion: 1;
    protocol: typeof PROTOCOL;
    state: 'classified' | 'withheld';
    reason: ExternalSkillArtifactFirewallReasonV1;
    gate: 'collecting' | 'withheld';
    policyDigest: string;
    canonicalCaptureConsistencyVerified: boolean;
    repeatableSnapshotVerified: boolean;
    captureDigest: string | null;
    captureReceiptDigest: string | null;
    portablePackDigest: string | null;
    inventoryDigest: string | null;
    classificationComplete: boolean;
    artifactCount: number;
    unknownArtifactCount: number;
    classCounts: readonly ExternalSkillArtifactClassCountV1[];
    projection: {
      policy: typeof PROJECTION_POLICY;
      eligibleArtifacts: number;
      invalidArtifacts: number;
      projectionDigest: string | null;
    };
  };

interface CaptureBundleEntryV1 {
  path: string;
  kind: ExternalSkillArtifactKindV1;
  mode: ExternalSkillArtifactModeV1;
  gitOid: string;
  byteLength: number;
  contentDigest: string | null;
  contentBase64: string | null;
  content: Buffer | null;
}

interface CaptureBundleV1 {
  schemaVersion: 1;
  objectFormat: 'sha1' | 'sha256';
  commitOid: string;
  commitTreeOid: string;
  packTreeOid: string;
  packSubdirHash: string;
  portablePackDigest: string;
  entries: CaptureBundleEntryV1[];
}

interface CaptureMarkerV1 {
  schemaVersion: 1;
  captureDigest: string;
  bundleDigest: string;
  portablePackDigest: string;
  sourceIdentity: string;
  fileCount: number;
  symlinkCount: number;
  totalBytes: number;
  custodyAuthenticated: false;
  executionEligible: false;
  policyEligible: false;
  promotionEligible: false;
}

interface NormalizedInput {
  bundle: CaptureBundleV1;
  marker: CaptureMarkerV1;
  markerBytes: Buffer;
}

interface ClassifiedArtifact extends CaptureBundleEntryV1 {
  artifactClass: ExternalSkillArtifactClassV1;
}

const POLICY_MANIFEST = {
  protocol: PROTOCOL,
  revision: 'm457-artifact-firewall-2026-07-25.1',
  captureProtocol: 'ashlr-external-skill-git-capture-v1',
  limits: {
    maxBundleBytes: MAX_BUNDLE_BYTES,
    maxMarkerBytes: MAX_MARKER_BYTES,
    maxArtifacts: MAX_ARTIFACTS,
    maxProjectedSkills: MAX_PROJECTED_SKILLS,
    maxDepth: MAX_DEPTH,
    maxJsonDepth: MAX_JSON_DEPTH,
    maxJsonNodes: MAX_JSON_NODES,
    maxPathBytes: MAX_PATH_BYTES,
    maxArtifactBytes: MAX_ARTIFACT_BYTES,
    maxTotalBytes: MAX_TOTAL_BYTES,
  },
  precedence: [
    'symlink-kind',
    'directory-kind',
    'executable-mode-or-path',
    'instruction-path',
    'exact-path-class',
    'unknown',
  ],
  classes: EXTERNAL_SKILL_ARTIFACT_CLASSES,
  projectionPolicy: PROJECTION_POLICY,
} as const;

export const EXTERNAL_SKILL_ARTIFACT_FIREWALL_POLICY_DIGEST = sha256(
  `ashlr:external-skill-artifact-firewall-policy:v1\0${JSON.stringify(POLICY_MANIFEST)}`,
);

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function authorityBoundary(): ExternalSkillArtifactAuthorityBoundaryV1 {
  return {
    authority: 'observation-only',
    executionAuthority: false,
    exposureAuthority: false,
    routingAuthority: false,
    learningAuthority: false,
    policyAuthority: false,
    promotionAuthority: false,
    proposalAuthority: false,
    verificationAuthority: false,
    mergeAuthority: false,
    releaseAuthority: false,
    deploymentAuthority: false,
    transitionAuthority: false,
    revocationAuthority: false,
    rawContentReturned: false,
    pathsReturned: false,
    referenceExpansion: false,
    distinctReadReceiptsVerified: false,
    captureReceiptBindingVerified: false,
    custodyAuthenticated: false,
    auditReceiptBindingVerified: false,
    sourceCompletenessVerified: false,
    sourceProvenanceVerified: false,
    licensePolicyVerified: false,
    runtimeConsumerVerified: false,
    artifactNamesReturned: false,
    projectedTextReturned: false,
    sourceIdentityReturned: false,
  };
}

function withheld(): ExternalSkillArtifactFirewallResultV1 {
  return {
    schemaVersion: 1,
    protocol: PROTOCOL,
    state: 'withheld',
    reason: 'invalid-input',
    gate: 'withheld',
    policyDigest: EXTERNAL_SKILL_ARTIFACT_FIREWALL_POLICY_DIGEST,
    canonicalCaptureConsistencyVerified: false,
    repeatableSnapshotVerified: false,
    captureDigest: null,
    captureReceiptDigest: null,
    portablePackDigest: null,
    inventoryDigest: null,
    classificationComplete: false,
    artifactCount: 0,
    unknownArtifactCount: 0,
    classCounts: [],
    projection: {
      policy: PROJECTION_POLICY,
      eligibleArtifacts: 0,
      invalidArtifacts: 0,
      projectionDigest: null,
    },
    ...authorityBoundary(),
  };
}

function exactRecord(value: unknown, keys: readonly string[]): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return null;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const ownKeys = Reflect.ownKeys(descriptors);
  if (ownKeys.some((key) => typeof key !== 'string')) return null;
  const actual = (ownKeys as string[]).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length ||
    !actual.every((key, index) => key === expected[index])) {
    return null;
  }
  const snapshot: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of expected) {
    const descriptor = descriptors[key];
    if (descriptor === undefined || !Object.hasOwn(descriptor, 'value') ||
      descriptor.enumerable !== true) {
      return null;
    }
    snapshot[key] = descriptor.value;
  }
  return snapshot;
}

function exactArray(value: unknown, maximum: number): unknown[] | null {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return null;
  const descriptors = Object.getOwnPropertyDescriptors(value) as unknown as Record<
    PropertyKey,
    PropertyDescriptor
  >;
  const lengthDescriptor = descriptors['length'];
  if (lengthDescriptor === undefined ||
    !Object.hasOwn(lengthDescriptor, 'value') ||
    typeof lengthDescriptor.value !== 'number' ||
    !Number.isSafeInteger(lengthDescriptor.value) ||
    lengthDescriptor.value < 1 ||
    lengthDescriptor.value > maximum) {
    return null;
  }
  const length = lengthDescriptor.value;
  const result: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (descriptor === undefined || !Object.hasOwn(descriptor, 'value') ||
      descriptor.enumerable !== true) {
      return null;
    }
    result.push(descriptor.value);
  }
  const expected = new Set(['length', ...result.map((_, index) => String(index))]);
  if (Reflect.ownKeys(descriptors).some((key) =>
    typeof key !== 'string' || !expected.has(key))) {
    return null;
  }
  return result;
}

function boundedJsonGraph(value: unknown): boolean {
  const pending: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  let nodes = 0;
  while (pending.length > 0) {
    const next = pending.pop()!;
    nodes += 1;
    if (nodes > MAX_JSON_NODES || next.depth > MAX_JSON_DEPTH) return false;
    if (typeof next.value !== 'object' || next.value === null) continue;
    if (Array.isArray(next.value)) {
      for (const child of next.value) {
        pending.push({ value: child, depth: next.depth + 1 });
      }
      continue;
    }
    if (Object.getPrototypeOf(next.value) !== Object.prototype) return false;
    for (const child of Object.values(next.value as Record<string, unknown>)) {
      pending.push({ value: child, depth: next.depth + 1 });
    }
  }
  return true;
}

function parseCanonicalUtf8Json(bytes: Buffer): unknown | null {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (!Buffer.from(text, 'utf8').equals(bytes)) return null;
    const value = JSON.parse(text) as unknown;
    return boundedJsonGraph(value) ? value : null;
  } catch {
    return null;
  }
}

function copyBytes(value: unknown, maximum: number): Buffer | null {
  try {
    if (!(value instanceof Uint8Array) ||
      Object.getPrototypeOf(value) !== Uint8Array.prototype ||
      TYPED_ARRAY_BYTE_LENGTH_GETTER === undefined ||
      TYPED_ARRAY_BUFFER_GETTER === undefined) {
      return null;
    }
    const length = Reflect.apply(TYPED_ARRAY_BYTE_LENGTH_GETTER, value, []) as number;
    const backingBuffer = Reflect.apply(
      TYPED_ARRAY_BUFFER_GETTER,
      value,
      [],
    ) as ArrayBufferLike;
    if (!Number.isSafeInteger(length) || length < 1 || length > maximum ||
      (typeof SharedArrayBuffer !== 'undefined' &&
        backingBuffer instanceof SharedArrayBuffer)) {
      return null;
    }
    const copy = Buffer.alloc(length);
    Reflect.apply(TYPED_ARRAY_SET, copy, [value]);
    return copy;
  } catch {
    return null;
  }
}

function portableSegment(value: string): boolean {
  if (!value || value === '.' || value === '..' || value !== value.normalize('NFC')) {
    return false;
  }
  if (Buffer.byteLength(value, 'utf8') > 255 ||
    /[\\/:*?"<>|]/u.test(value) ||
    /[. ]$/u.test(value) ||
    WINDOWS_DEVICE.test(value) ||
    value.toLowerCase() === '.git') {
    return false;
  }
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return false;
  }
  return true;
}

function portablePath(value: unknown): value is string {
  if (typeof value !== 'string' ||
    value.length === 0 ||
    value.startsWith('/') ||
    value.includes('\\') ||
    value.includes('\0') ||
    value !== value.normalize('NFC') ||
    Buffer.byteLength(value, 'utf8') > MAX_PATH_BYTES) {
    return false;
  }
  const segments = value.split('/');
  return segments.length <= MAX_DEPTH && segments.every(portableSegment);
}

function validOid(value: unknown, format: 'sha1' | 'sha256'): value is string {
  return typeof value === 'string' &&
    (format === 'sha1' ? SHA1_OID : SHA256_OID).test(value) &&
    !/^0+$/u.test(value);
}

function modeMatchesKind(
  kind: ExternalSkillArtifactKindV1,
  mode: ExternalSkillArtifactModeV1,
): boolean {
  if (kind === 'directory') return mode === '040000';
  if (kind === 'symlink') return mode === '120000';
  return mode === '100644' || mode === '100755';
}

function canonicalBundle(bundle: CaptureBundleV1): Buffer {
  return Buffer.from(JSON.stringify({
    schemaVersion: bundle.schemaVersion,
    objectFormat: bundle.objectFormat,
    commitOid: bundle.commitOid,
    commitTreeOid: bundle.commitTreeOid,
    packTreeOid: bundle.packTreeOid,
    packSubdirHash: bundle.packSubdirHash,
    portablePackDigest: bundle.portablePackDigest,
    entries: bundle.entries.map((entry) => ({
      path: entry.path,
      kind: entry.kind,
      mode: entry.mode,
      gitOid: entry.gitOid,
      byteLength: entry.byteLength,
      contentDigest: entry.contentDigest,
      contentBase64: entry.contentBase64,
    })),
  }), 'utf8');
}

function canonicalMarker(marker: CaptureMarkerV1): Buffer {
  return Buffer.from(JSON.stringify({
    schemaVersion: marker.schemaVersion,
    captureDigest: marker.captureDigest,
    bundleDigest: marker.bundleDigest,
    portablePackDigest: marker.portablePackDigest,
    sourceIdentity: marker.sourceIdentity,
    fileCount: marker.fileCount,
    symlinkCount: marker.symlinkCount,
    totalBytes: marker.totalBytes,
    custodyAuthenticated: marker.custodyAuthenticated,
    executionEligible: marker.executionEligible,
    policyEligible: marker.policyEligible,
    promotionEligible: marker.promotionEligible,
  }), 'utf8');
}

function parseBundle(bytes: Buffer): CaptureBundleV1 | null {
  try {
    const decoded = parseCanonicalUtf8Json(bytes);
    if (decoded === null) return null;
    const record = exactRecord(decoded, BUNDLE_KEYS);
    if (record === null ||
      record['schemaVersion'] !== 1 ||
      (record['objectFormat'] !== 'sha1' && record['objectFormat'] !== 'sha256')) {
      return null;
    }
    const objectFormat = record['objectFormat'];
    if (!validOid(record['commitOid'], objectFormat) ||
      !validOid(record['commitTreeOid'], objectFormat) ||
      !validOid(record['packTreeOid'], objectFormat) ||
      typeof record['packSubdirHash'] !== 'string' ||
      !DIGEST.test(record['packSubdirHash']) ||
      typeof record['portablePackDigest'] !== 'string' ||
      !DIGEST.test(record['portablePackDigest'])) {
      return null;
    }
    const rawEntries = exactArray(record['entries'], MAX_ARTIFACTS);
    if (rawEntries === null) return null;
    const entries: CaptureBundleEntryV1[] = [];
    const exactPaths = new Set<string>();
    const foldedPaths = new Set<string>();
    let totalBytes = 0;
    let previousPath: Buffer | null = null;
    for (const rawEntry of rawEntries) {
      const entry = exactRecord(rawEntry, ENTRY_KEYS);
      if (entry === null ||
        !portablePath(entry['path']) ||
        !['directory', 'file', 'symlink'].includes(String(entry['kind'])) ||
        !['040000', '100644', '100755', '120000'].includes(String(entry['mode'])) ||
        !validOid(entry['gitOid'], objectFormat) ||
        typeof entry['byteLength'] !== 'number' ||
        !Number.isSafeInteger(entry['byteLength']) ||
        entry['byteLength'] < 0 ||
        entry['byteLength'] > MAX_ARTIFACT_BYTES) {
        return null;
      }
      const path = entry['path'];
      const pathBytes = Buffer.from(path, 'utf8');
      if (previousPath !== null && Buffer.compare(previousPath, pathBytes) >= 0) return null;
      previousPath = pathBytes;
      const folded = path.toLowerCase();
      if (exactPaths.has(path) || foldedPaths.has(folded)) return null;
      exactPaths.add(path);
      foldedPaths.add(folded);
      const kind = entry['kind'] as ExternalSkillArtifactKindV1;
      const mode = entry['mode'] as ExternalSkillArtifactModeV1;
      if (!modeMatchesKind(kind, mode)) return null;

      let content: Buffer | null = null;
      if (kind === 'directory') {
        if (entry['byteLength'] !== 0 ||
          entry['contentDigest'] !== null ||
          entry['contentBase64'] !== null) {
          return null;
        }
      } else {
        if (typeof entry['contentDigest'] !== 'string' ||
          !DIGEST.test(entry['contentDigest']) ||
          typeof entry['contentBase64'] !== 'string' ||
          !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u
            .test(entry['contentBase64'])) {
          return null;
        }
        content = Buffer.from(entry['contentBase64'], 'base64');
        if (content.toString('base64') !== entry['contentBase64'] ||
          content.length !== entry['byteLength'] ||
          sha256(content) !== entry['contentDigest'] ||
          totalBytes > MAX_TOTAL_BYTES - content.length) {
          return null;
        }
        totalBytes += content.length;
      }
      entries.push({
        path,
        kind,
        mode,
        gitOid: entry['gitOid'],
        byteLength: entry['byteLength'],
        contentDigest: entry['contentDigest'] as string | null,
        contentBase64: entry['contentBase64'] as string | null,
        content,
      });
    }
    const byPath = new Map(entries.map((entry) => [entry.path, entry]));
    for (const entry of entries) {
      const segments = entry.path.split('/');
      for (let index = 1; index < segments.length; index += 1) {
        const parent = segments.slice(0, index).join('/');
        if (byPath.get(parent)?.kind !== 'directory') return null;
      }
    }
    const bundle: CaptureBundleV1 = {
      schemaVersion: 1,
      objectFormat,
      commitOid: record['commitOid'],
      commitTreeOid: record['commitTreeOid'],
      packTreeOid: record['packTreeOid'],
      packSubdirHash: record['packSubdirHash'],
      portablePackDigest: record['portablePackDigest'],
      entries,
    };
    return canonicalBundle(bundle).equals(bytes) ? bundle : null;
  } catch {
    return null;
  }
}

function parseMarker(bytes: Buffer): CaptureMarkerV1 | null {
  try {
    const decoded = parseCanonicalUtf8Json(bytes);
    if (decoded === null) return null;
    const record = exactRecord(decoded, MARKER_KEYS);
    if (record === null ||
      record['schemaVersion'] !== 1 ||
      typeof record['captureDigest'] !== 'string' ||
      !DIGEST.test(record['captureDigest']) ||
      typeof record['bundleDigest'] !== 'string' ||
      !DIGEST.test(record['bundleDigest']) ||
      typeof record['portablePackDigest'] !== 'string' ||
      !DIGEST.test(record['portablePackDigest']) ||
      typeof record['sourceIdentity'] !== 'string' ||
      !DIGEST.test(record['sourceIdentity']) ||
      !Number.isSafeInteger(record['fileCount']) ||
      !Number.isSafeInteger(record['symlinkCount']) ||
      !Number.isSafeInteger(record['totalBytes']) ||
      Number(record['fileCount']) < 0 ||
      Number(record['symlinkCount']) < 0 ||
      Number(record['totalBytes']) < 0 ||
      record['custodyAuthenticated'] !== false ||
      record['executionEligible'] !== false ||
      record['policyEligible'] !== false ||
      record['promotionEligible'] !== false) {
      return null;
    }
    const marker: CaptureMarkerV1 = {
      schemaVersion: 1,
      captureDigest: record['captureDigest'],
      bundleDigest: record['bundleDigest'],
      portablePackDigest: record['portablePackDigest'],
      sourceIdentity: record['sourceIdentity'],
      fileCount: Number(record['fileCount']),
      symlinkCount: Number(record['symlinkCount']),
      totalBytes: Number(record['totalBytes']),
      custodyAuthenticated: false,
      executionEligible: false,
      policyEligible: false,
      promotionEligible: false,
    };
    return canonicalMarker(marker).equals(bytes) ? marker : null;
  } catch {
    return null;
  }
}

function normalizeInput(value: unknown): NormalizedInput | null {
  try {
    const input = exactRecord(value, INPUT_KEYS);
    if (input === null) return null;
    const firstBundleBytes = copyBytes(input['firstBundleBytes'], MAX_BUNDLE_BYTES);
    const secondBundleBytes = copyBytes(input['secondBundleBytes'], MAX_BUNDLE_BYTES);
    const firstMarkerBytes = copyBytes(input['firstMarkerBytes'], MAX_MARKER_BYTES);
    const secondMarkerBytes = copyBytes(input['secondMarkerBytes'], MAX_MARKER_BYTES);
    if (firstBundleBytes === null || secondBundleBytes === null ||
      firstMarkerBytes === null || secondMarkerBytes === null ||
      !firstBundleBytes.equals(secondBundleBytes) ||
      !firstMarkerBytes.equals(secondMarkerBytes)) {
      return null;
    }
    const bundle = parseBundle(firstBundleBytes);
    const marker = parseMarker(firstMarkerBytes);
    if (bundle === null || marker === null) return null;
    const bundleDigest = sha256(firstBundleBytes);
    const captureDigest = sha256(
      `ashlr-external-skill-git-capture-v1\0${bundleDigest}`,
    );
    const sourceIdentity = sha256([
      'ashlr-external-skill-source-v1',
      bundle.objectFormat,
      bundle.commitOid,
      bundle.commitTreeOid,
      bundle.packTreeOid,
      bundle.packSubdirHash,
    ].join('\0'));
    const fileCount = bundle.entries.filter((entry) => entry.kind === 'file').length;
    const symlinkCount = bundle.entries.filter((entry) => entry.kind === 'symlink').length;
    const totalBytes = bundle.entries.reduce((sum, entry) => sum + entry.byteLength, 0);
    if (marker.bundleDigest !== bundleDigest ||
      marker.captureDigest !== captureDigest ||
      marker.portablePackDigest !== bundle.portablePackDigest ||
      marker.sourceIdentity !== sourceIdentity ||
      marker.fileCount !== fileCount ||
      marker.symlinkCount !== symlinkCount ||
      marker.totalBytes !== totalBytes) {
      return null;
    }
    return {
      bundle,
      marker,
      markerBytes: firstMarkerBytes,
    };
  } catch {
    return null;
  }
}

function classifyPath(entry: CaptureBundleEntryV1): ExternalSkillArtifactClassV1 {
  if (entry.kind === 'symlink') return 'symlink';
  if (entry.kind === 'directory') return 'directory';
  const path = entry.path;
  const foldedPath = path.toLowerCase();
  if (entry.mode === '100755' ||
    /\.(?:bat|bash|cmd|exe|ps1|sh|zsh)$/u.test(foldedPath) ||
    /^(?:bin|hooks|scripts|\.githooks|\.github\/workflows)(?:\/|$)/u
      .test(foldedPath) ||
    /^skills\/[a-z0-9]+(?:-[a-z0-9]+)*\/scripts(?:\/|$)/u.test(foldedPath)) {
    return 'executable-surface';
  }
  if (path === 'AGENTS.md' || path === 'CLAUDE.md' ||
    /^(?:agents|commands|personas|prompts|rules|\.claude|\.codex|\.opencode|\.gemini\/commands)(?:\/|$)/u
      .test(foldedPath)) {
    return 'instruction-surface';
  }
  if (/^skills\/[a-z0-9]+(?:-[a-z0-9]+)*\/SKILL\.md$/u.test(path)) {
    return 'skill-entry';
  }
  if (path === 'plugin.json' ||
    /^(?:\.agents\/plugins|\.claude-plugin|\.codex-plugin)(?:\/|$)/u.test(path)) {
    return 'plugin-manifest';
  }
  if (/^evals\/cases\/[a-z0-9]+(?:-[a-z0-9]+)*\.json$/u.test(path)) {
    return 'eval-contract';
  }
  if (/^evals\/fixtures(?:\/|$)/u.test(path)) return 'eval-fixture';
  if (/^(?:references|skills\/[a-z0-9]+(?:-[a-z0-9]+)*\/references)(?:\/|$)/u
    .test(path)) {
    return 'reference';
  }
  if (/^skills\/[a-z0-9]+(?:-[a-z0-9]+)*(?:\/|$)/u.test(path)) {
    return 'skill-support';
  }
  if (path === 'LICENSE') return 'license';
  if (path === 'README.md' || path === 'CONTRIBUTING.md' ||
    path === 'evals/README.md' || /^docs(?:\/|$)/u.test(path)) {
    return 'documentation';
  }
  if (path === '.gitattributes' || path === '.gitignore' ||
    /^(?:\.github|package\.json|package-lock\.json|npm-shrinkwrap\.json)(?:\/|$)/u
      .test(path)) {
    return 'repository-metadata';
  }
  return 'unknown';
}

function lengthPrefixed(value: string): Buffer {
  const bytes = Buffer.from(value, 'utf8');
  return Buffer.concat([Buffer.from(`${bytes.length}\0`, 'ascii'), bytes]);
}

function entryDigest(entry: ClassifiedArtifact): string {
  return sha256(Buffer.concat([
    Buffer.from('ashlr:external-skill-artifact-entry:v1\0', 'ascii'),
    lengthPrefixed(entry.path),
    lengthPrefixed(entry.kind),
    lengthPrefixed(entry.mode),
    lengthPrefixed(entry.gitOid),
    lengthPrefixed(String(entry.byteLength)),
    lengthPrefixed(entry.contentDigest ?? 'none'),
    lengthPrefixed(entry.artifactClass),
  ]));
}

function classCounts(
  artifacts: readonly ClassifiedArtifact[],
): ExternalSkillArtifactClassCountV1[] {
  const counts = new Map<ExternalSkillArtifactClassV1, { count: number; bytes: number }>(
    EXTERNAL_SKILL_ARTIFACT_CLASSES.map((artifactClass) => [
      artifactClass,
      { count: 0, bytes: 0 },
    ]),
  );
  for (const artifact of artifacts) {
    const count = counts.get(artifact.artifactClass)!;
    count.count += 1;
    count.bytes += artifact.byteLength;
  }
  return EXTERNAL_SKILL_ARTIFACT_CLASSES.map((artifactClass) => ({
    artifactClass,
    ...counts.get(artifactClass)!,
  }));
}

export function evaluateExternalSkillArtifactFirewall(
  value: unknown,
): ExternalSkillArtifactFirewallResultV1 {
  const input = normalizeInput(value);
  if (input === null) return withheld();

  const classified: ClassifiedArtifact[] = input.bundle.entries.map((entry) => ({
    ...entry,
    artifactClass: classifyPath(entry),
  }));
  const digests = classified.map(entryDigest);
  const inventoryDigest = sha256(Buffer.concat([
    Buffer.from('ashlr:external-skill-artifact-inventory:v1\0', 'ascii'),
    lengthPrefixed(EXTERNAL_SKILL_ARTIFACT_FIREWALL_POLICY_DIGEST),
    lengthPrefixed(input.marker.captureDigest),
    lengthPrefixed(input.marker.sourceIdentity),
    lengthPrefixed(input.bundle.portablePackDigest),
    lengthPrefixed(String(digests.length)),
    ...digests.map(lengthPrefixed),
  ]));

  const unknownArtifactCount = classified.filter(
    (artifact) => artifact.artifactClass === 'unknown',
  ).length;
  const skillEntryCount = classified.filter(
    (artifact) => artifact.artifactClass === 'skill-entry',
  ).length;
  const projections: string[] = [];
  let invalidArtifacts = 0;
  if (unknownArtifactCount === 0) {
    if (skillEntryCount > MAX_PROJECTED_SKILLS) {
      invalidArtifacts = skillEntryCount;
    } else {
      for (const artifact of classified) {
        if (artifact.artifactClass !== 'skill-entry') continue;
        const metadata = projectExternalSkillCandidateMetadata(artifact.content!);
        const expectedName = artifact.path.split('/')[1] ?? '';
        if (metadata === null || !SKILL_NAME.test(expectedName) ||
          metadata.name !== expectedName) {
          invalidArtifacts += 1;
          continue;
        }
        projections.push(sha256(Buffer.concat([
          Buffer.from('ashlr:external-skill-artifact-projection-entry:v1\0', 'ascii'),
          lengthPrefixed(metadata.name),
          lengthPrefixed(metadata.contentHash),
          lengthPrefixed(metadata.descriptionHash),
          lengthPrefixed(String(artifact.byteLength)),
        ])));
      }
    }
  }
  const projectionDigest = unknownArtifactCount === 0 && invalidArtifacts === 0
    ? sha256(Buffer.concat([
      Buffer.from('ashlr:external-skill-artifact-projection:v1\0', 'ascii'),
      lengthPrefixed(EXTERNAL_SKILL_ARTIFACT_FIREWALL_POLICY_DIGEST),
      lengthPrefixed(String(projections.length)),
      ...projections.map(lengthPrefixed),
    ]))
    : null;
  const reason: ExternalSkillArtifactFirewallReasonV1 =
    invalidArtifacts > 0
      ? 'projection-invalid'
      : unknownArtifactCount > 0
        ? 'unknown-artifacts'
        : 'inventory-classified';

  return {
    schemaVersion: 1,
    protocol: PROTOCOL,
    state: reason === 'inventory-classified' ? 'classified' : 'withheld',
    reason,
    gate: reason === 'inventory-classified' ? 'collecting' : 'withheld',
    policyDigest: EXTERNAL_SKILL_ARTIFACT_FIREWALL_POLICY_DIGEST,
    canonicalCaptureConsistencyVerified: true,
    repeatableSnapshotVerified: true,
    captureDigest: input.marker.captureDigest,
    captureReceiptDigest: sha256(Buffer.concat([
      CAPTURE_RECEIPT_DIGEST_DOMAIN,
      input.markerBytes,
    ])),
    portablePackDigest: input.bundle.portablePackDigest,
    inventoryDigest,
    classificationComplete: unknownArtifactCount === 0,
    artifactCount: classified.length,
    unknownArtifactCount,
    classCounts: classCounts(classified),
    projection: {
      policy: PROJECTION_POLICY,
      eligibleArtifacts: projections.length,
      invalidArtifacts,
      projectionDigest,
    },
    ...authorityBoundary(),
  };
}
