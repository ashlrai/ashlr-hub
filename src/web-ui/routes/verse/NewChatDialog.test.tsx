import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { bootstrap } from './fixtures.test-support.js';
import { CLAUDE_TIGHT_SEAT, CODEX_CREDITS_SEAT, UNREAD_SEAT } from './seat-fixtures.test-support.js';
import { NewChatDialog } from './NewChatDialog.js';

describe('NewChatDialog', () => {
  it('keeps what was typed when the project/seat lists refetch while it is open', async () => {
    const user = userEvent.setup();
    const boot = bootstrap();
    const onCreate = vi.fn();
    const view = render(<NewChatDialog open onClose={() => {}} projects={boot.projects} seats={boot.seats} onCreate={onCreate} />);

    await user.selectOptions(screen.getByLabelText('Project'), 'Other folder…');
    await user.type(screen.getByLabelText('Folder path'), '/Users/mason/dev/elsewhere');
    await user.type(screen.getByLabelText(/^Title/), 'Long title in progress');

    // A turn finishing in another chat invalidates bootstrap: new array references, same content.
    const again = bootstrap();
    view.rerender(<NewChatDialog open onClose={() => {}} projects={again.projects} seats={again.seats} onCreate={onCreate} />);

    expect(screen.getByLabelText('Folder path')).toHaveValue('/Users/mason/dev/elsewhere');
    expect(screen.getByLabelText(/^Title/)).toHaveValue('Long title in progress');

    await user.click(screen.getByRole('button', { name: 'Start chat' }));
    expect(onCreate).toHaveBeenCalledWith({ projectPath: '/Users/mason/dev/elsewhere', seatId: 'claude-main', model: 'claude-opus-5', title: 'Long title in progress' });
  });

  it('resets to the pre-fill on each open, not on every render', async () => {
    const user = userEvent.setup();
    const boot = bootstrap();
    const view = render(<NewChatDialog open={false} onClose={() => {}} projects={boot.projects} seats={boot.seats} onCreate={() => {}} initialProjectPath="/Users/mason/dev/site" />);
    view.rerender(<NewChatDialog open onClose={() => {}} projects={boot.projects} seats={boot.seats} onCreate={() => {}} initialProjectPath="/Users/mason/dev/site" />);
    expect(screen.getByLabelText('Project')).toHaveValue('/Users/mason/dev/site');
    await user.type(screen.getByLabelText(/^Title/), 'draft');
    view.rerender(<NewChatDialog open onClose={() => {}} projects={boot.projects} seats={boot.seats} onCreate={() => {}} initialProjectPath="/Users/mason/dev/hub" />);
    // Pre-fill changes while open do not clobber the form …
    expect(screen.getByLabelText(/^Title/)).toHaveValue('draft');
    expect(screen.getByLabelText('Project')).toHaveValue('/Users/mason/dev/site');
    // … but the next open applies them.
    view.rerender(<NewChatDialog open={false} onClose={() => {}} projects={boot.projects} seats={boot.seats} onCreate={() => {}} initialProjectPath="/Users/mason/dev/hub" />);
    view.rerender(<NewChatDialog open onClose={() => {}} projects={boot.projects} seats={boot.seats} onCreate={() => {}} initialProjectPath="/Users/mason/dev/hub" />);
    expect(screen.getByLabelText(/^Title/)).toHaveValue('');
    expect(screen.getByLabelText('Project')).toHaveValue('/Users/mason/dev/hub');
  });
});

/**
 * The seat list is where the choice actually gets made, so the cost of making
 * it belongs here — not one section away in Usage, discovered at turn time.
 */
describe('NewChatDialog — capacity at the point of choice', () => {
  const boot = bootstrap();

  it('shows the chosen seat\u2019s plan, binding meter and verbatim reset', () => {
    render(<NewChatDialog open onClose={() => {}} projects={boot.projects} seats={[CLAUDE_TIGHT_SEAT]} onCreate={() => {}} />);
    expect(screen.getByText('max')).toBeInTheDocument();
    expect(screen.getByRole('meter', { name: 'Claude Max weekly fable window used' })).toHaveAttribute('aria-valuenow', '92');
    expect(screen.getByText('resets Sep 25 at 7pm (America/New_York)')).toBeInTheDocument();
    expect(screen.getByText('tight')).toBeInTheDocument();
  });

  it('names the credits that outlive a spent window', () => {
    render(<NewChatDialog open onClose={() => {}} projects={boot.projects} seats={[CODEX_CREDITS_SEAT]} onCreate={() => {}} />);
    expect(screen.getByText('limit reached')).toBeInTheDocument();
    expect(screen.getByText(/2048\.42 credits left/)).toBeInTheDocument();
  });

  it('draws no meter for a seat nothing was read from', () => {
    render(<NewChatDialog open onClose={() => {}} projects={boot.projects} seats={[UNREAD_SEAT]} onCreate={() => {}} />);
    expect(screen.queryByRole('meter')).not.toBeInTheDocument();
    expect(screen.getByText('no capacity reading')).toBeInTheDocument();
  });
});
