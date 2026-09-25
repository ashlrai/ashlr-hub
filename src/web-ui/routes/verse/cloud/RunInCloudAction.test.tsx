/**
 * RunInCloudAction — "Run in cloud" in the composer's ⋯ sheet: enabled only
 * when the chat's project has a GitHub origin, the seat is ready, the budget
 * allows it and the box has text; each disabled case says why (tooltip AND a
 * visible line). A launch posts the draft for the chat's repo and branch
 * with origin `chat`, clears the box, and shows the session link. The sheet
 * loads the action lazily, so it is not in the chat's first paint.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { useState } from 'react';
import type { VerseSession, VerseSessionRootsResponse } from '../../../data/api-types.js';
import { clearMutationToken, setMutationToken } from '../../../data/auth-store.js';
import { evictAll } from '../../../data/cache.js';
import { ControlsSheet } from '../composer/ControlsSheet.js';
import { resetActivityForTest } from '../shell/useActivity.js';
import { resetVerseStore, seedVerseSession } from '../verse-store.js';
import { setVerseActiveSession } from '../verse-ui-store.js';
import { RunInCloudAction } from './RunInCloudAction.js';
import { budgetView, json, overview, stubCloudFetch, task } from './cloud-fixtures.test-support.js';

const TOKEN = 'e'.repeat(64);
const SESSION_ID = 'sess-cloud-1';

function session(): VerseSession {
  return { id: SESSION_ID, projectPath: '/Users/mason/code/ashlr-hub', extraRoots: [], turnCount: 2 } as unknown as VerseSession;
}

function roots(remote: string | null, branch = 'v3110-cloud'): VerseSessionRootsResponse {
  return {
    sessionId: SESSION_ID,
    workspaceId: null,
    workspaceName: null,
    notes: [],
    roots: [
      {
        path: '/Users/mason/code/ashlr-hub',
        name: 'ashlr-hub',
        primary: true,
        exists: true,
        enrolled: true,
        reachable: true,
        git: { branch, dirty: 0, ahead: 0, behind: 0, remote },
      },
    ],
  };
}

/** The composer's box, as the Composer renders it (aria-label "Message"), as a controlled field. */
function Box({ initial }: { initial: string }) {
  const [value, setValue] = useState(initial);
  return <textarea aria-label="Message" value={value} onChange={(e) => setValue(e.target.value)} />;
}

function mount(draft: string) {
  render(
    <>
      <Box initial={draft} />
      <RunInCloudAction />
    </>,
  );
}

const button = () => screen.getByRole('button', { name: 'Run in cloud' });

beforeEach(() => {
  evictAll();
  resetVerseStore();
  resetActivityForTest(async () => { throw new Error('no activity in this test'); });
  seedVerseSession(SESSION_ID, session(), []);
  setVerseActiveSession(SESSION_ID);
  setMutationToken(TOKEN);
});
afterEach(() => {
  vi.unstubAllGlobals();
  clearMutationToken();
  setVerseActiveSession(null);
  resetVerseStore();
  resetActivityForTest();
});

const rootsRoute = (r: VerseSessionRootsResponse) => ({ [`/api/verse/sessions/${SESSION_ID}/roots`]: r });

describe('Run in cloud — enabled', () => {
  it('launches the draft on the chat’s GitHub origin and branch, clears the box and links the session', async () => {
    const launched = task('running', { title: 'Tighten the tracker tests', origin: 'chat' });
    const { posted } = stubCloudFetch(overview(), {
      routes: rootsRoute(roots('ashlrai/ashlr-hub')),
      post: () => json({ ok: true, task: launched, error: null, failure: null }),
    });
    const user = userEvent.setup();
    mount('Tighten the tracker tests.');
    await waitFor(() => expect(button()).toBeEnabled());
    expect(screen.getByText('Runs on ashlrai/ashlr-hub from v3110-cloud as a Claude Code cloud session and delivers a draft PR. Estimated at $3.')).toBeInTheDocument();
    await user.click(button());
    await waitFor(() => expect(posted).toEqual([
      { url: '/api/verse/cloud/launch', body: { repo: 'ashlrai/ashlr-hub', baseBranch: 'v3110-cloud', prompt: 'Tighten the tracker tests.', origin: 'chat' } },
    ]));
    const status = await screen.findByRole('status');
    expect(status).toHaveTextContent('Started “Tighten the tracker tests” in the cloud. The draft was cleared.');
    expect(within(status).getByRole('link', { name: /Open in Claude/ })).toHaveAttribute('href', launched.sessionUrl);
    expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue('');
  });

  it('shows the server’s refusal and keeps the draft', async () => {
    stubCloudFetch(overview(), {
      routes: rootsRoute(roots('ashlrai/ashlr-hub')),
      post: () => json({ ok: false, task: null, error: 'Cloud sessions are not enabled for this account.', failure: 'not-enabled' }),
    });
    const user = userEvent.setup();
    mount('Do it.');
    await waitFor(() => expect(button()).toBeEnabled());
    await user.click(button());
    expect(await screen.findByRole('alert')).toHaveTextContent('Cloud sessions are not enabled for this account.');
    expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue('Do it.');
  });

  it('asks for the token first when none is held, and sends nothing if dismissed', async () => {
    clearMutationToken();
    const { posted } = stubCloudFetch(overview(), { routes: rootsRoute(roots('ashlrai/ashlr-hub')) });
    const user = userEvent.setup();
    mount('Do it.');
    await waitFor(() => expect(button()).toBeEnabled());
    await user.click(button());
    const unlock = await screen.findByRole('dialog', { name: 'Unlock actions' });
    await user.click(within(unlock).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Unlock actions' })).toBeNull());
    expect(posted).toEqual([]);
    expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue('Do it.');
  });
});

describe('Run in cloud — disabled, with the reason', () => {
  async function expectBlocked(reason: string) {
    await waitFor(() => expect(screen.getByText(reason)).toBeInTheDocument());
    expect(button()).toBeDisabled();
    const user = userEvent.setup();
    await user.hover(button().parentElement!);
    expect(await screen.findByRole('tooltip')).toHaveTextContent(reason);
  }

  it('when the project has no GitHub origin', async () => {
    stubCloudFetch(overview(), { routes: rootsRoute(roots(null)) });
    mount('Do it.');
    await expectBlocked("This chat's project has no GitHub origin, so a cloud session has nothing to clone.");
  });

  it('when the Claude seat is not ready', async () => {
    stubCloudFetch(overview({ seat: { id: 'claude-a', ready: false, reason: null } }), { routes: rootsRoute(roots('ashlrai/ashlr-hub')) });
    mount('Do it.');
    await expectBlocked("The Claude seat isn't set up on this Mac.");
  });

  it('when the budget gate is closed', async () => {
    stubCloudFetch(overview({ budget: budgetView({ canLaunch: { ok: false, reason: '4 of 4 sessions running at once.' } }) }), { routes: rootsRoute(roots('ashlrai/ashlr-hub')) });
    mount('Do it.');
    await expectBlocked('4 of 4 sessions running at once.');
  });

  it('when the box is empty', async () => {
    stubCloudFetch(overview(), { routes: rootsRoute(roots('ashlrai/ashlr-hub')) });
    mount('   ');
    await expectBlocked('Type the task in the message box first.');
  });

  it('when the server has no cloud lane', async () => {
    stubCloudFetch(null, { routes: rootsRoute(roots('ashlrai/ashlr-hub')) });
    mount('Do it.');
    await expectBlocked('The cloud lane is not in this build yet.');
  });
});

describe('the ⋯ sheet', () => {
  it('lazy-loads Run in cloud under the pickers', async () => {
    stubCloudFetch(overview(), { routes: rootsRoute(roots('ashlrai/ashlr-hub')) });
    render(
      <>
        <Box initial="Do it." />
        <ControlsSheet open onClose={() => {}}>
          <p>pickers</p>
        </ControlsSheet>
      </>,
    );
    const sheet = screen.getByRole('dialog', { name: 'Chat settings' });
    expect(within(sheet).getByText('pickers')).toBeInTheDocument();
    expect(await within(sheet).findByRole('button', { name: 'Run in cloud' })).toBeInTheDocument();
  });

  it('reaches the cloud module only through import(), never a static import', () => {
    const src = readFileSync(resolve(process.cwd(), 'src/web-ui/routes/verse/composer/ControlsSheet.tsx'), 'utf8');
    expect(src).toContain(`import('../cloud/RunInCloudAction.js')`);
    expect(src).not.toMatch(/^import\s+(?!type\s)[^;]*['"]\.\.\/cloud\//m);
  });
});
