/**
 * routes/verse/jev/jev-queries.ts — GET /api/verse/jev (core/decide/jev-api.ts).
 *
 * OPTIONAL: a server without the route answers 404 and the views render
 * nothing. Read-only: there is no write, and the page never takes a key.
 */
import { VERSE_JEV_PATH } from '../../../../core/decide/jev-types.js';
import { optionalQuery } from '../command/surface-data.js';
import { narrowJevResponse } from './jev-model.js';

export const JEV_KEY = 'verse-jev';
export const JEV_POLL_MS = 60_000;

export const jevQuery = optionalQuery(JEV_KEY, VERSE_JEV_PATH, 'Jev', narrowJevResponse);
