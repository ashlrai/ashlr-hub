/**
 * Leader API — V3.10 Track B (unit U8). Mounted by C0 at VERSE_LEADER_PATH.
 *
 *   GET  /api/verse/leader              → LeaderStateV1 (memo card, Mind timeline
 *                                          with 7-day outcomes and hit-rate,
 *                                          action log, standards, directives)
 *   GET  /api/verse/leader/memos/<id>   → one full LeaderMemo
 *   POST /api/verse/leader              → exactly one of:
 *        {action:'run'}                         start a manual run (202; runs in
 *                                               the background — a memo takes minutes)
 *        {action:'veto', actionId, note?}       undo one action (or cancel it
 *                                               inside its veto window)
 *        {action:'veto-memo', memoId, note?}    undo every live action of a memo
 *        {action:'dismiss', itemId}             clear a Leader ask / question from
 *                                               Needs-you (additive to the frozen
 *                                               LeaderActionRequest; UI-only state)
 *
 * SECURITY. Every POST sits behind the dispatch + mutation-token gate (the C0
 * mount runs it first; this module re-checks, like every Verse module). A veto
 * only LOWERS what autonomy is doing, so it needs nothing more (I1) — and it
 * can never raise anything the ledger cannot vouch for (leader-apply.ts).
 * `run` spends at most one Leader call on a seat the router allows; with no
 * standing grant that is a free local model or nothing. Unknown keys are 400s;
 * every response goes through sendJson → sanitizePublicJson.
 *
 * NEEDS-YOU (cross-track R1). `needsYouItems()` is PURE and answers from an
 * in-memory cache, because activity calls it on every poll: it never does I/O
 * on the caller's stack. The cache is refreshed asynchronously (at most every
 * 10 s, triggered by a poll that finds it stale, and immediately after any
 * change this process makes).
 *
 * First poll. Activity lazy-imports this module on its first poll and reads
 * the producer right after the import resolves, so the module's evaluation
 * AWAITS the first cache load (bounded — see LEADER_WARM_WAIT_MS): the first
 * answer is then real, not a guess. Should the load still be running (a very
 * slow disk), `needsYouItems()` returns [] rather than throwing — a throw made
 * every cold start show the Leader source as errored in the drawer — and
 * `needsYouSourceState()` says 'warming' so a caller that can show it does.
 * A load that FAILED (not merely "no files yet") still throws: activity then
 * reports `sources.leader: 'error'`, never a false all-clear on broken state.
 */
import { readFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';

import type { ApiModule } from './api-modules.js';
import type { VerseApiContext } from './verse-api.js';
import type { NeedsYouItem } from './workbench-types.js';
import { passesMutationGate, readBody, sendJson } from '../web/api.js';
import { VERSE_LEADER_PATH, type LeaderAction, type LeaderMemo } from '../vision/leader-types.js';
import { leaderRoot, listMemoIds, readLeaderMemo } from '../vision/leader-memo.js';

// ---------------------------------------------------------------------------
// Needs-you (pure builder + cache)
// ---------------------------------------------------------------------------

const TITLE_MAX = 120;
const DETAIL_MAX = 400;
const ITEM_WINDOW_MS = 7 * 86_400_000;
const SPEND_RAISING = new Set(['budget.mode', 'lanes.grok', 'lanes.codex']);

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function localClock(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function subjectFor(action: LeaderAction): NeedsYouItem['subject'] {
  const p = action.params as unknown as Record<string, unknown>;
  const task = p['task'] as { repo?: unknown } | undefined;
  const repo = typeof p['repo'] === 'string' ? p['repo'] : task && typeof task.repo === 'string' ? task.repo : null;
  const pr = action.kind === 'pr.close' && Number.isInteger(p['number']) ? (p['number'] as number) : null;
  return { repo, pr, seatId: null, sessionId: null, engine: null };
}

const LEADER_TARGET: NeedsYouItem['target'] = { kind: 'section', section: 'command', anchor: 'leader' };

function dismissAction(itemId: string): NeedsYouItem['actions'][number] {
  return {
    kind: 'done',
    label: 'Dismiss',
    request: { method: 'POST', path: VERSE_LEADER_PATH, body: { action: 'dismiss', itemId } },
    confirm: null,
    destructive: false,
  };
}

/**
 * The Leader's Needs-you items. PURE over its inputs:
 *   - `veto-window`   — each class-B action still inside its window (Veto);
 *   - `class-c`       — each ask outside the grant from the last 7 days (Dismiss);
 *   - `leader-question` — the newest memo's questionsForMason, for 7 days (Dismiss).
 */
export function buildLeaderNeedsYou(
  actions: readonly LeaderAction[],
  latestMemo: Pick<LeaderMemo, 'id' | 'at' | 'status' | 'questionsForMason'> | null,
  dismissed: ReadonlySet<string>,
  nowMs: number,
): NeedsYouItem[] {
  // Order: veto windows by how soon they apply (the most urgent first), then
  // asks newest first, then the memo's questions in the memo's order.
  const windows: NeedsYouItem[] = [];
  const asks: NeedsYouItem[] = [];
  for (const action of actions) {
    if (action.status === 'scheduled' && action.class === 'B' && action.applyAfter && Date.parse(action.applyAfter) > nowMs) {
      windows.push({
        id: `leader:veto-window:${action.id}`,
        source: 'leader',
        kind: 'veto-window',
        severity: SPEND_RAISING.has(action.kind) ? 'high' : 'warn',
        title: clip(`Leader: ${action.summary} — applies at ${localClock(action.applyAfter)}`, TITLE_MAX),
        detail: action.why ? clip(action.why, DETAIL_MAX) : null,
        since: action.createdAt,
        expiresAt: action.applyAfter,
        subject: subjectFor(action),
        target: LEADER_TARGET,
        actions: [{
          kind: 'veto',
          label: 'Veto',
          request: { method: 'POST', path: VERSE_LEADER_PATH, body: { action: 'veto', actionId: action.id } },
          confirm: { title: 'Veto this Leader action?', body: clip(action.summary, DETAIL_MAX), confirmLabel: 'Veto' },
          destructive: true,
        }],
      });
      continue;
    }
    if (action.status === 'escalated' && nowMs - Date.parse(action.createdAt) <= ITEM_WINDOW_MS) {
      const id = `leader:class-c:${action.id}`;
      if (dismissed.has(id)) continue;
      const p = action.params as unknown as Record<string, unknown>;
      const argument = typeof p['argument'] === 'string' ? p['argument'] : action.why;
      const why = [argument, action.statusReason].filter((s): s is string => typeof s === 'string' && s.length > 0).join(' — ');
      asks.push({
        id,
        source: 'leader',
        kind: 'class-c',
        severity: 'warn',
        title: clip(`Leader asks: ${typeof p['request'] === 'string' ? p['request'] : action.summary}`, TITLE_MAX),
        detail: why ? clip(why, DETAIL_MAX) : null,
        since: action.createdAt,
        expiresAt: null,
        subject: subjectFor(action),
        target: LEADER_TARGET,
        actions: [dismissAction(id)],
      });
    }
  }
  const questions: NeedsYouItem[] = [];
  if (latestMemo && latestMemo.status === 'ok' && nowMs - Date.parse(latestMemo.at) <= ITEM_WINDOW_MS) {
    latestMemo.questionsForMason.forEach((question, index) => {
      const id = `leader:leader-question:${latestMemo.id}:${index}`;
      if (dismissed.has(id)) return;
      questions.push({
        id,
        source: 'leader',
        kind: 'leader-question',
        severity: 'info',
        title: clip(`Leader question: ${question}`, TITLE_MAX),
        detail: question.length > TITLE_MAX - 17 ? clip(question, DETAIL_MAX) : null,
        since: latestMemo.at,
        expiresAt: null,
        subject: { repo: null, pr: null, seatId: null, sessionId: null, engine: null },
        target: { kind: 'section', section: 'mind', anchor: latestMemo.id },
        actions: [dismissAction(id)],
      });
    });
  }
  windows.sort((a, b) => Date.parse(a.expiresAt!) - Date.parse(b.expiresAt!) || a.id.localeCompare(b.id));
  asks.sort((a, b) => Date.parse(b.since) - Date.parse(a.since) || a.id.localeCompare(b.id));
  return [...windows, ...asks, ...questions];
}

interface LeaderCache {
  loadedAt: number;
  /** leaderRoot() at load time: a cache from another HOME is never served. */
  root: string;
  actions: LeaderAction[];
  latestMemo: LeaderMemo | null;
  latestMemoAt: string | null;
  dismissed: Set<string>;
}

let cache: LeaderCache | null = null;
let refreshing: Promise<void> | null = null;
/** The last refresh threw (unreadable memo dir, …); cleared by the next good load. */
let refreshFailed = false;
const CACHE_TTL_MS = 10_000;

/** Refresh the needs-you cache from disk, off the caller's stack (async fs). */
export function refreshLeaderCache(): Promise<void> {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    try {
      const root = leaderRoot();
      let actions: LeaderAction[] = [];
      let dismissed = new Set<string>();
      try {
        const text = await readFile(`${leaderRoot()}/actions.json`, 'utf8');
        const parsed = JSON.parse(text) as { actions?: { action?: LeaderAction }[]; dismissed?: { id?: string }[] };
        actions = (parsed.actions ?? []).flatMap((s) => (s.action && typeof s.action.id === 'string' ? [s.action] : [])).reverse();
        dismissed = new Set((parsed.dismissed ?? []).flatMap((d) => (typeof d.id === 'string' ? [d.id] : [])));
      } catch { /* no store yet = no actions */ }
      // Newest memo: ids sort by timestamp, so only the first readable one is opened.
      let latestMemo: LeaderMemo | null = null;
      let latestMemoAt: string | null = null;
      for (const id of listMemoIds().slice(0, 5)) {
        try {
          const memo = JSON.parse(await readFile(`${leaderRoot()}/memos/${id}.json`, 'utf8')) as LeaderMemo;
          if (latestMemoAt === null) latestMemoAt = memo.at;
          if (memo.status === 'ok') {
            latestMemo = memo;
            break;
          }
        } catch { /* skip unreadable */ }
      }
      cache = { loadedAt: Date.now(), root, actions, latestMemo, latestMemoAt, dismissed };
      refreshFailed = false;
    } catch (err) {
      refreshFailed = true;
      throw err;
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}

/** The cache for the CURRENT HOME, or null (never loaded, or loaded for another HOME). */
function currentCache(): LeaderCache | null {
  return cache && cache.root === leaderRoot() ? cache : null;
}

function ensureFresh(): void {
  const current = currentCache();
  if (!current || Date.now() - current.loadedAt > CACHE_TTL_MS) void refreshLeaderCache().catch(() => undefined);
}

/**
 * How long module evaluation waits for the first cache load. The load is one
 * small JSON file plus at most five memo files; this bound only matters on a
 * pathological disk, where a late import is worse than one warming poll.
 */
const LEADER_WARM_WAIT_MS = 750;

async function warmOnLoad(): Promise<void> {
  let timer: NodeJS.Timeout | null = null;
  try {
    await Promise.race([
      refreshLeaderCache().catch(() => undefined),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, LEADER_WARM_WAIT_MS);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// Top-level await: activity's lazy import resolves only once the cache is
// warm (or the bound passes), so its first poll serves real items.
await warmOnLoad();

/** Producer state for the drawer: 'warming' until the first load for this HOME finishes. */
export type LeaderNeedsYouSourceState = 'warming' | 'ok' | 'error';

export function needsYouSourceState(): LeaderNeedsYouSourceState {
  if (currentCache()) return 'ok';
  return refreshFailed ? 'error' : 'warming';
}

/**
 * R1: the Leader's items for the Needs-you drawer. Pure and cached (see the
 * file header): [] while the first load is still running, and a throw only
 * when loading actually failed.
 */
export function needsYouItems(): NeedsYouItem[] {
  ensureFresh();
  const current = currentCache();
  if (!current) {
    if (refreshFailed) throw new Error('leader state could not be read');
    return [];
  }
  return buildLeaderNeedsYou(current.actions, current.latestMemo, current.dismissed, Date.now());
}

/**
 * ISO time of the newest memo, for the rail's Mind dot (C1's activity route).
 * Pure, served from the same cache. null = none / not loaded yet.
 */
export function latestMemoAt(): string | null {
  ensureFresh();
  return currentCache()?.latestMemoAt ?? null;
}

/** Test hook: drop the cache (the next call reloads). */
export function resetLeaderApiCacheForTest(): void {
  cache = null;
  refreshing = null;
  refreshFailed = false;
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

type LeaderModule = typeof import('../vision/leader.js');
type ApplyModule = typeof import('../vision/leader-apply.js');

interface LeaderApiHooks {
  loadRunDeps?: (ctx: VerseApiContext) => Promise<import('../vision/leader.js').LeaderRunDeps>;
  now?: () => number;
}

let hooks: LeaderApiHooks = {};

/** Test hook: inject deps (fakes for the ledger, seats, …). Pass {} to restore. */
export function setLeaderApiHooksForTest(next: LeaderApiHooks): void {
  hooks = next;
}

const MEMO_PATH_RE = /^\/api\/verse\/leader\/memos\/(lm-\d{14}-[a-f0-9]{6})$/;
const NOTE_MAX = 500;

function sendInvalid(res: ServerResponse, message: string): void {
  sendJson(res, 400, { code: 'VERSE_INVALID', error: message });
}

function hasOnlyKeys(body: Record<string, unknown>, allowed: readonly string[]): string | null {
  for (const key of Object.keys(body)) if (!allowed.includes(key)) return key;
  return null;
}

async function readMutationBody(ctx: VerseApiContext, req: IncomingMessage, res: ServerResponse): Promise<Record<string, unknown> | null> {
  if (!ctx.allowDispatch) {
    sendJson(res, 404, { error: 'not found' });
    return null;
  }
  if (!passesMutationGate(req, res, ctx.token)) return null;
  let raw: string;
  try {
    raw = await readBody(req);
  } catch {
    sendJson(res, 413, { code: 'VERSE_TOO_LARGE', error: 'request body too large' });
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

function parseNote(value: unknown): string | null | undefined {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value.length > NOTE_MAX) return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

async function modules(): Promise<{ leader: LeaderModule; apply: ApplyModule }> {
  const [leader, apply] = await Promise.all([import('../vision/leader.js'), import('../vision/leader-apply.js')]);
  return { leader, apply };
}

async function runDeps(ctx: VerseApiContext, leader: LeaderModule): Promise<import('../vision/leader.js').LeaderRunDeps> {
  return hooks.loadRunDeps ? hooks.loadRunDeps(ctx) : leader.loadDefaultLeaderRunDeps(ctx.cfg);
}

export const handleLeaderApi: ApiModule = async (ctx, req, res, path, method) => {
  if (path !== VERSE_LEADER_PATH && !path.startsWith(`${VERSE_LEADER_PATH}/`)) return false;
  const now = hooks.now ?? Date.now;
  try {
    if (method === 'GET') {
      if ([...new URL(req.url ?? '/', 'http://localhost').searchParams.keys()].length > 0) {
        sendInvalid(res, 'this route takes no query parameters');
        return true;
      }
      if (path === VERSE_LEADER_PATH) {
        const { leader } = await modules();
        sendJson(res, 200, leader.buildLeaderState(now()));
        return true;
      }
      const m = MEMO_PATH_RE.exec(path);
      if (m) {
        const memo = readLeaderMemo(m[1]!);
        if (!memo) sendJson(res, 404, { error: 'no such memo' });
        else sendJson(res, 200, memo);
        return true;
      }
      return false;
    }

    if (method !== 'POST' || path !== VERSE_LEADER_PATH) return false;
    const body = await readMutationBody(ctx, req, res);
    if (!body) return true;
    const action = body['action'];
    const { leader, apply } = await modules();

    if (action === 'run') {
      const extra = hasOnlyKeys(body, ['action']);
      if (extra) {
        sendInvalid(res, `unknown key: ${extra}`);
        return true;
      }
      if (leader.leaderRunInFlight()) {
        sendJson(res, 409, { code: 'LEADER_BUSY', error: 'A Leader run is already in progress.' });
        return true;
      }
      const deps = await runDeps(ctx, leader);
      // Manual runs bypass the unchanged-evidence skip (Mason asked), but not
      // the 3-runs-a-day cap or the seat rules.
      void leader.runLeader(deps, 'manual', { force: true })
        .then(() => refreshLeaderCache())
        .catch(() => undefined);
      sendJson(res, 202, { accepted: true, state: leader.buildLeaderState(now()) });
      return true;
    }

    if (action === 'veto' || action === 'veto-memo') {
      const idKey = action === 'veto' ? 'actionId' : 'memoId';
      const extra = hasOnlyKeys(body, ['action', idKey, 'note']);
      if (extra) {
        sendInvalid(res, `unknown key: ${extra}`);
        return true;
      }
      const id = body[idKey];
      const idRe = action === 'veto' ? /^la-\d{14}-[a-f0-9]{6}-\d{1,3}$/ : /^lm-\d{14}-[a-f0-9]{6}$/;
      if (typeof id !== 'string' || !idRe.test(id)) {
        sendInvalid(res, `${idKey} is malformed`);
        return true;
      }
      const note = parseNote(body['note']);
      if (note === undefined) {
        sendInvalid(res, `note must be a string of at most ${NOTE_MAX} characters`);
        return true;
      }
      const deps = await runDeps(ctx, leader);
      const result = action === 'veto'
        ? await apply.vetoLeaderAction(deps.apply, id, note)
        : await apply.vetoLeaderMemo(deps.apply, id, note);
      await refreshLeaderCache();
      if (!result.ok) {
        sendJson(res, result.code, { code: result.code === 404 ? 'VERSE_NOT_FOUND' : 'LEADER_NOTHING_TO_VETO', error: result.message });
        return true;
      }
      sendJson(res, 200, { result, state: leader.buildLeaderState(now()) });
      return true;
    }

    if (action === 'dismiss') {
      const extra = hasOnlyKeys(body, ['action', 'itemId']);
      if (extra) {
        sendInvalid(res, `unknown key: ${extra}`);
        return true;
      }
      const itemId = body['itemId'];
      if (typeof itemId !== 'string' || !/^leader:(?:class-c|leader-question):[A-Za-z0-9:._-]{1,160}$/.test(itemId)) {
        sendInvalid(res, 'itemId is not a dismissible Leader item');
        return true;
      }
      apply.dismissNeedsYouItem(itemId, new Date(now()).toISOString());
      await refreshLeaderCache();
      sendJson(res, 200, { dismissed: itemId });
      return true;
    }

    sendInvalid(res, 'action must be one of: run, veto, veto-memo, dismiss');
    return true;
  } catch {
    sendJson(res, 500, { error: 'leader request failed' });
    return true;
  }
};
