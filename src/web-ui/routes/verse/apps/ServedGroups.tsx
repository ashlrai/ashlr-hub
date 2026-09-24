/**
 * routes/verse/apps/ServedGroups.tsx — the three groups GET /api/verse/apps
 * serves: DESKTOP (Ollama's switches for other apps), TERMINAL AGENTS and
 * LOCAL MODELS. Rendering only; every decision about a word or an enabled
 * control was made by the server or apps-model.ts.
 */
import type { VerseAppGroup, VerseAppRow } from '../../../../core/verse/workbench-types.js';
import { Button } from '../../../components/primitives/Button.js';
import { IconChevronDown, IconPlay } from '../../../components/primitives/icons.js';
import { Switch } from '../../../components/primitives/Switch.js';
import { appHealthTone } from './apps-model.js';
import { AppGroup, AppRow } from './AppRow.js';
import { CopyPill } from './CopyPill.js';
import { commandText } from './launch.js';
import styles from './Apps.module.css';

function rowHealth(row: VerseAppRow) {
  return { tone: appHealthTone(row.health.state), label: row.health.label };
}

export function DesktopGroup({
  group,
  onToggle,
  onRestore,
}: {
  group: VerseAppGroup;
  /** Opens the confirmation; never flips anything by itself. */
  onToggle: (row: VerseAppRow, enable: boolean) => void;
  onRestore: (row: VerseAppRow) => void;
}) {
  return (
    <AppGroup id={group.id} title={group.title} caveat={group.caveat}>
      <ul className={styles.rows}>
        {group.apps.map((row) => {
          const restore = row.actions.find((a) => a.kind === 'restore') ?? null;
          return (
            <AppRow
              key={row.id}
              id={`app-${row.id}`}
              name={row.name}
              monogram={row.monogram}
              engine={row.engine}
              description={row.description}
              health={rowHealth(row)}
              detail={row.toggle === null ? row.detail : null}
              aside={
                row.toggle === null ? null : (
                  <>
                    {restore ? (
                      <Button variant="ghost" size="sm" onClick={() => onRestore(row)} disabled={restore.disabledReason !== null} title={commandText(restore.command ?? [])}>
                        {restore.label}
                      </Button>
                    ) : null}
                    <Switch
                      checked={row.toggle.enabled}
                      onChange={(next) => onToggle(row, next)}
                      aria-label={`${row.description}: ${row.toggle.enabled ? 'on' : 'off'}`}
                      aria-describedby={`app-${row.id}-name`}
                    />
                  </>
                )
              }
            />
          );
        })}
      </ul>
    </AppGroup>
  );
}

export function AgentsGroup({
  group,
  quickLaunchReason,
  onQuickLaunch,
  onLaunchOptions,
}: {
  group: VerseAppGroup;
  /** Why the one-click Launch cannot run anywhere right now (no folder and no Verse tab), or null. */
  quickLaunchReason: string | null;
  onQuickLaunch: (row: VerseAppRow) => void;
  onLaunchOptions: (row: VerseAppRow) => void;
}) {
  return (
    <AppGroup id={group.id} title={group.title} caveat={group.caveat}>
      <ul className={styles.rows}>
        {group.apps.map((row) => {
          const launch = row.actions.find((a) => a.kind === 'launch') ?? null;
          const disabled = launch?.disabledReason ?? quickLaunchReason;
          return (
            <AppRow
              key={row.id}
              id={`app-${row.id}`}
              name={row.name}
              monogram={row.monogram}
              engine={row.engine}
              description={row.description}
              version={row.version}
              health={rowHealth(row)}
              detail={row.detail}
              aside={
                <>
                  {row.copy && row.installed ? <CopyPill text={row.copy.text} label={row.copy.label} what={`the ${row.name} command`} /> : null}
                  {row.ollamaLaunch ? (
                    <CopyPill text={commandText(row.ollamaLaunch)} what={`the Ollama launch command for ${row.name}`} />
                  ) : null}
                  {launch ? (
                    launch.disabledReason !== null ? (
                      <span className={styles.disabledNote}>{launch.disabledReason}</span>
                    ) : (
                      <span className={styles.split}>
                        <Button
                          variant="subtle"
                          size="sm"
                          icon={<IconPlay size={14} />}
                          disabled={disabled !== null}
                          title={disabled ?? undefined}
                          onClick={() => onQuickLaunch(row)}
                          aria-label={`Launch ${row.name}`}
                        >
                          Launch
                        </Button>
                        <Button
                          variant="subtle"
                          size="sm"
                          iconOnly
                          icon={<IconChevronDown size={14} />}
                          aria-label={`Launch options for ${row.name}`}
                          aria-haspopup="dialog"
                          onClick={() => onLaunchOptions(row)}
                        />
                      </span>
                    )
                  ) : null}
                </>
              }
            />
          );
        })}
      </ul>
    </AppGroup>
  );
}

export function LocalModelsGroup({ group }: { group: VerseAppGroup }) {
  return (
    <AppGroup id={group.id} title={group.title} caveat={group.caveat}>
      <ul className={styles.rows}>
        {group.apps.map((row) => (
          <AppRow
            key={row.id}
            id={`app-${row.id}`}
            name={row.name}
            monogram={row.monogram}
            engine={row.engine}
            description={row.description}
            version={row.version}
            health={rowHealth(row)}
            detail={row.detail}
          />
        ))}
      </ul>
    </AppGroup>
  );
}
