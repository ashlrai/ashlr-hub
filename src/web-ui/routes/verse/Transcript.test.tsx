import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ev } from './fixtures.test-support.js';
import { Transcript } from './Transcript.js';
import { buildTranscript } from './verse-store.js';

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
