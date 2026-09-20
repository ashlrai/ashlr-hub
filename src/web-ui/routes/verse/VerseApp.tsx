/**
 * routes/verse/VerseApp.tsx — the Verse shell (VERSE-CONTRACT-V2 "Shell
 * contract"): a 56px icon rail down the left, and exactly one of the five
 * section modules lazily mounted beside it.
 *
 *   Chat · Autonomy · Approvals · Usage · Settings
 *   ⌘1–⌘5 switch · ⌘K quick switcher · ⌘N new chat · ⌘, Settings
 *
 * Each section module exports a named component taking NO props and owns
 * its own data; the shell knows nothing about chat, caps or inboxes. That
 * is why the two chat shortcuts the rail owns (⌘N, ⌘K) are raised as
 * one-shot commands through verse-ui-store instead of being passed down.
 *
 * Section modules are resolved through `import.meta.glob` rather than a
 * static `import()` per section, for one deliberate reason: the four
 * non-chat modules are written by other owners and land at different times.
 * A glob yields real per-section code splitting when a module is present
 * and a designed "not built yet" state when it is not, instead of a build
 * that cannot compile until every owner has finished.
 */
import { Suspense, lazy, useEffect, useMemo, type ComponentType } from 'react';
import { RouteErrorBoundary } from '../../components/primitives/RouteErrorBoundary.js';
import { reportThemeToShell, subscribeDesktopCommands } from '../../app/desktop-shell.js';
import { useQuery, useTheme } from '../../data/hooks.js';
import { inboxListQuery } from '../../data/queries.js';
import { SECTION_ICON, VerseMark } from './verse-icons.js';
import { OnboardingFlow } from './onboarding/OnboardingFlow.js';
import { useVerseUi } from './useVerseUi.js';
import {
  requestVerseCommand,
  setVerseSection,
  setVersePendingApprovals,
  VERSE_SECTIONS,
  type VerseSectionId,
} from './verse-ui-store.js';
import styles from './VerseApp.module.css';

/**
 * Every `sections/*Section.tsx` that exists at build time, lazily. Vite
 * resolves this at build time (one chunk per match, `{}` when there are no
 * matches), so a module that has not been written yet is a missing key, not
 * an unresolved import.
 */
const SECTION_MODULES = import.meta.glob('./sections/*Section.tsx');

/**
 * The designed state for a rail slot whose module has not landed (or failed
 * to load). Exported so it can be tested directly: which sections exist
 * changes as the other owners land theirs, and a test that depends on one
 * being absent would rot the day it arrives.
 */
export function MissingSection({ label, moduleName, detail }: { label: string; moduleName: string; detail?: string }) {
  return (
    <div className={styles.missing} role="status">
      <h1 className={styles.missingTitle}>{label} is not wired up yet</h1>
      <p className={styles.missingBody}>
        This build has no <code>routes/verse/sections/{moduleName}.tsx</code>. The rail keeps the slot so the
        section appears the moment that module lands — nothing here is broken, and the other sections still work.
      </p>
      {detail ? <p className={styles.missingDetail}>{detail}</p> : null}
    </div>
  );
}

/**
 * Resolve one rail section to a lazy component. A module that is absent, or
 * that throws while loading, resolves to the honest missing state rather
 * than tearing down the shell.
 */
function sectionLoader(id: VerseSectionId): () => Promise<{ default: ComponentType }> {
  const entry = VERSE_SECTIONS.find((s) => s.id === id)!;
  const importer = SECTION_MODULES[`./sections/${entry.module}.tsx`];
  return async () => {
    if (!importer) return { default: () => <MissingSection label={entry.label} moduleName={entry.module} /> };
    try {
      const mod = (await importer()) as Record<string, unknown>;
      const exported = mod[entry.module] ?? mod.default;
      if (typeof exported !== 'function') {
        return {
          default: () => (
            <MissingSection label={entry.label} moduleName={entry.module}
              detail={`The module loaded but exports no \`${entry.module}\` component.`} />
          ),
        };
      }
      return { default: exported as ComponentType };
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      return { default: () => <MissingSection label={entry.label} moduleName={entry.module} detail={detail} /> };
    }
  };
}

/** One lazy component per section, created once for the life of the tab. */
const SECTION_COMPONENTS = new Map<VerseSectionId, ComponentType>(
  VERSE_SECTIONS.map((s) => [s.id, lazy(sectionLoader(s.id))] as const),
);

/**
 * The rail's Approvals badge has to be right whichever section is mounted —
 * that is the whole point of a badge — so the count is published from the
 * SHELL, not from ApprovalsSection. It rides the exact QueryDef the section
 * itself uses, so the two share one cache entry and one request rather than
 * each fetching the inbox.
 */
const PENDING_APPROVALS_QUERY = inboxListQuery({ status: 'pending', limit: 500 });

export function VerseApp() {
  const ui = useVerseUi();
  const theme = useTheme();
  const Section = SECTION_COMPONENTS.get(ui.section)!;

  const pendingApprovals = useQuery(PENDING_APPROVALS_QUERY);
  const pendingCount = pendingApprovals.data?.pending;
  useEffect(() => {
    // Only publish an observed number. While the read is in flight or has
    // failed the badge stays as it was rather than flashing to zero, which
    // would read as "nothing is waiting for you" — a false all-clear.
    if (typeof pendingCount === 'number') setVersePendingApprovals(pendingCount);
  }, [pendingCount]);

  // ⌘1–⌘5 sections · ⌘K quick switcher · ⌘N new chat · ⌘, Settings.
  // Held at the document so they work wherever focus is, except inside a
  // dialog's own text field where the browser's own editing shortcuts win.
  useEffect(() => {
    function onKey(event: globalThis.KeyboardEvent) {
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return;
      const index = Number.parseInt(event.key, 10);
      if (Number.isInteger(index) && index >= 1 && index <= VERSE_SECTIONS.length) {
        event.preventDefault();
        setVerseSection(VERSE_SECTIONS[index - 1]!.id);
        return;
      }
      switch (event.key.toLowerCase()) {
        case 'k':
          event.preventDefault();
          requestVerseCommand('quick-switcher');
          break;
        case 'n':
          event.preventDefault();
          requestVerseCommand('new-chat');
          break;
        case ',':
          event.preventDefault();
          setVerseSection('settings');
          break;
        default:
          break;
      }
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  // Desktop shell: the native menu bar owns ⌘, and ⇧⌘L and forwards them as a
  // window event rather than IPC, so this is inert in a browser. ⌘, is also
  // bound above for the browser; the native menu swallows it in the app, which
  // is why the menu has to hand it back.
  useEffect(() => subscribeDesktopCommands((command) => {
    if (command === 'open-settings') setVerseSection('settings');
    else if (command === 'toggle-theme') theme.cycle();
  }), [theme]);

  // Report the PAINTED theme so the native window can pre-paint its background
  // on the next cold launch instead of flashing white. No-op in a browser.
  useEffect(() => { reportThemeToShell(theme.theme); }, [theme.theme]);

  const themeTitle = useMemo(() => `Theme: ${theme.theme} — click to cycle`, [theme.theme]);

  return (
    <div className={styles.shell}>
      <nav className={styles.rail} aria-label="Verse sections">
        {/*
          Desktop shell: the window's top 48px is overlaid by the OS title bar
          and the traffic lights. The rail clears it in CSS; this strip makes
          the cleared space drag the window. It is 0px tall in a browser, where
          `--app-titlebar-height` is not set, so it is inert there.
          See desktop/README.md → "Desktop shell contract".
        */}
        <span className={styles.railDragStrip} data-app-region="drag" aria-hidden="true" />
        <span className={styles.mark} title="Ashlr Verse">
          <VerseMark />
          <span className="visually-hidden">Ashlr Verse</span>
        </span>
        <ul className={styles.railList}>
          {VERSE_SECTIONS.map((entry, index) => {
            const IconComponent = SECTION_ICON[entry.id];
            const pending = entry.id === 'approvals' ? ui.pendingApprovals : 0;
            const active = ui.section === entry.id;
            return (
              <li key={entry.id}>
                <button type="button" className={styles.railButton} aria-current={active ? 'page' : undefined}
                  data-section={entry.id} title={`${entry.label} (⌘${index + 1})`}
                  aria-label={pending > 0 ? `${entry.label}, ${pending} pending` : entry.label}
                  onClick={() => setVerseSection(entry.id)}>
                  <IconComponent />
                  {pending > 0 ? <span className={styles.railDot} data-pending={pending} aria-hidden="true" /> : null}
                </button>
              </li>
            );
          })}
        </ul>
        <div className={styles.railFoot}>
          <button type="button" className={styles.railButton} onClick={theme.cycle} title={themeTitle}
            aria-label={themeTitle} data-theme-toggle={theme.theme}>
            <ThemeGlyph preference={theme.theme} />
          </button>
        </div>
      </nav>
      <div className={styles.section} data-section={ui.section}>
        <RouteErrorBoundary resetKey={ui.section}>
          <Suspense fallback={<SectionFallback />}>
            <Section />
          </Suspense>
        </RouteErrorBoundary>
      </div>
      {/*
        First run only, and OUTSIDE the error boundary's subtree on purpose:
        it is a docked card, not a modal — no backdrop, no focus trap — so the
        rail and the mounted section stay fully usable while it is open, and a
        section that throws does not take the guidance down with it. It renders
        nothing at all once the operator has skipped or finished it
        (onboarding/onboarding-store.ts).
      */}
      <OnboardingFlow />
    </div>
  );
}

/**
 * Theme is a three-state preference, so the glyph says which — a half-moon
 * for the two explicit choices and a ring for "follow the system" (never
 * color alone, DESIGN §6).
 */
function ThemeGlyph({ preference }: { preference: string }) {
  return (
    <svg viewBox="0 0 16 16" width={16} height={16} fill="none" stroke="currentColor" strokeWidth={1.4}
      strokeLinejoin="round" strokeLinecap="round" aria-hidden="true" focusable="false">
      <circle cx="8" cy="8" r="4.2" />
      {preference === 'dark' ? <path d="M8 3.8a4.2 4.2 0 0 0 0 8.4Z" fill="currentColor" stroke="none" /> : null}
      {preference === 'light' ? <path d="M8 1.6v1M8 13.4v1M14.4 8h-1M2.6 8h-1M12.5 3.5l-.7.7M4.2 11.8l-.7.7M12.5 12.5l-.7-.7M4.2 4.2l-.7-.7" /> : null}
    </svg>
  );
}

function SectionFallback() {
  return <div className={styles.loading} role="status" aria-live="polite">Loading…</div>;
}
