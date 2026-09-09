import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from '@testing-library/react';
import { Experiment } from '../app/experiment';
import evidence from '../app/data/demo.json';

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const click = (name: string) =>
  fireEvent.click(screen.getByRole('button', { name }));
const advance = async () => {
  await act(async () => {
    vi.advanceTimersByTime(4000);
  });
};

it('starts only on request, follows six recorded trials and stops at the end', async () => {
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  render(<Experiment evidence={evidence} />);
  await act(async () => {
    vi.advanceTimersByTime(20000);
  });
  expect(screen.getByRole('status').textContent).toContain('Step 4 of 6');
  click('Play recorded search');
  expect(screen.getByRole('status').textContent).toContain('Step 1 of 6');
  for (let step = 2; step <= 6; step++) {
    await advance();
    expect(screen.getByRole('status').textContent).toContain(
      `Step ${step} of 6`,
    );
  }
  expect(screen.getByRole('status').textContent).toContain('Replay complete');
  expect(screen.getByText('No passing score')).toBeDefined();
  await advance();
  expect(screen.getByRole('status').textContent).toContain('Step 6 of 6');
  click('Replay again');
  expect(screen.getByRole('status').textContent).toContain('Step 1 of 6');
  expect(fetch).not.toHaveBeenCalled();
});
it('pauses, resumes and immediately yields to manual graph selection', async () => {
  render(<Experiment evidence={evidence} />);
  click('Play recorded search');
  await advance();
  click('Pause replay');
  await advance();
  expect(screen.getByRole('status').textContent).toContain('Step 2 of 6');
  click('Resume replay');
  await advance();
  expect(screen.getByRole('status').textContent).toContain('Step 3 of 6');
  click('Select compact lineage, generation 2');
  await advance();
  expect(screen.getByRole('status').textContent).toContain('Step 4 of 6');
  expect(screen.getByRole('status').textContent).toContain('Paused');
});
it('keeps previous/next and sequence controls synchronized and bounded', () => {
  render(<Experiment evidence={evidence} />);
  click('Go to recorded step 1: generation 1, compact');
  expect(
    (
      screen.getByRole('button', {
        name: 'Previous recorded trial',
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  click('Next recorded trial');
  expect(screen.getByRole('status').textContent).toContain('Step 2 of 6');
  click('Previous recorded trial');
  expect(screen.getByRole('status').textContent).toContain('Step 1 of 6');
  click('Go to recorded step 6: generation 2, broken');
  expect(
    (
      screen.getByRole('button', {
        name: 'Next recorded trial',
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  expect(
    screen
      .getByRole('button', {
        name: 'Go to recorded step 6: generation 2, broken',
      })
      .getAttribute('aria-current'),
  ).toBe('step');
});
it('pauses when the page becomes hidden and does not resume itself', async () => {
  render(<Experiment evidence={evidence} />);
  click('Play recorded search');
  const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
  fireEvent(document, new Event('visibilitychange'));
  await advance();
  expect(screen.getByRole('status').textContent).toContain('Step 1 of 6');
  expect(screen.getByRole('status').textContent).toContain('Paused');
  hidden.mockReturnValue(false);
  fireEvent(document, new Event('visibilitychange'));
  await advance();
  expect(screen.getByRole('status').textContent).toContain('Paused');
});
it('pauses offscreen, preserves focus and releases observers and timers on unmount', async () => {
  let notify: (entries: { isIntersecting: boolean }[]) => void = () => {};
  const disconnect = vi.fn();
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      constructor(callback: typeof notify) {
        notify = callback;
      }
      observe() {}
      disconnect = disconnect;
    },
  );
  const view = render(<Experiment evidence={evidence} />);
  const control = screen.getByRole('button', { name: 'Play recorded search' });
  control.focus();
  fireEvent.click(control);
  await advance();
  expect(document.activeElement).toBe(control);
  await act(async () => {
    notify([{ isIntersecting: false }]);
  });
  await advance();
  expect(screen.getByRole('status').textContent).toContain('Paused');
  view.unmount();
  expect(disconnect).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});
it('pauses when a generation or trial card is manually chosen', async () => {
  render(<Experiment evidence={evidence} />);
  click('Play recorded search');
  fireEvent.click(screen.getByRole('tab', { name: 'Generation 2' }));
  await advance();
  expect(screen.getByRole('status').textContent).toContain('Step 4 of 6');
  click('Resume replay');
  click('Inspect readable, generation 2');
  await advance();
  expect(screen.getByRole('status').textContent).toContain('Step 5 of 6');
  expect(screen.getByRole('status').textContent).toContain('Paused');
});
