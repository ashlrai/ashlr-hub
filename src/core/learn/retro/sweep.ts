/**
 * The retro sweep (3.15): find task ends that have no retro yet, write one
 * each, and queue their candidate notes for Mason's review.
 *
 * WHY a sweep and not hooks in every terminal transition: the ends are
 * written by Tier-1 code (the standing merge pass, the post-merge watch, the
 * Leader's veto path) and by the cloud lane that other work is changing. All
 * of them already RECORD what happened — the authority ledger (gate rows,
 * PR closes, landings, post-merge verdicts, reverts), the inbox (verify
 * results, decision reasons), the cloud task files (state, stateReason,
 * report) and the Leader's action log (veto notes). Reading those after the
 * fact needs no change to any of them, and a retro id derived from the end's
 * source key makes the sweep idempotent: running it twice writes nothing new.
 *
 *   fleet   gate:result refuse / owner-lane  → gate-refused | verify-failed | owner-laned
 *           merge:landed                     → merged
 *           revert:landed (+ post-merge row) → reverted
 *           pr:closed (not after a refusal)  → closed
 *           inbox rejected / failed proposals the ledger did not cover
 *   cloud   tasks in merged / closed / failed / expired (not superseded by a fleet PR)
 *   devin   the same, for Devin tasks (3.15; the cloud extractor with lane
 *           'devin', keyed `devin:<taskId>:<state>`)
 *   leader  actions vetoed / refused / failed
 *
 * Bounded: a 30-day window, ≤ 40 new retros per sweep, the model pass (when
 * enabled) ≤ RETRO_MODEL_CALLS_PER_DAY. Never throws: a source that fails is
 * reported in `unavailable` and the others still run.
 */
import type { LedgerEntry, LedgerReadOptions, LedgerReadResult } from '../../authority/types.js';
import type { CloudTaskV1 } from '../../cloud/types.js';
import type { DevinTaskV1 } from '../../devin/types.js';
import type { Proposal } from '../../types.js';
import type { LeaderAction } from '../../vision/leader-types.js';
import { diffPaths, retroFromCloud, retroFromFleet, retroFromLeader, retroFromExecutionFailure, type FleetEndInput } from './extract.js';
import type { ExecutionFeedbackSnapshot } from '../../fleet/execution-feedback.js';
import { enqueueCandidates } from './knowledge.js';
import { RETRO_MODEL_CALLS_PER_DAY, loadRetroModel, refineRetro, type RetroModel } from './model.js';
import { pruneRetros, readSweepState, retroExists, retroIdFor, saveRetro, writeSweepState } from './store.js';
import type { RetroV1 } from './types.js';
import { isPlaybookRef, type PlaybookRef } from '../../playbooks/types.js';

export type SweepProposal = Pick<Proposal, 'id' | 'title' | 'summary' | 'status' | 'createdAt'> &
  Partial<Pick<Proposal, 'diff' | 'verifyResult' | 'decidedAt' | 'result' | 'decisionReason' | 'engineModel' | 'runId'>>;

export interface RetroSweepDeps {
  now(): number;
  /** Optional exact terminal attempt source; independent of proposals/authority decisions. */
  executionFeedback?(opts: { sinceMs: number; nowMs: number }): ExecutionFeedbackSnapshot;
  readLedger(opts: LedgerReadOptions): Promise<LedgerReadResult>;
  /** Rejected + failed inbox proposals (bounded by the reader). */
  decidedProposals(): SweepProposal[];
  loadProposal(id: string): SweepProposal | null;
  cloudTasks(): CloudTaskV1[];
  /**
   * 3.15: Devin task ends (production: devin/store.ts listDevinTasks(500)).
   * Optional so a caller that predates the Devin lane — or a test that does
   * not care — reads no Devin store at all rather than the real one.
   */
  devinTasks?(): DevinTaskV1[];
  leaderActions(): LeaderAction[];
  /** null = deterministic only. */
  model: RetroModel | null;
  /**
   * Playbook uses by `lane:key` (playbooks/store.ts). Fleet retros are
   * attributed through the proposal's runId; absent = no attribution.
   */
  playbookUses?(): Promise<ReadonlyMap<string, { ref: PlaybookRef }>>;
  /**
   * Optional Jev pass (src/core/decide): prime typed task kinds for the texts
   * the extractors classify, in one batched call. Absent = keyword table only.
   */
  primeTaskKinds?(texts: readonly string[]): Promise<unknown>;
  /**
   * Optional Jev pass: root-cause CATEGORIES for the retros about to be saved
   * (generic codes via Jev, others via a fixed table). Never changes the
   * deterministic `code`/`label`; only adds `category` + `categorySource`.
   */
  labelRootCauses?(retros: readonly RetroV1[]): Promise<ReadonlyMap<string, { category: string; source: 'jev' | 'rule' }>>;
}

export interface RetroSweepResult {
  created: number;
  candidates: number;
  modelRefined: number;
  /** Sources that could not be read this sweep (the others still ran). */
  unavailable: string[];
  sweptAt: string;
}

export const RETRO_SWEEP_WINDOW_DAYS = 30;
export const RETRO_SWEEP_MAX_NEW = 40;

const LEDGER_KINDS = ['gate:result', 'pr:opened', 'pr:closed', 'merge:landed', 'post-merge:result', 'revert:landed'] as const;

function localDay(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function proposalFacts(p: SweepProposal | null): Pick<FleetEndInput, 'title' | 'summary' | 'paths' | 'engine' | 'verify'> {
  if (!p) return { title: null, summary: null, paths: [], engine: null, verify: null };
  const v = p.verifyResult;
  return {
    title: p.title ?? null,
    summary: p.summary ?? null,
    paths: diffPaths(p.diff),
    engine: p.engineModel ?? null,
    verify: v ? { passed: v.passed, failed: v.failed ?? [], detail: v.detail ?? null, failureCategory: v.failureCategory ?? null, ran: (v.ran ?? []).map((r) => ({ kind: r.kind, cmd: r.cmd })) } : null,
  };
}

/** Fleet ends from the authority ledger. Pure over the entries (proposals are looked up through `load`). */
export function fleetEndsFromLedger(entries: readonly LedgerEntry[], load: (id: string) => SweepProposal | null): FleetEndInput[] {
  const out: FleetEndInput[] = [];
  const prToProposal = new Map<string, string>();
  const landings = new Map<string, Extract<LedgerEntry, { kind: 'merge:landed' }>['data']>();
  const postMerge = new Map<string, Extract<LedgerEntry, { kind: 'post-merge:result' }>['data']>();
  const lastRefusal = new Map<string, Extract<LedgerEntry, { kind: 'gate:result' }>>();
  const firstOwnerLane = new Map<string, Extract<LedgerEntry, { kind: 'gate:result' }>>();
  const cache = new Map<string, SweepProposal | null>();
  const facts = (id: string | null) => {
    if (!id) return proposalFacts(null);
    if (!cache.has(id)) {
      let p: SweepProposal | null = null;
      try { p = load(id); } catch { p = null; }
      cache.set(id, p);
    }
    return proposalFacts(cache.get(id) ?? null);
  };

  for (const e of entries) {
    if (e.kind === 'pr:opened' && e.data.proposalId) prToProposal.set(`${e.data.repo.toLowerCase()}#${e.data.number}`, e.data.proposalId);
    else if (e.kind === 'merge:landed') landings.set(e.data.id, e.data);
    else if (e.kind === 'post-merge:result') postMerge.set(e.data.landingId, e.data);
    else if (e.kind === 'gate:result') {
      if (e.data.verdict === 'refuse') lastRefusal.set(e.data.proposalId, e);
      else if (e.data.verdict === 'owner-lane' && !firstOwnerLane.has(e.data.proposalId)) firstOwnerLane.set(e.data.proposalId, e);
    }
  }

  for (const [proposalId, row] of lastRefusal) {
    const f = facts(proposalId);
    const g = row.data;
    out.push({
      proposalId,
      repo: g.repo,
      endKind: g.code === 'verify-failed' && f.verify && !f.verify.passed ? 'verify-failed' : 'gate-refused',
      endedAt: g.at,
      ...f,
      gate: { gate: g.gate, code: g.code, reason: g.reason },
    });
  }
  for (const [proposalId, row] of firstOwnerLane) {
    const g = row.data;
    out.push({ proposalId, repo: g.repo, endKind: 'owner-laned', endedAt: g.at, ...facts(proposalId), gate: { gate: g.gate, code: g.code, reason: g.reason } });
  }
  for (const e of entries) {
    if (e.kind === 'merge:landed' && e.data.kind === 'merge') {
      const id = e.data.proposalId ?? e.data.id;
      out.push({ proposalId: id, repo: e.data.repo, endKind: 'merged', endedAt: e.data.landedAt, ...facts(e.data.proposalId), engine: e.data.producer?.engine ?? facts(e.data.proposalId).engine });
    } else if (e.kind === 'revert:landed' && e.data.revertsLandingId) {
      const original = landings.get(e.data.revertsLandingId) ?? null;
      const pm = postMerge.get(e.data.revertsLandingId) ?? null;
      const id = original?.proposalId ?? e.data.revertsLandingId;
      const f = facts(original?.proposalId ?? null);
      out.push({
        proposalId: id,
        repo: e.data.repo,
        endKind: 'reverted',
        endedAt: e.data.landedAt,
        ...f,
        engine: original?.producer?.engine ?? f.engine,
        postMerge: pm ? { ci: pm.ci, suite: pm.suite, detail: pm.detail } : null,
      });
    } else if (e.kind === 'pr:closed') {
      const proposalId = prToProposal.get(`${e.data.repo.toLowerCase()}#${e.data.number}`) ?? null;
      // A PR the fleet closed after a gate refused its proposal: the refusal retro is the lesson.
      if (proposalId && lastRefusal.has(proposalId)) continue;
      out.push({
        proposalId: proposalId ?? `${e.data.repo}#${e.data.number}`,
        repo: e.data.repo,
        endKind: 'closed',
        endedAt: e.data.at,
        ...facts(proposalId),
        close: { reason: e.data.reason, actor: e.data.actor },
      });
    }
  }
  return out;
}

/** Inbox ends the ledger does not carry (the non-standing paths). */
export function fleetEndsFromInbox(proposals: readonly SweepProposal[], sinceIso: string): FleetEndInput[] {
  const out: FleetEndInput[] = [];
  for (const p of proposals) {
    const endedAt = p.decidedAt ?? p.createdAt;
    if (!endedAt || endedAt < sinceIso) continue;
    const f = proposalFacts(p);
    const repo = null; // inbox rows carry a checkout path, not owner/name; the note scope stays repo-free
    if (p.status === 'failed') {
      out.push({ proposalId: p.id, repo, endKind: 'failed', endedAt, ...f, close: { reason: p.result ?? p.decisionReason ?? 'Applying it failed.', actor: 'daemon' } });
      continue;
    }
    if (p.status !== 'rejected') continue;
    const standing = /^standing gate (G[0-9b]+): ([a-z0-9-]+)$/i.exec(p.decisionReason ?? '');
    if (f.verify && !f.verify.passed) {
      out.push({ proposalId: p.id, repo, endKind: 'verify-failed', endedAt, ...f, gate: standing ? { gate: standing[1]!, code: standing[2]!, reason: p.result ?? '' } : null });
    } else if (standing) {
      out.push({ proposalId: p.id, repo, endKind: 'gate-refused', endedAt, ...f, gate: { gate: standing[1]!, code: standing[2]!, reason: p.result ?? p.decisionReason ?? '' } });
    } else {
      const reason = p.decisionReason ?? (p.result && !/^mason:/.test(p.result) ? p.result : null);
      const byMason = !reason || /^mason:/.test(p.result ?? '');
      out.push({ proposalId: p.id, repo, endKind: 'closed', endedAt, ...f, close: { reason: reason ?? 'Rejected in the inbox.', actor: byMason ? 'mason' : 'daemon' } });
    }
  }
  return out;
}

function leaderRepo(action: LeaderAction): string | null {
  const params = action.params as unknown as Record<string, unknown> | null;
  const repo = params && typeof params['repo'] === 'string' ? params['repo'] : null;
  return repo && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo) ? repo : null;
}

/** Every retro the sources describe (not yet filtered against disk). */
export function collectRetros(parts: {
  ledger: readonly LedgerEntry[] | null;
  inbox: readonly SweepProposal[] | null;
  cloud: readonly CloudTaskV1[] | null;
  /** 3.15: Devin tasks (optional: absent = no Devin lane). */
  devin?: readonly DevinTaskV1[] | null;
  leader: readonly LeaderAction[] | null;
  load: (id: string) => SweepProposal | null;
  sinceIso: string;
  nowIso: string;
}): RetroV1[] {
  const out = new Map<string, RetroV1>();
  const add = (r: RetroV1) => { if (!out.has(r.id)) out.set(r.id, r); };
  // Ledger first: it carries owner/name repos and gate detail the inbox copy lacks.
  if (parts.ledger) for (const end of fleetEndsFromLedger(parts.ledger, parts.load)) add(retroFromFleet(end, parts.nowIso));
  if (parts.inbox) for (const end of fleetEndsFromInbox(parts.inbox, parts.sinceIso)) add(retroFromFleet(end, parts.nowIso));
  // Cloud and Devin tasks share a delivery shape (branch → PR → report), so
  // they share the end rules and the extractor; only the lane differs.
  const lanes: Array<{ lane: 'cloud' | 'devin'; tasks: readonly (CloudTaskV1 | DevinTaskV1)[] }> = [
    { lane: 'cloud', tasks: parts.cloud ?? [] },
    { lane: 'devin', tasks: parts.devin ?? [] },
  ];
  for (const { lane, tasks } of lanes) {
    for (const t of tasks) {
      if (t.state !== 'merged' && t.state !== 'closed' && t.state !== 'failed' && t.state !== 'expired') continue;
      if (t.updatedAt < parts.sinceIso) continue;
      // Closed in favour of the fleet App PR that carries the same change: not an end, a hand-off.
      if (t.state === 'closed' && t.supersededBy) continue;
      // A Devin CHAT (3.15 chat seat) is the operator's conversation, not a delivery:
      // its session expiring or being terminated from Verse is not a failed task end,
      // and scoring it as one taught "No PR delivered" / "Mason closed a Devin change"
      // lessons from ordinary chats. Once a chat opened a PR, the PR's end is a delivery
      // outcome like any other.
      if (lane === 'devin' && t.origin === 'chat' && !t.pr) continue;
      add(withPlaybookRef(retroFromCloud({
        taskId: t.id, repo: t.repo, state: t.state, endedAt: t.updatedAt, title: t.title, prompt: t.prompt,
        stateReason: t.stateReason, failure: t.failure, report: t.report, origin: t.origin, lane,
      }, parts.nowIso), t.playbookRef));
    }
  }
  for (const a of parts.leader ?? []) {
    if (a.status !== 'vetoed' && a.status !== 'failed' && a.status !== 'refused') continue;
    const endedAt = (a.status === 'vetoed' ? a.vetoedAt : null) ?? a.appliedAt ?? a.createdAt;
    if (endedAt < parts.sinceIso) continue;
    add(retroFromLeader({
      actionId: a.id, kind: a.kind, status: a.status, summary: a.summary, why: a.why, endedAt,
      note: a.vetoNote, statusReason: a.statusReason, repo: leaderRepo(a),
    }, parts.nowIso));
  }
  return [...out.values()].sort((a, b) => b.endedAt.localeCompare(a.endedAt));
}

/** Attach the playbook version a task ran under (absent ⇒ the retro is unchanged). */
export function withPlaybookRef(retro: RetroV1, ref: unknown): RetroV1 {
  return isPlaybookRef(ref) ? { ...retro, playbookRef: { id: ref.id, version: ref.version, sha: ref.sha } } : retro;
}

let sweepInFlight: Promise<RetroSweepResult> | null = null;

/** True while a sweep is running in this process (the background timer skips then). */
export function isRetroSweepInFlight(): boolean {
  return sweepInFlight !== null;
}

/** Run one sweep (concurrent callers share the one in flight). */
export function sweepRetros(deps: RetroSweepDeps, opts: { windowDays?: number; maxNew?: number } = {}): Promise<RetroSweepResult> {
  if (sweepInFlight) return sweepInFlight;
  sweepInFlight = runSweep(deps, opts).finally(() => { sweepInFlight = null; });
  return sweepInFlight;
}

async function runSweep(deps: RetroSweepDeps, opts: { windowDays?: number; maxNew?: number }): Promise<RetroSweepResult> {
  const nowMs = deps.now();
  const nowIso = new Date(nowMs).toISOString();
  const sinceIso = new Date(nowMs - (opts.windowDays ?? RETRO_SWEEP_WINDOW_DAYS) * 86_400_000).toISOString();
  const unavailable: string[] = [];
  const guard = <T>(label: string, fn: () => T): T | null => {
    try {
      return fn();
    } catch {
      unavailable.push(label);
      return null;
    }
  };

  let ledger: LedgerEntry[] | null = null;
  try {
    const read = await deps.readLedger({ sinceAt: sinceIso, kinds: LEDGER_KINDS });
    if (read.chain === 'broken') unavailable.push('ledger');
    else ledger = read.entries;
  } catch {
    unavailable.push('ledger');
  }
  const inbox = guard('inbox', () => deps.decidedProposals());
  const cloud = guard('cloud', () => deps.cloudTasks());
  const devinTasks = deps.devinTasks;
  const devin = devinTasks ? guard('devin', () => devinTasks.call(deps)) : null;
  const leader = guard('leader', () => deps.leaderActions());
  const feedback = deps.executionFeedback ? guard('execution-feedback', () => deps.executionFeedback!({ sinceMs: Date.parse(sinceIso), nowMs })) : null;
  if (feedback && !feedback.view.complete) unavailable.push('execution-feedback-partial');
  const executionRetros = (feedback?.view.cases ?? []).flatMap((item) => {
    // No negative join when the inbox inventory is unreadable/partial. A late
    // exact run+trajectory proposal supersedes this no-proposal learning path.
    if (!feedback?.correlations.get(item.caseId)?.proposalJoinComplete) {
      if (item.outcome === 'failed') unavailable.push('execution-proposal-join');
      return [];
    }
    const retro = retroFromExecutionFailure(item, nowIso);
    return retro ? [retro] : [];
  });
  const executionIds = new Set(executionRetros.map((r) => r.id));

  if (deps.primeTaskKinds) {
    // The same strings extract.ts hands classifyTaskKind (fleet: title +
    // summary; cloud/Devin: title + prompt), so its memo lookup hits.
    const texts = [
      ...(inbox ? fleetEndsFromInbox(inbox, sinceIso) : []),
      ...(ledger ? fleetEndsFromLedger(ledger, (id) => deps.loadProposal(id)) : []),
    ].map((e) => `${e.title ?? ''} ${e.summary ?? ''}`)
      .concat([...(cloud ?? []), ...((devin ?? []) as ReadonlyArray<{ title?: string; prompt?: string }>)]
        .map((t) => `${t.title ?? ''} ${t.prompt ?? ''}`));
    if (texts.length > 0) await deps.primeTaskKinds(texts).catch(() => undefined);
  }

  const all = [...collectRetros({ ledger, inbox, cloud, devin, leader, load: (id) => deps.loadProposal(id), sinceIso, nowIso }), ...executionRetros]
    .sort((a, b) => b.endedAt.localeCompare(a.endedAt) || a.id.localeCompare(b.id));
  let uses: ReadonlyMap<string, { ref: PlaybookRef }> | null = null;
  const fleetPlaybook = async (proposalId: string): Promise<PlaybookRef | undefined> => {
    if (!deps.playbookUses) return undefined;
    try {
      uses ??= await deps.playbookUses();
      const runId = deps.loadProposal(proposalId)?.runId;
      return runId ? uses.get(`fleet:${runId}`)?.ref : undefined;
    } catch {
      return undefined;
    }
  };
  const state = await readSweepState();
  const day = localDay(nowMs);
  let calls = state.modelCalls[day] ?? 0;
  let created = 0;
  let candidates = 0;
  let modelRefined = 0;
  const fresh: RetroV1[] = [];
  for (const draft of all) {
    if (fresh.length >= (opts.maxNew ?? RETRO_SWEEP_MAX_NEW)) break;
    if (await retroExists(draft.id)) continue;
    fresh.push(draft);
  }
  let categories: ReadonlyMap<string, { category: string; source: 'jev' | 'rule' }> = new Map();
  const refinable = fresh.filter((r) => !executionIds.has(r.id));
  if (deps.labelRootCauses && refinable.some((r) => r.rootCause)) {
    categories = await deps.labelRootCauses(refinable).catch(() => new Map());
  }
  for (const draft of fresh) {
    const cat = draft.rootCause ? categories.get(draft.id) : undefined;
    const categorized: RetroV1 = cat && draft.rootCause
      ? { ...draft, rootCause: { ...draft.rootCause, category: cat.category, categorySource: cat.source } }
      : draft;
    let retro = categorized.source === 'fleet' && !executionIds.has(categorized.id) ? withPlaybookRef(categorized, await fleetPlaybook(categorized.taskId)) : categorized;
    if (deps.model && calls < RETRO_MODEL_CALLS_PER_DAY && retro.rootCause && retro.source !== 'leader' && !executionIds.has(retro.id)) {
      calls += 1;
      const refined = await refineRetro(retro, deps.model, nowIso);
      if (refined !== retro) modelRefined += 1;
      retro = refined;
    }
    try {
      await saveRetro(retro);
    } catch {
      unavailable.push('retro-store');
      break;
    }
    created += 1;
    try {
      candidates += await enqueueCandidates(retro, nowIso);
    } catch {
      unavailable.push('knowledge-store');
    }
  }
  if (created > 0) await pruneRetros().catch(() => 0);
  const keep: Record<string, number> = {};
  for (const [d, n] of Object.entries({ ...state.modelCalls, [day]: calls })) {
    if (d >= localDay(nowMs - 7 * 86_400_000)) keep[d] = n;
  }
  await writeSweepState({ v: 1, sweptAt: nowIso, lastCreated: created, modelCalls: keep }).catch(() => undefined);
  return { created, candidates, modelRefined, unavailable: [...new Set(unavailable)].sort(), sweptAt: nowIso };
}

/** The production sources, loaded lazily so importing this module stays cheap. */
export async function loadDefaultRetroSweepDeps(cfg: unknown): Promise<RetroSweepDeps> {
  const [ledger, inbox, cloudStore, devinStore, leaderApply, model, playbookStore, feedback] = await Promise.all([
    import('../../authority/ledger.js'),
    import('../../inbox/store.js'),
    import('../../cloud/store.js'),
    import('../../devin/store.js'),
    import('../../vision/leader-apply.js'),
    loadRetroModel(cfg),
    import('../../playbooks/store.js'),
    import('../../fleet/execution-feedback.js'),
  ]);
  return {
    now: () => Date.now(),
    executionFeedback: (opts) => feedback.readExecutionFeedbackSnapshot(opts),
    readLedger: (opts) => ledger.readLedger(opts),
    // Bounded reads: the sweep can run inside the Verse sidecar, whose one
    // thread serves every route, so it never reads the whole inbox at once.
    decidedProposals: () => [
      ...inbox.listProposalsDetailed({ status: 'rejected', maxFiles: 600, maxBytes: 16 * 1024 * 1024 }).proposals,
      ...inbox.listProposalsDetailed({ status: 'failed', maxFiles: 200, maxBytes: 4 * 1024 * 1024 }).proposals,
    ],
    loadProposal: (id) => inbox.loadProposal(id),
    cloudTasks: () => cloudStore.listCloudTasks(500),
    devinTasks: () => devinStore.listDevinTasks(500),
    leaderActions: () => leaderApply.listLeaderActions(300),
    model,
    playbookUses: () => playbookStore.readPlaybookUses(),
    // Jev (src/core/decide): both answer deterministically when unkeyed.
    primeTaskKinds: async (texts) => (await import('../../decide/task-class.js')).primeTaskClasses(texts, cfg ? { cfg: cfg as never } : {}),
    labelRootCauses: async (retros) => (await import('../../decide/retro.js')).labelRetroRootCauses(retros, cfg ? { cfg: cfg as never } : {}),
  };
}

/** Retro id for a source key (re-exported for callers that pre-check). */
export { retroIdFor };
