/**
 * components/layout/Sidebar.tsx — grouped, hierarchical nav (foundation
 * brief item 3), reading NAV_GROUPS from app/nav-config.ts so it can never
 * drift from what the command palette offers.
 */
import { NavLink } from 'react-router-dom';
import { NAV_GROUPS } from '../../app/nav-config.js';
import styles from './Sidebar.module.css';

export function Sidebar() {
  return (
    <nav className={styles.sidebar} aria-label="Primary">
      <div className={styles.brand}>
        <span className={styles.brandMark} aria-hidden="true">
          ▲
        </span>
        <span className={styles.brandName}>ashlr</span>
      </div>
      {NAV_GROUPS.map((group) => (
        <div key={group.id} className={styles.group}>
          <h2 className={styles.groupLabel}>{group.label}</h2>
          <ul className={styles.leaves}>
            {group.leaves.map((leaf) => (
              <li key={leaf.path}>
                <NavLink
                  to={leaf.path}
                  className={({ isActive }) => `${styles.link} ${isActive ? styles.active : ''}`}
                >
                  {leaf.label}
                  {!leaf.implemented ? <span className={styles.soon}>soon</span> : null}
                </NavLink>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </nav>
  );
}
