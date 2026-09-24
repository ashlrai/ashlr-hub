/**
 * Dialog — the accessible-description contract (3.10.1 review).
 *
 * A confirm dialog's consequence ("Unsent drafts will be cleared…") lives in
 * `description`. Focus opens on a button (Cancel, by design), so a plain <p>
 * under the title was drawn but never announced: VoiceOver read the title and
 * "Cancel, button" and nothing else. The description is now the dialog's
 * aria-describedby. Everything else about the API is unchanged, which the
 * last cases pin for the callers that pass no description.
 */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useRef } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { Dialog } from './Dialog.js';

function Confirm({ description, onClose = () => {} }: { description?: React.ReactNode; onClose?: () => void }) {
  const cancel = useRef<HTMLButtonElement>(null);
  return (
    <Dialog open onClose={onClose} titleId="confirm-title" title="Disconnect from this hub?" initialFocusRef={cancel}
      description={description}>
      <button ref={cancel} type="button">Cancel</button>
      <button type="button">Disconnect</button>
    </Dialog>
  );
}

describe('Dialog', () => {
  it('announces its description with the title, though focus opens on a button', () => {
    render(<Confirm description="Unsent drafts in open chats will be cleared." />);
    const dialog = screen.getByRole('dialog', { name: 'Disconnect from this hub?' });
    expect(dialog).toHaveAccessibleDescription('Unsent drafts in open chats will be cleared.');
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus();
  });

  it('describes with rich description content too', () => {
    render(<Confirm description={<>The agent in <strong>Fix login</strong> will run every command.</>} />);
    expect(screen.getByRole('dialog')).toHaveAccessibleDescription('The agent in Fix login will run every command.');
  });

  it('gives each open dialog its own description id', () => {
    render(<><Confirm description="First." /><Confirm description="Second." /></>);
    const [a, b] = screen.getAllByRole('dialog');
    expect(a!.getAttribute('aria-describedby')).not.toBe(b!.getAttribute('aria-describedby'));
    expect(a).toHaveAccessibleDescription('First.');
    expect(b).toHaveAccessibleDescription('Second.');
  });

  it('sets no aria-describedby without a description (no dangling id), and renders no empty paragraph', () => {
    for (const description of [undefined, null, '']) {
      const { unmount } = render(<Confirm description={description} />);
      const dialog = screen.getByRole('dialog', { name: 'Disconnect from this hub?' });
      expect(dialog).not.toHaveAttribute('aria-describedby');
      expect(dialog.querySelector('p')).toBeNull();
      unmount();
    }
  });

  it('keeps the rest of the contract: labelled by titleId, Escape closes', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<Confirm onClose={onClose} />);
    expect(screen.getByRole('dialog')).toHaveAttribute('aria-labelledby', 'confirm-title');
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
