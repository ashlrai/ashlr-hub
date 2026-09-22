/**
 * Tests for src/core/verse/github-api.ts — `GET /api/verse/github` and
 * `GET /api/verse/github/pr-plan` (docs/VERSE-WORKSPACES.md §2).
 *
 * FULLY HERMETIC. Both readers and the proposal loader are injected, so no
 * test here spawns `gh` or `git`, reads the inbox, or binds a socket. The
 * response is captured through a minimal ServerResponse stand-in — enough for
 * sendJson(), which only calls writeHead() and end().
 *
 * What these tests are actually protecting:
 *   - the routes are GET-only, because nothing on them may mutate anything
 *   - `?repo=` cannot be used to probe the filesystem: a path the operator has
 *     not brought into Verse is refused with the same answer whether or not it
 *     exists on disk
 */
import { describe, it, expect } from 'vitest';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';

import {
  VERSE_GITHUB_PR_PLAN_ROUTE,
  VERSE_GITHUB_ROUTE,
  handleVerseGithubApi,
  isVerseGithubPath,
  type VerseGithubApiDeps,
} from '../src/core/verse/github-api.js';
import type { VersePrPlanProposal } from '../src/core/verse/github-proposal.js';
import type { VerseGithubPrPlan, VerseGithubSnapshot } from '../src/core/verse/github-types.js';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface Captured {
  status: number;
  json: unknown;
}

function fakeRes(): { res: ServerResponse; captured: Captured } {
  const captured: Captured = { status: 0, json: null };
  const res = {
    headersSent: false,
    writableEnded: false,
    writeHead(status: number) {
      captured.status = status;
      (this as { headersSent: boolean }).headersSent = true;
      return this;
    },
    end(payload?: string) {
      (this as { writableEnded: boolean }).writableEnded = true;
      if (typeof payload === 'string') {
        try {
          captured.json = JSON.parse(payload) as unknown;
        } catch {
          captured.json = payload;
        }
      }
      return this;
    },
  } as unknown as ServerResponse;
  return { res, captured };
}

const KNOWN_A = '/Users/m/code/ashlr-hub';
const KNOWN_B = join(homedir(), 'code', 'other-repo');

function snapshotFor(paths: readonly string[]): VerseGithubSnapshot {
  return {
    repos: paths.map((path) => ({
      path,
      name: 'stub',
      remote: { state: 'github', nameWithOwner: 'ashlrai/ashlr-hub', defaultBranch: 'main' },
      prs: [],
      issues: [],
      prsAvailable: true,
      issuesAvailable: true,
      observedAt: '2026-09-22T12:00:00.000Z',
      detail: 'stub',
    })),
    observedAt: '2026-09-22T12:00:00.000Z',
  };
}

function planFor(proposalId: string): VerseGithubPrPlan {
  return {
    proposalId,
    state: 'ready',
    kind: 'pr',
    repoPath: KNOWN_A,
    nameWithOwner: 'ashlrai/ashlr-hub',
    branch: `ashlr/proposal/${proposalId}`,
    branchSource: 'predicted',
    base: 'master',
    baseSource: 'predicted',
    title: 'stub',
    bodyPreview: null,
    bodyTruncated: false,
    prUrl: null,
    publishesBranch: true,
    detail: 'stub',
  };
}

function deps(over: VerseGithubApiDeps = {}): VerseGithubApiDeps {
  return {
    knownRoots: () => [KNOWN_A, KNOWN_B],
    read: (paths) => snapshotFor(paths),
    describePlans: (proposals) => proposals.map((p) => planFor(p.id)),
    loadProposal: (id) =>
      id.startsWith('prop-')
        ? ({
            id,
            kind: 'pr',
            repo: KNOWN_A,
            title: 'stub',
            summary: 'stub',
            status: 'pending',
          } satisfies VersePrPlanProposal)
        : null,
    ...over,
  };
}

async function call(
  url: string,
  method = 'GET',
  over: VerseGithubApiDeps = {},
): Promise<Captured & { handled: boolean }> {
  const path = url.split('?')[0] ?? url;
  const { res, captured } = fakeRes();
  const req = { url, method } as IncomingMessage;
  const handled = await handleVerseGithubApi({}, req, res, path, method, deps(over));
  return { ...captured, handled };
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

describe('route matching', () => {
  it('claims exactly the two GitHub routes', () => {
    expect(isVerseGithubPath(VERSE_GITHUB_ROUTE)).toBe(true);
    expect(isVerseGithubPath(VERSE_GITHUB_PR_PLAN_ROUTE)).toBe(true);
    for (const other of [
      '/api/verse/github/',
      '/api/verse/githubs',
      '/api/verse/control',
      '/api/verse/bootstrap',
      '/api/github',
    ]) {
      expect(isVerseGithubPath(other), other).toBe(false);
    }
  });

  it('leaves a foreign path to the next handler', async () => {
    const out = await call('/api/verse/bootstrap');
    expect(out.handled).toBe(false);
    expect(out.status).toBe(0);
  });

  it('is GET-only — nothing on these routes may mutate anything', async () => {
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
      const out = await call(VERSE_GITHUB_ROUTE, method);
      expect(out.handled).toBe(true);
      expect(out.status).toBe(404);
    }
  });
});

// ---------------------------------------------------------------------------
// GET /api/verse/github
// ---------------------------------------------------------------------------

describe('GET /api/verse/github', () => {
  it('reads every root Verse already knows when no repo is named', async () => {
    const out = await call(VERSE_GITHUB_ROUTE);
    expect(out.status).toBe(200);
    const body = out.json as VerseGithubSnapshot;
    // sendJson() → sanitizePublicJson() rewrites the home directory to `~` in
    // every string it emits, so a root under $HOME comes back home-relative.
    expect(body.repos.map((r) => r.path)).toEqual([KNOWN_A, '~/code/other-repo']);
  });

  it('caps how many roots one request can read', async () => {
    const many = Array.from({ length: 30 }, (_, i) => `/tmp/repo-${i}`);
    const out = await call(VERSE_GITHUB_ROUTE, 'GET', { knownRoots: () => many });
    expect((out.json as VerseGithubSnapshot).repos).toHaveLength(12);
  });

  it('reads just the named root when it is one Verse knows', async () => {
    const out = await call(`${VERSE_GITHUB_ROUTE}?repo=${encodeURIComponent(KNOWN_A)}`);
    expect(out.status).toBe(200);
    expect((out.json as VerseGithubSnapshot).repos.map((r) => r.path)).toEqual([KNOWN_A]);
  });

  it('expands a ~ prefix the same way the session routes do', async () => {
    // Asserted on what the reader was HANDED, not on the response: the
    // response has already been home-scrubbed back to `~` by sanitizePublicJson.
    let handed: readonly string[] = [];
    const out = await call(
      `${VERSE_GITHUB_ROUTE}?repo=${encodeURIComponent('~/code/other-repo')}`,
      'GET',
      { read: (paths) => { handed = paths; return snapshotFor(paths); } },
    );
    expect(out.status).toBe(200);
    expect(handed).toEqual([KNOWN_B]);
    expect(KNOWN_B.startsWith('~')).toBe(false);
  });

  it('refuses a root the operator never brought into Verse, without touching disk', async () => {
    let read = false;
    const out = await call(`${VERSE_GITHUB_ROUTE}?repo=${encodeURIComponent('/etc')}`, 'GET', {
      read: (paths) => { read = true; return snapshotFor(paths); },
    });
    expect(out.status).toBe(409);
    expect(out.json).toMatchObject({ code: 'VERSE_REFUSED' });
    expect(read).toBe(false);
  });

  it('answers a non-existent path exactly as it answers an existing one', async () => {
    // Same refusal either way, so the route cannot be used to probe the disk.
    const missing = await call(`${VERSE_GITHUB_ROUTE}?repo=${encodeURIComponent('/no/such/dir')}`);
    const real = await call(`${VERSE_GITHUB_ROUTE}?repo=${encodeURIComponent('/etc')}`);
    expect(missing.status).toBe(409);
    expect(missing.json).toEqual(real.json);
  });

  it('cannot emit a token even if one somehow reached a snapshot string', async () => {
    // Defence in depth. github-repo.ts never reads a remote URL or gh's
    // stderr, so a credential should not be reachable at all — but every
    // response still leaves through sendJson() → sanitizePublicJson(), and
    // this pins that the GitHub routes are not an exception to it.
    const out = await call(VERSE_GITHUB_ROUTE, 'GET', {
      read: (paths) => {
        const snap = snapshotFor(paths);
        const repo = snap.repos[0];
        if (repo) repo.detail = 'origin https://x-access-token:ghp_0123456789abcdefghij@github.com/o/r';
        return snap;
      },
    });
    const serialized = JSON.stringify(out.json);
    expect(serialized).not.toContain('ghp_0123456789abcdefghij');
    expect(serialized).toContain('[REDACTED]');
  });

  it('rejects an empty or absurd repo parameter', async () => {
    expect((await call(`${VERSE_GITHUB_ROUTE}?repo=`)).status).toBe(400);
    const long = '/' + 'x'.repeat(5_000);
    expect((await call(`${VERSE_GITHUB_ROUTE}?repo=${encodeURIComponent(long)}`)).status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// GET /api/verse/github/pr-plan
// ---------------------------------------------------------------------------

describe('GET /api/verse/github/pr-plan', () => {
  it('returns the disclosure for one proposal', async () => {
    const out = await call(`${VERSE_GITHUB_PR_PLAN_ROUTE}?id=prop-1-a`);
    expect(out.status).toBe(200);
    const body = out.json as { plans: VerseGithubPrPlan[] };
    expect(body.plans).toHaveLength(1);
    expect(body.plans[0]).toMatchObject({
      proposalId: 'prop-1-a',
      branch: 'ashlr/proposal/prop-1-a',
      publishesBranch: true,
    });
  });

  it('takes several ids at once, de-duplicated, so a list view needs one call', async () => {
    const out = await call(`${VERSE_GITHUB_PR_PLAN_ROUTE}?id=prop-1,prop-2,prop-1`);
    const body = out.json as { plans: VerseGithubPrPlan[] };
    expect(body.plans.map((p) => p.proposalId)).toEqual(['prop-1', 'prop-2']);
  });

  it('drops an id it cannot find instead of failing the whole request', async () => {
    const out = await call(`${VERSE_GITHUB_PR_PLAN_ROUTE}?id=prop-1,gone`);
    expect(out.status).toBe(200);
    const body = out.json as { plans: VerseGithubPrPlan[] };
    expect(body.plans.map((p) => p.proposalId)).toEqual(['prop-1']);
  });

  it('requires an id', async () => {
    expect((await call(VERSE_GITHUB_PR_PLAN_ROUTE)).status).toBe(400);
    expect((await call(`${VERSE_GITHUB_PR_PLAN_ROUTE}?id=`)).status).toBe(400);
    expect((await call(`${VERSE_GITHUB_PR_PLAN_ROUTE}?id=,,`)).status).toBe(400);
  });

  it('refuses an id shaped like a path or a query', async () => {
    for (const id of ['../../etc/passwd', 'prop 1', 'prop/1', 'prop-1&x=1', 'x'.repeat(200)]) {
      const out = await call(`${VERSE_GITHUB_PR_PLAN_ROUTE}?id=${encodeURIComponent(id)}`);
      expect(out.status, id).toBe(400);
      expect(out.json).toMatchObject({ code: 'VERSE_INVALID' });
    }
  });

  it('bounds how many plans one request can ask for', async () => {
    const ids = Array.from({ length: 60 }, (_, i) => `prop-${i}`).join(',');
    const out = await call(`${VERSE_GITHUB_PR_PLAN_ROUTE}?id=${ids}`);
    expect(out.status).toBe(400);
  });

  it('survives a loader that throws', async () => {
    const out = await call(`${VERSE_GITHUB_PR_PLAN_ROUTE}?id=prop-1`, 'GET', {
      loadProposal: () => { throw new Error('inbox unreadable'); },
    });
    expect(out.status).toBe(200);
    expect((out.json as { plans: unknown[] }).plans).toEqual([]);
  });
});
