/*
 * Ashlr Verse on a phone — service worker (served at /verse/m/sw.js, scope
 * /verse/m/; see src/web-ui/routes/verse/mobile/pwa.ts and core/web/static.ts).
 *
 * WHAT IT CACHES, AND WHAT IT NEVER DOES:
 *   - the app shell (the /verse/m/ page) — network first, so a new build is
 *     picked up on the next launch; the cached copy only answers when the Mac
 *     does not
 *   - Vite's content-hashed assets (/next/assets/<name>-<hash>.<ext>) — cache
 *     first: their bytes can never change under that name
 *   - the icons and manifest (/next/verse-m/) — cache, refreshed behind
 *   - NEVER anything under /api/. Every read and every action goes to the Mac
 *     live; no agent output, approval or token is ever written to the phone's
 *     cache, and no request is ever replayed.
 *
 * When the Mac cannot be reached and no shell is cached yet, navigation gets a
 * small static page that says so (no script: the page CSP allows none inline).
 */
'use strict';

var VERSION = 'v1';
var SHELL_CACHE = 'ashlr-verse-m-shell-' + VERSION;
var ASSET_CACHE = 'ashlr-verse-m-assets-' + VERSION;
var SHELL_URL = '/verse/m/';
var MAX_ASSETS = 160;
var HASHED_ASSET_RE = /^\/next\/assets\/[^/]+-[A-Za-z0-9_-]{8}\.[A-Za-z0-9]+$/;

var OFFLINE_HTML =
  '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
  '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">' +
  '<meta name="color-scheme" content="light dark"><title>Ashlr Verse — Mac unreachable</title>' +
  '<style>' +
  ':root{color-scheme:light dark;font:-apple-system-body;font-family:system-ui,-apple-system,sans-serif}' +
  'body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:Canvas;color:CanvasText;' +
  'padding:max(1.5rem,env(safe-area-inset-top)) 1.5rem max(1.5rem,env(safe-area-inset-bottom))}' +
  'main{max-width:22rem;text-align:center}h1{font-size:1.4em;margin:0 0 .5em}p{opacity:.75;line-height:1.45;margin:0 0 1.25em}' +
  'a{display:inline-flex;align-items:center;justify-content:center;min-height:2.75rem;padding:0 1.5rem;border-radius:999px;' +
  'background:rgb(37 99 235);color:white;text-decoration:none;font-weight:600}' +
  '</style></head><body><main><h1>Can’t reach your Mac</h1>' +
  '<p>Verse runs on your Mac. It may be asleep, offline, or the connection to it is down. Nothing was sent.</p>' +
  '<a href="/verse/m/">Try again</a></main></body></html>';

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then(function (cache) {
        return cache.add(new Request(SHELL_URL, { cache: 'reload', credentials: 'same-origin' }));
      })
      .catch(function () {
        /* offline at install: the first online launch fills it */
      })
      .then(function () {
        return self.skipWaiting();
      }),
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches
      .keys()
      .then(function (keys) {
        return Promise.all(
          keys
            .filter(function (key) {
              return key.indexOf('ashlr-verse-m-') === 0 && key !== SHELL_CACHE && key !== ASSET_CACHE;
            })
            .map(function (key) {
              return caches.delete(key);
            }),
        );
      })
      .then(function () {
        return self.clients.claim();
      }),
  );
});

function offlineResponse() {
  return new Response(OFFLINE_HTML, {
    status: 503,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

function trimAssets(cache) {
  return cache.keys().then(function (keys) {
    var extra = keys.length - MAX_ASSETS;
    if (extra <= 0) return undefined;
    return Promise.all(
      keys.slice(0, extra).map(function (req) {
        return cache.delete(req);
      }),
    );
  });
}

function navigate(request) {
  return fetch(request)
    .then(function (response) {
      if (response.ok) {
        var copy = response.clone();
        caches.open(SHELL_CACHE).then(function (cache) {
          return cache.put(SHELL_URL, copy);
        });
      }
      return response;
    })
    .catch(function () {
      return caches.open(SHELL_CACHE).then(function (cache) {
        return cache.match(SHELL_URL).then(function (hit) {
          return hit || offlineResponse();
        });
      });
    });
}

function hashedAsset(request) {
  return caches.open(ASSET_CACHE).then(function (cache) {
    return cache.match(request).then(function (hit) {
      if (hit) return hit;
      return fetch(request).then(function (response) {
        if (response.ok) {
          cache.put(request, response.clone()).then(function () {
            return trimAssets(cache);
          });
        }
        return response;
      });
    });
  });
}

function staleWhileRevalidate(request) {
  return caches.open(SHELL_CACHE).then(function (cache) {
    return cache.match(request).then(function (hit) {
      var network = fetch(request)
        .then(function (response) {
          if (response.ok) cache.put(request, response.clone());
          return response;
        })
        .catch(function () {
          return hit || Response.error();
        });
      return hit || network;
    });
  });
}

/** Exposed for the unit test (src/web-ui/routes/verse/mobile/sw.test.ts); pure. */
function routeFor(method, urlString, mode, origin) {
  if (method !== 'GET') return 'network';
  var url = new URL(urlString);
  if (url.origin !== origin) return 'network';
  if (url.pathname.indexOf('/api/') === 0 || url.pathname === '/api') return 'network';
  if (mode === 'navigate') return url.pathname === '/verse/m/' || url.pathname === '/verse/m' ? 'shell' : 'network';
  if (HASHED_ASSET_RE.test(url.pathname)) return 'asset';
  if (url.pathname.indexOf('/next/verse-m/') === 0) return 'static';
  return 'network';
}

self.addEventListener('fetch', function (event) {
  var request = event.request;
  var route = routeFor(request.method, request.url, request.mode, self.location.origin);
  // 'network': not ours — the browser handles it exactly as without a worker.
  if (route === 'network') return;
  if (route === 'shell') event.respondWith(navigate(request));
  else if (route === 'asset') event.respondWith(hashedAsset(request));
  else event.respondWith(staleWhileRevalidate(request));
});

self.__ashlrVerseSw = { routeFor: routeFor, OFFLINE_HTML: OFFLINE_HTML, SHELL_URL: SHELL_URL };
