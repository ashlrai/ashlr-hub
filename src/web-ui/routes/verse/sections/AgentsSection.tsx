/** Both agent surfaces remain inside the existing lazy Agents section. */
import { lazy, Suspense, useState } from 'react';
import { Segmented } from '../../../components/primitives/Segmented.js';
import { AgentsBoard } from '../agents/AgentsBoard.js';
import styles from '../agents/Agents.module.css';
const ProactiveAgents = lazy(() => import('../proactive/ProactiveAgents.js').then(module => ({ default: module.ProactiveAgents })));
type AgentsView = 'coding' | 'proactive';
const VIEWS = [{ value: 'coding' as const, label: 'Coding agents' }, { value: 'proactive' as const, label: 'Proactive agents' }];
export function AgentsSection() {
  const [view, setView] = useState<AgentsView>('coding');
  return <div className={styles.surface}>
    <div className={styles.views} data-verse-anchor="proactive-agents" tabIndex={-1} aria-label="Agent views"
      onFocus={event => {
        // The existing shell reveals anchors by focusing them after a lazy surface mounts.
        // Only that direct focus selects the requested view; radio focus retains its choice.
        if (event.target !== event.currentTarget) return;
        const target = event.currentTarget;
        setView('proactive');
        requestAnimationFrame(() => target.querySelector<HTMLButtonElement>('[data-value="proactive"]')?.focus());
      }}>
      <Segmented<AgentsView> size="sm" aria-label="Agent views" options={VIEWS} value={view} onChange={setView} />
    </div>
    <div className={styles.viewBody}>{view === 'coding' ? <AgentsBoard /> : <Suspense fallback={<p role="status" aria-busy="true">Loading proactive agents…</p>}><ProactiveAgents /></Suspense>}</div>
  </div>;
}
