import { randomUUID } from 'node:crypto';
import { constants, lstatSync, type BigIntStats } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { canonicalJson } from '../authority/canonical-json.js';
import { acquireLocalStoreLock, ownsLocalStoreLock, releaseLocalStoreLock } from '../fleet/local-store-lock.js';
import { inspectPrivateDirectory } from '../universe/artifacts.js';
import { readStableRegularFile } from '../util/stable-file-read.js';
import { writePrivateFileAtomically } from '../util/private-file-write.js';
import type {
  ClaudeApiGrantAdmission, ClaudeApiGrantBinding, ClaudeApiGrantReadView,
  ClaudeApiGrantHoldReason, ClaudeApiGrantObservationV1, ClaudeApiGrantRecordedObservation, ClaudeApiGrantReservation,
  ClaudeApiGrantResult, ClaudeApiGrantView, FreshClaudeApiGrantProof, ReadFreshClaudeApiGrantProof,
} from './claude-api-grant-types.js';

export const CLAUDE_API_GRANT_OBSERVATIONS_FILE = 'claude-api-grants.json';
export const CLAUDE_API_GRANT_LEDGER_FILE = 'claude-api-grant-ledger.json';
const MAX_BYTES = 1024 * 1024;
const MAX_ROWS = 4096;
const HASH = /^[0-9a-f]{64}$/;
const ID = /^[a-z0-9][a-z0-9_-]{0,79}$/;
const MESSAGE_ID = /^msg_[A-Za-z0-9_-]{1,120}$/;
const MONEY = /^(?:0|[1-9][0-9]{0,39})$/;
type Row = Record<string, unknown>;
function exact(value: unknown, keys: string[]): value is Row {
  return !!value && typeof value === 'object' && !Array.isArray(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value)) &&
    Reflect.ownKeys(value).length === keys.length && keys.every(key => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return !!descriptor && 'value' in descriptor;
    });
}
function text(value: unknown, expression: RegExp): value is string { return typeof value === 'string' && expression.test(value); }
function money(value: unknown): value is string { return text(value, MONEY); }
function iso(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}
function date(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(`${value}T00:00:00.000Z`)) && new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) === value;
}
function binding(value: unknown): value is ClaudeApiGrantBinding {
  return exact(value, ['organizationDigest', 'workspaceDigest', 'credentialDigest', 'generation']) &&
    ['organizationDigest', 'workspaceDigest', 'credentialDigest'].every(key => text(value[key], HASH)) && text(value.generation, ID);
}
function same(a: unknown, b: unknown): boolean { return canonicalJson(a) === canonicalJson(b); }
function dense(value: unknown): value is unknown[] {
  return Array.isArray(value) && Object.getPrototypeOf(value) === Array.prototype && value.length <= MAX_ROWS && Reflect.ownKeys(value).length === value.length + 1 &&
    Array.from({ length: value.length }, (_, i) => Object.getOwnPropertyDescriptor(value, String(i))).every(d => d && 'value' in d);
}
function fail(reason: ClaudeApiGrantHoldReason): never { throw new Held(reason); }
class Held extends Error { constructor(readonly reason: ClaudeApiGrantHoldReason) { super(reason); } }
function result<T>(operation: () => T): ClaudeApiGrantResult<T> {
  try { return { ok: true, value: operation() }; } catch (error) {
    return { ok: false, reason: error instanceof Held ? error.reason : 'store-unavailable' };
  }
}

/** The UTC-day boundary is an admission policy, never a guessed provider expiry instant. */
export function claudeApiGrantCutoff(value: unknown): { at: string; policy: 'expiry-day-start/v1' | 'verified-instant/v1' } | null {
  try {
    if (!exact(value, ['precision', 'date', 'timezone', 'instant'])) return null;
    if (value.precision === 'unknown') return null;
    if (!date(value.date) || value.timezone !== 'UTC') return null;
    if (value.precision === 'date' && value.instant === null) return { at: `${value.date}T00:00:00.000Z`, policy: 'expiry-day-start/v1' };
    if (value.precision === 'instant' && iso(value.instant) && value.instant.slice(0, 10) === value.date) {
      return { at: value.instant, policy: 'verified-instant/v1' };
    }
    return null;
  } catch { return null; }
}
export function parseClaudeApiGrantObservation(value: unknown, nowMs: number): ClaudeApiGrantObservationV1 | null {
  try {
    if (!Number.isFinite(nowMs) || !exact(value, ['v', 'kind', 'observationId', 'cycleId', 'binding', 'remainingUsdMicros',
      'totalUsdMicros', 'capturedAt', 'expiry', 'evidenceDigest']) || value.v !== 1 || value.kind !== 'claude-api-promotion' ||
      !text(value.observationId, ID) || !text(value.cycleId, ID) || !binding(value.binding) ||
      !(value.remainingUsdMicros === null || money(value.remainingUsdMicros)) || !(value.totalUsdMicros === null || money(value.totalUsdMicros)) ||
      !iso(value.capturedAt) || Date.parse(value.capturedAt) > nowMs || !text(value.evidenceDigest, HASH) ||
      !exact(value.expiry, ['precision', 'date', 'timezone', 'instant'])) return null;
    const expiry = value.expiry;
    if (expiry.precision === 'unknown') {
      if (expiry.date !== null || expiry.timezone !== null || expiry.instant !== null) return null;
    } else if (!claudeApiGrantCutoff(expiry)) return null;
    if (money(value.remainingUsdMicros) && money(value.totalUsdMicros) && BigInt(value.remainingUsdMicros) > BigInt(value.totalUsdMicros)) return null;
    return JSON.parse(canonicalJson(value)) as ClaudeApiGrantObservationV1;
  } catch { return null; }
}
/** Stored history is an explicit disjoint kind, not a partially bound financial observation. */
export function parseClaudeApiGrantRecordedObservation(value: unknown, nowMs: number): ClaudeApiGrantRecordedObservation | null {
  const financial = parseClaudeApiGrantObservation(value, nowMs); if (financial) return financial;
  try {
    if (!Number.isFinite(nowMs) || !exact(value, ['v', 'kind', 'observationId', 'cycleId', 'binding', 'remainingUsdMicros',
      'totalUsdMicros', 'capturedAt', 'expiry', 'evidenceDigest']) || value.v !== 1 || value.kind !== 'claude-api-promotion-history' ||
      value.binding !== null || value.cycleId !== null || !text(value.observationId, ID) ||
      !(value.remainingUsdMicros === null || money(value.remainingUsdMicros)) || !(value.totalUsdMicros === null || money(value.totalUsdMicros)) ||
      !iso(value.capturedAt) || Date.parse(value.capturedAt) > nowMs || !text(value.evidenceDigest, HASH) ||
      !exact(value.expiry, ['precision', 'date', 'timezone', 'instant'])) return null;
    if (value.expiry.precision === 'unknown') {
      if (value.expiry.date !== null || value.expiry.timezone !== null || value.expiry.instant !== null) return null;
    } else if (!claudeApiGrantCutoff(value.expiry)) return null;
    if (money(value.remainingUsdMicros) && money(value.totalUsdMicros) && BigInt(value.remainingUsdMicros) > BigInt(value.totalUsdMicros)) return null;
    return JSON.parse(canonicalJson(value)) as ClaudeApiGrantRecordedObservation;
  } catch { return null; }
}
interface LedgerRow {
  id: string; cycleId: string; binding: ClaudeApiGrantBinding; pricingDigest: string;
  maxUsdMicros: string; heldUsdMicros: string; createdAt: string;
  state: 'reserved' | 'sent' | 'unknown' | 'settled' | 'released';
  providerRequestId: string | null; actualUsdMicros: string | null;
}
interface Ledger { v: 1; rows: LedgerRow[]; ceilings: { organizationDigest: string; cycleId: string; usdMicros: string; cutoff: string }[]; }
function validLedger(raw: unknown): raw is Ledger {
  if (!exact(raw, ['v', 'rows', 'ceilings']) || raw.v !== 1 || !dense(raw.rows) || !dense(raw.ceilings)) return false;
  const ids = new Set<string>(); const providers = new Set<string>(); const ceilings = new Set<string>();
  for (const row of raw.rows) {
    if (!exact(row, ['id', 'cycleId', 'binding', 'pricingDigest', 'maxUsdMicros', 'heldUsdMicros', 'createdAt', 'state', 'providerRequestId', 'actualUsdMicros']) ||
      !text(row.id, ID) || ids.has(row.id) || !text(row.cycleId, ID) || !binding(row.binding) || !text(row.pricingDigest, HASH) ||
      !money(row.maxUsdMicros) || BigInt(row.maxUsdMicros) === 0n || !money(row.heldUsdMicros) || !iso(row.createdAt) ||
      !['reserved', 'sent', 'unknown', 'settled', 'released'].includes(String(row.state)) ||
      !(row.providerRequestId === null || text(row.providerRequestId, MESSAGE_ID)) || !(row.actualUsdMicros === null || money(row.actualUsdMicros))) return false;
    if (row.state === 'settled' && (row.providerRequestId === null || row.actualUsdMicros === null || row.heldUsdMicros !== '0' || BigInt(row.actualUsdMicros) > BigInt(row.maxUsdMicros)) ||
      row.state === 'released' && (row.heldUsdMicros !== '0' || row.actualUsdMicros !== null || row.providerRequestId !== null) ||
      ['reserved', 'sent', 'unknown'].includes(String(row.state)) && (BigInt(row.heldUsdMicros) < BigInt(row.maxUsdMicros) || row.actualUsdMicros !== null || row.state !== 'unknown' && row.providerRequestId !== null)) return false;
    if (row.providerRequestId !== null) { if (providers.has(row.providerRequestId)) return false; providers.add(row.providerRequestId); }
    ids.add(row.id);
  }
  for (const row of raw.ceilings) {
    if (!exact(row, ['organizationDigest', 'cycleId', 'usdMicros', 'cutoff']) || !text(row.organizationDigest, HASH) || !text(row.cycleId, ID) || !money(row.usdMicros) || !iso(row.cutoff)) return false;
    const key = `${row.organizationDigest}:${row.cycleId}`; if (ceilings.has(key)) return false; ceilings.add(key);
  }
  return raw.rows.every(row => (raw.ceilings as Ledger['ceilings']).some(c => c.organizationDigest === (row as LedgerRow).binding.organizationDigest && c.cycleId === (row as LedgerRow).cycleId));
}
function readFile(root: string, name: string): unknown | null {
  if (!isAbsolute(root) || resolve(root) !== root) fail('store-unavailable');
  inspectPrivateDirectory(root);
  const path = join(root, name);
  let before: BigIntStats;
  try {
    const stat = lstatSync(path, { bigint: true }); before = stat;
    if (!stat.isFile() || stat.nlink !== 1n || process.platform !== 'win32' && (stat.mode & 0o777n) !== 0o600n ||
      typeof process.getuid === 'function' && stat.uid !== BigInt(process.getuid())) fail('store-unavailable');
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  const read = readStableRegularFile(path, { anchorPath: root, maxFileBytes: MAX_BYTES, remainingBytes: MAX_BYTES });
  if (!read.ok || !sameSnapshot(before, lstatSync(path, { bigint: true }))) fail('store-unavailable');
  const raw: unknown = JSON.parse(read.text);
  if (canonicalJson(raw) !== read.text) fail('store-unavailable');
  return raw;
}
function writeFile(root: string, name: string, value: unknown): void {
  const bytes = canonicalJson(value); if (Buffer.byteLength(bytes) > MAX_BYTES) fail('store-unavailable');
  writePrivateFileAtomically(join(root, `.${name}.${randomUUID()}.tmp`), join(root, name), bytes, { anchorPath: root, label: 'Claude API grant store' });
}
function transaction<T>(root: string, change: (ledger: Ledger) => T): T {
  inspectPrivateDirectory(root);
  const lock = acquireLocalStoreLock(join(root, '.claude-api-grants.lock'), 0, { anchorPath: root, exactPrivateStorage: true });
  if (!lock) fail('store-busy');
  try {
    const raw = readFile(root, CLAUDE_API_GRANT_LEDGER_FILE);
    if (raw !== null && !validLedger(raw)) fail('store-unavailable');
    const ledger: Ledger = raw === null ? { v: 1, rows: [], ceilings: [] } : raw;
    const outcome = change(ledger);
    if (!validLedger(ledger) || !ownsLocalStoreLock(lock)) fail('store-unavailable');
    writeFile(root, CLAUDE_API_GRANT_LEDGER_FILE, ledger);
    if (!ownsLocalStoreLock(lock)) fail('store-unavailable');
    return outcome;
  } finally { if (!releaseLocalStoreLock(lock)) fail('store-unavailable'); }
}
function parseObservations(raw: unknown, nowMs: number): ClaudeApiGrantRecordedObservation[] {
  if (raw === null) return [];
  if (!exact(raw, ['v', 'observations']) || raw.v !== 1 || !dense(raw.observations)) fail('store-unavailable');
  const rows = raw.observations.map(value => parseClaudeApiGrantRecordedObservation(value, nowMs));
  if (rows.some(row => row === null) || new Set(rows.map(row => row!.observationId)).size !== rows.length) fail('store-unavailable');
  return rows as ClaudeApiGrantRecordedObservation[];
}
function observations(root: string, nowMs: number): ClaudeApiGrantRecordedObservation[] {
  return parseObservations(readFile(root, CLAUDE_API_GRANT_OBSERVATIONS_FILE), nowMs);
}
export function recordClaudeApiGrantObservation(root: string, value: unknown, nowMs = Date.now()): ClaudeApiGrantResult<void> {
  return result(() => {
    const row = parseClaudeApiGrantRecordedObservation(value, nowMs); if (!row) fail('proof-invalid');
    transaction(root, () => {
      const rows = observations(root, nowMs); const previous = rows.find(r => r.observationId === row.observationId);
      if (previous && !same(previous, row)) fail('proof-invalid');
      if (!previous) rows.push(row);
      if (rows.length > MAX_ROWS) fail('store-unavailable');
      writeFile(root, CLAUDE_API_GRANT_OBSERVATIONS_FILE, { v: 1, observations: rows });
    });
  });
}
function sameSnapshot(a: BigIntStats, b: BigIntStats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.mode === b.mode && a.uid === b.uid && a.gid === b.gid &&
    a.nlink === b.nlink && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
}
/** Async counterpart of stable-file-read's descriptor/path guards, limited to this fixed file. */
async function readObservationsFile(root: string): Promise<unknown | null> {
  // No async DACL witness exists yet; Unix permission bits must not pretend to prove Windows privacy.
  if (process.platform === 'win32' || !isAbsolute(root) || resolve(root) !== root) fail('store-unavailable');
  const before = await lstat(root, { bigint: true });
  if (!before.isDirectory() || before.isSymbolicLink() || (before.mode & 0o777n) !== 0o700n ||
    typeof process.getuid === 'function' && before.uid !== BigInt(process.getuid()) || await realpath(root) !== root) fail('store-unavailable');
  const finishRoot = async () => {
    if (!sameSnapshot(before, await lstat(root, { bigint: true })) || await realpath(root) !== root) fail('store-unavailable');
  };
  const path = join(root, CLAUDE_API_GRANT_OBSERVATIONS_FILE);
  let named: BigIntStats;
  try { named = await lstat(path, { bigint: true }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    await finishRoot(); return null;
  }
  const safe = (stat: BigIntStats) => stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1n &&
    (stat.mode & 0o777n) === 0o600n && stat.size > 0n && stat.size <= BigInt(MAX_BYTES) &&
    (typeof process.getuid !== 'function' || stat.uid === BigInt(process.getuid()));
  if (!safe(named) || await realpath(path) !== path) fail('store-unavailable');
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const opened = await file.stat({ bigint: true });
    if (!safe(opened) || !sameSnapshot(named, opened)) fail('store-unavailable');
    const bytes = Buffer.alloc(Number(opened.size)); let offset = 0;
    while (offset < bytes.length) {
      const read = await file.read(bytes, offset, Math.min(64 * 1024, bytes.length - offset), offset);
      if (read.bytesRead <= 0) fail('store-unavailable'); offset += read.bytesRead;
    }
    if ((await file.read(Buffer.alloc(1), 0, 1, bytes.length)).bytesRead !== 0 ||
      !sameSnapshot(opened, await file.stat({ bigint: true })) || !sameSnapshot(opened, await lstat(path, { bigint: true })) ||
      await realpath(path) !== path) fail('store-unavailable');
    await finishRoot();
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); const raw: unknown = JSON.parse(text);
    if (canonicalJson(raw) !== text) fail('store-unavailable'); return raw;
  } finally { await file.close(); }
}
export async function readClaudeApiGrantObservations(root: string, nowMs = Date.now()): Promise<ClaudeApiGrantResult<ClaudeApiGrantRecordedObservation[]>> {
  try { return { ok: true, value: parseObservations(await readObservationsFile(root), nowMs) }; }
  catch { return { ok: false, reason: 'store-unavailable' }; }
}
/** No account witnesses, probes, credentials, writes or admission in this read-only projection. */
export async function readClaudeApiGrantViews(root: string, nowMs = Date.now()): Promise<ClaudeApiGrantReadView> {
  try {
    const raw = await readObservationsFile(root);
    if (raw === null) return { v: 1, state: 'missing', rows: [] };
    return { v: 1, state: 'healthy', rows: parseObservations(raw, nowMs).map(row => projectClaudeApiGrantView(row, nowMs)) };
  } catch { return { v: 1, state: 'unavailable', rows: [] }; }
}
export function projectClaudeApiGrantView(value: unknown, nowMs = Date.now()): ClaudeApiGrantView {
  const row = parseClaudeApiGrantRecordedObservation(value, nowMs); const cutoff = row ? claudeApiGrantCutoff(row.expiry) : null;
  return { v: 1, state: row ? 'recorded' : value === null ? 'missing' : 'unavailable',
    remainingUsdMicros: row?.remainingUsdMicros ?? null, totalUsdMicros: row?.totalUsdMicros ?? null,
    capturedAt: row?.capturedAt ?? null, expiryDate: row?.expiry.date ?? null,
    admissionCutoff: cutoff?.at ?? null, cutoffPolicy: cutoff?.policy ?? null, automaticAdmission: 'held' };
}
const admissions = new WeakMap<ClaudeApiGrantAdmission, { binding: ClaudeApiGrantBinding; cycleId: string; cutoff: string; authorityDigest: string }>();
const reservations = new WeakMap<ClaudeApiGrantReservation, { root: string; id: string; admission: ClaudeApiGrantAdmission; reader: ReadFreshClaudeApiGrantProof; identity: string }>();
function proof(reader: ReadFreshClaudeApiGrantProof | undefined, nowMs: number): FreshClaudeApiGrantProof {
  if (!reader) fail('proof-missing');
  let raw: unknown; try { raw = reader(); } catch { fail('proof-missing'); }
  if (!exact(raw, ['observation', 'observedAt', 'validUntil', 'funding', 'authority']) ||
    !iso(raw.observedAt) || !iso(raw.validUntil) || !Number.isFinite(nowMs)) fail('proof-invalid');
  const row = parseClaudeApiGrantObservation(raw.observation, nowMs); if (!row) fail('proof-invalid');
  if (Date.parse(raw.observedAt) > nowMs || Date.parse(raw.validUntil) <= nowMs ||
    Date.parse(raw.validUntil) - Date.parse(raw.observedAt) > 60_000 || Date.parse(raw.validUntil) <= Date.parse(raw.observedAt) ||
    Date.parse(row.capturedAt) < Date.parse(raw.observedAt)) fail('proof-stale');
  if (!exact(raw.funding, ['source', 'prepaid', 'invoiced', 'autoReload', 'purchasedUsdMicros', 'otherPaidFunding']) ||
    raw.funding.source !== 'verified-provider-billing' || raw.funding.prepaid !== true || raw.funding.invoiced !== false ||
    raw.funding.autoReload !== 'off' || raw.funding.purchasedUsdMicros !== '0' || raw.funding.otherPaidFunding !== false) fail('funding-unverified');
  if (!exact(raw.authority, ['active', 'stop', 'localOnly', 'engineEnabled', 'repoAuthorized', 'roleAuthorized',
    'meteredCeilingUsdMicros', 'dailyRemainingUsdMicros', 'identityDigest']) || raw.authority.active !== true ||
    raw.authority.stop !== false || raw.authority.localOnly !== false || raw.authority.engineEnabled !== true ||
    raw.authority.repoAuthorized !== true || raw.authority.roleAuthorized !== true || !money(raw.authority.meteredCeilingUsdMicros) ||
    BigInt(raw.authority.meteredCeilingUsdMicros) === 0n || !money(raw.authority.dailyRemainingUsdMicros) ||
    !text(raw.authority.identityDigest, HASH)) fail('authority-held');
  const cutoff = claudeApiGrantCutoff(row.expiry); if (!cutoff) fail('expiry-unknown');
  if (Date.parse(cutoff.at) <= nowMs) fail('cutoff-reached');
  if (!money(row.remainingUsdMicros)) fail('balance-unknown');
  return JSON.parse(canonicalJson(raw)) as FreshClaudeApiGrantProof;
}
function recheck(admission: ClaudeApiGrantAdmission, reader: ReadFreshClaudeApiGrantProof | undefined, nowMs: number): FreshClaudeApiGrantProof {
  const owned = admissions.get(admission); if (!owned) fail('reservation-invalid');
  const current = proof(reader, nowMs); const cutoff = claudeApiGrantCutoff(current.observation.expiry)!;
  if (!same(owned.binding, current.observation.binding) || owned.cycleId !== current.observation.cycleId ||
    owned.authorityDigest !== current.authority.identityDigest || cutoff.at !== owned.cutoff) fail('binding-changed');
  return current;
}
export function createClaudeApiGrantAdmission(options: { readFreshProof?: ReadFreshClaudeApiGrantProof; expectedBinding: ClaudeApiGrantBinding; nowMs?: number }): ClaudeApiGrantResult<ClaudeApiGrantAdmission> {
  return result(() => {
    const current = proof(options.readFreshProof, options.nowMs ?? Date.now());
    if (!binding(options.expectedBinding) || !same(current.observation.binding, options.expectedBinding)) fail('binding-changed');
    const capability: ClaudeApiGrantAdmission = Object.freeze({ kind: 'claude-api-admission' });
    admissions.set(capability, { binding: current.observation.binding, cycleId: current.observation.cycleId,
      cutoff: claudeApiGrantCutoff(current.observation.expiry)!.at, authorityDigest: current.authority.identityDigest });
    return capability;
  });
}
function available(ledger: Ledger, current: FreshClaudeApiGrantProof, excludeId: string | null, nowMs: number): { balance: bigint; daily: bigint } {
  const observation = current.observation; const org = observation.binding.organizationDigest;
  const rows = ledger.rows.filter(row => row.binding.organizationDigest === org && row.id !== excludeId);
  const pending = rows.reduce((sum, row) => sum + BigInt(row.heldUsdMicros), 0n);
  const foreignHolds = rows.filter(row => row.cycleId !== observation.cycleId).reduce((sum, row) => sum + BigInt(row.heldUsdMicros), 0n);
  const booked = rows.filter(row => row.cycleId === observation.cycleId).reduce((sum, row) => sum + BigInt(row.actualUsdMicros ?? row.heldUsdMicros), 0n);
  const ceiling = ledger.ceilings.find(row => row.organizationDigest === org && row.cycleId === observation.cycleId);
  if (ceiling && ceiling.cutoff !== claudeApiGrantCutoff(observation.expiry)!.at) fail('binding-changed');
  const base = ceiling ? BigInt(ceiling.usdMicros) : BigInt(observation.remainingUsdMicros!);
  const fresh = BigInt(observation.remainingUsdMicros!) - pending;
  const original = base - booked - foreignHolds;
  const day = new Date(nowMs).toISOString().slice(0, 10);
  const dayBooked = rows.reduce((sum, row) => sum + (row.createdAt.slice(0, 10) === day ? BigInt(row.actualUsdMicros ?? row.heldUsdMicros) : BigInt(row.heldUsdMicros)), 0n);
  const limit = BigInt(current.authority.meteredCeilingUsdMicros); const remaining = BigInt(current.authority.dailyRemainingUsdMicros!);
  return { balance: fresh < original ? fresh : original, daily: (limit < remaining ? limit : remaining) - dayBooked };
}
export function reserveClaudeApiGrantRequest(options: { root: string; admission: ClaudeApiGrantAdmission; requestId: string; maxUsdMicros: string;
  pricingDigest: string; readFreshProof?: ReadFreshClaudeApiGrantProof; nowMs?: number }): ClaudeApiGrantResult<ClaudeApiGrantReservation> {
  return result(() => transaction(options.root, ledger => {
    const nowMs = options.nowMs ?? Date.now(); const current = recheck(options.admission, options.readFreshProof, nowMs);
    if (!text(options.requestId, ID) || !money(options.maxUsdMicros) || BigInt(options.maxUsdMicros) === 0n || !text(options.pricingDigest, HASH)) fail('reservation-invalid');
    if (ledger.rows.some(row => row.id === options.requestId)) fail('request-recorded');
    const bounds = available(ledger, current, null, nowMs); const cost = BigInt(options.maxUsdMicros);
    if (cost > bounds.balance) fail('balance-exhausted'); if (cost > bounds.daily) fail('daily-limit');
    const observation = current.observation;
    if (!ledger.ceilings.some(row => row.organizationDigest === observation.binding.organizationDigest && row.cycleId === observation.cycleId)) {
      ledger.ceilings.push({ organizationDigest: observation.binding.organizationDigest, cycleId: observation.cycleId, usdMicros: observation.remainingUsdMicros!, cutoff: claudeApiGrantCutoff(observation.expiry)!.at });
    }
    const row: LedgerRow = { id: options.requestId, cycleId: observation.cycleId, binding: observation.binding, pricingDigest: options.pricingDigest,
      maxUsdMicros: options.maxUsdMicros, heldUsdMicros: options.maxUsdMicros, createdAt: new Date(nowMs).toISOString(),
      state: 'reserved', providerRequestId: null, actualUsdMicros: null };
    ledger.rows.push(row);
    const capability: ClaudeApiGrantReservation = Object.freeze({ kind: 'claude-api-reservation' });
    reservations.set(capability, { root: options.root, id: options.requestId, admission: options.admission, reader: options.readFreshProof!, identity: rowIdentity(row) });
    return capability;
  }));
}
function owned(reservation: ClaudeApiGrantReservation): NonNullable<ReturnType<typeof reservations.get>> {
  const value = reservations.get(reservation); if (!value) fail('reservation-invalid'); return value;
}
function rowIdentity(row: LedgerRow): string {
  return canonicalJson({ id: row.id, cycleId: row.cycleId, binding: row.binding, pricingDigest: row.pricingDigest,
    maxUsdMicros: row.maxUsdMicros, createdAt: row.createdAt });
}
function rowOf(ledger: Ledger, token: NonNullable<ReturnType<typeof reservations.get>>): LedgerRow {
  const row = ledger.rows.find(value => value.id === token.id);
  if (!row || rowIdentity(row) !== token.identity) fail('reservation-invalid'); return row;
}
/** Durable possible-contact state BEFORE fetch. Failure must cause zero provider requests. */
export function markClaudeApiGrantRequestSent(reservation: ClaudeApiGrantReservation, nowMs = Date.now()): ClaudeApiGrantResult<void> {
  return result(() => {
    const token = owned(reservation);
    transaction(token.root, ledger => {
      const row = rowOf(ledger, token); if (row.state !== 'reserved') fail('request-not-reserved');
      const current = recheck(token.admission, token.reader, nowMs); const bounds = available(ledger, current, row.id, nowMs);
      if (BigInt(row.maxUsdMicros) > bounds.balance) fail('balance-exhausted');
      if (BigInt(row.maxUsdMicros) > bounds.daily) fail('daily-limit');
      row.state = 'sent';
    });
  });
}
export function releaseClaudeApiGrantBeforeContact(reservation: ClaudeApiGrantReservation): ClaudeApiGrantResult<void> {
  return result(() => { const token = owned(reservation); transaction(token.root, ledger => {
    const row = rowOf(ledger, token); if (row.state !== 'reserved') fail('request-not-reserved'); row.state = 'released'; row.heldUsdMicros = '0';
  }); });
}
export function retainClaudeApiGrantUnknown(reservation: ClaudeApiGrantReservation): ClaudeApiGrantResult<void> {
  return result(() => { const token = owned(reservation); transaction(token.root, ledger => {
    const row = rowOf(ledger, token); if (!['sent', 'unknown'].includes(row.state)) fail('request-not-reserved'); row.state = 'unknown';
  }); });
}
export function settleClaudeApiGrantRequest(reservation: ClaudeApiGrantReservation, providerRequestId: string, actualUsdMicros: string): ClaudeApiGrantResult<void> {
  return result(() => {
    const token = owned(reservation); let overrun = false;
    transaction(token.root, ledger => {
      const row = rowOf(ledger, token);
      if (!text(providerRequestId, MESSAGE_ID) || !money(actualUsdMicros) || ledger.rows.some(r => r.id !== row.id && r.providerRequestId === providerRequestId)) fail('settlement-invalid');
      if (row.providerRequestId !== null && (row.providerRequestId !== providerRequestId ||
        row.state === 'unknown' && BigInt(actualUsdMicros) < BigInt(row.heldUsdMicros))) fail('settlement-invalid');
      if (row.state === 'settled') { if (row.providerRequestId !== providerRequestId || row.actualUsdMicros !== actualUsdMicros) fail('settlement-invalid'); return; }
      if (!['sent', 'unknown'].includes(row.state)) fail('request-not-reserved');
      if (BigInt(actualUsdMicros) > BigInt(row.maxUsdMicros)) {
        row.state = 'unknown'; row.providerRequestId = providerRequestId; row.heldUsdMicros = (BigInt(actualUsdMicros) > BigInt(row.heldUsdMicros) ? actualUsdMicros : row.heldUsdMicros); overrun = true; return;
      }
      row.state = 'settled'; row.actualUsdMicros = actualUsdMicros; row.providerRequestId = providerRequestId; row.heldUsdMicros = '0';
    });
    if (overrun) fail('cost-exceeds-reservation');
  });
}
