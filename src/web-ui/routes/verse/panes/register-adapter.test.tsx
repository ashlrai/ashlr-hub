/**
 * panes/register-adapter.test.tsx — a unit's self-describing `register.ts`
 * (the Browser unit's BROWSER_PANE shape) becomes a registered pane that
 * replaces the first-party stub and keeps its key, order and toggle.
 */
import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getPane, isUnitPaneRegistration, listPanes, registerBuiltinPanes, registerUnitPanes, resetPaneRegistry, type PaneProps } from './index.js';

function FakeBrowser({ sessionId, visible }: { sessionId: string | null; visible?: boolean }) {
  return <p data-testid="browser">browsing for {sessionId ?? 'no chat'} ({visible ? 'visible' : 'hidden'})</p>;
}

/** Exactly the shape routes/verse/browser/register.ts exports (PR #546). */
const BROWSER_MODULE = {
  BROWSER_PANE: {
    id: 'browser',
    label: 'Browser',
    commandId: 'pane.browser',
    keywords: ['browser', 'web'],
    defaultSlot: 'dock',
    chatScoped: true,
    load: () => Promise.resolve({ default: FakeBrowser }),
  },
  // Anything else in the file is ignored.
  SOMETHING_ELSE: { id: 'x' },
};

beforeEach(() => { resetPaneRegistry(); registerBuiltinPanes(); });
afterEach(() => { resetPaneRegistry(); registerBuiltinPanes(); });

describe('registerUnitPanes', () => {
  it('replaces the first-party stub, keeping its key, place and header toggle', async () => {
    const stub = getPane('browser')!;
    expect(registerUnitPanes({ '../browser/register.ts': BROWSER_MODULE })).toEqual(['browser']);
    const pane = getPane('browser')!;
    expect(pane.component).not.toBe(stub.component);
    expect(pane).toMatchObject({ title: 'Browser', command: 'dock.preview', toggle: true, order: stub.order, icon: stub.icon, needsSession: false });
    expect(listPanes().filter((p) => p.id === 'browser')).toHaveLength(1);

    const Body = pane.component;
    const props = { sessionId: 's-1', visible: true } as PaneProps;
    render(<Body {...props} />);
    expect(await screen.findByTestId('browser')).toHaveTextContent('browsing for s-1 (visible)');
  });

  it('maps a unit\'s other name for a first-party pane, and adds new ones with a generic glyph', () => {
    const ids = registerUnitPanes({
      '../changes/register.ts': { CHANGES_PANE: { id: 'changes', label: 'Changes', load: () => Promise.resolve({ default: () => null }) } },
      '../checkpoints/register.ts': { CHECKPOINTS_PANE: { id: 'checkpoints', label: 'Checkpoints', load: () => Promise.resolve({ default: () => null }) } },
    });
    expect(ids.sort()).toEqual(['checkpoints', 'diff']);
    expect(getPane('diff')!.command).toBe('dock.diff');
    expect(getPane('checkpoints')).toMatchObject({ title: 'Checkpoints', command: null, order: 100 });
  });

  it('recognises only the registration shape', () => {
    expect(isUnitPaneRegistration(BROWSER_MODULE.BROWSER_PANE)).toBe(true);
    for (const junk of [null, 'browser', { id: 'Bad Id', label: 'x', load: () => null }, { id: 'ok', label: ' ', load: () => null }, { id: 'ok', label: 'Ok' }]) {
      expect(isUnitPaneRegistration(junk)).toBe(false);
    }
    act(() => { registerUnitPanes({ 'a': null, 'b': 'text', 'c': { nothing: 1 } }); });
    expect(listPanes()).toHaveLength(8);
  });
});
