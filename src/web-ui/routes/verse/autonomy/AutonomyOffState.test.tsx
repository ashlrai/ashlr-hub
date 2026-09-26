import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { authorityStatus, fleetLive, setupReport } from '../command/fixtures.test-support.js';
import { getVerseUiState, setVerseSection } from '../verse-ui-store.js';
import { AutonomyOffState } from './AutonomyOffState.js';
import { SETUP_COMMAND, autonomyOffState } from './autonomy-off-model.js';

const NOW = Date.parse('2026-09-25T15:00:00Z');
const INSTALL = 'https://github.com/apps/ashlr-fleet/installations/new';
const pending = setupReport('github-app', {
  'github-app': { detail: 'the ashlr-fleet key is in custody, but the App is not installed on ashlrai/fleet-canary', link: INSTALL },
});
const setup = autonomyOffState({ authority: authorityStatus('dark', NOW), live: fleetLive('dark', NOW), readiness: 'setup', setup: pending })!;
const grant = autonomyOffState({ authority: authorityStatus('dark', NOW), live: fleetLive('dark', NOW), readiness: 'ready', setup: setupReport() })!;

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

  it('shows the live checklist: the next step with what it needs and its page, then every step, folded', async () => {
    render(<AutonomyOffState state={setup} here="growth" />);
    const checklist = await screen.findByTestId('setup-checklist');
    expect(checklist).toHaveTextContent('NextGitHub App');
    // On the next step and on its row in the list.
    expect(within(checklist).getAllByLabelText('Needs Browser, GitHub')).toHaveLength(2);
    expect(checklist).toHaveTextContent('the App is not installed on ashlrai/fleet-canary');
    expect(within(checklist).getByRole('link', { name: 'Open the install page ↗' })).toHaveAttribute('href', INSTALL);
    // The ONE action is still the single button, right under the next step.
    expect(within(checklist).getByRole('button', { name: `Copy the command: ${SETUP_COMMAND}` })).toBeInTheDocument();
    const steps = within(checklist).getByRole('list', { name: 'Setup: 5 of 15 ready' });
    const items = within(steps).getAllByRole('listitem');
    expect(items).toHaveLength(15);
    expect(items[0]).toHaveTextContent('Custody helper — done');
    expect(items[5]).toHaveAttribute('aria-current', 'step');
    expect(items[5]).toHaveTextContent('GitHub App');
    expect(items[6]).toHaveTextContent('Claude token');
    expect(items[6]).toHaveTextContent('— to do');
    expect(items[14]).toHaveTextContent('Resident runtimeblocked');
    expect(within(items[14]!).getByLabelText('Needs Terminal')).toBeInTheDocument();
    // Folded by default: the count is the summary.
    expect(checklist.querySelector('details')?.open).toBe(false);
  });

  it('the grant state lists the checklist too, with Approve grant as the one action on Command', async () => {
    const onGrant = vi.fn();
    render(<AutonomyOffState state={grant} here="command" onGrant={onGrant} />);
    const checklist = await screen.findByTestId('setup-checklist');
    expect(checklist).toHaveTextContent('NextStanding grant');
    expect(within(checklist).getAllByLabelText('Needs Touch ID').length).toBeGreaterThan(0);
    expect(within(checklist).getByRole('button', { name: 'Approve grant' })).toBeInTheDocument();
    expect(screen.getAllByRole('button')).toHaveLength(1);
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
