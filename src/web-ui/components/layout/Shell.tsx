/**
 * components/layout/Shell.tsx — the app frame: sidebar + topbar + a single
 * real scroll container (`<main>`) that useScrollRestore attaches to. Every
 * routed view renders inside this <main>; none of them own their own
 * scroll container, so scroll/focus/details state survives navigation
 * consistently everywhere instead of each view reimplementing it.
 */
import { useRef, useState } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { Sidebar } from './Sidebar.js';
import { Topbar } from './Topbar.js';
import { CommandPalette, useCommandPaletteShortcut } from '../command-palette/CommandPalette.js';
import { useScrollRestore } from '../../hooks/useScrollRestore.js';
import styles from './Shell.module.css';

export function Shell() {
  const mainRef = useRef<HTMLElement>(null);
  const location = useLocation();
  const [paletteOpen, setPaletteOpen] = useState(false);

  useScrollRestore(location.pathname, mainRef);
  useCommandPaletteShortcut(setPaletteOpen);

  return (
    <div className={styles.shell}>
      <Sidebar />
      <div className={styles.body}>
        <Topbar onOpenPalette={() => setPaletteOpen(true)} />
        <main ref={mainRef} className={styles.main} id="main-content" tabIndex={-1}>
          <Outlet />
        </main>
      </div>
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
    </div>
  );
}
