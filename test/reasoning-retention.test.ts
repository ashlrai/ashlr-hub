import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyReasoningRetention } from '../src/core/reasoning/retention.js';
import { appendFeatures, appendSteps, reasoningRoot } from '../src/core/reasoning/store.js';
import { extractTurnFeatures } from '../src/core/reasoning/extractors.js';
import type { ReasoningStepV1 } from '../src/core/reasoning/types.js';

const DAY = 86_400_000;
let home: string;
const savedHome = process.env['HOME'];
const savedAshlrHome = process.env['ASHLR_HOME'];

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'reasoning-retention-'));
  process.env['HOME'] = home;
  delete process.env['ASHLR_HOME'];
});

afterEach(() => {
  process.env['HOME'] = savedHome;
  if (savedAshlrHome !== undefined) process.env['ASHLR_HOME'] = savedAshlrHome;
  rmSync(home, { recursive: true, force: true });
});

function row(id: string, at: string, text = 'secret-free reasoning'): ReasoningStepV1 {
  return {
    v: 1, id, source: 'verse', sessionId: 's', runId: null, repo: null, engine: 'claude', model: null,
    at, turnId: 't', kind: 'thinking', text, tokens: null, toolAfter: null, outcome: null,
  };
}

/** Write a day file directly (the store refuses to write text for old rows, by design). */
function writeDay(kind: 'steps' | 'features', day: string, rows: unknown[]): string {
  const dir = join(reasoningRoot(), kind);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, `${day}.jsonl`);
  writeFileSync(path, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', { mode: 0o600 });
  return path;
}

const dayOf = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

describe('applyReasoningRetention', () => {
  it('blanks text past 30 days, keeps recent text, keeps the rows', async () => {
    const now = Date.now();
    const oldDay = dayOf(now - 40 * DAY);
    const oldPath = writeDay('steps', oldDay, [row('o1', `${oldDay}T10:00:00.000Z`), row('o2', `${oldDay}T11:00:00.000Z`)]);
    appendSteps([row('recent', new Date(now - DAY).toISOString())]);
    const result = await applyReasoningRetention({ nowMs: now });
    expect(result.textPrunedFiles).toBe(1);
    expect(result.textPrunedRows).toBe(2);
    const rows = readFileSync(oldPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as ReasoningStepV1);
    expect(rows.map((r) => r.id)).toEqual(['o1', 'o2']);
    expect(rows.every((r) => r.text === '')).toBe(true);
    expect(statSync(oldPath).mode & 0o777).toBe(0o600);
    const recentPath = join(reasoningRoot(), 'steps', `${dayOf(now - DAY)}.jsonl`);
    expect(readFileSync(recentPath, 'utf8')).toContain('secret-free reasoning');
  });

  it('deletes steps and features past 180 days', async () => {
    const now = Date.now();
    const ancient = dayOf(now - 200 * DAY);
    const stepsPath = writeDay('steps', ancient, [row('a', `${ancient}T10:00:00.000Z`, '')]);
    const feature = extractTurnFeatures({
      id: 'f', source: 'verse', sessionId: 's', runId: null, repo: null, engine: 'claude', model: null, turnId: 't',
      startedAt: `${ancient}T10:00:00.000Z`, endedAt: null, outcome: 'ok', actions: [],
    });
    const featuresPath = writeDay('features', ancient, [feature]);
    const keepFeature = { ...feature, id: 'keep', at: new Date(now - 100 * DAY).toISOString() };
    expect(appendFeatures([keepFeature])).toBe(1);
    const result = await applyReasoningRetention({ nowMs: now });
    expect(result.removedFiles).toBe(2);
    expect(existsSync(stepsPath)).toBe(false);
    expect(existsSync(featuresPath)).toBe(false);
    expect(existsSync(join(reasoningRoot(), 'features', `${dayOf(now - 100 * DAY)}.jsonl`))).toBe(true);
  });

  it('skips already-pruned days on the next run, but revisits a day modified since', async () => {
    const now = Date.now();
    const oldDay = dayOf(now - 45 * DAY);
    const path = writeDay('steps', oldDay, [row('x', `${oldDay}T10:00:00.000Z`)]);
    expect((await applyReasoningRetention({ nowMs: now })).textPrunedFiles).toBe(1);
    expect((await applyReasoningRetention({ nowMs: now })).textPrunedFiles).toBe(0);
    // Someone appends text to the old day afterwards (e.g. a hand-written row).
    writeFileSync(path, readFileSync(path, 'utf8') + JSON.stringify(row('y', `${oldDay}T12:00:00.000Z`)) + '\n');
    const future = new Date(Date.now() + 60_000);
    utimesSync(path, future, future);
    const again = await applyReasoningRetention({ nowMs: now });
    expect(again.textPrunedRows).toBe(1);
    expect(readFileSync(path, 'utf8')).not.toContain('secret-free reasoning');
  });

  it('evicts oldest day files when the store exceeds its byte ceiling', async () => {
    const now = Date.now();
    const d1 = dayOf(now - 10 * DAY);
    const d2 = dayOf(now - 5 * DAY);
    const p1 = writeDay('steps', d1, Array.from({ length: 50 }, (_, i) => row(`a${i}`, `${d1}T10:00:00.000Z`, 'x'.repeat(200))));
    const p2 = writeDay('steps', d2, Array.from({ length: 50 }, (_, i) => row(`b${i}`, `${d2}T10:00:00.000Z`, 'x'.repeat(200))));
    const size2 = statSync(p2).size;
    const result = await applyReasoningRetention({ nowMs: now, maxStoreBytes: size2 + 10 });
    expect(result.evictedFiles).toBe(1);
    expect(existsSync(p1)).toBe(false);
    expect(existsSync(p2)).toBe(true);
    expect(result.bytesAfter).toBeLessThanOrEqual(size2 + 10);
  });

  it('is a no-op on an empty or missing store', async () => {
    const result = await applyReasoningRetention();
    expect(result).toMatchObject({ textPrunedFiles: 0, removedFiles: 0, evictedFiles: 0, bytesAfter: 0 });
  });
});
