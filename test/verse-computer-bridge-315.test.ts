/**
 * 3.15 desktop control — the sidecar relay and grant store
 * (computer-bridge.ts): the "Verse window present" invariant, the operator's
 * access decision (clamped to what was offered and to each app's ceiling),
 * confirmation answers, KILL / revoke / chat deletion, the per-turn taint and
 * the turn's abort signal. Pure state: no server, no desktop.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  COMPUTER_CLAIM_TIMEOUT_MS,
  COMPUTER_WINDOW_STALE_MS,
  anyComputerGrant,
  applyComputerAccessDecision,
  claimComputerCommands,
  completeComputerCommand,
  computerAllowedForChat,
  computerGrantsFor,
  computerState,
  computerTurnReadUntrusted,
  computerWindowPresent,
  effectiveComputerTier,
  endComputerTurn,
  forgetComputerChat,
  killComputer,
  markComputerWindowSeenForTest,
  noteComputerUntrustedRead,
  resetComputerBridgeForTest,
  revokeComputerGrants,
  runComputerCommand,
  setComputerBridgeClockForTest,
} from '../src/core/verse/computer-bridge.js';
import type { VerseComputerAccessApp } from '../src/core/verse/computer-types.js';
import { verseTurnHooks } from '../src/core/verse/verse-api.js';

let tmpHome: string;
let prevHome: string | undefined;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-computer-bridge-home-'));
  prevHome = process.env.HOME;
  process.env.HOME = tmpHome;
  resetComputerBridgeForTest();
});

afterEach(() => {
  vi.useRealTimers();
  resetComputerBridgeForTest();
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

const offer = (bundleId: string, name: string, tier: VerseComputerAccessApp['tier']): VerseComputerAccessApp => ({
  bundleId, name, tier, category: tier === null ? 'denied' : 'other', reason: 'r', running: true,
});

async function grantNotes(sessionId = 's-1'): Promise<void> {
  markComputerWindowSeenForTest();
  const asked = runComputerCommand(sessionId, { kind: 'access', apps: [offer('com.apple.Notes', 'Notes', 'full')], reason: 'x' });
  const [command] = await claimComputerCommands({ waitMs: 0 });
  expect(completeComputerCommand({ id: command!.id, ok: true, data: { approved: [{ bundleId: 'com.apple.Notes', tier: 'full' }] } })).toBe(true);
  await asked;
}

describe('the Verse window invariant', () => {
  it('fails at once when no window has polled', async () => {
    expect(computerWindowPresent()).toBe(false);
    const outcome = await runComputerCommand('s-1', { kind: 'native', op: { op: 'list-apps' } });
    expect(outcome).toMatchObject({ ok: false, code: 'window-not-open' });
  });

  it('a poll marks the window present until it goes stale', async () => {
    let now = 1_000_000;
    setComputerBridgeClockForTest(() => now);
    await claimComputerCommands({ waitMs: 0 });
    expect(computerWindowPresent()).toBe(true);
    now += COMPUTER_WINDOW_STALE_MS + 1;
    expect(computerWindowPresent()).toBe(false);
  });

  it('a command nobody claims fails as "window not open"', async () => {
    vi.useFakeTimers();
    markComputerWindowSeenForTest();
    const pending = runComputerCommand('s-1', { kind: 'native', op: { op: 'list-apps' } });
    await vi.advanceTimersByTimeAsync(COMPUTER_CLAIM_TIMEOUT_MS + 1);
    expect(await pending).toMatchObject({ ok: false, code: 'window-not-open' });
  });
});

describe('the relay', () => {
  it('a long-poll is woken by a new command, which carries its id as native req', async () => {
    markComputerWindowSeenForTest();
    const poll = claimComputerCommands({ waitMs: 10_000 });
    const pending = runComputerCommand('s-1', { kind: 'native', op: { op: 'list-apps' } });
    const [command] = await poll;
    expect(command).toMatchObject({ sessionId: 's-1', kind: 'native' });
    expect(command!.id).toMatch(/^cc_[A-Za-z0-9_-]{12}$/);
    expect(command!.kind === 'native' && command!.op).toMatchObject({ op: 'list-apps', req: command!.id });
    expect(completeComputerCommand({ id: command!.id, ok: true, data: { apps: [] } })).toBe(true);
    expect(await pending).toEqual({ ok: true, data: { apps: [] } });
    // Late or unknown answers are refused.
    expect(completeComputerCommand({ id: command!.id, ok: true })).toBe(false);
  });

  it('native failures keep their code; unknown codes become failed', async () => {
    markComputerWindowSeenForTest();
    const a = runComputerCommand('s-1', { kind: 'native', op: { op: 'list-apps' } });
    const b = runComputerCommand('s-1', { kind: 'native', op: { op: 'list-apps' } });
    const [ca, cb] = await claimComputerCommands({ waitMs: 0 });
    completeComputerCommand({ id: ca!.id, ok: false, code: 'operator-took-over', error: 'took over' });
    completeComputerCommand({ id: cb!.id, ok: false, code: 'weird' as never, error: '' });
    expect(await a).toEqual({ ok: false, code: 'operator-took-over', message: 'took over' });
    expect(await b).toMatchObject({ ok: false, code: 'failed' });
  });

  it('the turn\'s abort signal fails a waiting command at once', async () => {
    markComputerWindowSeenForTest();
    const controller = new AbortController();
    const pending = runComputerCommand('s-1', { kind: 'native', op: { op: 'list-apps' } }, { signal: controller.signal });
    controller.abort();
    expect(await pending).toMatchObject({ ok: false, code: 'stopped' });
    expect(await claimComputerCommands({ waitMs: 0 })).toEqual([]);
    const aborted = new AbortController();
    aborted.abort();
    expect(await runComputerCommand('s-1', { kind: 'native', op: { op: 'list-apps' } }, { signal: aborted.signal })).toMatchObject({ code: 'stopped' });
  });
});

describe('grants', () => {
  it('the access answer grants only what was offered, never above the offer or the ceiling', () => {
    const offered = [
      offer('com.apple.Notes', 'Notes', 'full'),
      offer('com.apple.Safari', 'Safari', 'read'),
      offer('com.apple.Terminal', 'Terminal', 'click'),
      offer('com.1password.1password', '1Password', null),
    ];
    const made = applyComputerAccessDecision('s-1', offered, [
      { bundleId: 'com.apple.Notes', tier: 'full' },
      { bundleId: 'com.apple.Safari', tier: 'full' }, // above the offer → read
      { bundleId: 'com.apple.Terminal', tier: 'full' }, // above the ceiling → click
      { bundleId: 'com.1password.1password', tier: 'full' }, // denied → dropped
      { bundleId: 'com.apple.Calendar', tier: 'full' }, // never offered → dropped
      { bundleId: 'com.apple.Notes', tier: 'root' }, // not a tier → dropped
      'garbage',
    ]);
    expect(made.map((g) => [g.bundleId, g.tier])).toEqual([
      ['com.apple.Notes', 'full'], ['com.apple.Safari', 'read'], ['com.apple.Terminal', 'click'],
    ]);
    expect(computerGrantsFor('s-1')).toEqual([
      { bundleId: 'com.apple.Notes', tier: 'full' }, { bundleId: 'com.apple.Safari', tier: 'read' }, { bundleId: 'com.apple.Terminal', tier: 'click' },
    ]);
    expect(effectiveComputerTier('s-1', 'com.apple.notes')).toBe('full');
    expect(effectiveComputerTier('s-2', 'com.apple.Notes')).toBeNull();
    expect(applyComputerAccessDecision('s-1', offered, 'nope')).toEqual([]);
  });

  it('an access answer through the relay makes the grant before the tool call resolves', async () => {
    await grantNotes();
    expect(computerGrantsFor('s-1')).toEqual([{ bundleId: 'com.apple.Notes', tier: 'full' }]);
    expect(anyComputerGrant()).toBe(true);
    expect(computerState().chats).toEqual([expect.objectContaining({ sessionId: 's-1', grants: [expect.objectContaining({ name: 'Notes', tier: 'full' })] })]);
  });

  it('a declined sheet grants nothing', async () => {
    markComputerWindowSeenForTest();
    const asked = runComputerCommand('s-1', { kind: 'access', apps: [offer('com.apple.Notes', 'Notes', 'full')], reason: 'x' });
    const [command] = await claimComputerCommands({ waitMs: 0 });
    completeComputerCommand({ id: command!.id, ok: false, error: 'The operator declined.' });
    expect(await asked).toMatchObject({ ok: false, code: 'declined' });
    expect(computerGrantsFor('s-1')).toEqual([]);
  });

  it('confirm "chat" waives that reason for the chat; anything unknown is deny', async () => {
    markComputerWindowSeenForTest();
    const confirm = { action: 'click' as const, app: 'Mail', label: 'Send', reason: 'sensitive-label' as const, summary: 'click "Send" in Mail' };
    const a = runComputerCommand('s-1', { kind: 'confirm', confirm });
    const b = runComputerCommand('s-1', { kind: 'confirm', confirm });
    const [ca, cb] = await claimComputerCommands({ waitMs: 0 });
    completeComputerCommand({ id: ca!.id, ok: true, data: { decision: 'chat' } });
    completeComputerCommand({ id: cb!.id, ok: true, data: { decision: 'sure!' } });
    expect(await a).toEqual({ ok: true, data: { decision: 'chat' } });
    expect(await b).toEqual({ ok: true, data: { decision: 'deny' } });
    expect([...computerAllowedForChat('s-1')]).toEqual(['sensitive-label']);
  });

  it('KILL revokes every grant of every chat and fails everything waiting', async () => {
    await grantNotes('s-1');
    await grantNotes('s-2');
    const waiting = runComputerCommand('s-2', { kind: 'native', op: { op: 'list-apps' } });
    const state = killComputer();
    expect(state.chats).toEqual([]);
    expect(anyComputerGrant()).toBe(false);
    expect(await waiting).toMatchObject({ ok: false, code: 'stopped' });
  });

  it('revoke drops one app or a whole chat', async () => {
    await grantNotes('s-1');
    applyComputerAccessDecision('s-1', [offer('com.apple.TextEdit', 'TextEdit', 'full')], [{ bundleId: 'com.apple.TextEdit', tier: 'full' }]);
    revokeComputerGrants('s-1', 'com.apple.notes');
    expect(computerGrantsFor('s-1')).toEqual([{ bundleId: 'com.apple.TextEdit', tier: 'full' }]);
    revokeComputerGrants('s-1');
    expect(computerGrantsFor('s-1')).toEqual([]);
  });

  it('a deleted chat loses its grants and its waiting commands (the engine hook)', async () => {
    await grantNotes('gone');
    const waiting = runComputerCommand('gone', { kind: 'native', op: { op: 'list-apps' } });
    for (const env of [{ ASHLR_VERSE_CHECKPOINTS: '0' }, {}]) {
      const hooks = verseTurnHooks(env as NodeJS.ProcessEnv);
      await hooks.onSessionDeleted!({ sessionId: 'gone', roots: [] });
    }
    expect(computerGrantsFor('gone')).toEqual([]);
    expect(await waiting).toMatchObject({ ok: false, code: 'not-granted' });
    forgetComputerChat('gone'); // idempotent
  });
});

describe('the per-turn taint', () => {
  it('is set by an untrusted read and cleared when the turn ends', async () => {
    expect(computerTurnReadUntrusted('s-1')).toBe(false);
    noteComputerUntrustedRead('s-1');
    expect(computerTurnReadUntrusted('s-1')).toBe(true);
    endComputerTurn('s-1');
    expect(computerTurnReadUntrusted('s-1')).toBe(false);
  });

  it('the engine\'s afterTurn hook clears it, with or without checkpoints — and checkpoints-off still gates no spawn', async () => {
    const off = verseTurnHooks({ ASHLR_VERSE_CHECKPOINTS: '0' } as NodeJS.ProcessEnv);
    expect(off.beforeTurn).toBeUndefined();
    noteComputerUntrustedRead('s-1');
    await off.afterTurn!({ sessionId: 's-1', turnId: 't', roots: [], outcome: 'ok' });
    expect(computerTurnReadUntrusted('s-1')).toBe(false);
  });
});
