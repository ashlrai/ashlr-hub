/**
 * core/integrations/vercel.ts — Read-only Vercel project status via the
 * `vercel` CLI.
 *
 * RULES:
 *  - READ-ONLY. Deploying stays in `ashlr ship` (already --confirm gated).
 *  - NEVER throws. Every exported function degrades gracefully on any
 *    failure (CLI absent, not authed, not linked, malformed output).
 *  - Uses the installed `vercel` CLI — no raw tokens are read, stored,
 *    logged, or printed.
 *  - spawnSync only (no shell prevents shell injection).
 *  - Bounded timeouts so a slow/hung CLI never blocks the caller.
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { VercelStatus } from '../types.js';

// ---------------------------------------------------------------------------
// Internal constants
// ---------------------------------------------------------------------------

const VERCEL_BIN = 'vercel';
const TIMEOUT_MS = 8_000; // ms — vercel ls can be slow on first run
const MAX_DEPLOYS = 10;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Run a vercel sub-command synchronously inside `cwd`.
 * Returns trimmed stdout or null on any failure. Never throws.
 */
function runVercel(args: string[], cwd: string): string | null {
  try {
    const res = spawnSync(VERCEL_BIN, args, {
      cwd,
      timeout: TIMEOUT_MS,
      stdio: 'pipe',
      encoding: 'utf8',
      env: {
        ...process.env,
        // Suppress interactive prompts and update checks so the CLI
        // is usable in a non-TTY context.
        CI: '1',
        FORCE_COLOR: '0',
      },
    });
    // spawn error (e.g. ENOENT — vercel not on PATH) or non-zero exit → null.
    if (res.error) return null;
    if (res.status !== 0) return null;
    return typeof res.stdout === 'string' ? res.stdout.trim() : null;
  } catch {
    return null;
  }
}

/**
 * Returns true when a `.vercel/project.json` file exists in `cwd`, which
 * indicates the directory has been linked to a Vercel project.
 */
function hasProjectJson(cwd: string): boolean {
  return existsSync(join(cwd, '.vercel', 'project.json'));
}

// ---------------------------------------------------------------------------
// DeploySummary — public interface
// ---------------------------------------------------------------------------

/** A single deployment summary (read-only). */
export interface DeploySummary {
  /** The deployment URL (e.g. my-app-abc123.vercel.app). */
  url: string;
  /** Build/deployment state (e.g. READY, BUILDING, ERROR, CANCELED). */
  state: string;
  /** ISO-8601 creation timestamp, or null when unavailable. */
  createdAt: string | null;
  /** Deployment target: "production" | "preview" | null. */
  target: string | null;
}

// ---------------------------------------------------------------------------
// JSON parsing helpers
// ---------------------------------------------------------------------------

/**
 * Parse the JSON emitted by `vercel ls --format json`.
 *
 * The modern CLI emits `{ deployments: [...] }`; older shapes emit a bare
 * array of deployment objects. Each relevant
 * field is extracted defensively; unknown shapes produce an empty array.
 */
function parseDeployList(raw: string): DeploySummary[] {
  const trimmed = raw.trim();
  // vercel ls --format json wraps the array under a top-level key (or, on
  // older CLI versions, emits a bare array).
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return [];
  }

  // Accept a bare array OR { deployments: [...] } / { data: [...] } wrappers.
  let items: unknown[] | null = null;
  if (Array.isArray(parsed)) {
    items = parsed;
  } else if (parsed !== null && typeof parsed === 'object') {
    const obj = parsed as Record<string, unknown>;
    for (const key of ['deployments', 'data', 'items']) {
      if (Array.isArray(obj[key])) {
        items = obj[key] as unknown[];
        break;
      }
    }
  }

  if (items === null) return [];

  const results: DeploySummary[] = [];
  for (const item of items) {
    if (item === null || typeof item !== 'object') continue;
    const d = item as Record<string, unknown>;

    // URL — vercel uses "url" or "alias" (first element).
    let url = '';
    if (typeof d['url'] === 'string' && d['url'].length > 0) {
      url = d['url'];
    } else if (Array.isArray(d['alias']) && typeof d['alias'][0] === 'string') {
      url = d['alias'][0] as string;
    }
    if (!url) continue; // skip entries without a URL

    // State — various field names depending on vercel CLI version.
    let state = 'UNKNOWN';
    for (const key of ['state', 'readyState', 'status']) {
      if (typeof d[key] === 'string' && (d[key] as string).length > 0) {
        state = (d[key] as string).toUpperCase();
        break;
      }
    }

    // Created timestamp.
    let createdAt: string | null = null;
    for (const key of ['createdAt', 'created', 'createdTime']) {
      const val = d[key];
      if (typeof val === 'string' && val.length > 0) {
        createdAt = val;
        break;
      }
      if (typeof val === 'number') {
        createdAt = new Date(val).toISOString();
        break;
      }
    }

    // Target — "production" | "preview" | null.
    let target: string | null = null;
    for (const key of ['target', 'meta.githubCommitRef']) {
      if (typeof d[key] === 'string' && (d[key] as string).length > 0) {
        target = d[key] as string;
        break;
      }
    }

    results.push({ url, state, createdAt, target });

    if (results.length >= MAX_DEPLOYS) break;
  }

  return results;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Read-only linked-project snapshot via the `vercel` CLI.
 * NEVER throws — degrades to `{ linked: false, latestState: null, url: null }`
 * on any failure (CLI absent, not authed, not linked, scope prompt, timeout).
 */
export function vercelStatus(cwd: string): VercelStatus {
  const unlinked: VercelStatus = { linked: false, latestState: null, url: null };

  // Fast-path: check for .vercel/project.json before spawning the CLI.
  if (!hasProjectJson(cwd)) return unlinked;

  // Attempt `vercel ls --format json` for a live deployment list — take the
  // first (most recent) entry as the latest status. The modern Vercel CLI uses
  // `-F, --format json`; the legacy `--json` flag errors with "unknown option".
  const raw = runVercel(['ls', '--format', 'json'], cwd);
  if (raw === null) return unlinked;

  const deploys = parseDeployList(raw);
  if (deploys.length > 0) {
    const latest = deploys[0]!;
    return {
      linked: true,
      latestState: latest.state,
      url: latest.url,
    };
  }

  // `vercel ls` returned parseable JSON but no deployments — still linked.
  return { linked: true, latestState: null, url: null };
}

/**
 * List recent deployments for the Vercel project linked to `cwd`.
 * NEVER throws — returns [] on any failure (CLI absent, not authed, not
 * linked, malformed output, timeout).
 */
export function listDeploys(cwd: string): DeploySummary[] {
  const raw = runVercel(['ls', '--format', 'json'], cwd);
  if (raw === null) return [];

  return parseDeployList(raw);
}
