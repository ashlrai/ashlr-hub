/**
 * routes/verse/sections/app-version.ts — the hub's version, for About.
 *
 * Read straight from package.json (Vite inlines the named export at build
 * time and `resolveJsonModule` types it), because no API route reports it:
 * /api/health answers liveness, /api/snapshot answers fleet state, and
 * neither carries the running hub's version. A hardcoded string here would
 * silently drift from the published package on every release.
 */
import { version } from '../../../../../package.json';

export const APP_VERSION: string = version;
export const APP_NAME = 'Ashlr Verse';
