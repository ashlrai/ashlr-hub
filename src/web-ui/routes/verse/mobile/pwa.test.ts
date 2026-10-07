/**
 * Installable and offline-capable: the head tags iOS and Android read, the
 * web app manifest (and that every icon it names exists at its stated size),
 * service-worker registration, and the worker's own routing — above all that
 * it never touches /api/.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { installMobileHead, isStandalone, registerMobileServiceWorker, supportsIphoneHomeScreenPush, THEME_COLORS, VERSE_MOBILE_MANIFEST_HREF, VERSE_MOBILE_SW_SCOPE, VERSE_MOBILE_SW_URL } from './pwa.js';

const PUBLIC = resolve(process.cwd(), 'src/web-ui/public/verse-m');

afterEach(() => {
  document.head.innerHTML = '';
});

describe('installMobileHead', () => {
  it('writes the manifest, touch icon, standalone and safe-area tags', () => {
    document.head.innerHTML = '<meta name="viewport" content="width=device-width, initial-scale=1.0">';
    installMobileHead(document);
    const meta = (name: string) => [...document.head.querySelectorAll(`meta[name="${name}"]`)].map((m) => m.getAttribute('content'));
    expect(document.title).toBe('Phantom');
    expect(meta('viewport')).toEqual(['width=device-width, initial-scale=1, viewport-fit=cover']);
    expect(meta('apple-mobile-web-app-capable')).toEqual(['yes']);
    expect(meta('mobile-web-app-capable')).toEqual(['yes']);
    expect(meta('apple-mobile-web-app-status-bar-style')).toEqual(['black-translucent']);
    expect(meta('apple-mobile-web-app-title')).toEqual(['Phantom']);
    expect(meta('theme-color')).toEqual([THEME_COLORS.light, THEME_COLORS.dark]);
    expect(document.head.querySelector('link[rel="manifest"]')?.getAttribute('href')).toBe(VERSE_MOBILE_MANIFEST_HREF);
    expect(document.head.querySelector('link[rel="apple-touch-icon"]')?.getAttribute('href')).toBe('/next/verse-m/apple-touch-icon.png');
  });

  it('is idempotent — a remount adds nothing', () => {
    installMobileHead(document);
    const count = document.head.children.length;
    installMobileHead(document);
    expect(document.head.children.length).toBe(count);
  });
});

describe('registerMobileServiceWorker', () => {
  it('registers /verse/m/sw.js scoped to /verse/m/, never serving the worker from cache', async () => {
    const register = vi.fn(async () => ({}) as ServiceWorkerRegistration);
    await expect(registerMobileServiceWorker({ serviceWorker: { register } as unknown as ServiceWorkerContainer })).resolves.toBe('registered');
    expect(register).toHaveBeenCalledWith(VERSE_MOBILE_SW_URL, { scope: VERSE_MOBILE_SW_SCOPE, type: 'classic', updateViaCache: 'none' });
    expect(VERSE_MOBILE_SW_URL).toBe('/verse/m/sw.js');
    expect(VERSE_MOBILE_SW_SCOPE).toBe('/verse/m/');
  });

  it('is a quiet no-op where workers are missing or refused', async () => {
    await expect(registerMobileServiceWorker(undefined)).resolves.toBe('unsupported');
    await expect(registerMobileServiceWorker({} as Navigator)).resolves.toBe('unsupported');
    const register = vi.fn(async () => {
      throw new DOMException('insecure', 'SecurityError');
    });
    await expect(registerMobileServiceWorker({ serviceWorker: { register } as unknown as ServiceWorkerContainer })).resolves.toBe('failed');
  });
});

describe('isStandalone', () => {
  it('reads iOS navigator.standalone and display-mode', () => {
    expect(isStandalone({ navigator: { standalone: true }, matchMedia: () => ({ matches: false }) } as unknown as Window)).toBe(true);
    expect(isStandalone({ navigator: {}, matchMedia: () => ({ matches: true }) } as unknown as Window)).toBe(true);
    expect(isStandalone({ navigator: {}, matchMedia: () => ({ matches: false }) } as unknown as Window)).toBe(false);
  });
});

it('offers gateway push only in an installed iPhone app with browser push support', () => {
  const browser = { PushManager: class {}, Notification: class {} } as unknown as Window;
  expect(supportsIphoneHomeScreenPush({ standalone: true, serviceWorker: {} } as unknown as Navigator, browser)).toBe(true);
  expect(supportsIphoneHomeScreenPush({ standalone: false, serviceWorker: {} } as unknown as Navigator, browser)).toBe(false);
  expect(supportsIphoneHomeScreenPush({ serviceWorker: {} } as unknown as Navigator, browser)).toBe(false);
  expect(supportsIphoneHomeScreenPush({ standalone: true, serviceWorker: {} } as unknown as Navigator, {} as Window)).toBe(false);
});

/** Width and height from a PNG's IHDR chunk. */
function pngSize(file: string): [number, number] {
  const buf = readFileSync(resolve(PUBLIC, file));
  expect(buf.subarray(1, 4).toString('ascii')).toBe('PNG');
  return [buf.readUInt32BE(16), buf.readUInt32BE(20)];
}

describe('the web app manifest', () => {
  const manifest = JSON.parse(readFileSync(resolve(PUBLIC, 'manifest.webmanifest'), 'utf8')) as {
    start_url: string;
    scope: string;
    id: string;
    display: string;
    icons: Array<{ src: string; sizes: string; purpose: string }>;
    shortcuts: Array<{ url: string }>;
  };

  it('starts and stays inside the phone app, standalone', () => {
    expect(manifest.start_url).toBe('/verse/m/');
    expect(manifest.scope).toBe('/verse/m/');
    expect(manifest.id).toBe('/verse/m/');
    expect(manifest.display).toBe('standalone');
    for (const s of manifest.shortcuts) expect(s.url.startsWith('/verse/m/')).toBe(true);
  });

  it('names icons that exist at their stated sizes, including a maskable one', () => {
    expect(manifest.icons.some((i) => i.purpose === 'maskable')).toBe(true);
    expect(manifest.icons.some((i) => i.sizes === '512x512' && i.purpose === 'any')).toBe(true);
    expect(manifest.icons.some((i) => i.sizes === '192x192')).toBe(true);
    for (const icon of manifest.icons) {
      expect(icon.src.startsWith('/next/verse-m/')).toBe(true);
      const [w, h] = pngSize(icon.src.replace('/next/verse-m/', ''));
      expect(`${w}x${h}`).toBe(icon.sizes);
    }
    expect(pngSize('apple-touch-icon.png')).toEqual([180, 180]);
  });
});

// ---------------------------------------------------------------------------
// The worker itself (public/verse-m/sw.js), run against fakes
// ---------------------------------------------------------------------------

interface FakeCache {
  store: Map<string, Response>;
  put(req: string | Request, res: Response): Promise<void>;
  match(req: string | Request): Promise<Response | undefined>;
  add(req: Request): Promise<void>;
  keys(): Promise<Request[]>;
  delete(req: Request | string): Promise<boolean>;
}

function loadWorker(network: (req: Request) => Promise<Response>) {
  const listeners = new Map<string, (event: unknown) => void>();
  const caches = new Map<string, FakeCache>();
  const keyOf = (r: string | Request) => (typeof r === 'string' ? new URL(r, 'https://mac.local').pathname : new URL(r.url).pathname);
  const open = async (name: string) => {
    let c = caches.get(name);
    if (!c) {
      const store = new Map<string, Response>();
      c = {
        store,
        put: async (req, res) => {
          store.set(keyOf(req), res);
        },
        match: async (req) => store.get(keyOf(req))?.clone(),
        add: async (req) => {
          store.set(keyOf(req), await network(req));
        },
        keys: async () => [...store.keys()].map((k) => new Request(`https://mac.local${k}`)),
        delete: async (req) => store.delete(keyOf(req)),
      };
      caches.set(name, c);
    }
    return c;
  };
  const self = {
    location: { origin: 'https://mac.local' },
    registration: { showNotification: vi.fn(async () => undefined) },
    addEventListener: (type: string, fn: (e: unknown) => void) => listeners.set(type, fn),
    skipWaiting: vi.fn(async () => undefined),
    clients: { claim: vi.fn(async () => undefined) },
  } as Record<string, unknown>;
  const cacheStorage = {
    open,
    keys: async () => [...caches.keys()],
    delete: async (name: string) => caches.delete(name),
  };
  const src = readFileSync(resolve(PUBLIC, 'sw.js'), 'utf8');
  // A worker resolves relative URLs against its own location; Node's Request needs the base spelled out.
  class ScopedRequest extends Request {
    constructor(input: string | URL, init?: RequestInit) {
      const { cache: _cache, ...rest } = init ?? {};
      super(new URL(String(input), 'https://mac.local/verse/m/sw.js'), rest);
    }
  }
  new Function('self', 'caches', 'fetch', 'Request', 'Response', 'URL', 'Promise', src)(self, cacheStorage, (req: Request) => network(req), ScopedRequest, Response, URL, Promise);
  const api = self.__ashlrVerseSw as { routeFor: (m: string, u: string, mode: string, o: string) => string; SHELL_URL: string };

  async function dispatchFetch(url: string, init: { method?: string; mode?: string } = {}) {
    let responded: Promise<Response> | null = null;
    const request = { url, method: init.method ?? 'GET', mode: init.mode ?? 'cors' } as unknown as Request;
    listeners.get('fetch')!({ request, respondWith: (p: Promise<Response>) => { responded = p; } });
    return responded as Promise<Response> | null;
  }
  async function lifecycle(type: 'install' | 'activate') {
    let wait: Promise<unknown> = Promise.resolve();
    listeners.get(type)!({ waitUntil: (p: Promise<unknown>) => { wait = p; } });
    await wait;
  }
  async function dispatchPush(data: unknown) {
    let wait: Promise<unknown> = Promise.resolve();
    listeners.get('push')!({ data, waitUntil: (p: Promise<unknown>) => { wait = p; } });
    await wait;
  }
  return { api, dispatchFetch, dispatchPush, lifecycle, caches, self };
}

const ok = (body: string, type = 'text/html') => new Response(body, { status: 200, headers: { 'Content-Type': type } });

describe('the service worker', () => {
  it('never displays an untrusted push payload or private agent details', async () => {
    const { dispatchPush, self } = loadWorker(async () => ok(''));
    const payload = { text: 'PRIVATE agent transcript', repo: 'secret-repo', json: () => { throw new Error('payload read'); } };
    await dispatchPush(payload);
    const show = (self.registration as { showNotification: ReturnType<typeof vi.fn> }).showNotification;
    expect(show).toHaveBeenCalledTimes(1);
    const displayed = JSON.stringify(show.mock.calls[0]);
    expect(displayed).toContain('Phantom has an update');
    expect(displayed).not.toContain('PRIVATE');
    expect(displayed).not.toContain('secret-repo');
  });

  it('uses fixed copy and fixed routes for needs-you and completion signals', async () => {
    const { dispatchPush, self } = loadWorker(async () => ok(''));
    const show = (self.registration as { showNotification: ReturnType<typeof vi.fn> }).showNotification;
    await dispatchPush({ json: () => ({ kind: 'needs-you', title: 'PRIVATE approval', body: 'secret transcript' }) });
    await dispatchPush({ json: () => ({ kind: 'completed', title: 'PRIVATE repo', body: 'secret result' }) });
    expect(show.mock.calls[0]![1]).toMatchObject({ body: 'Something needs you. Open Phantom for details.', data: { path: '/verse/m/#/needs' } });
    expect(show.mock.calls[1]![1]).toMatchObject({ body: 'A run completed. Open Phantom for details.', data: { path: '/verse/m/#/' } });
    expect(JSON.stringify(show.mock.calls)).not.toMatch(/PRIVATE|secret/);
  });
  it('routes: never /api/, never another origin or method; shell, hashed assets and its own files only', () => {
    const { api } = loadWorker(async () => ok(''));
    const o = 'https://mac.local';
    expect(api.routeFor('GET', `${o}/api/verse/activity`, 'cors', o)).toBe('network');
    expect(api.routeFor('GET', `${o}/api/session`, 'cors', o)).toBe('network');
    expect(api.routeFor('POST', `${o}/verse/m/`, 'navigate', o)).toBe('network');
    expect(api.routeFor('GET', 'https://evil.example/verse/m/', 'navigate', o)).toBe('network');
    expect(api.routeFor('GET', `${o}/verse/m/`, 'navigate', o)).toBe('shell');
    expect(api.routeFor('GET', `${o}/verse/`, 'navigate', o)).toBe('network');
    expect(api.routeFor('GET', `${o}/next/assets/index-DKERPRgH.js`, 'cors', o)).toBe('asset');
    expect(api.routeFor('GET', `${o}/next/assets/index.js`, 'cors', o)).toBe('network');
    expect(api.routeFor('GET', `${o}/next/verse-m/icon-192.png`, 'no-cors', o)).toBe('static');
  });

  it('leaves /api/ requests entirely to the browser (no respondWith)', async () => {
    const network = vi.fn(async () => ok('{}', 'application/json'));
    const { dispatchFetch } = loadWorker(network);
    expect(await dispatchFetch('https://mac.local/api/verse/sessions')).toBeNull();
    expect(await dispatchFetch('https://mac.local/api/verse/sessions/x/turns', { method: 'POST' })).toBeNull();
    expect(network).not.toHaveBeenCalled();
  });

  it('serves the cached shell when the Mac is unreachable, and a static page when nothing is cached', async () => {
    let online = true;
    const { dispatchFetch, lifecycle } = loadWorker(async () => {
      if (!online) throw new TypeError('Failed to fetch');
      return ok('<div id="root"></div>');
    });
    online = false;
    const cold = await (await dispatchFetch('https://mac.local/verse/m/', { mode: 'navigate' }))!;
    expect(cold.status).toBe(503);
    const page = await cold.text();
    expect(page).toContain('Can’t reach your Mac');
    expect(page).not.toMatch(/<script/i);
    online = true;
    await lifecycle('install');
    online = false;
    const warm = await (await dispatchFetch('https://mac.local/verse/m/', { mode: 'navigate' }))!;
    expect(warm.status).toBe(200);
    expect(await warm.text()).toContain('id="root"');
  });

  it('never replaces a paired remote shell with Access HTML or an unmarked page', async () => {
    const remoteHtml = '<meta name="ashlr-remote-gateway" content="v1"><div id="root"></div>';
    let answer: Response | null = ok(remoteHtml);
    const { dispatchFetch, lifecycle } = loadWorker(async () => {
      if (!answer) throw new TypeError('offline');
      return answer;
    });
    await lifecycle('install');
    answer = ok('<div id="root"></div>');
    await (await dispatchFetch('https://mac.local/verse/m/', { mode: 'navigate' }))!;
    answer = ok('<div id="root"></div>');
    Object.defineProperty(answer, 'url', { value: 'https://login.cloudflareaccess.com/sign-in' });
    await (await dispatchFetch('https://mac.local/verse/m/', { mode: 'navigate' }))!;
    answer = null;
    const cached = await (await dispatchFetch('https://mac.local/verse/m/', { mode: 'navigate' }))!;
    expect(await cached.text()).toContain('ashlr-remote-gateway');
  });

  it('caches hashed assets first, and activate drops old versions only', async () => {
    const network = vi.fn(async () => ok('code', 'application/javascript'));
    const { dispatchFetch, lifecycle, caches, self } = loadWorker(network);
    const url = 'https://mac.local/next/assets/HomeBody-DkBbRGwS.js';
    await (await dispatchFetch(url))!;
    await new Promise((r) => setTimeout(r, 0));
    await (await dispatchFetch(url))!;
    expect(network).toHaveBeenCalledTimes(1);
    caches.set('ashlr-verse-m-shell-v0', {} as FakeCache);
    caches.set('someone-elses-cache', {} as FakeCache);
    await lifecycle('activate');
    expect([...caches.keys()].sort()).toEqual(['ashlr-verse-m-assets-v2', 'someone-elses-cache']);
    expect((self.clients as { claim: ReturnType<typeof vi.fn> }).claim).toHaveBeenCalled();
  });
});
