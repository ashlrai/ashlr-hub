/** Private manager messages remain in the existing chat log, including its archive. */
import { createHash } from 'node:crypto';
import { lstatSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readStableRegularFile } from '../util/stable-file-read.js';
import { VERSE_MAX_TURN_TEXT_BYTES, type VerseEvent, type VerseManagerMessageReference } from './types.js';

const token = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value);
const outcome = (value: unknown): value is string => typeof value === 'string' && /^[a-z0-9](?:[a-z0-9._-]{0,78}[a-z0-9])?$/.test(value);
const hash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const exact = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
type ManagerEvent = Extract<VerseEvent, { type: 'manager-message' | 'manager-result' }>;

/** Strict for these new records; historical native events retain their existing parser. */
export function isPersistedManagerEvent(value: unknown): value is ManagerEvent {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const event = value as Record<string, unknown>;
  if (!Number.isSafeInteger(event.seq) || Number(event.seq) < 1 || typeof event.at !== 'string' ||
      !Number.isFinite(Date.parse(event.at)) || event.turnId !== null || !outcome(event.outcomeId) || typeof event.text !== 'string') return false;
  if (event.type === 'manager-message') return exact(event, ['seq', 'at', 'type', 'turnId', 'outcomeId', 'messageId', 'text']) &&
    token(event.messageId) && !!event.text.trim() && Buffer.byteLength(event.text, 'utf8') <= VERSE_MAX_TURN_TEXT_BYTES;
  return event.type === 'manager-result' && exact(event, ['seq', 'at', 'type', 'turnId', 'outcomeId', 'stageId', 'runId', 'attemptId',
    'seatId', 'model', 'engine', 'resultDigest', 'text']) && hash(event.stageId) && event.attemptId === event.stageId &&
    token(event.runId) && hash(event.resultDigest) && createHash('sha256').update(event.text).digest('hex') === event.resultDigest && ['seatId', 'model', 'engine'].every(key => typeof event[key] === 'string' &&
      (event[key] as string).length > 0 && (event[key] as string).length <= 256 && ![...(event[key] as string)].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127));
}

/** Complete private source read for idempotent message/result lookup, including archived records. */
export function readStoredManagerEvents(sessionId: string, root = join(homedir(), '.ashlr', 'verse')): ManagerEvent[] | null {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(sessionId)) return null;
  const found = new Map<number, ManagerEvent>();
  // File admission bounds are not a stage/message count or provider token budget.
  const maxFileBytes = 32 * 1024 * 1024;
  let remainingBytes = maxFileBytes * 2;
  for (const suffix of ['.events.archive.jsonl', '.events.jsonl']) {
    const path = join(root, 'sessions', `${sessionId}${suffix}`);
    try { lstatSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; return null; }
    const read = readStableRegularFile(path, { anchorPath: root, maxFileBytes, remainingBytes });
    if (!read.ok) return null;
    remainingBytes -= read.bytesRead;
    for (const line of read.text.split('\n')) {
      if (!line.trim()) continue;
      let raw: unknown;
      try { raw = JSON.parse(line); } catch { return null; }
      const type = (raw as { type?: unknown } | null)?.type;
      if (type !== 'manager-message' && type !== 'manager-result') continue;
      if (!isPersistedManagerEvent(raw)) return null;
      const prior = found.get(raw.seq);
      // Archive-before-rewrite can leave an identical record in both files.
      if (prior && JSON.stringify(prior) !== JSON.stringify(raw)) return null;
      found.set(raw.seq, raw);
    }
  }
  return [...found.values()].sort((a, b) => a.seq - b.seq);
}

/** Complete exact references or unknown. This reader never creates or repairs a file. */
export function readOutcomeManagerConversation(
  sessionId: string, outcomeId: string, refs: readonly VerseManagerMessageReference[], root = join(homedir(), '.ashlr', 'verse'),
): Array<{ messageId: string; eventSeq: number; text: string }> | null {
  if (!outcome(outcomeId) || !Array.isArray(refs)) return null;
  let previous = 0;
  const ids = new Set<string>();
  for (const ref of refs) {
    if (!ref || ref.sessionId !== sessionId || !token(ref.messageId) || !Number.isSafeInteger(ref.eventSeq) ||
        ref.eventSeq <= previous || ids.has(ref.messageId)) return null;
    previous = ref.eventSeq; ids.add(ref.messageId);
  }
  const events = readStoredManagerEvents(sessionId, root);
  if (!events) return null;
  const bySeq = new Map(events.map(event => [event.seq, event]));
  const result: Array<{ messageId: string; eventSeq: number; text: string }> = [];
  for (const ref of refs) {
    const event = bySeq.get(ref.eventSeq);
    if (!event || event.type !== 'manager-message' || event.outcomeId !== outcomeId || event.messageId !== ref.messageId) return null;
    result.push({ messageId: ref.messageId, eventSeq: ref.eventSeq, text: event.text });
  }
  return result;
}
