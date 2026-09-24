/**
 * chat/ActivityGroup.test.tsx — the folded tool run from the keyboard:
 * summary, auto-expand to the failure, "Show N more", the operator's choice
 * winning, running rows with a timer, and a jump into a folded group.
 */
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { ToolGroupItem, ToolGroupMember } from '../verse-store.js';
import { ActivityGroupView, revealAnchorInGroups } from './ActivityGroup.js';
import { LiveTimer } from './LiveTimer.js';
import { toolAnchorId } from './tool-semantics.js';

let n = 0;
function tool(name: string, result: { output: string; isError: boolean } | null, at = '2026-09-24T10:00:00.000Z'): ToolGroupMember {
  n += 1;
  return { kind: 'tool', key: `k${n}`, turnId: 't1', at, toolUseId: `u${n}`, name, input: { command: `cmd ${n}` }, result, durationMs: null };
}
function group(items: ToolGroupMember[], over: Partial<ToolGroupItem> = {}): ToolGroupItem {
  return {
    kind: 'toolGroup', key: `g-${items[0]!.key}`, turnId: 't1', at: items[0]!.at, items, toolCount: items.length,
    summary: '', errorCount: items.filter((m) => m.kind === 'tool' && m.result?.isError).length,
    pending: items.some((m) => m.kind === 'tool' && m.result === null), spanMs: 134_000, ...over,
  };
}
const ok = { output: 'ok', isError: false };
const bad = { output: 'boom', isError: true };
const renderMember = (m: ToolGroupMember) => (m.kind === 'tool'
  ? <div id={toolAnchorId(m.toolUseId)} data-testid="member">{m.name} {m.result === null ? <>running <LiveTimer since={m.at} /></> : null}</div>
  : null);
const NO_FACTS = new Map();

describe('ActivityGroup', () => {
  it('folds a clean run to one line that states the work and the time', async () => {
    const user = userEvent.setup();
    render(<ActivityGroupView item={group([tool('Bash', ok), tool('Bash', ok), tool('Read', ok)])} facts={NO_FACTS} renderMember={renderMember} />);
    const line = screen.getByRole('button', { name: 'Ran 2 commands, read 1; 2m 14s' });
    expect(line).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryAllByTestId('member')).toHaveLength(0);
    // Keyboard: Enter opens everything (nothing to focus on), Space folds it again.
    line.focus();
    await user.keyboard('{Enter}');
    expect(line).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getAllByTestId('member')).toHaveLength(3);
    await user.keyboard(' ');
    expect(line).toHaveAttribute('aria-expanded', 'false');
  });

  it('opens on its failure, offers "Show N more", and lets the operator narrow it back', async () => {
    const user = userEvent.setup();
    const items = [tool('Bash', ok), tool('Bash', ok), tool('Bash', bad), tool('Read', ok), tool('Read', ok)];
    render(<ActivityGroupView item={group(items)} facts={NO_FACTS} renderMember={renderMember} />);
    const line = screen.getByRole('button', { name: /^Ran 3 commands, read 2; 1 failed/ });
    expect(line).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getAllByTestId('member')).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: 'Show 4 more' }));
    expect(screen.getAllByTestId('member')).toHaveLength(5);
    await user.click(screen.getByRole('button', { name: 'Show only failures' }));
    expect(screen.getAllByTestId('member')).toHaveLength(1);
  });

  it('shows running rows with a timer, and folds itself when the run finishes clean', () => {
    const started = new Date(Date.now() - 65_000).toISOString();
    const running = [tool('Bash', ok), tool('Bash', null, started)];
    const view = render(<ActivityGroupView item={group(running, { spanMs: null })} facts={NO_FACTS} renderMember={renderMember} />);
    const line = screen.getByRole('button', { name: /1 running/ });
    expect(line).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByTestId('member')).toHaveTextContent(/running 1m \d+s/);
    // The run finishes: no failures, so the operator is not left holding it open.
    view.rerender(<ActivityGroupView item={group([running[0]!, { ...running[1]!, result: ok } as ToolGroupMember])} facts={NO_FACTS} renderMember={renderMember} />);
    expect(screen.getByRole('button', { name: 'Ran 2 commands; 2m 14s' })).toHaveAttribute('aria-expanded', 'false');
  });

  it('keeps the operator\'s choice over the automatic view', async () => {
    const user = userEvent.setup();
    const items = [tool('Bash', bad), tool('Read', ok)];
    const view = render(<ActivityGroupView item={group(items)} facts={NO_FACTS} renderMember={renderMember} />);
    await user.click(screen.getByRole('button', { name: /1 failed/ }));
    expect(screen.queryAllByTestId('member')).toHaveLength(0);
    // A later render (another token in the live turn) does not reopen it.
    view.rerender(<ActivityGroupView item={group([...items])} facts={NO_FACTS} renderMember={renderMember} />);
    expect(screen.queryAllByTestId('member')).toHaveLength(0);
  });

  it('opens when a jump targets a call folded inside it', () => {
    const items = [tool('Read', ok), tool('Edit', ok)];
    render(<ActivityGroupView item={group(items)} facts={NO_FACTS} renderMember={renderMember} />);
    expect(document.getElementById(toolAnchorId(items[1]!.kind === 'tool' ? items[1]!.toolUseId : ''))).toBeNull();
    let claimed = false;
    act(() => { claimed = revealAnchorInGroups(toolAnchorId('u-none')); });
    expect(claimed).toBe(false);
    act(() => { claimed = revealAnchorInGroups(toolAnchorId((items[1] as Extract<ToolGroupMember, { kind: 'tool' }>).toolUseId)); });
    expect(claimed).toBe(true);
    expect(within(document.body).getAllByTestId('member')).toHaveLength(2);
  });
});
