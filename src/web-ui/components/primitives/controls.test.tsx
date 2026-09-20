/**
 * components/primitives/controls.test.tsx — the accessibility contract of
 * the V2 control set, asserted once here so no section has to re-test it.
 *
 * These are behavior tests, not snapshots: a control is correct when a
 * keyboard operator can reach it, operate it, and hear what it is — not when
 * its markup matches a string.
 */
import { describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Button, IconButton } from './Button.js';
import { EmptyState } from './EmptyState.js';
import { Input } from './Input.js';
import { Meter } from './Meter.js';
import { Segmented } from './Segmented.js';
import { Sheet } from './Sheet.js';
import { Switch } from './Switch.js';
import { Tag } from './Tag.js';
import { Tooltip } from './Tooltip.js';
import { IconPlus, IconStop } from './icons.js';

describe('Button', () => {
  it('gives an icon-only button an accessible name', () => {
    render(<IconButton icon={<IconStop />} aria-label="Stop turn" />);
    expect(screen.getByRole('button', { name: 'Stop turn' })).toBeInTheDocument();
  });

  it('keeps its decorative glyph out of the accessible name', () => {
    render(
      <Button icon={<IconPlus />} variant="primary">
        New chat
      </Button>,
    );
    expect(screen.getByRole('button', { name: 'New chat' })).toBeInTheDocument();
  });

  it('is disabled and announced busy while in flight', async () => {
    const onClick = vi.fn();
    const user = userEvent.setup();
    render(<Button busy onClick={onClick}>Save</Button>);
    const button = screen.getByRole('button', { name: 'Save' });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('aria-busy', 'true');
    await user.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });
});

describe('Segmented', () => {
  function Harness() {
    const [value, setValue] = useState('system');
    return (
      <Segmented
        aria-label="Theme"
        value={value}
        onChange={setValue}
        options={[
          { value: 'system', label: 'System' },
          { value: 'light', label: 'Light' },
          { value: 'dark', label: 'Dark' },
        ]}
      />
    );
  }

  it('exposes a radiogroup with one selected option', () => {
    render(<Harness />);
    const group = screen.getByRole('radiogroup', { name: 'Theme' });
    expect(within(group).getAllByRole('radio')).toHaveLength(3);
    expect(within(group).getByRole('radio', { name: 'System' })).toBeChecked();
  });

  it('moves and selects with the arrow keys, wrapping at the ends', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const group = screen.getByRole('radiogroup', { name: 'Theme' });

    within(group).getByRole('radio', { name: 'System' }).focus();
    await user.keyboard('{ArrowRight}');
    expect(within(group).getByRole('radio', { name: 'Light' })).toBeChecked();

    await user.keyboard('{ArrowLeft}{ArrowLeft}');
    expect(within(group).getByRole('radio', { name: 'Dark' })).toBeChecked();
  });

  it('keeps exactly one tab stop for the whole group', () => {
    render(<Harness />);
    const radios = screen.getAllByRole('radio');
    expect(radios.filter((r) => r.getAttribute('tabindex') === '0')).toHaveLength(1);
  });
});

describe('Switch', () => {
  it('is a switch, not a checkbox, and toggles from the keyboard', async () => {
    const user = userEvent.setup();
    function Harness() {
      const [on, setOn] = useState(false);
      return <Switch checked={on} onChange={setOn} aria-label="Reduce motion" />;
    }
    render(<Harness />);
    const control = screen.getByRole('switch', { name: 'Reduce motion' });
    expect(control).toHaveAttribute('aria-checked', 'false');

    control.focus();
    await user.keyboard(' ');
    expect(control).toHaveAttribute('aria-checked', 'true');
  });
});

describe('Meter', () => {
  it('reports the percentage it is drawing', () => {
    render(<Meter value={18_420} max={66_000} label="Context" />);
    const meter = screen.getByRole('meter', { name: /context|/ });
    expect(meter).toHaveAttribute('aria-valuenow', '28');
    // Compact numerals, the way the design doc writes them: "18k / 66k".
    expect(screen.getByText('18k / 66k')).toBeInTheDocument();
  });

  it('says unknown instead of inventing a full or empty bar', () => {
    render(<Meter value={1200} max={null} label="Context" />);
    expect(screen.getByText('unknown')).toBeInTheDocument();
    expect(screen.getByRole('meter')).toHaveAttribute('aria-valuetext', 'unknown');
    expect(screen.getByRole('meter')).not.toHaveAttribute('aria-valuenow');
  });

  it('carries an accessible name in the label-less line variant', () => {
    render(<Meter value={50} max={100} variant="line" aria-label="Context window" />);
    expect(screen.getByRole('meter', { name: 'Context window' })).toBeInTheDocument();
  });
});

describe('Input', () => {
  it('wires label, hint and error to the field', () => {
    render(<Input label="Daily budget" hint="USD per day" error="Must be under 1000" />);
    const field = screen.getByLabelText('Daily budget');
    expect(field).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByRole('alert')).toHaveTextContent('Must be under 1000');
    expect(field.getAttribute('aria-describedby')).toContain(screen.getByText('USD per day').id);
  });
});

describe('Tooltip', () => {
  it('stays hidden until focus, describes the trigger, and closes on Escape', async () => {
    const user = userEvent.setup();
    render(
      <Tooltip content="18k of 66k used">
        <button type="button">Context</button>
      </Tooltip>,
    );
    const trigger = screen.getByRole('button', { name: 'Context' });
    // `hidden` keeps it out of the accessibility tree entirely, not merely
    // out of sight — a tooltip nobody asked for is not announced either.
    expect(screen.queryByRole('tooltip')).toBeNull();

    trigger.focus();
    await waitFor(() => expect(screen.getByRole('tooltip')).toBeVisible());
    expect(trigger.parentElement).toHaveAttribute('aria-describedby', screen.getByRole('tooltip').id);

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('tooltip')).toBeNull();
  });
});

describe('Sheet', () => {
  function Harness() {
    const [open, setOpen] = useState(false);
    return (
      <>
        <button type="button" onClick={() => setOpen(true)}>
          Open detail
        </button>
        <Sheet open={open} onClose={() => setOpen(false)} titleId="sheet-title" title="Proposal">
          <button type="button">Inside</button>
        </Sheet>
      </>
    );
  }

  it('opens as a modal dialog, closes on Escape, and returns focus to the trigger', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const trigger = screen.getByRole('button', { name: 'Open detail' });

    await user.click(trigger);
    const sheet = screen.getByRole('dialog', { name: 'Proposal' });
    expect(sheet).toHaveAttribute('aria-modal', 'true');
    expect(within(sheet).getByRole('button', { name: 'Close' })).toBeInTheDocument();

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    await waitFor(() => expect(trigger).toHaveFocus());
  });
});

describe('EmptyState and Tag', () => {
  it('announces an error empty state and keeps the body text', () => {
    render(<EmptyState tone="error" title="Could not load seats" body="The server refused the read session." />);
    expect(screen.getByRole('alert')).toHaveTextContent('Could not load seats');
    expect(screen.getByText('The server refused the read session.')).toBeInTheDocument();
  });

  it('tints a tag by engine identity without coloring its text', () => {
    const { container } = render(<Tag engine="codex">Codex</Tag>);
    const tag = container.firstElementChild as HTMLElement;
    expect(tag).toHaveAttribute('data-engine', 'codex');
    // The identity hue lives on the dot; the label keeps the readable color.
    expect(tag.style.color).toBe('');
    expect((tag.firstElementChild as HTMLElement).style.background).toContain('--engine-codex');
  });
});
