import { appendFileSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  featureFromDiagnosticRow,
  ingestFleetAgentLogs,
  parseLegacyAgentLog,
} from '../src/core/reasoning/ingest-fleet.js';
import { scanFeatures, scanSteps } from '../src/core/reasoning/store.js';
import type { TurnFeaturesV1 } from '../src/core/reasoning/extractors.js';
import type { ReasoningStepV1 } from '../src/core/reasoning/types.js';

let home: string;
let logsDir: string;
const savedHome = process.env['HOME'];

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'reasoning-fleet-'));
  process.env['HOME'] = home;
  delete process.env['ASHLR_HOME'];
  logsDir = join(home, '.ashlr', 'agent-logs');
  mkdirSync(logsDir, { recursive: true });
});

afterEach(() => {
  process.env['HOME'] = savedHome;
  rmSync(home, { recursive: true, force: true });
});

const wide = { fromMs: Date.now() - 400 * 86_400_000, toMs: Date.now() + 86_400_000 };
async function steps(): Promise<ReasoningStepV1[]> {
  const out: ReasoningStepV1[] = [];
  await scanSteps(wide, (s) => { out.push(s); });
  return out;
}
async function features(): Promise<TurnFeaturesV1[]> {
  const out: TurnFeaturesV1[] = [];
  await scanFeatures(wide, (f) => { out.push(f); });
  return out;
}

const recent = new Date(Date.now() - 2 * 86_400_000).toISOString();
const j = (value: unknown): string => JSON.stringify(value);

const LEGACY_LOG = [
  '',
  `=== invocation ${recent} codex (codex:gpt-5.5) sandbox=55e011304898 worktree=/tmp/sandboxes/55e/worktree ===`,
  'ok=false terminationReason=- durationMs=114',
  "error=Error loading config.toml: unknown variant `ultra`, expected one of",
  'tokensIn=? tokensOut=?',
  'cmd=codex exec --json Write hello world',
  '--- agent output (truncated 40k) ---',
  'aborted_streaming',
  '',
  '=== claude (claude:claude-opus-4-8) sandbox=f26433daef66 worktree=/tmp/sandboxes/f26/worktree ===',
  'ok=true terminationReason=- durationMs=77239',
  'error=-',
  'tokensIn=22649 tokensOut=5362',
  'cmd=claude -p <!-- repo-map -->',
  '# src/core/types.ts  (refs: 492)',
  '--- agent output (truncated 40k) ---',
  j({ type: 'system', subtype: 'init', model: 'claude-opus-4-8', cwd: '/tmp/x' }),
  j({ type: 'assistant', message: { content: [{ type: 'thinking', thinking: "I'm not sure the test harness is wired; unclear." }] } }),
  j({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'u1', name: 'Bash', input: { command: 'npm test' } }] } }),
  j({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'u1', is_error: true, content: 'FAIL' }] } }),
  j({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'u2', name: 'Edit', input: { file_path: '/tmp/x/a.ts' } }] } }),
  j({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'u2', is_error: false, content: 'ok' }] } }),
  j({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'u3', name: 'Bash', input: { command: 'npm test' } }] } }),
  j({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'u3', is_error: false, content: 'ok' }] } }),
  j({ type: 'result', subtype: 'success', is_error: false }),
  '{"type":"assistant","message":{"content":[{"type":"text","text":"trunc',
].join('\n');

describe('parseLegacyAgentLog', () => {
  it('splits invocation sections with and without timestamps', () => {
    const sections = parseLegacyAgentLog(LEGACY_LOG);
    expect(sections).toHaveLength(2);
    expect(sections[0]).toMatchObject({ engine: 'codex', model: 'gpt-5.5', ok: false, durationMs: 114, at: recent });
    expect(sections[0]?.error).toContain('unknown variant');
    expect(sections[1]).toMatchObject({ engine: 'claude', model: 'claude-opus-4-8', ok: true, at: null, error: null });
    // the prompt after cmd= is not output
    expect(sections[1]?.outputLines.some((l) => l.includes('repo-map'))).toBe(false);
  });
});

describe('featureFromDiagnosticRow', () => {
  it('maps a metadata row and shortens the 64-hex run ref', () => {
    const feature = featureFromDiagnosticRow({
      schemaVersion: 1, ts: recent, runRef: 'a'.repeat(64), engine: 'claude', ok: false, errorClass: 'rate-limit',
      durationMs: 1000, attempt: 2, maxAttempts: 3,
    });
    expect(feature).toMatchObject({ source: 'fleet', runId: `rr-${'a'.repeat(24)}`, outcome: 'error', errorClass: 'rate-limit', turnId: 'a2', struggle: true });
    expect(featureFromDiagnosticRow({ schemaVersion: 2 })).toBeNull();
    expect(featureFromDiagnosticRow({ schemaVersion: 1, ts: recent, runRef: 'nothex', engine: 'x' })).toBeNull();
  });

  it('falls back to terminationReason when the error class is none', () => {
    const feature = featureFromDiagnosticRow({ schemaVersion: 1, ts: recent, runRef: 'b'.repeat(64), engine: 'codex', ok: false, errorClass: 'none', terminationReason: 'idle-stall', durationMs: 5 });
    expect(feature?.errorClass).toBe('idle-stall');
  });
});

describe('ingestFleetAgentLogs', () => {
  it('ingests legacy logs (steps + features) and metadata rows, incrementally', async () => {
    const logPath = join(logsDir, 'run-mr128x0k-lzumou.log');
    writeFileSync(logPath, LEGACY_LOG);
    const mtime = new Date(Date.now() - 86_400_000);
    utimesSync(logPath, mtime, mtime);
    const meta = join(logsDir, `${'c'.repeat(64)}.jsonl`);
    writeFileSync(meta, [
      j({ schemaVersion: 1, ts: recent, runRef: 'c'.repeat(64), engine: 'claude', ok: true, errorClass: 'none', durationMs: 340442, attempt: 1, maxAttempts: 3 }),
      j({ schemaVersion: 1, ts: recent, runRef: 'c'.repeat(64), engine: 'codex', ok: false, errorClass: 'configuration', durationMs: 90, attempt: 2, maxAttempts: 3 }),
    ].join('\n') + '\n');
    writeFileSync(join(logsDir, 'unrelated.txt'), 'x');

    const first = await ingestFleetAgentLogs({ logsDir });
    expect(first).toMatchObject({ filesSeen: 2, filesRead: 2, invocations: 4, steps: 1, features: 4 });

    const [step] = await steps();
    expect(step).toMatchObject({ source: 'fleet', runId: 'run-mr128x0k-lzumou', sessionId: null, engine: 'claude', model: 'claude-opus-4-8', kind: 'thinking', toolAfter: 'Bash' });
    const all = await features();
    const claude = all.find((f) => f.id === 'fleet:run-mr128x0k-lzumou:inv1');
    expect(claude).toMatchObject({ outcome: 'ok', tests: 2, testsFailed: 1, testsPassed: 1, edits: 1, win: true, uncertaintyScore: 4 });
    const codex = all.find((f) => f.id === 'fleet:run-mr128x0k-lzumou:inv0');
    expect(codex).toMatchObject({ outcome: 'error', errorClass: 'configuration', engine: 'codex', repo: null });
    expect(all.filter((f) => f.runId === `rr-${'c'.repeat(24)}`)).toHaveLength(2);

    // Nothing changed → nothing re-read.
    expect(await ingestFleetAgentLogs({ logsDir })).toMatchObject({ filesRead: 0, features: 0 });

    // A new metadata row (plus a torn tail) → exactly one new feature.
    appendFileSync(meta, j({ schemaVersion: 1, ts: recent, runRef: 'c'.repeat(64), engine: 'claude', ok: false, errorClass: 'timeout', durationMs: 5, attempt: 3, maxAttempts: 3 }) + '\n{"schemaVersion":1,"ts"');
    expect(await ingestFleetAgentLogs({ logsDir })).toMatchObject({ features: 1 });
    const later = new Date(Date.parse(recent) + 1_000).toISOString();
    appendFileSync(meta, `:"${later}","runRef":"${'c'.repeat(64)}","engine":"codex","ok":true,"errorClass":"none","durationMs":1,"attempt":1,"maxAttempts":1}\n`);
    expect(await ingestFleetAgentLogs({ logsDir })).toMatchObject({ features: 1 });
    expect((await features()).length).toBe(6);
  });

  it('returns quietly when the logs directory does not exist', async () => {
    await expect(ingestFleetAgentLogs({ logsDir: join(home, 'missing') })).resolves.toMatchObject({ filesSeen: 0 });
  });
});
