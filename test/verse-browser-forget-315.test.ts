/**
 * 3.15 integration: deleting a chat revokes its Browser-pane grant. The grant is the MCP
 * endpoint's only credential (POST /api/verse/browser/mcp/<grant>), and the bridge kept
 * every chat's state for the life of the server, so a deleted chat's grant stayed valid.
 * The engine's onSessionDeleted hook (verse-api.ts verseTurnHooks) now calls
 * forgetBrowserChat — with checkpoints on or off.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  browserPolicy,
  browserSeatLaunch,
  claimBrowserCommands,
  forgetBrowserChat,
  resetBrowserBridgeForTest,
  runBrowserCommand,
  sessionForBrowserGrant,
  setBrowserAgentAccess,
} from '../src/core/verse/browser-bridge.js';
import { verseTurnHooks } from '../src/core/verse/verse-api.js';

const SIDECAR = 'http://127.0.0.1:7777';

function grantOf(sessionId: string): string {
  const launch = browserSeatLaunch(sessionId)!;
  return JSON.parse(launch.mcpConfig).mcpServers['ashlr-browser'].url.split('/').pop();
}

beforeEach(() => resetBrowserBridgeForTest());
afterEach(() => resetBrowserBridgeForTest());

describe('forgetBrowserChat', () => {
  it('revokes the grant, fails waiting commands, releases the pane poll, and leaves other chats alone', async () => {
    setBrowserAgentAccess('s1', true, SIDECAR);
    setBrowserAgentAccess('s2', true, SIDECAR);
    const g1 = grantOf('s1');
    const g2 = grantOf('s2');

    // The pane is polling; one command is claimed (in flight) and the pane polls again.
    const poll = claimBrowserCommands('s1', { waitMs: 10_000 });
    const inflight = runBrowserCommand('s1', 'read');
    expect(await poll).toHaveLength(1);
    const idlePoll = claimBrowserCommands('s1', { waitMs: 10_000 });

    forgetBrowserChat('s1');
    expect(sessionForBrowserGrant(g1)).toBeNull();
    expect(browserSeatLaunch('s1')).toBeNull();
    expect(browserPolicy('s1').agentAccess).toBe(false);
    expect(await inflight).toMatchObject({ ok: false, code: 'access-off' });
    await expect(idlePoll).resolves.toEqual([]);

    // A command queued while no pane poll is waiting fails too.
    claimBrowserCommands('s2', { waitMs: 0 }); // marks the pane present, returns at once
    const queued = runBrowserCommand('s2', 'read');
    forgetBrowserChat('s2');
    expect(await queued).toMatchObject({ ok: false, code: 'access-off' });
    expect(sessionForBrowserGrant(g2)).toBeNull();

    setBrowserAgentAccess('s3', true, SIDECAR);
    expect(sessionForBrowserGrant(grantOf('s3'))).toBe('s3');
    forgetBrowserChat('s1'); // idempotent
    forgetBrowserChat('never-seen');
  });
});

describe('verseTurnHooks().onSessionDeleted', () => {
  it.each([
    ['checkpoints off', { ASHLR_VERSE_CHECKPOINTS: '0' }],
    ['checkpoints on', {}],
  ])('revokes the deleted chat\'s browser grant (%s)', async (_label, env) => {
    setBrowserAgentAccess('gone', true, SIDECAR);
    const grant = grantOf('gone');
    const hooks = verseTurnHooks(env as NodeJS.ProcessEnv);
    expect(typeof hooks.onSessionDeleted).toBe('function');
    await hooks.onSessionDeleted!({ sessionId: 'gone', roots: [] });
    expect(sessionForBrowserGrant(grant)).toBeNull();
  });

  it('keeps the checkpoint hooks only when checkpoints are on', () => {
    expect(verseTurnHooks({ ASHLR_VERSE_CHECKPOINTS: '0' } as NodeJS.ProcessEnv).beforeTurn).toBeUndefined();
    expect(typeof verseTurnHooks({} as NodeJS.ProcessEnv).beforeTurn).toBe('function');
  });
});
