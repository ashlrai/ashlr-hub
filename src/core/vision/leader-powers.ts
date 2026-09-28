/**
 * Founder-mode powers (3.15) — the Leader's expanded action vocabulary.
 *
 *   cloud.launch       a Claude cloud session that delivers a draft PR
 *   devin.launch       a Devin session (fleet origin; PRs stay shadow-only)
 *   backlog.add        a cloud backlog item for the self-improvement scheduler
 *   playbook.upsert    a new playbook version (src/core/playbooks — immutable versions)
 *   automation.upsert  create / update an automation (src/core/automations, when present)
 *   directive.self     a standing note the Leader sets for itself
 *
 * AUTHORITY STAYS DETERMINISTIC. `classifyPowerAction` is pure over the same
 * LeaderPolicyContext leader-apply.ts classifies every other kind with, and
 * leader-apply calls it from its own `classifyLeaderAction`: so a power action
 * gets the same dry-run rule, the same "class not granted in this stage"
 * escalation, the same ledger-first apply, the same veto window, and the same
 * re-check when its window closes or Mason approves it early. Nothing here can
 * raise the grant, and every paid lane keeps its OWN budget gate at launch
 * (cloud/budget.ts canLaunch / canSelfImprove, devin/budget.ts canFleetLaunch).
 *
 *   A  directive.self, backlog.add (spends nothing)
 *   B  cloud.launch, devin.launch (spend-raising), playbook.upsert, automation.upsert
 *   C  a repo outside the grant's current stage; any paid launch while the
 *      budget is in reserve (reserve = paid and Claude lanes are Mason's)
 *   refused  an API this build does not have; Devin fleet launches switched off
 *
 * SELF-DIRECTIVES are the Leader's own notes (model output — untrusted). They
 * live in their own file and reach the memo prompt as UNTRUSTED DATA; they
 * never enter operator-directives.json, whose trusted block is Mason's words.
 *
 * Ports are injectable (tests); `loadDefaultLeaderPowers` wires production.
 * Importing this module is cheap: fs/crypto plus the private-file helpers.
 */
import { createHash, randomBytes } from 'node:crypto';
import { join } from 'node:path';

import { acquireLocalStoreLock, releaseLocalStoreLock } from '../fleet/local-store-lock.js';
import { ensurePrivateDirectory, readPrivateFileCapped, writePrivateFileAtomic } from '../verse/preferences.js';
import type { LeaderClassification, LeaderPolicyContext } from './leader-apply.js';
import { cleanModelText, leaderRoot, type AnyLeaderActionDraft } from './leader-memo.js';
import type { LeaderAction, LeaderActionParamsMap, LeaderInverse } from './leader-types.js';

// ---------------------------------------------------------------------------
// Ports
// ---------------------------------------------------------------------------

export type LeaderLaunchResult =
  | { ok: true; taskId: string; url: string | null; detail: string }
  | { ok: false; reason: string };

/**
 * The contract the Leader expects from the automations API being built
 * concurrently (src/core/automations). `get` returns the current definition
 * (null = none) so a veto can restore it exactly.
 */
export interface LeaderStandingApi {
  get(name: string): unknown | null | Promise<unknown | null>;
  upsert(name: string, definition: Record<string, unknown>): { ok: true } | { ok: false; reason: string } | Promise<{ ok: true } | { ok: false; reason: string }>;
  /** Put back `before` (null = delete the definition). */
  restore(name: string, before: unknown | null): { ok: true } | { ok: false; reason: string } | Promise<{ ok: true } | { ok: false; reason: string }>;
}

export interface LeaderPowersPorts {
  cloud?: { launch(req: { repo: string; title: string; prompt: string; origin: 'leader' | 'self-improve' }): Promise<LeaderLaunchResult> };
  devin?: {
    launch(req: { repo: string; title: string; prompt: string }): Promise<LeaderLaunchResult>;
    /** devin.enabled && devin.fleet; null = unknown. */
    fleetEnabled(): boolean | null;
  };
  backlog?: {
    /** Returns how many items were new (0 = already there). */
    add(item: { id: string; title: string; prompt: string; area: string; priority: 1 | 2 | 3; repo: string }): number | Promise<number>;
    remove(itemId: string): boolean | Promise<boolean>;
  };
  playbooks?: LeaderPlaybooksPort | null;
  automations?: LeaderStandingApi | null;
}

/**
 * src/core/playbooks, as the Leader uses it. Versions are immutable: a save
 * is always a new version, so "restore" means writing the prior source back
 * as the next version.
 */
export interface LeaderPlaybooksPort {
  /** The latest canonical source of `id` (built-ins included); null = no such playbook. */
  current(id: string): Promise<string | null>;
  /** Build the next source: `before` with Outcome / Procedure replaced, or a new playbook. Null = invalid. */
  compose(id: string, before: string | null, outcome: string, procedure: string): string | null | Promise<string | null>;
  save(source: string, note: string): Promise<{ ok: true; version: number } | { ok: false; reason: string }>;
}

/** What classification needs to know about the ports (kept in the pure policy context). */
export interface LeaderPowersContext {
  playbooks: boolean;
  automations: boolean;
  /** Devin fleet launches switched on; null = unknown (the launch gate decides). */
  devinFleet: boolean | null;
}

export function powersContextOf(ports: LeaderPowersPorts | undefined): LeaderPowersContext {
  let devinFleet: boolean | null = null;
  try {
    devinFleet = ports?.devin ? ports.devin.fleetEnabled() : false;
  } catch {
    devinFleet = null;
  }
  return { playbooks: Boolean(ports?.playbooks), automations: Boolean(ports?.automations), devinFleet };
}

// ---------------------------------------------------------------------------
// The pure policy check
// ---------------------------------------------------------------------------

const ok = (cls: 'A' | 'B', spendRaising = false): LeaderClassification => ({ class: cls, verdict: 'ok', reason: null, spendRaising });
const refuse = (cls: 'A' | 'B' | 'C', reason: string): LeaderClassification => ({ class: cls, verdict: 'refused', reason, spendRaising: false });
const escalate = (reason: string, spendRaising = false): LeaderClassification => ({ class: 'C', verdict: 'ok', reason, spendRaising });

function outsideGrant(ctx: LeaderPolicyContext, repo: string): boolean {
  return ctx.policy !== null && !ctx.policy.repos.some((r) => r.nameWithOwner === repo);
}

/**
 * Class of a founder-mode action from kind AND params. PURE: everything comes
 * from `ctx`, so the check re-runs verbatim when a class-B window closes.
 * Null for a kind this module does not own.
 */
export function classifyPowerAction(draft: AnyLeaderActionDraft, ctx: LeaderPolicyContext): LeaderClassification | null {
  const powers = ctx.powers ?? { playbooks: false, automations: false, devinFleet: null };
  switch (draft.kind) {
    case 'directive.self':
      return ok('A');
    case 'backlog.add': {
      const p = draft.params as LeaderActionParamsMap['backlog.add'];
      if (outsideGrant(ctx, p.repo)) return escalate(`${p.repo} is not in the grant's current stage.`);
      return ok('A');
    }
    case 'cloud.launch':
    case 'devin.launch': {
      const p = draft.params as LeaderActionParamsMap['cloud.launch'] | LeaderActionParamsMap['devin.launch'];
      const lane = draft.kind === 'cloud.launch' ? 'cloud' : 'Devin';
      if (outsideGrant(ctx, p.repo)) return escalate(`${p.repo} is not in the grant's current stage.`, true);
      if (ctx.budgetMode === 'reserve') {
        return escalate(`The budget is in reserve: paid ${lane} sessions are Mason's call until it moves to balanced.`, true);
      }
      if (draft.kind === 'devin.launch' && powers.devinFleet === false) {
        return refuse('B', 'Devin fleet launches are switched off (devin.enabled + devin.fleet).');
      }
      return ok('B', true);
    }
    case 'playbook.upsert':
      return powers.playbooks ? ok('B') : refuse('B', 'Playbooks are not available in this build yet.');
    case 'automation.upsert':
      return powers.automations ? ok('B') : refuse('B', 'Automations are not available in this build yet.');
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Self-directives (the Leader's own standing notes)
// ---------------------------------------------------------------------------

export interface LeaderSelfDirective {
  v: 1;
  /** `sd-<yyyymmddhhmmss>-<6 hex>` */
  id: string;
  /** Model text (UNTRUSTED), scrubbed. */
  text: string;
  actionId: string;
  createdAt: string;
  retiredAt: string | null;
}

export const SELF_DIRECTIVE_LIMITS = Object.freeze({ maxActive: 12, keep: 100, maxChars: 300 });
const SELF_DIRECTIVE_ID_RE = /^sd-\d{14}-[a-f0-9]{6}$/;

export function selfDirectivesPath(): string {
  return join(leaderRoot(), 'self-directives.json');
}

function isSelfDirective(x: unknown): x is LeaderSelfDirective {
  if (typeof x !== 'object' || x === null) return false;
  const r = x as Record<string, unknown>;
  return r['v'] === 1 && typeof r['id'] === 'string' && SELF_DIRECTIVE_ID_RE.test(r['id']) && typeof r['text'] === 'string'
    && typeof r['createdAt'] === 'string' && (r['retiredAt'] === null || typeof r['retiredAt'] === 'string');
}

function readSelfDirectivesRaw(): LeaderSelfDirective[] {
  const read = readPrivateFileCapped(selfDirectivesPath(), 256 * 1024);
  if (!read || read.truncated) return [];
  try {
    const parsed = JSON.parse(read.text) as Record<string, unknown>;
    return parsed['v'] === 1 && Array.isArray(parsed['directives']) ? (parsed['directives'] as unknown[]).filter(isSelfDirective) : [];
  } catch {
    return [];
  }
}

function withSelfDirectives<T>(mutate: (all: LeaderSelfDirective[]) => { write: boolean; result: T }, nowMs: number): T {
  ensurePrivateDirectory(leaderRoot());
  const lock = acquireLocalStoreLock(join(leaderRoot(), '.self-directives.lock'), 5_000);
  if (!lock) throw new Error('the Leader self-directive store is busy');
  try {
    const all = readSelfDirectivesRaw();
    const { write, result } = mutate(all);
    if (write) {
      writePrivateFileAtomic(selfDirectivesPath(), `${JSON.stringify({ v: 1, updatedAt: new Date(nowMs).toISOString(), directives: all.slice(-SELF_DIRECTIVE_LIMITS.keep) })}\n`);
    }
    return result;
  } finally {
    releaseLocalStoreLock(lock);
  }
}

/** In-force self-directives, newest first. */
export function listSelfDirectives(): LeaderSelfDirective[] {
  return readSelfDirectivesRaw().filter((d) => d.retiredAt === null).reverse();
}

// ---------------------------------------------------------------------------
// Apply / undo
// ---------------------------------------------------------------------------

export type PowerApplyOutcome =
  | { status: 'applied'; inverse: LeaderInverse; detail: string | null }
  | { status: 'refused' | 'failed'; reason: string };

function stamp(nowMs: number): string {
  return new Date(nowMs).toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
}

/** Stable backlog id per (repo, title) — the backlog dedupes on it too. */
export function leaderPowerBacklogId(repo: string, title: string): string {
  return `leader-${createHash('sha256').update(`${repo}\0${title.toLowerCase()}`).digest('hex').slice(0, 16)}`;
}

/** Keep the ledger line (64 KB cap) safe: a prior definition bigger than this is not restorable, so the change is refused. */
const MAX_STANDING_BEFORE_BYTES = 16 * 1024;

async function upsertStanding(
  api: LeaderStandingApi | null | undefined,
  which: 'playbooks' | 'automations',
  name: string,
  definition: Record<string, unknown>,
): Promise<PowerApplyOutcome> {
  if (!api) return { status: 'refused', reason: `${which === 'playbooks' ? 'Playbooks' : 'Automations'} are not available in this build yet.` };
  const before = (await api.get(name)) ?? null;
  const beforeBytes = before === null ? 0 : Buffer.byteLength(JSON.stringify(before) ?? '', 'utf8');
  if (beforeBytes > MAX_STANDING_BEFORE_BYTES) {
    return { status: 'refused', reason: `The current ${name} definition is too large to record for a veto; change it by hand.` };
  }
  const res = await api.upsert(name, definition);
  if (!res.ok) return { status: 'refused', reason: res.reason };
  return { status: 'applied', inverse: { op: 'restore-standing', api: which, name, before }, detail: null };
}

/**
 * Apply one founder-mode action. Null for a kind this module does not own.
 * Throws only what the ports throw (leader-apply turns that into `failed`).
 */
export async function executePowerAction(
  ports: LeaderPowersPorts | undefined,
  action: LeaderAction,
  nowMs: number,
): Promise<PowerApplyOutcome | null> {
  switch (action.kind) {
    case 'cloud.launch': {
      if (!ports?.cloud) return { status: 'refused', reason: 'The cloud lane is not wired in this process.' };
      const p = action.params;
      const res = await ports.cloud.launch({ repo: p.repo, title: p.title, prompt: p.prompt, origin: p.purpose === 'self-improve' ? 'self-improve' : 'leader' });
      if (!res.ok) return { status: 'refused', reason: res.reason };
      return { status: 'applied', inverse: { op: 'launch-recall', lane: 'cloud', taskId: res.taskId }, detail: res.detail };
    }
    case 'devin.launch': {
      if (!ports?.devin) return { status: 'refused', reason: 'The Devin lane is not wired in this process.' };
      const p = action.params;
      const res = await ports.devin.launch({ repo: p.repo, title: p.title, prompt: p.prompt });
      if (!res.ok) return { status: 'refused', reason: res.reason };
      return { status: 'applied', inverse: { op: 'launch-recall', lane: 'devin', taskId: res.taskId }, detail: res.detail };
    }
    case 'backlog.add': {
      if (!ports?.backlog) return { status: 'refused', reason: 'The cloud backlog is not wired in this process.' };
      const p = action.params;
      const id = leaderPowerBacklogId(p.repo, p.title);
      const added = await ports.backlog.add({ id, title: p.title, prompt: p.prompt, area: 'leader', priority: p.priority, repo: p.repo });
      if (added === 0) return { status: 'refused', reason: 'That item is already in the backlog.' };
      return { status: 'applied', inverse: { op: 'drop-backlog', itemId: id }, detail: `Backlog item ${id}.` };
    }
    case 'playbook.upsert': {
      const pb = ports?.playbooks;
      if (!pb) return { status: 'refused', reason: 'Playbooks are not available in this process.' };
      const p = action.params;
      const before = await pb.current(p.name);
      if (before !== null && Buffer.byteLength(before, 'utf8') > MAX_STANDING_BEFORE_BYTES) {
        return { status: 'refused', reason: `Playbook ${p.name} is too large to record for a veto; edit it by hand.` };
      }
      const source = await pb.compose(p.name, before, p.outcome, p.procedure);
      if (!source) return { status: 'refused', reason: `Playbook ${p.name} could not be composed from the Leader's outcome and procedure.` };
      const saved = await pb.save(source, `Leader action ${action.id}`);
      if (!saved.ok) return { status: 'refused', reason: saved.reason };
      return { status: 'applied', inverse: { op: 'restore-standing', api: 'playbooks', name: p.name, before }, detail: `Playbook ${p.name} v${saved.version}.` };
    }
    case 'automation.upsert': {
      const p = action.params;
      return upsertStanding(ports?.automations, 'automations', p.name, p.definition);
    }
    case 'directive.self': {
      const text = cleanModelText(action.params.text, SELF_DIRECTIVE_LIMITS.maxChars);
      if (!text) return { status: 'refused', reason: 'The note is empty.' };
      return withSelfDirectives((all): { write: boolean; result: PowerApplyOutcome } => {
        const active = all.filter((d) => d.retiredAt === null);
        const key = text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
        if (active.some((d) => d.text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim() === key)) {
          return { write: false, result: { status: 'refused', reason: 'That note is already in force.' } };
        }
        if (active.length >= SELF_DIRECTIVE_LIMITS.maxActive) {
          return { write: false, result: { status: 'refused', reason: `${active.length} Leader notes are already in force (limit ${SELF_DIRECTIVE_LIMITS.maxActive}).` } };
        }
        const directive: LeaderSelfDirective = {
          v: 1,
          id: `sd-${stamp(nowMs)}-${randomBytes(3).toString('hex')}`,
          text,
          actionId: action.id,
          createdAt: new Date(nowMs).toISOString(),
          retiredAt: null,
        };
        all.push(directive);
        return { write: true, result: { status: 'applied', inverse: { op: 'retire-self-directive', directiveId: directive.id }, detail: null } };
      }, nowMs);
    }
    default:
      return null;
  }
}

/** Inverse ops that can only lower what autonomy is doing (a veto may run them from the local store alone). */
export const POWER_LOWERING_ONLY_OPS: ReadonlySet<LeaderInverse['op']> = new Set(['launch-recall', 'drop-backlog', 'retire-self-directive']);

/**
 * Run a founder-mode inverse. Null for an op this module does not own.
 * `trusted` = the inverse came from the ledger; untrusted inverses may only lower.
 */
export async function runPowerInverse(
  ports: LeaderPowersPorts | undefined,
  inverse: LeaderInverse,
  trusted: boolean,
  nowMs: number,
): Promise<{ restored: boolean; detail: string; ran: boolean } | null> {
  switch (inverse.op) {
    case 'launch-recall':
      // Honest: a session that started has spent; the veto stops nothing that
      // is already running remotely. Its PR is a draft (cloud) or shadow-only
      // (Devin) and waits in Needs-you for Mason to close.
      return {
        restored: false,
        detail: `The ${inverse.lane === 'cloud' ? 'cloud' : 'Devin'} session ${inverse.taskId} had already started and cannot be recalled; its PR stays a draft for you to close in Needs you.`,
        ran: false,
      };
    case 'drop-backlog': {
      if (!ports?.backlog) return { restored: false, detail: 'The cloud backlog is not wired in this process; the item stays.', ran: false };
      const removed = await ports.backlog.remove(inverse.itemId);
      return removed
        ? { restored: true, detail: 'The backlog item was removed.', ran: true }
        : { restored: true, detail: 'The backlog item was already gone.', ran: false };
    }
    case 'retire-self-directive': {
      const found = withSelfDirectives((all) => {
        const target = all.find((d) => d.id === inverse.directiveId);
        if (!target || target.retiredAt !== null) return { write: false, result: false };
        target.retiredAt = new Date(nowMs).toISOString();
        return { write: true, result: true };
      }, nowMs);
      return { restored: true, detail: found ? 'The Leader note was retired.' : 'The Leader note is not in force.', ran: found };
    }
    case 'restore-standing': {
      if (!trusted) return { restored: false, detail: 'The ledger could not confirm this veto; the definition was left as is.', ran: false };
      if (inverse.api === 'playbooks') {
        const pb = ports?.playbooks;
        if (!pb) return { restored: false, detail: 'Playbooks are not available in this process; nothing was restored.', ran: false };
        if (typeof inverse.before !== 'string') {
          // Versions are immutable: a playbook the Leader created cannot be unmade here.
          return { restored: false, detail: `Playbook ${inverse.name} was new; versions are immutable, so it stays — it only applies where a task names it.`, ran: false };
        }
        const res = await pb.save(inverse.before, 'Veto: the version before the Leader\'s change, restored');
        return res.ok
          ? { restored: true, detail: `Playbook ${inverse.name} is back to its prior text (as v${res.version}).`, ran: true }
          : { restored: false, detail: `Playbook ${inverse.name} could not be restored: ${res.reason}`, ran: false };
      }
      const api = ports?.automations;
      if (!api) return { restored: false, detail: `${inverse.api} are not available in this process; nothing was restored.`, ran: false };
      const res = await api.restore(inverse.name, inverse.before ?? null);
      return res.ok
        ? { restored: true, detail: inverse.before === null ? `${inverse.name} was removed.` : `${inverse.name} was restored.`, ran: true }
        : { restored: false, detail: `${inverse.name} could not be restored: ${res.reason}`, ran: false };
    }
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Production wiring
// ---------------------------------------------------------------------------

type AnyModule = Record<string, unknown>;

/**
 * The automations API (src/core/automations/index.ts): getAutomation /
 * createAutomation / updateAutomation / deleteAutomation (create and update
 * throw AutomationInputError with a plain sentence; the module validates the
 * whole definition, playbook refs included). The Leader names an automation
 * by slug; its id is `au_<slug>`. A literal import, so the Tier-1 closure
 * test accounts for it; loaded only when the Leader touches an automation.
 */

export function automationIdFor(name: string): string {
  return `au_${name}`;
}

/** Stored-only fields an update must not carry back in. */
function automationInputOf(stored: unknown): Record<string, unknown> {
  const { v: _v, createdAt: _c, updatedAt: _u, id: _id, ...rest } = (stored ?? {}) as Record<string, unknown>;
  return rest;
}

const errorReason = (err: unknown): string => (err instanceof Error ? err.message.slice(0, 300) : 'refused');

export async function detectAutomationsApi(load: () => Promise<AnyModule> = () => import('../automations/index.js') as unknown as Promise<AnyModule>): Promise<LeaderStandingApi | null> {
  let mod: AnyModule;
  try {
    mod = await load();
  } catch {
    return null; // not in this build
  }
  const get = mod['getAutomation'];
  const create = mod['createAutomation'];
  const update = mod['updateAutomation'];
  const remove = mod['deleteAutomation'];
  if (typeof get !== 'function' || typeof create !== 'function' || typeof update !== 'function' || typeof remove !== 'function') return null;
  const call = <T>(fn: unknown, ...args: unknown[]): Promise<T> => Promise.resolve((fn as (...a: unknown[]) => T | Promise<T>)(...args));
  return {
    get: async (name) => (await call<unknown>(get, automationIdFor(name))) ?? null,
    upsert: async (name, definition) => {
      const id = automationIdFor(name);
      try {
        const existing = await call<unknown>(get, id);
        if (existing) await call(update, id, definition);
        else await call(create, { ...definition, id });
        return { ok: true };
      } catch (err) {
        return { ok: false, reason: errorReason(err) };
      }
    },
    restore: async (name, before) => {
      const id = automationIdFor(name);
      try {
        if (before === null) {
          await call(remove, id);
          return { ok: true };
        }
        const existing = await call<unknown>(get, id);
        if (existing) await call(update, id, automationInputOf(before));
        else await call(create, { ...automationInputOf(before), id });
        return { ok: true };
      } catch (err) {
        return { ok: false, reason: errorReason(err) };
      }
    },
  };
}

type PlaybookParseModule = typeof import('../playbooks/parse.js');

/**
 * The Leader's next version of a playbook: the prior one with Outcome and
 * Procedure replaced (front matter and the other sections kept), or a new,
 * opt-in playbook (auto-match off — it reaches a task only when named).
 * Null when the result does not parse. Pure over the parse module.
 */
export function composeLeaderPlaybook(parse: PlaybookParseModule, id: string, before: string | null, outcome: string, procedure: string): string | null {
  const title = id.split('-').map((w) => (w ? w[0]!.toUpperCase() + w.slice(1) : w)).join(' ');
  let meta: Parameters<PlaybookParseModule['serializePlaybook']>[0];
  let sections: Parameters<PlaybookParseModule['serializePlaybook']>[1];
  if (before !== null) {
    const prior = parse.parsePlaybook(before);
    if (!prior.ok) return null;
    // A command workflow (kind: command) is a terminal template, not an agent procedure: never the Leader's to rewrite.
    if (prior.meta.kind === 'command') return null;
    meta = prior.meta;
    sections = { ...prior.sections, Outcome: outcome, Procedure: procedure };
  } else {
    meta = {
      id,
      name: title,
      macro: `!${id}`,
      description: outcome.split('\n')[0]!.slice(0, 120),
      appliesTo: { repos: [], globs: [] },
      taskKinds: [],
      doneWhen: ['The project’s own test command passes'],
      budget: { usd: null, minutes: null },
      auto: false,
    };
    sections = { Outcome: outcome, Procedure: procedure };
  }
  const source = parse.serializePlaybook(meta, sections);
  return parse.parsePlaybook(source).ok ? source : null;
}

/** The playbooks port over src/core/playbooks (store + parse). Saves are authored `leader`. */
export function leaderPlaybooksPort(store: typeof import('../playbooks/store.js'), parse: PlaybookParseModule): LeaderPlaybooksPort {
  return {
    current: async (id) => (await store.getPlaybook(id))?.source ?? null,
    compose: (id, before, outcome, procedure) => composeLeaderPlaybook(parse, id, before, outcome, procedure),
    save: async (source, note) => {
      const res = await store.savePlaybook(source, { author: 'leader', note });
      return res.ok ? { ok: true, version: res.playbook.version } : { ok: false, reason: res.errors.map((e) => e.message).join('; ').slice(0, 300) || 'refused' };
    },
  };
}

/**
 * Production ports. Every lane keeps its own gates; a lane's module is
 * imported only when that lane is used (loading the Leader's deps stays
 * cheap), and a module that fails to load refuses the action — never fakes it.
 */
export async function loadDefaultLeaderPowers(): Promise<LeaderPowersPorts> {
  const config = await import('../config.js');
  const ports: LeaderPowersPorts = {
    cloud: {
      launch: async (req) => {
        const service = await import('../cloud/service.js');
        const res = await service.launchCloudTask({ repo: req.repo, title: req.title, prompt: req.prompt, origin: req.origin });
        if (!res.ok || !res.task) return { ok: false, reason: res.error ?? `cloud launch refused (${res.failure ?? 'unknown'})` };
        return { ok: true, taskId: res.task.id, url: res.task.sessionUrl, detail: `Cloud task ${res.task.id}${res.task.sessionUrl ? ` — ${res.task.sessionUrl}` : ''}.` };
      },
    },
    devin: {
      launch: async (req) => {
        // Fleet origin: needs devin.fleet, a live grant with the repo in it and
        // the Devin reserve intact — the Leader gets no wider door than the fleet.
        const devin = await import('../devin/service.js');
        const res = await devin.launchDevinTask({ repo: req.repo, title: req.title, prompt: req.prompt, origin: 'fleet' });
        if (!res.ok || !res.task) return { ok: false, reason: res.error ?? `Devin launch refused (${res.failure ?? 'unknown'})` };
        return { ok: true, taskId: res.task.id, url: res.task.sessionUrl, detail: `Devin task ${res.task.id}${res.task.sessionUrl ? ` — ${res.task.sessionUrl}` : ''}.` };
      },
      // Same rule as devin/service.ts devinEnabled && devinFleetOptIn (exactly true), read without loading the lane.
      fleetEnabled: () => {
        const section = config.loadConfigReadOnly().devin;
        return section?.enabled === true && section?.fleet === true;
      },
    },
    backlog: {
      add: async (item) => (await import('../cloud/backlog.js')).appendUserBacklogItems([item]),
      remove: async (itemId) => (await import('../cloud/backlog.js')).removeUserBacklogItem(itemId),
    },
    playbooks: {
      current: async (id) => (await import('../playbooks/store.js')).getPlaybook(id).then((pb) => pb?.source ?? null),
      compose: async (id, before, outcome, procedure) => composeLeaderPlaybook(await import('../playbooks/parse.js'), id, before, outcome, procedure),
      save: async (source, note) => leaderPlaybooksPort(await import('../playbooks/store.js'), await import('../playbooks/parse.js')).save(source, note),
    },
  };
  // Loaded on first use; a build without the module refuses the action.
  let automations: Promise<LeaderStandingApi | null> | null = null;
  const api = async (): Promise<LeaderStandingApi> => {
    automations ??= detectAutomationsApi();
    const got = await automations;
    if (!got) throw new Error('Automations are not available in this build.');
    return got;
  };
  ports.automations = {
    get: async (name) => (await api()).get(name),
    upsert: async (name, definition) => {
      try { return await (await api()).upsert(name, definition); } catch (err) { return { ok: false, reason: errorReason(err) }; }
    },
    restore: async (name, before) => {
      try { return await (await api()).restore(name, before); } catch (err) { return { ok: false, reason: errorReason(err) }; }
    },
  };
  return ports;
}
