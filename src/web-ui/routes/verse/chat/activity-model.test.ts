/**
 * chat/activity-model.test.ts — the activity row's sentence and its
 * auto-expand rule (SPEC-310C §2 "Activity groups").
 */
import { describe, expect, it } from 'vitest';
import type { ToolGroupItem, ToolGroupMember } from '../verse-store.js';
import { defaultActivityView, describeWork, focusMembers, summarizeActivity, type ActionCounts } from './activity-model.js';

let n = 0;
function tool(name: string, result: { output: string; isError: boolean } | null, input: unknown = {}): ToolGroupMember {
  n += 1;
  return { kind: 'tool', key: `k${n}`, turnId: 't1', at: '2026-09-24T10:00:00.000Z', toolUseId: `u${n}`, name, input, result, durationMs: null };
}
const ok = { output: 'ok', isError: false };
const bad = { output: 'boom', isError: true };

function group(items: ToolGroupMember[], spanMs: number | null = 134_000): Pick<ToolGroupItem, 'items' | 'spanMs'> {
  return { items, spanMs };
}

function counts(over: Partial<ActionCounts>): ActionCounts {
  return { read: 0, edit: 0, create: 0, delete: 0, command: 0, search: 0, task: 0, web: 0, other: 0, ...over };
}

describe('describeWork', () => {
  it('speaks actions, with the noun on the first clause only', () => {
    expect(describeWork(counts({ command: 12, read: 8, edit: 3 }))).toBe('Ran 12 commands, read 8, edited 3');
    expect(describeWork(counts({ read: 1 }))).toBe('Read 1 file');
    expect(describeWork(counts({ read: 2, create: 1 }))).toBe('Read 2 files, created 1');
  });

  it('keeps the noun where a bare verb would be ambiguous', () => {
    // "ran 2" after commands could mean either.
    expect(describeWork(counts({ command: 1, task: 2 }))).toBe('Ran 1 command, ran 2 subagents');
    expect(describeWork(counts({ web: 1, other: 2 }))).toBe('Fetched 1 page, used 2 other tools');
  });

  it('says nothing for nothing', () => {
    expect(describeWork(counts({}))).toBe('');
  });
});

describe('summarizeActivity', () => {
  it('reads "Ran 2 commands, read 1; 1 failed, 1 running" with no duration while running', () => {
    const s = summarizeActivity(group([tool('Bash', ok), tool('Bash', bad), tool('Read', null)]));
    expect(s.work).toBe('Ran 2 commands, read 1');
    expect(s.state).toBe('1 failed, 1 running');
    expect(s.failed).toBe(1);
    expect(s.running).toBe(1);
    // A running group's duration is still growing: the sentence leaves it out.
    expect(s.sentence).toBe('Ran 2 commands, read 1; 1 failed, 1 running');
  });

  it('adds the wall time once finished, and never a zero or unknown one', () => {
    expect(summarizeActivity(group([tool('Read', ok), tool('Edit', ok)])).sentence).toBe('Read 1 file, edited 1; 2m 14s');
    expect(summarizeActivity(group([tool('Read', ok), tool('Edit', ok)], null)).sentence).toBe('Read 1 file, edited 1');
    expect(summarizeActivity(group([tool('Read', ok), tool('Edit', ok)], 0)).spanMs).toBeNull();
  });

  it('classifies MCP-routed and vendor-specific names by what they do', () => {
    const s = summarizeActivity(group([tool('mcp__plugin_ashlr_ashlr__ashlr__edit', ok), tool('exec', ok), tool('run_terminal_cmd', ok)]));
    expect(s.work).toBe('Ran 2 commands, edited 1');
  });

  it('does not count reasoning as work', () => {
    const thought: ToolGroupMember = { kind: 'thinking', key: 'th', turnId: 't1', at: '2026-09-24T10:00:00.000Z', text: 'hmm', redacted: false, durationMs: null, estimatedTokens: null, thinkingKind: null };
    expect(summarizeActivity(group([tool('Read', ok), thought, tool('Read', ok)])).toolCount).toBe(2);
  });
});

describe('the auto-expand rule', () => {
  it('opens on focus when anything failed or is running, folds otherwise', () => {
    expect(defaultActivityView({ failed: 1, running: 0 })).toBe('focus');
    expect(defaultActivityView({ failed: 0, running: 2 })).toBe('focus');
    expect(defaultActivityView({ failed: 0, running: 0 })).toBe('collapsed');
  });

  it('focus shows the failed and running calls, in order, and counts the rest', () => {
    const members = [tool('Read', ok), tool('Bash', bad), tool('Read', ok), tool('Bash', null), tool('Edit', ok)];
    const f = focusMembers(group(members));
    expect(f.shown.map((m) => m.key)).toEqual([members[1]!.key, members[3]!.key]);
    expect(f.hidden).toBe(3);
  });
});
