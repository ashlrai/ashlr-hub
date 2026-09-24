/**
 * routes/verse/sections/AppsSection.tsx — Apps & Accounts (unit C6,
 * SPEC-310C §4; the gear tray's "Apps & Accounts", and where MCP now lives).
 *
 * One page that answers "what can I run with on this Mac, and is it ready":
 *
 *   ACCOUNTS         each seat's plan, connection, 5-hour and weekly windows
 *                    with resets, "Reserved for you N%", and Reconnect / Fix /
 *                    Edit budget — the shared CapacityStrip;
 *   DESKTOP          Ollama's switches for Claude Desktop and Hermes Desktop,
 *                    shown OFF with Restore (SPEC-310C §0.5);
 *   TERMINAL AGENTS  installed version or "not installed", the agent's own
 *                    command, `ollama launch <id>` only where the installed
 *                    Ollama lists it, and [Launch ▾];
 *   LOCAL MODELS     Ollama (models, end-to-end tok/s), llama-server, LM Studio;
 *   MCP SERVERS      what each seat would load, and Add (propose → disclose → apply).
 *
 * Takes no props, per the shell contract (C1 mounts `sections/*Section.tsx`).
 * `focusGroup` is only for the legacy MCP entry point, which lands on the MCP
 * group of this same page.
 *
 * Polls only while visible (usePollWhileVisible): apps every 60 s (the server
 * caches and re-probes in the background), seats 30 s, health 30 s, budget
 * 60 s. Every mutation goes through the mutation-token gate; nothing on this
 * page spends — the actions open visible Terminal windows or write a config
 * the operator just read.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { VerseAppRow } from '../../../../core/verse/workbench-types.js';
import { MutationTokenDialog } from '../../../components/auth/MutationTokenDialog.js';
import { Button } from '../../../components/primitives/Button.js';
import { IconRefresh } from '../../../components/primitives/icons.js';
import { SkeletonLine } from '../../../components/primitives/Skeleton.js';
import { useQuery, useRefetch } from '../../../data/hooks.js';
import type { VerseBootstrap } from '../../../data/api-types.js';
import { AccountsGroup } from '../apps/AccountsGroup.js';
import { launchProjects, localModelTags, type LaunchChoice } from '../apps/apps-model.js';
import { appsQuery, launchInTerminalApp, refreshApps, terminalStatusQuery, toggleDesktopApp } from '../apps/apps-queries.js';
import { DesktopToggleDialog } from '../apps/DesktopToggleDialog.js';
import { inVerseAvailability, launchInVerse } from '../apps/launch.js';
import { LaunchDialog, type LaunchRequest } from '../apps/LaunchDialog.js';
import { McpGroup } from '../apps/McpGroup.js';
import { AgentsGroup, DesktopGroup, LocalModelsGroup } from '../apps/ServedGroups.js';
import { describeContextError, useTokenGate } from '../context/use-token-gate.js';
import { reconnectSeat, refreshSeatHealth } from '../health/health-queries.js';
import { projectCliHealth, projectMcpSnapshot } from '../mcp/mcp-contract.js';
import { mcpCliHealthQuery, mcpSnapshotQuery } from '../mcp/mcp-queries.js';
import { usePollWhileVisible } from '../shell/section-visibility.js';
import { useCapacityData } from '../usage/CapacityStrip.js';
import type { CapacityRow } from '../usage/capacity-strip-model.js';
import { useVerseUi } from '../useVerseUi.js';
import { verseBootstrapQuery } from '../verse-queries.js';
import styles from '../apps/Apps.module.css';

/** The server re-probes in the background after 60 s; reading faster only re-reads its cache. */
export const APPS_POLL_MS = 60_000;

function checkedAgo(iso: string, now: number): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return 'not checked';
  const minutes = Math.max(0, Math.round((now - t) / 60_000));
  if (minutes < 1) return 'checked just now';
  if (minutes < 120) return `checked ${minutes} min ago`;
  return `checked ${Math.round(minutes / 60)} h ago`;
}

export function AppsSection({ focusGroup }: { focusGroup?: 'mcp-servers' } = {}) {
  const apps = useQuery(appsQuery);
  const refetchApps = useRefetch(appsQuery);
  usePollWhileVisible(refetchApps, APPS_POLL_MS);
  const terminal = useQuery(terminalStatusQuery);
  const mcp = useQuery(mcpSnapshotQuery);
  const cli = useQuery(mcpCliHealthQuery);
  const refetchMcp = useRefetch(mcpSnapshotQuery);
  const bootstrap = useQuery(verseBootstrapQuery);
  const capacity = useCapacityData();
  const ui = useVerseUi();
  const gate = useTokenGate();

  const [status, setStatus] = useState<{ tone: 'neutral' | 'danger'; text: string } | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [reconnecting, setReconnecting] = useState<string | null>(null);
  const [toggle, setToggle] = useState<{ row: VerseAppRow; enable: boolean } | null>(null);
  const [toggleBusy, setToggleBusy] = useState(false);
  const [toggleError, setToggleError] = useState<string | null>(null);
  const [launchRow, setLaunchRow] = useState<VerseAppRow | null>(null);
  const [launchBusy, setLaunchBusy] = useState(false);
  const [launchError, setLaunchError] = useState<string | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  usePollWhileVisible(() => setNowMs(Date.now()), 30_000);

  const mcpHeading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (focusGroup !== 'mcp-servers') return;
    const el = mcpHeading.current;
    if (!el) return;
    if (typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'start' });
    el.focus({ preventScroll: true });
  }, [focusGroup]);

  const data = bootstrap.data as VerseBootstrap | undefined;
  const projects = launchProjects(data);
  const models = localModelTags(capacity.seats);
  const inVerse = inVerseAvailability({
    terminalAvailable: terminal.data?.available ? terminal.data.data.available : terminal.data ? false : null,
    terminalReason: terminal.data?.available ? terminal.data.data.reason : null,
    activeSessionId: ui.activeSessionId,
  });

  const served = apps.data?.available ? apps.data.data : null;
  const group = (id: 'desktop' | 'terminal-agents' | 'local-models') => served?.groups.find((g) => g.id === id) ?? null;
  const snapshot = mcp.data?.available ? projectMcpSnapshot(mcp.data.raw) : null;
  const cliHealth = cli.data?.available ? projectCliHealth(cli.data.raw) : null;

  const say = useCallback((text: string, tone: 'neutral' | 'danger' = 'neutral') => setStatus({ text, tone }), []);

  const onRefresh = async () => {
    setRefreshing(true);
    try {
      const done = await gate.run('Check every app and seat again', async () => {
        await Promise.all([refreshApps(), refreshSeatHealth().catch(() => null)]);
        refetchMcp();
        return true;
      });
      if (done) {
        setNowMs(Date.now());
        say('Checked again.');
      }
    } catch (err) {
      say(describeContextError(err), 'danger');
    } finally {
      setRefreshing(false);
    }
  };

  const onReconnect = async (row: CapacityRow) => {
    setReconnecting(row.seatId);
    try {
      const done = await gate.run(`Open the sign-in for ${row.label} in Terminal`, async () => {
        await reconnectSeat(row.seatId);
        return true;
      });
      if (done) say(`Opened the sign-in for ${row.label} in Terminal. Finish it there; this page picks it up.`);
    } catch (err) {
      say(describeContextError(err), 'danger');
    } finally {
      setReconnecting(null);
    }
  };

  const onConfirmToggle = async () => {
    if (!toggle) return;
    setToggleBusy(true);
    setToggleError(null);
    try {
      const result = await gate.run(`${toggle.enable ? 'Switch on' : 'Restore'} ${toggle.row.name}`, () => toggleDesktopApp(toggle.row.id, toggle.enable));
      if (result) {
        say(`Opened “${result.command.join(' ')}” in Terminal. Answer its prompts there.`);
        setToggle(null);
      }
    } catch (err) {
      setToggleError(describeContextError(err));
    } finally {
      setToggleBusy(false);
    }
  };

  const launch = async (row: VerseAppRow, request: LaunchRequest) => {
    if (request.target === 'verse') {
      launchInVerse(row.id, request.choice);
      setLaunchRow(null);
      return;
    }
    if (request.root === null) return;
    setLaunchBusy(true);
    setLaunchError(null);
    try {
      const result = await gate.run(`Launch ${row.name} in Terminal`, () =>
        launchInTerminalApp(row.id, { root: request.root!, via: request.choice.via, model: request.choice.model }));
      if (result) {
        say(`Opened ${row.name} in Terminal.`);
        setLaunchRow(null);
      }
    } catch (err) {
      const message = describeContextError(err);
      if (launchRow) setLaunchError(message);
      else say(message, 'danger');
    } finally {
      setLaunchBusy(false);
    }
  };

  const quickLaunchReason = inVerse.available || projects.length > 0 ? null : 'Open a chat or enrol a project first.';
  const onQuickLaunch = (row: VerseAppRow) => {
    const choice: LaunchChoice = { via: 'native', model: null };
    const command = row.actions.find((a) => a.kind === 'launch')?.command ?? null;
    if (!command) return;
    void launch(row, { choice, target: inVerse.available ? 'verse' : 'terminal-app', root: projects[0]?.path ?? null, command });
  };

  const servedLoading = apps.data === undefined && (apps.status === 'loading' || apps.status === 'idle');

  return (
    <section className={styles.section} aria-label="Apps & Accounts">
      <div className={styles.scroll}>
        <div className={styles.page}>
          <header className={styles.header}>
            <div className={styles.headerText}>
              <h2 className={styles.title}>Apps &amp; Accounts</h2>
              <p className={styles.lede}>Everything Verse can run with on this Mac, and whether it is ready.</p>
            </div>
            <div className={styles.headerMeta}>
              {served ? (
                <span>
                  {checkedAgo(served.checkedAt, nowMs)}
                  {served.pathSource === 'fallback' ? ' · PATH from known folders (your login shell did not answer)' : ''}
                </span>
              ) : null}
              <Button variant="ghost" size="sm" icon={<IconRefresh size={14} />} busy={refreshing} onClick={() => void onRefresh()}>
                Check again
              </Button>
            </div>
          </header>

          <p className={status ? styles.banner : styles.visuallyHidden} data-tone={status?.tone} role="status" aria-live="polite">
            {status?.text ?? ''}
          </p>

          <AccountsGroup
            seats={capacity.seats}
            health={capacity.health}
            budget={capacity.budget}
            loading={capacity.loading}
            reconnecting={reconnecting}
            onReconnect={(row) => void onReconnect(row)}
          />

          {apps.data && !apps.data.available ? (
            <p className={styles.banner}>{apps.data.reason}</p>
          ) : servedLoading ? (
            <div aria-busy="true" aria-label="Checking apps">
              <SkeletonLine width="30%" />
              <SkeletonLine width="80%" />
              <SkeletonLine width="70%" />
            </div>
          ) : (
            <>
              {group('desktop') ? (
                <DesktopGroup
                  group={group('desktop')!}
                  onToggle={(row, enable) => { setToggleError(null); setToggle({ row, enable }); }}
                  onRestore={(row) => { setToggleError(null); setToggle({ row, enable: false }); }}
                />
              ) : null}
              {group('terminal-agents') ? (
                <AgentsGroup
                  group={group('terminal-agents')!}
                  quickLaunchReason={quickLaunchReason}
                  onQuickLaunch={onQuickLaunch}
                  onLaunchOptions={(row) => { setLaunchError(null); setLaunchRow(row); }}
                />
              ) : null}
              {group('local-models') ? <LocalModelsGroup group={group('local-models')!} /> : null}
            </>
          )}

          <McpGroup
            snapshot={snapshot}
            cliHealth={cliHealth}
            unavailable={mcp.data && !mcp.data.available ? mcp.data.reason : null}
            loading={mcp.data === undefined}
            run={gate.run}
            onAdded={(text) => { say(text); refetchMcp(); }}
            headingRef={mcpHeading}
          />
        </div>
      </div>

      <DesktopToggleDialog
        row={toggle?.row ?? null}
        enable={toggle?.enable ?? false}
        busy={toggleBusy}
        error={toggleError}
        onCancel={() => setToggle(null)}
        onConfirm={() => void onConfirmToggle()}
      />
      <LaunchDialog
        row={launchRow}
        projects={projects}
        models={models}
        inVerse={inVerse}
        busy={launchBusy}
        error={launchError}
        onCancel={() => setLaunchRow(null)}
        onLaunch={(request) => { if (launchRow) void launch(launchRow, request); }}
      />
      <MutationTokenDialog
        open={gate.dialog.open}
        reason={gate.dialog.reason}
        tokenLabel="Mutation token"
        tokenHelp="the mutation token ashlr verse printed"
        onClose={gate.dialog.onClose}
        onUnlocked={gate.dialog.onUnlocked}
      />
    </section>
  );
}
