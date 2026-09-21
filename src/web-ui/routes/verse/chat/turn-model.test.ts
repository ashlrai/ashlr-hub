import { describe, expect, it } from 'vitest';
import { ev } from '../fixtures.test-support.js';
import { buildTranscript, groupTranscriptItems } from '../verse-store.js';
import {
  buildTurns,
  countDiffLines,
  createTurnCache,
  describeFiles,
  searchTurns,
  turnTitle,
  type TurnBlock,
} from './turn-model.js';

function turnsFor(events: Parameters<typeof buildTranscript>[0]): TurnBlock[] {
  return buildTurns(groupTranscriptItems(buildTranscript(events).items)).turns;
}

describe('buildTurns', () => {
  it('starts a new turn at each user message', () => {
    const turns = turnsFor([
      ev(1, 'user-message', { turnId: 't1', text: 'first ask' }),
      ev(2, 'assistant-message', { turnId: 't1', text: 'first answer' }),
      ev(3, 'turn-done', { turnId: 't1', ok: true, nativeSessionId: null, durationMs: 1200 }),
      ev(4, 'user-message', { turnId: 't2', text: 'second ask' }),
      ev(5, 'assistant-message', { turnId: 't2', text: 'second answer' }),
    ]);
    expect(turns).toHaveLength(2);
    expect(turns[0]!.prompt).toBe('first ask');
    expect(turns[0]!.status).toBe('ok');
    expect(turns[0]!.durationMs).toBe(1200);
    expect(turns[1]!.prompt).toBe('second ask');
    // No terminal event yet — the turn is still open, not failed.
    expect(turns[1]!.status).toBe('running');
  });

  it('keeps leading items that arrived before any user message', () => {
    const turns = turnsFor([
      ev(1, 'assistant-message', { turnId: 't0', text: 'resumed tail' }),
      ev(2, 'user-message', { turnId: 't1', text: 'ask' }),
    ]);
    expect(turns).toHaveLength(2);
    expect(turns[0]!.prompt).toBeNull();
  });

  it('summarizes which files a turn read, edited and created, with line deltas', () => {
    const turns = turnsFor([
      ev(1, 'user-message', { turnId: 't1', text: 'refactor' }),
      ev(2, 'tool-use', { turnId: 't1', toolUseId: 'a', name: 'Read', input: { file_path: 'src/a.ts' } }),
      ev(3, 'tool-result', { turnId: 't1', toolUseId: 'a', output: 'contents', isError: false }),
      ev(4, 'tool-use', {
        turnId: 't1', toolUseId: 'b', name: 'Edit',
        input: { file_path: 'src/a.ts', old_string: 'one\ntwo', new_string: 'ONE\nTWO\nTHREE' },
      }),
      ev(5, 'tool-result', { turnId: 't1', toolUseId: 'b', output: 'ok', isError: false }),
      ev(6, 'tool-use', {
        turnId: 't1', toolUseId: 'c', name: 'Write',
        input: { file_path: 'src/new.ts', content: 'x\ny\n' },
      }),
      ev(7, 'tool-result', { turnId: 't1', toolUseId: 'c', output: 'File created successfully at: src/new.ts', isError: false }),
    ]);
    const [turn] = turns;
    expect(turn!.toolCount).toBe(3);
    expect(turn!.files).toHaveLength(2);

    const edited = turn!.files.find((f) => f.path === 'src/a.ts')!;
    // Read AND edited: the stronger action wins the row, and the row's jump
    // target is the call that CHANGED the file, not the read before it.
    expect(edited.action).toBe('edit');
    expect(edited.reads).toBe(1);
    expect(edited.edits).toBe(1);
    expect(edited.anchorToolUseId).toBe('b');
    expect(edited.additions).toBe(3);
    expect(edited.deletions).toBe(2);

    const created = turn!.files.find((f) => f.path === 'src/new.ts')!;
    expect(created.action).toBe('create');
    expect(created.additions).toBe(2);

    expect(describeFiles(turn!.files)).toBe('1 created, 1 edited');
  });

  it('counts failures and points at the first one', () => {
    const turns = turnsFor([
      ev(1, 'user-message', { turnId: 't1', text: 'build' }),
      ev(2, 'tool-use', { turnId: 't1', toolUseId: 'a', name: 'Bash', input: { command: 'npm run build' } }),
      ev(3, 'tool-result', { turnId: 't1', toolUseId: 'a', output: 'boom\nExit code: 1', isError: true }),
      ev(4, 'tool-use', { turnId: 't1', toolUseId: 'b', name: 'Read', input: { file_path: 'src/a.ts' } }),
      ev(5, 'tool-result', { turnId: 't1', toolUseId: 'b', output: 'ok', isError: false }),
      ev(6, 'error', { turnId: 't1', message: 'engine gave up' }),
    ]);
    const [turn] = turns;
    expect(turn!.errorCount).toBe(2);
    expect(turn!.firstErrorAnchor).toBe('verse-tool-a');
    expect(turn!.status).toBe('error');
    expect(turn!.commandCount).toBe(1);
  });

  it('treats a stopped turn as stopped, not as a failure', () => {
    const turns = turnsFor([
      ev(1, 'user-message', { turnId: 't1', text: 'go' }),
      ev(2, 'cancelled', { turnId: 't1' }),
      ev(3, 'turn-done', { turnId: 't1', ok: false, nativeSessionId: null, durationMs: 800 }),
    ]);
    expect(turns[0]!.status).toBe('stopped');
    expect(turns[0]!.errorCount).toBe(0);
  });

  it('flags a turn that ended with no result and nothing to explain it', () => {
    const turns = turnsFor([
      ev(1, 'user-message', { turnId: 't1', text: 'go' }),
      ev(2, 'turn-done', { turnId: 't1', ok: false, nativeSessionId: null, durationMs: 10 }),
    ]);
    expect(turns[0]!.status).toBe('error');
    expect(turns[0]!.errorCount).toBe(1);
    expect(turns[0]!.firstErrorAnchor).toBe('verse-note-td-2');
  });

  it('exposes every failure in the session in document order', () => {
    const model = buildTurns(groupTranscriptItems(buildTranscript([
      ev(1, 'user-message', { turnId: 't1', text: 'a' }),
      ev(2, 'tool-use', { turnId: 't1', toolUseId: 'x', name: 'Bash', input: { command: 'false' } }),
      ev(3, 'tool-result', { turnId: 't1', toolUseId: 'x', output: '', isError: true }),
      ev(4, 'user-message', { turnId: 't2', text: 'b' }),
      ev(5, 'error', { turnId: 't2', message: 'nope' }),
    ]).items));
    expect(model.errorAnchors).toEqual(['verse-tool-x', 'verse-note-e-5']);
    expect(model.facts.get('x')!.action).toBe('command');
  });
});

describe('countDiffLines', () => {
  it('ignores the file headers', () => {
    const diff = '--- a/x\n+++ b/x\n@@ -1,2 +1,2 @@\n-old\n+new\n context';
    expect(countDiffLines(diff)).toEqual({ additions: 1, deletions: 1 });
  });

  it('counts content lines that themselves begin with --- or +++', () => {
    // A diff OF a diff: every changed line carries a diff marker of its own.
    // The old flat scan skipped all four as if they were file headers and
    // reported 0/0 for a call that rewrote the whole hunk.
    const diff = [
      '--- a/fixture.patch',
      '+++ b/fixture.patch',
      '@@ -1,4 +1,4 @@',
      '---- a/old/path.ts',
      '-+++ b/old/path.ts',
      '+--- a/new/path.ts',
      '++++ b/new/path.ts',
    ].join('\n');
    expect(countDiffLines(diff)).toEqual({ additions: 2, deletions: 2 });
  });

  it('counts a deleted Markdown rule, which is a bare ---- once marked', () => {
    const diff = '--- a/README.md\n+++ b/README.md\n@@ -1,2 +1,1 @@\n----\n title';
    expect(countDiffLines(diff)).toEqual({ additions: 0, deletions: 1 });
  });

  it('sums every file of a multi-file patch', () => {
    const diff = [
      'diff --git a/one.ts b/one.ts',
      '--- a/one.ts',
      '+++ b/one.ts',
      '@@ -1,1 +1,2 @@',
      ' keep',
      '+added',
      'diff --git a/two.ts b/two.ts',
      '--- a/two.ts',
      '+++ b/two.ts',
      '@@ -1,2 +1,1 @@',
      ' keep',
      '-gone',
    ].join('\n');
    expect(countDiffLines(diff)).toEqual({ additions: 1, deletions: 1 });
  });

  it('reports nothing for text that is not a diff at all', () => {
    expect(countDiffLines('just some tool output\nwith two lines')).toEqual({
      additions: 0,
      deletions: 0,
    });
  });
});

describe('searchTurns', () => {
  const turns = turnsFor([
    ev(1, 'user-message', { turnId: 't1', text: 'fix the login bug' }),
    ev(2, 'tool-use', { turnId: 't1', toolUseId: 'a', name: 'Grep', input: { pattern: 'session cookie' } }),
    ev(3, 'tool-result', { turnId: 't1', toolUseId: 'a', output: 'src/auth.ts:12', isError: false }),
    ev(4, 'user-message', { turnId: 't2', text: 'now write a test' }),
    ev(5, 'assistant-message', { turnId: 't2', text: 'Added auth.test.ts.' }),
  ]);

  it('searches prose, tool arguments and tool output alike', () => {
    expect(searchTurns(turns, 'login').map((m) => m.turnKey)).toEqual([turns[0]!.key]);
    expect(searchTurns(turns, 'session cookie').map((m) => m.turnKey)).toEqual([turns[0]!.key]);
    expect(searchTurns(turns, 'src/auth.ts').map((m) => m.turnKey)).toEqual([turns[0]!.key]);
    expect(searchTurns(turns, 'auth')).toHaveLength(2);
  });

  it('is case-insensitive and returns a snippet around the hit', () => {
    const [match] = searchTurns(turns, 'LOGIN');
    expect(match!.snippet).toContain('login');
  });

  it('returns nothing for an empty query', () => {
    expect(searchTurns(turns, '   ')).toEqual([]);
  });
});

describe('turnTitle', () => {
  it('uses the ask, then the tool count, then a fallback', () => {
    const [withPrompt] = turnsFor([ev(1, 'user-message', { turnId: 't1', text: 'do  the\nthing' })]);
    expect(turnTitle(withPrompt!)).toBe('do the thing');

    const [toolsOnly] = turnsFor([
      ev(1, 'tool-use', { turnId: 't1', toolUseId: 'a', name: 'Read', input: { file_path: '/a' } }),
      ev(2, 'tool-result', { turnId: 't1', toolUseId: 'a', output: '', isError: false }),
    ]);
    expect(turnTitle(toolsOnly!)).toBe('1 tool call');
  });

  it('truncates a long ask to one line', () => {
    const long = 'x'.repeat(200);
    const [turn] = turnsFor([ev(1, 'user-message', { turnId: 't1', text: long })]);
    expect(turnTitle(turn!, 20)).toHaveLength(20);
    expect(turnTitle(turn!, 20).endsWith('…')).toBe(true);
  });
});

describe('buildTurns — the per-token cost of a long agentic session', () => {
  /**
   * `useVerseSession` rebuilds `state.events` on every event and
   * `buildTranscript` allocates fresh item objects from it, so Transcript's
   * memos miss on EVERY streamed token. Without a cache that meant re-deriving
   * the semantics of every tool call in the session per frame — including a
   * full LCS diff per Edit payload.
   */
  const editEvents = [
    ev(1, 'user-message', { turnId: 't1', text: 'refactor' }),
    ev(2, 'tool-use', {
      turnId: 't1',
      toolUseId: 'edit-1',
      name: 'Edit',
      input: { file_path: '/src/a.ts', old_string: 'alpha\nbeta', new_string: 'alpha\ngamma' },
    }),
    ev(3, 'tool-result', { turnId: 't1', toolUseId: 'edit-1', output: 'ok', isError: false }),
  ] as const;

  it('reuses the SAME ToolFacts instance across rebuilds', () => {
    const cache = createTurnCache();
    const items = groupTranscriptItems(buildTranscript([...editEvents]).items);

    const first = buildTurns(items, cache).facts.get('edit-1');
    expect(first?.diff).not.toBeNull();

    // A fresh rebuild from the same log — exactly what a `text-delta` causes.
    const rebuilt = groupTranscriptItems(buildTranscript([...editEvents]).items);
    const second = buildTurns(rebuilt, cache).facts.get('edit-1');

    expect(second).toBe(first);
  });

  it('recomputes a call whose result has since landed', () => {
    const cache = createTurnCache();
    const pendingOnly = [...editEvents.slice(0, 2)];
    const whilePending = buildTurns(
      groupTranscriptItems(buildTranscript(pendingOnly).items),
      cache,
    ).facts.get('edit-1');
    expect(whilePending?.pending).toBe(true);

    const resolved = buildTurns(
      groupTranscriptItems(buildTranscript([...editEvents]).items),
      cache,
    ).facts.get('edit-1');
    expect(resolved).not.toBe(whilePending);
    expect(resolved?.pending).toBe(false);
  });

  it('caches nothing when no cache is supplied, so callers stay pure', () => {
    const items = groupTranscriptItems(buildTranscript([...editEvents]).items);
    const a = buildTurns(items).facts.get('edit-1');
    const b = buildTurns(items).facts.get('edit-1');
    expect(a).not.toBe(b);
    expect(a).toEqual(b);
  });
});

describe('turn file ordering', () => {
  /**
   * An agentic turn reads widely before editing narrowly. In first-touch order
   * the edits sat behind FileActivity's "Show N more files" collapse — hiding
   * exactly the rows whose line deltas justify the summary.
   */
  it('puts the files it CHANGED before the ones it only read', () => {
    const events: Parameters<typeof buildTranscript>[0] = [
      ev(1, 'user-message', { turnId: 't1', text: 'ask' }),
    ];
    let seq = 2;
    for (let i = 0; i < 20; i++) {
      events.push(ev(seq++, 'tool-use', {
        turnId: 't1', toolUseId: `r${i}`, name: 'Read', input: { file_path: `/src/read-${i}.ts` },
      }));
      events.push(ev(seq++, 'tool-result', { turnId: 't1', toolUseId: `r${i}`, output: 'x', isError: false }));
    }
    for (let i = 0; i < 3; i++) {
      events.push(ev(seq++, 'tool-use', {
        turnId: 't1',
        toolUseId: `e${i}`,
        name: 'Edit',
        input: { file_path: `/src/edit-${i}.ts`, old_string: 'a', new_string: 'b' },
      }));
      events.push(ev(seq++, 'tool-result', { turnId: 't1', toolUseId: `e${i}`, output: 'ok', isError: false }));
    }

    const [turn] = turnsFor(events);
    const files = turn!.files;
    expect(files).toHaveLength(23);
    // All three edits are inside FileActivity's 8-row collapse window.
    expect(files.slice(0, 3).every((f) => f.action === 'edit')).toBe(true);
    expect(files.slice(3).every((f) => f.action === 'read')).toBe(true);
  });
});
