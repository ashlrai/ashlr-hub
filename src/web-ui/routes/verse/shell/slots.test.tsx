/**
 * Slots (unit C0; SPEC-310C §7): C2 mounts other units' UI only through
 * these, each lazily loading ONE fixed file and rendering nothing until it
 * lands. The real module map is checked against the contract table; the
 * rendering paths run against injected maps (a landed file, an absent one, a
 * mis-named export, a component that crashes).
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BranchBarSlot,
  isSlotAvailable,
  SessionInsightChipSlot,
  SLOT_IDS,
  SLOT_MODULES,
  SlotForTest,
  SLOTS,
  TerminalPaneSlot,
  type TerminalPaneProps,
} from './slots.js';

const VERSE = resolve(process.cwd(), 'src/web-ui/routes/verse');

afterEach(() => vi.restoreAllMocks());

const terminalProps: TerminalPaneProps = { sessionId: 's-1', roots: ['/r'], request: null, onSendToChat: () => {}, visible: true };

describe('slot contracts', () => {
  it('names the five fixed files the spec lists, each a named export', () => {
    expect(Object.fromEntries(SLOT_IDS.map((id) => [id, `${SLOTS[id].path}#${SLOTS[id].exportName}`]))).toEqual({
      'branch-bar': 'git/BranchBar.tsx#BranchBar',
      'diff-pane': 'git/DiffPane.tsx#DiffPane',
      'terminal-pane': 'dock/terminal/TerminalPane.tsx#TerminalPane',
      'preview-pane': 'dock/preview/PreviewPane.tsx#PreviewPane',
      'session-insight-chip': 'mind/SessionInsightChip.tsx#SessionInsightChip',
    });
  });

  it('resolves exactly the files that exist in this build — and nothing else', () => {
    for (const key of Object.keys(SLOT_MODULES)) {
      expect(SLOT_IDS.some((id) => `../${SLOTS[id].path}` === key), key).toBe(true);
    }
    for (const id of SLOT_IDS) {
      expect(isSlotAvailable(id), id).toBe(existsSync(resolve(VERSE, SLOTS[id].path)));
    }
  });

  it('renders nothing — no placeholder, no error — for a slot whose file has not landed', () => {
    const { container } = render(
      <>
        {isSlotAvailable('branch-bar') ? null : <BranchBarSlot sessionId="s-1" roots={['/r']} onOpenDiff={() => {}} />}
        {isSlotAvailable('session-insight-chip') ? null : <SessionInsightChipSlot sessionId="s-1" />}
        {isSlotAvailable('terminal-pane') ? null : <TerminalPaneSlot {...terminalProps} />}
      </>,
    );
    expect(container).toBeEmptyDOMElement();
  });
});

describe('slot rendering (injected module maps)', () => {
  it('renders a landed component with exactly the slot props', async () => {
    const TerminalPane = vi.fn((props: TerminalPaneProps) => <div data-testid="pane">terminal for {props.sessionId}</div>);
    render(<SlotForTest id="terminal-pane" props={terminalProps} modules={{ '../dock/terminal/TerminalPane.tsx': async () => ({ TerminalPane }) }} />);
    expect(await screen.findByTestId('pane')).toHaveTextContent('terminal for s-1');
    expect(TerminalPane.mock.calls[0]![0]).toEqual(terminalProps);
  });

  it('renders nothing when the module map has no entry', () => {
    const { container } = render(<SlotForTest id="terminal-pane" props={terminalProps} modules={{}} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('says a PANE failed (no path, no stack) when its file exports the wrong name, and retries the import', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    let attempts = 0;
    const importer = async () => {
      attempts += 1;
      return attempts === 1 ? { Terminal: () => null } : { TerminalPane: () => <div data-testid="pane">ok</div> };
    };
    render(<SlotForTest id="terminal-pane" props={terminalProps} modules={{ '../dock/terminal/TerminalPane.tsx': importer }} />);
    const notice = await screen.findByText('Terminal could not load');
    expect(notice.closest('[role="alert"]')).not.toBeNull();
    expect(document.body.textContent).not.toMatch(/TerminalPane\.tsx|dock\/terminal|at \w+ \(/);

    await act(async () => {
      await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    });
    expect(await screen.findByTestId('pane')).toHaveTextContent('ok');
    expect(attempts).toBe(2);
  });

  it('makes an INLINE slot vanish when it crashes, leaving its neighbours alone', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const Crashing = () => {
      throw new Error('boom');
    };
    render(
      <div>
        <span>header</span>
        <SlotForTest id="session-insight-chip" props={{ sessionId: 's-1' }} modules={{ '../mind/SessionInsightChip.tsx': async () => ({ SessionInsightChip: Crashing }) }} />
      </div>,
    );
    await waitFor(() => expect(console.error).toHaveBeenCalled());
    expect(screen.getByText('header')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
