/**
 * terminal/LaunchDialog.tsx — launch configurations (3.15): the layouts a
 * repo's `.ashlr/verse/launch.json` names (a dev server + a test watcher +
 * Claude Code, say), each shown with EXACTLY what it would type, launched one
 * at a time by name. Opening this dialog types nothing; only [Launch] does,
 * and the commands come from the file on the server, never from this page.
 *
 * Loaded lazily (TerminalPanel), in its own small chunk.
 */
import { useEffect, useId, useState } from 'react';
import type { VerseTerminalLaunchConfig, VerseTerminalLaunchListResponse } from '../../../data/api-types.js';
import { Button } from '../../../components/primitives/Button.js';
import { Dialog } from '../../../components/primitives/Dialog.js';
import { EmptyState } from '../../../components/primitives/EmptyState.js';
import { SkeletonLine } from '../../../components/primitives/Skeleton.js';
import { projectName } from '../verse-model.js';
import extra from './TerminalExtras.module.css';

export interface LaunchDialogProps {
  load: () => Promise<VerseTerminalLaunchListResponse>;
  onLaunch: (config: VerseTerminalLaunchConfig) => Promise<void>;
  onClose: () => void;
}

const EXAMPLE = `{
  "version": 1,
  "configurations": [
    { "name": "Dev",
      "tabs": [
        { "split": "right", "panes": [ { "cwd": "web", "command": "npm run dev" },
                                       { "command": "npm test -- --watch" } ] },
        { "panes": [ { "agent": "claude-code" } ] } ] } ] }`;

export function LaunchDialog({ load, onLaunch, onClose }: LaunchDialogProps) {
  const titleId = useId();
  const [list, setList] = useState<VerseTerminalLaunchListResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    load().then(
      (res) => { if (!cancelled) setList(res); },
      (err: unknown) => { if (!cancelled) setError(err instanceof Error ? err.message : 'The launch configurations could not be read.'); },
    );
    return () => { cancelled = true; };
  }, [load]);

  const launch = async (config: VerseTerminalLaunchConfig) => {
    setBusy(`${config.root}\u0000${config.name}`);
    try {
      await onLaunch(config);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That configuration could not be launched.');
    } finally {
      setBusy(null);
    }
  };

  return (
    <Dialog open onClose={onClose} titleId={titleId} title="Launch a terminal layout"
      description="From .ashlr/verse/launch.json in this chat’s folders. Each layout opens its tabs and types the commands shown — only when you launch it.">
      {error ? <p className={extra.launchError} role="alert">{error}</p> : null}
      {list === null && !error ? <div role="status" aria-label="Loading"><SkeletonLine width="60%" /><SkeletonLine width="40%" /></div> : null}
      {list && list.errors.map((e) => (
        <p key={e.root} className={extra.launchError} role="alert">{projectName(e.root)}: {e.error}</p>
      ))}
      {list && list.configs.length === 0 ? (
        <>
          <EmptyState compact title="No launch configurations" body={<>Add <code>.ashlr/verse/launch.json</code> to a project, for example:</>} />
          <pre className={extra.launchPanes}>{EXAMPLE}</pre>
        </>
      ) : null}
      {list && list.configs.length > 0 ? (
        <ul className={extra.launchList} aria-label="Launch configurations">
          {list.configs.map((config) => {
            const key = `${config.root}\u0000${config.name}`;
            return (
              <li key={key} className={extra.launchItem}>
                <div className={extra.launchHead}>
                  <span className={extra.launchName}>{config.name}</span>
                  <span className={extra.barLabel}>{projectName(config.root)}</span>
                  <Button size="sm" variant="subtle" busy={busy === key} disabled={busy !== null && busy !== key}
                    aria-label={`Launch ${config.name}`} onClick={() => void launch(config)}>Launch</Button>
                </div>
                <ol className={extra.launchPanes}>
                  {config.tabs.map((tab, i) => (
                    <li key={i}>
                      Tab {i + 1}{tab.panes.length > 1 ? ` (split ${tab.split})` : ''}:{' '}
                      {tab.panes.map((pane, j) => (
                        <span key={j}>
                          {j > 0 ? ' · ' : ''}
                          {pane.cwd ? <>in <code>{pane.cwd}</code> </> : null}
                          {pane.agent ? <>start <code>{pane.agent}</code></> : pane.command ? <>run <code>{pane.command}</code></> : 'a shell'}
                        </span>
                      ))}
                    </li>
                  ))}
                </ol>
              </li>
            );
          })}
        </ul>
      ) : null}
    </Dialog>
  );
}
