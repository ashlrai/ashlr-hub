/**
 * Authority API — V3.10 Track B (unit B-U1). Mounted by C0 in verse-api.ts.
 *
 *   GET  /api/verse/authority              → AuthorityStatusV1 (+ effectiveReason)
 *   GET  /api/verse/authority/draft[?kind=new|reapprove]
 *                                          → AuthorityGrantDraft (+ kind, summary, startStageId)
 *   GET  /api/verse/authority/ledger[?limit=&kind=]
 *                                          → { entries, head, chain, brokenAtSeq, reason }
 *   POST /api/verse/authority              → one AuthorityActionRequest → AuthorityStatusV1 (+ result)
 *
 * The Command top bar: the Autonomy switch, Stop, the grant chip and the Touch
 * ID sheet. LOWERING (switch down, stop, revoke) is instant and needs nothing
 * but the Verse mutation token; raising the switch within the installed grant
 * needs nothing more either; raising PAST it answers 409 `grant-required`,
 * and only `grant` / `re-approve` — which ask the custody helper to show the
 * scope in a Touch ID prompt on this Mac — can widen authority. The server
 * signs exactly the draft Mason saw: drafts are kept server-side by digest
 * and the action echoes the digest.
 *
 * Every POST passes the V1 dispatch + mutation-token gate (re-checked here);
 * agents and MCP clients cannot reach these routes. Every response goes
 * through sanitizePublicJson; digests (fields named *digest / hash /
 * prevHash, validated as 64-hex we produced) are restored afterwards because
 * the secret scrubber would otherwise redact them and break the draft round
 * trip.
 *
 * R1 (SPEC-310C): `needsYouItems()` and `autonomyBadge()` answer from a cache
 * refreshed OFF the caller's stack, so C1's activity route never waits on I/O.
 */
import { lstatSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';

import type { ApiModule } from './api-modules.js';
import type { VerseApiContext } from './verse-api.js';
import type { NeedsYouItem, VerseAutonomyBadge } from './workbench-types.js';
import { passesMutationGate, readBody } from '../web/api.js';
import { sanitizePublicJson } from '../util/public-json.js';
import { scrubSecrets } from '../util/scrub.js';
import { clearStop, revokeStandingAndDrain, stopAutonomyAndDrain } from '../authority/clamp.js';
import { custodyStatus, signGrant } from '../authority/custody-client.js';
import {
  displaySurfaceTarget,
  evaluateStandingAuthority,
  invalidateStandingPolicyCache,
  requestAutonomySwitch,
  type StandingEvaluation,
} from '../authority/effective-config.js';
import { ledgerSnapshot, readLedger, withLedgerTransaction } from '../authority/ledger.js';
import {
  buildDefaultGrantPayload,
  buildReapprovalGrantPayload,
  describeGrantScope,
  FLEET_CANARY_REPO,
  installStandingGrant,
  readInstalledGrant,
  standingGrantPayloadDigest,
  type DraftRepoInput,
  type DraftSeatInput,
} from '../authority/standing-grant.js';
import { currentHostBinding, verifyAuthoritySurface } from '../authority/surface.js';
import { STANDING_GRANT_TRUST_ROOTS } from '../authority/trust-roots.js';
import { killSwitchPath, readEnrollmentRegistry } from '../sandbox/policy.js';
import {
  AUTONOMY_SWITCHES,
  LEDGER_EVENT_KINDS,
  VERSE_AUTHORITY_PATH,
  type AuthorityCustodyView,
  type AuthorityGrantDraft,
  type AuthorityGrantView,
  type AuthorityStatusV1,
  type AutonomySwitch,
  type LedgerEventKind,
  type StandingGrantV1,
} from '../authority/types.js';

export const VERSE_AUTHORITY_DRAFT_PATH = `${VERSE_AUTHORITY_PATH}/draft`;
export const VERSE_AUTHORITY_LEDGER_PATH = `${VERSE_AUTHORITY_PATH}/ledger`;

// ---------------------------------------------------------------------------
// Response helpers
// ---------------------------------------------------------------------------

const DIGEST_RE = /^[a-f0-9]{64}$/u;
const DIGEST_KEY_RE = /^(?:hash|prevHash|digest|[A-Za-z]+Digest)$/u;

/**
 * Put back the digests the scrubber redacted. Only values we produced, under
 * keys that by contract hold a sha256 (and only when they are exactly 64
 * lowercase hex), are restored — never an arbitrary string.
 */
function restoreDigests(original: unknown, sanitized: unknown): unknown {
  if (Array.isArray(original) && Array.isArray(sanitized)) {
    return sanitized.map((entry, i) => restoreDigests(original[i], entry));
  }
  if (original && sanitized && typeof original === 'object' && typeof sanitized === 'object') {
    const out = sanitized as Record<string, unknown>;
    for (const [key, value] of Object.entries(original as Record<string, unknown>)) {
      if (!Object.prototype.hasOwnProperty.call(out, key)) continue;
      if (typeof value === 'string' && DIGEST_KEY_RE.test(key) && DIGEST_RE.test(value)) out[key] = value;
      else out[key] = restoreDigests(value, out[key]);
    }
    return out;
  }
  return sanitized;
}

function sendAuthorityJson(res: ServerResponse, status: number, body: unknown): void {
  try {
    const bounded = body && typeof body === 'object' && 'error' in body
      ? { ...(body as Record<string, unknown>), error: String((body as { error: unknown }).error).slice(0, 512) }
      : body;
    const payload = JSON.stringify(restoreDigests(bounded, sanitizePublicJson(bounded)) ?? null);
    res.writeHead(status, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(payload);
  } catch {
    try {
      if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end('{"error":"internal error"}');
    } catch {
      // socket gone
    }
  }
}

function sendInvalid(res: ServerResponse, message: string): void {
  sendAuthorityJson(res, 400, { code: 'VERSE_INVALID', error: message });
}

function readQuery(req: IncomingMessage, res: ServerResponse, allowed: readonly string[]): URLSearchParams | null {
  let params: URLSearchParams;
  try {
    params = new URL(req.url ?? '/', 'http://localhost').searchParams;
  } catch {
    sendInvalid(res, 'invalid query string');
    return null;
  }
  for (const key of new Set(params.keys())) {
    if (!allowed.includes(key)) {
      sendInvalid(res, `unknown query parameter: ${key}`);
      return null;
    }
    if (params.getAll(key).length > 1) {
      sendInvalid(res, `query parameter ${key} may appear only once`);
      return null;
    }
  }
  return params;
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

const CUSTODY_TTL_MS = 60_000;
const CUSTODY_TIMEOUT_MS = 1_500;
const UNKNOWN_CUSTODY: AuthorityCustodyView = Object.freeze({ installed: null, keyInitialized: null, githubApp: null, claudeToken: null });
let custodyCache: { at: number; view: AuthorityCustodyView; keyId: string | null } | null = null;

/** Zero-cost custody probe (unit U2), cached a minute; unknown on any failure. */
async function custodySnapshot(force = false): Promise<{ view: AuthorityCustodyView; keyId: string | null }> {
  const now = Date.now();
  if (!force && custodyCache && now - custodyCache.at < CUSTODY_TTL_MS) return custodyCache;
  let view = UNKNOWN_CUSTODY;
  let keyId: string | null = null;
  try {
    const status = await Promise.race([
      custodyStatus(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('custody status timed out')), CUSTODY_TIMEOUT_MS).unref?.()),
    ]);
    view = { installed: status.installed, keyInitialized: status.keyInitialized, githubApp: status.githubApp, claudeToken: status.claudeToken };
    keyId = status.keyId;
  } catch {
    view = UNKNOWN_CUSTODY;
  }
  custodyCache = { at: now, view, keyId };
  return custodyCache;
}

function grantView(ev: StandingEvaluation): AuthorityGrantView {
  const grant = ev.grant;
  return {
    state: ev.grantState,
    reason: ev.grantReason,
    grantId: grant?.grantId ?? null,
    grantSeq: grant?.grantSeq ?? null,
    keyId: grant?.keyId ?? null,
    issuedAt: grant?.issuedAt ?? null,
    expiresAt: grant?.expiresAt ?? null,
    repos: grant ? grant.repos.map((repo) => ({ ...repo })) : [],
    engines: grant ? [...grant.engines] : [],
    maxMode: grant?.spend.maxMode ?? null,
    stageIds: grant ? grant.rollout.stages.map((stage) => stage.id) : [],
  };
}

function statusFrom(ev: StandingEvaluation, custody: AuthorityCustodyView): AuthorityStatusV1 {
  return {
    v: 1,
    checkedAt: ev.checkedAt,
    switch: ev.switch,
    effectiveSwitch: ev.effectiveSwitch,
    maxSwitchWithoutGrant: ev.maxSwitchWithoutGrant,
    kill: ev.kill,
    grant: grantView(ev),
    rollout: ev.rollout?.progress ?? null,
    policy: ev.policy,
    ledger: { state: ev.ledger.chain, head: ev.ledger.head, reason: ev.ledger.reason },
    custody,
    effectiveReason: ev.effectiveSwitch === ev.switch && ev.grantState === 'active' ? null : ev.inactiveReason ?? ev.grantReason,
  };
}

/**
 * The status as Verse shows it. Evaluated against THIS release when it is a
 * compiled one, else the installed daemon release (the desktop sidecar is a
 * single-file binary) — display only; the daemon verifies its own code.
 */
export async function buildAuthorityStatus(): Promise<{ status: AuthorityStatusV1; evaluation: StandingEvaluation }> {
  const custody = await custodySnapshot();
  const evaluation = evaluateStandingAuthority({ mode: 'cached', surface: displaySurfaceTarget() });
  const status = statusFrom(evaluation, custody.view);
  rememberStatus(status, evaluation);
  return { status, evaluation };
}

// ---------------------------------------------------------------------------
// Needs-you + badge (R1) — served from cache, refreshed off the caller's stack
// ---------------------------------------------------------------------------

const REFRESH_AFTER_MS = 15_000;
const EXPIRY_WARNING_MS = 72 * 60 * 60 * 1000;
const REGRESSION_VISIBLE_MS = 24 * 60 * 60 * 1000;
const SECTION_TARGET = { kind: 'section', section: 'command', anchor: 'autonomy' } as const;
const EMPTY_SUBJECT = Object.freeze({ repo: null, pr: null, seatId: null, sessionId: null, engine: null });

let statusCache: { at: number; status: AuthorityStatusV1; items: NeedsYouItem[]; badge: VerseAutonomyBadge } | null = null;
let refreshing = false;
/** The last refresh failed and nothing was ever cached (needsYouSourceState 'error'). */
let refreshFailed = false;

function killSince(fallback: string): string {
  try {
    return lstatSync(killSwitchPath()).mtime.toISOString();
  } catch {
    return fallback;
  }
}

function capTitle(text: string): string {
  return text.length <= 120 ? text : `${text.slice(0, 117)}…`;
}

function capDetail(text: string | null): string | null {
  if (text === null) return null;
  const clean = scrubSecrets(text);
  return clean.length <= 400 ? clean : `${clean.slice(0, 397)}…`;
}

/** PURE (given the evaluation): what the authority source puts in Needs-you. */
export function authorityNeedsYouItems(status: AuthorityStatusV1, ev: StandingEvaluation, nowMs: number): NeedsYouItem[] {
  const items: NeedsYouItem[] = [];
  const grant = status.grant;
  const renew = [{ kind: 'renew' as const, label: 'Re-approve', request: null, confirm: null, destructive: false }];
  if (status.kill && grant.state === 'active') {
    items.push({
      id: 'authority:kill:stop',
      source: 'authority',
      kind: 'kill',
      severity: 'high',
      title: 'Autonomy is stopped',
      detail: 'Stop is engaged, so nothing autonomous runs until you clear it.',
      since: killSince(status.checkedAt),
      expiresAt: null,
      subject: { ...EMPTY_SUBJECT },
      target: { ...SECTION_TARGET },
      actions: [{
        kind: 'resume',
        label: 'Clear Stop',
        request: { method: 'POST', path: VERSE_AUTHORITY_PATH, body: { action: 'clear-stop' } },
        confirm: { title: 'Clear Stop?', body: 'Autonomy resumes within what the current grant allows.', confirmLabel: 'Clear Stop' },
        destructive: false,
      }],
    });
  }
  const grantKey = grant.grantId ?? 'none';
  if (grant.state === 'paused') {
    const codeChanged = ev.pauseCode === 'authority-code-changed';
    items.push({
      id: `authority:grant:paused:${grantKey}`,
      source: 'authority',
      kind: 'grant',
      severity: 'high',
      title: codeChanged ? 'Authority code changed — re-approve the grant' : 'Standing grant paused — re-approve',
      detail: capDetail(grant.reason),
      since: status.checkedAt,
      expiresAt: grant.expiresAt,
      subject: { ...EMPTY_SUBJECT },
      target: { kind: 'section', section: 'command', anchor: 'authority-grant' },
      actions: renew,
    });
  } else if (grant.state === 'expired' || grant.state === 'invalid') {
    items.push({
      id: `authority:grant:${grant.state}:${grantKey}`,
      source: 'authority',
      kind: 'grant',
      severity: grant.state === 'invalid' ? 'high' : 'warn',
      title: grant.state === 'expired' ? 'Standing grant expired — renew to resume autonomy' : 'Standing grant is not valid',
      detail: capDetail(grant.reason),
      since: grant.state === 'expired' && grant.expiresAt ? grant.expiresAt : status.checkedAt,
      expiresAt: null,
      subject: { ...EMPTY_SUBJECT },
      target: { kind: 'section', section: 'command', anchor: 'authority-grant' },
      actions: renew,
    });
  } else if (grant.state === 'active' && grant.expiresAt) {
    const left = Date.parse(grant.expiresAt) - nowMs;
    if (left > 0 && left <= EXPIRY_WARNING_MS) {
      const hours = Math.max(1, Math.floor(left / 3_600_000));
      items.push({
        id: `authority:grant:expiring:${grantKey}`,
        source: 'authority',
        kind: 'grant',
        severity: 'warn',
        title: `Standing grant expires in ${hours} h — renew`,
        detail: 'One Touch ID renews it for another 30 days, continuing the current rollout stage.',
        since: new Date(Date.parse(grant.expiresAt) - EXPIRY_WARNING_MS).toISOString(),
        expiresAt: grant.expiresAt,
        subject: { ...EMPTY_SUBJECT },
        target: { kind: 'section', section: 'command', anchor: 'authority-grant' },
        actions: renew,
      });
    }
  }
  const move = ev.lastRolloutMove;
  if (grant.state === 'active' && move && move.move === 'regressed' && nowMs - Date.parse(move.enteredAt) <= REGRESSION_VISIBLE_MS) {
    items.push({
      id: `authority:rollout:regressed:${grantKey}:${move.entrySeq}`,
      source: 'authority',
      kind: 'grant',
      severity: 'warn',
      title: capTitle(`Rollout dropped back to stage ${move.stageId}${move.fromStageId ? ` from ${move.fromStageId}` : ''}`),
      detail: capDetail(move.breach),
      since: move.enteredAt,
      expiresAt: new Date(Date.parse(move.enteredAt) + REGRESSION_VISIBLE_MS).toISOString(),
      subject: { ...EMPTY_SUBJECT },
      target: { ...SECTION_TARGET },
      actions: [],
    });
  }
  return items;
}

const MODE_LABEL: Record<AutonomySwitch, string> = { off: 'Off', propose: 'Propose', autonomous: 'Autonomous' };

/** PURE: the rail's Fleet badge. */
export function authorityBadge(status: AuthorityStatusV1): VerseAutonomyBadge {
  const paused = status.grant.state === 'paused' || status.grant.state === 'expired';
  let label: string;
  if (status.kill && status.grant.state === 'active') label = 'Stopped';
  else if (status.grant.state === 'paused') label = 'Paused — re-approve';
  else if (status.grant.state === 'expired') label = 'Grant expired — renew';
  else if (status.effectiveSwitch === 'off') label = status.grant.state === 'active' ? 'Off' : 'Off · no grant';
  else {
    const stage = status.rollout ? ` · stage ${status.rollout.stageId} (${status.rollout.stageIndex + 1}/${status.rollout.stageCount})` : '';
    label = `${MODE_LABEL[status.effectiveSwitch]}${stage}`;
  }
  return { mode: status.switch, paused, stopped: status.kill, label };
}

function rememberStatus(status: AuthorityStatusV1, evaluation: StandingEvaluation): void {
  const nowMs = Date.parse(status.checkedAt) || Date.now();
  statusCache = { at: Date.now(), status, items: authorityNeedsYouItems(status, evaluation, nowMs), badge: authorityBadge(status) };
  refreshFailed = false;
}

function scheduleRefresh(): void {
  if (refreshing) return;
  refreshing = true;
  // setImmediate: the evaluation does synchronous file I/O, and R1 callers
  // must never pay for it on their own stack.
  setImmediate(() => {
    buildAuthorityStatus()
      // The next call retries; the cache keeps its last good answer. With no
      // answer at all, needsYouSourceState() says 'error' instead of 'warming'.
      .catch(() => { refreshFailed = true; })
      .finally(() => { refreshing = false; });
  });
}

/**
 * Producer state for the Needs-you drawer (the same contract as leader-api's
 * and fleet-live-api's): 'warming' until the first refresh lands, 'error' when
 * it failed with nothing cached, else 'ok'. Pure — no I/O, never throws.
 *
 * WHY: before the first refresh needsYouItems() throws, which activity used
 * to report as the source ERRORING on every cold start. Activity now asks
 * this first and shows 'warming' as 'unavailable' — neither a false error
 * nor a false all-clear.
 */
export type AuthorityNeedsYouSourceState = 'warming' | 'ok' | 'error';

export function needsYouSourceState(): AuthorityNeedsYouSourceState {
  if (statusCache) return 'ok';
  return refreshFailed ? 'error' : 'warming';
}

/**
 * R1: grant renewal / expiring / paused ("authority code changed —
 * re-approve"), Stop in force, rollout regressions. Pure, served from cache.
 * Before the first refresh completes it throws (a caller that does not read
 * needsYouSourceState() then sees "not answering", never a false all-clear).
 */
export function needsYouItems(): NeedsYouItem[] {
  if (!statusCache) {
    scheduleRefresh();
    throw new Error('authority status is still loading');
  }
  if (Date.now() - statusCache.at > REFRESH_AFTER_MS) scheduleRefresh();
  return statusCache.items.map((item) => ({ ...item }));
}

/** The rail's Fleet badge, from the same cache; null until the first refresh. */
export function autonomyBadge(): VerseAutonomyBadge | null {
  if (!statusCache) {
    scheduleRefresh();
    return null;
  }
  if (Date.now() - statusCache.at > REFRESH_AFTER_MS) scheduleRefresh();
  return { ...statusCache.badge };
}

/** Test hook: forget the cached status (never changes any authority state). */
export function resetAuthorityApiCachesForTest(): void {
  statusCache = null;
  refreshing = false;
  refreshFailed = false;
  custodyCache = null;
  drafts.clear();
  signingInFlight = false;
}

// ---------------------------------------------------------------------------
// Drafts — what Mason is asked to sign
// ---------------------------------------------------------------------------

export type DraftKind = 'new' | 'reapprove';

export interface AuthorityDraftResponse extends AuthorityGrantDraft {
  kind: DraftKind;
  /** Plain-language scope lines (what the Touch ID sheet lists). */
  summary: string[];
  /** The rung autonomy starts on once signed. */
  startStageId: string;
}

const DRAFT_TTL_MS = 15 * 60 * 1000;
const MAX_DRAFTS = 8;
const drafts = new Map<string, { payload: StandingGrantV1; kind: DraftKind; at: number }>();

function rememberDraft(payload: StandingGrantV1, kind: DraftKind): string {
  const digest = standingGrantPayloadDigest(payload);
  const now = Date.now();
  for (const [key, entry] of drafts) if (now - entry.at > DRAFT_TTL_MS) drafts.delete(key);
  while (drafts.size >= MAX_DRAFTS) drafts.delete(drafts.keys().next().value as string);
  drafts.set(digest, { payload, kind, at: now });
  return digest;
}

export class AuthorityDraftError extends Error {
  constructor(public readonly code: string, message: string, public readonly status = 409) {
    super(message);
  }
}

/** Which compiled key a new grant must name. */
async function signingKeyId(): Promise<string> {
  const roots = STANDING_GRANT_TRUST_ROOTS;
  if (roots.length === 0) {
    throw new AuthorityDraftError('no-trust-roots', 'No custody key is compiled into this build yet — run `ashlr authority setup` and merge the trust-root PR it opens.');
  }
  if (roots.length === 1) return roots[0]!.keyId;
  const custody = await custodySnapshot(true);
  const match = roots.find((root) => root.keyId === custody.keyId);
  if (!match) throw new AuthorityDraftError('custody-key-unknown', 'The custody helper\'s key is not one of the compiled trust roots.');
  return match.keyId;
}

/** Enrolled checkouts → GitHub repos, plus the fleet canary. */
async function draftRepos(): Promise<DraftRepoInput[]> {
  const out: DraftRepoInput[] = [];
  const registry = readEnrollmentRegistry();
  if (registry.state === 'ready') {
    const [{ repoIdentityOfPath }, { detectVerifyCommands }] = await Promise.all([
      import('../fleet/repo-identity.js'),
      import('../run/verify-commands.js'),
    ]);
    for (const path of registry.repos) {
      const nameWithOwner = repoIdentityOfPath(path);
      if (!nameWithOwner) continue;
      let hasVerify: boolean | null = null;
      try {
        hasVerify = detectVerifyCommands(path).length > 0;
      } catch {
        hasVerify = null;
      }
      out.push({ nameWithOwner, visibility: null, hasVerify });
    }
  }
  if (!out.some((repo) => repo.nameWithOwner.toLowerCase() === FLEET_CANARY_REPO)) {
    out.push({ nameWithOwner: FLEET_CANARY_REPO, visibility: 'public', hasVerify: true });
  }
  return out;
}

/** Seats from A9's capacity snapshot; engine-level defaults when none was published yet. */
async function draftSeats(): Promise<DraftSeatInput[]> {
  try {
    const { readCapacitySnapshot } = await import('../routing/budget-store.js');
    const snapshot = readCapacitySnapshot();
    if (snapshot && snapshot.seats.length > 0) return snapshot.seats.map((seat) => ({ seatId: seat.seatId, engine: seat.engine }));
  } catch {
    // fall through to defaults
  }
  return [
    { seatId: 'claude', engine: 'claude' },
    { seatId: 'grok', engine: 'grok' },
    { seatId: 'codex', engine: 'codex' },
    { seatId: 'local', engine: 'local' },
  ];
}

/** The next grantSeq: above every grant any chain (even a broken one) accepted or revoked. */
function nextGrantSeq(): number {
  const result = withLedgerTransaction((tx) => {
    if (tx.snapshot.chain === 'broken') return tx.brokenChainFloor() + 1;
    const index = tx.snapshot.index;
    return Math.max(index.maxAcceptedGrantSeq, index.minGrantSeq - 1, 0) + 1;
  });
  if (!result.ok) throw new AuthorityDraftError('ledger', `The authority ledger is unavailable: ${result.reason}`, 503);
  return result.value;
}

/**
 * Build (and remember) the grant Mason would sign. `auto` continues the
 * installed grant's ladder when it is active, paused or expired, and starts
 * the default ladder from its first rung otherwise (none, revoked, invalid).
 */
export async function buildStandingGrantDraft(kind: DraftKind | 'auto' = 'auto', nowMs = Date.now()): Promise<AuthorityDraftResponse> {
  const keyId = await signingKeyId();
  const hostBinding = currentHostBinding();
  if (!hostBinding) throw new AuthorityDraftError('host-unknown', "This Mac's hardware identity could not be read, so a grant cannot be bound to it.");
  const surface = verifyAuthoritySurface(displaySurfaceTarget(), { fresh: true, nowMs });
  if (!surface.ok) throw new AuthorityDraftError('surface-unverified', surface.reason);
  const evaluation = evaluateStandingAuthority({ mode: 'cached', surface: displaySurfaceTarget(), nowMs });
  const installed = readInstalledGrant();
  const continuable = installed.state === 'ok' && evaluation.grant !== null
    && (evaluation.grantState === 'active' || evaluation.grantState === 'paused' || evaluation.grantState === 'expired');
  const resolved: DraftKind = kind === 'auto' ? (continuable ? 'reapprove' : 'new') : kind;
  if (resolved === 'reapprove' && !continuable) {
    throw new AuthorityDraftError('nothing-to-reapprove', 'There is no active, paused or expired grant to continue — draft a new grant instead.');
  }
  const base = {
    nowMs,
    grantId: randomBytes(16).toString('hex'),
    grantSeq: nextGrantSeq(),
    keyId,
    hostBinding,
    authoritySurfaceDigest: surface.digest,
  };
  let payload: StandingGrantV1;
  if (resolved === 'reapprove' && installed.state === 'ok') {
    const position = evaluation.position?.stageIndex ?? ledgerPositionIndex(installed.envelope.payload);
    payload = buildReapprovalGrantPayload(installed.envelope.payload, position, base);
  } else {
    payload = buildDefaultGrantPayload({ ...base, repos: await draftRepos(), seats: await draftSeats() });
  }
  const digest = rememberDraft(payload, resolved);
  return { payload, digest, kind: resolved, summary: describeGrantScope(payload), startStageId: payload.rollout.stages[0]!.id };
}

/** Rollout position straight from the ledger for a grant that no longer verifies (paused / expired). */
function ledgerPositionIndex(grant: StandingGrantV1): number {
  const moved = ledgerSnapshot('cached').index.rollout.get(grant.grantId);
  if (!moved) return 0;
  const stage = grant.rollout.stages[moved.stageIndex];
  return stage && stage.id === moved.stageId ? moved.stageIndex : 0;
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

const ACTION_KEYS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  switch: ['action', 'to'],
  stop: ['action'],
  'clear-stop': ['action'],
  revoke: ['action', 'reason'],
  grant: ['action', 'draftDigest'],
  're-approve': ['action', 'draftDigest'],
});

const SIGN_TIMEOUT_MS = 3 * 60 * 1000;
let signingInFlight = false;

export type AuthorityActionOutcome =
  | { ok: true; status: number; result: Record<string, unknown> }
  | { ok: false; status: number; code: string; error: string; extra?: Record<string, unknown> };

/** Apply one action as Mason (shared by the POST route and `ashlr authority`). */
export async function applyAuthorityAction(body: Record<string, unknown>): Promise<AuthorityActionOutcome> {
  const action = body['action'];
  if (typeof action !== 'string' || !Object.prototype.hasOwnProperty.call(ACTION_KEYS, action)) {
    return { ok: false, status: 400, code: 'VERSE_INVALID', error: `action must be one of: ${Object.keys(ACTION_KEYS).join(', ')}` };
  }
  const allowed = ACTION_KEYS[action]!;
  for (const key of Object.keys(body)) {
    if (!allowed.includes(key)) return { ok: false, status: 400, code: 'VERSE_INVALID', error: `unknown key for ${action}: ${key}` };
  }
  switch (action) {
    case 'switch': {
      const to = body['to'];
      if (typeof to !== 'string' || !(AUTONOMY_SWITCHES as readonly string[]).includes(to)) {
        return { ok: false, status: 400, code: 'VERSE_INVALID', error: 'to must be off, propose or autonomous' };
      }
      const result = requestAutonomySwitch(to as AutonomySwitch, 'mason', 'set from Verse Command');
      if (!result.ok) {
        return {
          ok: false,
          status: result.code === 'grant-required' ? 409 : result.code === 'invalid' ? 400 : 503,
          code: result.code,
          error: result.reason,
          extra: { maxSwitchWithoutGrant: result.cap },
        };
      }
      return { ok: true, status: 200, result: { switch: result } };
    }
    case 'stop': {
      // WHY THE DRAINING VARIANT WITH drainMs:0: the instant stopAutonomy only
      // STARTS revoking armed host merges (fire-and-forget, a few ms later), so
      // the response could not say whether a prepared merge was cancelled and a
      // HOME change in between skipped it. Awaiting the draining variant revokes
      // them before we answer (mergesRevoked is a number, not null) while
      // drainMs:0 + waitMs:0 keeps the panic button instant: KILL is armed
      // synchronously before the first await and running agents are aborted
      // now; we just do not wait for their leases to be released.
      const result = await stopAutonomyAndDrain({ actor: 'mason', reason: 'Stop pressed in Verse', drainMs: 0, waitMs: 0 });
      invalidateStandingPolicyCache();
      if (!result.armed) return { ok: false, status: 503, code: 'stop-failed', error: `Stop could not be armed: ${result.reason}` };
      return { ok: true, status: 200, result: { stop: result } };
    }
    case 'clear-stop': {
      const result = clearStop({ actor: 'mason', reason: 'Stop cleared in Verse', waitMs: 0 });
      invalidateStandingPolicyCache();
      if (!result.ok) return { ok: false, status: 409, code: 'clear-stop-failed', error: result.reason };
      return { ok: true, status: 200, result: { clearStop: result } };
    }
    case 'revoke': {
      const reason = body['reason'];
      if (reason !== undefined && (typeof reason !== 'string' || reason.length > 300)) {
        return { ok: false, status: 400, code: 'VERSE_INVALID', error: 'reason must be text of at most 300 characters' };
      }
      // Same reasoning as Stop: await the merge revocation (so mergesRevoked is
      // a number), but wait for neither the drain nor the outward-mutation
      // fence — drainMs:0 + waitMs:0 answers instantly. The grant is archived,
      // the switch lowered and KILL armed before the first await regardless.
      const result = await revokeStandingAndDrain({ actor: 'mason', reason: typeof reason === 'string' && reason.trim() ? reason : 'revoked from Verse', drainMs: 0, waitMs: 0 });
      invalidateStandingPolicyCache();
      return { ok: true, status: 200, result: { revoke: result } };
    }
    default: {
      // grant / re-approve
      const digest = body['draftDigest'];
      if (typeof digest !== 'string' || !/^[a-f0-9]{64}$/u.test(digest)) {
        return { ok: false, status: 400, code: 'VERSE_INVALID', error: 'draftDigest must be the 64-hex digest of a draft from GET /api/verse/authority/draft' };
      }
      const draft = drafts.get(digest);
      if (!draft || Date.now() - draft.at > DRAFT_TTL_MS) {
        return { ok: false, status: 409, code: 'draft-expired', error: 'That draft is no longer on file — open the grant sheet again to get a fresh one.' };
      }
      const wanted: DraftKind = action === 'grant' ? 'new' : 'reapprove';
      if (draft.kind !== wanted) {
        return { ok: false, status: 400, code: 'VERSE_INVALID', error: `that draft is a ${draft.kind === 'new' ? 'new grant' : 're-approval'}; use action "${draft.kind === 'new' ? 'grant' : 're-approve'}"` };
      }
      if (signingInFlight) return { ok: false, status: 409, code: 'signing-in-progress', error: 'A Touch ID prompt is already open.' };
      signingInFlight = true;
      try {
        let signed: unknown;
        try {
          signed = await Promise.race([
            signGrant(draft.payload),
            new Promise<never>((_, reject) => setTimeout(() => reject(new Error('the Touch ID prompt timed out')), SIGN_TIMEOUT_MS).unref?.()),
          ]);
        } catch (error) {
          return { ok: false, status: 409, code: 'not-signed', error: `Not signed: ${scrubSecrets((error as Error).message).slice(0, 300)}` };
        }
        const signedPayload = (signed as { payload?: StandingGrantV1 } | null)?.payload;
        if (!signedPayload || standingGrantPayloadDigest(signedPayload) !== digest) {
          return { ok: false, status: 502, code: 'custody-mismatch', error: 'The custody helper signed something other than the draft you saw; nothing was installed.' };
        }
        const installed = installStandingGrant(signed, { surface: displaySurfaceTarget() });
        invalidateStandingPolicyCache();
        if (!installed.ok) return { ok: false, status: 409, code: installed.code, error: installed.reason };
        drafts.delete(digest);
        return { ok: true, status: 200, result: { installed: { grantId: installed.grant.grantId, grantSeq: installed.grant.grantSeq, recovered: installed.recovered } } };
      } finally {
        signingInFlight = false;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

async function readMutationBody(ctx: VerseApiContext, req: IncomingMessage, res: ServerResponse): Promise<Record<string, unknown> | null> {
  if (!ctx.allowDispatch) {
    sendAuthorityJson(res, 404, { error: 'not found' });
    return null;
  }
  if (!passesMutationGate(req, res, ctx.token)) return null;
  let raw: string;
  try {
    raw = await readBody(req);
  } catch {
    sendAuthorityJson(res, 413, { code: 'VERSE_TOO_LARGE', error: 'request body too large' });
    return null;
  }
  let parsed: unknown;
  try {
    parsed = raw.length === 0 ? {} : (JSON.parse(raw) as unknown);
  } catch {
    sendInvalid(res, 'invalid JSON body');
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    sendInvalid(res, 'body must be a JSON object');
    return null;
  }
  return parsed as Record<string, unknown>;
}

const LEDGER_KIND_SET: ReadonlySet<string> = new Set(LEDGER_EVENT_KINDS);

export const handleAuthorityApi: ApiModule = async (ctx, req, res, path, method) => {
  if (path !== VERSE_AUTHORITY_PATH && path !== VERSE_AUTHORITY_DRAFT_PATH && path !== VERSE_AUTHORITY_LEDGER_PATH) return false;
  try {
    if (path === VERSE_AUTHORITY_PATH) {
      if (method === 'GET') {
        if (!readQuery(req, res, [])) return true;
        const { status } = await buildAuthorityStatus();
        sendAuthorityJson(res, 200, status);
        return true;
      }
      if (method === 'POST') {
        const body = await readMutationBody(ctx, req, res);
        if (!body) return true;
        const outcome = await applyAuthorityAction(body);
        if (!outcome.ok) {
          sendAuthorityJson(res, outcome.status, { code: outcome.code, error: outcome.error, ...(outcome.extra ?? {}) });
          return true;
        }
        const { status } = await buildAuthorityStatus();
        sendAuthorityJson(res, outcome.status, { ...status, result: outcome.result });
        return true;
      }
      sendAuthorityJson(res, 404, { error: `not found: ${method} ${path}` });
      return true;
    }
    if (method !== 'GET') {
      sendAuthorityJson(res, 404, { error: `not found: ${method} ${path}` });
      return true;
    }
    if (path === VERSE_AUTHORITY_DRAFT_PATH) {
      const params = readQuery(req, res, ['kind']);
      if (!params) return true;
      const kind = params.get('kind') ?? 'auto';
      if (kind !== 'auto' && kind !== 'new' && kind !== 'reapprove') {
        sendInvalid(res, 'kind must be new or reapprove');
        return true;
      }
      try {
        sendAuthorityJson(res, 200, await buildStandingGrantDraft(kind));
      } catch (error) {
        if (error instanceof AuthorityDraftError) sendAuthorityJson(res, error.status, { code: error.code, error: error.message });
        else sendAuthorityJson(res, 500, { code: 'draft-failed', error: 'the grant draft could not be built' });
      }
      return true;
    }
    // VERSE_AUTHORITY_LEDGER_PATH
    const params = readQuery(req, res, ['limit', 'kind']);
    if (!params) return true;
    const limitRaw = params.get('limit');
    if (limitRaw !== null && !/^\d{1,3}$/u.test(limitRaw)) {
      sendInvalid(res, 'limit must be a whole number from 1 to 500');
      return true;
    }
    const kindRaw = params.get('kind');
    if (kindRaw !== null && !LEDGER_KIND_SET.has(kindRaw)) {
      sendInvalid(res, 'kind must be a ledger event kind');
      return true;
    }
    const limit = limitRaw === null ? 100 : Math.max(1, Math.min(500, Number(limitRaw)));
    const read = await readLedger({ limit, ...(kindRaw ? { kinds: [kindRaw as LedgerEventKind] } : {}) });
    sendAuthorityJson(res, 200, read);
    return true;
  } catch {
    sendAuthorityJson(res, 500, { code: 'authority-failed', error: 'the authority request failed' });
    return true;
  }
};
