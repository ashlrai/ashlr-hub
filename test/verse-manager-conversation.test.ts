import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createVerseEngine, type VerseEngineHandle } from '../src/core/verse/session-engine.js';
import { createVerseSessionStore, readOutcomeManagerSessionMetadata } from '../src/core/verse/session-store.js';
import { readOutcomeManagerConversation, readStoredManagerEvents } from '../src/core/verse/manager-conversation.js';
import { managerSessionTargetsMatch, resolveManagerSessionTargets } from '../src/core/verse/manager-scope.js';
import { resetRepoIdentityCache } from '../src/core/fleet/repo-identity.js';
import type { VerseSeat } from '../src/core/verse/types.js';

let home: string;
let root: string;
let repo: string;
let engine: VerseEngineHandle;
const seat: VerseSeat = { id: 'test-seat', engine: 'codex', label: 'Test seat', accountId: 'test-account',
  models: [{ id: 'test-model', label: 'Test model', contextWindow: null }], contextWindow: null,
  health: { state: 'unknown', summary: null, windows: [], observedAt: null } };
const stageId = 'a'.repeat(64);
const reply = 'Actual fixture result';
const result = { runId: 'registered-run', attemptId: stageId, text: reply, seatId: 'selected-seat',
  engine: 'codex', model: 'test-model', resultDigest: createHash('sha256').update(reply).digest('hex') };
let admitted: boolean;
let actualResult: typeof result | null;
beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'manager-chat-')));
  vi.stubEnv('HOME', home); vi.stubEnv('USERPROFILE', home);
  root = join(home, 'verse'); repo = join(home, 'primary'); mkdirSync(repo);
  admitted = true; actualResult = result;
  engine = createVerseEngine({ root, readiness: null, preflight: null, reasoningTap: null, processRegistry: false,
    managerSessionReader: input => admitted && input.roots.length === 1 && input.roots[0] === repo,
    managerResultReader: () => actualResult });
  resetRepoIdentityCache();
});
afterEach(() => { engine.close(); resetRepoIdentityCache(); vi.unstubAllEnvs(); rmSync(home, { recursive: true, force: true }); });
function session() { return engine.createSession({ projectPath: repo, seatId: seat.id }, { seat, launcher: ['never-launch-this-test'], ollamaBaseUrl: 'http://127.0.0.1:11434' }); }
const message = (text = 'Inspect the current work') => ({ outcomeId: 'chat-outcome', messageId: 'message-1', text });

describe('durable manager conversation', () => {
  it('records interjections without a native child, status, turn count or orphan recovery', async () => {
    const chat = session();
    const ref = await engine.recordManagerMessage!(chat.id, message());
    expect(ref).toMatchObject({ sessionId: chat.id, messageId: 'message-1' });
    expect(engine.getSession(chat.id)).toMatchObject({ status: 'idle', turnCount: 0 });
    expect(engine.getEvents(chat.id).map(event => event.type)).toEqual(['manager-message']);
    engine.close(); engine = createVerseEngine({ root, reasoningTap: null, processRegistry: false });
    expect(engine.getEvents(chat.id).some(event => event.type === 'error' || event.type === 'turn-done')).toBe(false);
    expect(readOutcomeManagerSessionMetadata(chat.id, root)).toMatchObject({ id: chat.id, roots: [repo], seatId: seat.id });
  });
  it('replays exact message and result once across real archive compaction and restart', async () => {
    const chat = session();
    const ref = await engine.recordManagerMessage!(chat.id, message());
    await engine.recordManagerResult!(chat.id, { outcomeId: 'chat-outcome', stageId });
    await engine.recordManagerMessage!(chat.id, { ...message('Follow up'), messageId: 'message-2' });
    const store = createVerseSessionStore(root);
    const compact = store.compactEvents(chat.id, { cap: 2 }); store.close();
    expect(compact.archived).toBeGreaterThan(0);
    expect(readOutcomeManagerConversation(chat.id, 'chat-outcome', [ref], root)).toEqual([{ messageId: ref.messageId, eventSeq: ref.eventSeq, text: message().text }]);
    engine.close(); engine = createVerseEngine({ root, reasoningTap: null, processRegistry: false,
      managerSessionReader: () => true, managerResultReader: () => result });
    expect(await engine.recordManagerMessage!(chat.id, message())).toEqual(ref);
    expect(await engine.recordManagerResult!(chat.id, { outcomeId: 'chat-outcome', stageId })).toMatchObject({ runId: result.runId });
    const all = readStoredManagerEvents(chat.id, root)!;
    expect(all.filter(event => event.type === 'manager-message')).toHaveLength(2);
    expect(all.filter(event => event.type === 'manager-result')).toHaveLength(1);
  });
  it('refuses conflicting message IDs and mismatched references, and holds a changed association', async () => {
    const chat = session(); const ref = await engine.recordManagerMessage!(chat.id, message());
    await expect(engine.recordManagerMessage!(chat.id, message('Different request'))).rejects.toThrow('different content');
    expect(readOutcomeManagerConversation(chat.id, 'other-outcome', [ref], root)).toBeNull();
    expect(readOutcomeManagerConversation(chat.id, 'chat-outcome', [{ ...ref, eventSeq: ref.eventSeq + 1 }], root)).toBeNull();
    admitted = false;
    await expect(engine.recordManagerMessage!(chat.id, { ...message(), messageId: 'new-message' })).rejects.toThrow('not active');
    expect(await engine.recordManagerResult!(chat.id, { outcomeId: 'chat-outcome', stageId })).toBeNull();
  });
  it('never publishes missing or malformed host results or accepts caller-authored reply fields', async () => {
    const chat = session(); actualResult = null;
    expect(await engine.recordManagerResult!(chat.id, { outcomeId: 'chat-outcome', stageId })).toBeNull();
    await expect(engine.recordManagerResult!(chat.id, { outcomeId: 'chat-outcome', stageId, text: 'fake' } as never)).rejects.toThrow('malformed');
    actualResult = { ...result, attemptId: 'different-stage' };
    await expect(engine.recordManagerResult!(chat.id, { outcomeId: 'chat-outcome', stageId })).rejects.toThrow('malformed');
    expect(engine.getEvents(chat.id).some(event => event.type === 'manager-result')).toBe(false);
  });
  it('holds ambiguous archive bytes and symlinks without rewriting source history', async () => {
    const chat = session(); const ref = await engine.recordManagerMessage!(chat.id, message());
    const path = join(root, 'sessions', `${chat.id}.events.jsonl`);
    const before = readFileSync(path);
    appendFileSync(path, JSON.stringify({ ...engine.getEvents(chat.id).at(-1), text: 'conflict' }) + '\n');
    expect(readOutcomeManagerConversation(chat.id, 'chat-outcome', [ref], root)).toBeNull();
    writeFileSync(path, before, { mode: 0o600 });
    const archive = join(root, 'sessions', `${chat.id}.events.archive.jsonl`);
    symlinkSync(path, archive);
    expect(readStoredManagerEvents(chat.id, root)).toBeNull();
    expect(readFileSync(path)).toEqual(before);
  });
  it('propagates append failure instead of acknowledging an unsaved interjection', async () => {
    const chat = session();
    const original = join(root, 'sessions'); const moved = join(root, 'old-sessions');
    // The engine holds the existing session, but the required event destination is unavailable.
    const { renameSync } = await import('node:fs'); renameSync(original, moved);
    writeFileSync(original, 'not a directory');
    await expect(engine.recordManagerMessage!(chat.id, message())).rejects.toThrow();
    expect(readFileSync(original, 'utf8')).toBe('not a directory');
  });
});

describe('unique enrolled manager scope', () => {
  it('maps a primary GitHub checkout to its exact enrolled fleet mirror, not another ordinary checkout', () => {
    mkdirSync(join(repo, '.git')); writeFileSync(join(repo, '.git', 'config'), '[remote "origin"]\nurl = https://github.com/example/project.git\n');
    const mirror = join(home, '.ashlr', 'fleet', 'mirrors', 'example__project'); mkdirSync(mirror, { recursive: true });
    expect(resolveManagerSessionTargets([repo], [mirror])).toEqual([mirror]);
    expect(managerSessionTargetsMatch([repo], [mirror], [mirror])).toBe(true);
    const other = join(home, 'another-checkout'); mkdirSync(join(other, '.git'), { recursive: true });
    writeFileSync(join(other, '.git', 'config'), readFileSync(join(repo, '.git', 'config')));
    expect(resolveManagerSessionTargets([repo], [other])).toBeNull();
    expect(resolveManagerSessionTargets([repo], [repo, mirror])).toBeNull();
    expect(managerSessionTargetsMatch([repo], [mirror], [mirror, other])).toBe(false);
  });
  it('requires every canonical root to resolve uniquely and fails closed for missing targets', () => {
    expect(resolveManagerSessionTargets([repo], [repo])).toEqual([repo]);
    expect(resolveManagerSessionTargets([], [repo])).toBeNull();
    expect(resolveManagerSessionTargets([repo, repo], [repo])).toBeNull();
    expect(resolveManagerSessionTargets([repo], [join(home, 'missing')])).toBeNull();
    expect(resolveManagerSessionTargets([repo], [repo, repo])).toBeNull();
  });
});
