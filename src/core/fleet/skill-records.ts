/**
 * Append-only metadata ledgers for verified skill cards and their use events.
 *
 * Rows live under ~/.ashlr/skills/ (or $ASHLR_HOME/skills). The schemas are
 * explicit allowlists: raw prompts, diffs, stdout/stderr, env, file contents,
 * argv, command output, and unknown fields are never persisted or returned.
 */

import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  existsSync,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  writeSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type {
  SkillCard,
  SkillCardSource,
  SkillCardStatus,
  SkillCardVerification,
  SkillUseEvent,
  SkillUseMode,
  SkillUseOutcome,
  SkillUseStage,
} from '../types.js';
import { causalMetadata } from '../learning/causal.js';
import { scrubSecrets } from '../util/scrub.js';

const DATE_LEDGER_FILE_RE = /^(\d{4}-\d{2}-\d{2})\.jsonl$/;
const DEFAULT_READ_LIMIT = 100;
const MAX_READ_LIMIT = 1000;
const DEFAULT_MAX_FILES = 14;
const MAX_READ_FILES = 31;
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const MAX_LIST_ITEMS = 16;
const PRIVATE_DIR_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const MAX_FUTURE_SKEW_MS = 24 * 60 * 60 * 1000;
const SHA256_HEX_RE = /^[a-f0-9]{64}$/;

const CARD_STATUSES = new Set<SkillCardStatus>(['candidate', 'verified', 'deprecated', 'revoked']);
const CARD_SOURCES = new Set<SkillCardSource>(['verified-proposal', 'manual', 'imported']);
const USE_MODES = new Set<SkillUseMode>(['shadow', 'active', 'disabled']);
const USE_STAGES = new Set<SkillUseStage>(['selected', 'injected', 'applied', 'outcome']);
const USE_OUTCOMES = new Set<SkillUseOutcome>([
  'unknown',
  'verified',
  'merged',
  'rejected',
  'reverted',
  'followed-up',
  'failed',
  'skipped',
]);

const MAX_TEXT = {
  id: 240,
  name: 120,
  summary: 480,
  reason: 240,
  tag: 64,
  kind: 80,
  version: 80,
  hash: 160,
  risk: 40,
};

export interface ReadSkillRecordsOptions {
  sinceMs?: number;
  limit?: number;
  maxFiles?: number;
}

type SkillCausalInput = Pick<
  SkillCard | SkillUseEvent,
  | 'ts'
  | 'proposalId'
  | 'runId'
  | 'trajectoryId'
  | 'routeSnapshot'
  | 'runEventSummary'
  | 'evidenceOutcome'
  | 'learningSource'
  | 'labelBasis'
  | 'routerPolicyVersion'
  | 'learningEpoch'
>;

export function skillRecordsDir(): string {
  const configuredHome = process.env.ASHLR_HOME;
  const root =
    typeof configuredHome === 'string' && configuredHome.trim() !== ''
      ? configuredHome
      : join(homedir(), '.ashlr');
  return join(root, 'skills');
}

export function skillCardsDir(): string {
  return join(skillRecordsDir(), 'cards');
}

export function skillUseEventsDir(): string {
  return join(skillRecordsDir(), 'uses');
}

/** Alias matching the ~/.ashlr/skills directory name. */
export const skillsDir = skillRecordsDir;

function eventTimestamp(value: unknown): string {
  const parsed = typeof value === 'string' ? Date.parse(value) : NaN;
  if (!Number.isFinite(parsed)) throw new Error('invalid skill record timestamp');
  if (parsed > Date.now() + MAX_FUTURE_SKEW_MS) throw new Error('future-dated skill record timestamp');
  return new Date(parsed).toISOString();
}

function eventDateString(ts: string): string {
  return eventTimestamp(ts).slice(0, 10);
}

function replaceControlCharacters(value: string): string {
  let out = '';
  for (const character of value) {
    const code = character.charCodeAt(0);
    out += (code <= 8 || (code >= 11 && code <= 12) || (code >= 14 && code <= 31) || code === 127)
      ? ' '
      : character;
  }
  return out;
}

function scrubMetadataText(value: string): string {
  const scrubbed = scrubSecrets(value)
    .replace(
      /\bRAW_[A-Z0-9_]*(?:PROMPT|DIFF|STDOUT|STDERR|ENV|FILE_CONTENTS?|ARGV|COMMAND_OUTPUT)[A-Z0-9_]*\b/g,
      '[REDACTED]',
    )
    .replace(
      /\b(raw\s+)?(prompts?|diffs?|stdout|stderr|env(?:ironment)?|file\s+contents?|argv|command\s+output)\b\s*(?:contained|included|was|=|:)\s*[^,;}\]]+/gi,
      (_match, rawPrefix: string | undefined, label: string) => `${rawPrefix ?? ''}${label}=[REDACTED]`,
    )
    .replace(/\bdiff --git\b[^,;}\]]*/gi, '[REDACTED]');
  return replaceControlCharacters(scrubbed)
    .replace(/\s+/g, ' ')
    .trim();
}

function boundedText(value: unknown, max: number, fallback = ''): string {
  if (typeof value !== 'string') return fallback;
  const text = scrubMetadataText(value);
  const chosen = text || fallback;
  return chosen.length > max ? `${chosen.slice(0, max - 3)}...` : chosen;
}

function boundedOptionalText(value: unknown, max: number): string | undefined {
  const text = boundedText(value, max);
  return text || undefined;
}

function canonicalDigest(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const digest = value.trim().toLowerCase();
  return SHA256_HEX_RE.test(digest) ? digest : undefined;
}

function requiredText(value: unknown, max: number, field: string): string {
  const text = boundedOptionalText(value, max);
  if (!text) throw new Error(`invalid skill record ${field}`);
  return text;
}

function boundedTextList(value: unknown, maxItems: number, maxChars: number): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: string[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    const text = boundedOptionalText(entry, maxChars);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
    if (out.length >= maxItems) break;
  }
  return out.length > 0 ? out : undefined;
}

function sanitizeMetadataValues<T>(value: T): T {
  if (typeof value === 'string') return scrubMetadataText(value) as T;
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map((entry) => sanitizeMetadataValues(entry)) as T;
  if (typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (entry !== undefined) out[key] = sanitizeMetadataValues(entry);
  }
  return out as T;
}

function enumValue<T extends string>(value: unknown, allowed: ReadonlySet<T>, fallback: T): T {
  return typeof value === 'string' && allowed.has(value as T) ? value as T : fallback;
}

function optionalEnumValue<T extends string>(value: unknown, allowed: ReadonlySet<T>): T | undefined {
  return typeof value === 'string' && allowed.has(value as T) ? value as T : undefined;
}

function nonNegativeInteger(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.trunc(value)))
    : fallback;
}

function optionalNonNegativeInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.trunc(value)))
    : undefined;
}

function optionalScore(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, Math.min(1, Math.round(value * 1000) / 1000))
    : undefined;
}

function optionalTimestamp(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const scrubbed = boundedOptionalText(value, MAX_TEXT.version);
  if (!scrubbed) return undefined;
  const parsed = Date.parse(scrubbed);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined;
}

function sanitizeVerification(value: unknown): SkillCardVerification | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const input = value as Record<string, unknown>;
  const verifiedAt = optionalTimestamp(input['verifiedAt']);
  const commandKinds = boundedTextList(input['commandKinds'], 12, MAX_TEXT.kind);
  const diffHash = canonicalDigest(input['diffHash']);
  const riskClass = boundedOptionalText(input['riskClass'], MAX_TEXT.risk);
  const evidenceCount = optionalNonNegativeInteger(input['evidenceCount']);
  return {
    passed: input['passed'] === true,
    ...(verifiedAt ? { verifiedAt } : {}),
    ...(commandKinds ? { commandKinds } : {}),
    ...(diffHash ? { diffHash } : {}),
    ...(riskClass ? { riskClass } : {}),
    ...(evidenceCount !== undefined ? { evidenceCount } : {}),
  };
}

function sanitizedCausal(input: SkillCausalInput): Omit<SkillCausalInput, 'ts' | 'proposalId' | 'runId'> {
  const causal = sanitizeMetadataValues(causalMetadata({
    ts: input.ts,
    proposalId: boundedOptionalText(input.proposalId, MAX_TEXT.id),
    runId: boundedOptionalText(input.runId, MAX_TEXT.id),
    trajectoryId: boundedOptionalText(input.trajectoryId, MAX_TEXT.id),
    routeSnapshot: input.routeSnapshot,
    runEventSummary: input.runEventSummary,
    evidenceOutcome: input.evidenceOutcome,
    learningSource: input.learningSource,
    labelBasis: input.labelBasis,
    routerPolicyVersion: input.routerPolicyVersion,
    learningEpoch: input.learningEpoch,
  }));
  return {
    ...(causal.trajectoryId ? { trajectoryId: causal.trajectoryId } : {}),
    ...(causal.routeSnapshot ? { routeSnapshot: causal.routeSnapshot } : {}),
    ...(causal.runEventSummary ? { runEventSummary: causal.runEventSummary } : {}),
    ...(causal.evidenceOutcome ? { evidenceOutcome: causal.evidenceOutcome } : {}),
    ...(causal.learningSource ? { learningSource: causal.learningSource } : {}),
    ...(causal.labelBasis ? { labelBasis: causal.labelBasis } : {}),
    ...(causal.routerPolicyVersion ? { routerPolicyVersion: causal.routerPolicyVersion } : {}),
    learningEpoch: causal.learningEpoch,
  } as Omit<SkillCausalInput, 'ts' | 'proposalId' | 'runId'>;
}

export function sanitizeSkillCard(card: SkillCard): SkillCard {
  const ts = eventTimestamp(card.ts);
  const proposalId = boundedOptionalText(card.proposalId, MAX_TEXT.id);
  const runId = boundedOptionalText(card.runId, MAX_TEXT.id);
  const tags = boundedTextList(card.tags, MAX_LIST_ITEMS, MAX_TEXT.tag);
  const taskKinds = boundedTextList(card.taskKinds, MAX_LIST_ITEMS, MAX_TEXT.kind);
  const commandKinds = boundedTextList(card.commandKinds, 12, MAX_TEXT.kind);
  const verification = sanitizeVerification(card.verification);
  const contentHash = canonicalDigest(card.contentHash);
  const attestation = canonicalDigest(card.attestation);
  return {
    schemaVersion: 1,
    skillId: requiredText(card.skillId, MAX_TEXT.id, 'skillId'),
    revision: Math.max(1, nonNegativeInteger(card.revision, 1)),
    ts,
    name: requiredText(card.name, MAX_TEXT.name, 'name'),
    summary: boundedText(card.summary, MAX_TEXT.summary),
    status: enumValue(card.status, CARD_STATUSES, 'candidate'),
    source: enumValue(card.source, CARD_SOURCES, 'manual'),
    ...(tags ? { tags } : {}),
    ...(taskKinds ? { taskKinds } : {}),
    ...(commandKinds ? { commandKinds } : {}),
    ...(verification ? { verification } : {}),
    ...(contentHash ? { contentHash } : {}),
    ...(attestation ? { attestation } : {}),
    ...(proposalId ? { proposalId } : {}),
    ...(runId ? { runId } : {}),
    ...sanitizedCausal(card),
  };
}

export function sanitizeSkillUseEvent(event: SkillUseEvent): SkillUseEvent {
  const ts = eventTimestamp(event.ts);
  const proposalId = boundedOptionalText(event.proposalId, MAX_TEXT.id);
  const runId = boundedOptionalText(event.runId, MAX_TEXT.id);
  const outcome = optionalEnumValue(event.outcome, USE_OUTCOMES);
  const rank = optionalNonNegativeInteger(event.rank);
  const score = optionalScore(event.score);
  const reason = boundedOptionalText(event.reason, MAX_TEXT.reason);
  const contentHash = canonicalDigest(event.contentHash);
  const selectedAt = event.selectedAt ? eventTimestamp(event.selectedAt) : undefined;
  const skillPolicyVersion = boundedOptionalText(event.skillPolicyVersion, MAX_TEXT.version);
  const trajectoryId = boundedOptionalText(event.trajectoryId, MAX_TEXT.id);
  const hasStrongIdentity = Boolean(
    proposalId ||
    runId ||
    (trajectoryId && !trajectoryId.startsWith('work:')),
  );
  if (!contentHash || !selectedAt || !skillPolicyVersion || !hasStrongIdentity) {
    throw new Error('skill use event lacks signed snapshot or strong attempt identity');
  }
  return {
    schemaVersion: 1,
    eventId: requiredText(event.eventId, MAX_TEXT.id, 'eventId'),
    ts,
    skillId: requiredText(event.skillId, MAX_TEXT.id, 'skillId'),
    skillRevision: Math.max(1, nonNegativeInteger(event.skillRevision, 1)),
    ...(contentHash ? { contentHash } : {}),
    ...(selectedAt ? { selectedAt } : {}),
    ...(skillPolicyVersion ? { skillPolicyVersion } : {}),
    mode: enumValue(event.mode, USE_MODES, 'disabled'),
    stage: enumValue(event.stage, USE_STAGES, 'selected'),
    ...(outcome ? { outcome } : {}),
    ...(rank !== undefined ? { rank } : {}),
    ...(score !== undefined ? { score } : {}),
    ...(reason ? { reason } : {}),
    ...(proposalId ? { proposalId } : {}),
    ...(runId ? { runId } : {}),
    ...sanitizedCausal(event),
  };
}

function isSkillCard(value: unknown): value is SkillCard {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const card = value as Record<string, unknown>;
  return card['schemaVersion'] === 1
    && typeof card['skillId'] === 'string'
    && typeof card['revision'] === 'number'
    && typeof card['ts'] === 'string'
    && typeof card['name'] === 'string'
    && typeof card['summary'] === 'string'
    && typeof card['status'] === 'string'
    && CARD_STATUSES.has(card['status'] as SkillCardStatus)
    && typeof card['source'] === 'string'
    && CARD_SOURCES.has(card['source'] as SkillCardSource);
}

function isSkillUseEvent(value: unknown): value is SkillUseEvent {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const event = value as Record<string, unknown>;
  return event['schemaVersion'] === 1
    && typeof event['eventId'] === 'string'
    && typeof event['ts'] === 'string'
    && typeof event['skillId'] === 'string'
    && typeof event['skillRevision'] === 'number'
    && typeof event['mode'] === 'string'
    && USE_MODES.has(event['mode'] as SkillUseMode)
    && typeof event['stage'] === 'string'
    && USE_STAGES.has(event['stage'] as SkillUseStage);
}

function appendRecords<T extends { ts: string }>(
  input: T | T[],
  dir: string,
  sanitize: (record: T) => T,
): void {
  try {
    const records: T[] = [];
    for (const rawRecord of Array.isArray(input) ? input : [input]) {
      try {
        records.push(sanitize(rawRecord));
      } catch {
        // A hostile or malformed record must not suppress valid batch siblings.
      }
    }
    if (records.length === 0) return;
    ensurePrivateSkillDirectory(dir);
    const byDate = new Map<string, T[]>();
    for (const record of records) {
      const date = eventDateString(record.ts);
      byDate.set(date, [...(byDate.get(date) ?? []), record]);
    }
    for (const [date, rows] of byDate) {
      for (const row of rows) {
        appendPrivateFile(join(dir, `${date}.jsonl`), `${JSON.stringify(row)}\n`);
      }
    }
  } catch {
    // Skill history must never disrupt the caller.
  }
}

function ownedByCurrentUser(uid: number): boolean {
  return typeof process.getuid !== 'function' || uid === process.getuid();
}

function permissionsArePrivate(mode: number): boolean {
  return process.platform === 'win32' || (mode & 0o077) === 0;
}

function ensurePrivateSkillDirectory(dir: string): void {
  for (const candidate of [skillRecordsDir(), dir]) {
    if (!existsSync(candidate)) mkdirSync(candidate, { recursive: true, mode: PRIVATE_DIR_MODE });
    const stat = lstatSync(candidate);
    if (stat.isSymbolicLink() || !stat.isDirectory() || !ownedByCurrentUser(stat.uid)) {
      throw new Error('unsafe skill ledger directory');
    }
    chmodSync(candidate, PRIVATE_DIR_MODE);
  }
}

function appendPrivateFile(filePath: string, contents: string): void {
  let fd: number | undefined;
  try {
    if (existsSync(filePath)) {
      const before = lstatSync(filePath);
      if (before.isSymbolicLink() || !before.isFile() || !ownedByCurrentUser(before.uid)) {
        throw new Error('unsafe skill ledger file');
      }
    }
    fd = openSync(
      filePath,
      fsConstants.O_APPEND | fsConstants.O_CREAT | fsConstants.O_RDWR | fsConstants.O_NOFOLLOW,
      PRIVATE_FILE_MODE,
    );
    const opened = fstatSync(fd);
    if (!opened.isFile() || !ownedByCurrentUser(opened.uid)) throw new Error('unsafe skill ledger file');
    fchmodSync(fd, PRIVATE_FILE_MODE);
    if (opened.size > 0) {
      const tail = Buffer.alloc(1);
      const read = readSync(fd, tail, 0, 1, opened.size - 1);
      if (read === 1 && tail[0] !== 0x0a) writeSync(fd, '\n', undefined, 'utf8');
    }
    writeSync(fd, contents, undefined, 'utf8');
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export function recordSkillCard(input: SkillCard | SkillCard[]): void {
  appendRecords(input, skillCardsDir(), sanitizeSkillCard);
}

export function recordSkillUseEvent(input: SkillUseEvent | SkillUseEvent[]): void {
  appendRecords(input, skillUseEventsDir(), sanitizeSkillUseEvent);
}

/** Append aliases for callers that name the storage operation directly. */
export const appendSkillCard = recordSkillCard;
export const appendSkillUseEvent = recordSkillUseEvent;

function boundedOption(value: number | undefined, fallback: number, max: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(1, Math.min(max, Math.floor(value)))
    : fallback;
}

function readFileTail(filePath: string): string | null {
  let fd: number | undefined;
  try {
    const before = lstatSync(filePath);
    if (
      before.isSymbolicLink() ||
      !before.isFile() ||
      !ownedByCurrentUser(before.uid) ||
      !permissionsArePrivate(before.mode)
    ) return null;
    const size = before.size;
    if (size <= 0) return '';
    const bytes = Math.min(size, MAX_FILE_BYTES);
    const start = Math.max(0, size - bytes);
    const buffer = Buffer.alloc(bytes);
    fd = openSync(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const opened = fstatSync(fd);
    if (!opened.isFile() || !ownedByCurrentUser(opened.uid) || !permissionsArePrivate(opened.mode)) return null;
    const read = readSync(fd, buffer, 0, bytes, start);
    let text = buffer.subarray(0, read).toString('utf8');
    if (start > 0) {
      const firstNewline = text.indexOf('\n');
      text = firstNewline >= 0 ? text.slice(firstNewline + 1) : '';
    }
    return text;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // Ignore close failures on best-effort reads.
      }
    }
  }
}

function fileMayContainSince(file: string, sinceMs: number): boolean {
  const match = DATE_LEDGER_FILE_RE.exec(file);
  if (!match) return false;
  const endOfDayMs = Date.parse(`${match[1]}T23:59:59.999Z`);
  return !Number.isFinite(endOfDayMs) || endOfDayMs >= sinceMs;
}

function fileIsNotFutureDated(file: string): boolean {
  const match = DATE_LEDGER_FILE_RE.exec(file);
  if (!match) return false;
  const startOfDayMs = Date.parse(`${match[1]}T00:00:00.000Z`);
  return Number.isFinite(startOfDayMs) && startOfDayMs <= Date.now() + MAX_FUTURE_SKEW_MS;
}

function readRecords<T>(
  dir: string,
  guard: (value: unknown) => value is T,
  sanitize: (record: T) => T,
  opts: ReadSkillRecordsOptions,
): T[] {
  const limit = boundedOption(opts.limit, DEFAULT_READ_LIMIT, MAX_READ_LIMIT);
  const maxFiles = boundedOption(opts.maxFiles, DEFAULT_MAX_FILES, MAX_READ_FILES);
  const sinceMs = typeof opts.sinceMs === 'number' && Number.isFinite(opts.sinceMs)
    ? opts.sinceMs
    : undefined;
  try {
    if (!existsSync(dir)) return [];
    const dirStat = lstatSync(dir);
    if (
      dirStat.isSymbolicLink() ||
      !dirStat.isDirectory() ||
      !ownedByCurrentUser(dirStat.uid) ||
      !permissionsArePrivate(dirStat.mode)
    ) return [];
    const files = readdirSync(dir)
      .filter((file) => DATE_LEDGER_FILE_RE.test(file) && fileIsNotFutureDated(file))
      .sort()
      .reverse()
      .slice(0, maxFiles);
    const out: T[] = [];
    for (const file of files) {
      if (out.length >= limit) break;
      if (sinceMs !== undefined && !fileMayContainSince(file, sinceMs)) continue;
      const raw = readFileTail(join(dir, file));
      if (raw === null) continue;
      for (const line of raw.split('\n').reverse()) {
        if (out.length >= limit) break;
        if (!line.trim()) continue;
        try {
          const parsed: unknown = JSON.parse(line);
          if (!guard(parsed)) continue;
          const record = sanitize(parsed);
          if (sinceMs !== undefined) {
            const recordMs = Date.parse((record as { ts: string }).ts);
            if (Number.isFinite(recordMs) && recordMs < sinceMs) continue;
          }
          out.push(record);
        } catch {
          // Malformed rows do not poison the remaining append-only history.
        }
      }
    }
    return out;
  } catch {
    return [];
  }
}

export function readSkillCards(opts: ReadSkillRecordsOptions = {}): SkillCard[] {
  return readRecords(skillCardsDir(), isSkillCard, sanitizeSkillCard, opts);
}

export function readSkillUseEvents(opts: ReadSkillRecordsOptions = {}): SkillUseEvent[] {
  const requested = boundedOption(opts.limit, DEFAULT_READ_LIMIT, MAX_READ_LIMIT);
  const scanned = readRecords(skillUseEventsDir(), isSkillUseEvent, sanitizeSkillUseEvent, {
    ...opts,
    limit: Math.min(MAX_READ_LIMIT, Math.max(requested, requested * 4)),
  });
  const byEventId = new Map<string, {
    fingerprint: string;
    event: SkillUseEvent;
    conflict: boolean;
  }>();
  for (const event of scanned) {
    const fingerprint = JSON.stringify(event);
    const existing = byEventId.get(event.eventId);
    if (!existing) {
      byEventId.set(event.eventId, { fingerprint, event, conflict: false });
    } else if (existing.fingerprint !== fingerprint) {
      existing.conflict = true;
    }
  }
  return [...byEventId.values()]
    .filter((entry) => !entry.conflict)
    .map((entry) => entry.event)
    .slice(0, requested);
}
