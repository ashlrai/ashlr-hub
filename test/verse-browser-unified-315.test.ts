import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { browserMcpDepsFor } from '../src/core/verse/browser-api.js';
import {
  browserPolicy,
  canDispatchBrowserCommand,
  claimBrowserCommands,
  completeBrowserCommand,
  resetBrowserBridgeForTest,
  runBrowserCommand,
  setBrowserOriginAllowed,
} from '../src/core/verse/browser-bridge.js';
import { tools } from '../src/core/verse/verse-mcp-browser-act-adapter.js';
import {
  mintVerseMcpTurn,
  resetVerseMcpGrantsForTest,
  revokeVerseMcpTurn,
  setAgentToolsGrant,
  turnForBearer,
} from '../src/core/verse/verse-mcp-grants.js';
import type { VerseMcpToolContext } from '../src/core/verse/verse-mcp.js';

const SIDECAR = 'http://127.0.0.1:7777';
const SESSION = 's1';

beforeEach(() => { resetBrowserBridgeForTest(); resetVerseMcpGrantsForTest(); });
afterEach(() => { resetBrowserBridgeForTest(); resetVerseMcpGrantsForTest(); });

function turnContext(): VerseMcpToolContext {
  const credential = mintVerseMcpTurn(SESSION, 'claude')!;
  const turn = turnForBearer(credential.token)!;
  return {
    sessionId: SESSION,
    engine: turn.engine,
    signal: turn.signal,
    versePort: 7777,
    desktop: true,
    confirm: async () => 'deny',
    record: () => 'unused',
    settle: () => {},
    untrusted: (_label, body) => body,
    markRemoteRead: turn.markRemoteRead,
    remoteRead: turn.remoteRead,
    browser: browserMcpDepsFor(7777),
  };
}

function browserTool(name: string) {
  const tool = tools.find((entry) => entry.name === name);
  expect(tool).toBeDefined();
  return tool!;
}

describe('the unified bearer-per-turn browser adapter', () => {
  it('requires act scope for tab mutations and history while leaving tab listing in look scope', async () => {
    setAgentToolsGrant(SESSION, { browser: 'look' }, SIDECAR);
    const ctx = turnContext();
    const newTab = await browserTool('browser_tabs').handler({ action: 'new', url: 'http://localhost:5173/' }, ctx);
    expect(newTab.isError).toBe(true);
    const back = await browserTool('browser_back').handler({}, ctx);
    expect(back.isError).toBe(true);
    expect(await claimBrowserCommands(SESSION, { waitMs: 0 })).toEqual([]);
  });

  it('refuses a remote tab mutation under act-localhost even when that origin is allowed for reading', async () => {
    setAgentToolsGrant(SESSION, { browser: 'act-localhost' }, SIDECAR);
    setBrowserOriginAllowed(SESSION, 'https://example.com', true);
    const ctx = turnContext();
    const result = await browserTool('browser_tabs').handler({ action: 'new', url: 'https://example.com/' }, ctx);
    expect(result.isError).toBe(true);
    expect(await claimBrowserCommands(SESSION, { waitMs: 0 })).toEqual([]);
  });

  it('revoking the turn during a confirmation cannot add a chat allowance or dispatch the tab mutation', async () => {
    setAgentToolsGrant(SESSION, { browser: 'act-localhost' }, SIDECAR);
    const ctx = turnContext();
    ctx.markRemoteRead();
    await claimBrowserCommands(SESSION, { waitMs: 0 });
    const pending = browserTool('browser_tabs').handler({ action: 'new', url: 'http://localhost:5173/' }, ctx);
    const [confirmation] = await claimBrowserCommands(SESSION, { waitMs: 0 });
    expect(confirmation?.op).toBe('confirm');
    revokeVerseMcpTurn(SESSION, 'turn ended');
    expect(completeBrowserCommand(SESSION, { id: confirmation!.id, ok: true, data: { decision: 'chat' } })).toBe(false);
    expect((await pending).isError).toBe(true);
    expect(browserPolicy(SESSION).allowances).toEqual([]);
    expect(await claimBrowserCommands(SESSION, { waitMs: 0 })).toEqual([]);
    const next = turnContext();
    expect(next.remoteRead()).toBe(false);
    expect(browserPolicy(SESSION).allowances).toEqual([]);
  });

  it('narrowing act-allowed to localhost cancels a claimed remote command', async () => {
    setAgentToolsGrant(SESSION, { browser: 'act-allowed' }, SIDECAR);
    setBrowserOriginAllowed(SESSION, 'https://example.com', true);
    const ctx = turnContext();
    await claimBrowserCommands(SESSION, { waitMs: 0 });
    const pending = runBrowserCommand(SESSION, 'act', { args: { kind: 'click' } }, {
      signal: ctx.signal,
      authorize: () => !ctx.signal.aborted,
    });
    const [command] = await claimBrowserCommands(SESSION, { waitMs: 0 });
    expect(canDispatchBrowserCommand(SESSION, command!.id)).toBe(true);
    setAgentToolsGrant(SESSION, { browser: 'act-localhost' }, SIDECAR);
    expect(canDispatchBrowserCommand(SESSION, command!.id)).toBe(false);
    expect(await pending).toMatchObject({ ok: false, code: 'access-off' });
  });
});
