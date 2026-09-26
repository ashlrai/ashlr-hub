import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { authorityStatus, fleetLive } from '../command/fixtures.test-support.js';
import { getVerseUiState, setVerseSection } from '../verse-ui-store.js';
import { AutonomyOffState } from './AutonomyOffState.js';
import { SETUP_COMMAND, autonomyOffState } from './autonomy-off-model.js';

const NOW = Date.parse('2026-09-25T15:00:00Z');
const custody = { installed: true, keyInitialized: true, githubApp: false, claudeToken: false };
const setup = autonomyOffState({ authority: authorityStatus('dark', NOW, { custody }), live: fleetLive('dark', NOW), draft: 'setup' })!;
const grant = autonomyOffState({ authority: authorityStatus('dark', NOW), live: fleetLive('dark', NOW), draft: 'ready' })!;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('AutonomyOffState', () => {
  it('states what is off, why, and ONE action: the setup command, read in full and copied', async () => {
    // user-event installs its own clipboard; watch that one.
    const user = userEvent.setup();
    const writeText = vi.spyOn(navigator.clipboard, 'writeText');
    render(<AutonomyOffState state={setup} here="growth" />);
    const region = screen.getByRole('region', { name: 'Autonomy is off' });
    expect(region).toHaveTextContent('Nothing runs or merges on its own until the one-time setup is done.');
    expect(within(region).getByText(SETUP_COMMAND)).toBeInTheDocument();
    expect(within(region).getAllByRole('button')).toHaveLength(1);
    await user.click(within(region).getByRole('button', { name: `Copy the command: ${SETUP_COMMAND}` }));
    expect(writeText).toHaveBeenCalledWith(SETUP_COMMAND);
    await waitFor(() => expect(within(region).getByRole('button', { name: /Copy the command/ })).toHaveTextContent('Copied'));
  });

  it('shows the setup progress Verse can see', () => {
    render(<AutonomyOffState state={setup} here="growth" />);
    const checks = screen.getByRole('list', { name: 'Setup: 2 of 5 ready' });
    expect(within(checks).getAllByRole('listitem').map((li) => li.textContent)).toEqual([
      'Custody helper — done',
      'Signing key — done',
      'GitHub App — to do',
      'Claude token — to do',
      'Standing grant — to do',
    ]);
  });

  it('goes to Command from another surface, and leaves that out on Command itself', async () => {
    setVerseSection('growth');
    const user = userEvent.setup();
    const { unmount } = render(<AutonomyOffState state={grant} here="growth" />);
    await user.click(screen.getByRole('button', { name: 'Approve in Command' }));
    expect(getVerseUiState().section).toBe('command');
    unmount();
    render(<AutonomyOffState state={grant} here="command" />);
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('opens Command’s Touch ID sheet when Command hands it the grant action', async () => {
    const onGrant = vi.fn();
    const user = userEvent.setup();
    render(<AutonomyOffState state={grant} here="command" onGrant={onGrant} />);
    await user.click(screen.getByRole('button', { name: 'Approve grant' }));
    expect(onGrant).toHaveBeenCalledWith('grant');
  });

  it('takes a surface headline and folds the state into its line', () => {
    render(<AutonomyOffState state={grant} here="growth" title="Growth starts with the first fleet run." />);
    const region = screen.getByRole('region', { name: 'Growth starts with the first fleet run.' });
    expect(region).toHaveTextContent('Autonomy is off. Approve a standing grant to let the fleet work.');
  });

  it('renders a plain empty line when autonomy is on (no state, no action)', () => {
    render(<AutonomyOffState state={null} here="mind" title="The Leader hasn't run yet." why={null} />);
    const region = screen.getByRole('region', { name: "The Leader hasn't run yet." });
    expect(within(region).queryByRole('button')).toBeNull();
    expect(within(region).queryByRole('paragraph')).toBeNull();
  });
});
