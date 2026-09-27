/**
 * The native browser pane's tap (desktop/src-tauri/src/browser_tap.js) records failed
 * XMLHttpRequests. 3.15 integration: the XHR hook no longer aliases `this` (eslint
 * no-this-alias failed `gate:full`); the `loadend` listener reads the request from its own
 * `this`, which a DOM listener is always called with. This runs the real tap source in a
 * vm context with a minimal XHR double that dispatches like the DOM, and proves the
 * network buffer still captures a failed request and a network error — and ignores a 200.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

const TAP = readFileSync(join(__dirname, '..', 'desktop', 'src-tauri', 'src', 'browser_tap.js'), 'utf8');

interface TapApi { dump: (limit?: number) => string }

function loadTap() {
  class FakeXHR {
    status = 0;
    private listeners = new Map<string, Array<(this: FakeXHR, ev: unknown) => void>>();
    open(_method: string, _url: string): void {}
    send(): void {}
    addEventListener(type: string, fn: (this: FakeXHR, ev: unknown) => void): void {
      this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
    }
    /** Like the DOM: each listener is called with `this` = the target. */
    finish(status: number): void {
      this.status = status;
      for (const fn of this.listeners.get('loadend') ?? []) fn.call(this, { type: 'loadend' });
    }
  }
  const window: Record<string, unknown> = {
    XMLHttpRequest: FakeXHR,
    location: { href: 'https://example.test/' },
    addEventListener() {},
  };
  window.window = window;
  runInNewContext(TAP, { window, document: { title: 't', readyState: 'complete' }, JSON, Date, WeakMap, Object, String });
  const tap = window.__ashlrTap as TapApi;
  const network = () => (JSON.parse(tap.dump(50)) as { network: Array<{ method: string; url: string; status: number | null; error?: string }> }).network;
  return { FakeXHR, network };
}

describe('browser tap — XMLHttpRequest capture', () => {
  it('records a failed request and a network error from the listener\'s own `this`', () => {
    const { FakeXHR, network } = loadTap();
    const ok = new FakeXHR();
    ok.open('get', '/ok');
    ok.send();
    ok.finish(200);

    const bad = new FakeXHR();
    bad.open('post', '/boom');
    bad.send();
    bad.finish(503);

    const dropped = new FakeXHR();
    dropped.open('GET', '/gone');
    dropped.send();
    dropped.finish(0);

    const entries = network();
    expect(entries.map(({ method, url, status, error }) => ({ method, url, status, error }))).toEqual([
      { method: 'POST', url: '/boom', status: 503, error: undefined },
      { method: 'GET', url: '/gone', status: null, error: 'network error' },
    ]);
  });

  it('hooks a request once even when it is sent twice', () => {
    const { FakeXHR, network } = loadTap();
    const xhr = new FakeXHR();
    xhr.open('GET', '/twice');
    xhr.send();
    xhr.send();
    xhr.finish(404);
    expect(network()).toHaveLength(1);
  });
});
