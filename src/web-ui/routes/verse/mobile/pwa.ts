/**
 * routes/verse/mobile/pwa.ts — what makes /verse/m installable and launch
 * like an app: the head tags iOS and Android read, and the service worker.
 *
 * WHY THE HEAD IS WRITTEN AT RUNTIME: index.html is shared by every console.
 * A manifest link or `viewport-fit=cover` there would make the desktop Verse,
 * Universe and Resources pages installable, and let the workbench draw under
 * a phone's notch without the safe-area padding only this app has. So the
 * phone app adds them when it mounts — iOS reads them when "Add to Home
 * Screen" is tapped, which is always after that.
 *
 * WHY THE WORKER LIVES AT /verse/m/sw.js: a worker controls only paths under
 * its own script's directory (core/web/static.ts maps the path to the built
 * file in next/verse-m/). What it caches is in public/verse-m/sw.js: the app
 * shell and hashed assets — never an /api/ response, so no read data is left
 * on the phone.
 */
import { VERSE_MOBILE_PATH } from '../../../app/console-mode.js';

export const VERSE_MOBILE_SW_URL = `${VERSE_MOBILE_PATH}sw.js`;
export const VERSE_MOBILE_SW_SCOPE = VERSE_MOBILE_PATH;

/**
 * Built by Vite from src/web-ui/public/verse-m/ into /next/verse-m/ (the
 * build's base). Literal, like the manifest's own icon paths, so the two can
 * never disagree.
 */
const ASSET_BASE = '/next/verse-m/';
export const VERSE_MOBILE_MANIFEST_HREF = `${ASSET_BASE}manifest.webmanifest`;
export const VERSE_MOBILE_TOUCH_ICON_HREF = `${ASSET_BASE}apple-touch-icon.png`;

/** The canvas colour of each theme (design/tokens.css --bg-canvas), for the status bar. */
export const THEME_COLORS = Object.freeze({ light: 'rgb(250 250 250)', dark: 'rgb(11 11 13)' });

const VIEWPORT = 'width=device-width, initial-scale=1, viewport-fit=cover';

function upsert(doc: Document, selector: string, create: () => HTMLElement, attrs: Record<string, string>): void {
  let el = doc.head.querySelector<HTMLElement>(selector);
  if (!el) {
    el = create();
    doc.head.append(el);
  }
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
}

function meta(doc: Document, name: string, content: string, extra: Record<string, string> = {}): void {
  const media = extra.media ? `[media="${extra.media}"]` : '';
  upsert(doc, `meta[name="${name}"]${media}`, () => doc.createElement('meta'), { name, content, ...extra });
}

function link(doc: Document, rel: string, href: string): void {
  upsert(doc, `link[rel="${rel}"]`, () => doc.createElement('link'), { rel, href });
}

/** Idempotent: safe to call on every mount. */
export function installMobileHead(doc: Document = document): void {
  if (!doc.head) return;
  doc.title = 'Ashlr Verse';
  meta(doc, 'viewport', VIEWPORT);
  link(doc, 'manifest', VERSE_MOBILE_MANIFEST_HREF);
  link(doc, 'apple-touch-icon', VERSE_MOBILE_TOUCH_ICON_HREF);
  meta(doc, 'apple-mobile-web-app-capable', 'yes');
  meta(doc, 'mobile-web-app-capable', 'yes');
  // Content runs under the status bar; the shell pads by env(safe-area-inset-top).
  meta(doc, 'apple-mobile-web-app-status-bar-style', 'black-translucent');
  meta(doc, 'apple-mobile-web-app-title', 'Verse');
  meta(doc, 'theme-color', THEME_COLORS.light, { media: '(prefers-color-scheme: light)' });
  meta(doc, 'theme-color', THEME_COLORS.dark, { media: '(prefers-color-scheme: dark)' });
  // Phone numbers and dates in agent output are not links to dial.
  meta(doc, 'format-detection', 'telephone=no');
}

export type ServiceWorkerOutcome = 'registered' | 'unsupported' | 'failed';

/**
 * Register the shell cache. Never throws and never blocks the app: a phone
 * with no worker (private mode, an http:// tunnel that is not localhost) is
 * the same app minus the offline screen.
 */
export async function registerMobileServiceWorker(
  nav: Pick<Navigator, 'serviceWorker'> | undefined = typeof navigator === 'undefined' ? undefined : navigator,
): Promise<ServiceWorkerOutcome> {
  const container = nav?.serviceWorker;
  if (!container || typeof container.register !== 'function') return 'unsupported';
  try {
    await container.register(VERSE_MOBILE_SW_URL, { scope: VERSE_MOBILE_SW_SCOPE, type: 'classic', updateViaCache: 'none' });
    return 'registered';
  } catch {
    return 'failed';
  }
}

/** Whether the app is running from the home screen (no browser chrome). */
export function isStandalone(win: Window = window): boolean {
  const iosStandalone = (win.navigator as Navigator & { standalone?: boolean }).standalone === true;
  return iosStandalone || (typeof win.matchMedia === 'function' && win.matchMedia('(display-mode: standalone)').matches);
}

/** This gateway's push sender accepts Apple Web Push subscriptions only. */
export function supportsIphoneHomeScreenPush(
  nav: Navigator = navigator,
  win: Window = window,
): boolean {
  return (nav as Navigator & { standalone?: boolean }).standalone === true
    && 'serviceWorker' in nav && 'PushManager' in win && 'Notification' in win;
}

/** Only called from an explicit tap after the paired gateway advertises push. */
export async function enableRemotePush(publicKey: string): Promise<PushSubscription> {
  if (!supportsIphoneHomeScreenPush()) {
    throw new Error('Notifications require Verse installed on an iPhone Home Screen with Web Push support.');
  }
  if (Notification.permission === 'denied') throw new Error('Notifications are blocked in this phone’s settings.');
  const permission = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission();
  if (permission !== 'granted') throw new Error('Notification permission was not granted.');
  const normalized = publicKey.replace(/-/g, '+').replace(/_/g, '/');
  const decoded = atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '='));
  const key = new Uint8Array(decoded.length);
  for (let i = 0; i < decoded.length; i += 1) key[i] = decoded.charCodeAt(i);
  const registration = await navigator.serviceWorker.ready;
  const existing = await registration.pushManager.getSubscription();
  return existing ?? registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
}
