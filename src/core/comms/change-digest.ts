/**
 * 3.14: change-driven fleet digest.
 *
 * The old 6-hourly digest repeated "0 proposals… Top concern: Fleet health
 * looks nominal… Vision progress: 0%… κ=0.00 ⚠ low-kappa" whether or not
 * anything happened, and called an idle fleet "nominal". This one speaks only
 * when something changed since the last digest:
 *
 *   merges landed · fleet PRs opened · reverts (landed or failed) · seats
 *   exhausted / reset · cloud tasks finished · (listed alongside) a new
 *   Leader memo — a memo alone never triggers a digest, since it reaches
 *   Mason as its own message
 *
 * with concrete numbers and PR links. Otherwise it stays silent — except that
 * once the fleet has done no work for more than 24 h it sends at most ONE
 * honest line per idle stretch ("Fleet idle 3d: autonomy is off — next step:
 * `ashlr authority setup`"). No judge κ / vision-% lines: they were noise.
 *
 * Every source is a LOCAL read (authority ledger, inbox, cloud task store,
 * capacity snapshot, Leader memos, standing policy) — no git, no network, no
 * model. Sources are injectable for tests. State (what was already reported)
 * lives in ~/.ashlr/comms/digest-state.json. Never throws.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Facts
// ---------------------------------------------------------------------------

export type DigestEventKind = 'merge' | 'pr-opened' | 'revert' | 'revert-failed' | 'cloud' | 'memo';

export interface DigestEvent {
  /** Stable identity — an event is reported once. */
  key: string;
  kind: DigestEventKind;
  /** ISO time it happened. */
  at: string;
  /** One line, plain text. */
  text: string;
  url?: string;
  /** Counts as fleet WORK for idle detection (a memo or seat change does not). */
  work: boolean;
}

export interface DigestSeat {
  seatId: string;
  label: string;
  exhausted: boolean;
  /** When / how it resets, when known. */
  resetHint: string | null;
}

export interface DigestFacts {
  events: DigestEvent[];
  /** null = capacity snapshot unavailable (seat changes are then not judged). */
  seats: DigestSeat[] | null;
  autonomy: { on: boolean; mode: string | null };
}

export interface DigestSources {
  /** Ledger entries since `sinceIso` for the given kinds (oldest first). */
  ledger?: (sinceIso: string) => Promise<Array<{ kind: string; at: string; repo: string | null; data: unknown }>>;
  /** Proposals with status 'applied' (inbox). */
  appliedProposals?: () => Array<Record<string, unknown>>;
  proposalTitle?: (id: string) => string | null;
  cloudTasks?: () => Array<Record<string, unknown>>;
  capacity?: () => { seats: Array<Record<string, unknown>> } | null;
  memos?: () => Array<{ id: string; at: string; status: string; move: { statement: string } | null; bottleneck: { statement: string } | null }>;
  autonomy?: () => { on: boolean; mode: string | null };
}

const LEDGER_KINDS = ['merge:landed', 'pr:opened', 'revert:landed', 'revert:failed'] as const;
const MAX_ITEMS_PER_SECTION = 5;
const IDLE_MS = 24 * 3_600_000;
/** Look-back overlap so an event written just before the last check is not missed (keys dedupe). */
const OVERLAP_MS = 3_600_000;

function clip(text: string, max: number): string {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function prUrl(repo: string | null | undefined, n: unknown): string | undefined {
  if (!repo || !/^[\w.-]+\/[\w.-]+$/.test(repo) || typeof n !== 'number' || !Number.isSafeInteger(n) || n <= 0) return undefined;
  return `https://github.com/${repo}/pull/${n}`;
}

function parsePrUrl(url: unknown): { repo: string; n: number } | null {
  if (typeof url !== 'string') return null;
  const m = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/.exec(url);
  return m ? { repo: m[1]!, n: Number(m[2]) } : null;
}

/**
 * Resolve every source: an override wins; otherwise the default local reader
 * (dynamic imports resolved up front so the readers themselves stay sync). A
 * reader whose module fails to load degrades to "nothing to report".
 */
async function resolveSources(overrides: DigestSources): Promise<Required<DigestSources>> {
  const base: Required<DigestSources> = {
    ledger: async (sinceIso) => {
      const { readLedger } = await import('../authority/ledger.js');
      const res = await readLedger({ sinceAt: sinceIso, kinds: [...LEDGER_KINDS] });
      return res.entries.map((e) => ({ kind: e.kind, at: e.at, repo: e.repo, data: e.data }));
    },
    appliedProposals: () => [],
    proposalTitle: () => null,
    cloudTasks: () => [],
    capacity: () => null,
    memos: () => [],
    autonomy: () => ({ on: false, mode: null }),
  };
  const safe = async (fn: () => Promise<void>): Promise<void> => {
    try {
      await fn();
    } catch {
      // keep the empty default
    }
  };
  if (!overrides.appliedProposals || !overrides.proposalTitle) {
    await safe(async () => {
      const store = await import('../inbox/store.js');
      base.appliedProposals = () => store.listProposals({ status: 'applied' }) as unknown as Array<Record<string, unknown>>;
      base.proposalTitle = (id) => {
        try {
          return store.loadProposal(id)?.title ?? null;
        } catch {
          return null;
        }
      };
    });
  }
  if (!overrides.cloudTasks) {
    await safe(async () => {
      const { listCloudTasks } = await import('../cloud/store.js');
      base.cloudTasks = () => listCloudTasks(200) as unknown as Array<Record<string, unknown>>;
    });
  }
  if (!overrides.capacity) {
    await safe(async () => {
      const { readCapacitySnapshot } = await import('../routing/budget-store.js');
      base.capacity = () => readCapacitySnapshot() as unknown as { seats: Array<Record<string, unknown>> } | null;
    });
  }
  if (!overrides.memos) {
    await safe(async () => {
      const { readRecentMemos } = await import('../vision/leader-memo.js');
      base.memos = () => readRecentMemos(5);
    });
  }
  if (!overrides.autonomy) {
    await safe(async () => {
      const { currentStandingPolicy } = await import('../authority/effective-config.js');
      base.autonomy = () => {
        const p = currentStandingPolicy();
        return p ? { on: true, mode: p.switch } : { on: false, mode: null };
      };
    });
  }
  return { ...base, ...(Object.fromEntries(Object.entries(overrides).filter(([, v]) => typeof v === 'function')) as DigestSources) };
}

function call<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

/** Gather everything that happened since `sinceMs`. Never throws. */
export async function collectDigestFacts(sinceMs: number, overrides: DigestSources = {}): Promise<DigestFacts> {
  const src = await resolveSources(overrides);
  const sinceIso = new Date(sinceMs).toISOString();
  const events: DigestEvent[] = [];
  const seen = new Set<string>();
  const push = (e: DigestEvent): void => {
    if (seen.has(e.key)) return;
    seen.add(e.key);
    events.push(e);
  };

  // Ledger: merges, PRs opened, reverts.
  let ledger: Awaited<ReturnType<Required<DigestSources>['ledger']>> = [];
  try {
    ledger = await src.ledger(sinceIso);
  } catch {
    ledger = [];
  }
  for (const e of ledger) {
    const d = (e.data ?? {}) as Record<string, unknown>;
    const repo = (typeof d['repo'] === 'string' ? (d['repo'] as string) : e.repo) ?? null;
    if (e.kind === 'merge:landed' || e.kind === 'revert:landed') {
      const n = d['prNumber'];
      const url = prUrl(repo, n);
      const pid = typeof d['proposalId'] === 'string' ? (d['proposalId'] as string) : null;
      const title = pid ? call(() => src.proposalTitle(pid), null) : null;
      const isRevert = e.kind === 'revert:landed' || d['kind'] === 'revert';
      const ref = typeof n === 'number' ? `${repo}#${n}` : `${repo ?? 'repo'} ${String(d['mergeSha'] ?? '').slice(0, 8)}`;
      push({
        key: `pr:${repo}#${String(n ?? d['mergeSha'] ?? d['id'])}:${isRevert ? 'reverted' : 'merged'}`,
        kind: isRevert ? 'revert' : 'merge',
        at: e.at,
        text: `${ref}${title ? ` — ${clip(title, 80)}` : ''}`,
        ...(url ? { url } : {}),
        work: true,
      });
    } else if (e.kind === 'pr:opened') {
      const n = d['number'];
      const url = prUrl(repo, n);
      const isRevert = d['kind'] === 'revert';
      const pid = typeof d['proposalId'] === 'string' ? (d['proposalId'] as string) : null;
      const title = pid ? call(() => src.proposalTitle(pid), null) : null;
      push({
        key: `pr:${repo}#${String(n)}:opened`,
        kind: 'pr-opened',
        at: e.at,
        text: `${repo}#${String(n)}${isRevert ? ' (revert)' : ''}${title ? ` — ${clip(title, 80)}` : ''}`,
        ...(url ? { url } : {}),
        work: true,
      });
    } else if (e.kind === 'revert:failed') {
      push({
        key: `revert-failed:${String(d['landingId'])}`,
        kind: 'revert-failed',
        at: e.at,
        text: `${repo ?? 'repo'}: revert FAILED — ${clip(String(d['reason'] ?? 'no reason'), 120)}`,
        work: true,
      });
    }
  }

  // Inbox: merges that landed through the human/apply path (github-host with a PR URL).
  const applied = call(() => src.appliedProposals(), []);
  for (const p of applied) {
    const rm = p['realizedMerge'] as Record<string, unknown> | undefined;
    if (!rm) continue;
    const recon = rm['reconciliation'] as Record<string, unknown> | undefined;
    const at = String((rm['source'] === 'github-host' ? recon?.['observedAt'] : rm['observedAt']) ?? rm['mergedAt'] ?? '');
    const t = Date.parse(at);
    if (!Number.isFinite(t) || t < sinceMs) continue;
    const parsed = parsePrUrl(rm['prUrl']);
    const key = parsed ? `pr:${parsed.repo}#${parsed.n}:merged` : `local:${String(rm['mergeCommitOid'] ?? p['id'])}:merged`;
    const repo = parsed?.repo ?? (typeof p['repo'] === 'string' ? (p['repo'] as string) : 'repo');
    push({
      key,
      kind: 'merge',
      at,
      text: `${parsed ? `${parsed.repo}#${parsed.n}` : `${repo} (local)`} — ${clip(String(p['title'] ?? ''), 80)}`,
      ...(parsed ? { url: String(rm['prUrl']) } : {}),
      work: true,
    });
  }

  // Cloud tasks that reached a terminal state.
  const terminal = new Set(['merged', 'closed', 'failed', 'expired']);
  for (const task of call(() => src.cloudTasks(), [])) {
    const state = String(task['state'] ?? '');
    if (!terminal.has(state)) continue;
    const at = String(task['updatedAt'] ?? '');
    const t = Date.parse(at);
    if (!Number.isFinite(t) || t < sinceMs) continue;
    const pr = task['pr'] as Record<string, unknown> | null | undefined;
    const url = typeof pr?.['url'] === 'string' ? (pr['url'] as string) : undefined;
    const report = task['report'] as Record<string, unknown> | null | undefined;
    const reasonText = state === 'failed' || state === 'expired'
      ? clip(String(task['stateReason'] ?? task['failure'] ?? report?.['summary'] ?? ''), 100)
      : '';
    push({
      key: `cloud:${String(task['id'])}:${state}`,
      kind: 'cloud',
      at,
      text: `"${clip(String(task['title'] ?? task['id']), 70)}" (${String(task['repo'] ?? '')}) ${state}${reasonText ? ` — ${reasonText}` : ''}`,
      ...(url ? { url } : {}),
      work: true,
    });
  }

  // A new Leader memo.
  const memo = call(() => src.memos(), []).find((m) => m.status === 'ok');
  if (memo && Date.parse(memo.at) >= sinceMs) {
    const headline = memo.move?.statement ?? memo.bottleneck?.statement ?? '';
    push({
      key: `memo:${memo.id}`,
      kind: 'memo',
      at: memo.at,
      text: `${memo.id}${headline ? ` — ${clip(headline, 140)}` : ''}`,
      work: false,
    });
  }

  // Seats.
  let seats: DigestSeat[] | null = null;
  const snap = call(() => src.capacity(), null);
  if (snap && Array.isArray(snap.seats)) {
    seats = [];
    for (const s of snap.seats) {
      if (s['free'] === true || typeof s['seatId'] !== 'string') continue;
      const windows = Array.isArray(s['windows']) ? (s['windows'] as Array<Record<string, unknown>>) : [];
      const full = windows.filter((w) => w['limitReached'] === true || (typeof w['usedPercent'] === 'number' && (w['usedPercent'] as number) >= 100));
      const hintWin = full[0];
      const resetHint = hintWin
        ? typeof hintWin['resetsAt'] === 'string'
          ? `resets ${(hintWin['resetsAt'] as string).slice(0, 16).replace('T', ' ')}`
          : typeof hintWin['resetDescription'] === 'string'
            ? clip(hintWin['resetDescription'] as string, 60)
            : null
        : null;
      seats.push({
        seatId: s['seatId'] as string,
        label: typeof s['label'] === 'string' ? (s['label'] as string) : (s['seatId'] as string),
        exhausted: full.length > 0,
        resetHint,
      });
    }
  }

  const autonomy = call(() => src.autonomy(), { on: false, mode: null });
  return { events, seats, autonomy };
}

// ---------------------------------------------------------------------------
// State + planning (pure)
// ---------------------------------------------------------------------------

export interface DigestState {
  v: 1;
  /** Last time the digest was evaluated (sent or silent). */
  lastCheckAt: string;
  /** Last time a digest was actually posted. */
  lastSentAt: string | null;
  /** Newest fleet-WORK event seen (drives idle detection). */
  lastActivityAt: string;
  /** Event keys already reported (bounded). */
  reported: string[];
  /** Seats that were exhausted at the last check. */
  exhaustedSeats: string[];
  /** The lastActivityAt an idle notice was already sent for (one notice per idle stretch). */
  idleNoticeFor: string | null;
}

const REPORTED_KEEP = 600;

export function autonomyLine(autonomy?: { on: boolean; mode: string | null }): string {
  let a = autonomy;
  if (!a) a = { on: false, mode: null };
  return a.on
    ? `Autonomy: on (${a.mode ?? 'standing grant'})`
    : 'Autonomy: off — next step: `ashlr authority setup`';
}

function fmtDuration(ms: number): string {
  const h = Math.floor(ms / 3_600_000);
  if (h < 48) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

function section(title: string, events: DigestEvent[]): string[] {
  if (events.length === 0) return [];
  const lines = [`${title} (${events.length}):`];
  for (const e of events.slice(0, MAX_ITEMS_PER_SECTION)) lines.push(`• ${e.text}${e.url ? ` ${e.url}` : ''}`);
  if (events.length > MAX_ITEMS_PER_SECTION) lines.push(`• …and ${events.length - MAX_ITEMS_PER_SECTION} more`);
  return lines;
}

export interface DigestPlan {
  /** Message to post, or null for silence. */
  text: string | null;
  reason: 'changes' | 'idle' | 'unchanged' | 'first-run';
  next: DigestState;
}

/**
 * PURE: decide what (if anything) to say. `prev` null = first evaluation
 * (the look-back was the last 24 h; current seat state is recorded silently).
 */
export function planChangeDigest(prev: DigestState | null, facts: DigestFacts, nowMs: number): DigestPlan {
  const nowIso = new Date(nowMs).toISOString();
  const reported = new Set(prev?.reported ?? []);
  const fresh = facts.events.filter((e) => !reported.has(e.key)).sort((a, b) => (a.at < b.at ? -1 : 1));

  // Seat transitions (only judged when we have a baseline and a snapshot).
  const seatLines: string[] = [];
  let exhaustedNow = prev?.exhaustedSeats ?? [];
  if (facts.seats) {
    exhaustedNow = facts.seats.filter((s) => s.exhausted).map((s) => s.seatId).sort();
    if (prev) {
      const before = new Set(prev.exhaustedSeats);
      for (const s of facts.seats) {
        if (s.exhausted && !before.has(s.seatId)) seatLines.push(`• ${s.label} exhausted${s.resetHint ? ` (${s.resetHint})` : ''}`);
        if (!s.exhausted && before.has(s.seatId)) seatLines.push(`• ${s.label} reset — available again`);
      }
    }
  }

  const workAt = fresh.filter((e) => e.work).map((e) => e.at).sort().pop();
  const baselineActivity = prev?.lastActivityAt ?? new Date(nowMs - IDLE_MS).toISOString();
  const lastActivityAt = workAt && workAt > baselineActivity ? workAt : baselineActivity;

  const next: DigestState = {
    v: 1,
    lastCheckAt: nowIso,
    lastSentAt: prev?.lastSentAt ?? null,
    lastActivityAt,
    reported: [...reported, ...fresh.map((e) => e.key)].slice(-REPORTED_KEEP),
    exhaustedSeats: exhaustedNow,
    idleNoticeFor: prev?.idleNoticeFor ?? null,
  };

  // A new memo alone does not warrant a digest: the memo reaches Mason as its
  // own message (with buttons). It is listed when the digest speaks anyway.
  const newsworthy = fresh.some((e) => e.kind !== 'memo') || seatLines.length > 0;
  if (newsworthy) {
    const by = (k: DigestEventKind): DigestEvent[] => fresh.filter((e) => e.kind === k);
    const merges = by('merge');
    const opened = by('pr-opened');
    const reverts = [...by('revert'), ...by('revert-failed')];
    const cloud = by('cloud');
    const memos = by('memo');
    const since = prev?.lastSentAt ?? prev?.lastCheckAt ?? null;
    const counts = [
      merges.length ? `${merges.length} merged` : null,
      opened.length ? `${opened.length} PR${opened.length === 1 ? '' : 's'} opened` : null,
      reverts.length ? `${reverts.length} revert${reverts.length === 1 ? '' : 's'}` : null,
      cloud.length ? `${cloud.length} cloud task${cloud.length === 1 ? '' : 's'} finished` : null,
    ].filter(Boolean);
    const header = `Fleet update${since ? ` since ${since.slice(0, 16).replace('T', ' ')} UTC` : ' (last 24h)'}${counts.length ? `: ${counts.join(', ')}` : ''}`;
    const lines = [
      header,
      ...section('Merged', merges),
      ...section('PRs opened', opened),
      ...section('Reverts', reverts),
      ...section('Cloud tasks finished', cloud),
      ...(seatLines.length ? ['Seats:', ...seatLines] : []),
      ...section('New Leader memo', memos),
    ];
    // Merges and reverts need the fleet to be allowed to act — say so when it is not.
    if (!facts.autonomy.on && (opened.length > 0 || merges.length > 0)) lines.push(autonomyLine(facts.autonomy));
    next.lastSentAt = nowIso;
    // Activity resets the idle stretch.
    if (workAt) next.idleNoticeFor = null;
    return { text: lines.join('\n'), reason: 'changes', next };
  }

  const idleFor = nowMs - Date.parse(lastActivityAt);
  if (idleFor >= IDLE_MS && next.idleNoticeFor !== lastActivityAt) {
    next.idleNoticeFor = lastActivityAt;
    next.lastSentAt = nowIso;
    const span = prev ? fmtDuration(idleFor) : '24h+';
    const text = facts.autonomy.on
      ? `Fleet idle ${span}: nothing merged, opened or finished with autonomy on (${facts.autonomy.mode ?? 'standing grant'}) — check \`ashlr doctor\`.`
      : `Fleet idle ${span}: autonomy is off — next step: \`ashlr authority setup\`.`;
    return { text, reason: 'idle', next };
  }

  return { text: null, reason: prev ? 'unchanged' : 'first-run', next };
}

// ---------------------------------------------------------------------------
// Persistence + entry point
// ---------------------------------------------------------------------------

function statePath(): string {
  return join(homedir(), '.ashlr', 'comms', 'digest-state.json');
}

export function readDigestState(): DigestState | null {
  try {
    if (!existsSync(statePath())) return null;
    const s = JSON.parse(readFileSync(statePath(), 'utf8')) as Partial<DigestState>;
    if (s.v !== 1 || typeof s.lastCheckAt !== 'string' || typeof s.lastActivityAt !== 'string') return null;
    return {
      v: 1,
      lastCheckAt: s.lastCheckAt,
      lastSentAt: typeof s.lastSentAt === 'string' ? s.lastSentAt : null,
      lastActivityAt: s.lastActivityAt,
      reported: Array.isArray(s.reported) ? s.reported.filter((k) => typeof k === 'string') : [],
      exhaustedSeats: Array.isArray(s.exhaustedSeats) ? s.exhaustedSeats.filter((k) => typeof k === 'string') : [],
      idleNoticeFor: typeof s.idleNoticeFor === 'string' ? s.idleNoticeFor : null,
    };
  } catch {
    return null;
  }
}

function writeDigestState(s: DigestState): void {
  try {
    mkdirSync(join(homedir(), '.ashlr', 'comms'), { recursive: true });
    writeFileSync(statePath(), JSON.stringify(s) + '\n', { encoding: 'utf8', mode: 0o600 });
  } catch {
    // best-effort
  }
}

export interface ChangeDigestResult {
  posted: boolean;
  reason: DigestPlan['reason'];
  text: string | null;
  requestId: string | null;
}

/**
 * Evaluate the digest and queue it as an informational report when there is
 * something to say. Never throws.
 */
export async function runChangeDigest(opts: { nowMs?: number; sources?: DigestSources } = {}): Promise<ChangeDigestResult> {
  const nowMs = opts.nowMs ?? Date.now();
  try {
    const prev = readDigestState();
    const sinceMs = prev ? Date.parse(prev.lastCheckAt) - OVERLAP_MS : nowMs - IDLE_MS;
    const facts = await collectDigestFacts(Number.isFinite(sinceMs) ? sinceMs : nowMs - IDLE_MS, opts.sources);
    const plan = planChangeDigest(prev, facts, nowMs);
    let requestId: string | null = null;
    if (plan.text) {
      const { postRequest } = await import('./requests.js');
      requestId = postRequest({
        kind: 'fleet-digest',
        type: 'report',
        text: plan.text,
        options: [],
        meta: { source: 'digest', reason: plan.reason, generatedAt: new Date(nowMs).toISOString() },
      });
    }
    writeDigestState(plan.next);
    return { posted: plan.text !== null, reason: plan.reason, text: plan.text, requestId };
  } catch {
    return { posted: false, reason: 'unchanged', text: null, requestId: null };
  }
}
