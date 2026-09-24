/**
 * Shared fakes for the V3.10 B-U8 Leader tests: an in-memory hash-less
 * ledger, an EffectivePolicy fixture, and LeaderApplyDeps wired to the REAL
 * goal store and A9 budget store (inside the test's tmp HOME) with fakes for
 * every other unit (holds, tasks, GitHub, experiments, harness).
 *
 * Nothing here spawns a process, touches the network, or prompts a seat.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type {
  EffectivePolicy,
  LedgerAppendInput,
  LedgerAppendResult,
  LedgerEntry,
  LedgerEventKind,
  LedgerReadOptions,
  LedgerReadResult,
} from '../../src/core/authority/types.js';
import type { LeaderApplyDeps } from '../../src/core/vision/leader-apply.js';
import type { LeaderAction } from '../../src/core/vision/leader-types.js';
import type { HarnessHypothesis } from '../../src/core/learn/harness-types.js';
import type { RepoHold } from '../../src/core/fleet/fleet-types.js';
import * as goalsStore from '../../src/core/goals/store.js';
import * as budgetStore from '../../src/core/routing/budget-store.js';
import { sanitizeBudgetPolicy } from '../../src/core/routing/policy.js';

export function useTmpHome(): { home: () => string; setup: () => void; teardown: () => void } {
  let dir = '';
  let saved: string | undefined;
  return {
    home: () => dir,
    setup: () => {
      saved = process.env['HOME'];
      dir = mkdtempSync(join(tmpdir(), 'leader-310b-'));
      process.env['HOME'] = dir;
    },
    teardown: () => {
      process.env['HOME'] = saved;
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* tmp */ }
    },
  };
}

export interface FakeLedger {
  entries: LedgerEntry[];
  failAppends: boolean;
  failReads: boolean;
  append<K extends LedgerEventKind>(input: LedgerAppendInput<K>): LedgerAppendResult<K>;
  read(opts?: LedgerReadOptions): Promise<LedgerReadResult>;
  rows<K extends LedgerEventKind>(kind: K): Extract<LedgerEntry, { kind: K }>['data'][];
}

export function fakeLedger(): FakeLedger {
  const ledger: FakeLedger = {
    entries: [],
    failAppends: false,
    failReads: false,
    append(input) {
      if (ledger.failAppends) return { ok: false, reason: 'ledger offline (test)' };
      const entry = {
        v: 1,
        seq: ledger.entries.length,
        at: new Date().toISOString(),
        actor: input.actor,
        grantId: input.grantId,
        repo: input.repo,
        prevHash: '0'.repeat(64),
        hash: String(ledger.entries.length).padStart(64, '0'),
        kind: input.kind,
        // Deep copy: a row is immutable once written.
        data: JSON.parse(JSON.stringify(input.data)),
      } as unknown as LedgerEntry;
      ledger.entries.push(entry);
      return { ok: true, entry } as never;
    },
    async read(opts) {
      if (ledger.failReads) throw new Error('ledger unreadable (test)');
      let entries = ledger.entries;
      if (opts?.kinds) entries = entries.filter((e) => opts.kinds!.includes(e.kind));
      if (opts?.sinceAt) entries = entries.filter((e) => e.at >= opts.sinceAt!);
      return { entries, head: null, chain: entries.length === 0 ? 'empty' : 'ok', brokenAtSeq: null, reason: null };
    },
    rows(kind) {
      return ledger.entries.filter((e) => e.kind === kind).map((e) => e.data) as never;
    },
  };
  return ledger;
}

export function makePolicy(overrides: Partial<EffectivePolicy> = {}): EffectivePolicy {
  return {
    v: 1,
    grantId: 'a'.repeat(32),
    grantSeq: 1,
    keyId: 'mason-se',
    issuedAt: '2026-09-20T00:00:00.000Z',
    expiresAt: '2026-10-20T00:00:00.000Z',
    switch: 'autonomous',
    rollout: { stageId: 'full', stageIndex: 4, stageCount: 5, enteredAt: '2026-09-21T00:00:00.000Z' },
    repos: [
      { nameWithOwner: 'ashlrai/binshield', stage: 'merge', enforcement: 'server', maxRisk: 'low', maxFiles: 4, maxLines: 150, maxMergesPerDay: 6, selfRepo: null },
    ],
    merge: { maxFiles: 4, maxLines: 150, selfRepo: 'propose-only', localAuthored: { maxRisk: 'low', maxFiles: 4, maxLines: 150 } },
    spend: {
      maxMode: 'balanced',
      meteredUsdPerDay: 0,
      seats: {
        grok: { seatId: 'grok', enabled: true, reserveFloorPercent: 0, maxSessionWindowPercent: null, roles: ['producer', 'judge', 'leader'] },
        claude: { seatId: 'claude', enabled: true, reserveFloorPercent: 40, maxSessionWindowPercent: 70, roles: ['judge', 'leader'] },
      },
    },
    engines: ['local', 'grok-cli', 'claude-cli'],
    leader: { classes: ['A', 'B'], vetoMinutes: 30 },
    conductorGoals: true,
    computedAt: '2026-09-24T00:00:00.000Z',
    ...overrides,
  };
}

export interface FakeUnits {
  holds: Map<string, RepoHold>;
  tasks: Map<string, { id: string; status: 'queued' | 'dispatched' | 'cancelled' }>;
  prs: Map<string, 'open' | 'closed'>;
  experiments: Map<string, 'queued' | 'cancelled'>;
  /** The fake harness registry's recorded hypotheses (open or tested). */
  hypotheses: Map<string, HarnessHypothesis>;
  /** Hypotheses each startExperiment call received (the registry copy). */
  started: HarnessHypothesis[];
  harness: { active: string | null };
  playbook: string[];
  notified: LeaderAction[];
}

export function makeApplyDeps(opts: {
  ledger: FakeLedger;
  policy?: () => EffectivePolicy | null;
  now?: () => number;
  codex?: { ready: boolean | null; resetsAt: string | null };
  enrolled?: string[] | null;
}): { deps: LeaderApplyDeps; units: FakeUnits } {
  const units: FakeUnits = {
    holds: new Map(),
    tasks: new Map(),
    prs: new Map(),
    experiments: new Map(),
    hypotheses: new Map(),
    started: [],
    harness: { active: null },
    playbook: [],
    notified: [],
  };
  let taskSeq = 0;
  const dedupe = new Map<string, string>();
  let expSeq = 0;
  const now = opts.now ?? (() => Date.now());
  const deps: LeaderApplyDeps = {
    now,
    standingPolicy: opts.policy ?? (() => makePolicy()),
    appendLedger: (input) => opts.ledger.append(input),
    readLedger: (o) => opts.ledger.read(o),
    setRepoHold: (req) => {
      const key = `${req.repo}\0${req.kind}`;
      const before = units.holds.get(key) ?? null;
      if (req.kind !== 'leader-pause' && req.actor === 'leader') return { ok: false, reason: 'the Leader may only set leader-pause', before, after: before };
      if (req.hold === null) {
        units.holds.delete(key);
        return { ok: true, reason: null, before, after: null };
      }
      const after: RepoHold = {
        v: 1, repo: req.repo, kind: req.kind, reason: req.hold.reason, since: new Date(now()).toISOString(),
        until: req.hold.until, setBy: req.actor, landingId: req.hold.landingId ?? null,
      };
      units.holds.set(key, after);
      return { ok: true, reason: null, before, after };
    },
    enqueueTask: (input) => {
      const existing = input.dedupeKey ? dedupe.get(input.dedupeKey) : undefined;
      if (existing && units.tasks.get(existing)?.status === 'queued') {
        return { ok: true, deduped: true, task: { id: existing } as never };
      }
      taskSeq += 1;
      const id = `task-${taskSeq}`;
      units.tasks.set(id, { id, status: 'queued' });
      if (input.dedupeKey) dedupe.set(input.dedupeKey, id);
      return { ok: true, deduped: false, task: { id } as never };
    },
    cancelTask: (req) => {
      const t = units.tasks.get(req.taskId);
      if (!t || t.status !== 'queued') return { ok: false, reason: 'not cancellable' };
      t.status = 'cancelled';
      return { ok: true, task: { id: t.id } as never };
    },
    closeFleetPr: async (req) => {
      units.prs.set(`${req.repo}#${req.number}`, 'closed');
      return { ok: true, reason: 'closed', repo: req.repo, number: req.number, state: 'closed' };
    },
    reopenFleetPr: async (req) => {
      units.prs.set(`${req.repo}#${req.number}`, 'open');
      return { ok: true, reason: 'reopened', repo: req.repo, number: req.number, state: 'open' };
    },
    recordHypotheses: (hypotheses) => {
      const accepted: string[] = [];
      const refused: { id: string | null; reason: string }[] = [];
      for (const h of hypotheses) {
        // Validation is the real registry's job (learn-harness-310b covers it); the fake only dedupes.
        if (units.hypotheses.has(h.id)) refused.push({ id: h.id, reason: 'already recorded' });
        else {
          units.hypotheses.set(h.id, structuredClone(h));
          accepted.push(h.id);
        }
      }
      return { accepted, refused };
    },
    findHypothesis: (id) => {
      const h = units.hypotheses.get(id);
      return h ? structuredClone(h) : null;
    },
    startExperiment: (req) => {
      units.started.push(req.hypothesis);
      expSeq += 1;
      const id = `exp-${expSeq}`;
      units.experiments.set(id, 'queued');
      return { ok: true, experimentId: id };
    },
    cancelExperiment: (req) => {
      if (!units.experiments.has(req.experimentId)) return { ok: false, reason: 'unknown' };
      units.experiments.set(req.experimentId, 'cancelled');
      return { ok: true };
    },
    activeHarness: () => null,
    adoptHarness: (req) => {
      const before = units.harness.active;
      units.harness.active = req.versionId;
      return { ok: true, before: before ? ({ id: before } as never) : null, after: { id: req.versionId } as never };
    },
    rollbackHarness: (req) => {
      units.harness.active = req.toVersionId;
      return { ok: true, before: null, after: null };
    },
    codexReadiness: () => opts.codex ?? { ready: null, resetsAt: null },
    goals: {
      load: (id) => goalsStore.loadGoal(id),
      save: (goal, nowIso) => goalsStore.saveGoal(goal, { now: nowIso }),
      list: () => {
        const read = goalsStore.listGoalsDetailed();
        return { goals: read.goals, complete: read.complete || read.sourceState === 'missing' };
      },
      createIfAbsent: (objective, project) => goalsStore.createGoalIfAbsent(objective, { project }),
      enrolledRepos: () => (opts.enrolled === undefined ? ['/work/ashlrai__binshield'] : opts.enrolled),
    },
    budget: {
      path: () => budgetStore.budgetPolicyPath(),
      load: () => budgetStore.loadBudgetPolicy(),
      setMode: (mode) => budgetStore.updateBudgetPolicy({ mode }),
      serialize: (policy) => `${JSON.stringify(policy, null, 2)}\n`,
      sanitize: (raw) => sanitizeBudgetPolicy(raw),
    },
    addPlaybookDelta: (text) => { units.playbook.push(text); },
    notify: (action) => { units.notified.push(action); },
  };
  return { deps, units };
}
