/**
 * routes/verse/fleet/RepoTable.tsx — one row per enrolled repo (SPEC-310C §5
 * Fleet "Repo table: stage, last merge, green% sparkline, holds,
 * pause/resume"; unit C7).
 *
 * Pause sets an owner-hold as Mason; Resume clears every active hold (or the
 * one a Needs-you item names). Both confirm first — a pause stops new work
 * in a repo, a resume can lift a quarantine early — then take the token.
 * At 375 px the table becomes one card per repo (a 7-column table does not
 * fit a phone, and a horizontal scroll hides the action).
 */
import type { FleetLiveSnapshotV1, FleetMirrorSummary, FleetRepoRow, RepoHold } from '../../../../core/fleet/fleet-types.js';
import { Sparkline } from '../../../components/charts/Sparkline.js';
import { Button } from '../../../components/primitives/Button.js';
import { formatRelative } from '../autonomy/format.js';
import type { SurfaceActions } from '../command/actions.js';
import { anchorId } from '../command/nav.js';
import { Card, CardNote } from '../command/Surface.js';
import { postFleetLive, type OptionalRead } from '../command/surface-data.js';
import styles from './fleet.module.css';

const HOLD_WORD: Record<RepoHold['kind'], string> = {
  quarantine: 'Quarantined',
  'owner-hold': 'On hold (you)',
  'leader-pause': 'Paused by Leader',
  cooldown: 'Cooling down',
};

export function holdText(hold: RepoHold, now: number): string {
  const until = hold.until ? Date.parse(hold.until) : NaN;
  const left = Number.isFinite(until) ? Math.max(0, until - now) : null;
  const tail = left === null ? 'until resumed' : left < 3_600_000 ? `${Math.ceil(left / 60_000)}m left` : `${Math.round(left / 3_600_000)}h left`;
  return `${HOLD_WORD[hold.kind]} · ${tail}`;
}

function shortRepo(repo: string): string {
  return repo.includes('/') ? repo.split('/')[1]! : repo;
}

function StageBadge({ row }: { row: FleetRepoRow }) {
  if (row.stage === null) return <span className={styles.stage} data-stage="none">Not in grant</span>;
  return (
    <span className={styles.stage} data-stage={row.stage}>
      {row.stage === 'merge' ? 'Merge' : 'Propose'}
      {row.enforcement === 'local' ? <span className={styles.stageNote}> · local checks</span> : null}
    </span>
  );
}

function RepoAction({ row, actions }: { row: FleetRepoRow; actions: SurfaceActions }) {
  const disabled = actions.busy || actions.readOnly;
  if (row.holds.length) {
    return (
      <Button
        size="sm"
        variant="subtle"
        disabled={disabled}
        aria-label={`Resume ${row.repo}`}
        onClick={() =>
          actions.act(() => postFleetLive({ action: 'resume-repo', repo: row.repo }), `Resume ${row.repo}`, {
            confirm: {
              title: `Resume ${shortRepo(row.repo)}?`,
              body: `Clears ${row.holds.map((h) => HOLD_WORD[h.kind].toLowerCase()).join(' and ')}. New fleet work can start there on the next tick.`,
              confirmLabel: 'Resume',
            },
          })
        }
      >
        Resume
      </Button>
    );
  }
  if (row.stage === null) return null;
  return (
    <Button
      size="sm"
      variant="ghost"
      disabled={disabled}
      aria-label={`Pause ${row.repo}`}
      onClick={() =>
        actions.act(() => postFleetLive({ action: 'pause-repo', repo: row.repo, reason: 'Paused by Mason from the Fleet surface' }), `Pause ${row.repo}`, {
          confirm: {
            title: `Pause ${shortRepo(row.repo)}?`,
            body: 'No new fleet work starts there until you resume it. Runs already in flight finish and are watched as usual.',
            confirmLabel: 'Pause repo',
            destructive: true,
          },
        })
      }
    >
      Pause
    </Button>
  );
}

function GreenCell({ row }: { row: FleetRepoRow }) {
  return (
    <span className={styles.green}>
      <span className={styles.greenValue}>{row.greenPct7d === null ? '—' : `${Math.round(row.greenPct7d)}%`}</span>
      <Sparkline points={row.greenTrend} width={64} height={18} ariaLabel={`${row.repo} post-merge green, 14 days`} describe={(v) => `${Math.round(v)}%`} />
    </span>
  );
}

function Holds({ row, now }: { row: FleetRepoRow; now: number }) {
  if (!row.holds.length) return <span className={styles.muted}>—</span>;
  return (
    <span className={styles.holds}>
      {row.holds.map((h) => (
        <span key={h.kind} className={styles.hold} data-kind={h.kind} title={h.reason}>
          {holdText(h, now)}
        </span>
      ))}
    </span>
  );
}

/**
 * The fleet's own mirror clones, apart from the repo rows. WHY separate: a
 * mirror is the fleet's working copy of a repo already listed above, so
 * counting it as a row double-counts the repo (and its pause would not pause
 * the real one). `undefined` = an older server that does not report mirrors
 * (say nothing); `null` = the enrollment registry could not be read (say so —
 * unknown is never "none").
 */
export function mirrorsText(mirrors: FleetMirrorSummary | null | undefined): string | null {
  if (mirrors === undefined) return null;
  if (mirrors === null) return 'Fleet mirrors: unknown — the enrollment registry could not be read.';
  if (mirrors.count === 0) return 'Fleet mirrors: none yet — the fleet clones a repo the first time it works on it.';
  const shown = mirrors.repos.slice(0, 6).join(', ');
  const more = mirrors.repos.length > 6 ? ` and ${mirrors.repos.length - 6} more` : '';
  return `Fleet mirrors: ${mirrors.count} working ${mirrors.count === 1 ? 'copy' : 'copies'}${shown ? ` (${shown}${more})` : ''} — the fleet's own clones of the repos above.`;
}

const today = (row: FleetRepoRow) => (row.mergesToday === null ? '—' : `${row.mergesToday}${row.maxMergesPerDay !== null ? ` / ${row.maxMergesPerDay}` : ''}`);

export function RepoTable({ read, actions, now, compact }: { read: OptionalRead<FleetLiveSnapshotV1> | undefined; actions: SurfaceActions; now: number; compact: boolean }) {
  const live = read?.value ?? null;
  const rows = live?.repos ?? [];
  return (
    <Card title="Repositories" caption={live ? `${rows.length} enrolled · stage is what the grant and rollout allow right now` : undefined}>
      {!read ? (
        <p className={styles.muted} aria-busy="true">Reading repositories…</p>
      ) : !live ? (
        <CardNote tone="unknown">{read.reason ?? 'The live fleet view did not answer.'}</CardNote>
      ) : rows.length === 0 ? (
        <CardNote>No repositories are enrolled.</CardNote>
      ) : compact ? (
        <ul className={styles.repoCards}>
          {rows.map((row) => (
            <li key={row.repo} className={styles.repoCard} id={anchorId(`repo-${row.repo}`)}>
              <div className={styles.repoCardHead}>
                <span className={styles.repoName}>{row.repo}</span>
                <RepoAction row={row} actions={actions} />
              </div>
              <dl className={styles.facts}>
                <div><dt>Stage</dt><dd><StageBadge row={row} /></dd></div>
                <div><dt>Last merge</dt><dd>{row.lastMergeAt ? formatRelative(row.lastMergeAt) : '—'}</dd></div>
                <div><dt>Today</dt><dd>{today(row)}</dd></div>
                <div><dt>Green 7d</dt><dd><GreenCell row={row} /></dd></div>
              </dl>
              <Holds row={row} now={now} />
            </li>
          ))}
        </ul>
      ) : (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <caption className="visually-hidden">Enrolled repositories</caption>
            <thead>
              <tr>
                <th scope="col">Repository</th>
                <th scope="col">Stage</th>
                <th scope="col">Last merge</th>
                <th scope="col" className={styles.num}>Today</th>
                <th scope="col">Post-merge green · 14d</th>
                <th scope="col" className={styles.num}>Open PRs</th>
                <th scope="col">Holds</th>
                <th scope="col"><span className="visually-hidden">Action</span></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.repo} id={anchorId(`repo-${row.repo}`)} data-held={row.holds.length > 0 || undefined}>
                  <th scope="row" className={styles.repoName}>{row.repo}</th>
                  <td><StageBadge row={row} /></td>
                  <td>{row.lastMergeAt ? formatRelative(row.lastMergeAt) : '—'}</td>
                  <td className={styles.num}>{today(row)}</td>
                  <td><GreenCell row={row} /></td>
                  <td className={styles.num}>{row.openFleetPrs ?? '—'}</td>
                  <td><Holds row={row} now={now} /></td>
                  <td className={styles.actionCell}><RepoAction row={row} actions={actions} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {live && mirrorsText(live.mirrors) ? <p className={styles.muted}>{mirrorsText(live.mirrors)}</p> : null}
    </Card>
  );
}
