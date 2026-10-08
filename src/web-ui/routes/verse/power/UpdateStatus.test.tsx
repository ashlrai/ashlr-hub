import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ state: null as unknown, refresh: vi.fn(() => true), preference: vi.fn(() => true) }));
vi.mock('../../../app/desktop-updates.js', () => ({ useDesktopUpdates: () => mocks.state, refreshDesktopUpdates: mocks.refresh }));
vi.mock('../../../app/desktop-state.js', () => ({ setDesktopPreference: mocks.preference }));
import { UpdateStatus } from './UpdateStatus.js';
const state = { phase: 'downloading', enabled: true, version: '3.25.2', bytesReceived: 1234567, bytesTotal: 9999999, reason: null };
beforeEach(() => { mocks.state = { ...state }; mocks.refresh.mockClear(); mocks.preference.mockClear(); });
afterEach(() => vi.useRealTimers());
describe('Phantom update status', () => {
  it('shows actual progress at two significant figures without an installed claim', () => {
    render(<UpdateStatus />); expect(screen.getByText('1.2 MB of 9.5 MB · 12%')).toBeTruthy();
    expect(screen.getByRole('progressbar', { hidden: true }).getAttribute('value')).toBe('1234567');
    expect(screen.queryByText('Update installed')).toBeNull();
  });
  it('waits for native preference acknowledgement and reports timeout', () => {
    vi.useFakeTimers(); const view = render(<UpdateStatus />);
    const checkbox = screen.getByRole('checkbox', { hidden: true }) as HTMLInputElement;
    fireEvent.click(checkbox); expect(mocks.preference).toHaveBeenCalledWith('automaticUpdates', false);
    expect(checkbox.checked).toBe(true); expect(checkbox.disabled).toBe(true);
    act(() => { vi.advanceTimersByTime(4000); }); expect(screen.getByRole('alert', { hidden: true }).textContent).toContain('did not confirm');
    mocks.state = { ...state, enabled: false, phase: 'disabled' }; view.rerender(<UpdateStatus />);
    expect(checkbox.checked).toBe(false); expect(screen.queryByRole('alert', { hidden: true })).toBeNull();
  });
  it('download progress cannot acknowledge a pending preference change', () => {
    const view = render(<UpdateStatus />); const checkbox = screen.getByRole('checkbox', { hidden: true }) as HTMLInputElement;
    fireEvent.click(checkbox); mocks.state = { ...state, bytesReceived: 2234567 }; view.rerender(<UpdateStatus />);
    expect(checkbox.checked).toBe(true); expect(checkbox.disabled).toBe(true);
    mocks.state = { ...state, enabled: false }; view.rerender(<UpdateStatus />); expect(checkbox.disabled).toBe(false); expect(checkbox.checked).toBe(false);
  });
  it('a refresh asks only for host status', () => { render(<UpdateStatus />); fireEvent.click(screen.getByRole('button', { hidden: true })); expect(mocks.refresh).toHaveBeenCalledTimes(2); expect(mocks.preference).not.toHaveBeenCalled(); });
  it('holds are actionable and do not expose raw native diagnostics', () => {
    mocks.state = { ...state, phase: 'adoption-held', reason: 'grant-expired' }; render(<UpdateStatus />);
    expect(screen.getByText(/could not confirm the conditions/u)).toBeTruthy(); expect(screen.queryByText('grant-expired')).toBeNull();
  });
  it('older shells and browsers show no invented control', () => { mocks.state = null; const view = render(<UpdateStatus />); expect(view.container.childElementCount).toBe(0); });
});
