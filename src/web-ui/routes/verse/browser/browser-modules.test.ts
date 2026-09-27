/**
 * The Browser pane's pure modules: the address bar, the tab model, the
 * geometry handed to the native webview, the native bridge's feature test,
 * the send-to-chat payload, and the agent runner's gate.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { VerseBrowserAgentCommand } from '../../../../core/verse/browser-types.js';
import { executeAgentCommand, versePortOf, type BrowserExecutor } from './agent-runner.js';
import { SEARCH_URL, parseBrowserAddress, shortAddress } from './browser-address.js';
import { frameRect, isUsableRect, stepZoom, zoomLabel } from './browser-geometry.js';
import { MAX_BROWSER_TABS, activeTab, browserTabsReducer, initialTabsState, restoreTabs, serializeTabs } from './browser-tabs.js';
import { NATIVE_BROWSER_EVENT, nativeBrowser, nativeRequest, parseNativeBrowserEvent } from './native-browser.js';
import { base64Bytes, buildSendToChatText, fence, screenshotName, sendCaptureToChat } from './send-to-chat.js';

const VERSE = 'http://127.0.0.1:7777';

describe('the address bar', () => {
  it('expands shorthands and classifies loopback / frameable', () => {
    expect(parseBrowserAddress('5173', VERSE)).toEqual({ kind: 'url', url: 'http://localhost:5173/', loopback: true, frameable: true });
    expect(parseBrowserAddress(':3000', VERSE)).toMatchObject({ url: 'http://localhost:3000/' });
    expect(parseBrowserAddress('localhost:3000/admin?x=1', VERSE)).toMatchObject({ url: 'http://localhost:3000/admin?x=1', frameable: true });
    expect(parseBrowserAddress('app.localhost:4000', VERSE)).toMatchObject({ url: 'http://app.localhost:4000/', loopback: true, frameable: false });
    expect(parseBrowserAddress('https://localhost:8443', VERSE)).toMatchObject({ loopback: true, frameable: false });
    expect(parseBrowserAddress('example.com/docs', VERSE)).toEqual({ kind: 'url', url: 'https://example.com/docs', loopback: false, frameable: false });
  });

  it('searches for words, refuses other schemes, credentials and Verse itself', () => {
    expect(parseBrowserAddress('react useEffect cleanup', VERSE)).toMatchObject({ kind: 'url', url: `${SEARCH_URL}react%20useEffect%20cleanup` });
    for (const bad of ['javascript:alert(1)', 'file:///etc/passwd', 'data:text/html,x', 'ftp://example.com/']) {
      expect([bad, parseBrowserAddress(bad, VERSE).kind]).toEqual([bad, 'invalid']);
    }
    expect(parseBrowserAddress('http://u:p@localhost:3000', VERSE).kind).toBe('invalid');
    expect(parseBrowserAddress('7777', VERSE).kind).toBe('self');
    expect(parseBrowserAddress('http://localhost:7777/verse/', VERSE).kind).toBe('self');
    expect(parseBrowserAddress('', VERSE).kind).toBe('invalid');
    expect(shortAddress('http://localhost:5173/admin?x=1')).toBe('localhost:5173/admin?x=1');
  });
});

describe('tabs', () => {
  it('opens, navigates with history, steps and closes', () => {
    let s = initialTabsState();
    s = browserTabsReducer(s, { type: 'navigate', id: 't1', url: 'http://localhost:1/' });
    s = browserTabsReducer(s, { type: 'navigate', id: 't1', url: 'http://localhost:2/' });
    expect(activeTab(s)).toMatchObject({ url: 'http://localhost:2/', index: 1, loading: true });
    s = browserTabsReducer(s, { type: 'step', id: 't1', delta: -1 });
    expect(activeTab(s).url).toBe('http://localhost:1/');
    s = browserTabsReducer(s, { type: 'native-nav', id: 't1', url: 'http://localhost:1/', loading: false });
    expect(activeTab(s).loading).toBe(false);
    s = browserTabsReducer(s, { type: 'native-nav', id: 't1', url: 'http://localhost:1/redirected', loading: false });
    expect(activeTab(s)).toMatchObject({ url: 'http://localhost:1/redirected', history: ['http://localhost:1/', 'http://localhost:1/redirected'] });
    s = browserTabsReducer(s, { type: 'new-tab' });
    expect(s.activeId).toBe('t2');
    s = browserTabsReducer(s, { type: 'close', id: 't2' });
    expect(s.activeId).toBe('t1');
    s = browserTabsReducer(s, { type: 'close', id: 't1' });
    expect(s.tabs).toHaveLength(1);
    expect(activeTab(s).url).toBeNull();
  });

  it('caps tabs, and restores only well-formed saved tabs', () => {
    let s = initialTabsState();
    for (let i = 0; i < 20; i++) s = browserTabsReducer(s, { type: 'new-tab' });
    expect(s.tabs).toHaveLength(MAX_BROWSER_TABS);
    const saved = serializeTabs(browserTabsReducer(initialTabsState(), { type: 'navigate', id: 't1', url: 'http://localhost:5173/' }));
    expect(restoreTabs(saved)).toMatchObject({ activeId: 't1', nextId: 2, tabs: [{ id: 't1', url: 'http://localhost:5173/', loading: false }] });
    expect(restoreTabs('{"tabs":[{"id":"x/../1","url":"javascript:1"},{"id":"t9","url":"javascript:alert(1)"}]}').tabs).toEqual([
      expect.objectContaining({ id: 't9', url: null }),
    ]);
    expect(restoreTabs('garbage')).toEqual(initialTabsState());
    expect(restoreTabs(null)).toEqual(initialTabsState());
  });
});

describe('geometry', () => {
  const stage = { x: 100, y: 50, width: 900, height: 600 };
  it('fills, or centres a device preset clipped to the stage', () => {
    expect(frameRect(stage, 'fill')).toEqual(stage);
    expect(frameRect(stage, 'mobile')).toEqual({ x: 355, y: 50, width: 390, height: 600 });
    expect(frameRect(stage, 'desktop')).toEqual({ x: 100, y: 50, width: 900, height: 600 });
    expect(frameRect({ x: 0.4, y: 0.6, width: 10.2, height: 10.2 }, 'fill')).toEqual({ x: 0, y: 1, width: 11, height: 10 });
    expect(isUsableRect({ x: 0, y: 0, width: 10, height: 500 })).toBe(false);
  });
  it('steps zoom through fixed levels', () => {
    expect(stepZoom(1, 1)).toBe(1.1);
    expect(stepZoom(0.5, -1)).toBe(0.5);
    expect(stepZoom(2, 1)).toBe(2);
    expect(stepZoom(1.33, 1)).toBe(1);
    expect(zoomLabel(1.25)).toBe('125%');
  });
});

describe('the native bridge (feature-detected)', () => {
  afterEach(() => {
    delete (window as unknown as { __ASHLR_DESKTOP__?: unknown }).__ASHLR_DESKTOP__;
  });

  it('is null in a browser tab and on an older shell without the browser contract', () => {
    expect(nativeBrowser()).toBeNull();
    (window as unknown as { __ASHLR_DESKTOP__: unknown }).__ASHLR_DESKTOP__ = { shell: 'tauri', reportTheme: () => {} };
    expect(nativeBrowser()).toBeNull();
    (window as unknown as { __ASHLR_DESKTOP__: unknown }).__ASHLR_DESKTOP__ = { browser: { version: 0, send: () => true } };
    expect(nativeBrowser()).toBeNull();
  });

  it('is present on a v1 shell, and a request resolves on its result event', async () => {
    const sent: unknown[] = [];
    (window as unknown as { __ASHLR_DESKTOP__: unknown }).__ASHLR_DESKTOP__ = {
      browser: { version: 1, capabilities: { screenshot: false }, send: (m: unknown) => { sent.push(m); return true; } },
    };
    const bridge = nativeBrowser()!;
    expect(bridge.capabilities).toEqual({ screenshot: false, picker: true, console: true, text: true });
    const pending = nativeRequest(bridge, (req) => ({ op: 'query', tab: 't1', req, what: 'info' }));
    const req = (sent[0] as { req: string }).req;
    window.dispatchEvent(new CustomEvent(NATIVE_BROWSER_EVENT, { detail: { kind: 'result', req, ok: true, data: { url: 'http://localhost:1/' } } }));
    await expect(pending).resolves.toEqual({ url: 'http://localhost:1/' });
    const failing = nativeRequest(bridge, (r) => ({ op: 'screenshot', tab: 't1', req: r }));
    const req2 = (sent[1] as { req: string }).req;
    window.dispatchEvent(new CustomEvent(NATIVE_BROWSER_EVENT, { detail: { kind: 'result', req: req2, ok: false, error: 'unsupported' } }));
    await expect(failing).rejects.toThrow(/cannot do that on this platform/);
  });

  it('times out, and refuses when the shell refuses the send', async () => {
    vi.useFakeTimers();
    try {
      const bridge = { version: 1, capabilities: { screenshot: true, picker: true, console: true, text: true }, send: () => true };
      const pending = nativeRequest(bridge, (req) => ({ op: 'query', tab: 't1', req, what: 'text' }), 1_000);
      vi.advanceTimersByTime(1_001);
      await expect(pending).rejects.toThrow(/did not answer/);
      await expect(nativeRequest({ ...bridge, send: () => false }, (req) => ({ op: 'query', tab: 't1', req, what: 'text' }))).rejects.toThrow(/refused/);
    } finally {
      vi.useRealTimers();
    }
  });

  it('drops malformed events', () => {
    expect(parseNativeBrowserEvent({ kind: 'nav', tab: 't1' })).toBeNull();
    expect(parseNativeBrowserEvent({ kind: 'weird' })).toBeNull();
    expect(parseNativeBrowserEvent(null)).toBeNull();
    expect(parseNativeBrowserEvent({ kind: 'title', tab: 't1', title: 'x'.repeat(500) })).toMatchObject({ title: 'x'.repeat(300) });
  });
});

describe('send to chat', () => {
  it('fences page content so it cannot close the fence', () => {
    expect(fence('a ``` b')).toBe('````\na ``` b\n````');
    expect(fence('plain', 'html')).toBe('```html\nplain\n```');
  });

  it('builds the draft: where, the screenshot ref, the element, the logs, the notes', () => {
    const text = buildSendToChatText({
      url: 'http://localhost:5173/settings',
      title: 'Settings',
      element: { selector: '#save', html: '<button id="save">Save</button>' },
      console: [{ t: 0, level: 'error', text: 'boom' }],
      network: [{ t: 0, method: 'POST', url: 'http://localhost:5173/api', status: 500 }],
      notes: ['the screenshot could not be attached'],
    }, '@~/.ashlr/verse/attachments/s-1/abcd1234-shot.png');
    expect(text).toContain('From the Browser pane: “Settings” — http://localhost:5173/settings');
    expect(text).toContain('Screenshot: @~/.ashlr/verse/attachments/s-1/abcd1234-shot.png');
    expect(text).toContain('Selected element `#save`:\n```html\n<button id="save">Save</button>\n```');
    expect(text).toContain('ERROR boom');
    expect(text).toContain('500 POST http://localhost:5173/api');
    expect(text).toContain('(the screenshot could not be attached)');
  });

  it('uploads the screenshot as an attachment, then drafts (never sends)', async () => {
    const attach = vi.fn(async () => ({ id: 'a1', sessionId: 's-1', name: 'x.png', mime: 'image/png', bytes: 3, ref: '@/tmp/a/x.png', createdAt: 'now' }));
    const insert = vi.fn((_sessionId: string, _text: string) => true);
    const result = await sendCaptureToChat('s-1', { url: 'http://localhost:5173/', title: null, screenshot: { mime: 'image/png', base64: 'AAAA', width: 1, height: 1 } },
      { attach, insert, now: () => new Date('2026-09-27T10:15:00Z') });
    expect(result).toEqual({ ok: true, attached: true });
    expect(attach).toHaveBeenCalledWith('s-1', { name: 'browser-localhost-5173-20260927-101500.png', mime: 'image/png', dataBase64: 'AAAA' });
    expect(insert.mock.calls[0]![1]).toContain('Screenshot: @/tmp/a/x.png');
  });

  it('screenshot fallback: a failed or oversized upload still drafts the rest, with a note', async () => {
    const insert = vi.fn((_sessionId: string, _text: string) => true);
    const failed = await sendCaptureToChat('s-1', { url: 'http://localhost:1/', title: null, screenshot: { mime: 'image/png', base64: 'AAAA', width: null, height: null } },
      { attach: async () => { throw new Error('HTTP 413'); }, insert, now: () => new Date() });
    expect(failed).toEqual({ ok: true, attached: false });
    expect(insert.mock.calls[0]![1]).toContain('(the screenshot could not be attached)');
    const huge = 'A'.repeat(12 * 1024 * 1024);
    expect(base64Bytes(huge)).toBeGreaterThan(8 * 1024 * 1024);
    const attach = vi.fn();
    await sendCaptureToChat('s-1', { url: null, title: null, screenshot: { mime: 'image/png', base64: huge, width: null, height: null } }, { attach, insert, now: () => new Date() });
    expect(attach).not.toHaveBeenCalled();
    expect(insert.mock.calls[1]![1]).toContain('larger than 8 MB');
  });

  it('a missing composer is reported, not swallowed; a locked token is rethrown for the gate', async () => {
    expect(await sendCaptureToChat('s-1', { url: null, title: null }, { attach: vi.fn(), insert: () => false, now: () => new Date() }))
      .toMatchObject({ ok: false });
    const locked = Object.assign(new Error('locked'), { name: 'VerseMutationLockedError' });
    await expect(sendCaptureToChat('s-1', { url: null, title: null, screenshot: { mime: 'image/png', base64: 'AA==', width: null, height: null } },
      { attach: async () => { throw locked; }, insert: () => true, now: () => new Date() })).rejects.toBe(locked);
    expect(screenshotName('not a url', 'image/jpeg', new Date('2026-01-02T03:04:05Z'))).toBe('browser-page-20260102-030405.jpg');
  });
});

describe('the agent runner re-applies the gate in the pane', () => {
  function executor(over: Partial<BrowserExecutor> & { url?: string | null } = {}): BrowserExecutor & { calls: string[] } {
    const calls: string[] = [];
    return {
      calls,
      mode: 'native',
      capabilities: { screenshot: true, text: true, console: true },
      current: () => ({ url: over.url === undefined ? 'http://localhost:5173/' : over.url, title: 'App', tabs: 1 }),
      navigate: async (url) => { calls.push(`navigate ${url}`); return { url, title: 'App', loading: false }; },
      screenshot: async () => { calls.push('screenshot'); return { mime: 'image/png', base64: 'AA==', width: 1, height: 1 }; },
      text: async () => { calls.push('text'); return { url: 'http://localhost:5173/', title: 'App', text: 'hello', truncated: false }; },
      console: async () => { calls.push('console'); return { url: 'http://localhost:5173/', console: [], network: [] }; },
      ...over,
    };
  }
  const cmd = (op: VerseBrowserAgentCommand['op'], extra: Partial<VerseBrowserAgentCommand> = {}): VerseBrowserAgentCommand =>
    ({ id: 'bc_AAAAAAAAAAAA', sessionId: 's-1', op, allowedOrigins: [], createdAt: 'now', ...extra });

  it('never captures a page the chat may not observe — and never names it', async () => {
    const exec = executor({ url: 'https://mail.example/inbox' });
    for (const op of ['screenshot', 'read-text', 'console'] as const) {
      const r = await executeAgentCommand(cmd(op), exec, VERSE);
      expect([op, r.ok]).toEqual([op, false]);
    }
    expect(exec.calls).toEqual([]);
    const status = await executeAgentCommand(cmd('status'), exec, VERSE);
    expect(status).toMatchObject({ ok: true, data: { hidden: true, title: null } });
    expect(status.url).toBeUndefined();
    // Allowed for this chat → captured.
    const allowed = await executeAgentCommand(cmd('screenshot', { allowedOrigins: ['https://mail.example'] }), exec, VERSE);
    expect(allowed.ok).toBe(true);
  });

  it('navigates only through the gate (Verse itself and external origins refused)', async () => {
    const exec = executor();
    expect((await executeAgentCommand(cmd('navigate', { url: 'http://127.0.0.1:7777/verse/' }), exec, VERSE)).ok).toBe(false);
    expect((await executeAgentCommand(cmd('navigate', { url: 'https://example.com/' }), exec, VERSE)).ok).toBe(false);
    const ok = await executeAgentCommand(cmd('navigate', { url: 'http://localhost:3000/x' }), exec, VERSE);
    expect(ok).toMatchObject({ ok: true, url: 'http://localhost:3000/x', data: { title: 'App' } });
    expect(exec.calls).toEqual(['navigate http://localhost:3000/x']);
  });

  it('in the web UI (frame mode) it can navigate but says capture needs the desktop app', async () => {
    const exec = executor({ mode: 'frame', capabilities: { screenshot: false, text: false, console: false } });
    const shot = await executeAgentCommand(cmd('screenshot'), exec, VERSE);
    expect(shot).toMatchObject({ ok: false });
    expect(shot.error).toMatch(/desktop app/);
    expect(exec.calls).toEqual([]);
  });

  it('turns executor failures into answers, and caps limits', async () => {
    const exec = executor({ screenshot: async () => { throw new Error('snapshot failed'); } });
    expect(await executeAgentCommand(cmd('screenshot'), exec, VERSE)).toMatchObject({ ok: false, error: 'snapshot failed' });
    const noShots = executor({ capabilities: { screenshot: false, text: true, console: true } });
    expect((await executeAgentCommand(cmd('screenshot'), noShots, VERSE)).error).toMatch(/macOS only/);
    expect(versePortOf('http://127.0.0.1:7777')).toBe(7777);
    expect(versePortOf('https://verse.test')).toBe(443);
  });
});
