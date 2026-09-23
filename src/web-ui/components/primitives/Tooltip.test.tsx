/**
 * Tooltip — the failure modes of the native `title=` tooltip it replaces,
 * pinned so they cannot come back:
 *
 *   1. it was CLIPPED by whatever the trigger sat inside;
 *   2. it never appeared for a keyboard operator;
 *   3. it could not be dismissed;
 *   4. it was drawn, never announced;
 *   5. it appeared instantly, so sweeping a pointer across a rail strobed.
 *
 * The positioning MATHS is deliberately not asserted: jsdom has no layout, so
 * every getBoundingClientRect is a zero rect and every flip decision is
 * degenerate. What is asserted is the property that makes the maths reachable
 * at all — that the bubble renders OUTSIDE the clipping subtree, in
 * document.body, positioned against the viewport.
 */
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Tooltip } from './Tooltip.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('Tooltip', () => {
  it('escapes an overflow:hidden ancestor by rendering into document.body', async () => {
    const user = userEvent.setup();
    render(
      // The Verse rail in miniature: a clipping ancestor with its own stacking
      // context. The browser's own tooltip — and any absolutely-positioned
      // bubble living inside this box — is cut off at its edge.
      <div data-testid="clipper" style={{ overflow: 'hidden', position: 'relative', width: 56, height: 56, zIndex: 0 }}>
        <Tooltip label="Approvals" shortcut="⌘3" placement="right">
          <button type="button" aria-label="Approvals" />
        </Tooltip>
      </div>,
    );

    await user.hover(screen.getByRole('button', { name: 'Approvals' }));
    const tip = await screen.findByRole('tooltip');

    // THE POINT. Not merely "elsewhere in the tree" — specifically not inside
    // the clipping box, and directly under <body>, where no ancestor of the
    // trigger can clip, hide or out-stack it.
    expect(screen.getByTestId('clipper')).not.toContainElement(tip);
    expect(tip.parentElement).toBe(document.body);
    // The other half: placed from the trigger's VIEWPORT rect, so a scrolling
    // ancestor cannot drag it out of frame.
    expect(tip).toHaveStyle({ position: 'fixed' });
  });

  it('waits before opening on hover, so sweeping across a rail does not strobe', () => {
    vi.useFakeTimers();
    render(
      <Tooltip label="Usage" shortcut="⌘4">
        <button type="button" aria-label="Usage" />
      </Tooltip>,
    );
    // mouseOver, not mouseEnter: React synthesises onMouseEnter from the
    // bubbling mouseover, and a dispatched `mouseenter` never reaches it.
    fireEvent.mouseOver(screen.getByRole('button', { name: 'Usage' }));
    expect(screen.queryByRole('tooltip')).toBeNull();

    act(() => { vi.advanceTimersByTime(400); });
    expect(screen.getByRole('tooltip')).toBeInTheDocument();
  });

  it('opens on keyboard focus with no pointer involved, and closes on blur', async () => {
    const user = userEvent.setup();
    render(
      <>
        <Tooltip label="Usage" shortcut="⌘4">
          <button type="button" aria-label="Usage" />
        </Tooltip>
        <button type="button">Elsewhere</button>
      </>,
    );

    expect(screen.queryByRole('tooltip')).toBeNull();
    // Tab, not hover. A control that says its name only to a mouse is
    // unusable by keyboard — which is exactly what `title=` was.
    await user.tab();
    expect(screen.getByRole('button', { name: 'Usage' })).toHaveFocus();
    const tip = await screen.findByRole('tooltip');
    expect(tip).toHaveTextContent('Usage');
    // The shortcut is its own keycap, not glued onto the end of the sentence.
    expect(within(tip).getByText('⌘4').tagName).toBe('KBD');

    await user.tab();
    await waitFor(() => expect(screen.queryByRole('tooltip')).toBeNull());
  });

  it('closes on Escape while the trigger keeps focus (WCAG 1.4.13)', async () => {
    const user = userEvent.setup();
    render(
      <Tooltip label="Settings" shortcut="⌘5">
        <button type="button" aria-label="Settings" />
      </Tooltip>,
    );
    const trigger = screen.getByRole('button', { name: 'Settings' });

    trigger.focus();
    await screen.findByRole('tooltip');

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('tooltip')).toBeNull();
    // Dismissing the description must not also dismiss the control.
    expect(trigger).toHaveFocus();
  });

  it('describes the trigger without becoming its name, and unwires itself when closed', async () => {
    const user = userEvent.setup();
    render(
      <Tooltip label="Approvals" shortcut="⌘3">
        <button type="button" aria-label="Approvals, 3 pending" />
      </Tooltip>,
    );
    const trigger = screen.getByRole('button', { name: 'Approvals, 3 pending' });
    expect(trigger).not.toHaveAttribute('aria-describedby');

    trigger.focus();
    const tip = await screen.findByRole('tooltip');
    expect(trigger).toHaveAttribute('aria-describedby', tip.id);
    // It is a DESCRIPTION. The button's own aria-label still names it —
    // losing that is how an icon button ends up anonymous.
    expect(trigger).toHaveAccessibleName('Approvals, 3 pending');

    await user.keyboard('{Escape}');
    // A dangling aria-describedby pointing at a removed node is worse than
    // none: nothing is announced and the reference reads as broken.
    expect(trigger).not.toHaveAttribute('aria-describedby');
  });

  it('adds no layout box around the trigger', () => {
    const { container } = render(
      <Tooltip label="Chat" shortcut="⌘1">
        <button type="button" aria-label="Chat" />
      </Tooltip>,
    );
    // Exactly one element between the render root and the trigger, and it is
    // the `display: contents` wrapper — never a <div> that would break the
    // flex or grid row the trigger was placed into.
    const wrapper = screen.getByRole('button', { name: 'Chat' }).parentElement!;
    expect(wrapper.tagName).toBe('SPAN');
    expect(wrapper.parentElement).toBe(container);
  });

  it('keeps the trigger’s own handlers rather than replacing them', async () => {
    const user = userEvent.setup();
    const seen: string[] = [];
    render(
      <Tooltip label="Chat">
        <button
          type="button"
          aria-label="Chat"
          onMouseEnter={() => seen.push('enter')}
          onMouseLeave={() => seen.push('leave')}
          onFocus={() => seen.push('focus')}
          onBlur={() => seen.push('blur')}
        />
      </Tooltip>,
    );
    const trigger = screen.getByRole('button', { name: 'Chat' });

    await user.hover(trigger);
    await user.unhover(trigger);
    act(() => { trigger.focus(); });
    act(() => { trigger.blur(); });
    expect(seen).toEqual(['enter', 'leave', 'focus', 'blur']);
  });

  it('renders nothing when disabled — the escape hatch for a label already on screen', async () => {
    const user = userEvent.setup();
    const { container } = render(
      <Tooltip label="Chat" shortcut="⌘1" disabled>
        <button type="button" aria-label="Chat" />
      </Tooltip>,
    );
    const trigger = screen.getByRole('button', { name: 'Chat' });
    // Not even a wrapper: the tree is the child, untouched.
    expect(trigger.parentElement).toBe(container);

    trigger.focus();
    await user.hover(trigger);
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('still accepts the older `content` spelling for non-string bodies', async () => {
    render(
      <Tooltip content={<span>18k of 66k used</span>}>
        <button type="button">Context</button>
      </Tooltip>,
    );
    screen.getByRole('button', { name: 'Context' }).focus();
    expect(await screen.findByRole('tooltip')).toHaveTextContent('18k of 66k used');
  });
});
