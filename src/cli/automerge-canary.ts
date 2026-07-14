import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  type BigIntStats,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

import {
  activateShadow,
  AUTOMERGE_CANARY_MAX_REVISIONS_PER_EPOCH,
  automergeCanaryStatus,
  recoverableAutomergeCanaryHaltCas,
  haltShadow,
  type AutoMergeCanaryActivationInput,
  type AutoMergeCanaryReadResult,
  type AutoMergeCanaryShadowCountersV1,
  type AutoMergeCanaryShadowEvidenceV1,
  type AutoMergeCanaryStateV1,
  type AutoMergeCanaryWriteResult,
} from '../core/fleet/automerge-canary-store.js';
import { deriveAutoMergeCanaryCandidateBindings } from '../core/fleet/automerge-canary-observer.js';
import { assurePrivateStoragePath } from '../core/util/private-storage.js';

export const AUTOMERGE_CANARY_MAX_ACTIVATION_INPUT_BYTES = 16 * 1024;

const PREPARED_SHADOW_BUDGETS = {
  maxAdmissions: 1,
  maxMerges: 1,
  maxInFlight: 1,
  minMergeIntervalMs: 24 * 60 * 60 * 1_000,
  leaseDurationMs: 10 * 60 * 1_000,
  observationDurationMs: 7 * 24 * 60 * 60 * 1_000,
} as const;
const IMMUTABLE_OID_RE = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;

const O_NOFOLLOW = typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0;
const AUTHORITY_BOUNDARY = {
  schemaVersion: 1 as const,
  authority: 'observation-only' as const,
  policyEligible: false as const,
  enforceSupported: false as const,
  hostCancellationProven: false as const,
};

interface ConciseCanaryState {
  epochId: string;
  revision: number;
  mode: 'shadow';
  state: AutoMergeCanaryStateV1['state'];
  activatedAt: string;
  updatedAt: string;
  counters: AutoMergeCanaryStateV1['counters'];
  observation: AutoMergeCanaryStateV1['observation'];
  blocker: AutoMergeCanaryStateV1['blocker'];
}

interface ConciseShadowEvidence {
  observedAt: string;
  outcome: AutoMergeCanaryShadowEvidenceV1['outcome'];
  mismatchFields: AutoMergeCanaryShadowEvidenceV1['mismatchFields'];
  fileCount: number;
  lineCount: number;
}

interface ShadowCanaryTelemetry {
  shadowCounters: AutoMergeCanaryShadowCountersV1 | null;
  outcomeRates: {
    eligible: number | null;
    rejected: number | null;
    bindingMismatch: number | null;
    inspectionError: number | null;
  };
  casRetries: number | null;
  revisionCapacity: {
    maximum: number;
    used: number | null;
    remaining: number | null;
    reservedForTerminal: 1;
    observationWritesRemaining: number | null;
  };
  epochAgeMs: number | null;
  observationDeadlineRemainingMs: number | null;
  lastShadowEvidence: ConciseShadowEvidence | null;
}

export interface AutoMergeCanaryCliStatus {
  schemaVersion: 1;
  authority: 'observation-only';
  policyEligible: false;
  enforceSupported: false;
  hostCancellationProven: false;
  sourceState: AutoMergeCanaryReadResult['sourceState'];
  severity: AutoMergeCanaryReadResult['severity'];
  status: AutoMergeCanaryReadResult['status'];
  active: boolean;
  state: ConciseCanaryState | null;
  telemetry: ShadowCanaryTelemetry;
  diagnostics: AutoMergeCanaryReadResult['diagnostics'];
  limitExceeded: boolean;
}

function unknownTelemetry(): ShadowCanaryTelemetry {
  return {
    shadowCounters: null,
    outcomeRates: {
      eligible: null,
      rejected: null,
      bindingMismatch: null,
      inspectionError: null,
    },
    casRetries: null,
    revisionCapacity: {
      maximum: AUTOMERGE_CANARY_MAX_REVISIONS_PER_EPOCH,
      used: null,
      remaining: null,
      reservedForTerminal: 1,
      observationWritesRemaining: null,
    },
    epochAgeMs: null,
    observationDeadlineRemainingMs: null,
    lastShadowEvidence: null,
  };
}

function conciseShadowEvidence(
  evidence: AutoMergeCanaryShadowEvidenceV1 | null,
): ConciseShadowEvidence | null {
  if (!evidence) return null;
  return {
    observedAt: evidence.observedAt,
    outcome: evidence.outcome,
    mismatchFields: [...evidence.mismatchFields],
    fileCount: evidence.fileCount,
    lineCount: evidence.lineCount,
  };
}

function shadowTelemetry(
  read: AutoMergeCanaryReadResult,
  now: Date,
): ShadowCanaryTelemetry {
  if (read.sourceState !== 'healthy' || !read.state) return unknownTelemetry();
  const state = read.state;
  const attempts = state.shadowCounters.attempts;
  const nowMs = now.getTime();
  const activatedMs = Date.parse(state.activatedAt);
  const deadlineMs = state.observation.deadlineAt === null
    ? null
    : Date.parse(state.observation.deadlineAt);
  const rate = (count: number): number | null => attempts === 0
    ? null
    : Math.min(1, Math.max(0, count / attempts));
  return {
    shadowCounters: { ...state.shadowCounters },
    outcomeRates: {
      eligible: rate(state.shadowCounters.eligible),
      rejected: rate(state.shadowCounters.rejected),
      bindingMismatch: rate(state.shadowCounters.bindingMismatches),
      inspectionError: rate(state.shadowCounters.inspectionErrors),
    },
    casRetries: state.shadowCounters.casRetries,
    revisionCapacity: {
      maximum: AUTOMERGE_CANARY_MAX_REVISIONS_PER_EPOCH,
      used: state.revision,
      remaining: AUTOMERGE_CANARY_MAX_REVISIONS_PER_EPOCH - state.revision,
      reservedForTerminal: 1,
      observationWritesRemaining: Math.max(
        0,
        AUTOMERGE_CANARY_MAX_REVISIONS_PER_EPOCH - state.revision - 1,
      ),
    },
    epochAgeMs: Number.isFinite(nowMs) && activatedMs <= nowMs ? nowMs - activatedMs : null,
    observationDeadlineRemainingMs: Number.isFinite(nowMs) && deadlineMs !== null &&
      state.observation.completedAt === null
      ? Math.max(0, deadlineMs - nowMs)
      : null,
    lastShadowEvidence: conciseShadowEvidence(state.lastShadowEvidence),
  };
}

function conciseState(state: AutoMergeCanaryStateV1 | null): ConciseCanaryState | null {
  if (!state) return null;
  return {
    epochId: state.epochId,
    revision: state.revision,
    mode: state.mode,
    state: state.state,
    activatedAt: state.activatedAt,
    updatedAt: state.updatedAt,
    counters: { ...state.counters },
    observation: { ...state.observation },
    blocker: state.blocker === null ? null : { ...state.blocker },
  };
}

/** Pure, bounded projection: it omits repository and policy digests plus revision history. */
export function projectAutoMergeCanaryStatus(
  read: AutoMergeCanaryReadResult,
  now = new Date(),
): AutoMergeCanaryCliStatus {
  return {
    ...AUTHORITY_BOUNDARY,
    sourceState: read.sourceState,
    severity: read.severity,
    status: read.status,
    active: read.active,
    state: read.sourceState === 'healthy' ? conciseState(read.state) : null,
    telemetry: shadowTelemetry(read, now),
    diagnostics: [...read.diagnostics],
    limitExceeded: read.limitExceeded,
  };
}

/** Pure terminal formatter used by both human and machine-readable status paths. */
export function formatAutoMergeCanaryStatus(
  read: AutoMergeCanaryReadResult,
  json = false,
  now = new Date(),
): string {
  const status = projectAutoMergeCanaryStatus(read, now);
  if (json) return `${JSON.stringify(status)}\n`;

  const lines = [
    `auto-merge canary: ${status.status} (${status.sourceState})`,
    'authority: observation-only; policy eligible: no; enforce supported: no',
    'host cancellation proven: no',
  ];
  if (status.state) {
    lines.push(`epoch: ${status.state.epochId}; revision: ${status.state.revision}; active: ${status.active ? 'yes' : 'no'}`);
  }
  const telemetry = status.telemetry;
  if (telemetry.shadowCounters) {
    const rates = telemetry.outcomeRates;
    const percent = (value: number | null): string => value === null ? 'unknown' : `${(value * 100).toFixed(1)}%`;
    lines.push(
      `shadow soak: ${telemetry.shadowCounters.attempts} attempt(s); ` +
        `eligible ${telemetry.shadowCounters.eligible} (${percent(rates.eligible)}); ` +
        `rejected ${telemetry.shadowCounters.rejected} (${percent(rates.rejected)})`,
    );
    lines.push(
      `anomalies: binding mismatch ${telemetry.shadowCounters.bindingMismatches} ` +
        `(${percent(rates.bindingMismatch)}); inspection error ${telemetry.shadowCounters.inspectionErrors} ` +
        `(${percent(rates.inspectionError)}); CAS retries ${telemetry.casRetries}`,
    );
    lines.push(
      `revision capacity: ${telemetry.revisionCapacity.used}/${telemetry.revisionCapacity.maximum} used; ` +
        `${telemetry.revisionCapacity.observationWritesRemaining} observation writes remaining; ` +
        '1 revision reserved for terminal halt',
    );
    lines.push(
      `epoch age: ${telemetry.epochAgeMs ?? 'unknown'} ms; observation deadline remaining: ` +
        `${telemetry.observationDeadlineRemainingMs ?? 'unknown'} ms`,
    );
    if (telemetry.lastShadowEvidence) {
      lines.push(
        `last observation: ${telemetry.lastShadowEvidence.outcome} at ` +
          `${telemetry.lastShadowEvidence.observedAt}; files ${telemetry.lastShadowEvidence.fileCount}; ` +
          `lines ${telemetry.lastShadowEvidence.lineCount}`,
      );
    }
  } else {
    lines.push('shadow soak: unknown');
  }
  if (status.diagnostics.length > 0) lines.push(`diagnostics: ${status.diagnostics.join(', ')}`);
  return `${lines.join('\n')}\n`;
}

interface ParsedJsonFile {
  ok: true;
  value: unknown;
}

interface JsonFileError {
  ok: false;
  reason: string;
}

function sameFile(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameSnapshot(left: BigIntStats, right: BigIntStats): boolean {
  return sameFile(left, right) && left.size === right.size && left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs && left.mode === right.mode && left.uid === right.uid &&
    left.gid === right.gid && left.nlink === right.nlink;
}

function activationInputWithinAnchor(anchorPath: string, inputPath: string): boolean {
  const nested = relative(anchorPath, inputPath);
  return nested !== '' && nested !== '..' && !nested.startsWith(`..${sep}`) && !isAbsolute(nested);
}

function currentUid(): bigint | null {
  return typeof process.getuid === 'function' ? BigInt(process.getuid()) : null;
}

function safePosixInputFile(stat: BigIntStats, uid: bigint): boolean {
  return stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1n && stat.uid === uid &&
    (stat.mode & 0o077n) === 0n;
}

function trustedPosixAncestor(stat: BigIntStats, uid: bigint): boolean {
  return stat.isDirectory() && !stat.isSymbolicLink() && (stat.uid === uid || stat.uid === 0n) &&
    (stat.mode & 0o022n) === 0n;
}

function snapshotActivationAncestors(
  inputPath: string,
  anchorPath: string,
  uid: bigint | null,
): Map<string, BigIntStats> | null {
  const snapshots = new Map<string, BigIntStats>();
  let cursor = dirname(inputPath);
  for (let depth = 0; depth < 256; depth += 1) {
    const snapshot = lstatSync(cursor, { bigint: true });
    if (process.platform === 'win32') {
      if (!snapshot.isDirectory() || snapshot.isSymbolicLink()) return null;
    } else if (uid === null || !trustedPosixAncestor(snapshot, uid)) {
      return null;
    }
    snapshots.set(cursor, snapshot);
    if (cursor === anchorPath) return snapshots;
    const parent = dirname(cursor);
    if (parent === cursor) return null;
    cursor = parent;
  }
  return null;
}

function activationAncestorsUnchanged(
  snapshots: Map<string, BigIntStats>,
  uid: bigint | null,
): boolean {
  for (const [path, before] of snapshots) {
    const after = lstatSync(path, { bigint: true });
    const safe = process.platform === 'win32'
      ? after.isDirectory() && !after.isSymbolicLink()
      : uid !== null && trustedPosixAncestor(after, uid);
    if (!safe || !sameSnapshot(before, after)) return false;
  }
  return true;
}

function readBoundedJsonFile(path: string): ParsedJsonFile | JsonFileError {
  let descriptor: number | undefined;
  try {
    const anchorPath = resolve(homedir());
    const inputPath = resolve(path);
    if (!activationInputWithinAnchor(anchorPath, inputPath)) {
      return { ok: false, reason: 'input must be beneath the current user home directory' };
    }
    const uid = process.platform === 'win32' ? null : currentUid();
    if (process.platform !== 'win32' && uid === null) {
      return { ok: false, reason: 'input ownership cannot be proved' };
    }
    const ancestors = snapshotActivationAncestors(inputPath, anchorPath, uid);
    if (!ancestors) {
      return { ok: false, reason: 'input has an untrusted or writable directory ancestor' };
    }

    const before = lstatSync(inputPath, { bigint: true });
    const safeFile = process.platform === 'win32'
      ? before.isFile() && !before.isSymbolicLink() && before.nlink === 1n
      : uid !== null && safePosixInputFile(before, uid);
    if (!safeFile) {
      return { ok: false, reason: 'input must be a private current-user regular file with one link' };
    }
    if (process.platform === 'win32' && !assurePrivateStoragePath(
      inputPath,
      'file',
      'inspect-owned',
      { anchorPath },
    ).ok) {
      return { ok: false, reason: 'input owner, ACL, or reparse safety cannot be proved' };
    }
    if (before.size < 1n || before.size > BigInt(AUTOMERGE_CANARY_MAX_ACTIVATION_INPUT_BYTES)) {
      return { ok: false, reason: `input must be 1..${AUTOMERGE_CANARY_MAX_ACTIVATION_INPUT_BYTES} bytes` };
    }

    descriptor = openSync(inputPath, fsConstants.O_RDONLY | O_NOFOLLOW);
    const opened = fstatSync(descriptor, { bigint: true });
    const safeOpened = process.platform === 'win32'
      ? opened.isFile() && opened.nlink === 1n
      : uid !== null && safePosixInputFile(opened, uid);
    if (!safeOpened || !sameSnapshot(before, opened)) {
      return { ok: false, reason: 'input changed while opening' };
    }

    const expectedLength = Number(opened.size);
    const bytes = Buffer.alloc(expectedLength);
    let length = 0;
    while (length < expectedLength) {
      const count = readSync(descriptor, bytes, length, bytes.length - length, null);
      if (count === 0) break;
      length += count;
    }
    const growthProbe = Buffer.allocUnsafe(1);
    const grew = readSync(descriptor, growthProbe, 0, 1, null) !== 0;
    const after = fstatSync(descriptor, { bigint: true });
    const pathAfter = lstatSync(inputPath, { bigint: true });
    const windowsAssuredAfter = process.platform !== 'win32' || assurePrivateStoragePath(
      inputPath,
      'file',
      'inspect-owned',
      { anchorPath },
    ).ok;
    if (length !== expectedLength || grew || !sameSnapshot(opened, after) ||
      !sameSnapshot(after, pathAfter) || !activationAncestorsUnchanged(ancestors, uid) ||
      !windowsAssuredAfter) {
      return { ok: false, reason: 'input is oversized or changed while reading' };
    }

    const value: unknown = JSON.parse(bytes.subarray(0, length).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return { ok: false, reason: 'input must contain one JSON object' };
    }
    return { ok: true, value };
  } catch {
    return { ok: false, reason: 'input is unavailable or is not valid JSON' };
  } finally {
    if (descriptor !== undefined) {
      try { closeSync(descriptor); } catch { /* read-only descriptor cleanup */ }
    }
  }
}

function jsonRequested(args: readonly string[]): boolean {
  return args.includes('--json');
}

function validJsonOnly(args: readonly string[]): boolean {
  return args.every((arg) => arg === '--json') && args.filter((arg) => arg === '--json').length <= 1;
}

function emit(value: unknown, json: boolean, human: string, error = false): void {
  if (json) {
    process.stdout.write(`${JSON.stringify(value)}\n`);
  } else if (error) {
    process.stderr.write(`${human}\n`);
  } else {
    process.stdout.write(`${human}\n`);
  }
}

function refusal(action: string, reason: string): Record<string, unknown> {
  return { ok: false, action, ...AUTHORITY_BOUNDARY, reason };
}

function writeFailureCode(result: AutoMergeCanaryWriteResult): number {
  return result.ok ? 0 : result.reason === 'invalid' ? 2 : 1;
}

function actionResult(
  action: 'activate-shadow' | 'halt',
  state: AutoMergeCanaryStateV1,
  changed: boolean,
): Record<string, unknown> {
  return {
    ok: true,
    action,
    changed,
    ...AUTHORITY_BOUNDARY,
    sourceState: 'healthy',
    status: state.state,
    active: state.state !== 'halted',
    state: conciseState(state),
  };
}

function help(): string {
  return [
    'usage: ashlr fleet automerge-canary status [--json]',
    '       ashlr fleet automerge-canary prepare-shadow --repo <absolute-repo> --base-ref <branch> --base-oid <immutable-oid> --head-oid <immutable-oid> [--json]',
    '       ashlr fleet automerge-canary activate-shadow --input <bounded-json-file> [--json]',
    '       ashlr fleet automerge-canary halt [--json]',
    '       ashlr fleet automerge-canary reconcile [--json]',
  ].join('\n');
}

interface PrepareShadowArgs {
  repo: string;
  baseRef: string;
  baseOid: string;
  headOid: string;
  json: boolean;
}

function canonicalRepo(path: string): boolean {
  if (!isAbsolute(path) || resolve(path) !== path) return false;
  try {
    const entry = lstatSync(path);
    return entry.isDirectory() && !entry.isSymbolicLink() && realpathSync(path) === path;
  } catch {
    return false;
  }
}

function canonicalBranch(branch: string): boolean {
  return branch.length > 0 && branch.length <= 255 && branch !== 'HEAD' && branch !== '@' &&
    !branch.startsWith('-') && !branch.startsWith('refs/') &&
    /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(branch) &&
    !branch.includes('..') && !branch.includes('//') && !branch.includes('@{') &&
    !branch.endsWith('/') && !branch.endsWith('.') && !branch.endsWith('.lock') &&
    !branch.split('/').some((component) => component.startsWith('.'));
}

function parsePrepareShadowArgs(args: readonly string[]): { ok: true; value: PrepareShadowArgs } | JsonFileError {
  const values = new Map<string, string>();
  let json = false;
  const valueOptions = new Set(['--repo', '--base-ref', '--base-oid', '--head-oid']);
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === '--json' && !json) {
      json = true;
      continue;
    }
    if (!valueOptions.has(arg) || values.has(arg)) {
      return { ok: false, reason: 'unknown, duplicate, or valueless preparation option' };
    }
    const value = args[index + 1];
    if (!value || value.startsWith('--')) {
      return { ok: false, reason: `${arg} requires a value` };
    }
    values.set(arg, value);
    index += 1;
  }
  for (const option of valueOptions) {
    if (!values.has(option)) return { ok: false, reason: `${option} is required` };
  }
  const value = {
    repo: values.get('--repo')!,
    baseRef: values.get('--base-ref')!,
    baseOid: values.get('--base-oid')!,
    headOid: values.get('--head-oid')!,
    json,
  };
  if (!canonicalRepo(value.repo)) {
    return { ok: false, reason: '--repo must be a canonical absolute non-symbolic directory' };
  }
  if (!canonicalBranch(value.baseRef)) {
    return { ok: false, reason: '--base-ref must be one canonical branch name' };
  }
  if (!IMMUTABLE_OID_RE.test(value.baseOid) || !IMMUTABLE_OID_RE.test(value.headOid)) {
    return { ok: false, reason: '--base-oid and --head-oid must be lowercase immutable commit OIDs' };
  }
  if (value.baseOid === value.headOid) {
    return { ok: false, reason: '--base-oid and --head-oid must identify different commits' };
  }
  return { ok: true, value };
}

function parseActivationArgs(args: readonly string[]): { ok: true; input: string; json: boolean } | JsonFileError {
  let input: string | undefined;
  let json = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--json' && !json) {
      json = true;
      continue;
    }
    if (arg === '--input' && input === undefined) {
      const value = args[index + 1];
      if (!value || value.startsWith('--')) return { ok: false, reason: '--input requires a file path' };
      input = value;
      index += 1;
      continue;
    }
    return { ok: false, reason: 'unknown, duplicate, or valueless activation option' };
  }
  return input ? { ok: true, input, json } : { ok: false, reason: '--input is required' };
}

/** Operator surface for the observation-only auto-merge canary controller. */
export async function cmdAutoMergeCanary(args: string[]): Promise<number> {
  const subcommand = args[0] ?? 'status';
  const rest = args.slice(1);

  if (subcommand === '--help' || subcommand === '-h' || subcommand === 'help') {
    if (rest.length > 0) {
      process.stderr.write(`${help()}\n`);
      return 2;
    }
    process.stdout.write(`${help()}\n`);
    return 0;
  }

  if (subcommand === 'status') {
    if (!validJsonOnly(rest)) {
      emit(refusal('status', 'usage'), jsonRequested(rest), `${help()}\nerror: status accepts only --json`, true);
      return 2;
    }
    const read = automergeCanaryStatus();
    process.stdout.write(formatAutoMergeCanaryStatus(read, rest.includes('--json')));
    return read.sourceState === 'degraded' || read.severity === 'critical' ? 1 : 0;
  }

  if (subcommand === 'prepare-shadow') {
    const parsed = parsePrepareShadowArgs(rest);
    if (!parsed.ok) {
      emit(refusal('prepare-shadow', parsed.reason), jsonRequested(rest), `error: ${parsed.reason}`, true);
      return 2;
    }
    let cfg: import('../core/types.js').AshlrConfig;
    try {
      const { loadConfigReadOnly } = await import('../core/config.js');
      cfg = loadConfigReadOnly();
    } catch {
      emit(
        refusal('prepare-shadow', 'config-unavailable'),
        parsed.value.json,
        'error: current config is unavailable',
        true,
      );
      return 1;
    }
    const bindings = deriveAutoMergeCanaryCandidateBindings({
      repo: parsed.value.repo,
      baseRef: parsed.value.baseRef,
      baseOid: parsed.value.baseOid,
      headOid: parsed.value.headOid,
      cfg,
    });
    if (!bindings) {
      emit(
        refusal('prepare-shadow', 'binding-derivation-failed'),
        parsed.value.json,
        'error: shadow activation bindings could not be derived',
        true,
      );
      return 1;
    }
    const activation: AutoMergeCanaryActivationInput = {
      mode: 'shadow',
      repository: {
        repositoryId: bindings.repositoryId,
        fetchDestinationDigest: bindings.fetchDestinationDigest,
        pushDestinationDigest: bindings.pushDestinationDigest,
        baseRefDigest: bindings.baseRefDigest,
        baseOid: bindings.baseOid,
        headOid: bindings.headOid,
      },
      policyDigest: bindings.policyDigest,
      configDigest: bindings.configDigest,
      classifierDigest: bindings.classifierDigest,
      pathDigest: bindings.pathDigest,
      budgets: { ...PREPARED_SHADOW_BUDGETS },
    };
    process.stdout.write(`${JSON.stringify(activation)}\n`);
    return 0;
  }

  if (subcommand === 'activate-shadow') {
    const parsed = parseActivationArgs(rest);
    if (!parsed.ok) {
      emit(refusal('activate-shadow', parsed.reason), jsonRequested(rest), `error: ${parsed.reason}`, true);
      return 2;
    }
    const input = readBoundedJsonFile(parsed.input);
    if (!input.ok) {
      emit(refusal('activate-shadow', input.reason), parsed.json, `error: ${input.reason}`, true);
      return 2;
    }
    const result = activateShadow(input.value as AutoMergeCanaryActivationInput);
    if (!result.ok) {
      emit(refusal('activate-shadow', result.reason), parsed.json, `error: shadow activation refused: ${result.reason}`, true);
      return writeFailureCode(result);
    }
    emit(
      actionResult('activate-shadow', result.state, true),
      parsed.json,
      `auto-merge canary: shadow activated; epoch: ${result.state.epochId}; revision: ${result.state.revision}\n` +
        'authority: observation-only; policy eligible: no; host cancellation proven: no',
    );
    return 0;
  }

  if (subcommand === 'halt') {
    if (!validJsonOnly(rest)) {
      emit(refusal('halt', 'usage'), jsonRequested(rest), `${help()}\nerror: halt accepts only --json`, true);
      return 2;
    }
    const json = rest.includes('--json');
    const current = automergeCanaryStatus();
    if (current.sourceState === 'degraded') {
      const recoveryCas = recoverableAutomergeCanaryHaltCas(current);
      if (recoveryCas === null) {
        emit(refusal('halt', 'degraded'), json, 'error: canary state is degraded; halt refused', true);
        return 1;
      }
      const recovered = haltShadow(recoveryCas);
      if (!recovered.ok) {
        emit(refusal('halt', recovered.reason), json, `error: canary halt recovery refused: ${recovered.reason}`, true);
        return writeFailureCode(recovered);
      }
      emit(
        actionResult('halt', recovered.state, true),
        json,
        `auto-merge canary: terminal summary recovered; revision: ${recovered.state.revision}\n` +
          'host cancellation proven: no',
      );
      return 0;
    }
    if (current.sourceState === 'healthy' && current.state?.state === 'halted') {
      emit(
        actionResult('halt', current.state, false),
        json,
        'auto-merge canary: already halted; local state unchanged\nhost cancellation proven: no',
      );
      return 0;
    }
    if (current.sourceState !== 'healthy' || !current.active || !current.state) {
      emit(refusal('halt', 'inactive'), json, 'error: no active healthy shadow canary to halt', true);
      return 1;
    }

    const result = haltShadow({
      epochId: current.state.epochId,
      revision: current.state.revision,
      attestation: current.state.attestation,
    });
    if (!result.ok) {
      emit(refusal('halt', result.reason), json, `error: canary halt refused: ${result.reason}`, true);
      return writeFailureCode(result);
    }
    emit(
      actionResult('halt', result.state, true),
      json,
      `auto-merge canary: halted; revision: ${result.state.revision}; local controller state only\n` +
        'host cancellation proven: no',
    );
    return 0;
  }

  if (subcommand === 'reconcile') {
    if (!validJsonOnly(rest)) {
      emit(refusal('reconcile', 'usage'), jsonRequested(rest), `${help()}\nerror: reconcile accepts only --json`, true);
      return 2;
    }
    emit(
      refusal('reconcile', 'unsupported'),
      rest.includes('--json'),
      'error: reconcile is unsupported; host cancellation cannot be proven by canary v1',
      true,
    );
    return 1;
  }

  if (subcommand === 'activate-enforce' || subcommand === 'enforce') {
    const json = jsonRequested(rest);
    emit(refusal(subcommand, 'enforce-unsupported'), json, 'error: enforce mode is unsupported', true);
    return 1;
  }

  emit(refusal(subcommand, 'unknown-command'), jsonRequested(rest), `${help()}\nerror: unknown subcommand: ${subcommand}`, true);
  return 2;
}
