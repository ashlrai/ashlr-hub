/**
 * 3.15 — the Devin CLI model catalog (core/devin/models.ts) and what uses it:
 * the `devin models list` parser against a fixture trimmed from the real
 * 3000.11.3 output, alias / family resolution, the cached background refresh
 * (a stubbed lister — the real CLI is never run), the Devin (CLI) seat's
 * grouped, priced model list with SWE-2 first, the controls menu's groups, the
 * ACP model switch on a resumed conversation (a fake `devin acp` — no session
 * is started, nothing is spent) and the adapter's `--model`.
 */
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { devinAcpArgs, nextDevinModelStep, runDevinCliTurn } from '../src/core/devin/acp-bridge.js';
import type { DevinTurnIo } from '../src/core/devin/chat-runner.js';
import {
  DEVIN_DEFAULT_MODEL,
  devinContextNote,
  devinDefaultModelId,
  devinPriceNote,
  fallbackDevinModelCatalog,
  getDevinModelCatalog,
  parseDevinModelMeta,
  parseDevinModelsList,
  peekDevinModelCatalog,
  resetDevinModelCatalogForTest,
  resolveDevinModel,
  summarizeDevinModels,
  type DevinModelCatalog,
} from '../src/core/devin/models.js';
import type { DevinTurnLine, DevinTurnPayload } from '../src/core/devin/turn-protocol.js';
import { devinCliModelFor } from '../src/core/verse/adapters/devin.js';
import { devinCliModelOptions, discoverDevinSeats, DEVIN_PICKER_EXCLUDED_FAMILIES } from '../src/core/verse/devin-seats.js';
import { modelOptionsFor } from '../src/core/verse/session-controls.js';
import { resetDevinCliProbeForTest } from '../src/core/devin/cli-probe.js';

const FIXTURE = readFileSync(join(__dirname, 'fixtures', 'devin', 'models-list.txt'), 'utf8');

function fixtureCatalog(): DevinModelCatalog {
  const parsed = parseDevinModelsList(FIXTURE);
  return { source: 'cli', fetchedAt: '2026-09-27T12:00:00.000Z', declaredFamilyCount: parsed.declaredFamilyCount, families: parsed.families };
}

beforeEach(() => {
  resetDevinModelCatalogForTest();
  resetDevinCliProbeForTest();
});

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

describe('parseDevinModelsList (devin 3000.11.3 format)', () => {
  const { declaredFamilyCount, families } = parseDevinModelsList(FIXTURE);
  const byId = new Map(families.flatMap((f) => f.models).map((m) => [m.id, m]));

  it('reads the header count and every family block, in the CLI order; the footer is not a family', () => {
    expect(declaredFamilyCount).toBe(52);
    expect(families.map((f) => f.id)).toEqual([
      'adaptive', 'swe-2', 'swe-1.7-lightning', 'claude-fable-5.1', 'claude-opus-5.5', 'kimi-k3', 'glm-5.2',
      'claude-sonnet-5', 'grok-4.6', 'fusion', 'gpt-5.5', 'claude-haiku-4.5',
    ]);
    expect(families.find((f) => f.id === 'swe-2')).toMatchObject({ label: 'SWE-2', aliases: ['swe'] });
    expect(families.find((f) => f.id === 'claude-sonnet-5')!.aliases).toEqual(['claude', 'sonnet']);
  });

  it('SWE-2: three variants, 262K context, Free; the family default (first row) is swe-2-high', () => {
    const swe = families.find((f) => f.id === 'swe-2')!;
    expect(swe.models.map((m) => m.id)).toEqual(['swe-2-high', 'swe-2-medium', 'swe-2-max']);
    expect(byId.get('swe-2-high')).toEqual({
      family: 'swe-2', familyLabel: 'SWE-2', id: 'swe-2-high', label: 'SWE-2 High', contextTokens: 262_000,
      pricing: { free: true, inPerM: null, outPerM: null, cachedPerM: null }, isNew: false, isBeta: false, aliases: ['swe'],
    });
  });

  it('prices, context spellings and flags', () => {
    expect(byId.get('claude-opus-5-5-medium')).toMatchObject({ contextTokens: 1_000_000, isNew: true, pricing: { free: false, inPerM: 4, cachedPerM: 0.2, outPerM: 20 } });
    expect(byId.get('claude-opus-5-5-high-fast')!.pricing).toMatchObject({ inPerM: 8, outPerM: 40 });
    expect(byId.get('swe-1-7-lightning')).toMatchObject({ label: 'SWE-1.7 Lightning Max', contextTokens: 202_752, pricing: { inPerM: 2.5, outPerM: 12.5, cachedPerM: 1 } });
    expect(byId.get('kimi-k3-high')!.contextTokens).toBe(1_048_576);
    expect(byId.get('adaptive')).toMatchObject({ contextTokens: null, pricing: { free: false, inPerM: 0.5, cachedPerM: 0.1, outPerM: 2 } });
    expect(byId.get('grok-4-6-low')!.isBeta).toBe(true);
    // A real id with an underscore.
    expect(byId.get('MODEL_PRIVATE_11')).toMatchObject({ family: 'claude-haiku-4.5', label: 'Claude Haiku 4.5', contextTokens: 200_000 });
  });

  it('Fusion: the sidekick\'s prices are not the row\'s; "Sidekick: Free" does not make it free', () => {
    const fusion = families.find((f) => f.id === 'fusion')!;
    expect(fusion.models.every((m) => m.pricing.free === false)).toBe(true);
    expect(byId.get('fusion-claude-fable-5-1-medium-sidekick-gpt-5-6-luna-high')!.pricing).toEqual({ free: false, inPerM: 10, outPerM: 50, cachedPerM: 0.25 });
  });

  it('is total: garbage, ANSI colour, empty families and rows before any family are handled', () => {
    expect(parseDevinModelsList('')).toEqual({ declaredFamilyCount: null, families: [] });
    expect(parseDevinModelsList('not logged in\nrun devin auth login')).toEqual({ declaredFamilyCount: null, families: [] });
    const colored = '\u001b[1mSWE-2 (swe-2)\u001b[0m\n  swe-2-high      SWE-2 High  [262K context, Free]\n\nEmpty (empty)\n';
    expect(parseDevinModelsList(colored).families.map((f) => f.id)).toEqual(['swe-2']);
    expect(parseDevinModelsList('  orphan-row   Orphan  [Free]\n').families).toEqual([]);
    expect(parseDevinModelMeta('1.5M context, Free')).toMatchObject({ contextTokens: 1_500_000, pricing: { free: true } });
    expect(parseDevinModelMeta('$0 / 1M Input · $0 / 1M Output').pricing.free).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Resolution, notes, defaults
// ---------------------------------------------------------------------------

describe('resolveDevinModel / defaults / notes', () => {
  const catalog = fixtureCatalog();

  it('id, family slug and alias → the model --model gets (a family means its first row)', () => {
    expect(resolveDevinModel('swe', catalog)?.id).toBe('swe-2-high');
    expect(resolveDevinModel('swe-2', catalog)?.id).toBe('swe-2-high');
    expect(resolveDevinModel('SWE-2-MAX', catalog)?.id).toBe('swe-2-max');
    expect(resolveDevinModel('sonnet', catalog)?.id).toBe('claude-sonnet-5-medium');
    expect(resolveDevinModel('claude-opus-5.5', catalog)?.id).toBe('claude-opus-5-5-medium');
    expect(resolveDevinModel('model_private_11', catalog)?.id).toBe('MODEL_PRIVATE_11');
    expect(resolveDevinModel('nope', catalog)).toBeNull();
    expect(resolveDevinModel('', catalog)).toBeNull();
    expect(resolveDevinModel(null, catalog)).toBeNull();
    // Before any listing: the built-in SWE-2 fallback.
    expect(resolveDevinModel('swe')?.id).toBe('swe-2-high');
  });

  it('the default is swe-2-high unless devin.defaultModel names something the catalog knows', () => {
    expect(DEVIN_DEFAULT_MODEL).toBe('swe-2-high');
    expect(devinDefaultModelId(undefined, catalog)).toBe('swe-2-high');
    expect(devinDefaultModelId({ defaultModel: 'sonnet' }, catalog)).toBe('claude-sonnet-5-medium');
    expect(devinDefaultModelId({ defaultModel: 'not-a-model' }, catalog)).toBe('swe-2-high');
    expect(devinDefaultModelId({ defaultModel: 'bad id with spaces' }, catalog)).toBe('swe-2-high');
    expect(devinDefaultModelId({ defaultModel: 'swe-2-max' }, fallbackDevinModelCatalog())).toBe('swe-2-max');
  });

  it('price and context notes', () => {
    expect(devinPriceNote(resolveDevinModel('swe-2-high', catalog)!)).toBe('Free');
    expect(devinPriceNote(resolveDevinModel('claude-opus-5-5-high', catalog)!)).toBe('$4 in · $20 out per 1M');
    expect(devinPriceNote(resolveDevinModel('swe-1-7-lightning', catalog)!)).toBe('$2.5 in · $12.5 out per 1M');
    expect(devinContextNote({ contextTokens: 262_000 })).toBe('262K ctx');
    expect(devinContextNote({ contextTokens: 1_048_576 })).toBe('1M ctx');
    expect(devinContextNote({ contextTokens: null })).toBeNull();
  });

  it('summary for the Resources card: SWE-2 free + the paid families, and the default', () => {
    expect(summarizeDevinModels(catalog, undefined)).toEqual({
      source: 'cli',
      fetchedAt: '2026-09-27T12:00:00.000Z',
      freeFamilies: ['SWE-2'],
      paidFamilyCount: 11,
      defaultModel: { id: 'swe-2-high', label: 'SWE-2 High', free: true, price: 'Free' },
    });
    expect(summarizeDevinModels(catalog, { defaultModel: 'opus-nope' }).defaultModel.id).toBe('swe-2-high');
  });
});

// ---------------------------------------------------------------------------
// Cache + background refresh (stubbed lister; never the real CLI)
// ---------------------------------------------------------------------------

describe('getDevinModelCatalog', () => {
  let dir: string;
  let cachePath: string;
  let calls: number;
  let output: string | Error;
  const runList = async (cliPath: string): Promise<string> => {
    expect(cliPath).toBe('/fake/devin');
    calls++;
    if (output instanceof Error) throw output;
    return output;
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'devin-models-'));
    cachePath = join(dir, 'devin', 'models-cache.json');
    calls = 0;
    output = FIXTURE;
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('returns at once (the fallback), lists in the background, then serves memory; the listing is persisted privately', async () => {
    const first = await getDevinModelCatalog({ cliPath: '/fake/devin', runList, cachePath, now: () => 1_000_000 });
    expect(first.source).toBe('fallback');
    expect(first.families.map((f) => f.id)).toEqual(['swe-2']);
    const waited = await getDevinModelCatalog({ cliPath: '/fake/devin', runList, cachePath, wait: true, now: () => 1_000_000 });
    expect(waited.source).toBe('cli');
    expect(waited.families).toHaveLength(12);
    expect(calls).toBe(1);
    expect(peekDevinModelCatalog()?.source).toBe('cli');
    // Fresh: no second listing.
    await getDevinModelCatalog({ cliPath: '/fake/devin', runList, cachePath, wait: true, now: () => 1_000_000 + 60_000 });
    expect(calls).toBe(1);
    expect(statSync(cachePath).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(cachePath, 'utf8'))).toMatchObject({ v: 1, fetchedAt: new Date(1_000_000).toISOString() });
  });

  it('a new process reads the disk cache without listing; older than 6 h it lists again', async () => {
    await getDevinModelCatalog({ cliPath: '/fake/devin', runList, cachePath, wait: true, now: () => 1_000_000 });
    resetDevinModelCatalogForTest();
    const cached = await getDevinModelCatalog({ cliPath: '/fake/devin', runList, cachePath, now: () => 1_000_000 + 60_000 });
    expect(cached.source).toBe('cache');
    expect(calls).toBe(1);
    const later = 1_000_000 + 7 * 60 * 60 * 1000;
    const refreshed = await getDevinModelCatalog({ cliPath: '/fake/devin', runList, cachePath, wait: true, now: () => later });
    expect(refreshed.source).toBe('cli');
    expect(calls).toBe(2);
  });

  it('a failed or empty listing keeps the last good catalog and is not retried for 10 minutes', async () => {
    await getDevinModelCatalog({ cliPath: '/fake/devin', runList, cachePath, wait: true, now: () => 0 });
    output = new Error('logged out');
    const stale = 7 * 60 * 60 * 1000;
    const kept = await getDevinModelCatalog({ cliPath: '/fake/devin', runList, cachePath, wait: true, now: () => stale });
    expect(kept.source).toBe('cli');
    expect(calls).toBe(2);
    await getDevinModelCatalog({ cliPath: '/fake/devin', runList, cachePath, wait: true, now: () => stale + 60_000 });
    expect(calls).toBe(2);
    output = 'Not logged in.';
    await getDevinModelCatalog({ cliPath: '/fake/devin', runList, cachePath, wait: true, now: () => stale + 11 * 60_000 });
    expect(calls).toBe(3);
    expect(peekDevinModelCatalog()?.families).toHaveLength(12);
  });

  it('cliPath null never lists; a corrupt cache file is ignored', async () => {
    writeFileSync(join(dir, 'broken.json'), '{"v":1,"fetchedAt":"x","text":42}');
    const out = await getDevinModelCatalog({ cliPath: null, runList, cachePath: join(dir, 'broken.json'), wait: true });
    expect(out.source).toBe('fallback');
    expect(calls).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// The Devin (CLI) seat's models + the controls menu
// ---------------------------------------------------------------------------

describe('Devin (CLI) seat models', () => {
  const catalog = fixtureCatalog();

  it('default first, SWE-2 first and Free, grouped by family, priced; Fusion left out', () => {
    const options = devinCliModelOptions(catalog, 'swe-2-high', null);
    expect(options[0]).toEqual({ id: 'swe-2-high', label: 'SWE-2 High', contextWindow: null, windowSource: 'fallback', group: 'SWE-2', priceNote: 'Free' });
    expect(options.slice(0, 3).map((o) => o.id)).toEqual(['swe-2-high', 'swe-2-medium', 'swe-2-max']);
    expect(options.some((o) => o.id.startsWith('fusion-'))).toBe(false);
    expect(DEVIN_PICKER_EXCLUDED_FAMILIES.has('fusion')).toBe(true);
    // The rest in the CLI's order.
    const groups = [...new Set(options.map((o) => o.group))];
    expect(groups).toEqual(['SWE-2', 'Adaptive', 'SWE-1.7 Lightning', 'Claude Fable 5.1', 'Claude Opus 5.5', 'Kimi K3', 'GLM-5.2', 'Claude Sonnet 5', 'Grok 4.6', 'GPT-5.5', 'Claude Haiku 4.5']);
    expect(options.find((o) => o.id === 'claude-opus-5-5-high')!.priceNote).toBe('$4 in · $20 out per 1M');
  });

  it('a configured default leads, with its family; SWE-2 next; a logged-out CLI marks every row', () => {
    const options = devinCliModelOptions(catalog, 'claude-sonnet-5-high', 'Log in: `devin auth login`');
    expect(options.slice(0, 6).map((o) => o.id)).toEqual(['claude-sonnet-5-high', 'claude-sonnet-5-medium', 'claude-sonnet-5-low', 'claude-sonnet-5-xhigh', 'claude-sonnet-5-max', 'swe-2-high']);
    expect(options.every((o) => o.unavailableReason === 'Log in: `devin auth login`')).toBe(true);
  });

  it('the composer\'s Model menu: family headings carry the family price; a variant that costs more says so', () => {
    const menu = modelOptionsFor({ models: devinCliModelOptions(catalog, 'swe-2-high', null) });
    expect(menu[0]).toEqual({ id: 'swe-2-high', label: 'SWE-2 High', available: true, group: 'SWE-2 · Free' });
    const opus = menu.filter((o) => o.id.startsWith('claude-opus-5-5-'));
    expect(opus[0]).toMatchObject({ id: 'claude-opus-5-5-medium', group: 'Claude Opus 5.5 · $4 in · $20 out per 1M' });
    expect(opus[0]).not.toHaveProperty('note');
    expect(opus.find((o) => o.id === 'claude-opus-5-5-high-fast')).toMatchObject({ note: '$8 in · $40 out per 1M' });
    // A seat without groups is unchanged.
    expect(modelOptionsFor({ models: [{ id: 'm', label: 'M', contextWindow: 1 }] })).toEqual([{ id: 'm', label: 'M', available: true }]);
  });

  it('discovery builds the seat from the catalog and devin.defaultModel', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'devin-cli-seat-'));
    try {
      const bin = join(dir, 'devin');
      writeFileSync(bin, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      const creds = join(dir, 'credentials.toml');
      writeFileSync(creds, 'x');
      const out = await discoverDevinSeats({
        status: async () => ({ state: 'not-connected', reason: '' }),
        cliCandidates: [bin],
        cliCredentialsPath: creds,
        modelCatalog: async () => catalog,
        defaultModel: () => 'swe-2-max',
      });
      const cli = out.seats.find((s) => s.id === 'devin-cli')!;
      expect(cli.models[0]).toMatchObject({ id: 'swe-2-max', group: 'SWE-2', priceNote: 'Free' });
      expect(cli.models.map((m) => m.id)).not.toContain('devin');
      // No catalog yet (and no config): the SWE-2 fallback, SWE-2 High first.
      const cold = await discoverDevinSeats({
        status: async () => ({ state: 'not-connected', reason: '' }),
        cliCandidates: [bin],
        cliCredentialsPath: creds,
        modelCatalog: async () => fallbackDevinModelCatalog(),
        defaultModel: () => null,
      });
      expect(cold.seats.find((s) => s.id === 'devin-cli')!.models.map((m) => m.id)).toEqual(['swe-2-high', 'swe-2-medium', 'swe-2-max']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('adapter: aliases resolve to the family default; the legacy "devin" choice stays the CLI default', () => {
    expect(devinCliModelFor('devin')).toBeNull();
    expect(devinCliModelFor(null)).toBeNull();
    expect(devinCliModelFor('swe')).toBe('swe-2-high');
    expect(devinCliModelFor('swe-2-max')).toBe('swe-2-max');
    // Unknown to the (fallback) catalog: passed through as typed.
    expect(devinCliModelFor('opus')).toBe('opus');
    expect(devinCliModelFor('bad id')).toBeNull();
    expect(devinAcpArgs({ permissionMode: 'accept-edits', model: 'swe-2-high' })).toEqual(['--sandbox', '--permission-mode', 'accept-edits', 'acp', '--model', 'swe-2-high']);
  });
});

// ---------------------------------------------------------------------------
// ACP model switch on a resumed conversation
// ---------------------------------------------------------------------------

/** Config options shaped exactly like devin acp 3000.11.3's (values trimmed). */
const MODEL_VALUES = ['adaptive', 'swe-2-high', 'swe-1-7-lightning-medium', 'claude-opus-5-5-medium', 'claude-opus-5-medium', 'glm-5-2', 'gpt-5-5-medium'];
const LEVELS: Record<string, string[]> = {
  'swe-2-high': ['medium', 'high', 'max'],
  'claude-opus-5-5-medium': ['low', 'medium', 'high', 'xhigh', 'max'],
  'gpt-5-5-medium': ['none', 'low', 'medium', 'high', 'xhigh'],
};
const FAMILY_DEFAULT_LEVEL: Record<string, string> = { 'swe-2-high': 'high', 'claude-opus-5-5-medium': 'medium', 'gpt-5-5-medium': 'medium' };
const HAS_SPEED = new Set(['claude-opus-5-5-medium', 'gpt-5-5-medium']);

function configOptions(state: { model: string; thought?: string; speed?: string }): unknown[] {
  const opts: unknown[] = [
    { id: 'mode', name: 'Session Mode', category: 'mode', type: 'select', currentValue: 'accept-edits', options: [{ value: 'accept-edits', name: 'Code' }] },
    { id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: state.model, options: MODEL_VALUES.map((value) => ({ value, name: value })) },
  ];
  const levels = LEVELS[state.model];
  if (levels) opts.push({ id: 'thought_level', name: 'Thinking', category: 'thought_level', type: 'select', currentValue: state.thought ?? FAMILY_DEFAULT_LEVEL[state.model], options: levels.map((value) => ({ value, name: value })) });
  if (HAS_SPEED.has(state.model)) opts.push({ id: 'speed', name: 'Speed', category: 'model_config', type: 'select', currentValue: state.speed ?? 'standard', options: [{ value: 'standard' }, { value: 'fast' }] });
  return opts;
}

/** Apply steps against the simulated agent until done; returns the steps taken. */
function drive(target: string, start: { model: string; thought?: string; speed?: string }) {
  const state = { ...start };
  const steps: string[] = [];
  for (let i = 0; i < 6; i++) {
    const step = nextDevinModelStep(target, configOptions(state));
    if (step.kind !== 'set') return { steps, end: step, state };
    steps.push(`${step.configId}=${step.value}`);
    if (step.configId === 'model') {
      state.model = step.value;
      delete state.thought;
      delete state.speed;
    } else if (step.configId === 'thought_level') state.thought = step.value;
    else state.speed = step.value;
  }
  throw new Error('did not settle');
}

describe('nextDevinModelStep', () => {
  it('same family, another effort: one thought_level step', () => {
    expect(drive('swe-2-max', { model: 'swe-2-high' })).toMatchObject({ steps: ['thought_level=max'], end: { kind: 'done' } });
    expect(drive('swe-2-high', { model: 'swe-2-high', thought: 'max' }).steps).toEqual(['thought_level=high']);
    expect(drive('swe-2-high', { model: 'swe-2-high' })).toMatchObject({ steps: [], end: { kind: 'done' } });
  });

  it('another family, effort and speed: model, then thought_level, then speed', () => {
    expect(drive('claude-opus-5-5-high-fast', { model: 'swe-2-high' }).steps).toEqual(['model=claude-opus-5-5-medium', 'thought_level=high', 'speed=fast']);
    // `-priority` is the listing's "Fast" too; no speed word means standard.
    expect(drive('gpt-5-5-none-priority', { model: 'swe-2-high' }).steps).toEqual(['model=gpt-5-5-medium', 'thought_level=none', 'speed=fast']);
    expect(drive('claude-opus-5-5-medium', { model: 'claude-opus-5-5-medium', thought: 'max', speed: 'fast' }).steps).toEqual(['thought_level=medium', 'speed=standard']);
    // The longest matching family wins (claude-opus-5-5 over claude-opus-5).
    expect(drive('claude-opus-5-5-low', { model: 'claude-opus-5-medium' }).steps[0]).toBe('model=claude-opus-5-5-medium');
    // A family default with no effort word: just the model.
    expect(drive('glm-5-2', { model: 'swe-2-high' }).steps).toEqual(['model=glm-5-2']);
  });

  it('unplannable: unknown words, unknown families, no model control, an effort the family lacks', () => {
    expect(nextDevinModelStep('glm-5-2-max-1m', configOptions({ model: 'glm-5-2' }))).toMatchObject({ kind: 'unplannable' });
    expect(nextDevinModelStep('opus', configOptions({ model: 'swe-2-high' }))).toMatchObject({ kind: 'unplannable' });
    expect(nextDevinModelStep('swe-2-high', [])).toMatchObject({ kind: 'unplannable' });
    expect(nextDevinModelStep('swe-2-high', undefined)).toMatchObject({ kind: 'unplannable' });
    expect(nextDevinModelStep('swe-2-low', configOptions({ model: 'swe-2-high' }))).toMatchObject({ kind: 'unplannable' });
  });
});

// A minimal fake `devin acp` (the full harness lives in devin-acp-bridge-315.test.ts).
type Msg = { id?: number; method?: string; params?: Record<string, unknown> };
class FakeAgent extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  received: Msg[] = [];
  stdin: Writable;
  pid = 4242;
  private buffer = '';
  constructor(private readonly onRequest: (msg: Msg, agent: FakeAgent) => unknown) {
    super();
    this.stdout.setEncoding('utf8');
    this.stdin = new Writable({
      write: (chunk, _enc, done) => {
        this.buffer += String(chunk);
        let nl: number;
        while ((nl = this.buffer.indexOf('\n')) !== -1) {
          const line = this.buffer.slice(0, nl);
          this.buffer = this.buffer.slice(nl + 1);
          if (line.trim()) this.handle(JSON.parse(line) as Msg);
        }
        done();
      },
    });
  }
  private handle(msg: Msg): void {
    this.received.push(msg);
    if (msg.method === undefined || msg.id === undefined) return;
    const out = this.onRequest(msg, this);
    if (out === null) return;
    const body = out && typeof out === 'object' && 'error' in (out as object) ? { error: (out as { error: unknown }).error } : { result: out };
    this.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: msg.id, ...body })}\n`);
  }
  kill(): boolean {
    setImmediate(() => this.emit('close', 0));
    return true;
  }
}

function runTurn(onRequest: (msg: Msg, agent: FakeAgent) => unknown, patch: Partial<DevinTurnPayload>) {
  const agent = new FakeAgent(onRequest);
  const args: string[][] = [];
  const spawn = ((_bin: string, argv: string[]) => { args.push(argv); return agent; }) as unknown as typeof import('node:child_process').spawn;
  const lines: DevinTurnLine[] = [];
  const io: DevinTurnIo = { emit: (l) => { lines.push(l); }, signal: new AbortController().signal, sleep: async () => undefined, now: () => 1_000 };
  const payload: DevinTurnPayload = {
    v: 1, lane: 'cli', verseSessionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', nativeId: 'veiled-alpaca', projectPath: '/tmp/proj',
    text: 'Continue', permissionMode: 'accept-edits', cliPath: '/opt/homebrew/bin/devin', model: 'claude-opus-5-5-high', ...patch,
  };
  return { agent, args, lines, run: runDevinCliTurn(payload, io, { spawn, env: {}, requestTimeoutMs: 2_000, cancelGraceMs: 50, recordPrs: () => [] }) };
}

describe('Devin CLI turn: model switch on resume', () => {
  it('a resumed conversation is switched with session/set_config_option before the prompt', async () => {
    let state = { model: 'swe-2-high' } as { model: string; thought?: string; speed?: string };
    const t = runTurn((msg) => {
      if (msg.method === 'initialize') return { protocolVersion: 1, agentCapabilities: { loadSession: true } };
      if (msg.method === 'session/load') return { configOptions: configOptions(state) };
      if (msg.method === 'session/set_config_option') {
        const { configId, value } = msg.params as { configId: string; value: string };
        if (configId === 'model') state = { model: value };
        else if (configId === 'thought_level') state = { ...state, thought: value };
        else state = { ...state, speed: value };
        return { configOptions: configOptions(state) };
      }
      if (msg.method === 'session/prompt') return { stopReason: 'end_turn' };
      return { error: { code: -32601, message: 'nope' } };
    }, {});
    expect(await t.run).toBe(0);
    const sets = t.agent.received.filter((m) => m.method === 'session/set_config_option').map((m) => m.params);
    expect(sets).toEqual([
      { sessionId: 'veiled-alpaca', configId: 'model', value: 'claude-opus-5-5-medium' },
      { sessionId: 'veiled-alpaca', configId: 'thought_level', value: 'high' },
    ]);
    const order = t.agent.received.map((m) => m.method).filter(Boolean);
    expect(order.indexOf('session/prompt')).toBeGreaterThan(order.lastIndexOf('session/set_config_option'));
    expect(t.args[0]).toContain('--model');
  });

  it('a switch the CLI refuses fails the turn with the model named; nothing is prompted', async () => {
    const t = runTurn((msg) => {
      if (msg.method === 'initialize') return { protocolVersion: 1, agentCapabilities: { loadSession: true } };
      if (msg.method === 'session/load') return { configOptions: configOptions({ model: 'swe-2-high' }) };
      if (msg.method === 'session/set_config_option') return { error: { code: -32602, message: 'Invalid params' } };
      return { stopReason: 'end_turn' };
    }, {});
    expect(await t.run).toBe(1);
    expect(t.lines.find((l) => l.type === 'error')).toMatchObject({ message: expect.stringContaining('could not switch this chat to claude-opus-5-5-high') });
    expect(t.agent.received.some((m) => m.method === 'session/prompt')).toBe(false);
  });

  it('already on the chat\'s model, an unplannable model, or a new session: no set_config_option', async () => {
    const answer = (load: unknown) => (msg: Msg) => {
      if (msg.method === 'initialize') return { protocolVersion: 1, agentCapabilities: { loadSession: true } };
      if (msg.method === 'session/load') return load;
      if (msg.method === 'session/new') return { sessionId: 'fresh-one', configOptions: configOptions({ model: 'swe-2-high' }) };
      return { stopReason: 'end_turn' };
    };
    const same = runTurn(answer({ configOptions: configOptions({ model: 'swe-2-high' }) }), { model: 'swe-2-high' });
    expect(await same.run).toBe(0);
    const odd = runTurn(answer({ configOptions: configOptions({ model: 'swe-2-high' }) }), { model: 'opus' });
    expect(await odd.run).toBe(0);
    const bare = runTurn(answer({}), {});
    expect(await bare.run).toBe(0);
    const fresh = runTurn(answer(null), { nativeId: null, model: 'claude-opus-5-5-high' });
    expect(await fresh.run).toBe(0);
    for (const t of [same, odd, bare, fresh]) expect(t.agent.received.some((m) => m.method === 'session/set_config_option')).toBe(false);
    expect(fresh.args[0]).toEqual(['--sandbox', '--permission-mode', 'accept-edits', 'acp', '--model', 'claude-opus-5-5-high']);
  });
});
