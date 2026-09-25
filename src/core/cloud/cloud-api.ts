/**
 * Cloud lane HTTP module (3.11) — mounted as 'cloud' in verse-api.ts.
 *
 * CONTRACT STUB: unit C2 implements the routes in types.ts
 * (VERSE_CLOUD_*). Until then it claims no path, so the server answers 404
 * exactly as before and nothing else is affected.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { VerseApiContext } from '../verse/verse-api.js';

export async function handleCloudApi(
  _ctx: VerseApiContext,
  _req: IncomingMessage,
  _res: ServerResponse,
  _path: string,
  _method: string,
): Promise<boolean> {
  return false;
}
