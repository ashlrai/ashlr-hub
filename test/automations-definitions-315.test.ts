/**
 * 3.15 automations — definitions: the RRULE subset (parse, next occurrence,
 * description), strict validation, the 0600 store (create / update / enable /
 * delete, id collisions, corrupt files) and the journal.
 */
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  AUTOMATION_TEMPLATES,
  AutomationInputError,
  createAutomation,
  deleteAutomation,
  describeRrule,
  disableAutomation,
  enableAutomation,
  getAutomation,
  listAutomations,
  nextOccurrence,
  parseRrule,
  updateAutomation,
  type AutomationInput,
} from '../src/core/automations/index.js';
import { normaliseAutomation } from '../src/core/automations/validate.js';
import {
  appendAutomationJournal,
  automationsDir,
  automationsPath,
  readAutomationJournal,
  readAutomations,
} from '../src/core/automations/store.js';
import { isolateAshlrHome } from './helpers/automations-fakes.js';

const base = (over: Partial<AutomationInput> = {}): AutomationInput => ({
  name: 'Fix issues labeled ashlr',
  enabled: false,
  trigger: { kind: 'github-issues', labels: ['ashlr'], query: null, includePrs: false, pollMinutes: 15 },
  lane: 'fleet',
  playbookId: null,
  repos: ['acme/app'],
  instructions: 'Fix the issue.',
  maxConcurrent: 2,
  maxPerDay: 5,
  queueDepth: 10,
  spendCapUsd: 0,
  dedupeKey: null,
  triage: null,
  ...over,
});

describe('RRULE subset', () => {
  it('parses the template rules and refuses what it does not support', () => {
    for (const t of AUTOMATION_TEMPLATES) {
      if (t.input.trigger.kind === 'schedule') expect(parseRrule(t.input.trigger.rrule).ok).toBe(true);
    }
    expect(parseRrule('RRULE:FREQ=DAILY;BYHOUR=2').ok).toBe(true);
    for (const bad of ['', 'FREQ=YEARLY', 'FREQ=DAILY;COUNT=3', 'FREQ=WEEKLY;BYDAY=1MO', 'FREQ=DAILY;BYHOUR=24', 'FREQ=DAILY;FREQ=DAILY', 'FREQ=DAILY;BYMONTHDAY=3', 'garbage']) {
      const r = parseRrule(bad);
      expect(r.ok, bad).toBe(false);
      if (!r.ok) expect(r.error.length).toBeGreaterThan(5);
    }
  });

  it('finds the next local occurrence strictly after a time', () => {
    const daily = parseRrule('FREQ=DAILY;BYHOUR=2;BYMINUTE=0');
    if (!daily.ok) throw new Error('parse');
    expect(nextOccurrence(daily.rule, new Date(2026, 8, 27, 1, 0))).toEqual(new Date(2026, 8, 27, 2, 0));
    expect(nextOccurrence(daily.rule, new Date(2026, 8, 27, 2, 0))).toEqual(new Date(2026, 8, 28, 2, 0));

    const weekly = parseRrule('FREQ=WEEKLY;BYDAY=MO;BYHOUR=6');
    if (!weekly.ok) throw new Error('parse');
    // 2026-09-27 is a Sunday → Monday 28th 06:00.
    expect(nextOccurrence(weekly.rule, new Date(2026, 8, 27, 12, 0))).toEqual(new Date(2026, 8, 28, 6, 0));

    const monthly = parseRrule('FREQ=MONTHLY;BYMONTHDAY=31;BYHOUR=9');
    if (!monthly.ok) throw new Error('parse');
    expect(nextOccurrence(monthly.rule, new Date(2026, 8, 27))).toEqual(new Date(2026, 9, 31, 9, 0));

    const hourly = parseRrule('FREQ=HOURLY;BYMINUTE=15');
    if (!hourly.ok) throw new Error('parse');
    expect(nextOccurrence(hourly.rule, new Date(2026, 8, 27, 10, 20))).toEqual(new Date(2026, 8, 27, 11, 15));

    const every2 = parseRrule('FREQ=DAILY;INTERVAL=2;BYHOUR=3');
    if (!every2.ok) throw new Error('parse');
    const a = nextOccurrence(every2.rule, new Date(2026, 8, 27))!;
    const b = nextOccurrence(every2.rule, a)!;
    expect(Math.round((b.getTime() - a.getTime()) / 86_400_000)).toBe(2);
  });

  it('describes a rule in operator language', () => {
    const r = parseRrule('FREQ=WEEKLY;BYDAY=MO;BYHOUR=6');
    if (!r.ok) throw new Error('parse');
    expect(describeRrule(r.rule)).toBe('Every week on Monday at 06:00');
  });
});

describe('validation', () => {
  const now = new Date('2026-09-27T12:00:00Z');

  it('fills defaults, derives an id, and keeps strict shapes', () => {
    const a = normaliseAutomation({ name: 'Nightly flaky test hunt!', lane: 'cloud', trigger: { kind: 'schedule', rrule: 'freq=daily;byhour=2' }, repos: ['*'] }, { now });
    expect(a.id).toBe('au_nightly-flaky-test-hunt');
    expect(a.enabled).toBe(false);
    expect(a.trigger).toEqual({ kind: 'schedule', rrule: 'FREQ=DAILY;BYHOUR=2' });
    expect(a.maxConcurrent).toBe(2);
    expect(a.triage).toBeNull();
  });

  it('refuses unknown keys, bad repos, widening queries and bad dedupe templates', () => {
    const bad: Array<[Record<string, unknown>, RegExp]> = [
      [{ ...base(), surprise: 1 }, /Unknown field surprise/],
      [{ ...base(), repos: ['not a repo'] }, /owner\/name/],
      [{ ...base(), repos: ['*', 'acme/app'] }, /cannot be combined/],
      [{ ...base(), trigger: { kind: 'github-issues', labels: [], query: null } }, /label or a query/],
      [{ ...base(), trigger: { kind: 'github-issues', labels: ['x'], query: 'org:evil is:open' } }, /repo:, org: or user:/],
      [{ ...base(), trigger: { kind: 'github-issues', labels: ['x'], extra: 1 } }, /Unknown field trigger.extra/],
      [{ ...base(), dedupeKey: '{nope}' }, /placeholder/],
      [{ ...base(), dedupeKey: 'static' }, /at least one placeholder/],
      [{ ...base(), lane: 'mars' }, /lane must be/],
      [{ ...base(), maxConcurrent: 0 }, /maxConcurrent/],
      [{ ...base(), spendCapUsd: -1 }, /spendCapUsd/],
      [{ ...base(), triage: { lanes: ['cloud'] } }, /must include the automation's own lane/],
      [{ ...base(), triage: { lanes: ['fleet'], minConfidence: 0.2 } }, /minConfidence/],
    ];
    for (const [body, message] of bad) {
      expect(() => normaliseAutomation(body, { now }), JSON.stringify(body).slice(0, 80)).toThrow(message);
    }
  });

  it('strips control characters from free text', () => {
    const a = normaliseAutomation({ ...base(), name: 'a\u0007b\nc', instructions: 'line1\u0000\nline2' }, { now });
    expect(a.name).toBe('a b c');
    expect(a.instructions).toBe('line1\nline2');
  });
});

describe('store', () => {
  let restore: () => void;
  beforeEach(() => { restore = isolateAshlrHome(); });
  afterEach(() => restore());

  it('creates private files and round-trips definitions', async () => {
    const created = await createAutomation(base());
    expect(created.id).toBe('au_fix-issues-labeled-ashlr');
    expect(statSync(automationsDir()).mode & 0o777).toBe(0o700);
    expect(statSync(automationsPath()).mode & 0o777).toBe(0o600);
    expect(await listAutomations()).toHaveLength(1);

    // Same name → a new id, never an overwrite; an explicit existing id is refused on create.
    const second = await createAutomation(base());
    expect(second.id).toBe('au_fix-issues-labeled-ashlr-2');
    await expect(createAutomation({ ...base(), id: created.id })).rejects.toBeInstanceOf(AutomationInputError);

    const updated = await updateAutomation(created.id, { maxPerDay: 9, lane: 'cloud' });
    expect(updated?.maxPerDay).toBe(9);
    expect(updated?.lane).toBe('cloud');
    expect(updated?.createdAt).toBe(created.createdAt);
    expect(await updateAutomation('au_missing', { maxPerDay: 1 })).toBeNull();
    await expect(updateAutomation(created.id, { maxPerDay: -3 })).rejects.toThrow(/maxPerDay/);

    expect((await enableAutomation(created.id))?.enabled).toBe(true);
    expect((await getAutomation(created.id))?.enabled).toBe(true);
    expect((await disableAutomation(created.id))?.enabled).toBe(false);
    expect(await deleteAutomation(second.id)).toBe(true);
    expect(await deleteAutomation(second.id)).toBe(false);
    expect((await listAutomations()).map((a) => a.id)).toEqual([created.id]);
  });

  it('skips invalid entries on read instead of half-trusting them', async () => {
    await createAutomation(base());
    const doc = JSON.parse(readFileSync(automationsPath(), 'utf8')) as { automations: unknown[] };
    doc.automations.push({ v: 1, id: 'au_evil', name: 'x', lane: 'fleet', trigger: { kind: 'webhook' }, repos: ['../../etc'] });
    writeFileSync(automationsPath(), JSON.stringify(doc));
    const read = await readAutomations();
    expect(read.automations).toHaveLength(1);
    expect(read.invalid).toBe(1);
    writeFileSync(automationsPath(), '{not json');
    expect((await readAutomations()).automations).toEqual([]);
  });

  it('appends a private journal and reads its tail', async () => {
    mkdirSync(automationsDir(), { recursive: true, mode: 0o700 });
    const record = {
      at: '2026-09-27T12:00:00.000Z', event: 'fired' as const, automationId: 'au_x', firingId: null, dedupeKey: 'k', repo: 'acme/app',
      state: 'queued', lane: 'fleet', sourceUrl: 'https://github.com/acme/app/issues/1', laneRef: null, laneUrl: null, reason: null, spendUsd: 0,
    };
    expect(await appendAutomationJournal([record, { ...record, event: 'dispatched' }])).toBe(true);
    const tail = await readAutomationJournal(10);
    expect(tail.map((r) => r.event)).toEqual(['fired', 'dispatched']);
    expect(statSync(join(automationsDir(), 'firings.jsonl')).mode & 0o777).toBe(0o600);
  });
});
