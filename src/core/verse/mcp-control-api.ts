/**
 * core/verse/mcp-control-api.ts — the HTTP surface for MCP and per-account
 * CLI management.
 *
 * Deliberately a SEPARATE handler from `control-api.ts` rather than new arms
 * on its `if`-chain: that file is owned by another work stream, and this one
 * carries a mutation that installs arbitrary code. Keeping them apart means
 * the review surface for "can the hub run new code" is one file.
 *
 * ── Route shape ─────────────────────────────────────────────────────────────
 *
 *   GET  /api/verse/mcp              which servers each seat would load
 *   GET  /api/verse/mcp/cli-health   per-account auth, plan and version drift
 *   POST /api/verse/mcp/cli-probe    read the installed CLI versions (SPAWNS)
 *   POST /api/verse/mcp/proposal     validate + disclose a write (writes nothing)
 *   POST /api/verse/mcp/apply        perform the write the digest confirms
 *
 * The two GETs are free: no subprocess, no provider call, no write. Everything
 * that costs something or changes something is a POST behind
 * `passesMutationGate`, including `cli-probe` — it launches up to four vendor
 * binaries, and a read route that does that is a side effect in disguise.
 *
 * `proposal` is a POST for the same reason, even though it writes nothing: it
 * carries an operator-supplied command in its body, and it is the step that
 * must be authenticated for the resulting digest to mean anything.
 *
 * ── Ordering requirement ────────────────────────────────────────────────────
 *
 * These paths live under `/api/verse/*`, which `isVerseApiPath()` matches
 * wholesale and 404s when it does not recognise. So the dispatch call in
 * `src/core/web/api.ts` MUST come before both `isVerseControlPath` and
 * `isVerseApiPath`. See the comment at that call site.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';

import { passesMutationGate, readBody, sendJson } from '../web/api.js';
import { audit } from '../sandbox/audit.js';
import type { AshlrConfig } from '../types.js';
import { buildVerseAccountsSnapshot, readVerseAccountIdentities } from './accounts.js';
import { getVerseAccountCollector } from './accounts.js';
import { defaultAccountsRoot, resolveAccountsRoot } from './seats.js';
import { buildVerseMcpSnapshot, type VerseMcpSeatInput } from './mcp-seat-view.js';
import { readVerseMcpScopeGate } from './mcp-scope.js';
import {
  buildVerseCliHealth,
  probeVerseAccountCliVersions,
  type VerseCliVersionReading,
} from './mcp-cli-health.js';
import {
  applyVerseMcpProposal,
  buildVerseMcpProposal,
  type VerseMcpApplyResult,
  type VerseMcpProposal,
  type VerseMcpRefusalResult,
} from './mcp-mutation.js';

const MCP_PREFIX = '/api/verse/mcp';

const MCP_ROUTES = new Set([
  MCP_PREFIX,
  `${MCP_PREFIX}/cli-health`,
  `${MCP_PREFIX}/cli-probe`,
  `${MCP_PREFIX}/proposal`,
  `${MCP_PREFIX}/apply`,
]);

/** True for exactly the five MCP-management routes. */
export function isVerseMcpPath(path: string): boolean {
  return MCP_ROUTES.has(path);
}

export interface VerseMcpApiContext {
  cfg: AshlrConfig;
  token: string;
  allowDispatch: boolean;
  readSession?: { id: string; expiresAt: number };
  /** Test seam: override the accounts root without touching config. */
  accountsRoot?: string;
}

// ---------------------------------------------------------------------------
// Local copies of the control-plane's response helpers.
//
// control-api.ts copied these from verse-api.ts rather than sharing them, for
// the stated reason that each half must behave identically without one owning
// the other's error vocabulary. Same posture here.
// ---------------------------------------------------------------------------

type VerseMcpErrorCode = 'VERSE_INVALID' | 'VERSE_REFUSED' | 'VERSE_TOO_LARGE' | 'VERSE_UNAVAILABLE';

const ERROR_STATUS: Record<VerseMcpErrorCode, 400 | 409 | 413 | 503> = {
  VERSE_INVALID: 400,
  VERSE_REFUSED: 409,
  VERSE_TOO_LARGE: 413,
  VERSE_UNAVAILABLE: 503,
};

function sendError(res: ServerResponse, code: VerseMcpErrorCode, error: string): void {
  sendJson(res, ERROR_STATUS[code], { code, error });
}

function sendInvalid(res: ServerResponse, error: string): void {
  sendError(res, 'VERSE_INVALID', error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

async function readJsonBody(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<Record<string, unknown> | null> {
  let raw: string;
  try {
    raw = await readBody(req);
  } catch {
    sendError(res, 'VERSE_TOO_LARGE', 'request body too large');
    return null;
  }
  let parsed: unknown;
  try {
    parsed = raw.length === 0 ? {} : (JSON.parse(raw) as unknown);
  } catch {
    sendInvalid(res, 'invalid JSON body');
    return null;
  }
  if (!isRecord(parsed)) {
    sendInvalid(res, 'body must be a JSON object');
    return null;
  }
  return parsed;
}

function passesPostGate(
  ctx: VerseMcpApiContext,
  req: IncomingMessage,
  res: ServerResponse,
): boolean {
  if (!ctx.allowDispatch) {
    sendJson(res, 404, { error: 'not found' });
    return false;
  }
  return passesMutationGate(req, res, ctx.token);
}

// ---------------------------------------------------------------------------
// Shared reads
// ---------------------------------------------------------------------------

function accountsRootFor(ctx: VerseMcpApiContext): string {
  if (ctx.accountsRoot !== undefined) return ctx.accountsRoot;
  try {
    return resolveAccountsRoot(ctx.cfg);
  } catch {
    return defaultAccountsRoot();
  }
}

/**
 * Seat inputs for the MCP view, WITHOUT running `discoverSeats()`.
 *
 * `discoverSeats` probes Ollama over HTTP and builds telemetry — none of which
 * this view needs, and all of which would make a cheap read expensive. What
 * the MCP question turns on is (engine, account), and that is exactly what
 * `readVerseAccountIdentities` publishes. Seat ids for native seats ARE the
 * account ids (see VerseSeat.id's own documentation).
 *
 * Local seats are collapsed into ONE row on purpose: every Ollama tag is
 * launched through the same `buildClaudeLaunch` argv, so they are all isolated
 * identically and listing twelve identical rows would be noise, not detail.
 */
export function verseMcpSeatInputs(accountsRoot: string): VerseMcpSeatInput[] {
  const seats: VerseMcpSeatInput[] = readVerseAccountIdentities(accountsRoot).map((identity) => ({
    id: identity.id,
    label: identity.label,
    engine: identity.provider,
    accountId: identity.id,
  }));
  seats.push({
    id: 'local',
    label: 'Local seats (every Ollama tag)',
    engine: 'local',
    accountId: 'local',
  });
  return seats;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * Handle one MCP-management request. Returns true when a response was
 * written (including errors); false when `path` is not one of these routes.
 */
export async function handleVerseMcpApi(
  ctx: VerseMcpApiContext,
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  method: string,
): Promise<boolean> {
  if (!isVerseMcpPath(path)) return false;

  try {
    const accountsRoot = accountsRootFor(ctx);

    // ── GET /api/verse/mcp ────────────────────────────────────────────────
    if (path === MCP_PREFIX) {
      if (method !== 'GET') {
        sendJson(res, 404, { error: `not found: ${method} ${path}` });
        return true;
      }
      sendJson(res, 200, buildVerseMcpSnapshot({
        accountsRoot,
        seats: verseMcpSeatInputs(accountsRoot),
      }));
      return true;
    }

    // ── GET /api/verse/mcp/cli-health ─────────────────────────────────────
    //
    // Free: derived entirely from the collector's existing records plus the
    // pinned-version constant. No subprocess. A version NUMBER requires the
    // probe below; its absence is reported as `unverified`, never faked.
    if (path === `${MCP_PREFIX}/cli-health`) {
      if (method !== 'GET') {
        sendJson(res, 404, { error: `not found: ${method} ${path}` });
        return true;
      }
      const snapshot = buildVerseAccountsSnapshot({
        accountsRoot,
        collector: getVerseAccountCollector(),
      });
      sendJson(res, 200, buildVerseCliHealth({ accounts: snapshot.accounts }));
      return true;
    }

    // ── POST /api/verse/mcp/cli-probe ─────────────────────────────────────
    //
    // Gated because it SPAWNS: help/version invocations only, but four vendor
    // binaries is a real cost and a real side effect on this machine.
    if (path === `${MCP_PREFIX}/cli-probe`) {
      if (method !== 'POST') {
        sendJson(res, 404, { error: `not found: ${method} ${path}` });
        return true;
      }
      if (!passesPostGate(ctx, req, res)) return true;
      const body = await readJsonBody(req, res);
      if (!body) return true;
      for (const key of Object.keys(body)) {
        sendInvalid(res, `unknown key: ${key}`);
        return true;
      }

      let readings: ReadonlyMap<string, VerseCliVersionReading>;
      try {
        readings = await probeVerseAccountCliVersions({ accountsRoot });
      } catch {
        sendError(res, 'VERSE_UNAVAILABLE', 'the CLI version probe could not be run');
        return true;
      }
      const snapshot = buildVerseAccountsSnapshot({
        accountsRoot,
        collector: getVerseAccountCollector(),
      });
      const health = buildVerseCliHealth({ accounts: snapshot.accounts, readings });
      audit({
        action: 'verse.mcp.cli-probe',
        repo: null,
        sandboxId: null,
        summary: `read CLI versions for ${readings.size} account(s); drift=${health.driftDetected}`,
        result: 'ok',
      });
      sendJson(res, 200, health);
      return true;
    }

    // ── POST /api/verse/mcp/proposal ──────────────────────────────────────
    //
    // Writes NOTHING. Returns the full command, args and env KEYS (values
    // redacted), the warnings, the Locus scope, and the digest that the apply
    // step demands back.
    if (path === `${MCP_PREFIX}/proposal` || path === `${MCP_PREFIX}/apply`) {
      const applying = path === `${MCP_PREFIX}/apply`;
      if (method !== 'POST') {
        sendJson(res, 404, { error: `not found: ${method} ${path}` });
        return true;
      }
      if (!passesPostGate(ctx, req, res)) return true;
      const body = await readJsonBody(req, res);
      if (!body) return true;

      const allowed = applying
        ? new Set(['target', 'server', 'digest', 'confirm'])
        : new Set(['target', 'server']);
      for (const key of Object.keys(body)) {
        if (!allowed.has(key)) {
          sendInvalid(res, `unknown key: ${key}`);
          return true;
        }
      }

      const target = body['target'];
      if (typeof target !== 'string' || target.length === 0 || target.length > 128) {
        sendInvalid(res, 'target is required');
        return true;
      }
      if (body['server'] === undefined) {
        sendInvalid(res, 'server is required');
        return true;
      }

      const scope = readVerseMcpScopeGate();

      if (!applying) {
        const proposal = buildVerseMcpProposal({
          targetId: target,
          server: body['server'],
          accountsRoot,
          scope,
        });
        sendRefusableResult(res, proposal);
        return true;
      }

      // An explicit `confirm: true` on top of the digest. The digest is the
      // real control; this is the second half of "never a one-click install"
      // being visible in the request itself.
      if (body['confirm'] !== true) {
        sendInvalid(res, 'confirm must be true to apply a proposal');
        return true;
      }
      const supplied = body['digest'];
      if (typeof supplied !== 'string' || supplied.length === 0 || supplied.length > 128) {
        sendInvalid(res, 'digest is required to apply a proposal');
        return true;
      }

      const result = applyVerseMcpProposal({
        targetId: target,
        server: body['server'],
        accountsRoot,
        scope,
        digest: supplied,
      });

      // The audit summary names the target and the server NAME. It never
      // carries the command, args or env — `stripSecrets` is a backstop, not
      // a licence to hand it a secret.
      const serverName = isRecord(body['server']) && typeof body['server']['name'] === 'string'
        ? body['server']['name']
        : '(unnamed)';
      audit({
        action: 'verse.mcp.apply',
        repo: null,
        sandboxId: null,
        summary: result.ok
          ? `${result.action} MCP server ${serverName} in ${result.target.ref}`
          : `refused MCP server ${serverName} for ${target}: ${result.refusal}`,
        result: result.ok ? 'ok' : 'refused',
      });

      sendRefusableResult(res, result);
      return true;
    }

    /* c8 ignore next 2 -- isVerseMcpPath already narrowed to the five routes. */
    sendJson(res, 404, { error: `not found: ${method} ${path}` });
    return true;
  } catch {
    sendError(res, 'VERSE_UNAVAILABLE', 'MCP management is unavailable on this server');
    return true;
  }
}

/**
 * A refusal is a 409 carrying the full result body with a plain-language
 * `note` — the same convention `VerseScopeResult` established, which the web
 * client relies on when it reads `error` and falls back to `note`.
 */
function sendRefusableResult(
  res: ServerResponse,
  result: VerseMcpProposal | VerseMcpApplyResult | VerseMcpRefusalResult,
): void {
  sendJson(res, result.ok ? 200 : 409, result);
}
