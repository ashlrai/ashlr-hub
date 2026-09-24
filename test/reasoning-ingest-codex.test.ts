import { appendFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { codexInteractiveOptIn, codexSessionsRoot, ingestCodexRollouts } from '../src/core/reasoning/ingest-codex.js';
import { reasoningRoot, scanFeatures, scanSteps } from '../src/core/reasoning/store.js';
import type { TurnFeaturesV1 } from '../src/core/reasoning/extractors.js';
import type { ReasoningStepV1 } from '../src/core/reasoning/types.js';

let home: string;
let sessionsRoot: string;
let verseRoot: string;
const saved = { HOME: process.env['HOME'], CODEX_HOME: process.env['CODEX_HOME'], OPT: process.env['ASHLR_REASONING_CODEX_DESKTOP'] };

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'reasoning-codex-'));
  process.env['HOME'] = home;
  delete process.env['ASHLR_HOME'];
  delete process.env['CODEX_HOME'];
  delete process.env['ASHLR_REASONING_CODEX_DESKTOP'];
  sessionsRoot = join(home, '.codex', 'sessions');
  verseRoot = join(home, '.ashlr', 'verse');
});

afterEach(() => {
  process.env['HOME'] = saved.HOME;
  for (const [key, value] of [['CODEX_HOME', saved.CODEX_HOME], ['ASHLR_REASONING_CODEX_DESKTOP', saved.OPT]] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(home, { recursive: true, force: true });
});

const base = Date.now() - 2 * 3_600_000;
const ts = (s: number): string => new Date(base + s * 1_000).toISOString();
const line = (s: number, type: string, payload: Record<string, unknown>): string =>
  JSON.stringify({ timestamp: ts(s), type, payload });

function rolloutPath(name: string): string {
  const d = new Date(base);
  const dir = join(sessionsRoot, String(d.getUTCFullYear()), String(d.getUTCMonth() + 1).padStart(2, '0'), String(d.getUTCDate()).padStart(2, '0'));
  mkdirSync(dir, { recursive: true });
  return join(dir, `rollout-${name}.jsonl`);
}

function meta(threadId: string, originator: string): string {
  return line(0, 'session_meta', {
    id: threadId, cwd: join(home, 'code', 'svc'), originator, cli_version: '0.200.0',
    source: originator === 'codex_exec' ? 'exec' : 'vscode', base_instructions: { text: 'long system prompt' },
  });
}

/** A current-format turn: reasoning (+ duplicate item_completed), a failing then passing test around an edit. */
function currentTurn(turnId: string, s0: number): string[] {
  return [
    line(s0, 'turn_context', { turn_id: turnId, cwd: join(home, 'code', 'svc'), model: 'gpt-5.5' }),
    line(s0 + 1, 'event_msg', { type: 'task_started', turn_id: turnId }),
    line(s0 + 2, 'response_item', {
      type: 'reasoning', id: `rs_${turnId}`, summary: [{ type: 'summary_text', text: "**Plan** I'm not sure the cache is invalidated. It's unclear." }],
      encrypted_content: 'ENCRYPTEDBLOB-never-store-me',
    }),
    line(s0 + 2, 'event_msg', { type: 'item_completed', item: { type: 'Reasoning', id: `rs_${turnId}`, summary_text: ["**Plan** I'm not sure the cache is invalidated. It's unclear."], raw_content: [] } }),
    line(s0 + 3, 'response_item', { type: 'function_call', name: 'exec_command', arguments: JSON.stringify({ cmd: 'npm test' }), call_id: 'c1' }),
    line(s0 + 4, 'response_item', { type: 'function_call_output', call_id: 'c1', output: 'Chunk ID: 1a\nWall time: 1.0 seconds\nProcess exited with code 1\nOutput:\nFAIL' }),
    line(s0 + 4, 'event_msg', { type: 'item_completed', item: { type: 'CommandExecution', id: 'i1', command: ['/bin/zsh', '-lc', 'npm test'], cwd: '/x', exit_code: '1', status: 'completed', aggregated_output: 'FAIL' } }),
    line(s0 + 5, 'event_msg', { type: 'item_completed', item: { type: 'FileChange', id: 'i2', changes: { [join(home, 'code', 'svc', 'cache.ts')]: { type: 'update', content: 'x' } }, status: 'completed', stdout: '', stderr: '' } }),
    line(s0 + 6, 'event_msg', { type: 'item_completed', item: { type: 'CommandExecution', id: 'i3', command: ['/bin/zsh', '-lc', 'npm test'], cwd: '/x', exit_code: '0', status: 'completed', aggregated_output: 'ok' } }),
    line(s0 + 7, 'event_msg', { type: 'agent_message', message: 'Fixed; tests pass.' }),
    line(s0 + 8, 'event_msg', { type: 'task_complete', turn_id: turnId, last_agent_message: 'Fixed; tests pass.' }),
  ];
}

function write(path: string, lines: string[]): void {
  writeFileSync(path, lines.join('\n') + '\n');
}

const wide = { fromMs: Date.now() - 10 * 86_400_000, toMs: Date.now() + 86_400_000 };
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

function storeText(): string {
  const root = reasoningRoot();
  let text = '';
  for (const kind of ['steps', 'features', 'state']) {
    try {
      for (const name of readdirSync(join(root, kind))) text += readFileSync(join(root, kind, name), 'utf8');
    } catch { /* absent */ }
  }
  return text;
}

/** Signature/count pairs (each also carries its newest evidence ref). */
const sigs = (list: { signature: string; count: number }[] | undefined) => (list ?? []).map(({ signature, count }) => ({ signature, count }));

describe('ingestCodexRollouts', () => {
  it('ingests a codex exec rollout: deduped summary step, item_completed tools, win, never the encrypted blob', async () => {
    write(rolloutPath('exec1'), [meta('thread-exec-1', 'codex_exec'), ...currentTurn('turn-1', 10)]);
    const result = await ingestCodexRollouts({ sessionsRoot, verseRoot });
    expect(result).toMatchObject({ filesSeen: 1, filesRead: 1, steps: 1, features: 1 });
    const [step] = await steps();
    expect(step).toMatchObject({
      id: 'codex:thread-exec-1:rs_turn-1', source: 'codex-rollout', sessionId: 'thread-exec-1', engine: 'codex',
      model: 'gpt-5.5', kind: 'summary', turnId: 'turn-1', toolAfter: 'command_execution', repo: '~/code/svc',
    });
    const [feature] = await features();
    expect(feature).toMatchObject({
      id: 'codex:thread-exec-1:turn-1', outcome: 'ok', tests: 2, testsFailed: 1, testsPassed: 1, edits: 1, win: true,
      verifiedAfterEdit: true, claimUnverified: false, uncertaintyScore: 4,
    });
    expect(storeText()).not.toContain('ENCRYPTEDBLOB');
    expect(storeText()).not.toContain('long system prompt');
  });

  it('skips interactive conversations unless opted in, and re-evaluates when the policy changes', async () => {
    write(rolloutPath('desk1'), [meta('thread-desk', 'Codex Desktop'), ...currentTurn('turn-d', 10)]);
    const skipped = await ingestCodexRollouts({ sessionsRoot, verseRoot });
    expect(skipped).toMatchObject({ filesSkipped: 1, steps: 0, features: 0 });
    expect(await ingestCodexRollouts({ sessionsRoot, verseRoot })).toMatchObject({ filesSkipped: 1, bytesRead: 0 });
    const opted = await ingestCodexRollouts({ sessionsRoot, verseRoot, includeInteractive: true });
    expect(opted).toMatchObject({ filesRead: 1, steps: 1, features: 1 });
  });

  it('reads the consent switch from env or cfg', () => {
    expect(codexInteractiveOptIn()).toBe(false);
    expect(codexInteractiveOptIn({ reasoning: { codexDesktop: true } })).toBe(true);
    expect(codexInteractiveOptIn({ reasoning: { codexDesktop: 'yes' } })).toBe(false);
    process.env['ASHLR_REASONING_CODEX_DESKTOP'] = '1';
    expect(codexInteractiveOptIn()).toBe(true);
  });

  it('skips threads a Verse session owns (the Verse tap already recorded them)', async () => {
    mkdirSync(join(verseRoot, 'sessions'), { recursive: true });
    writeFileSync(join(verseRoot, 'sessions', 'v1.json'), JSON.stringify({ id: 'v1', engine: 'codex', nativeSessionId: 'thread-verse' }));
    write(rolloutPath('verse1'), [meta('thread-verse', 'codex_exec'), ...currentTurn('turn-v', 10)]);
    expect(await ingestCodexRollouts({ sessionsRoot, verseRoot })).toMatchObject({ filesSkipped: 1, features: 0 });
  });

  it('handles the older rollout generation (shell function calls, exec_command_end, agent_reasoning)', async () => {
    write(rolloutPath('old1'), [
      meta('thread-old', 'codex_exec'),
      line(1, 'turn_context', { cwd: '/w', model: 'gpt-5-codex' }),
      line(2, 'response_item', { type: 'reasoning', id: 'r1', summary: [{ type: 'summary_text', text: 'Actually, wait — revert the change.' }] }),
      line(2, 'event_msg', { type: 'agent_reasoning', text: 'Actually, wait — revert the change.' }),
      line(3, 'response_item', { type: 'function_call', name: 'shell', arguments: JSON.stringify({ command: ['bash', '-lc', 'pytest -q'] }), call_id: 'k1' }),
      line(4, 'event_msg', { type: 'exec_command_end', call_id: 'k1', exit_code: 2 }),
      line(5, 'response_item', { type: 'function_call', name: 'shell', arguments: JSON.stringify({ command: ['bash', '-lc', 'pytest -q'] }), call_id: 'k2' }),
      line(6, 'response_item', { type: 'function_call_output', call_id: 'k2', output: JSON.stringify({ output: 'E', metadata: { exit_code: 1 } }) }),
      line(7, 'event_msg', { type: 'turn_aborted', turn_id: 'x', reason: 'interrupted' }),
    ]);
    const result = await ingestCodexRollouts({ sessionsRoot, verseRoot });
    expect(result.steps).toBe(1);
    const [feature] = await features();
    expect(feature).toMatchObject({ outcome: 'cancelled', tests: 2, testsFailed: 2, model: 'gpt-5-codex' });
    expect(sigs(feature?.failures)).toEqual([{ signature: 'pytest', count: 2 }]);
    expect(feature?.struggle).toBe(true);
  });

  it('is incremental: an open turn is re-read when it completes, nothing is duplicated', async () => {
    const path = rolloutPath('grow');
    const turnLines = currentTurn('turn-g', 10);
    write(path, [meta('thread-grow', 'codex_exec'), ...turnLines.slice(0, -1)]);
    expect(await ingestCodexRollouts({ sessionsRoot, verseRoot })).toMatchObject({ steps: 0, features: 0 });
    // A partial trailing line is not consumed.
    appendFileSync(path, turnLines[turnLines.length - 1]!.slice(0, 20));
    expect(await ingestCodexRollouts({ sessionsRoot, verseRoot })).toMatchObject({ features: 0 });
    appendFileSync(path, turnLines[turnLines.length - 1]!.slice(20) + '\n');
    expect(await ingestCodexRollouts({ sessionsRoot, verseRoot })).toMatchObject({ steps: 1, features: 1 });
    // Second turn appended later.
    appendFileSync(path, currentTurn('turn-h', 100).join('\n') + '\n');
    expect(await ingestCodexRollouts({ sessionsRoot, verseRoot })).toMatchObject({ steps: 1, features: 1 });
    expect((await features()).map((f) => f.id).sort()).toEqual(['codex:thread-grow:turn-g', 'codex:thread-grow:turn-h']);
    expect(await steps()).toHaveLength(2);
    // Unchanged → no read at all.
    expect(await ingestCodexRollouts({ sessionsRoot, verseRoot })).toMatchObject({ bytesRead: 0, features: 0 });
  });

  it('respects the byte budget and resumes next pass', async () => {
    write(rolloutPath('big'), [meta('thread-big', 'codex_exec'), ...currentTurn('turn-1', 10), ...currentTurn('turn-2', 100)]);
    const first = await ingestCodexRollouts({ sessionsRoot, verseRoot, maxBytes: 3_000 });
    expect(first.truncated || first.features < 2).toBe(true);
    let total = first.features;
    for (let i = 0; i < 10 && total < 2; i += 1) {
      total += (await ingestCodexRollouts({ sessionsRoot, verseRoot, maxBytes: 3_000 })).features;
    }
    expect(total).toBe(2);
    expect((await features()).map((f) => f.id).sort()).toEqual(['codex:thread-big:turn-1', 'codex:thread-big:turn-2']);
  });

  it('honours CODEX_HOME and ignores rollouts older than the lookback', async () => {
    process.env['CODEX_HOME'] = join(home, 'alt-codex');
    expect(codexSessionsRoot()).toBe(join(home, 'alt-codex', 'sessions'));
    const oldDir = join(sessionsRoot, '2020', '01', '01');
    mkdirSync(oldDir, { recursive: true });
    write(join(oldDir, 'rollout-ancient.jsonl'), [meta('thread-ancient', 'codex_exec'), ...currentTurn('t', 1)]);
    expect(await ingestCodexRollouts({ sessionsRoot, verseRoot })).toMatchObject({ filesSeen: 0 });
  });
});
