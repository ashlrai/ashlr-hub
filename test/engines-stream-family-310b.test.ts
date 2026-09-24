/**
 * V3.10 R3a — the stall monitor sees grok's tool calls (run/engines.ts).
 *
 * INT4 found `normaliseEngineOutputLine` compared the FULL bin path to
 * 'claude'/'codex' and never read tool_use inside `assistant` envelopes or
 * `stream_event` wrappers, so a grok-cli producer (pinned binary
 * `grok-0.2.118-…`, or the seat launcher `node launcher.mjs …`) produced only
 * raw events: the loop check could not fire and the no-diff check had to be
 * switched off for grok. These tests pin:
 *  - family detection by basename and by declared output format;
 *  - one tool_call per tool_use (streamed pieces + envelope deduplicated by
 *    id), carrying its arguments (loop hashing needs them);
 *  - a `file_touched` for mutating tools whatever the CLI calls them
 *    (grok's `search_replace`);
 *  - end to end through spawnEngine with a fake grok binary (no network, no
 *    paid seat): a real loop is stopped as `loop-stall`, a real editor is not
 *    stopped by the no-diff check, a spinner is stopped as `no-diff-stall`.
 */
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createEngineOutputNormaliser, engineStreamFamily, spawnEngine } from '../src/core/run/engines.js';
import type { AshlrConfig } from '../src/core/types.js';

const GROK_ARGS = ['--no-auto-update', '--output-format', 'streaming-messages-json', '--cwd', '/w', '--permission-mode', 'dontAsk', '--single=goal'];

describe('engineStreamFamily', () => {
  it('matches by basename, not the full path', () => {
    expect(engineStreamFamily({ bin: '/opt/homebrew/bin/claude', args: ['-p', 'x'] })).toBe('anthropic');
    expect(engineStreamFamily({ bin: 'claude', args: [] })).toBe('anthropic');
    expect(engineStreamFamily({ bin: '/usr/local/bin/codex', args: ['exec'] })).toBe('codex');
    expect(engineStreamFamily({ bin: 'C:\\tools\\codex.exe', args: [] })).toBe('codex');
    expect(engineStreamFamily({ bin: '/Users/x/.grok/downloads/grok-0.2.118-macos-aarch64', args: GROK_ARGS })).toBe('anthropic');
    expect(engineStreamFamily({ bin: 'grok', args: [] })).toBe('anthropic');
  });

  it('recognises the grok-cli seat launcher form by its declared output format', () => {
    expect(engineStreamFamily({ bin: '/Users/x/.ashlr/accounts/grok-a/node', args: ['/p/launcher.mjs', ...GROK_ARGS] })).toBe('anthropic');
    expect(engineStreamFamily({ bin: 'node', args: ['x.mjs', '--output-format=stream-json'] })).toBe('anthropic');
  });

  it('leaves unrelated binaries generic (a goal that merely mentions a format is one argv element)', () => {
    expect(engineStreamFamily({ bin: 'aider', args: ['--message', 'use --output-format streaming-messages-json'] })).toBe('generic');
    expect(engineStreamFamily({ bin: 'grokker', args: [] })).toBe('generic');
  });
});

const line = (v: unknown): string => JSON.stringify(v);

describe('createEngineOutputNormaliser (anthropic wire)', () => {
  it('assembles a streamed tool_use into ONE tool_call with its arguments', () => {
    const n = createEngineOutputNormaliser({ bin: 'grok-0.2.118-macos-aarch64', args: GROK_ARGS });
    const events = [
      ...n.line(line({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_1', name: 'read_file', input: {} } }), 1),
      ...n.line(line({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"path":' } }), 2),
      ...n.line(line({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '"src/a.ts"}' } }), 3),
      ...n.line(line({ type: 'content_block_stop', index: 1 }), 4),
      // The same block again as a whole envelope (partial messages on): not counted twice.
      ...n.line(line({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_1', name: 'read_file', input: { path: 'src/a.ts' } }] } }), 5),
    ];
    const calls = events.filter((e) => e.kind === 'tool_call');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ toolName: 'read_file', text: '{"path":"src/a.ts"}' });
    expect(events.filter((e) => e.kind === 'file_touched')).toHaveLength(0);
  });

  it('reads stream_event wrappers and whole envelopes; mutating tools also touch a file', () => {
    const n = createEngineOutputNormaliser({ bin: '/abs/claude', args: [] });
    const wrapped = n.line(line({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 't2', name: 'search_replace', input: { file_path: 'a.ts', old: 'x', new: 'y' } } } }), 1);
    expect(wrapped.every((e) => e.kind !== 'tool_call')).toBe(true);
    const stopped = n.line(line({ type: 'stream_event', event: { type: 'content_block_stop', index: 0 } }), 2);
    expect(stopped.map((e) => e.kind)).toEqual(['tool_call', 'file_touched']);
    expect(stopped[1]).toMatchObject({ fileTouched: 'a.ts' });

    const env = n.line(line({ type: 'assistant', message: { content: [
      { type: 'text', text: 'editing' },
      { type: 'tool_use', id: 't3', name: 'apply_patch', input: { path: 'b.ts' } },
      { type: 'tool_use', id: 't4', name: 'list_dir', input: { path: '.' } },
    ] } }), 3);
    expect(env.map((e) => [e.kind, e.toolName ?? e.fileTouched])).toEqual([
      ['tool_call', 'apply_patch'], ['file_touched', 'b.ts'], ['tool_call', 'list_dir'],
    ]);
  });

  it('text deltas become text; the terminal result becomes usage; non-JSON stays raw', () => {
    const n = createEngineOutputNormaliser({ bin: 'grok', args: GROK_ARGS });
    expect(n.line(line({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } }), 1)).toMatchObject([{ kind: 'text', text: 'hi' }]);
    expect(n.line(line({ type: 'result', subtype: 'success', usage: { input_tokens: 250, output_tokens: 50 } }), 2)).toMatchObject([{ kind: 'usage', text: 'tokensIn=250 tokensOut=50' }]);
    expect(n.line('grok: warming up', 3)).toMatchObject([{ kind: 'raw', text: 'grok: warming up' }]);
  });

  it('a generic engine never interprets Anthropic shapes (unchanged)', () => {
    const n = createEngineOutputNormaliser({ bin: 'aider', args: [] });
    expect(n.line(line({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'x', name: 'write_file', input: {} }] } }), 1)[0]!.kind).toBe('raw');
  });

  it('codex keeps its JSONL tool calls, matched by basename', () => {
    const n = createEngineOutputNormaliser({ bin: '/opt/bin/codex', args: ['exec'] });
    expect(n.line(line({ type: 'function_call', name: 'shell' }), 1)).toMatchObject([{ kind: 'tool_call', toolName: 'shell' }]);
  });
});

// ---------------------------------------------------------------------------
// End to end: spawnEngine + the real stall monitor, fake grok binary.
// ---------------------------------------------------------------------------

let dir: string;

beforeEach(() => {
  const home = realpathSync(homedir());
  mkdirSync(join(home, 'work'), { recursive: true });
  dir = realpathSync(mkdtempSync(join(home, 'work', 'r3a-grok-')));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** A fake pinned grok binary that prints `lines` as NDJSON, then idles until stopped. */
function fakeGrok(lines: unknown[]): string {
  const bin = join(dir, 'grok-0.2.118-macos-aarch64');
  writeFileSync(
    bin,
    `#!${process.execPath}\n` +
      `for (const l of ${JSON.stringify(lines.map((l) => JSON.stringify(l)))}) process.stdout.write(l + '\\n');\n` +
      `setTimeout(() => process.exit(0), 800);\n`,
  );
  chmodSync(bin, 0o755);
  return bin;
}

function toolUse(id: string, name: string, input: Record<string, unknown>) {
  return { type: 'assistant', message: { id: `m-${id}`, content: [{ type: 'tool_use', id, name, input }] } };
}

async function run(bin: string, noDiffMinEvents: number) {
  const cfg = { foundry: { noDiffMinEvents } } as unknown as AshlrConfig;
  return spawnEngine({ bin, args: GROK_ARGS, cwd: dir }, cfg, { env: { ...process.env }, timeoutMs: 20_000, _stallGraceMs: 200, _terminationDrainMs: 200 });
}

describe('spawnEngine stall monitor on a grok stream', () => {
  it('stops a real tool-call loop as loop-stall', async () => {
    const lines = Array.from({ length: 8 }, (_, i) => toolUse(`t${i}`, 'read_file', { path: 'same.ts' }));
    const res = await run(fakeGrok(lines), 1_000);
    expect(res.terminationReason).toBe('loop-stall');
  });

  it('does not call six reads of six different files a loop', async () => {
    const lines = Array.from({ length: 8 }, (_, i) => toolUse(`t${i}`, 'read_file', { path: `f${i}.ts` }));
    const res = await run(fakeGrok(lines), 1_000);
    expect(res.terminationReason).toBeUndefined();
    expect(res.ok).toBe(true);
  });

  it('an editing grok run (search_replace) is not stopped by the no-diff check', async () => {
    const lines = [
      ...Array.from({ length: 5 }, (_, i) => toolUse(`r${i}`, 'read_file', { path: `f${i}.ts` })),
      toolUse('e1', 'search_replace', { file_path: 'f1.ts', old_string: 'a', new_string: 'b' }),
      ...Array.from({ length: 10 }, (_, i) => toolUse(`s${i}`, 'list_dir', { path: `d${i}` })),
    ];
    const res = await run(fakeGrok(lines), 12);
    expect(res.terminationReason).toBeUndefined();
    expect(res.ok).toBe(true);
  });

  it('a grok run that only reads is stopped as no-diff-stall', async () => {
    const lines = Array.from({ length: 16 }, (_, i) => toolUse(`r${i}`, 'read_file', { path: `f${i}.ts` }));
    const res = await run(fakeGrok(lines), 12);
    expect(res.terminationReason).toBe('no-diff-stall');
  });
});
