/**
 * chat/tasks-model.test.ts — what "◌ N running tasks" counts, and the Tasks
 * pane's lists; plus chat/turn-files (the Review pane's "This turn").
 */
import { describe, expect, it } from 'vitest';
import type { VerseEvent } from '../../../data/api-types.js';
import type { VerseActivityResponse } from '../../../../core/verse/workbench-types.js';
import { ev, session } from '../fixtures.test-support.js';
import { buildTranscript } from '../verse-transcript.js';
import { countTasks, currentTurnTasks, describeTaskCounts, otherRunningChats } from './tasks-model.js';
import { lastTurnFiles } from './turn-files.js';

const LOG: VerseEvent[] = [
  ev(1, 'user-message', { turnId: 't0', text: 'earlier' }),
  ev(2, 'tool-use', { turnId: 't0', toolUseId: 'old', name: 'Bash', input: { command: 'ls' } }),
  ev(3, 'tool-result', { turnId: 't0', toolUseId: 'old', output: '', isError: false }),
  ev(4, 'user-message', { turnId: 't1', text: 'fix it' }),
  ev(5, 'tool-use', { turnId: 't1', toolUseId: 'r', name: 'Read', input: { file_path: '/repo/a.ts' } }),
  ev(6, 'tool-result', { turnId: 't1', toolUseId: 'r', output: 'x', isError: false }),
  ev(7, 'tool-use', { turnId: 't1', toolUseId: 'e', name: 'Edit', input: { file_path: '/repo/src/b.ts', old_string: 'a', new_string: 'b' } }),
  ev(8, 'tool-result', { turnId: 't1', toolUseId: 'e', output: 'ok', isError: false }),
  ev(9, 'tool-use', { turnId: 't1', toolUseId: 'bad', name: 'Write', input: { file_path: '/repo/c.ts', content: 'x' } }),
  ev(10, 'tool-result', { turnId: 't1', toolUseId: 'bad', output: 'denied', isError: true }),
  ev(11, 'tool-use', { turnId: 't1', toolUseId: 'sub', name: 'Task', input: { description: 'review the auth module' } }),
  ev(12, 'tool-use', { turnId: 't1', toolUseId: 'sh', name: 'Bash', input: { command: 'npm test' } }),
];

describe('currentTurnTasks', () => {
  it('lists only the latest turn: running first (in start order), then finished, newest first', () => {
    const tasks = currentTurnTasks(buildTranscript(LOG).items);
    expect(tasks.map((t) => [t.toolUseId, t.status, t.kind])).toEqual([
      ['sub', 'running', 'subagent'],
      ['sh', 'running', 'tool'],
      ['bad', 'failed', 'tool'],
      ['e', 'done', 'tool'],
      ['r', 'done', 'tool'],
    ]);
    expect(tasks[1]!.detail).toBe('npm test');
  });
});

describe('otherRunningChats + counts', () => {
  const sessions = [
    session({ id: 'vs_1', status: 'running' }),
    session({ id: 'vs_2', status: 'running', title: 'Docs' }),
    session({ id: 'vs_3', status: 'idle' }),
  ];

  it('excludes the open chat, prefers activity, and falls back to the list', () => {
    const activity = {
      running: [{ sessionId: 'vs_2', title: 'Docs', engine: 'local', seatId: 'local:q', startedAt: '2026-09-24T10:00:00.000Z',
        live: { phase: 'tool', tool: 'npm run build', elapsedMs: 1000, thinkingTail: null } }],
    } as unknown as VerseActivityResponse;
    expect(otherRunningChats(sessions, activity, 'vs_1')).toEqual([
      { sessionId: 'vs_2', title: 'Docs', engine: 'local', startedAt: '2026-09-24T10:00:00.000Z', live: 'npm run build' },
    ]);
    // No activity route: the session list still knows who is running (start unknown, not guessed).
    expect(otherRunningChats(sessions, null, 'vs_3').map((c) => [c.sessionId, c.startedAt])).toEqual([['vs_1', null], ['vs_2', null]]);
  });

  it('counts this turn’s running calls plus the other chats', () => {
    const turn = currentTurnTasks(buildTranscript(LOG).items);
    const counts = countTasks(turn, otherRunningChats(sessions, null, 'vs_1'));
    expect(counts).toEqual({ turn: 2, subagents: 1, chats: 1, total: 3 });
    expect(describeTaskCounts(counts)).toBe('3 running tasks: 2 in this chat, 1 other chat');
    expect(describeTaskCounts(countTasks([], []))).toBe('0 running tasks');
  });
});

describe('lastTurnFiles', () => {
  it('lists the latest turn’s successful edits, relative to the root that holds them', () => {
    expect(lastTurnFiles(LOG, ['/repo'])).toEqual([{ root: '/repo', path: 'src/b.ts' }]);
  });

  it('prefers the most specific root, and drops a path under none of them', () => {
    const log: VerseEvent[] = [
      ev(1, 'user-message', { turnId: 't1', text: 'go' }),
      ev(2, 'tool-use', { turnId: 't1', toolUseId: 'a', name: 'Write', input: { file_path: '/repo/wt/x.ts', content: 'x' } }),
      ev(3, 'tool-result', { turnId: 't1', toolUseId: 'a', output: 'ok', isError: false }),
      ev(4, 'tool-use', { turnId: 't1', toolUseId: 'b', name: 'Write', input: { file_path: '/elsewhere/y.ts', content: 'y' } }),
      ev(5, 'tool-result', { turnId: 't1', toolUseId: 'b', output: 'ok', isError: false }),
    ];
    expect(lastTurnFiles(log, ['/repo', '/repo/wt'])).toEqual([{ root: '/repo/wt', path: 'x.ts' }]);
    expect(lastTurnFiles(log, [])).toEqual([]);
  });
});
