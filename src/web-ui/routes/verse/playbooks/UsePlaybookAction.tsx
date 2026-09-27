/**
 * routes/verse/playbooks/UsePlaybookAction.tsx — "Use playbook…" in the
 * composer's ⋯ sheet, above "Run in cloud" / "Run in Devin" (3.15; lazy-
 * loaded by composer/ControlsSheet.tsx, never on the chat first-paint path).
 *
 * Choosing one writes its `!macro` at the front of the message (replacing a
 * macro already there). Nothing runs: the lane buttons below — or sending to
 * the chat — carry the macro, and that lane resolves the playbook. A build
 * with no playbooks route renders nothing.
 */
import { useState } from 'react';
import { useQuery } from '../../../data/hooks.js';
import { putMacroInComposerNow } from './playbook-composer.js';
import { playbooksQuery } from './playbooks-queries.js';
import styles from './Playbooks.module.css';

export function UsePlaybookAction({ root }: { root?: ParentNode } = {}) {
  const read = useQuery(playbooksQuery, { freshMs: 60_000 });
  const [chosen, setChosen] = useState('');
  const [note, setNote] = useState<string | null>(null);
  const rows = read.data?.value ?? null;
  if (read.data && !rows) return null;

  const use = (macro: string) => {
    setChosen(macro);
    if (!macro) return;
    setNote(putMacroInComposerNow(macro, root)
      ? `${macro} is at the start of your message. Describe the task, then run it where you want.`
      : 'Open a chat first — the playbook goes into its message.');
  };

  return (
    <div className={styles.sheetAction} data-lane="playbook">
      <label className={styles.visuallyHidden} htmlFor="verse-use-playbook">Use playbook</label>
      <select id="verse-use-playbook" aria-label="Use playbook" value={chosen} disabled={!rows} onChange={(e) => use(e.target.value)}>
        <option value="">{rows ? 'Use playbook…' : 'Loading playbooks…'}</option>
        {(rows ?? []).map((r) => (
          <option key={r.id} value={r.macro}>{r.name} ({r.macro})</option>
        ))}
      </select>
      <p className={styles.meta} role="status">
        {note ?? 'Puts a playbook’s !macro in your message; Run in cloud, Run in Devin and fleet goals then follow it.'}
      </p>
    </div>
  );
}
