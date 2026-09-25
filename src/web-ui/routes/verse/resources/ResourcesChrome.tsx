/**
 * routes/verse/resources/ResourcesChrome.tsx — everything the Resources
 * drawer puts on every surface, as ONE chunk fetched right after first paint
 * (unit 3.11 C6):
 *
 *   ResourcesChrome      the edge tab on the right, the summary behind its
 *                        dot, the ⌘. / palette command, and the drawer itself
 *                        (overlay, or the docked column when pinned);
 *   ResourcesRailButton  the rail-foot button with the same dot.
 *
 * WHY A CHUNK. Chat first paint has ~3 KB of budget left (SPEC-310A §1;
 * `npm run check:first-paint`), and nothing here can draw anything useful
 * before the seat reads answer anyway. The shell keeps only the tiny store
 * static — it must know at first paint whether a pinned column takes a grid
 * track, so the surface never jumps — and mounts this module's two
 * components lazily, like the rail's capacity ring. The drawer body is a
 * further chunk still, mounted only while open (so it polls only while open)
 * and warmed on idle / on hover.
 */
import { Suspense, lazy, useEffect } from 'react';
import { Tooltip } from '../../../components/primitives/Tooltip.js';
import { findCommand, formatChord } from '../shell/command-catalog.js';
import { registerCommandHandler } from '../shell/command-bus.js';
import { executeCatalogCommand } from '../shell/run-command.js';
import { useVerseUi } from '../useVerseUi.js';
import { closeVerseOverlay } from '../verse-ui-store.js';
import { ResourcesDot, ResourcesHandle, ResourcesIcon, resourcesLabel } from './ResourcesHandle.js';
import { closeResources, getResourcesUi, openResources, useResourcesUi } from './resources-store.js';
import { ResourcesSummaryProbe } from './resources-summary.js';
import styles from './ResourcesChrome.module.css';

const importDrawer = () => import('./ResourcesDrawer.js');
const ResourcesDrawer = lazy(() => importDrawer().then((m) => ({ default: m.ResourcesDrawer })));

/** Fetch the drawer's chunk ahead of the first open (the shell's idle warm-up, a hover). */
export function preloadResourcesDrawer(): Promise<unknown> {
  return importDrawer();
}

const warm = () => {
  void importDrawer().catch(() => undefined);
};

/** The key and the buttons toggle; the palette ("Show resources") and the desktop menu open. */
export function runResourcesCommand(via: string | undefined): void {
  if (getResourcesUi().open && (via === 'key' || via === 'button')) {
    closeResources();
    return;
  }
  // One overlay at a time: the drawer replaces ⌘K / ⌘J / ⌘/.
  closeVerseOverlay();
  openResources();
}

function shortcutText(): string | undefined {
  const chord = findCommand('resources.toggle')?.keys[0];
  return chord ? formatChord(chord) : undefined;
}

/** Pinned docks beside the surface; a phone-width window has no room, so it floats there. */
export function resourcesDocked(state: { open: boolean; pinned: boolean }, compact: boolean): boolean {
  return state.open && state.pinned && !compact;
}

export function ResourcesChrome({ compact }: { compact: boolean }) {
  const resources = useResourcesUi();
  const { overlay } = useVerseUi();
  const docked = resourcesDocked(resources, compact);

  useEffect(() => registerCommandHandler('resources.toggle', (inv) => runResourcesCommand(inv.via)), []);
  // Another overlay (⌘K, ⌘J, ⌘/) replaces a FLOATING drawer; a pinned one stays docked.
  useEffect(() => {
    if (overlay !== null && !resourcesDocked(getResourcesUi(), compact)) closeResources();
  }, [overlay, compact]);

  return (
    <>
      <ResourcesSummaryProbe />
      {docked ? (
        <div className={styles.dock} data-resources-dock>
          <Suspense fallback={null}>
            <ResourcesDrawer mode="docked" />
          </Suspense>
        </div>
      ) : null}
      {resources.open && !docked ? (
        <Suspense fallback={null}>
          <ResourcesDrawer mode="overlay" compact={compact} />
        </Suspense>
      ) : null}
      {resources.open ? null : (
        <ResourcesHandle summary={resources.summary} shortcut={shortcutText()} onWarm={warm} onOpen={() => executeCatalogCommand('resources.toggle', { via: 'button' })} />
      )}
    </>
  );
}

/**
 * The rail-foot button. The shell passes its own rail classes so the button
 * is indistinguishable from its neighbours (no tooltip while the rail's
 * labelled mode already shows the name).
 */
export function ResourcesRailButton({ expanded, buttonClass, iconClass, labelClass }: {
  expanded: boolean;
  buttonClass: string | undefined;
  iconClass: string | undefined;
  labelClass: string | undefined;
}) {
  const resources = useResourcesUi();
  const label = resourcesLabel(resources.summary);
  return (
    <Tooltip label={label} shortcut={shortcutText()} placement="right" disabled={expanded}>
      <button
        type="button"
        className={buttonClass}
        aria-label={label}
        aria-expanded={resources.open}
        data-resources-rail
        onPointerEnter={warm}
        onClick={() => executeCatalogCommand('resources.toggle', { via: 'button' })}
      >
        <span className={iconClass}>
          <ResourcesIcon />
          <ResourcesDot summary={resources.summary} rail />
        </span>
        {expanded ? <span className={labelClass}>Resources</span> : null}
      </button>
    </Tooltip>
  );
}
