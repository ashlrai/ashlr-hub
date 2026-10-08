/**
 * 3.15 — the founder-mode Leader: persona, intent routing, expanded powers,
 * and the daily self-improvement drive.
 *
 *   - persona: the prompts name no real person; model output that claims to
 *     be one is rewritten (guardPersonaText); replies are phone-sized.
 *   - intent: deterministic rules; a fake Jev (setJevForTest) decides when it
 *     answers in time with confidence — but never invents an approve / veto.
 *   - powers: cloud / Devin launches are class B (spend-raising) and class C
 *     in reserve or outside the grant; backlog / self-notes are class A;
 *     playbooks / automations only where the API exists. Enact → approve →
 *     veto through the real leader-apply store with a fake ledger.
 *   - drive: candidates from retros / failures / friction / competitive gaps;
 *     selection bounded by budget mode, lane gates, daily caps and cooldown.
 *
 * Hermetic: tmp HOME, fake ledger, fake lanes. Nothing launches, nothing is sent.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  applyApprovedLeaderAction,
  classifyLeaderAction,
  enactLeaderActions,
  findStoredAction,
  vetoLeaderAction,
  type LeaderPolicyContext,
} from '../src/core/vision/leader-apply.js';
import { actionIdFor, buildLeaderActionDraft, parseLeaderMemoOutput, type AnyLeaderActionDraft } from '../src/core/vision/leader-memo.js';
import { LEADER_SYSTEM_PROMPT } from '../src/core/vision/leader.js';
import { LEADER_CONVERSATION_SYSTEM } from '../src/core/vision/leader-thread.js';
import {
  LEADER_FOUNDER_VOICE,
  fitTelegram,
  guardPersonaText,
  personaViolations,
  wantsDetail,
} from '../src/core/vision/leader-persona.js';
import {
  classifyIntentByRules,
  classifyOperatorText,
  jevChooseLane,
  jevWorthInterrupting,
  parseTaskRequest,
  setJevForTest,
} from '../src/core/vision/leader-intent.js';
import { detectAutomationsApi, leaderPlaybooksPort, listSelfDirectives, loadDefaultLeaderPowers, type LeaderPowersPorts } from '../src/core/vision/leader-powers.js';
import * as playbookStore from '../src/core/playbooks/store.js';
import * as playbookParse from '../src/core/playbooks/parse.js';

const { getPlaybook } = playbookStore;
import {
  DRIVE_LIMITS,
  collectImprovementCandidates,
  competitiveGaps,
  draftForSelection,
  enactDirectLeaderActions,
  readDriveState,
  runLeaderDrive,
  selectImprovements,
  type DriveBudget,
  type DriveSources,
  type ImprovementCandidate,
} from '../src/core/vision/leader-drive.js';
import type { LeaderRunDeps } from '../src/core/vision/leader.js';
import { leaderDisplayText } from '../src/core/integrations/telegram-format.js';
import { fakeLedger, makeApplyDeps, makePolicy, useTmpHome, type FakeLedger } from './helpers/leader-310b-fakes.js';

const home = useTmpHome();
let ledger: FakeLedger;

beforeEach(() => {
  home.setup();
  ledger = fakeLedger();
});

afterEach(() => {
  home.teardown();
  setJevForTest(undefined);
});

const NOW = Date.parse('2026-09-27T14:00:00.000Z'); // 10:00 in New York
const VERSE = 'ashlrai/ashlr-hub';

const HUB_REPO = { nameWithOwner: VERSE, stage: 'merge', enforcement: 'server', maxRisk: 'low', maxFiles: 4, maxLines: 150, maxMergesPerDay: 6, selfRepo: null } as const;
const policyWithHub = (): ReturnType<typeof makePolicy> => makePolicy({ repos: [...makePolicy().repos, { ...HUB_REPO }] as never });

function ctx(overrides: Partial<LeaderPolicyContext> = {}): LeaderPolicyContext {
  return {
    nowMs: NOW,
    policy: policyWithHub(),
    budgetMode: 'balanced',
    directives: null,
    codex: { ready: null, resetsAt: null },
    openGoalCount: 1,
    goalCreatesLast24h: 0,
    hypothesisIds: [],
    powers: { playbooks: false, automations: false, devinFleet: true },
    ...overrides,
  };
}

function draft(kind: AnyLeaderActionDraft['kind'], params: unknown): AnyLeaderActionDraft {
  const d = buildLeaderActionDraft(kind, params, `${kind} test`, 'the data says so');
  if (!d) throw new Error(`draft ${kind} did not validate`);
  return d;
}

const LAUNCH = { repo: VERSE, title: 'Instant brief on Telegram', prompt: 'Add an instant brief for status requests with links and tests.' };

function fakePowers(): { ports: LeaderPowersPorts; launched: string[]; backlog: Map<string, unknown> } {
  const launched: string[] = [];
  const backlog = new Map<string, unknown>();
  const ports: LeaderPowersPorts = {
    cloud: {
      launch: vi.fn(async (req) => {
        launched.push(`cloud:${req.origin}:${req.title}`);
        return { ok: true as const, taskId: 'ct_20260927T1400_abc123', url: 'https://claude.ai/code/session_1', detail: 'Cloud task ct_20260927T1400_abc123 — https://claude.ai/code/session_1.' };
      }),
    },
    devin: {
      launch: vi.fn(async (req) => {
        launched.push(`devin:${req.title}`);
        return { ok: true as const, taskId: 'dv_1', url: null, detail: 'Devin task dv_1.' };
      }),
      fleetEnabled: () => true,
    },
    backlog: {
      add: (item) => {
        if (backlog.has(item.id)) return 0;
        backlog.set(item.id, item);
        return 1;
      },
      remove: (id) => backlog.delete(id),
    },
    playbooks: null,
    automations: null,
  };
  return { ports, launched, backlog };
}

// ---------------------------------------------------------------------------
// Persona
// ---------------------------------------------------------------------------

describe('persona — a founder-operator that never claims to be a real person', () => {
  it('the memo and conversation prompts carry the founder voice and name no real person', () => {
    for (const prompt of [LEADER_SYSTEM_PROMPT, LEADER_CONVERSATION_SYSTEM, LEADER_FOUNDER_VOICE]) {
      expect(prompt).not.toMatch(/elon|musk|jobs|bezos|zuckerberg|altman/i);
      expect(prompt).toMatch(/never claim to be, or speak as, any real person/i);
      expect(personaViolations(prompt)).toEqual([]);
    }
    expect(LEADER_SYSTEM_PROMPT).toMatch(/Visionary/);
    expect(LEADER_SYSTEM_PROMPT).toMatch(/best part is no part/i);
    expect(LEADER_SYSTEM_PROMPT).toContain('Phantom (repo ashlrai/phantom)');
    for (const prompt of [LEADER_SYSTEM_PROMPT, LEADER_CONVERSATION_SYSTEM, LEADER_FOUNDER_VOICE]) {
      expect(prompt).toContain('Phantom');
      expect(prompt).not.toContain('Ashlr Verse');
    }
    // The expanded vocabulary is documented to the model.
    for (const kind of ['cloud.launch', 'devin.launch', 'backlog.add', 'playbook.upsert', 'automation.upsert', 'directive.self']) {
      expect(LEADER_SYSTEM_PROMPT).toContain(kind);
    }
    expect(LEADER_CONVERSATION_SYSTEM).toMatch(/At most 6 short lines/);
  });

  it('rewrites identity claims in model output, idempotently, and leaves mentions alone', () => {
    const raw = "I'm Elon Musk and this ships today.\nElon here — kill the router.\n- Elon\nI am a real human.";
    const guarded = guardPersonaText(raw);
    expect(personaViolations(raw).length).toBeGreaterThanOrEqual(4);
    expect(personaViolations(guarded)).toEqual([]);
    expect(guarded).toContain("I'm the Leader and this ships today.");
    expect(guarded).toContain('the Leader here');
    expect(guarded).toContain('— the Leader');
    expect(guarded).toContain("I'm an AI agent");
    expect(guardPersonaText(guarded)).toBe(guarded);
    const mention = 'The best founders would delete this. Musk-style urgency, not Musk.';
    expect(guardPersonaText(mention)).toBe(mention);
  });

  it('keeps Telegram replies phone-sized, with a hint when cut', () => {
    const long = Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join('\n');
    const fit = fitTelegram(long, 6);
    expect(fit.truncated).toBe(true);
    expect(fit.text.split('\n')).toHaveLength(7);
    expect(fit.text).toMatch(/say "more"/);
    expect(fitTelegram('one\n\ntwo', 6)).toEqual({ text: 'one\n\ntwo', truncated: false });
    expect(wantsDetail('explain the bottleneck in detail')).toBe(true);
    expect(wantsDetail('ship it')).toBe(false);
  });

  it('discloses a clipped single line and keeps complete emoji at the boundary', () => {
    const full = `${'a'.repeat(398)}😀 tail`;
    const fit = fitTelegram(full);
    expect(fit.truncated).toBe(true);
    expect(fit.text).toBe(`${'a'.repeat(398)}…\n… (say "more" for the rest)`);
    expect(fit.text).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    expect(fitTelegram('😀😀', 6, 4)).toEqual({ text: '😀😀', truncated: false });
  });

  it('shows readable Leader labels and dates without erasing useful quantities', () => {
    const memo = 'lm-20260927140000-abcdef';
    const action = 'la-20260927140000-abcdef-0';
    const iso = '2026-09-27T14:00:00.000Z';
    const raw = `Leader memo ${memo}\n• [B] Budget 1,018.63 credits, $0.50, 12,345 tokens, v3.24.2 — scheduled (${action})\nNext ${iso}`;
    const display = leaderDisplayText(raw, Date.parse(iso));
    expect(display).toMatch(/^Leader memo\n/);
    expect(display).not.toContain(memo);
    expect(display).not.toContain(action);
    expect(display).not.toContain(iso);
    expect(display).toContain('Next today ');
    expect(display).toContain('1,018.63 credits, $0.50, 12,345 tokens, v3.24.2');
    expect(leaderDisplayText(`Approved ${action}: recorded`)).toBe('Approved action: recorded');
    expect(leaderDisplayText(`• ${memo} — Merge PR #543`)).toBe('• memo — Merge PR #543');
  });

  it('replaces generated task metadata without altering literal references or useful numbers', () => {
    const id = '93715601-ff99-4914-bcb1-095fe8101008';
    const sha = 'c938f914b7ea6a772141fdcbc5ec1786218ab1cc';
    const raw = `Task ${id} failed. Run ${id} is held; commit ${sha}. PR #635 uses v3.25.2.`;
    expect(leaderDisplayText(raw)).toBe('Task failed. Run is held; commit c938f91. PR #635 uses v3.25.2.');
    for (const literal of [`https://github.com/ashlrai/ashlr-hub/commit/${sha}`, `src/${id}.ts`,
      `"Task ${id}"`, `\`run ${id}\``, `\`\`\`\nTask ${id}\n\`\`\``,
      `Invoice 12345678901234567890; model qwen3.8:27b; 12,345 tokens`, `task ${id}.json`]) {
      expect(leaderDisplayText(literal)).toBe(literal);
    }
  });

  it('leaves exact URLs, filenames, code and quoted task text intact', () => {
    const id = 'lm-20260927140000-abcdef';
    const iso = '2026-09-27T14:00:00.000Z';
    const literals = [
      `https://example.test/${id}?at=${iso}`,
      `src/${id}.ts`, `file(${id}).ts`, `filename (${id})`, `logs/${iso}.txt`,
      `\`Leader memo ${id} at ${iso}\``,
      `\`\`\`\nMemo ${id}\n${iso}\n\`\`\``,
      `"Memo ${id} at ${iso}, 12345678901234567890"`,
      'Invoice 12345678901234567890; credit balance 2499.91; 2026-09-27',
    ].join('\n');
    expect(leaderDisplayText(literals, Date.parse(iso))).toBe(literals);
  });

  it('hides terminal action metadata after literal summaries without changing those literals', () => {
    const id = 'la-20260927140000-abcdef-0';
    for (const summary of [
      'Fix "billing"',
      `Edit \`src/${id}.ts\``,
      `Inspect https://example.test/${id}?tokens=12345`,
      `Keep "Memo ${id}" in the filename`,
    ]) {
      const prefix = `• [B] ${summary} — scheduled`;
      expect(leaderDisplayText(`${prefix} (${id})`)).toBe(prefix);
      const advisory = ' — Jev suggests class C (advisory; the class above stands)';
      expect(leaderDisplayText(`${prefix} (${id})${advisory}`)).toBe(`${prefix}${advisory}`);
    }
  });

  it('does not mistake literal action-shaped lines or URL suffixes for terminal metadata', () => {
    const id = 'la-20260927140000-abcdef-0';
    const line = `• [B] Keep this — scheduled (${id})`;
    for (const literal of [
      `"${line}"`, `\`${line}\``, `\`\`\`\n${line}\n\`\`\``,
      `• [B] Download https://example.test/file(${id})`,
      `filename (${id})`,
    ]) expect(leaderDisplayText(literal)).toBe(literal);
  });
});

// ---------------------------------------------------------------------------
// Intent
// ---------------------------------------------------------------------------

describe('intent — rules always, Jev when it answers', () => {
  it('routes status, detail, directives, tasks and chat deterministically', () => {
    for (const t of ['status', 'Update?', "what's up", 'whats up', 'sitrep', '/status', 'where are we?']) {
      expect(classifyIntentByRules(t).kind).toBe('status');
    }
    expect(classifyIntentByRules('more').kind).toBe('detail');
    expect(classifyIntentByRules('focus: ship the Telegram line').kind).toBe('directive');
    expect(classifyIntentByRules('From now on never touch the billing repo').kind).toBe('directive');
    const task = classifyIntentByRules('go build an instant brief command in ashlrai/ashlr-hub with links');
    expect(task.kind).toBe('task');
    expect(task.task).toMatchObject({ repo: 'ashlrai/ashlr-hub', size: 'pr', lane: null });
    expect(task.task!.text).toMatch(/^build an instant brief/);
    expect(parseTaskRequest('please fix the typo in the README')).toMatchObject({ size: 'small' });
    expect(parseTaskRequest('fix the flaky cloud tracker test with devin')).toMatchObject({ lane: 'devin' });
    expect(classifyIntentByRules('how do you feel about the roadmap?').kind).toBe('chat');
    expect(classifyIntentByRules('anything', { replyToKind: 'question' }).kind).toBe('answer');
  });

  it('approve / veto need a target: an id in the text or a reply to an action message', () => {
    const id = 'la-20260927140000-abcdef-0';
    expect(classifyIntentByRules(`approve ${id}`)).toMatchObject({ kind: 'approve', actionIds: [id] });
    expect(classifyIntentByRules('approve')).toMatchObject({ kind: 'chat' });
    expect(classifyIntentByRules('yes', { replyToKind: 'action', replyActionIds: [id] })).toMatchObject({ kind: 'approve', actionIds: [id] });
    expect(classifyIntentByRules('no', { replyToKind: 'action', replyActionIds: [id] })).toMatchObject({ kind: 'veto', actionIds: [id] });
    expect(classifyIntentByRules(`veto ${id} — wrong repo`)).toMatchObject({ kind: 'veto', actionIds: [id] });
    // A longer "no …" message is conversation, not a veto.
    expect(classifyIntentByRules('no worries, tell me what you think instead', { replyActionIds: [id] }).kind).toBe('chat');
  });

  it('uses a fake Jev when it answers in time with confidence', async () => {
    // Jev's published shape: Decision<OperatorIntent> (src/core/decide).
    setJevForTest({ classifyOperatorIntent: async () => ({ value: 'task-request', path: 'jev', confidence: 0.9 }) });
    const res = await classifyOperatorText('we really need dark mode in the Mind surface');
    expect(res).toMatchObject({ kind: 'task', source: 'jev' });
    expect(res.task!.text).toMatch(/dark mode/);
  });

  it('falls back to the rules on low confidence, an unknown label, an error or a timeout', async () => {
    // Jev's own fallback path (unsure / unkeyed / over budget) defers to the line's rules.
    setJevForTest({ classifyOperatorIntent: async () => ({ value: 'task-request', path: 'fallback', confidence: 1 }) });
    expect(await classifyOperatorText('nice work today')).toMatchObject({ kind: 'chat', source: 'rules' });
    setJevForTest({ classifyOperatorIntent: async () => ({ value: 'launch-rockets', path: 'jev', confidence: 0.99 }) });
    expect(await classifyOperatorText('nice work today')).toMatchObject({ kind: 'chat', source: 'rules' });
    setJevForTest({ classifyOperatorIntent: async () => { throw new Error('down'); } });
    expect(await classifyOperatorText('nice work today')).toMatchObject({ kind: 'chat', source: 'rules' });
    setJevForTest({ classifyOperatorIntent: () => new Promise(() => undefined) });
    expect(await classifyOperatorText('nice work today', {}, { timeoutMs: 20 })).toMatchObject({ kind: 'chat', source: 'rules' });
    setJevForTest(null);
    expect(await classifyOperatorText('nice work today')).toMatchObject({ kind: 'chat', source: 'rules' });
  });

  it('never lets Jev invent an approval or a veto', async () => {
    setJevForTest({ classifyOperatorIntent: async () => ({ value: 'approval', path: 'jev', confidence: 0.99 }) });
    expect((await classifyOperatorText('sounds good to me')).kind).toBe('chat');
    const id = 'la-20260927140000-abcdef-1';
    expect(await classifyOperatorText(`approve ${id}`)).toMatchObject({ kind: 'approve', actionIds: [id] });
  });

  it('worthInterrupting and chooseLane: Jev when it answers, the caller\'s fallback otherwise', async () => {
    setJevForTest({
      worthInterrupting: async () => ({ value: false, path: 'jev', confidence: 0.9 }),
      chooseLane: async () => ({ value: 'devin', path: 'jev', confidence: 0.9 }),
    });
    expect(await jevWorthInterrupting({ id: 'e', title: 'revert landed', severity: 'warn' }, {}, true)).toEqual({ interrupt: false, source: 'jev' });
    // A high-severity item is never suppressed, whatever Jev says.
    expect(await jevWorthInterrupting({ id: 'e', title: 'revert FAILED', severity: 'high' }, {}, true)).toEqual({ interrupt: true, source: 'rules' });
    expect(await jevChooseLane({ title: 't' }, ['fleet', 'cloud', 'devin'], 'cloud')).toEqual({ lane: 'devin', source: 'jev' });
    // Jev may only pick an open lane.
    expect(await jevChooseLane({ title: 't' }, ['fleet', 'cloud'], 'cloud')).toEqual({ lane: 'cloud', source: 'rules' });
    setJevForTest({ chooseLane: async () => ({ value: 'cloud', path: 'fallback', confidence: 1 }) });
    expect(await jevChooseLane({ title: 't' }, ['fleet', 'cloud'], 'fleet')).toEqual({ lane: 'fleet', source: 'rules' });
    setJevForTest(null);
    expect(await jevWorthInterrupting({ id: 'e', title: 'x', severity: 'warn' }, {}, false)).toEqual({ interrupt: false, source: 'rules' });
  });
});

// ---------------------------------------------------------------------------
// Powers — classes
// ---------------------------------------------------------------------------

describe('powers — deterministic classes under the grant', () => {
  it('memo parsing validates the new kinds exactly', () => {
    expect(buildLeaderActionDraft('cloud.launch', { ...LAUNCH, purpose: 'self-improve' }, null, null)).not.toBeNull();
    expect(buildLeaderActionDraft('cloud.launch', { ...LAUNCH, repo: 'not a repo' }, null, null)).toBeNull();
    expect(buildLeaderActionDraft('cloud.launch', { ...LAUNCH, prompt: 'too short' }, null, null)).toBeNull();
    expect(buildLeaderActionDraft('cloud.launch', { ...LAUNCH, extra: 1 }, null, null)).toBeNull();
    expect(buildLeaderActionDraft('devin.launch', { ...LAUNCH, purpose: 'task' }, null, null)).toBeNull();
    expect(buildLeaderActionDraft('playbook.upsert', { name: 'Bad Name!', outcome: 'o', procedure: 'p' }, null, null)).toBeNull();
    expect(buildLeaderActionDraft('playbook.upsert', { name: 'fix-flaky', text: 'old shape' }, null, null)).toBeNull();
    expect(buildLeaderActionDraft('directive.self', { text: 'short' }, null, null)).toBeNull();
    const memo = parseLeaderMemoOutput(JSON.stringify({
      bottleneck: { statement: 'b' }, move: { statement: 'm' },
      actions: [{ kind: 'backlog.add', params: { repo: VERSE, title: 'Queue it', prompt: 'Do the thing well.' }, summary: 'q', why: 'w' }],
    }), { nowMs: NOW });
    expect(memo.ok && memo.draft.actions.map((a) => a.kind)).toEqual(['backlog.add']);
  });

  it('launches are class B and spend-raising; reserve or a repo outside the grant is class C', () => {
    const cloud = draft('cloud.launch', LAUNCH);
    expect(classifyLeaderAction(cloud, ctx())).toMatchObject({ class: 'B', verdict: 'ok', spendRaising: true });
    expect(classifyLeaderAction(cloud, ctx({ budgetMode: 'reserve' }))).toMatchObject({ class: 'C', spendRaising: true });
    expect(classifyLeaderAction(cloud, ctx({ policy: makePolicy() })).class).toBe('C'); // ashlr-hub not in this grant
    const devin = draft('devin.launch', LAUNCH);
    expect(classifyLeaderAction(devin, ctx())).toMatchObject({ class: 'B', spendRaising: true });
    expect(classifyLeaderAction(devin, ctx({ powers: { playbooks: false, automations: false, devinFleet: false } }))).toMatchObject({ verdict: 'refused' });
  });

  it('backlog items and self-notes are class A; playbooks / automations need their API', () => {
    expect(classifyLeaderAction(draft('backlog.add', { repo: VERSE, title: 't', prompt: 'p p p' }), ctx())).toMatchObject({ class: 'A', verdict: 'ok' });
    expect(classifyLeaderAction(draft('backlog.add', { repo: 'ashlrai/other', title: 't', prompt: 'p' }), ctx()).class).toBe('C');
    expect(classifyLeaderAction(draft('directive.self', { text: 'Ship the Telegram line before anything else.' }), ctx()).class).toBe('A');
    const pb = draft('playbook.upsert', { name: 'morning-triage', outcome: 'Red CI is triaged first.', procedure: '1. Read the red job.\n2. Fix or revert.' });
    expect(classifyLeaderAction(pb, ctx())).toMatchObject({ verdict: 'refused' });
    expect(classifyLeaderAction(pb, ctx({ powers: { playbooks: true, automations: false, devinFleet: null } }))).toMatchObject({ class: 'B', verdict: 'ok' });
    const definition = { name: 'Nightly deps', enabled: true, trigger: { kind: 'schedule', rrule: 'FREQ=DAILY;BYHOUR=2' }, lane: 'fleet', repos: [VERSE], instructions: 'Bump patch deps.' };
    const auto = draft('automation.upsert', { name: 'nightly-deps', definition });
    expect(classifyLeaderAction(auto, ctx({ powers: { playbooks: false, automations: true, devinFleet: null } })).class).toBe('B');
    expect(buildLeaderActionDraft('automation.upsert', { name: 'nightly-deps', definition: { ...definition, id: 'au_x' } }, null, null)).toBeNull();
  });

  it('feature-detects the automations API (au_<name>; create or update; veto restores or deletes)', async () => {
    expect(await detectAutomationsApi(async () => { throw new Error('missing'); })).toBeNull();
    expect(await detectAutomationsApi(async () => ({ getAutomation: () => null }))).toBeNull();
    const store = new Map<string, Record<string, unknown>>();
    const api = await detectAutomationsApi(async () => ({
      getAutomation: async (id: string) => store.get(id) ?? null,
      createAutomation: async (input: Record<string, unknown>) => {
        if (store.has(String(input['id']))) throw new Error('exists');
        store.set(String(input['id']), { v: 1, ...input, createdAt: 'c', updatedAt: 'u' });
      },
      updateAutomation: async (id: string, patch: Record<string, unknown>) => {
        if ('v' in patch || 'createdAt' in patch) throw new Error('stored-only fields');
        store.set(id, { ...store.get(id)!, ...patch });
      },
      deleteAutomation: async (id: string) => store.delete(id),
    }));
    expect(api).not.toBeNull();
    expect(await api!.upsert('nightly-deps', { name: 'Nightly', instructions: 'a' })).toEqual({ ok: true });
    const before = await api!.get('nightly-deps');
    expect(store.get('au_nightly-deps')).toMatchObject({ id: 'au_nightly-deps', instructions: 'a' });
    expect(await api!.upsert('nightly-deps', { instructions: 'b' })).toEqual({ ok: true });
    expect(await api!.restore('nightly-deps', before)).toEqual({ ok: true });
    expect(store.get('au_nightly-deps')).toMatchObject({ instructions: 'a' });
    expect(await api!.restore('nightly-deps', null)).toEqual({ ok: true });
    expect(store.has('au_nightly-deps')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Powers — enact, approve, veto
// ---------------------------------------------------------------------------

describe('powers — enact, approve and veto through leader-apply', () => {
  const MEMO = 'lm-20260927140000-abcdef';

  function setup(policy = policyWithHub()) {
    const made = makeApplyDeps({ ledger, now: () => NOW, policy: () => policy });
    const powers = fakePowers();
    made.deps.powers = powers.ports;
    return { ...made, ...powers };
  }

  it('a cloud launch waits its veto window, launches on approval, and a veto is honest that spend cannot be recalled', async () => {
    const { deps, launched } = setup();
    const [a] = await enactLeaderActions(deps, MEMO, [draft('cloud.launch', LAUNCH)], [], { idFor: (i) => actionIdFor(MEMO, i) });
    expect(a).toMatchObject({ class: 'B', status: 'scheduled' });
    expect(launched).toEqual([]);
    expect(ledger.rows('leader:action').some((r) => r.id === a!.id && r.status === 'scheduled')).toBe(true);

    const approved = await applyApprovedLeaderAction(deps, a!.id, { via: 'telegram' });
    expect(approved).toMatchObject({ ok: true, outcome: 'applied' });
    expect(launched).toEqual([`cloud:leader:${LAUNCH.title}`]);
    expect(approved.action?.inverse).toEqual({ op: 'launch-recall', lane: 'cloud', taskId: 'ct_20260927T1400_abc123' });
    expect(approved.action?.statusReason).toMatch(/Approved by Mason \(telegram\)/);

    const veto = await vetoLeaderAction(deps, a!.id, 'not now');
    expect(veto.ok).toBe(true);
    expect(veto.records[0]).toMatchObject({ restored: false });
    expect(veto.message).toMatch(/cannot be recalled/);
  });

  it('a launch in reserve mode escalates and never calls the lane', async () => {
    const { deps, launched } = setup();
    deps.budget.setMode('reserve');
    const [a] = await enactLeaderActions(deps, MEMO, [draft('cloud.launch', LAUNCH)], [], { idFor: (i) => actionIdFor(MEMO, i) });
    expect(a).toMatchObject({ class: 'C', status: 'escalated' });
    const approved = await applyApprovedLeaderAction(deps, a!.id, { via: 'telegram' });
    expect(approved.outcome).toBe('recorded-outside-grant');
    expect(launched).toEqual([]);
  });

  it('a grant revoked inside the window stops an approved launch', async () => {
    let policy: ReturnType<typeof makePolicy> | null = policyWithHub();
    const made = makeApplyDeps({ ledger, now: () => NOW, policy: () => policy });
    const powers = fakePowers();
    made.deps.powers = powers.ports;
    const [a] = await enactLeaderActions(made.deps, MEMO, [draft('cloud.launch', LAUNCH)], [], { idFor: (i) => actionIdFor(MEMO, i) });
    policy = null;
    const approved = await applyApprovedLeaderAction(made.deps, a!.id, { via: 'telegram' });
    expect(approved).toMatchObject({ ok: false, outcome: 'refused' });
    expect(powers.launched).toEqual([]);
  });

  it('a lane refusal (budget) is recorded as refused, nothing applied', async () => {
    const { deps } = setup();
    deps.powers!.cloud = { launch: async () => ({ ok: false as const, reason: '20 of 20 sessions used today.' }) };
    const res = await enactDirectLeaderActions(deps, [draft('cloud.launch', LAUNCH)], { approvedVia: 'telegram' });
    expect(res.actions[0]).toMatchObject({ status: 'refused' });
    expect(res.actions[0]!.statusReason).toMatch(/20 of 20/);
  });

  it('backlog.add and directive.self apply at once and veto cleanly', async () => {
    const { deps, backlog } = setup();
    const res = await enactDirectLeaderActions(deps, [
      draft('backlog.add', { repo: VERSE, title: 'Tighten the brief', prompt: 'Make the brief tighter with tests.' }),
      draft('directive.self', { text: 'Every reply ends with the next move and its owner.' }),
    ]);
    expect(res.actions.map((a) => [a.kind, a.class, a.status])).toEqual([
      ['backlog.add', 'A', 'applied'],
      ['directive.self', 'A', 'applied'],
    ]);
    expect(backlog.size).toBe(1);
    expect(listSelfDirectives().map((d) => d.text)).toEqual(['Every reply ends with the next move and its owner.']);

    const v1 = await vetoLeaderAction(deps, res.actions[0]!.id, null);
    const v2 = await vetoLeaderAction(deps, res.actions[1]!.id, null);
    expect(v1.records[0]).toMatchObject({ restored: true });
    expect(v2.records[0]).toMatchObject({ restored: true });
    expect(backlog.size).toBe(0);
    expect(listSelfDirectives()).toEqual([]);
    expect(findStoredAction(res.actions[1]!.id)?.action.status).toBe('vetoed');
  });

  it('playbook.upsert writes a new version through the real playbooks store; a veto writes the prior text back', async () => {
    const { deps } = setup();
    deps.powers = { playbooks: leaderPlaybooksPort(playbookStore, playbookParse) };
    const first = await enactDirectLeaderActions(deps, [draft('playbook.upsert', {
      name: 'leader-triage', outcome: 'Red CI on main is triaged within the hour.', procedure: '1. Read the failing job.\n2. Fix forward or revert.',
    })], { approvedVia: 'telegram' });
    expect(first.actions[0]).toMatchObject({ class: 'B', status: 'applied' });
    expect((await getPlaybook('leader-triage'))?.sections.Outcome).toBe('Red CI on main is triaged within the hour.');
    // A new playbook cannot be unmade (versions are immutable) — the veto says so.
    const v1 = await vetoLeaderAction(deps, first.actions[0]!.id, null);
    expect(v1.records[0]).toMatchObject({ restored: false });
    expect(v1.message).toMatch(/versions are immutable/);

    const second = await enactDirectLeaderActions(deps, [draft('playbook.upsert', {
      name: 'leader-triage', outcome: 'Red CI on main is triaged within 15 minutes.', procedure: '1. Page the Leader.\n2. Fix forward or revert.',
    })], { approvedVia: 'telegram' });
    expect(second.actions[0]!.statusReason).toMatch(/Playbook leader-triage v2/);
    const v2 = await vetoLeaderAction(deps, second.actions[0]!.id, null);
    expect(v2.records[0]).toMatchObject({ restored: true });
    const latest = await getPlaybook('leader-triage');
    expect(latest?.version).toBe(3);
    expect(latest?.sections.Outcome).toBe('Red CI on main is triaged within the hour.');
  });

  it('automation.upsert creates a real automation (au_<name>) and a veto deletes it', async () => {
    const { deps } = setup();
    const real = await loadDefaultLeaderPowers();
    deps.powers = { automations: real.automations! };
    const { automationTemplate } = await import('../src/core/automations/templates.js');
    const { getAutomation } = await import('../src/core/automations/index.js');
    const name = `leader-nightly-${Math.random().toString(16).slice(2, 8)}`;
    const definition = { ...automationTemplate('fix-labeled-issues')!.input, name: 'Leader: fix labeled issues', enabled: false };
    const res = await enactDirectLeaderActions(deps, [draft('automation.upsert', { name, definition })], { approvedVia: 'telegram' });
    expect(res.actions[0]).toMatchObject({ kind: 'automation.upsert', class: 'B', status: 'applied' });
    expect(await getAutomation(`au_${name}`)).toMatchObject({ name: 'Leader: fix labeled issues', enabled: false });
    const veto = await vetoLeaderAction(deps, res.actions[0]!.id, null);
    expect(veto.records[0]).toMatchObject({ restored: true });
    expect(await getAutomation(`au_${name}`)).toBeNull();
  }, 30_000);

  it("Mason's own request approves a class-B launch at once (same checks as an Approve tap)", async () => {
    const { deps, launched, units } = setup();
    const res = await enactDirectLeaderActions(deps, [draft('devin.launch', LAUNCH)], { approvedVia: 'telegram' });
    expect(res.actions[0]).toMatchObject({ kind: 'devin.launch', status: 'applied' });
    expect(launched).toEqual([`devin:${LAUNCH.title}`]);
    // No separate "reply 1 to veto" question for work he asked for.
    expect(units.notified).toEqual([]);
  });

  it('dry run (no grant) records the ask and launches nothing', async () => {
    const { deps, launched } = setup(null as never);
    deps.standingPolicy = () => null;
    const res = await enactDirectLeaderActions(deps, [draft('cloud.launch', LAUNCH)], { approvedVia: 'telegram' });
    expect(res.actions[0]!.status).toBe('refused');
    expect(res.actions[0]!.statusReason).toMatch(/^dry run/);
    expect(launched).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Self-improvement drive
// ---------------------------------------------------------------------------

describe('self-improvement drive — highest leverage, cheapest lane, bounded by budget', () => {
  const retro = (code: string, daysAgo: number, endKind = 'verify-failed') => ({
    endKind: endKind as never,
    endedAt: new Date(NOW - daysAgo * 86_400_000).toISOString(),
    repo: VERSE,
    rootCause: { code, label: code.replace(/[:-]/g, ' '), detail: `detail for ${code}`, evidence: 'gate memo' },
  });

  const DOC = [
    '| Gate | Evidence required | Current boundary |',
    '| --- | --- | --- |',
    '| Cloud delivery identity | PR identity | Gate and release verification are still required |',
    '| Release identity | Digest | Local ship is not publication |',
    '',
  ].join('\n');

  it('collects candidates from retros, failures, friction, usage and competitive gaps', () => {
    const cands = collectImprovementCandidates({
      retros: [retro('verify:tests-failed', 1), retro('verify:tests-failed', 2), retro('verify:tests-failed', 3), retro('gate:protected-path', 1), retro('old', 30), retro('old', 31)],
      leader: { consecutiveFailures: 3, lastFailureReason: 'grok timed out' },
      escalations: [
        { id: 'la-1', createdAt: new Date(NOW - 3 * 86_400_000).toISOString(), status: 'escalated', summary: 'Widen grant' },
        { id: 'la-2', createdAt: new Date(NOW - 2 * 86_400_000).toISOString(), status: 'escalated', summary: 'All-in' },
      ],
      cloudTasks: [
        { state: 'failed', updatedAt: new Date(NOW - 86_400_000).toISOString(), failure: 'timeout' },
        { state: 'expired', updatedAt: new Date(NOW - 86_400_000).toISOString(), failure: null },
      ],
      competitive: DOC,
    }, NOW);
    const ids = cands.map((c) => c.id);
    expect(ids).toContain('retro:verify:tests-failed');
    expect(ids).not.toContain('retro:gate:protected-path'); // one occurrence is not a pattern
    expect(ids).not.toContain('retro:old'); // outside the window
    expect(ids).toContain('failure:leader-runs');
    expect(ids).toContain('needs-you:stale-escalations');
    expect(ids.some((id) => id.startsWith('usage:cloud-failures'))).toBe(true);
    expect(ids).toContain('competitive:cloud-delivery-identity');
    // Sorted by leverage: the recurring failure (3×) and the Leader's own failures lead.
    expect(cands[0]!.leverage).toBeGreaterThanOrEqual(cands[cands.length - 1]!.leverage);
    expect(competitiveGaps(DOC)).toHaveLength(2);
    for (const c of cands) {
      const selection = { candidate: c, lane: 'cloud' as const, why: 'x' };
      expect(draftForSelection(selection)).toMatchObject({ params: { repo: 'ashlrai/phantom' } });
      expect(draftForSelection(selection, VERSE)).toMatchObject({ params: { repo: VERSE } });
    }
  });

  const cand = (id: string, leverage: number, size: 'small' | 'pr' = 'pr'): ImprovementCandidate => ({
    id, title: `Improve ${id}`, brief: `In ashlrai/ashlr-hub: improve ${id} with tests and verification.`, source: 'retro', leverage, size, evidence: 'e',
  });
  const budget = (over: Partial<DriveBudget> = {}): DriveBudget => ({ mode: 'balanced', cloud: { ok: true, reason: null }, devin: { ok: true, reason: null }, fleet: true, ...over });

  it('selects every independent admitted improvement without arbitrary daily ceilings', () => {
    const picks = selectImprovements([cand('a', 9), cand('b', 8), cand('c', 7, 'small'), cand('d', 6)], budget(), [], NOW);
    expect(picks.map((p) => [p.candidate.id, p.lane])).toEqual([['a', 'cloud'], ['b', 'cloud'], ['c', 'fleet'], ['d', 'cloud']]);
    expect(DRIVE_LIMITS.maxPerDay).toBeNull();
    expect(DRIVE_LIMITS.maxPaidPerDay).toBeNull();
  });

  it('retains explicitly supplied daily and paid limits, including zero', () => {
    const candidates = [cand('a', 9), cand('b', 8), cand('c', 7, 'small'), cand('d', 6)];
    const picks = selectImprovements(candidates, budget(), [], NOW, { maxPerDay: 3, maxPaidPerDay: 1 });
    expect(picks.map((p) => [p.candidate.id, p.lane])).toEqual([['a', 'cloud'], ['b', 'backlog'], ['c', 'fleet']]);
    expect(selectImprovements(candidates, budget(), [], NOW, { maxPerDay: 0 })).toEqual([]);
    expect(selectImprovements(candidates, budget(), [], NOW, { maxPaidPerDay: 0 }).map(p => p.lane)).toEqual(['backlog', 'backlog', 'fleet', 'backlog']);
    expect(selectImprovements(candidates, budget(), [], NOW, {}).map(p => p.lane)).toEqual(['cloud', 'cloud', 'fleet', 'cloud']);
  });

  it.each([Infinity, NaN, -1, 1.5])('refuses invalid explicit daily drive limit %s', limit => {
    expect(() => selectImprovements([cand('a', 1)], budget(), [], NOW, { maxPerDay: limit })).toThrow(RangeError);
    expect(() => selectImprovements([cand('a', 1)], budget(), [], NOW, { maxPaidPerDay: limit })).toThrow(RangeError);
  });

  it('never spends in reserve mode or past a lane gate', () => {
    expect(selectImprovements([cand('a', 9), cand('b', 8, 'small')], budget({ mode: 'reserve' }), [], NOW).map((p) => p.lane)).toEqual(['backlog', 'fleet']);
    expect(selectImprovements([cand('a', 9)], budget({ cloud: { ok: false, reason: 'reserve reached' } }), [], NOW)[0]!.lane).toBe('devin');
    const none = selectImprovements([cand('a', 9)], budget({ cloud: { ok: false, reason: 'x' }, devin: null }), [], NOW);
    expect(none[0]).toMatchObject({ lane: 'backlog' });
    expect(none[0]!.why).toMatch(/no paid lane/);
  });

  it('respects the cooldown', () => {
    const history = [{ candidateId: 'a', at: new Date(NOW - 2 * 86_400_000).toISOString(), lane: 'cloud' as const, actionId: null, status: 'applied' }];
    expect(selectImprovements([cand('a', 9), cand('b', 1)], budget(), history, NOW).map((p) => p.candidate.id)).toEqual(['b']);
    const old = [{ ...history[0]!, at: new Date(NOW - 8 * 86_400_000).toISOString() }];
    expect(selectImprovements([cand('a', 9)], budget(), old, NOW).map((p) => p.candidate.id)).toEqual(['a']);
  });

  it('a daily run enacts its picks under the grant, records a report once a day, and stays within budget', async () => {
    const made = makeApplyDeps({ ledger, now: () => NOW, policy: () => makePolicy({
      repos: [...policyWithHub().repos, { ...HUB_REPO, nameWithOwner: 'ashlrai/phantom' }] as never,
    }) });
    const powers = fakePowers();
    made.deps.powers = powers.ports;
    const runDeps = { cfg: {}, now: () => NOW, apply: made.deps } as unknown as LeaderRunDeps;
    const sources: DriveSources = {
      retros: async () => [retro('verify:tests-failed', 1), retro('verify:tests-failed', 2)],
      leader: () => ({ consecutiveFailures: 0, lastFailureReason: null }),
      escalations: () => [],
      cloudTasks: () => [],
      competitive: () => DOC,
      budget: async (mode) => ({ mode, cloud: { ok: true, reason: null }, devin: null, fleet: true }),
    };
    const first = await runLeaderDrive(runDeps, { sources });
    expect(first.ran).toBe(true);
    expect(first.selections.map((s) => s.lane)).toEqual(['cloud', 'cloud', 'cloud']);
    // The cloud pick is class B: scheduled behind its veto window, not launched yet.
    expect(first.actions[0]).toMatchObject({ kind: 'cloud.launch', status: 'scheduled' });
    expect(powers.launched).toEqual([]);
    expect(first.actions.every((a) => a.kind === 'cloud.launch' && a.status === 'scheduled')).toBe(true);
    const report = readDriveState().lastReport!;
    expect(report.text).toMatch(/^Self-improvement — 3 moves on Phantom today:/);
    expect(report.actionIds).toEqual(first.actions.map(action => action.id));
    expect(report.postedAt).toBeNull();

    const again = await runLeaderDrive(runDeps, { sources });
    expect(again).toMatchObject({ ran: false, reason: 'already ran today' });
  });

  it('in dry run it enacts nothing and its report rides the next brief (no ping)', async () => {
    const made = makeApplyDeps({ ledger, now: () => NOW, policy: () => null });
    const powers = fakePowers();
    made.deps.powers = powers.ports;
    const runDeps = { cfg: {}, now: () => NOW, apply: made.deps } as unknown as LeaderRunDeps;
    const res = await runLeaderDrive(runDeps, { sources: {
      retros: async () => [retro('verify:tests-failed', 1), retro('verify:tests-failed', 2)],
      leader: () => ({ consecutiveFailures: 0, lastFailureReason: null }),
      escalations: () => [],
      cloudTasks: () => [],
      competitive: () => null,
      budget: async (mode) => ({ mode, cloud: { ok: true, reason: null }, devin: null, fleet: true }),
    } });
    expect(res).toMatchObject({ ran: true, reason: 'dry run', actions: [] });
    expect(ledger.rows('leader:action')).toEqual([]);
    const report = readDriveState().lastReport!;
    expect(report.text).toMatch(/^Self-improvement \(dry run/);
    expect(report.postedAt).not.toBeNull();
  });
});
