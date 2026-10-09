/**
 * routes/verse/sections/app-version.ts — build and installed desktop versions for Settings.
 *
 * Read straight from package.json (Vite inlines the named export at build
 * time and `resolveJsonModule` types it). This is the interface build, not
 * proof of publication or the version of a desktop shell hosting it.
 */
import { version } from '../../../../../package.json';

export const APP_VERSION: string = version;
export { PRODUCT_NAME as APP_NAME } from '../../../app/product-brand.js';

/** Existing native shell metadata is display-only; protocol versions are not app versions. */
export function installedDesktopVersion(source: unknown = typeof window === 'undefined' ? null : window): string | null {
  if (typeof source !== 'object' || source === null) return null;
  const bridge = (source as { __ASHLR_DESKTOP__?: unknown }).__ASHLR_DESKTOP__;
  if (typeof bridge !== 'object' || bridge === null) return null;
  const shell = bridge as { shell?: unknown; version?: unknown };
  if (shell.shell !== 'tauri' || typeof shell.version !== 'string' || shell.version.length > 128) return null;
  return /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(shell.version) ? shell.version : null;
}
