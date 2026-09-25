/**
 * CloudLaunchDialog — "New cloud task": the repo defaults to
 * ashlrai/ashlr-hub, each bad field is named before anything is sent, a good
 * launch posts exactly the request (origin `operator`) and closes, and a
 * server refusal stays in the dialog with the draft intact.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { CloudTaskV1 } from '../../../../core/cloud/types.js';
import { clearMutationToken, setMutationToken } from '../../../data/auth-store.js';
import { evictAll } from '../../../data/cache.js';
import { useSurfaceActions } from '../command/actions.js';
import { resetActivityForTest } from '../shell/useActivity.js';
import { CloudLaunchDialog } from './CloudLaunchDialog.js';
import { json, overview, stubCloudFetch, task } from './cloud-fixtures.test-support.js';

const TOKEN = 'd'.repeat(64);

function Host({ onLaunched, onClose }: { onLaunched: (t: CloudTaskV1) => void; onClose: () => void }) {
  const actions = useSurfaceActions();
  return (
    <>
      <CloudLaunchDialog open onClose={onClose} actions={actions} estimatePerSessionUsd={3} onLaunched={onLaunched} />
      {actions.dialogs}
    </>
  );
}

function setup() {
  const onLaunched = vi.fn();
  const onClose = vi.fn();
  render(<Host onLaunched={onLaunched} onClose={onClose} />);
  const dialog = screen.getByRole('dialog', { name: 'New cloud task' });
  return { onLaunched, onClose, dialog, user: userEvent.setup() };
}

beforeEach(() => {
  evictAll();
  resetActivityForTest(async () => { throw new Error('no activity in this test'); });
  setMutationToken(TOKEN);
});
afterEach(() => {
  vi.unstubAllGlobals();
  clearMutationToken();
  resetActivityForTest();
});

describe('CloudLaunchDialog', () => {
  it('opens on the task box with the repo prefilled and the estimate stated', () => {
    stubCloudFetch(overview());
    const { dialog } = setup();
    expect(within(dialog).getByLabelText('Repository')).toHaveValue('ashlrai/ashlr-hub');
    expect(within(dialog).getByLabelText('Base branch')).toHaveValue('');
    expect(within(dialog).getByLabelText('Task')).toHaveFocus();
    expect(dialog).toHaveTextContent('0 of 20,000 characters · estimated at $3 per session');
    expect(dialog).toHaveAccessibleDescription(/delivers a draft PR; nothing merges on its own/);
  });

  it('names every bad field and sends nothing', async () => {
    const { posted } = stubCloudFetch(overview());
    const { dialog, user } = setup();
    const repo = within(dialog).getByLabelText('Repository');
    await user.clear(repo);
    await user.type(repo, 'ashlr-hub');
    await user.type(within(dialog).getByLabelText('Base branch'), 'bad..branch');
    await user.click(within(dialog).getByRole('button', { name: 'Launch' }));
    const alerts = within(dialog).getAllByRole('alert').map((a) => a.textContent);
    expect(alerts).toEqual([
      'Use the GitHub owner/name form, like ashlrai/ashlr-hub.',
      "That isn't a branch name git accepts.",
      'Describe the task for the cloud session.',
    ]);
    expect(within(dialog).getByLabelText('Task')).toHaveAttribute('aria-invalid', 'true');
    expect(posted).toEqual([]);
    // Editing a field clears only its own error.
    await user.type(within(dialog).getByLabelText('Task'), 'Fix it');
    expect(within(dialog).getAllByRole('alert')).toHaveLength(2);
  });

  it('launches with origin "operator", reports the task and closes', async () => {
    const launched = task('running');
    const { posted } = stubCloudFetch(overview(), { post: () => json({ ok: true, task: launched, error: null, failure: null }) });
    const { dialog, user, onLaunched, onClose } = setup();
    await user.type(within(dialog).getByLabelText('Base branch'), 'v3110-cloud');
    await user.type(within(dialog).getByLabelText('Task'), '  Fix the flaky tracker test.  ');
    await user.click(within(dialog).getByRole('button', { name: 'Launch' }));
    await waitFor(() => expect(onLaunched).toHaveBeenCalledWith(launched));
    expect(posted).toEqual([
      { url: '/api/verse/cloud/launch', body: { repo: 'ashlrai/ashlr-hub', baseBranch: 'v3110-cloud', prompt: 'Fix the flaky tracker test.', origin: 'operator' } },
    ]);
    expect(onClose).toHaveBeenCalled();
  });

  it('keeps a budget refusal in the dialog, in the server’s words, with the draft intact', async () => {
    stubCloudFetch(overview(), { post: () => json({ ok: false, task: null, error: '20 of 20 sessions used today.', failure: 'budget' }) });
    const { dialog, user, onLaunched, onClose } = setup();
    await user.type(within(dialog).getByLabelText('Task'), 'Fix it.');
    await user.click(within(dialog).getByRole('button', { name: 'Launch' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('20 of 20 sessions used today.');
    expect(within(dialog).getByLabelText('Task')).toHaveValue('Fix it.');
    expect(onLaunched).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('shows a 4xx refusal sentence too', async () => {
    stubCloudFetch(overview(), { post: () => json({ ok: false, error: 'The base branch is not on origin.', failure: 'no-remote' }, 409) });
    const { dialog, user } = setup();
    await user.type(within(dialog).getByLabelText('Task'), 'Fix it.');
    await user.click(within(dialog).getByRole('button', { name: 'Launch' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('The base branch is not on origin.');
  });

  it('counts characters and refuses one over the limit', async () => {
    const { posted } = stubCloudFetch(overview());
    const { dialog, user } = setup();
    const box = within(dialog).getByLabelText('Task');
    await user.click(box);
    await user.paste('x'.repeat(20_001));
    expect(dialog).toHaveTextContent('20,001 of 20,000 characters');
    await user.click(within(dialog).getByRole('button', { name: 'Launch' }));
    expect(within(dialog).getByRole('alert')).toHaveTextContent('The task is 20,001 characters; the limit is 20,000.');
    expect(posted).toEqual([]);
  });
});
