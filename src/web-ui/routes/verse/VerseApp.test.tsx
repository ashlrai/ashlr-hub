/**
 * Shell tests: the rail in both of its widths, the lazily-mounted sections,
 * and the global shortcuts. The chat surface itself is covered in
 * sections/ChatSection.test.tsx — this file only asserts that the shell
 * mounts it and gets out of the way.
 */
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '../../components/primitives/Toast.js';
import { clearMutationToken, markCheckComplete } from '../../data/auth-store.js';
import { evictAll } from '../../data/cache.js';
import { MockEventSource, verseFetch } from './fixtures.test-support.js';
import { MissingSection, SECTION_MODULES, VerseApp } from './VerseApp.js';
import { resetVerseStore } from './verse-store.js';
import {
  resetVerseUi,
  setVersePendingApprovals,
  setVerseRailExpanded,
  VERSE_SECTIONS,
} from './verse-ui-store.js';

/** verseFetch's mock is typed loosely; this is the shape we actually delegate to. */
type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

function mount() {
  return render(<ToastProvider><VerseApp /></ToastProvider>);
}

/**
 * Resolve every lazily-imported section module BEFORE any test asserts that
 * one of them mounted.
 *
 * WHY THIS HOOK EXISTS — a real order dependence, not a convenience.
 *
 * The shell mounts sections through `React.lazy(sectionLoader(id))`, and
 * `sectionLoader` awaits the `import.meta.glob` importer. The first test to
 * mount the shell therefore pays, inside its own assertion window, the cost
 * of transforming and evaluating a whole section's module graph for the first
 * time in this worker — ChatSection plus everything it pulls in. Testing
 * Library's `findBy*` allows 1000ms for that, and a cold ChatSection does not
 * reliably fit: run this file on its own and the FIRST test times out waiting
 * for the Chats nav, while every test after it passes on the module the first
 * one just warmed.
 *
 * That made the file pass or fail depending on what ran before it. In a full
 * suite some earlier file had usually already imported the section modules,
 * so the race was won and nobody saw it; alone, or after a change to the file
 * order, it was lost. The failure looked like "Chat did not mount", which is
 * a real bug's signature — so the test was not just flaky, it was pointing at
 * the wrong thing.
 *
 * The fix is to establish the precondition the assertions depend on instead
 * of leaving it to whatever ran first. Awaiting the importers here resolves
 * them once, in a hook with its own generous budget, so every `React.lazy` in
 * every test below resolves from an already-evaluated module. The assertions
 * are untouched: the shell must still actually mount ChatSection and render
 * its nav, and if it does not, the test still fails.
 *
 * It walks `SECTION_MODULES` — the shell's own glob result, the same map the
 * registration test below walks — so it cannot warm a different set of
 * modules from the ones the shell will load.
 */
beforeAll(async () => {
  await Promise.all(Object.values(SECTION_MODULES).map((load) => load()));
  // An explicit budget rather than the default hook timeout: this hook does
  // module loading, whose cost depends on the machine and on how cold the
  // transform cache is, and inheriting a default is precisely how the race
  // above went unnoticed. 30s is far more than the ~2s it takes warm, and it
  // is a ceiling on setup — not on any assertion.
}, 30_000);

beforeEach(() => {
  window.history.replaceState(null, '', '/verse/');
  localStorage.clear();
  evictAll();
  resetVerseStore();
  resetVerseUi();
  clearMutationToken();
  MockEventSource.reset();
  vi.stubGlobal('EventSource', MockEventSource);
  vi.stubGlobal('fetch', verseFetch().fetch);
  markCheckComplete(true);
});
afterEach(() => {
  act(() => markCheckComplete(false));
  vi.unstubAllGlobals();
  window.history.replaceState(null, '', '/');
});

describe('VerseApp shell', () => {
  it('renders a rail button for every registered section and mounts Chat first', async () => {
    mount();
    const rail = screen.getByRole('navigation', { name: 'Verse sections' });
    // Driven off VERSE_SECTIONS, not a hard-coded five: a section added to the
    // list and given no rail button is the same bug as one with no module.
    for (const label of VERSE_SECTIONS.map((s) => s.label)) {
      expect(within(rail).getByRole('button', { name: label })).toBeInTheDocument();
    }
    expect(within(rail).getByRole('button', { name: 'Chat' })).toHaveAttribute('aria-current', 'page');
    // The Chat module exists, so it actually mounts (its own nav shows up).
    await screen.findByRole('navigation', { name: 'Chats' });
  });

  it('switches sections by click and by ⌘1–⌘5, mounting exactly one at a time', async () => {
    const user = userEvent.setup();
    const view = mount();
    await screen.findByRole('navigation', { name: 'Chats' });
    const slot = () => view.container.querySelector('[data-section]:not(button)')!;

    await user.click(screen.getByRole('button', { name: 'Autonomy' }));
    expect(screen.getByRole('button', { name: 'Autonomy' })).toHaveAttribute('aria-current', 'page');
    expect(slot()).toHaveAttribute('data-section', 'autonomy');
    // Chat is unmounted, not hidden — a section owns its own polling and streams.
    expect(screen.queryByRole('navigation', { name: 'Chats' })).not.toBeInTheDocument();

    act(() => { fireEvent.keyDown(document, { key: '4', metaKey: true }); });
    expect(screen.getByRole('button', { name: 'Usage' })).toHaveAttribute('aria-current', 'page');
    expect(slot()).toHaveAttribute('data-section', 'usage');

    act(() => { fireEvent.keyDown(document, { key: '1', metaKey: true }); });
    await screen.findByRole('navigation', { name: 'Chats' });
  });

  it('gives every section the one <main id="main-content"> the skip link targets', async () => {
    // Regression: the landmark used to live inside ChatSection, so SkipToContent
    // (which imperatively focuses #main-content) worked in Chat and silently did
    // nothing in the other four — a keyboard user was left on <body> with the
    // whole rail still ahead of them. The shell owns it now.
    const view = mount();
    await screen.findByRole('navigation', { name: 'Chats' });

    const sections: Array<[string, string]> = [
      ['1', 'chat'], ['2', 'autonomy'], ['3', 'approvals'], ['4', 'usage'], ['5', 'settings'],
    ];
    for (const [key, id] of sections) {
      act(() => { fireEvent.keyDown(document, { key, metaKey: true }); });
      const mains = view.container.querySelectorAll('main');
      expect(mains, `section ${id} should have exactly one <main>`).toHaveLength(1);
      const main = mains[0]!;
      expect(main).toHaveAttribute('id', 'main-content');
      expect(main).toHaveAttribute('data-section', id);
      // Focusable, or main?.focus() from SkipToContent is a no-op.
      expect(main.tabIndex).toBe(-1);
    }
  });

  it('resolves EVERY registered section through the shell’s own glob', async () => {
    // THE REGRESSION THIS PINS. A section is reachable only when it is BOTH in
    // VERSE_SECTIONS and at `sections/<module>.tsx`, where the shell's
    // `import.meta.glob` can see it. MCP satisfied neither for a whole release
    // — a complete component with its own queries, contract, tests and two
    // live server routes, invisible to the app, and nothing failed to say so.
    //
    // This walks SECTION_MODULES, the shell's actual glob result, so changing
    // the pattern in VerseApp.tsx is covered too — a test carrying its own
    // copy of the pattern would keep passing through exactly that change.
    //
    // Asserted here rather than by mounting each section and looking for
    // MissingSection: when a lazy child re-suspends, React keeps the PREVIOUS
    // section mounted (hidden) beside the fallback, so a DOM sweep reads stale
    // content and passes on nothing. The end-to-end proof that the shell
    // really mounts MCP is the next test, which fails if this breaks.
    for (const entry of VERSE_SECTIONS) {
      const key = `./sections/${entry.module}.tsx`;
      const importer = SECTION_MODULES[key];
      expect(
        importer,
        `VERSE_SECTIONS lists ${entry.id} as ${key}, which the shell's glob cannot see`,
      ).toBeTypeOf('function');

      // The shell takes `mod[entry.module] ?? mod.default`; a module that
      // loads but exports neither renders the missing state just the same.
      const mod = (await importer!()) as Record<string, unknown>;
      expect(
        typeof (mod[entry.module] ?? mod.default),
        `${key} must export a \`${entry.module}\` component`,
      ).toBe('function');
    }
  });

  it('reaches the MCP section by rail button and by ⌘6, with its real panel', async () => {
    // Positive proof, not just "not missing": the heading below is rendered by
    // sections/McpSection.tsx itself, so seeing it means the glob resolved the
    // real module rather than the designed placeholder.
    const user = userEvent.setup();
    mount();
    await screen.findByRole('navigation', { name: 'Chats' });

    const rail = screen.getByRole('navigation', { name: 'Verse sections' });
    await user.click(within(rail).getByRole('button', { name: 'MCP' }));
    expect(await screen.findByRole('heading', { name: 'MCP and CLI' })).toBeInTheDocument();
    expect(within(rail).getByRole('button', { name: 'MCP' })).toHaveAttribute('aria-current', 'page');

    act(() => { fireEvent.keyDown(document, { key: '1', metaKey: true }); });
    await screen.findByRole('navigation', { name: 'Chats' });
    act(() => { fireEvent.keyDown(document, { key: '6', metaKey: true }); });
    expect(await screen.findByRole('heading', { name: 'MCP and CLI' })).toBeInTheDocument();

    // ⌘5 still means Settings — the new section extended the scheme rather
    // than renumbering the five bindings people already have.
    act(() => { fireEvent.keyDown(document, { key: '5', metaKey: true }); });
    expect(within(rail).getByRole('button', { name: 'Settings' })).toHaveAttribute('aria-current', 'page');
  });

  it('explains a rail slot whose module has not landed instead of going blank', () => {
    // Rendered directly: which sections exist changes as the other owners land
    // theirs, so the state is tested on its own rather than through whichever
    // module happens to be missing today.
    render(<MissingSection label="Settings" moduleName="SettingsSection" detail="boom" />);
    expect(screen.getByRole('status')).toHaveTextContent('Settings is not wired up yet');
    expect(screen.getByText('routes/verse/sections/SettingsSection.tsx')).toBeInTheDocument();
    expect(screen.getByText('boom')).toBeInTheDocument();
  });

  it('⌘, opens Settings and the active section survives a remount (ashlr.verse.ui.v2)', async () => {
    const view = mount();
    await screen.findByRole('navigation', { name: 'Chats' });
    act(() => { fireEvent.keyDown(document, { key: ',', metaKey: true }); });
    expect(screen.getByRole('button', { name: 'Settings' })).toHaveAttribute('aria-current', 'page');
    expect(JSON.parse(localStorage.getItem('ashlr.verse.ui.v2') ?? '{}')).toMatchObject({ section: 'settings' });

    view.unmount();
    mount();
    expect(screen.getByRole('button', { name: 'Settings' })).toHaveAttribute('aria-current', 'page');
  });

  it('⌘N and ⌘K come back to Chat and reach the chat surface', async () => {
    mount();
    await screen.findByRole('navigation', { name: 'Chats' });
    act(() => { fireEvent.keyDown(document, { key: '5', metaKey: true }); });
    expect(screen.getByRole('button', { name: 'Settings' })).toHaveAttribute('aria-current', 'page');

    act(() => { fireEvent.keyDown(document, { key: 'n', metaKey: true }); });
    expect(await screen.findByRole('dialog', { name: 'New chat' })).toBeInTheDocument();

    act(() => { fireEvent.keyDown(document, { key: 'k', metaKey: true }); });
    expect(await screen.findByRole('dialog', { name: 'Switch chat' })).toBeInTheDocument();
  });

  it('publishes the pending-approval count from the shell, so the badge is right on any section', async () => {
    // The badge exists to be seen while you are NOT in Approvals, so the
    // count cannot come from ApprovalsSection's own mount. The shell reads
    // /api/inbox itself, through the same QueryDef the section uses.
    const base = verseFetch().fetch as unknown as FetchLike;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = typeof input === 'string' ? input : input.toString();
      if (path.startsWith('/api/inbox')) {
        return new Response(JSON.stringify({ pending: 4, items: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return base(input, init);
    }));

    mount();

    // Still on Chat — the badge is published anyway.
    const rail = screen.getByRole('navigation', { name: 'Verse sections' });
    expect(within(rail).getByRole('button', { name: 'Chat' })).toHaveAttribute('aria-current', 'page');
    const flagged = await screen.findByRole('button', { name: 'Approvals, 4 pending' });
    expect(flagged.querySelector('[data-pending="4"]')).not.toBeNull();
  });

  it('leaves the badge alone when the inbox read fails, rather than flashing a false all-clear', async () => {
    act(() => setVersePendingApprovals(2));
    const base = verseFetch().fetch as unknown as FetchLike;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = typeof input === 'string' ? input : input.toString();
      if (path.startsWith('/api/inbox')) return new Response('nope', { status: 500 });
      return base(input, init);
    }));

    mount();
    await screen.findByRole('navigation', { name: 'Chats' });

    // A failed count must not be reported as zero pending.
    expect(screen.getByRole('button', { name: 'Approvals, 2 pending' })).toBeInTheDocument();
  });

  it('shows a dot on Approvals only while a section reports pending items', async () => {
    mount();
    await screen.findByRole('navigation', { name: 'Chats' });
    expect(screen.getByRole('button', { name: 'Approvals' })).toBeInTheDocument();

    act(() => setVersePendingApprovals(3));
    const flagged = screen.getByRole('button', { name: 'Approvals, 3 pending' });
    expect(flagged.querySelector('[data-pending="3"]')).not.toBeNull();

    act(() => setVersePendingApprovals(0));
    expect(screen.getByRole('button', { name: 'Approvals' }).querySelector('[data-pending]')).toBeNull();
  });
});

describe('VerseApp rail', () => {
  // The rail's job is navigation, and it has two ways of doing it. Collapsed,
  // the name of each section lives in a tooltip; expanded, it is on screen.
  // Exactly one of those is true at a time — a visible label with a bubble
  // repeating it is noise, and an icon with neither is a guess.

  it('starts collapsed: icons, no labels, and a Tooltip carrying name + ⌘-digit', async () => {
    const user = userEvent.setup();
    mount();
    await screen.findByRole('navigation', { name: 'Chats' });
    const rail = screen.getByRole('navigation', { name: 'Verse sections' });
    const usage = within(rail).getByRole('button', { name: 'Usage' });

    // No visible label text — the glyph is the whole control.
    expect(usage).toHaveTextContent('');
    // And crucially NOT the native tooltip. `title=` is what rendered as an
    // unstyled grey box that overlapped the sidebar and got clipped.
    expect(usage).not.toHaveAttribute('title');
    expect(rail.querySelectorAll('[title]')).toHaveLength(0);

    await user.hover(usage);
    const tip = await screen.findByRole('tooltip');
    expect(tip).toHaveTextContent('Usage');
    expect(tip).toHaveTextContent('⌘4');
    expect(usage).toHaveAttribute('aria-describedby', tip.id);
    // Portalled out of the rail, which is the point: the rail is a flex column
    // in a grid shell, so a bubble rendered inside it is cut off at its edge.
    expect(rail).not.toContainElement(tip);
  });

  it('expanded, shows every section label and suppresses the now-redundant tooltips', async () => {
    const user = userEvent.setup();
    mount();
    await screen.findByRole('navigation', { name: 'Chats' });
    const rail = screen.getByRole('navigation', { name: 'Verse sections' });

    await user.click(within(rail).getByRole('button', { name: 'Expand rail' }));

    for (const entry of VERSE_SECTIONS) {
      const button = within(rail).getByRole('button', { name: entry.label });
      // The label is now ON the control, not in a bubble over it.
      expect(button).toHaveTextContent(entry.label);
    }

    await user.hover(within(rail).getByRole('button', { name: 'Usage' }));
    // Deliberately not `findByRole`: we are asserting nothing appears, and the
    // open delay has to be allowed to elapse before that means anything.
    await new Promise((resolve) => setTimeout(resolve, 350));
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('keeps the accessible name, aria-current and the pending dot across both widths', async () => {
    const user = userEvent.setup();
    mount();
    await screen.findByRole('navigation', { name: 'Chats' });
    const rail = () => screen.getByRole('navigation', { name: 'Verse sections' });

    act(() => setVersePendingApprovals(3));
    for (const state of ['collapsed', 'expanded'] as const) {
      if (state === 'expanded') {
        await user.click(within(rail()).getByRole('button', { name: 'Expand rail' }));
      }
      // The count rides the accessible NAME in both states, so it is announced
      // rather than being a dot only sighted users get.
      const approvals = within(rail()).getByRole('button', { name: 'Approvals, 3 pending' });
      expect(approvals.querySelector('[data-pending="3"]'), state).not.toBeNull();
      expect(within(rail()).getByRole('button', { name: 'Chat' }), state)
        .toHaveAttribute('aria-current', 'page');
    }
  });

  it('⌘1–⌘6 still switch sections while the rail is expanded', async () => {
    const user = userEvent.setup();
    const view = mount();
    await screen.findByRole('navigation', { name: 'Chats' });
    const rail = screen.getByRole('navigation', { name: 'Verse sections' });
    await user.click(within(rail).getByRole('button', { name: 'Expand rail' }));

    const slot = () => view.container.querySelector('[data-section]:not(button)')!;
    act(() => { fireEvent.keyDown(document, { key: '4', metaKey: true }); });
    expect(slot()).toHaveAttribute('data-section', 'usage');
    act(() => { fireEvent.keyDown(document, { key: '6', metaKey: true }); });
    expect(slot()).toHaveAttribute('data-section', 'mcp');
    act(() => { fireEvent.keyDown(document, { key: '1', metaKey: true }); });
    await screen.findByRole('navigation', { name: 'Chats' });
  });

  it('⌘\\ toggles the rail, and the choice survives a remount', async () => {
    const view = mount();
    await screen.findByRole('navigation', { name: 'Chats' });
    const rail = () => screen.getByRole('navigation', { name: 'Verse sections' });
    expect(within(rail()).getByRole('button', { name: 'Expand rail' }))
      .toHaveAttribute('aria-expanded', 'false');

    act(() => { fireEvent.keyDown(document, { key: '\\', metaKey: true }); });
    expect(within(rail()).getByRole('button', { name: 'Collapse rail' }))
      .toHaveAttribute('aria-expanded', 'true');
    // Same key, same storage path as every other layout preference.
    expect(JSON.parse(localStorage.getItem('ashlr.verse.ui.v2') ?? '{}'))
      .toMatchObject({ railExpanded: true });

    view.unmount();
    mount();
    expect(within(rail()).getByRole('button', { name: 'Collapse rail' })).toBeInTheDocument();
    expect(within(rail()).getByRole('button', { name: 'Chat' })).toHaveTextContent('Chat');
  });

  it('keeps the desktop drag strip and the traffic-light clearance in BOTH widths', async () => {
    // THE REGRESSION THIS PINS. `--app-titlebar-height` is 0px in a browser and
    // 48px in the Tauri window, where the OS paints the traffic lights over the
    // rail's top-left corner. The rail clears that strip in CSS and this span
    // makes the cleared space drag the window. The user has already been bitten
    // once by traffic lights sitting on top of the UI; a rail that grows a
    // second layout must not drop either half of the contract.
    // See desktop/README.md → "Desktop shell contract".
    const view = mount();
    await screen.findByRole('navigation', { name: 'Chats' });

    for (const state of ['collapsed', 'expanded'] as const) {
      act(() => setVerseRailExpanded(state === 'expanded'));
      const rail = screen.getByRole('navigation', { name: 'Verse sections' });
      expect(rail, state).toHaveAttribute('data-rail', state);

      const strip = rail.querySelector('[data-app-region="drag"]');
      expect(strip, `${state}: the rail must keep its drag region`).not.toBeNull();
      // It must be the rail's OWN first child, above every control, or it stops
      // covering the corner the traffic lights are painted over.
      expect(rail.firstElementChild, state).toBe(strip);
      expect(strip, state).toHaveAttribute('aria-hidden', 'true');

      // The shell carries the state as a data attribute because the expanded
      // width is applied by re-declaring --rail-width on it — the same token
      // five other stylesheets subtract from --app-traffic-light-inset.
      expect(view.container.querySelector('[data-rail]'), state)
        .toHaveAttribute('data-rail', state);
    }
  });
});
