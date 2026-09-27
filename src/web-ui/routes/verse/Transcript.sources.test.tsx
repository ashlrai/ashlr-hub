/**
 * Transcript.sources.test.tsx — V3.15: every turn shows what it drew on
 * (numbered citations under the answer), what it did (one summary line),
 * and says so when the seat keeps its reasoning to itself; the Sources /
 * Reasoning sheet collects the whole chat; edits preview their change and
 * runs of reads fold.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ev } from './fixtures.test-support.js';
import { Transcript } from './Transcript.js';
import { miniDiffPreview } from './ToolUseCard.js';
import { buildTranscript } from './verse-transcript.js';
import { parseVerseEventFrame } from './verse-events.js';

const openSourceFile = vi.fn<(sessionId: string, path: string, line?: number) => Promise<void>>();
vi.mock('./reasoning/sources-queries.js', () => ({
  openSourceFile: (sessionId: string, path: string, line?: number) => openSourceFile(sessionId, path, line),
}));

const READ_OUT = Array.from({ length: 30 }, (_, i) => `${String(i + 10).padStart(6)}→x`).join('\n');

function researchTurn(turnId: string, base: number) {
  return [
    ev(base, 'user-message', { turnId, text: `question ${turnId}` }),
    ev(base + 1, 'thinking', { turnId, text: 'Check the parser, then the docs.', durationMs: 4000, kind: 'summary' }),
    ev(base + 2, 'tool-use', { turnId, toolUseId: `${turnId}-r`, name: 'Read', input: { file_path: '/repo/src/parser.ts', offset: 10, limit: 30 } }),
    ev(base + 3, 'tool-result', { turnId, toolUseId: `${turnId}-r`, output: READ_OUT, isError: false }),
    ev(base + 4, 'tool-use', { turnId, toolUseId: `${turnId}-w`, name: 'WebFetch', input: { url: 'https://vitest.dev/config/' } }),
    ev(base + 5, 'tool-result', { turnId, toolUseId: `${turnId}-w`, output: '# Configuring Vitest\n…', isError: false }),
    ev(base + 6, 'assistant-message', { turnId, text: 'The parser caps workers.' }),
    ev(base + 7, 'turn-done', { turnId, ok: true, nativeSessionId: null, durationMs: 12_000 }),
  ];
}

beforeEach(() => {
  openSourceFile.mockReset();
});

describe('Transcript — sources under the answer', () => {
  it('numbers each turn’s sources from 1, with the line range the read proved', () => {
    const transcript = buildTranscript([...researchTurn('t1', 1), ...researchTurn('t2', 20)]);
    render(<Transcript transcript={transcript} loaded loadError={null} sessionId="s1" />);
    const lists = screen.getAllByRole('region', { name: 'Sources for this answer' });
    expect(lists).toHaveLength(2);
    for (const list of lists) {
      const first = within(list).getByRole('button', { name: 'Source 1: /repo/src/parser.ts, lines 10-39' });
      expect(first).toHaveTextContent('parser.ts:10-39');
      const link = within(list).getByRole('link', { name: /Source 2: Configuring Vitest, vitest\.dev/ });
      expect(link).toHaveAttribute('href', 'https://vitest.dev/config');
      expect(link).toHaveAttribute('target', '_blank');
      expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    }
  });

  it('opens a cited file in the editor at its first line, scoped to the chat', async () => {
    const user = userEvent.setup();
    openSourceFile.mockResolvedValue(undefined);
    render(<Transcript transcript={buildTranscript(researchTurn('t1', 1))} loaded loadError={null} sessionId="s1" />);
    await user.click(screen.getByRole('button', { name: /^Source 1:/ }));
    expect(openSourceFile).toHaveBeenCalledWith('s1', '/repo/src/parser.ts', 10);
  });

  it('falls back to the call that read the file when the editor cannot open it', async () => {
    const user = userEvent.setup();
    openSourceFile.mockRejectedValue(new Error('locked'));
    render(<Transcript transcript={buildTranscript(researchTurn('t1', 1))} loaded loadError={null} sessionId="s1" />);
    await user.click(screen.getByRole('button', { name: /^Source 1:/ }));
    expect(await screen.findByText(/showing the call that read it/)).toHaveAttribute('role', 'status');
  });

  it('ends a settled turn with the one line of what it did', () => {
    const transcript = buildTranscript([
      ev(1, 'user-message', { turnId: 't1', text: 'fix it' }),
      ev(2, 'tool-use', { turnId: 't1', toolUseId: 'e', name: 'Edit', input: { file_path: '/a.ts', old_string: 'a\nb', new_string: 'c' } }),
      ev(3, 'tool-result', { turnId: 't1', toolUseId: 'e', output: 'ok', isError: false }),
      ev(4, 'tool-use', { turnId: 't1', toolUseId: 'b', name: 'Bash', input: { command: 'npm test' } }),
      ev(5, 'tool-result', { turnId: 't1', toolUseId: 'b', output: 'fail', isError: true }),
      ev(6, 'turn-done', { turnId: 't1', ok: true, nativeSessionId: null, durationMs: 3000 }),
    ]);
    const { container } = render(<Transcript transcript={transcript} loaded loadError={null} />);
    expect(container.querySelector('[data-kind="turn-work"]')).toHaveTextContent('Edited 1 file (+1 −2) · ran 1 command (1 failed)');
  });

  it('says so when a seat that withholds reasoning shared none — and only then', () => {
    const plain = [
      ev(1, 'user-message', { turnId: 't1', text: 'hi' }),
      ev(2, 'assistant-message', { turnId: 't1', text: 'hello' }),
      ev(3, 'turn-done', { turnId: 't1', ok: true, nativeSessionId: null, durationMs: 900 }),
    ];
    const { container, rerender } = render(<Transcript transcript={buildTranscript(plain)} loaded loadError={null} engine="grok" />);
    expect(container.querySelector('[data-kind="reasoning-not-shared"]')).toHaveTextContent('Reasoning not shared by this model');
    rerender(<Transcript transcript={buildTranscript(plain)} loaded loadError={null} engine="claude" />);
    expect(container.querySelector('[data-kind="reasoning-not-shared"]')).toBeNull();
  });
});

describe('Transcript — the Sources / Reasoning sheet', () => {
  it('collects the chat’s sources across turns and its reasoning turn by turn', async () => {
    const user = userEvent.setup();
    const transcript = buildTranscript([...researchTurn('t1', 1), ...researchTurn('t2', 20)]);
    render(<Transcript transcript={transcript} loaded loadError={null} sessionId="s1" engine="claude" />);
    await user.click(screen.getByRole('button', { name: /^Sources/ }));
    const sheet = await screen.findByRole('complementary', { name: 'Reasoning and sources for this chat' });
    // Two turns read the same file and page: two chat-level sources, each citing both turns.
    const rows = sheet.querySelectorAll('li[data-kind]');
    expect(rows).toHaveLength(2);
    expect(within(sheet).getAllByRole('button', { name: /^Go to turn [12]$/ })).toHaveLength(4);

    await user.click(within(sheet).getByRole('tab', { name: 'Reasoning' }));
    expect(within(sheet).getByText(/2 thoughts · 8s/)).toBeInTheDocument();
    expect(within(sheet).getAllByText('Read 1 file · 1 web lookup')).toHaveLength(2);

    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('complementary', { name: 'Reasoning and sources for this chat' })).toBeNull());
  });
});

describe('Transcript — the actions timeline', () => {
  it('previews a collapsed edit’s change and folds a run of clean reads', async () => {
    const user = userEvent.setup();
    const transcript = buildTranscript([
      ev(1, 'user-message', { turnId: 't1', text: 'go' }),
      ev(2, 'tool-use', { turnId: 't1', toolUseId: 'r1', name: 'Read', input: { file_path: '/a.ts' } }),
      ev(3, 'tool-result', { turnId: 't1', toolUseId: 'r1', output: 'x', isError: false }),
      ev(4, 'tool-use', { turnId: 't1', toolUseId: 'r2', name: 'Read', input: { file_path: '/b.ts' } }),
      ev(5, 'tool-result', { turnId: 't1', toolUseId: 'r2', output: 'x', isError: false }),
      ev(6, 'tool-use', { turnId: 't1', toolUseId: 'r3', name: 'Read', input: { file_path: '/c.ts' } }),
      ev(7, 'tool-result', { turnId: 't1', toolUseId: 'r3', output: 'x', isError: false }),
      ev(8, 'tool-use', { turnId: 't1', toolUseId: 'e1', name: 'Edit', input: { file_path: '/c.ts', old_string: 'old line', new_string: 'new line' } }),
      ev(9, 'tool-result', { turnId: 't1', toolUseId: 'e1', output: 'ok', isError: false }),
      ev(10, 'turn-done', { turnId: 't1', ok: true, nativeSessionId: null, durationMs: 100 }),
    ]);
    const { container } = render(<Transcript transcript={transcript} loaded loadError={null} />);
    await user.click(screen.getByRole('button', { name: /^Read 3 files, edited 1 file/ }));
    const reads = container.querySelector('[data-member="reads"]') as HTMLElement;
    expect(reads).toHaveTextContent('Read 3 files');
    expect(reads).toHaveTextContent('a.ts, b.ts, c.ts');
    const mini = container.querySelector('[data-kind="mini-diff"]') as HTMLElement;
    expect(mini).toHaveTextContent('old line');
    expect(mini).toHaveTextContent('new line');
  });

  it('miniDiffPreview keeps changed lines only and counts the rest exactly', () => {
    const diff = ['--- a/x', '+++ b/x', '@@ -1,3 +1,3 @@', ' ctx', '-a', '+b', '-c', '+d', '+e'].join('\n');
    expect(miniDiffPreview(diff)).toEqual({ lines: [{ sign: '-', text: 'a' }, { sign: '+', text: 'b' }, { sign: '-', text: 'c' }], more: 2 });
  });
});

describe('source events on the wire', () => {
  it('parses a well-formed frame and drops a malformed one', () => {
    const ok = { seq: 3, at: 'x', type: 'source', turnId: 't', source: { kind: 'url', ref: 'https://a.dev', title: 'A', origin: 'agent' } };
    expect(parseVerseEventFrame(JSON.stringify(ok))).toMatchObject({ type: 'source' });
    expect(parseVerseEventFrame(JSON.stringify({ ...ok, source: { kind: 'url' } }))).toBeNull();
  });

  it('a persisted source is cited under its turn without splitting the run of calls', () => {
    const transcript = buildTranscript([
      ev(1, 'user-message', { turnId: 't1', text: 'go' }),
      ev(2, 'tool-use', { turnId: 't1', toolUseId: 'a', name: 'Bash', input: { command: 'ls' } }),
      ev(3, 'tool-result', { turnId: 't1', toolUseId: 'a', output: 'x', isError: false }),
      ev(4, 'source', { turnId: 't1', source: { kind: 'url', ref: 'https://docs.devin.ai', title: 'Devin docs', origin: 'agent', url: 'https://docs.devin.ai', domain: 'docs.devin.ai' } }),
      ev(5, 'tool-use', { turnId: 't1', toolUseId: 'b', name: 'Bash', input: { command: 'pwd' } }),
      ev(6, 'tool-result', { turnId: 't1', toolUseId: 'b', output: 'x', isError: false }),
      ev(7, 'turn-done', { turnId: 't1', ok: true, nativeSessionId: null, durationMs: 100 }),
    ]);
    const { container } = render(<Transcript transcript={transcript} loaded loadError={null} />);
    expect(container.querySelectorAll('[data-kind="tool-group"]')).toHaveLength(1);
    expect(screen.getByRole('link', { name: /Source 1: Devin docs/ })).toHaveAttribute('href', 'https://docs.devin.ai');
  });
});
