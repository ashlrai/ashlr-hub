/**
 * Dictation gave the Ashlr app a microphone grant — and wry's WKUIDelegate
 * grants every WebKit media-capture request — so a site in the browser pane
 * must never reach the mic. Native denies it (desktop/src-tauri/src/media_guard.rs,
 * Rust-tested); this proves the second layer: the real tap
 * (desktop/src-tauri/src/browser_tap.js), run in a vm before "page" code, makes
 * getUserMedia / getDisplayMedia reject with NotAllowedError, hides devices,
 * refuses the legacy callback API, and cannot be undone by the page.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

const TAP = readFileSync(join(__dirname, '..', 'desktop', 'src-tauri', 'src', 'browser_tap.js'), 'utf8');

interface Sandbox {
  window: Record<string, unknown>;
  navigator: Record<string, unknown>;
  grants: string[];
}

function loadPage(): Sandbox {
  const grants: string[] = [];
  // What WebKit exposes before the tap runs: working capture APIs.
  class MediaDevices {
    getUserMedia(): Promise<string> {
      grants.push('getUserMedia');
      return Promise.resolve('live-mic-stream');
    }
    getDisplayMedia(): Promise<string> {
      grants.push('getDisplayMedia');
      return Promise.resolve('screen');
    }
    enumerateDevices(): Promise<Array<{ kind: string; label: string }>> {
      return Promise.resolve([{ kind: 'audioinput', label: 'MacBook Pro Microphone' }]);
    }
  }
  class Navigator {
    getUserMedia(_c: unknown, ok: (s: string) => void): void {
      grants.push('legacy');
      ok('legacy-stream');
    }
  }
  const navigator = Object.create(Navigator.prototype) as Record<string, unknown>;
  navigator.mediaDevices = new MediaDevices();
  const window: Record<string, unknown> = {
    MediaDevices,
    Navigator,
    navigator,
    location: { href: 'https://evil.example/' },
    addEventListener() {},
    XMLHttpRequest: class {
      open(): void {}
      send(): void {}
      addEventListener(): void {}
    },
  };
  window.window = window;
  runInNewContext(TAP, {
    window,
    navigator,
    document: { title: 't', readyState: 'complete' },
    DOMException,
    Promise,
    JSON,
    Date,
    WeakMap,
    Object,
    String,
    Error,
  });
  return { window, navigator, grants };
}

type Md = {
  getUserMedia: (c?: unknown) => Promise<unknown>;
  getDisplayMedia: (c?: unknown) => Promise<unknown>;
  enumerateDevices: () => Promise<unknown[]>;
};

describe('browser tap — media capture is refused', () => {
  it('rejects getUserMedia and getDisplayMedia with NotAllowedError', async () => {
    const { navigator, grants } = loadPage();
    const md = navigator.mediaDevices as Md;
    await expect(md.getUserMedia({ audio: true })).rejects.toMatchObject({
      name: 'NotAllowedError', message: 'Media capture is disabled in the Phantom browser pane.',
    });
    await expect(md.getDisplayMedia({ video: true })).rejects.toMatchObject({ name: 'NotAllowedError' });
    expect(await md.enumerateDevices()).toEqual([]);
    expect(grants).toEqual([]);
  });

  it('closes the prototype path and the legacy callback API too', async () => {
    const { window, navigator, grants } = loadPage();
    const proto = (window.MediaDevices as { prototype: Md }).prototype;
    await expect(proto.getUserMedia.call(navigator.mediaDevices, { audio: true })).rejects.toMatchObject({
      name: 'NotAllowedError',
    });
    let failed: unknown = null;
    (navigator as { getUserMedia: (c: unknown, ok: () => void, fail: (e: unknown) => void) => void }).getUserMedia(
      { audio: true },
      () => {
        throw new Error('must not succeed');
      },
      (e) => {
        failed = e;
      },
    );
    expect(failed).toMatchObject({ name: 'NotAllowedError' });
    expect(grants).toEqual([]);
  });

  it('cannot be put back by the page', async () => {
    const { navigator, grants } = loadPage();
    const md = navigator.mediaDevices as Md & Record<string, unknown>;
    expect(() => {
      'use strict';
      Object.defineProperty(md, 'getUserMedia', { value: () => Promise.resolve('stream') });
    }).toThrow();
    try {
      md.getUserMedia = () => Promise.resolve('stream');
    } catch {
      /* non-writable: strict-mode assignment throws, sloppy is ignored */
    }
    await expect(md.getUserMedia({ audio: true })).rejects.toMatchObject({ name: 'NotAllowedError' });
    expect(grants).toEqual([]);
  });

  it('is idempotent: a second injection neither throws nor re-opens anything', async () => {
    const page = loadPage();
    expect(() =>
      runInNewContext(TAP, {
        window: page.window,
        navigator: page.navigator,
        document: { title: 't', readyState: 'complete' },
        DOMException,
        Promise,
        JSON,
        Date,
        WeakMap,
        Object,
        String,
        Error,
      }),
    ).not.toThrow();
    await expect((page.navigator.mediaDevices as Md).getUserMedia({ audio: true })).rejects.toMatchObject({
      name: 'NotAllowedError',
    });
  });
});
