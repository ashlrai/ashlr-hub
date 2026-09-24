/**
 * chat/TurnAnnouncer.test.tsx — the transcript is `aria-live="off"`; a screen
 * reader hears only turn boundaries (SPEC-310C §2 "Screen readers").
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { TurnAnnouncer, turnAnnouncement } from './TurnAnnouncer.js';

describe('turnAnnouncement', () => {
  it('says nothing on mount (history is not news)', () => {
    expect(turnAnnouncement(null, { running: true, lastStatus: 'running', lastKey: 'a' })).toBeNull();
  });

  it('says start, finish, failure and stop — and nothing in between', () => {
    expect(turnAnnouncement({ running: false, lastKey: 'a' }, { running: true, lastStatus: 'running', lastKey: 'b' })).toBe('Turn started.');
    expect(turnAnnouncement({ running: true, lastKey: 'b' }, { running: true, lastStatus: 'running', lastKey: 'b' })).toBeNull();
    expect(turnAnnouncement({ running: true, lastKey: 'b' }, { running: false, lastStatus: 'ok', lastKey: 'b' })).toBe('Turn finished.');
    expect(turnAnnouncement({ running: true, lastKey: 'b' }, { running: false, lastStatus: 'error', lastKey: 'b' })).toBe('Turn failed.');
    expect(turnAnnouncement({ running: true, lastKey: 'b' }, { running: false, lastStatus: 'stopped', lastKey: 'b' })).toBe('Turn stopped.');
  });
});

describe('TurnAnnouncer', () => {
  it('is a polite status region that speaks each boundary once', () => {
    const view = render(<TurnAnnouncer running={false} lastStatus="ok" lastKey="a" />);
    const region = screen.getByTestId('turn-announcer');
    expect(region).toHaveAttribute('role', 'status');
    expect(region).toHaveAttribute('aria-live', 'polite');
    expect(region).toBeEmptyDOMElement();
    view.rerender(<TurnAnnouncer running lastStatus="running" lastKey="b" />);
    expect(region).toHaveTextContent('Turn started.');
    view.rerender(<TurnAnnouncer running={false} lastStatus="error" lastKey="b" />);
    expect(region).toHaveTextContent('Turn failed.');
    // A second failure is a second event: the text changes so it is re-read.
    view.rerender(<TurnAnnouncer running lastStatus="running" lastKey="c" />);
    view.rerender(<TurnAnnouncer running={false} lastStatus="error" lastKey="c" />);
    expect(region.textContent?.trim()).toBe('Turn failed.');
  });
});
