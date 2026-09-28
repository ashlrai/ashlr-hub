/**
 * routes/verse/mobile/screens/FleetScreen.tsx — the fleet from a pocket:
 * what state it is in and the one safe button, Stop, how much of your seats
 * it may spend (budget mode), what it is allowed to touch (the grant —
 * read-only here), and what it decided lately.
 *
 * Reads, all the workbench's own (same cache keys, so the Mac's Fleet and
 * Command views and this screen never disagree):
 *   control    GET /api/verse/control              daemon, pause, kill switch
 *   live       GET /api/verse/fleet/live           state, summary, lanes, runs
 *   authority  GET /api/verse/authority            switch, grant
 *   budget     GET /api/verse/budget               mode
 *   decisions  GET /api/verse/authority/ledger?view=decisions
 * plus the shell's activity badge. Polled every 15 s while on screen.
 *
 * What the phone deliberately cannot do: release the kill switch (the Mac's
 * `ashlr fleet resume`), sign or widen a grant (Touch ID on the Mac), or
 * raise the budget above the grant's ceiling. Each says so where it applies.
 */
import { useCallback, useState } from 'react';
import type { BudgetMode } from '../../../../../core/routing/types.js';
import type { AutonomySwitch } from '../../../../../core/authority/types.js';
import type { FleetLiveRun } from '../../../../../core/fleet/fleet-types.js';
import type { ShadowDecisionOutcome } from '../../../../../core/verse/autonomy-ladder.js';
import { refetchQuery } from '../../../../data/cache.js';
import { readFailureReason } from '../../../../data/client.js';
import { useQuery, useRefetch } from '../../../../data/hooks.js';
import { verseControlQuery } from '../../autonomy/control-queries.js';
import { budgetQuery } from '../../budget/budget-queries.js';
import { BUDGET_MODE_OPTIONS, modeAboveCeiling } from '../../budget/budget-model.js';
import { decisionsQuery } from '../../command/ladder-queries.js';
import { ago, grantExpiry, OUTCOME_TONE, repoShort } from '../../command/ladder-model.js';
import { authorityQuery, fleetLiveQuery } from '../../command/surface-data.js';
import { usePollWhileVisible } from '../../shell/section-visibility.js';
import { runFleetAction } from '../fleet-actions.js';
import { getMobileFleetClient } from '../fleet-client.js';
import { canStop, fleetStateView, STOP_ACTION, type FleetHeadline } from '../fleet-state.js';
import { runMobileAction } from '../mobile-actions.js';
import { canShowActions, useMobile } from '../mobile-context.js';
import { Button, cx, Screen, SkeletonList } from '../ui.js';
import { Badge, Banner, ErrorState, Row, Section, ui, type Tone } from '../ui-parts.js';
import styles from './FleetScreen.module.css';

export const FLEET_POLL_MS = 15_000;
const STOP = STOP_ACTION.kind === 'daemon' ? STOP_ACTION : null;
/** Decisions shown before the list stops (the Mac's Fleet view has the rest). */
export const DECISION_ROWS = 10;

const HEADLINE_TONE: Readonly<Record<FleetHeadline, Tone>> = {
  running: 'running',
  paused: 'warning',
  stopped: 'neutral',
  blocked: 'danger',
  unknown: 'neutral',
};

const SWITCH_WORD: Readonly<Record<AutonomySwitch, string>> = { off: 'Off', propose: 'Propose', autonomous: 'Autonomous' };

const GRANT_WORD: Readonly<Record<string, string>> = {
  none: 'No grant',
  active: 'Active',
  paused: 'Paused',
  expired: 'Expired',
  revoked: 'Revoked',
  invalid: 'Invalid',
};

const GRANT_TONE: Readonly<Record<string, Tone>> = {
  none: 'neutral',
  active: 'success',
  paused: 'warning',
  expired: 'danger',
  revoked: 'danger',
  invalid: 'danger',
};

/** The phone's words for a decision: a merge is "Landed" here. */
export const DECISION_WORD: Readonly<Record<ShadowDecisionOutcome, string>> = {
  merged: 'Landed',
  'would-merge': 'Would merge',
  refused: 'Refused',
  'owner-lane': 'Owner lane',
  waiting: 'Waiting',
  'in-progress': 'In the gates',
};

function toneOf(chip: string): Tone {
  return chip === 'success' || chip === 'warning' || chip === 'danger' ? chip : 'neutral';
}

const RUN_OUTCOME: Readonly<Record<string, { word: string; tone: Tone }>> = {
  merged: { word: 'Landed', tone: 'success' },
  refused: { word: 'Refused', tone: 'danger' },
  failed: { word: 'Failed', tone: 'danger' },
  reverted: { word: 'Reverted', tone: 'warning' },
};

const LANE_LABEL: Readonly<Record<string, string>> = {
  local: 'Local',
  'grok-cli': 'Grok',
  'claude-cli': 'Claude',
  codex: 'Codex',
  devin: 'Devin',
};

function count(n: number | null | undefined): string {
  return typeof n === 'number' && Number.isFinite(n) ? String(n) : '—';
}

function modeLabel(mode: BudgetMode | null | undefined): string {
  return BUDGET_MODE_OPTIONS.find((o) => o.value === mode)?.label ?? '—';
}

/** Pull-to-refresh: every read this screen shows, forced fresh. */
export function refreshFleetScreen(): Promise<unknown> {
  return Promise.all([
    refetchQuery(verseControlQuery.key, () => verseControlQuery.fetch(), true),
    refetchQuery(fleetLiveQuery.key, () => fleetLiveQuery.fetch(), true),
    refetchQuery(authorityQuery.key, () => authorityQuery.fetch(), true),
    refetchQuery(budgetQuery.key, () => budgetQuery.fetch(), true),
    refetchQuery(decisionsQuery.key, () => decisionsQuery.fetch(), true),
  ]);
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className={styles.stat}>
      <span className={styles.statValue}>{value}</span>
      <span className={styles.statLabel}>{label}</span>
    </div>
  );
}

export function FleetScreen() {
  const { activity, permissions, reachability, navigate } = useMobile();
  const control = useQuery(verseControlQuery);
  const live = useQuery(fleetLiveQuery);
  const authority = useQuery(authorityQuery);
  const budget = useQuery(budgetQuery);
  const decisions = useQuery(decisionsQuery);
  const refetchControl = useRefetch(verseControlQuery);
  const refetchLive = useRefetch(fleetLiveQuery);
  const refetchAuthority = useRefetch(authorityQuery);
  const refetchBudget = useRefetch(budgetQuery);
  const refetchDecisions = useRefetch(decisionsQuery);
  const poll = useCallback(() => {
    refetchControl();
    refetchLive();
    refetchAuthority();
    refetchBudget();
    refetchDecisions();
  }, [refetchControl, refetchLive, refetchAuthority, refetchBudget, refetchDecisions]);
  usePollWhileVisible(poll, FLEET_POLL_MS);
  const [reposOpen, setReposOpen] = useState(false);

  const snapshot = live.data?.value ?? null;
  const fleet = fleetStateView({ control: control.data ?? null, live: snapshot, badge: activity.data?.autonomy ?? null });
  const canAct = canShowActions(permissions);
  const offline = reachability === 'offline' || reachability === 'unreachable';
  // Nothing to say about the fleet until one of its two sources has answered with a reading.
  const nothingYet = !control.data && !snapshot;
  const loading = nothingYet && (control.status === 'loading' || control.status === 'idle' || live.status === 'loading' || live.status === 'idle');
  const failed = nothingYet && !loading;
  const action = fleet.action?.kind === 'daemon' ? fleet.action : null;
  const kill = control.data?.killSwitch;

  const status = authority.data?.value ?? null;
  const ceiling = status?.grant.maxMode ?? null;
  const currentMode = budget.data?.mode ?? null;
  const expiry = grantExpiry(status, Date.now());

  const chooseMode = (mode: BudgetMode) => {
    if (mode === currentMode) return;
    const option = BUDGET_MODE_OPTIONS.find((o) => o.value === mode);
    if (!option) return;
    runMobileAction({
      title: `Switch to ${option.label}?`,
      consequences: `${option.description} This applies to autonomous work immediately.`,
      confirmLabel: `Use ${option.label}`,
      run: () => getMobileFleetClient().setBudgetMode(mode),
      success: `Budget mode: ${option.label}`,
    });
  };

  const header = offline && canAct ? <div className={styles.headerBanner}><Banner tone="warning">Your Mac isn’t answering — controls wait until it does.</Banner></div> : undefined;

  let fleetCard;
  if (loading) {
    fleetCard = <SkeletonList rows={2} label="Loading the fleet" />;
  } else if (failed) {
    fleetCard = (
      <ErrorState
        title="Couldn’t read the fleet"
        reason={control.error ? readFailureReason(control.error) : live.data?.reason ?? null}
        onRetry={poll}
      />
    );
  } else {
    fleetCard = (
      <section className={cx(ui.card, styles.fleetCard)} aria-label="Fleet state">
        <div className={ui.spread}>
          <span className={styles.cardTitle}>Fleet</span>
          <Badge tone={HEADLINE_TONE[fleet.headline]} dot pulse={fleet.headline === 'running' && (fleet.building ?? 0) > 0}>{fleet.label}</Badge>
        </div>
        <p className={styles.detail}>{fleet.detail}</p>
        {fleet.killEngaged ? (
          <Banner tone="danger">
            <span className={ui.stack}>
              <span>{kill?.note || kill?.reason || 'The kill switch is engaged: nothing autonomous runs, and the agents’ write tools refuse.'}</span>
              <span>Release it on your Mac: <code className={ui.mono}>ashlr fleet resume</code></span>
            </span>
          </Banner>
        ) : null}
        {canAct && (action || canStop(fleet)) ? (
          <div className={ui.buttonRow}>
            {action ? (
              <Button variant={action.destructive ? 'destructiveTinted' : 'tinted'} disabled={offline} onClick={() => runFleetAction(action)}>
                {action.verb === 'pause' ? 'Pause' : action.verb === 'resume' ? 'Resume' : 'Start fleet'}
              </Button>
            ) : null}
            {canStop(fleet) && STOP ? (
              <Button variant="destructiveTinted" disabled={offline} onClick={() => runFleetAction(STOP)}>
                Stop fleet
              </Button>
            ) : null}
          </div>
        ) : null}
        {!canAct && permissions.actReason ? <p className={ui.faint}>{permissions.actReason}</p> : null}
      </section>
    );
  }

  let liveBody;
  if (live.status === 'loading' && !live.data) liveBody = <SkeletonList rows={2} label="Loading the live fleet" />;
  else if (!snapshot) liveBody = <p className={cx(ui.card, ui.muted)}>{live.data?.reason ?? 'The live fleet view has not answered yet.'}</p>;
  else {
    liveBody = (
      <div className={ui.stack}>
        <div className={styles.stats}>
          <Stat label="Building" value={count(snapshot.summary.building)} />
          <Stat label="Queued" value={count(snapshot.summary.queued)} />
          <Stat label="Parked" value={count(snapshot.summary.parked)} />
          <Stat label="Landed today" value={count(snapshot.summary.mergedToday)} />
        </div>
        {snapshot.lanes.length > 0 ? (
          <div className={ui.group} aria-label="Lanes">
            {snapshot.lanes.map((lane) => (
              <Row
                key={lane.lane}
                title={LANE_LABEL[lane.lane] ?? lane.lane}
                subtitle={lane.capReason ?? undefined}
                trailing={lane.slots === 0 ? 'off' : `${lane.busy} of ${lane.slots} busy`}
              />
            ))}
          </div>
        ) : null}
      </div>
    );
  }

  let budgetBody;
  if (budget.status === 'loading' && !budget.data) budgetBody = <SkeletonList rows={1} label="Loading the budget mode" />;
  else if (!budget.data) budgetBody = <p className={cx(ui.card, ui.muted)}>{budget.error ? readFailureReason(budget.error) : 'The budget has not answered yet.'}</p>;
  else {
    const selected = BUDGET_MODE_OPTIONS.find((o) => o.value === currentMode);
    budgetBody = (
      <div className={ui.stack}>
        <div className={ui.chips} role="group" aria-label="Budget mode">
          {BUDGET_MODE_OPTIONS.map((o) => {
            const above = modeAboveCeiling(o.value, ceiling);
            return (
              <button
                key={o.value}
                type="button"
                className={ui.chip}
                aria-pressed={o.value === currentMode}
                disabled={!canAct || offline || above}
                onClick={() => chooseMode(o.value)}
              >
                {o.label}
              </button>
            );
          })}
        </div>
        <p className={ui.muted}>{selected?.description ?? 'The Mac reported a mode this phone doesn’t know.'}</p>
        {ceiling && BUDGET_MODE_OPTIONS.some((o) => modeAboveCeiling(o.value, ceiling)) ? (
          <p className={ui.faint}>Above {modeLabel(ceiling)} is off: the grant caps spending there. Raise the ceiling with a new grant on your Mac.</p>
        ) : null}
      </div>
    );
  }

  let grantBody;
  if (authority.status === 'loading' && !authority.data) grantBody = <SkeletonList rows={2} label="Loading the grant" />;
  else if (!status) grantBody = <p className={cx(ui.card, ui.muted)}>{authority.data?.reason ?? 'The authority service has not answered yet.'}</p>;
  else {
    const repos = status.grant.repos;
    grantBody = (
      <div className={ui.group}>
        <Row
          title="Autonomy"
          subtitle={status.effectiveSwitch !== status.switch ? status.effectiveReason ?? undefined : undefined}
          trailing={status.effectiveSwitch === status.switch ? SWITCH_WORD[status.switch] : `${SWITCH_WORD[status.switch]} · in force: ${SWITCH_WORD[status.effectiveSwitch]}`}
        />
        <Row
          title="Grant"
          subtitle={status.grant.reason ?? (expiry ? `Until ${expiry.until}` : undefined)}
          trailing={(
            <>
              <Badge tone={GRANT_TONE[status.grant.state] ?? 'neutral'}>{GRANT_WORD[status.grant.state] ?? status.grant.state}</Badge>
              {expiry ? <span>{expiry.text}</span> : null}
            </>
          )}
        />
        <Row
          title="Repos"
          trailing={`${repos.length}`}
          onClick={repos.length > 0 ? () => setReposOpen((o) => !o) : undefined}
          chevron={false}
          label={repos.length > 0 ? `${reposOpen ? 'Hide' : 'Show'} ${repos.length} granted repos` : undefined}
        />
        {reposOpen ? (
          <ul className={styles.repoList}>
            {repos.map((r) => <li key={r.nameWithOwner}><span className={ui.mono}>{r.nameWithOwner}</span> <span className={ui.faint}>{r.stage}</span></li>)}
          </ul>
        ) : null}
        <Row title="Engines" trailing={status.grant.engines.length > 0 ? status.grant.engines.map((e) => LANE_LABEL[e] ?? e).join(', ') : '—'} />
        <Row title="Max budget mode" trailing={modeLabel(status.grant.maxMode)} />
      </div>
    );
  }

  const decisionList = decisions.data?.value?.decisions ?? null;
  const endedRuns: FleetLiveRun[] = (snapshot?.runs ?? []).filter((r) => r.endedAt && r.outcome && RUN_OUTCOME[r.outcome]).slice(0, DECISION_ROWS);
  const now = Date.now();
  let decisionsBody;
  if (decisions.status === 'loading' && !decisions.data) decisionsBody = <SkeletonList rows={3} label="Loading recent decisions" />;
  else if (decisionList) {
    decisionsBody = decisionList.length === 0 ? (
      <p className={cx(ui.card, ui.muted)}>No decisions yet. Each fleet PR the gates judge shows here: landed, refused, or held for you.</p>
    ) : (
      <div className={ui.group}>
        {decisionList.slice(0, DECISION_ROWS).map((d) => (
          <Row
            key={`${d.proposalId}-${d.at}`}
            leading={<Badge tone={toneOf(OUTCOME_TONE[d.outcome])}>{DECISION_WORD[d.outcome]}</Badge>}
            title={d.prNumber !== null ? `${repoShort(d.repo)} #${d.prNumber}` : repoShort(d.repo)}
            subtitle={d.why}
            trailing={ago(d.at, now)}
          />
        ))}
      </div>
    );
  } else {
    const why = decisions.data?.reason ?? (decisions.error ? readFailureReason(decisions.error) : 'The decisions ledger has not answered.');
    decisionsBody = (
      <div className={ui.stack}>
        <p className={ui.faint}>{why}{endedRuns.length > 0 ? ' Showing finished runs instead.' : ''}</p>
        {endedRuns.length > 0 ? (
          <div className={ui.group}>
            {endedRuns.map((r) => {
              const o = RUN_OUTCOME[r.outcome!]!;
              const where = r.prNumber !== null ? `${repoShort(r.repo)} #${r.prNumber}` : repoShort(r.repo);
              return (
                <Row
                  key={r.id}
                  leading={<Badge tone={o.tone}>{o.word}</Badge>}
                  title={r.title}
                  subtitle={r.hold?.reason ? `${where} · ${r.hold.reason}` : where}
                  trailing={r.endedAt ? ago(r.endedAt, now) : undefined}
                />
              );
            })}
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <Screen title="Fleet" onBack={() => navigate({ screen: 'more' })} backLabel="More" onRefresh={refreshFleetScreen} header={header} label="Fleet">
      {fleetCard}
      <Section title="Right now" flat>{liveBody}</Section>
      <Section title="Budget mode" flat>{budgetBody}</Section>
      <Section title="Grant" flat footer="Grants are signed on your Mac with Touch ID.">{grantBody}</Section>
      <Section title="Recent decisions" flat>{decisionsBody}</Section>
    </Screen>
  );
}
