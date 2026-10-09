import { lazy, Suspense, useState } from 'react';
import { Button } from '../../../components/primitives/Button.js';
const TaskContext = lazy(() => import('./TaskContext.js').then(module => ({ default: module.TaskContext })));
/** The endpoint is read only when the person asks for this admitted task's context. */
export function TaskContextToggle({ outcomeId, taskId, title }: { outcomeId: string; taskId: string; title: string }) {
  const [open, setOpen] = useState(false);
  return <div>
    <Button size="sm" variant="ghost" aria-expanded={open} onClick={() => setOpen(value => !value)}>{open ? 'Hide task context' : 'View task context'}</Button>
    {open ? <Suspense fallback={<p role="status" aria-busy="true">Loading task context…</p>}><TaskContext outcomeId={outcomeId} taskId={taskId} title={title} /></Suspense> : null}
  </div>;
}
