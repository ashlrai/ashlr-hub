import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PowerState } from '../../../app/desktop-shell.js';
const mocks = vi.hoisted(() => ({ power: null as PowerState | null, send: vi.fn(() => true) }));
vi.mock('../../../app/desktop-shell.js', () => ({ useDesktopState: () => ({ power: mocks.power }), setDesktopPreference: mocks.send }));
import { PowerStatus } from './PowerStatus.js';
const state: PowerState = { automatic: true, requested: true, localRuns: 2, checkedAt: 1791169200000, platform: 'macos', error: null, powerSource: 'ac', idleSleepSeconds: 1200, settingsCheckedAt: 1791169200000 };
beforeEach(() => { mocks.power = { ...state }; mocks.send.mockReset(); mocks.send.mockReturnValue(true); });
describe('computer power status', () => {
  it('reports accepted native request and actual system timer separately', () => {
    render(<PowerStatus />);
    expect(screen.getByLabelText('Computer power: Awake request active')).toBeTruthy();
    expect(screen.getByText('Plugged in · System idle sleep after 20 min')).toBeTruthy();
  });
  it('manual control waits for native readback rather than claiming success', () => {
    const view = render(<PowerStatus />); const checkbox = screen.getByRole('checkbox', { hidden: true }) as HTMLInputElement;
    fireEvent.click(checkbox); expect(mocks.send).toHaveBeenCalledWith('automaticAwake', false);
    expect(checkbox.checked).toBe(true);
    mocks.power = { ...state, automatic: false, requested: false }; view.rerender(<PowerStatus />);
    expect(screen.getByLabelText('Computer power: System sleep settings')).toBeTruthy();
  });
  it('shows failed requests without an awake claim', () => {
    mocks.power = { ...state, requested: false, error: 'macOS refused the idle-sleep request.' }; render(<PowerStatus />);
    expect(screen.getByLabelText('Computer power: Awake request failed')).toBeTruthy();
    expect(screen.getByRole('alert', { hidden: true }).textContent).toContain('macOS refused');
  });
  it('a browser cannot invent or change host power', () => {
    mocks.power = null; render(<PowerStatus />); expect(screen.getByLabelText('Computer power: Host power unavailable')).toBeTruthy();
    expect(screen.queryByRole('checkbox', { hidden: true })).toBeNull(); expect(mocks.send).not.toHaveBeenCalled();
  });
});
