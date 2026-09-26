/**
 * routes/verse/VerseApp.tsx — the Verse 3.10 workbench shell (unit C1;
 * SPEC-310C §1, SPEC-310B §6).
 *
 *   [rail] Command ⌘1 · Fleet ⌘2 · Growth ⌘3 · Mind ⌘4 · Chat ⌘5
 *          foot: Needs you (⌘J) · the scarcest seat's capacity ring · ⚙ tray
 *   [main] the current surface, with up to three recent surfaces (and Chat,
 *          once visited) kept MOUNTED behind it — hidden + inert
 *   [dock] the Resources drawer when PINNED (3.11 C6): a third grid track
 *          that shrinks [main]. Unpinned it floats over the surface, opened
 *          from the right-edge tab, the rail, ⌘. or ⌘K "Open Resources".
 *   overlays  ⌘K palette · ⌘J Needs-you drawer · ⌘/ shortcuts · the guard
 *
 * KEEP-ALIVE. Switching surfaces used to unmount the one you left: the
 * approvals selection, the autonomy scroll and the chat's streams were
 * rebuilt every time. Now a left surface stays mounted, `hidden` (no paint,
 * no layout) and `inert` (no focus, no clicks, out of the accessibility
 * tree), inside a SectionVisibilityProvider that tells its polls to stop
 * (C0's usePollWhileVisible). Coming back is instant and exactly where you
 * were. The list is bounded (verse-ui-store KEEP_ALIVE_SURFACES).
 *
 * KEYS come from C0's command catalog — the shell handles the GLOBAL ones
 * (surfaces, palette, drawer, shortcuts, history, recent chats, rail labels,
 * new chat, theme) through the command bus, so the palette, the native menu
 * and a key press all run the same handler. Chat and composer keys belong to
 * C2 / C3 and are never bound here. While the palette is open it owns every
 * key; while a dialog the shell did not open is up (a confirmation, the
 * token prompt, New chat), global keys stand down.
 *
 * SECTIONS resolve through `shell/section-modules.ts`'s glob, one lazy chunk
 * each; a surface whose module has not landed shows a designed "not in this
 * build" state (no source paths), and Fleet falls back to the legacy Autonomy
 * panels until C7 lands its own.
 *
 * NATIVE (C8). The desktop app's menu, tray, clicked notifications and the
 * system-wide hotkey arrive through app/desktop-shell.ts
 * `subscribeShellCommands` — the one web seam to the desktop app — already
 * parsed by the catalog: `open-needs-you`, `new-chat`, `focus-composer`,
 * `open-session:<id>` (and the 3.9 menu's two). Anchors ("go to that card")
 * arrive as VERSE_ANCHOR_EVENT and are revealed by shell/reveal-anchor.ts
 * (listened for by shell/anchor-requests.ts).
 */
import { Suspense, lazy, useEffect, useMemo, useRef, useState, type ComponentType } from 'react';
import { reportThemeToShell, subscribeShellCommands } from '../../app/desktop-shell.js';
import { RouteErrorBoundary } from '../../components/primitives/RouteErrorBoundary.js';
import { Tooltip } from '../../components/primitives/Tooltip.js';
import { useToast } from '../../components/primitives/Toast.js';
import { getMutationToken } from '../../data/auth-store.js';
import { queryGateStats } from '../../data/cache.js';
import { apiPost } from '../../data/client.js';
import { useTheme } from '../../data/hooks.js';
import { VERSE_ACTIVITY_SEEN_PATH, type VerseActivityCompletion } from '../../../core/verse/workbench-types.js';
import { useResourcesUi } from './resources/resources-store.js';
import { commandChord, detectKeyPlatform, formatChord, matchKey } from './shell/command-keys.js';
import { GuardHost } from './shell/guarded-action.js';
import type { RailBadge } from './shell/RailStatus.js';
import { subscribeAnchorRequests } from './shell/anchor-requests.js';
import { executeCatalogCommand, useShellCommands } from './shell/run-command.js';
import { SectionVisibilityProvider } from './shell/section-visibility.js';
import { SECTION_MODULES, sectionImporter } from './shell/section-modules.js';
import { SurfaceNotInBuild, SurfaceSkeleton } from './shell/skeletons.js';
import { onActivityCompletions, useActivity } from './shell/useActivity.js';
import { useViewport } from './shell/viewport.js';
import type { WarmupOptions } from './shell/warmup.js';
import { useVerseUi } from './useVerseUi.js';
// rail-icons, not verse-icons: only the rail's glyphs belong in first paint.
import { GearIcon, NeedsYouIcon, RAIL_ICON, VerseMark } from './rail-icons.js';
import {
  acknowledgeChatMoved,
  closeVerseOverlay,
  getVerseUiState,
  landedModule,
  openVerseSession,
  RAIL_SECTIONS,
  sectionEntry,
  setVerseSection,
  VERSE_ANCHOR_EVENT,
  VERSE_SECTIONS,
  type VerseSectionId,
} from './verse-ui-store.js';
import styles from './VerseApp.module.css';
import { usedPercentText } from './percent-text.js';

export { SECTION_MODULES };

/**
 * The designed state for a surface whose module has not landed. Exported so
 * it can be tested directly (which surfaces exist changes as owners land).
 */
export function MissingSection({ label, blurb }: { label: string; blurb?: string }) {
  return <SurfaceNotInBuild label={label} blurb={blurb ?? ''} />;
}

/**
 * Resolve one section to a lazy component: the primary module, else its
 * fallback, else the designed missing state. A module that throws while
 * loading is logged to the console (never printed to the operator: messages
 * can carry paths) and shown as missing, never as a torn-down shell.
 */
function sectionLoader(id: VerseSectionId): () => Promise<{ default: ComponentType }> {
  const entry = sectionEntry(id);
  return async () => {
    const module = landedModule(id);
    const importer = module ? sectionImporter(module) : undefined;
    if (!module || !importer) return { default: () => <MissingSection label={entry.label} blurb={entry.blurb} /> };
    try {
      const mod = (await importer()) as Record<string, unknown>;
      const exported = mod[module] ?? mod.default;
      if (typeof exported === 'function') return { default: exported as ComponentType };
      console.error(`[verse] ${module} exports no ${module} component`);
    } catch (err) {
      console.error(`[verse] ${entry.label} failed to load`, err);
    }
    return { default: () => <MissingSection label={entry.label} blurb={entry.blurb} /> };
  };
}

/** One load per section for the life of the tab — shared by its lazy component and the idle prefetch. */
const sectionLoads = new Map<VerseSectionId, Promise<{ default: ComponentType }>>();
/** Sections whose module has arrived, mounted directly (no Suspense round-trip, so no skeleton frame). */
const loadedSections = new Map<VerseSectionId, ComponentType>();

function loadSection(id: VerseSectionId): Promise<{ default: ComponentType }> {
  let load = sectionLoads.get(id);
  if (!load) {
    load = sectionLoader(id)().then((mod) => {
      loadedSections.set(id, mod.default);
      return mod;
    });
    sectionLoads.set(id, load);
  }
  return load;
}

/** One lazy component per section, for the life of the tab. */
const SECTION_COMPONENTS = new Map<VerseSectionId, ComponentType>(
  VERSE_SECTIONS.map((s) => [s.id, lazy(() => loadSection(s.id))] as const),
);

// ---------------------------------------------------------------------------
// Off the first-paint path (review 3.10 d1)
// ---------------------------------------------------------------------------
//
// WHY: every module this file imports statically is in the chunk a cold chat
// paint must download and parse before anything shows (SPEC-310A §1: chat
// critical JS ≤ 350 KB, SPEC-310C "xterm, the charts and the palette each load
// as separate lazy chunks"). The overlays render only while open, onboarding
// only on a first run, and the rail's badges and capacity ring only once the
// activity / capacity reads answer — none of them can draw anything at first
// paint, so none of them may cost first-paint bytes. Each is its own chunk,
// fetched after first paint (the overlays on idle, below) so ⌘K still opens
// without a visible wait.

const importPalette = () => import('./shell/CommandPalette.js');
const importDrawer = () => import('./shell/NeedsYouDrawer.js');
const importShortcuts = () => import('./shell/ShortcutsOverlay.js');
const importGearTray = () => import('./shell/GearTray.js');
// The first-run tour's store and its flow: the gate reads the one and loads the other.
const importOnboarding = () => import('./onboarding/OnboardingGate.js');
const importRailStatus = () => import('./shell/RailStatus.js');
const importWarmup = () => import('./shell/warmup.js');
// Resources (3.11 C6): the edge tab, rail button, ⌘. handler and the drawer
// (itself a further chunk) — see resources/ResourcesChrome.tsx for why.
const importResources = () => import('./resources/ResourcesChrome.js');

const CommandPalette = lazy(() => importPalette().then((m) => ({ default: m.CommandPalette })));
const NeedsYouDrawer = lazy(() => importDrawer().then((m) => ({ default: m.NeedsYouDrawer })));
const ShortcutsOverlay = lazy(() => importShortcuts().then((m) => ({ default: m.ShortcutsOverlay })));
const GearTray = lazy(() => importGearTray().then((m) => ({ default: m.GearTray })));
const OnboardingGate = lazy(() => importOnboarding().then((m) => ({ default: m.OnboardingGate })));
const ResourcesChrome = lazy(() => importResources().then((m) => ({ default: m.ResourcesChrome })));
const ResourcesRailButton = lazy(() => importResources().then((m) => ({ default: m.ResourcesRailButton })));
const ResourcesBar = lazy(() => importResources().then((m) => ({ default: m.ResourcesBar })));

/**
 * The after-first-paint warm-up (shell/warmup.ts): the overlay chunks, then
 * each rail surface not yet open — its chunk (the same load its lazy
 * component uses, so the first visit mounts it directly) and the reads it
 * opens with — one piece at a time, and only while the operator is idle: no
 * input for a quiet period and none of their reads in flight.
 *
 * The scheduler and the step list are a lazy chunk; this trigger is all the
 * warm-up costs chat first paint. Returns a cancel (called on unmount; safe
 * before the chunk has even arrived).
 */
export function prefetchAfterFirstPaint(options?: WarmupOptions): () => void {
  const readsInFlight = () => {
    const gate = queryGateStats();
    return gate.active + gate.queued > 0;
  };
  let live = true;
  let cancel: (() => void) | null = null;
  void importWarmup().then(
    (m) => {
      if (live) cancel = m.warmUpAfterFirstPaint({ loadSection, overlays: [importPalette, importDrawer, importShortcuts, () => importResources().then((r) => r.preloadResourcesDrawer())], readsInFlight }, options);
    },
    () => undefined,
  );
  return () => {
    live = false;
    cancel?.();
  };
}

type RailStatusModule = typeof import('./shell/RailStatus.js');
let railStatusModule: RailStatusModule | null = null;

/**
 * The rail badge / capacity module, loaded after first paint. RailStatus
 * pulls the usage contract and capacity-strip model (~30 KB) for the ring;
 * the badges it draws depend on the activity read, which is not back at first
 * paint either, so waiting for the module costs nothing visible. Null until
 * loaded — the rail then draws no badge, which RailStatus already defines as
 * "not known yet", never "zero".
 */
function useRailStatusModule(): RailStatusModule | null {
  const [mod, setMod] = useState<RailStatusModule | null>(railStatusModule);
  useEffect(() => {
    if (mod) return undefined;
    let alive = true;
    void importRailStatus().then(
      (m) => {
        railStatusModule = m;
        if (alive) setMod(m);
      },
      (err) => console.error('[verse] rail status failed to load', err),
    );
    return () => {
      alive = false;
    };
  }, [mod]);
  return mod;
}

/** A dialog the shell did not open (a confirmation, the token prompt, New chat) is up. */
function foreignModalOpen(): boolean {
  return [...document.querySelectorAll('[aria-modal="true"]')].some(
    (el) => !el.hasAttribute('data-verse-overlay') && !el.querySelector('[data-verse-overlay]'),
  );
}

const COMPLETION_TOAST_LIMIT = 3;

export function VerseApp() {
  const ui = useVerseUi();
  const theme = useTheme();
  const toast = useToast();
  const activity = useActivity();
  const { compact } = useViewport();
  const platform = useMemo(() => detectKeyPlatform(), []);
  const gearRef = useRef<HTMLButtonElement>(null);
  const [trayOpen, setTrayOpen] = useState(false);
  const data = activity.data;
  const rail = useRailStatusModule();
  const resources = useResourcesUi();

  useEffect(() => prefetchAfterFirstPaint(), []);
  // The gear tray is fetched right after mount (not on idle) and then stays
  // MOUNTED closed, exactly as before it was split out: its open effect
  // schedules the first item's focus on a frame, and mounting it only on the
  // click shifted that frame behind the operator's first arrow key.
  const [gearReady, setGearReady] = useState(false);
  useEffect(() => {
    let alive = true;
    void importGearTray().then(
      () => { if (alive) setGearReady(true); },
      (err) => console.error('[verse] settings tray failed to load', err),
    );
    return () => { alive = false; };
  }, []);

  // ── the global commands the shell serves, and run-command's toasts ─────
  useShellCommands();

  // ── global keys ─────────────────────────────────────────────────────────
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.defaultPrevented) return;
      if (getVerseUiState().overlay === 'palette') return;
      if (foreignModalOpen()) return;
      const command = matchKey(event, ['global']);
      if (!command) return;
      // preventDefault BEFORE running: the chat's key fallback and the
      // transcript's ⌥↑/⌥↓ skip default-prevented events (C2), which is what
      // keeps one press from running two handlers. stopPropagation is not
      // used — other listeners still see the event, they just know it is taken.
      event.preventDefault();
      executeCatalogCommand(command.id, { via: 'key' });
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  // ── the desktop shell: menu, tray, notifications, hotkey ────────────────
  useEffect(
    () =>
      subscribeShellCommands((command) => {
        if (command.kind === 'open-session') {
          closeVerseOverlay();
          openVerseSession(command.sessionId);
          return;
        }
        // The tray's "New chat" and the hotkey's "focus the composer" must
        // land in the composer: an open palette or shortcuts sheet would keep
        // focus (and every key) for itself. The drawer opener, the theme and
        // Settings leave overlays alone — open-needs-you REPLACES the overlay.
        if (command.name === 'new-chat' || command.name === 'focus-composer') closeVerseOverlay();
        executeCatalogCommand(command.commandId, { via: 'menu' });
      }),
    [],
  );
  // "Go to that card": whoever raises it (drawer, Command, Mind), the shell reveals it.
  useEffect(() => subscribeAnchorRequests(VERSE_ANCHOR_EVENT), []);
  // Report the PAINTED theme so the native window pre-paints its background
  // on the next cold launch instead of flashing white. No-op in a browser.
  useEffect(() => { reportThemeToShell(theme.theme); }, [theme.theme]);

  // ── one-time announcements ──────────────────────────────────────────────
  useEffect(() => {
    if (!ui.announceChatMoved) return;
    const chat = commandChord('surface.chat');
    toast.show(`Chat moved to ${chat ? formatChord(chat, platform) : '⌘5'} — Command, Fleet, Growth and Mind come first now.`);
    acknowledgeChatMoved();
  }, [ui.announceChatMoved, toast, platform]);

  // ── in-app "Finished / Failed" (the window is visible; C8 notifies when it is not) ─
  useEffect(
    () =>
      onActivityCompletions((batch: VerseActivityCompletion[]) => {
        if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
        const s = getVerseUiState();
        const news = batch.filter((c) => !(s.section === 'chat' && s.activeSessionId === c.sessionId));
        const failed = news.filter((c) => c.outcome === 'failed');
        for (const c of failed.slice(0, COMPLETION_TOAST_LIMIT)) toast.show(`Failed: ${c.title}`, 'danger');
        const done = news.filter((c) => c.outcome === 'ok');
        if (done.length > COMPLETION_TOAST_LIMIT) toast.show(`${done.length} chats finished.`, 'success');
        else for (const c of done) toast.show(`Finished: ${c.title}`, 'success');
      }),
    [toast],
  );

  // ── Mind's dot clears when Mind is opened ───────────────────────────────
  const [mindSeenLocal, setMindSeenLocal] = useState<string | null>(null);
  const latestMemoAt = data?.mind?.latestMemoAt ?? null;
  useEffect(() => {
    if (ui.section !== 'mind' || !data?.mind?.unseen || !latestMemoAt) return;
    setMindSeenLocal(latestMemoAt);
    // Best-effort on the server too (it needs a held token; reading Mind is
    // not worth a token prompt — the local mark already clears the dot).
    const token = getMutationToken();
    if (token) void apiPost<unknown>(VERSE_ACTIVITY_SEEN_PATH, { surface: 'mind' }, token).catch(() => undefined);
  }, [ui.section, data?.mind?.unseen, latestMemoAt]);

  const expanded = ui.railExpanded && !compact;
  const needsYouCount = data ? data.counts.needsYou : null;
  // Settings, Apps & Accounts and Usage open from the gear, so on those pages
  // the gear IS the current rail item — for assistive tech too (aria-current,
  // and the page's name, since one gear stands for three pages), not only
  // through the data-active styling.
  const currentPage = sectionEntry(ui.section);
  const gearPage = currentPage.placement === 'tray' ? currentPage : null;
  const BadgeMark = rail?.RailBadgeMark ?? null;
  const shortcut = (id: string) => {
    const chord = commandChord(id);
    return chord ? formatChord(chord, platform) : undefined;
  };

  return (
    <div
      className={styles.shell}
      data-rail={expanded ? 'expanded' : 'collapsed'}
      data-compact={compact || undefined}
      data-resources={resources.open && resources.pinned && !compact ? 'docked' : undefined}
    >
      <nav className={styles.rail} data-rail={expanded ? 'expanded' : 'collapsed'} aria-label="Verse sections">
        {/*
          Desktop shell: the window's top 48px is overlaid by the OS title bar
          and the traffic lights. The rail clears it in CSS; this strip makes
          the cleared space drag the window. 0px tall in a browser, where
          `--app-titlebar-height` is not set. See desktop/README.md.
        */}
        <span className={styles.railDragStrip} data-app-region="drag" aria-hidden="true" />
        <Tooltip label="Ashlr Verse" placement="right" disabled={expanded}>
          <span className={styles.mark}>
            <VerseMark />
            <span className="visually-hidden">Ashlr Verse</span>
          </span>
        </Tooltip>
        <ul className={styles.railList}>
          {RAIL_SECTIONS.map((entry) => {
            const IconComponent = RAIL_ICON[entry.id];
            // Mind's dot also clears on sight in THIS window, whether or not
            // the server-side mark could be written (it needs a held token).
            const mindSeenHere = entry.id === 'mind' && latestMemoAt !== null && mindSeenLocal === latestMemoAt;
            const badge: RailBadge | null = mindSeenHere || !rail ? null : rail.railBadgeFor(entry.id, data);
            const active = ui.section === entry.id;
            const keys = shortcut(`surface.${entry.id}`);
            return (
              <li key={entry.id}>
                {/* The name stays on the button; badges ride it so they are announced, not just drawn. */}
                <Tooltip label={entry.label} shortcut={keys} placement="right" disabled={expanded || compact}>
                  <button
                    type="button"
                    className={styles.railButton}
                    aria-current={active ? 'page' : undefined}
                    data-section={entry.id}
                    aria-label={`${entry.label}${badge?.spoken ?? ''}`}
                    onClick={() => setVerseSection(entry.id)}
                  >
                    <span className={styles.railIcon}>
                      {IconComponent ? <IconComponent /> : null}
                      {badge && BadgeMark ? <BadgeMark badge={badge} /> : null}
                    </span>
                    {expanded || compact ? <span className={styles.railLabel}>{entry.label}</span> : null}
                    {expanded && keys ? <span className={styles.railKey} aria-hidden="true">{keys}</span> : null}
                  </button>
                </Tooltip>
              </li>
            );
          })}
        </ul>
        <div className={styles.railFoot}>
          <Tooltip label="Needs you" shortcut={shortcut('needs-you.open')} placement="right" disabled={expanded || compact}>
            <button
              type="button"
              className={styles.railButton}
              aria-label={needsYouCount === null ? 'Needs you' : `Needs you, ${needsYouCount}`}
              aria-expanded={ui.overlay === 'needs-you'}
              data-needs-you={needsYouCount ?? undefined}
              onClick={() => executeCatalogCommand('needs-you.open', { via: 'button' })}
            >
              <span className={styles.railIcon}>
                <NeedsYouIcon />
                {needsYouCount && BadgeMark ? <BadgeMark badge={{ kind: 'count', count: needsYouCount, spoken: '', tone: 'warning' }} /> : null}
              </span>
              {expanded || compact ? <span className={styles.railLabel}>{compact ? 'Inbox' : 'Needs you'}</span> : null}
            </button>
          </Tooltip>
          {compact ? null : (
            <Suspense fallback={null}>
              <ResourcesRailButton expanded={expanded} buttonClass={styles.railButton} iconClass={styles.railIcon} labelClass={styles.railLabel} />
            </Suspense>
          )}
          {/* 3.11.1: the always-on resource bar (logos + batteries) replaces the
              single capacity ring while it is on; off brings the ring back. */}
          {compact ? null : resources.bar ? (
            <Suspense fallback={null}>
              <ResourcesBar expanded={expanded} />
            </Suspense>
          ) : rail ? <RailCapacityButton rail={rail} expanded={expanded} /> : null}
          <Tooltip label="Settings and more" placement="right" disabled={expanded || compact || trayOpen}>
            <button
              ref={gearRef}
              type="button"
              className={styles.railButton}
              aria-label={gearPage ? `Settings and more (${gearPage.label} open)` : 'Settings and more'}
              aria-haspopup="menu"
              aria-expanded={trayOpen}
              aria-current={gearPage ? 'page' : undefined}
              data-gear
              data-active={gearPage ? true : undefined}
              onClick={() => setTrayOpen((v) => !v)}
            >
              <span className={styles.railIcon}><GearIcon /></span>
              {expanded || compact ? <span className={styles.railLabel}>{compact ? 'More' : 'Settings'}</span> : null}
            </button>
          </Tooltip>
        </div>
      </nav>

      {/*
        The ONE <main id="main-content"> for the whole shell (SkipToContent
        focuses it). Every mounted surface lives inside it; only the current
        one is visible.
      */}
      <main className={styles.section} data-section={ui.section} id="main-content" tabIndex={-1}>
        {ui.mounted.map((id) => (
          <SurfaceHost key={id} id={id} active={id === ui.section} />
        ))}
      </main>

      {/* Lazy chunks (see "Off the first-paint path"); each mounts only while it can draw. */}
      <Suspense fallback={null}>
        {gearReady || trayOpen ? <GearTray open={trayOpen} anchorRef={gearRef} onClose={() => setTrayOpen(false)} compact={compact} /> : null}
      </Suspense>
      <Suspense fallback={null}>
        <ResourcesChrome compact={compact} />
      </Suspense>
      <Suspense fallback={null}>
        {ui.overlay === 'palette' ? <CommandPalette /> : null}
        {ui.overlay === 'needs-you' ? <NeedsYouDrawer /> : null}
        {ui.overlay === 'shortcuts' ? <ShortcutsOverlay /> : null}
      </Suspense>
      <GuardHost />
      {/*
        First run only, outside the surfaces: a docked card, not a modal, so
        the rail and the surface stay usable while it is open.
      */}
      <Suspense fallback={null}><OnboardingGate /></Suspense>
    </div>
  );
}

/**
 * The rail foot's capacity ring for the scarcest seat. Its own component so
 * `useRailCapacity` (a hook from the lazily loaded RailStatus module) is only
 * called once that module is here, always in the same place.
 */
function RailCapacityButton({ rail, expanded }: { rail: RailStatusModule; expanded: boolean }) {
  const capacity = rail.useRailCapacity();
  if (!capacity) return null;
  const { CapacityRing, describeRailCapacity } = rail;
  return (
    <Tooltip label={describeRailCapacity(capacity)} placement="right" disabled={expanded}>
      <button
        type="button"
        className={styles.railButton}
        aria-label={`Capacity — ${describeRailCapacity(capacity)}`}
        data-capacity={Math.round(capacity.usedPercent)}
        onClick={() => setVerseSection('apps', `seat:${capacity.seatId}`)}
      >
        <span className={styles.railIcon}>
          <CapacityRing badge={capacity} />
        </span>
        {expanded ? (
          <span className={styles.railLabel}>
            {capacity.label} {capacity.limitReached ? 'limit' : usedPercentText(capacity.usedPercent)}
          </span>
        ) : null}
      </button>
    </Tooltip>
  );
}

function SurfaceHost({ id, active }: { id: VerseSectionId; active: boolean }) {
  // A section the idle prefetch already loaded mounts directly: React.lazy
  // would still suspend once on its first render — even with the module in
  // hand — and commit the skeleton, the very flash the prefetch exists to
  // remove. Chosen ONCE per host, so a load that lands while this surface is
  // up never swaps the component type under it (that would remount the
  // surface and drop its state).
  const [Section] = useState<ComponentType>(() => loadedSections.get(id) ?? SECTION_COMPONENTS.get(id)!);
  const entry = sectionEntry(id);
  return (
    <div className={styles.surface} data-surface={id} hidden={!active} inert={!active}>
      <SectionVisibilityProvider visible={active}>
        <RouteErrorBoundary resetKey={id}>
          <Suspense fallback={<SurfaceSkeleton section={id} label={entry.label} />}>
            <Section />
          </Suspense>
        </RouteErrorBoundary>
      </SectionVisibilityProvider>
    </div>
  );
}
