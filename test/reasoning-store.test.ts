import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  appendFeatures,
  appendSteps,
  appendStepsChunked,
  normalizeStep,
  readStoreState,
  reasoningRoot,
  scanFeatures,
  scanSteps,
  scrubReasoningText,
  storeDroppedRows,
  truncateUtf8,
  writeStoreState,
} from '../src/core/reasoning/store.js';
import { extractTurnFeatures } from '../src/core/reasoning/extractors.js';
import { REASONING_TEXT_MAX_BYTES, type ReasoningStepV1 } from '../src/core/reasoning/types.js';

let home: string;
const saved = { HOME: process.env['HOME'], ASHLR_HOME: process.env['ASHLR_HOME'] };

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'reasoning-store-'));
  process.env['HOME'] = home;
  delete process.env['ASHLR_HOME'];
});

afterEach(() => {
  process.env['HOME'] = saved.HOME;
  if (saved.ASHLR_HOME === undefined) delete process.env['ASHLR_HOME'];
  else process.env['ASHLR_HOME'] = saved.ASHLR_HOME;
  rmSync(home, { recursive: true, force: true });
});

function step(overrides: Partial<ReasoningStepV1> = {}): ReasoningStepV1 {
  return {
    v: 1,
    id: 'verse:s1:1',
    source: 'verse',
    sessionId: 's1',
    runId: null,
    repo: null,
    engine: 'claude',
    model: 'claude-opus',
    at: new Date().toISOString(),
    turnId: 't1',
    kind: 'thinking',
    text: 'thinking about it',
    tokens: null,
    toolAfter: null,
    outcome: null,
    ...overrides,
  };
}

const DAY = 86_400_000;
/** Noon UTC `n` days ago — relative so the suite never ages past the 30-day text window. */
function daysAgoNoon(n: number): string {
  const d = new Date(Date.now() - n * DAY);
  d.setUTCHours(12, 0, 0, 0);
  return d.toISOString();
}

const wide = { fromMs: Date.now() - 400 * 86_400_000, toMs: Date.now() + 86_400_000 };

async function allSteps(root?: string): Promise<ReasoningStepV1[]> {
  const out: ReasoningStepV1[] = [];
  await scanSteps(wide, (s) => { out.push(s); }, root ? { root } : {});
  return out;
}

describe('reasoning store: location and permissions', () => {
  it('lives under the (test) HOME, honours an absolute ASHLR_HOME, ignores a relative one', () => {
    expect(reasoningRoot()).toBe(join(home, '.ashlr', 'reasoning'));
    process.env['ASHLR_HOME'] = join(home, 'alt');
    expect(reasoningRoot()).toBe(join(home, 'alt', 'reasoning'));
    process.env['ASHLR_HOME'] = 'relative/path';
    expect(reasoningRoot()).toBe(join(home, '.ashlr', 'reasoning'));
  });

  it('writes 0700 directories and 0600 files', () => {
    expect(appendSteps([step()])).toBe(1);
    const root = reasoningRoot();
    const day = new Date().toISOString().slice(0, 10);
    expect(statSync(root).mode & 0o777).toBe(0o700);
    expect(statSync(join(root, 'steps')).mode & 0o777).toBe(0o700);
    expect(statSync(join(root, 'steps', `${day}.jsonl`)).mode & 0o777).toBe(0o600);
  });

  it('re-tightens a loosened store directory', () => {
    const root = reasoningRoot();
    mkdirSync(join(root, 'steps'), { recursive: true, mode: 0o755 });
    expect(appendSteps([step()])).toBe(1);
    expect(statSync(join(root, 'steps')).mode & 0o777).toBe(0o700);
  });

  it('refuses to append through a symlinked day file', () => {
    const root = reasoningRoot();
    mkdirSync(join(root, 'steps'), { recursive: true, mode: 0o700 });
    const target = join(home, 'elsewhere.jsonl');
    writeFileSync(target, '', { mode: 0o600 });
    const day = new Date().toISOString().slice(0, 10);
    symlinkSync(target, join(root, 'steps', `${day}.jsonl`));
    const dropped = storeDroppedRows();
    expect(appendSteps([step()])).toBe(0);
    expect(storeDroppedRows()).toBe(dropped + 1);
    expect(readFileSync(target, 'utf8')).toBe('');
  });

  it('refuses a group-writable day file rather than writing to it', () => {
    const root = reasoningRoot();
    mkdirSync(join(root, 'steps'), { recursive: true, mode: 0o700 });
    const day = new Date().toISOString().slice(0, 10);
    const file = join(root, 'steps', `${day}.jsonl`);
    writeFileSync(file, '');
    // chmod after write so the umask cannot mask the bit
    chmodSync(file, 0o666);
    expect(appendSteps([step()])).toBe(0);
  });
});

describe('reasoning store: privacy normalisation', () => {
  it('scrubs secrets and the home directory from text and labels', () => {
    const secret = 'sk-ant-' + 'a'.repeat(30);
    const normalized = normalizeStep(step({
      text: `using key ${secret} from ${home}/proj/.env`,
      repo: `${home}/proj`,
    }));
    expect(normalized?.text).not.toContain(secret);
    expect(normalized?.text).toContain('[REDACTED]');
    expect(normalized?.text).toContain('~/proj/.env');
    expect(normalized?.text).not.toContain(home);
    expect(normalized?.repo).toBe('~/proj');
  });

  it('strips control characters but keeps newlines and tabs', () => {
    expect(scrubReasoningText('a\u0000b\u0007c\nd\te')).toBe('abc\nd\te');
  });

  it('caps text at 8 KB of UTF-8 without splitting a code point', () => {
    const long = '€'.repeat(5_000); // 3 bytes each
    const normalized = normalizeStep(step({ text: long }));
    const bytes = Buffer.byteLength(normalized?.text ?? '', 'utf8');
    expect(bytes).toBeLessThanOrEqual(REASONING_TEXT_MAX_BYTES);
    expect(normalized?.text.endsWith('…')).toBe(true);
    expect(normalized?.text).not.toContain('�');
    expect(truncateUtf8('short', 100)).toBe('short');
  });

  it('rejects rows without a conversation id, with bad enums, or dated in the far future', () => {
    expect(normalizeStep(step({ sessionId: null, runId: null }))).toBeNull();
    expect(normalizeStep(step({ kind: 'bogus' as never }))).toBeNull();
    expect(normalizeStep(step({ source: 'bogus' as never }))).toBeNull();
    expect(normalizeStep(step({ at: new Date(Date.now() + 3 * 86_400_000).toISOString() }))).toBeNull();
    expect(normalizeStep(step({ id: 'has space' }))).toBeNull();
    expect(normalizeStep(step({ engine: '' }))).toBeNull();
  });

  it('stores a step already past the 30-day text window without its text', () => {
    const old = normalizeStep(step({ at: new Date(Date.now() - 40 * 86_400_000).toISOString(), text: 'old reasoning' }));
    expect(old?.text).toBe('');
    expect(old?.at).toBeDefined();
  });

  it('coerces tokens / outcome to null when invalid', () => {
    const normalized = normalizeStep(step({ tokens: -3, outcome: 'maybe' as never }));
    expect(normalized?.tokens).toBeNull();
    expect(normalized?.outcome).toBeNull();
  });

  it('re-cleans feature rows (home path in repo, secret-shaped signatures)', async () => {
    const feature = extractTurnFeatures({
      id: 'verse:s1:t1', source: 'verse', sessionId: 's1', runId: null, repo: `${home}/repo`, engine: 'claude',
      model: null, turnId: 't1', startedAt: new Date().toISOString(), endedAt: null, outcome: 'ok', actions: [],
    });
    feature.failures = [{ signature: 'curl ghp_' + 'b'.repeat(36), count: 2 }];
    expect(appendFeatures([feature])).toBe(1);
    const rows: unknown[] = [];
    await scanFeatures(wide, (row) => { rows.push(row); });
    expect(rows).toHaveLength(1);
    const row = rows[0] as typeof feature;
    expect(row.repo).toBe('~/repo');
    expect(row.failures[0]?.signature).toContain('[REDACTED]');
  });
});

describe('reasoning store: reads', () => {
  it('partitions by UTC day and de-duplicates by id on read', async () => {
    const at1 = daysAgoNoon(3);
    const at2 = daysAgoNoon(2);
    appendSteps([step({ id: 'a', at: at1 }), step({ id: 'b', at: at2 })]);
    appendSteps([step({ id: 'a', at: at1, text: 'duplicate write' })]);
    const root = reasoningRoot();
    expect(lstatSync(join(root, 'steps', `${at1.slice(0, 10)}.jsonl`)).isFile()).toBe(true);
    expect(lstatSync(join(root, 'steps', `${at2.slice(0, 10)}.jsonl`)).isFile()).toBe(true);
    const rows = await allSteps();
    expect(rows.map((r) => r.id).sort()).toEqual(['a', 'b']);
    expect(rows.find((r) => r.id === 'a')?.text).toBe('thinking about it');
  });

  it('newest-first scans return rows in descending time and stop when asked', async () => {
    const base = Date.parse(daysAgoNoon(4));
    appendSteps(Array.from({ length: 6 }, (_, i) => step({ id: `s${i}`, at: new Date(base + i * 6 * 3_600_000).toISOString() })));
    const seen: string[] = [];
    await scanSteps(wide, (s) => {
      seen.push(s.id);
      return seen.length < 4 ? undefined : false;
    }, { newestFirst: true });
    expect(seen).toEqual(['s5', 's4', 's3', 's2']);
  });

  it('skips torn and foreign lines', async () => {
    appendSteps([step({ id: 'good' })]);
    const day = new Date().toISOString().slice(0, 10);
    const file = join(reasoningRoot(), 'steps', `${day}.jsonl`);
    writeFileSync(file, readFileSync(file, 'utf8') + '{"v":1,"id":"torn"\nnot json\n{"v":2}\n', { mode: 0o600 });
    appendSteps([step({ id: 'after-torn' })]);
    const ids = (await allSteps()).map((s) => s.id).sort();
    expect(ids).toEqual(['after-torn', 'good']);
  });

  it('filters by the requested window', async () => {
    appendSteps([step({ id: 'in', at: daysAgoNoon(3) }), step({ id: 'out', at: daysAgoNoon(20) })]);
    const got: string[] = [];
    await scanSteps({ fromMs: Date.now() - 8 * DAY, toMs: Date.now() }, (s) => { got.push(s.id); });
    expect(got).toEqual(['in']);
  });

  it('chunked appends write everything', async () => {
    const many = Array.from({ length: 250 }, (_, i) => step({ id: `c${i}` }));
    expect(await appendStepsChunked(many, reasoningRoot(), 100)).toBe(250);
    expect(await allSteps()).toHaveLength(250);
  });
});

describe('reasoning store: state documents', () => {
  it('round-trips a cursor atomically with 0600 and rejects bad names', () => {
    expect(writeStoreState('verse-cursor', { v: 1, sessions: { a: 1 } })).toBe(true);
    expect(readStoreState('verse-cursor')).toEqual({ v: 1, sessions: { a: 1 } });
    const path = join(reasoningRoot(), 'state', 'verse-cursor.json');
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(writeStoreState('../escape', {})).toBe(false);
    expect(readStoreState('../escape')).toBeNull();
    expect(readStoreState('missing')).toBeNull();
  });
});
