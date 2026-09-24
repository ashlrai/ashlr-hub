import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { VerseEvent } from '../../data/api-types.js';
import { ev, session } from './fixtures.test-support.js';
import { appendInlineText, splitStreamingBlocks } from './MessageMarkdown.js';
import { describeCompaction, Transcript } from './Transcript.js';
import { useVerseLive, useVerseTranscript } from './useVerseSession.js';
import { cpuMs, median, openLastTurn, realisticLog, stamp } from './verse-perf.test-support.js';
import { applyVerseEvent, applyVerseEvents, buildTranscript, resetVerseStore, seedVerseSession, type VerseLiveState } from './verse-store.js';

const NO_LIVE: VerseLiveState = { turnId: null, startedAt: null, progress: null, thinking: null, notice: null, settledTurnId: null };

/** The transcript wired to the store the way Workspace wires it (useVerseTranscript + useVerseLive). */
function LiveHarness({ sessionId, onStop }: { sessionId: string; onStop?: () => void }) {
  const transcript = useVerseTranscript(sessionId);
  const live = useVerseLive(sessionId);
  return <Transcript transcript={transcript} live={live} loaded loadError={null} onStop={onStop} />;
}

function transient(seq: number, e: Record<string, unknown>): VerseEvent {
  return { seq, at: stamp(seq), ...e } as VerseEvent;
}

describe('Transcript', () => {
  it('renders exactly one quiet note after Stop, not a red failure line', () => {
    const transcript = buildTranscript([
      ev(1, 'user-message', { turnId: 't1', text: 'do the thing' }),
      ev(2, 'turn-started', { turnId: 't1', pid: 1 }),
      ev(3, 'text-delta', { turnId: 't1', text: 'Starting' }),
      ev(4, 'cancelled', { turnId: 't1' }),
      ev(5, 'turn-done', { turnId: 't1', ok: false, nativeSessionId: null, durationMs: 2300 }),
    ]);
    render(<Transcript transcript={transcript} loaded loadError={null} />);
    const log = screen.getByRole('log');
    expect(within(log).getByText('Stopped.')).toBeInTheDocument();
    expect(within(log).queryByText(/Turn ended without a result/)).not.toBeInTheDocument();
    expect(log.querySelectorAll('[data-kind="cancelled"], [data-kind="turn-done"] [role="alert"]')).toHaveLength(1);
    // The duration meta still shows.
    expect(within(log).getByText('2.3s')).toBeInTheDocument();
  });

  it('keeps the failure line when a turn ends without any explanation', () => {
    const transcript = buildTranscript([
      ev(1, 'user-message', { turnId: 't1', text: 'hi' }),
      ev(2, 'turn-done', { turnId: 't1', ok: false, nativeSessionId: null, durationMs: 10 }),
    ]);
    render(<Transcript transcript={transcript} loaded loadError={null} />);
    expect(screen.getByText(/Turn ended without a result/)).toBeInTheDocument();
  });

  it('folds a burst of tool calls into one disclosure that expands to the individual cards', () => {
    const transcript = buildTranscript([
      ev(1, 'user-message', { turnId: 't1', text: 'refactor' }),
      ev(2, 'tool-use', { turnId: 't1', toolUseId: 'a', name: 'Read', input: { file_path: '/a.ts' } }),
      ev(3, 'tool-result', { turnId: 't1', toolUseId: 'a', output: 'ok', isError: false }),
      ev(4, 'tool-use', { turnId: 't1', toolUseId: 'b', name: 'Read', input: { file_path: '/b.ts' } }),
      ev(5, 'tool-result', { turnId: 't1', toolUseId: 'b', output: 'ok', isError: false }),
      ev(6, 'tool-use', { turnId: 't1', toolUseId: 'c', name: 'Edit', input: { file_path: '/b.ts' } }),
      ev(7, 'tool-result', { turnId: 't1', toolUseId: 'c', output: 'boom', isError: true }),
      ev(8, 'assistant-message', { turnId: 't1', text: 'Done.' }),
    ]);
    render(<Transcript transcript={transcript} loaded loadError={null} />);
    const log = screen.getByRole('log');
    expect(log.querySelectorAll('[data-kind="tool"]')).toHaveLength(0);
    const group = log.querySelector('[data-kind="tool-group"] details') as HTMLDetailsElement;
    expect(group.open).toBe(false);
    const summary = group.querySelector('summary')!;
    // DESIGN §5 wording: `3 tools · Read ×2, Edit · 1 failed` — the count is a
    // noun, not a sentence, so the row stays one dense line.
    expect(summary).toHaveTextContent('3 tools');
    expect(summary).toHaveTextContent('Read ×2, Edit');
    expect(summary).toHaveTextContent('1 failed');
    // Every card is still there inside the group.
    expect(group.querySelectorAll('details details')).toHaveLength(3);
    expect(within(group).getByText('/a.ts')).toBeInTheDocument();
  });
});

describe('Transcript — agentic reading', () => {
  const EDIT_TURN = [
    ev(1, 'user-message', { turnId: 't1', text: 'rename the flag' }),
    ev(2, 'tool-use', { turnId: 't1', toolUseId: 'r1', name: 'Read', input: { file_path: 'src/flags.ts' } }),
    ev(3, 'tool-result', { turnId: 't1', toolUseId: 'r1', output: 'const oldFlag = true;', isError: false }),
    ev(4, 'tool-use', {
      turnId: 't1', toolUseId: 'e1', name: 'Edit',
      input: { file_path: 'src/flags.ts', old_string: 'const oldFlag = true;', new_string: 'const newFlag = true;' },
    }),
    ev(5, 'tool-result', { turnId: 't1', toolUseId: 'e1', output: 'ok', isError: false }),
    ev(6, 'assistant-message', { turnId: 't1', text: 'Renamed it.' }),
    ev(7, 'turn-done', { turnId: 't1', ok: true, nativeSessionId: null, durationMs: 4200 }),
  ];

  it('summarizes what the turn touched and jumps to the call that changed it', async () => {
    const user = userEvent.setup();
    render(<Transcript transcript={buildTranscript(EDIT_TURN)} loaded loadError={null} />);

    const activity = screen.getByRole('region', { name: 'Files this turn touched' });
    // Read AND edited, so the row says "edited" — the stronger action wins.
    const row = within(activity).getByRole('button', { name: /edited src\/flags\.ts/ });
    expect(row).toHaveTextContent('+1');
    expect(row).toHaveTextContent('−1');

    // The edit card is inside a collapsed tool-run disclosure; the jump opens
    // the whole chain rather than scrolling to something invisible.
    const card = document.getElementById('verse-tool-e1') as HTMLDetailsElement;
    expect(card.open).toBe(false);
    await user.click(row);
    expect(card.open).toBe(true);
    expect((card.closest('details[data-state-key^="toolgroup:"]') as HTMLDetailsElement).open).toBe(true);
  });

  it('renders an edit as a diff rather than as raw JSON', async () => {
    const user = userEvent.setup();
    render(<Transcript transcript={buildTranscript(EDIT_TURN)} loaded loadError={null} />);
    await user.click(screen.getByRole('region', { name: 'Files this turn touched' })
      .querySelector('button')!);
    const card = document.getElementById('verse-tool-e1')!;
    // Once in the collapsed summary line, once as the diff's own header.
    expect(within(card as HTMLElement).getAllByText('src/flags.ts')).toHaveLength(2);
    expect([...card.querySelectorAll('tr')].some((r) => r.className.includes('diffRow_add'))).toBe(true);
    // The old dump-the-payload rendering is gone for edits.
    expect(within(card as HTMLElement).queryByText('Input')).not.toBeInTheDocument();
  });

  it('renders a shell run with its command, exit status and ANSI stripped', () => {
    const transcript = buildTranscript([
      ev(1, 'user-message', { turnId: 't1', text: 'build it' }),
      ev(2, 'tool-use', { turnId: 't1', toolUseId: 'b1', name: 'Bash', input: { command: 'npm run build' } }),
      ev(3, 'tool-result', {
        turnId: 't1', toolUseId: 'b1',
        output: '\u001B[31merror TS2345\u001B[0m\nExit code: 2', isError: true,
      }),
    ]);
    render(<Transcript transcript={transcript} loaded loadError={null} />);
    const card = document.getElementById('verse-tool-b1')!;
    // Once in the collapsed summary line, once as the `$` command line.
    expect(within(card as HTMLElement).getAllByText('npm run build')).toHaveLength(2);
    expect(within(card as HTMLElement).getByText('exit 2')).toBeInTheDocument();
    const pre = card.querySelector('pre')!;
    expect(pre.textContent).toContain('error TS2345');
    expect(pre.textContent).not.toContain('\u001B');
  });

  it('offers a jump to the first failure in a turn and across the session', async () => {
    const user = userEvent.setup();
    const transcript = buildTranscript([
      ev(1, 'user-message', { turnId: 't1', text: 'one' }),
      ev(2, 'tool-use', { turnId: 't1', toolUseId: 'f1', name: 'Bash', input: { command: 'false' } }),
      ev(3, 'tool-result', { turnId: 't1', toolUseId: 'f1', output: '', isError: true }),
      ev(4, 'user-message', { turnId: 't2', text: 'two' }),
      ev(5, 'assistant-message', { turnId: 't2', text: 'fine' }),
      ev(6, 'user-message', { turnId: 't3', text: 'three' }),
      ev(7, 'assistant-message', { turnId: 't3', text: 'also fine' }),
    ]);
    render(<Transcript transcript={transcript} loaded loadError={null} />);

    expect(screen.getByRole('button', { name: /1 failure in this turn/ })).toBeInTheDocument();
    const jump = screen.getByRole('button', { name: /1 error/ });
    const card = document.getElementById('verse-tool-f1') as HTMLDetailsElement;
    expect(card.open).toBe(false);
    await user.click(jump);
    expect(card.open).toBe(true);
  });

  it('gives a long session an outline and a search over prose and tool payloads', async () => {
    const user = userEvent.setup();
    const events = [
      ev(1, 'user-message', { turnId: 't1', text: 'fix the login bug' }),
      ev(2, 'tool-use', { turnId: 't1', toolUseId: 'g1', name: 'Grep', input: { pattern: 'session cookie' } }),
      ev(3, 'tool-result', { turnId: 't1', toolUseId: 'g1', output: 'src/auth.ts:12', isError: false }),
      ev(4, 'user-message', { turnId: 't2', text: 'write the test' }),
      ev(5, 'assistant-message', { turnId: 't2', text: 'Done.' }),
      ev(6, 'user-message', { turnId: 't3', text: 'ship it' }),
      ev(7, 'assistant-message', { turnId: 't3', text: 'Pushed.' }),
    ];
    render(<Transcript transcript={buildTranscript(events)} loaded loadError={null} />);

    const outlineToggle = screen.getByRole('button', { name: /3\s*turns/ });
    await user.click(outlineToggle);
    const outline = screen.getByRole('group', { name: 'Turns in this chat' });
    expect(within(outline).getByText('fix the login bug')).toBeInTheDocument();
    expect(within(outline).getByText('ship it')).toBeInTheDocument();
    await user.keyboard('{Escape}');

    // Search reaches a tool ARGUMENT, not just the prose.
    const search = screen.getByRole('searchbox', { name: 'Search this chat' });
    await user.type(search, 'session cookie');
    expect(screen.getByText('1 of 1')).toBeInTheDocument();
    await user.click(outlineToggle);
    const filtered = screen.getByRole('group', { name: 'Turns in this chat' });
    expect(within(filtered).getByText('fix the login bug')).toBeInTheDocument();
    expect(within(filtered).queryByText('ship it')).not.toBeInTheDocument();
  });

  it('keeps the nav strip out of the way of a short chat', () => {
    const transcript = buildTranscript([
      ev(1, 'user-message', { turnId: 't1', text: 'hi' }),
      ev(2, 'assistant-message', { turnId: 't1', text: 'hello' }),
    ]);
    render(<Transcript transcript={transcript} loaded loadError={null} />);
    expect(screen.queryByRole('searchbox', { name: 'Search this chat' })).not.toBeInTheDocument();
  });

  it('steps between turns with Alt+arrows', async () => {
    const user = userEvent.setup();
    const transcript = buildTranscript([
      ev(1, 'user-message', { turnId: 't1', text: 'one' }),
      ev(2, 'assistant-message', { turnId: 't1', text: 'a' }),
      ev(3, 'user-message', { turnId: 't2', text: 'two' }),
      ev(4, 'assistant-message', { turnId: 't2', text: 'b' }),
    ]);
    render(<Transcript transcript={transcript} loaded loadError={null} />);
    const turns = [...document.querySelectorAll('[data-turn-key]')] as HTMLElement[];
    expect(turns).toHaveLength(2);

    await user.keyboard('{Alt>}{ArrowDown}{/Alt}');
    expect(turns[0]).toHaveFocus();
    await user.keyboard('{Alt>}{ArrowDown}{/Alt}');
    expect(turns[1]).toHaveFocus();
    // Plain arrows work once a turn itself has focus.
    await user.keyboard('{ArrowUp}');
    expect(turns[0]).toHaveFocus();
  });
});

describe('Transcript — V3.9 compaction and handoff', () => {
  it('draws a compaction as a divider with the CLI\'s own numbers', () => {
    const transcript = buildTranscript([
      ev(1, 'user-message', { turnId: 't1', text: 'keep going' }),
      ev(2, 'compaction', { turnId: 't1', trigger: 'auto', preTokens: 812_000, postTokens: 41_000, durationMs: 118_000 }),
      ev(3, 'assistant-message', { turnId: 't1', text: 'Continuing.' }),
    ]);
    render(<Transcript transcript={transcript} loaded loadError={null} engine="claude" />);
    const divider = screen.getByRole('log').querySelector('[data-kind="compaction"]') as HTMLElement;
    expect(divider).not.toBeNull();
    expect(divider).toHaveTextContent('Auto-compacted 812k → 41k in 1m 58s');
    expect(divider).toHaveTextContent('Earlier turns now reach the agent only as a summary');
  });

  it('says only what the CLI recorded when it gives no counts (codex rollouts)', () => {
    expect(describeCompaction({ trigger: 'auto', preTokens: null, postTokens: null, durationMs: null }, 'codex')).toBe('Codex compacted its context');
    expect(describeCompaction({ trigger: 'auto', preTokens: null, postTokens: null, durationMs: null })).toBe('The CLI compacted its context');
    expect(describeCompaction({ trigger: 'manual', preTokens: 300_000, postTokens: null, durationMs: 4_000 }, 'grok')).toBe('Compacted on request at 300k in 4.0s');
    expect(describeCompaction({ trigger: 'auto', preTokens: 967_391, postTokens: 19_001, durationMs: null }, 'claude')).toBe('Auto-compacted 967k → 19k');
  });

  it('does not let a compaction between Stop and turn-done turn the stop into a failure', () => {
    const transcript = buildTranscript([
      ev(1, 'user-message', { turnId: 't1', text: 'go' }),
      ev(2, 'cancelled', { turnId: 't1' }),
      ev(3, 'compaction', { turnId: 't1', trigger: 'auto', preTokens: null, postTokens: null, durationMs: null }),
      ev(4, 'turn-done', { turnId: 't1', ok: false, nativeSessionId: null, durationMs: 100 }),
    ]);
    render(<Transcript transcript={transcript} loaded loadError={null} engine="codex" />);
    expect(screen.queryByText(/Turn ended without a result/)).not.toBeInTheDocument();
    expect(screen.getByText('Codex compacted its context')).toBeInTheDocument();
  });

  it('opens a handoff chat with "Continued from <source>", linking back', async () => {
    const user = userEvent.setup();
    const onOpenSession = vi.fn();
    render(<Transcript transcript={buildTranscript([])} loaded loadError={null}
      handoffFrom={{ sessionId: 'vs_src', title: 'Migrate the billing tables' }} onOpenSession={onOpenSession} />);
    const log = screen.getByRole('log');
    expect(within(log).getByText('Continued from')).toBeInTheDocument();
    // An empty handoff chat explains the pre-filled draft and that nothing was spent.
    expect(within(log).getByText('Review the handoff, then send it.')).toBeInTheDocument();
    expect(log).toHaveTextContent('nothing is sent until you press Send');
    await user.click(within(log).getByRole('button', { name: 'Migrate the billing tables' }));
    expect(onOpenSession).toHaveBeenCalledWith('vs_src');
  });

  it('names the source without a link when there is nowhere to open it', () => {
    render(<Transcript transcript={buildTranscript([ev(1, 'user-message', { turnId: 't1', text: 'hi' })])} loaded loadError={null}
      handoffFrom={{ sessionId: 'vs_src', title: 'Old chat' }} />);
    expect(screen.getByText('Old chat')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Old chat' })).toBeNull();
    expect(screen.queryByText('Review the handoff, then send it.')).toBeNull();
  });
});

describe('Transcript — V3.10 live turn', () => {
  beforeEach(() => resetVerseStore());

  function startTurn() {
    seedVerseSession('vs_1', session({ status: 'running' }), [
      ev(1, 'user-message', { turnId: 't1', text: 'run the tests' }),
      { ...ev(2, 'turn-started', { turnId: 't1', pid: 1 }), at: new Date(Date.now() - 14_000).toISOString() },
    ]);
  }

  it('replaces the bare caret with a live line — phase, elapsed, and the command a pending tool runs — and a Stop', async () => {
    const user = userEvent.setup();
    const onStop = vi.fn();
    startTurn();
    render(<LiveHarness sessionId="vs_1" onStop={onStop} />);
    const line = screen.getByRole('listitem', { name: 'The agent is working' });
    expect(line).toHaveTextContent(/Waiting·1[45]s/);

    act(() => { applyVerseEvent('vs_1', ev(3, 'tool-use', { turnId: 't1', toolUseId: 'b', name: 'Bash', input: { command: 'npm test' } })); });
    expect(line).toHaveTextContent('Running');
    expect(line).toHaveTextContent('npm test');
    expect(within(line).getByRole('status')).toHaveTextContent('Running: npm test');

    await user.click(within(line).getByRole('button', { name: 'Stop this turn' }));
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it('shows the server\'s progress figures and a retry notice, and drops the line when the turn ends', () => {
    startTurn();
    render(<LiveHarness sessionId="vs_1" />);
    act(() => {
      applyVerseEvents('vs_1', [
        ev(3, 'text-delta', { turnId: 't1', text: 'Tests ' }),
        transient(3, { type: 'progress', turnId: 't1', phase: 'writing', elapsedMs: 63_000, tokPerSec: 38.4 }),
        transient(3, { type: 'status', turnId: 't1', kind: 'retry', message: 'The API is overloaded — retrying (2 of 10).' }),
      ]);
    });
    const line = screen.getByRole('listitem', { name: 'The agent is working' });
    expect(line).toHaveTextContent('Writing');
    expect(line).toHaveTextContent('1m 3s');
    expect(line).toHaveTextContent('38 tok/s');
    expect(line).toHaveTextContent('RetryingThe API is overloaded — retrying (2 of 10).');

    act(() => { applyVerseEvent('vs_1', ev(4, 'turn-done', { turnId: 't1', ok: true, nativeSessionId: null, durationMs: 64_000 })); });
    expect(screen.queryByRole('listitem', { name: 'The agent is working' })).not.toBeInTheDocument();
  });

  it('streams reasoning in an open block that becomes the persisted "Thought …" block', () => {
    startTurn();
    render(<LiveHarness sessionId="vs_1" />);
    act(() => {
      applyVerseEvents('vs_1', [
        transient(2, { type: 'thinking-delta', turnId: 't1', text: 'The pager looks ' }),
        transient(2, { type: 'thinking-delta', turnId: 't1', text: 'off by one.' }),
        transient(2, { type: 'thinking-progress', turnId: 't1', estimatedTokens: 1840 }),
      ]);
    });
    const live = document.querySelector('[data-kind="thinking-live"] details') as HTMLDetailsElement;
    expect(live.open).toBe(true);
    expect(live).toHaveTextContent('The pager looks off by one.');
    expect(live.querySelector('summary')).toHaveTextContent(/^Thinking · (<1|\d+)s · ~1\.8k tok$/);
    expect(screen.getByRole('listitem', { name: 'The agent is working' })).toHaveTextContent('Thinking');

    act(() => { applyVerseEvent('vs_1', { ...ev(3, 'thinking', { turnId: 't1', text: 'The pager looks off by one.' }), durationMs: 12_000 } as VerseEvent); });
    expect(document.querySelector('[data-kind="thinking-live"]')).toBeNull();
    const done = document.querySelector('[data-kind="thinking"] details') as HTMLDetailsElement;
    expect(done.querySelector('summary')).toHaveTextContent('Thought 12s · ~1.8k tok');
    // Still open while its turn runs — it is what the operator was reading.
    expect(done.open).toBe(true);
  });

  it('says so when the provider withheld the reasoning text', () => {
    render(<Transcript loaded loadError={null} live={NO_LIVE} transcript={buildTranscript([
      ev(1, 'user-message', { turnId: 't1', text: 'q' }),
      { ...ev(2, 'thinking', { turnId: 't1', text: '' }), redacted: true, durationMs: 9000 } as VerseEvent,
      ev(3, 'assistant-message', { turnId: 't1', text: 'a' }),
    ])} />);
    const block = document.querySelector('[data-kind="thinking"]')!;
    expect(block).toHaveTextContent('Thought 9s');
    expect(block).toHaveTextContent('reasoning hidden by the provider');
    expect(block.querySelector('details')).toBeNull();
  });

  it('shows recovery, a trimmed log, and what an error code means', () => {
    render(<Transcript loaded loadError={null} transcript={buildTranscript([
      ev(1, 'history-truncated', { turnId: null, droppedBefore: 900 }),
      ev(2, 'user-message', { turnId: 't1', text: 'continue' }),
      { ...ev(3, 'error', { turnId: 't1', message: 'No conversation found with session ID abc' }), code: 'native-thread-missing' } as VerseEvent,
      ev(4, 'recovered', { turnId: 't1', how: 'handoff', message: 'Started a new native session seeded with the handoff note.' }),
    ])} />);
    const log = screen.getByRole('log');
    expect(within(log).getByText('Older history trimmed')).toBeInTheDocument();
    const error = log.querySelector('[data-kind="error"]')!;
    expect(error).toHaveAttribute('data-code', 'native-thread-missing');
    expect(error).toHaveTextContent('No conversation found with session ID abc');
    expect(error).toHaveTextContent('Continue in a fresh chat');
    expect(log.querySelector('[data-kind="recovered"]')).toHaveTextContent('Recovered from the handoff note — Started a new native session seeded with the handoff note.');
  });
});

describe('MessageMarkdown — V3.10 streaming', () => {
  it('cuts streamed text at blank lines outside code fences', () => {
    expect(splitStreamingBlocks('# Title\n\nPara one\n\nTail')).toEqual({ done: ['# Title', 'Para one'], tail: 'Tail', tailInFence: false });
    expect(splitStreamingBlocks('Intro\n\n```ts\nconst a = 1;\n\nconst b')).toEqual({ done: ['Intro'], tail: '```ts\nconst a = 1;\n\nconst b', tailInFence: true });
    expect(splitStreamingBlocks('```\nx\n```\n\nafter')).toEqual({ done: ['```\nx\n```'], tail: 'after', tailInFence: false });
    // A closing fence still arriving does not close anything yet.
    expect(splitStreamingBlocks('```\nx\n``').tailInFence).toBe(true);
  });

  it('builds the tail from text nodes and inline marks only — never markup from the model', () => {
    const p = document.createElement('p');
    appendInlineText(p, 'Use `npm test` for **all** of it, *not* <img src=x onerror=alert(1)> snake_case_name');
    expect(p.querySelector('code')).toHaveTextContent('npm test');
    expect(p.querySelector('strong')).toHaveTextContent('all');
    expect(p.querySelector('em')).toHaveTextContent('not');
    expect(p.querySelector('img')).toBeNull();
    expect(p.textContent).toBe('Use npm test for all of it, not <img src=x onerror=alert(1)> snake_case_name');
  });

  it('renders completed blocks as Markdown and the unfinished tail as text, then the whole reply once', () => {
    const text = '# Plan\n\n1. read\n2. fix\n\nNow running **the** ```';
    const { rerender } = render(<Transcript loaded loadError={null} live={NO_LIVE} transcript={buildTranscript([
      ev(1, 'user-message', { turnId: 't1', text: 'go' }),
      ev(2, 'turn-started', { turnId: 't1', pid: 1 }),
      ev(3, 'text-delta', { turnId: 't1', text }),
    ])} />);
    const bubble = document.querySelector('[data-kind="assistant"][data-streaming]')!;
    expect(bubble.querySelector('h1')).toHaveTextContent('Plan');
    expect(bubble.querySelectorAll('ol li')).toHaveLength(2);
    const tail = bubble.querySelector('[data-stream-tail]')!;
    expect(tail.tagName).toBe('P');
    expect(tail.querySelector('strong')).toHaveTextContent('the');

    rerender(<Transcript loaded loadError={null} live={NO_LIVE} transcript={buildTranscript([
      ev(1, 'user-message', { turnId: 't1', text: 'go' }),
      ev(2, 'turn-started', { turnId: 't1', pid: 1 }),
      ev(3, 'text-delta', { turnId: 't1', text }),
      ev(4, 'assistant-message', { turnId: 't1', text: '# Plan\n\n1. read\n2. fix\n\nDone.' }),
      ev(5, 'turn-done', { turnId: 't1', ok: true, nativeSessionId: null, durationMs: 1 }),
    ])} />);
    const final = document.querySelector('[data-kind="assistant"]')!;
    expect(final).not.toHaveAttribute('data-streaming');
    expect(final.querySelector('[data-stream-tail]')).toBeNull();
    expect(final.querySelector('h1')).toHaveTextContent('Plan');
  });
});

describe('Transcript — §1 target: ≤ 4 ms per streamed delta at 5k events', () => {
  beforeEach(() => resetVerseStore());

  it('re-renders only the live turn while a reply streams', () => {
    // Open the last turn: drop its reply, usage and turn-done so it streams.
    const { events: open, turnId } = openLastTurn(realisticLog(5000));
    seedVerseSession('vs_perf', session({ id: 'vs_perf', status: 'running' }), open);
    const t0 = performance.now();
    render(<LiveHarness sessionId="vs_perf" onStop={() => {}} />);
    const mountMs = performance.now() - t0;

    let seq = open[open.length - 1]!.seq + 1;
    let n = 0;
    const round = () => {
      const wall: number[] = [];
      const cpu: number[] = [];
      for (let i = 0; i < 30; i++) {
        const start = performance.now();
        const word = `word${n++}`;
        cpu.push(cpuMs(() => act(() => {
          applyVerseEvents('vs_perf', [ev(seq++, 'text-delta', { turnId, text: `${word} ` })]);
        })));
        wall.push(performance.now() - start);
      }
      return { wall: median(wall), cpu: median(cpu) };
    };
    // One warm-up round pays for JIT; then the best of three steady-state
    // medians, because a timing taken while the rest of the suite competes
    // for the same cores measures the machine, not this code.
    round();
    const rounds = [round(), round(), round()];
    const perDelta = Math.min(...rounds.map((r) => r.wall));
    console.info('[verse-perf] transcript at 5k events', {
      mountMs: Number(mountMs.toFixed(0)),
      perDeltaWallMedianMs: rounds.map((r) => Number(r.wall.toFixed(2))),
      perDeltaCpuMedianMs: rounds.map((r) => Number(r.cpu.toFixed(2))),
    });
    expect(document.querySelector('[data-kind="assistant"][data-streaming] [data-stream-tail]')?.textContent).toContain(`word${n - 1}`);
    expect(perDelta).toBeLessThanOrEqual(4);
  }, 60_000);
});
