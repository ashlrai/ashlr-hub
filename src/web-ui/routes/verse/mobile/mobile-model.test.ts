/**
 * The phone app's pure models: the hash router, this device's permissions
 * and the step-up seam, reachability, and the fleet's one word + one button.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { FleetLiveSnapshotV1 } from '../../../../core/fleet/fleet-types.js';
import type { VerseControlSnapshot } from '../../../../core/verse/control-types.js';
import { reachabilityOf, sinceText } from './connectivity.js';
import { canShowActions, registerStepUpProvider, requestStepUp, resolveDevicePermissions } from './device-permissions.js';
import { canStop, fleetStateView } from './fleet-state.js';
import { formatMobileHash, parseMobileHash, tabOf, tabRoot, type MobileRoute } from './mobile-router.js';

describe('mobile-router', () => {
  it('round-trips every route through the hash', () => {
    const routes: MobileRoute[] = [
      { screen: 'home' },
      { screen: 'agents' },
      { screen: 'agent', id: 'abc', pane: 'transcript' },
      { screen: 'agent', id: 'a b/c', pane: 'changes' },
      { screen: 'new' },
      { screen: 'needs' },
      { screen: 'leader' },
      { screen: 'more' },
      { screen: 'fleet' },
    ];
    for (const route of routes) expect(parseMobileHash(formatMobileHash(route))).toEqual(route);
    expect(formatMobileHash({ screen: 'agent', id: 'a b/c', pane: 'changes' })).toBe('#/agents/a%20b%2Fc/changes');
  });

  it('reads anything unknown or malformed as Home, never an error', () => {
    expect(parseMobileHash('')).toEqual({ screen: 'home' });
    expect(parseMobileHash('#/')).toEqual({ screen: 'home' });
    expect(parseMobileHash('#/workbench/chat')).toEqual({ screen: 'home' });
    expect(parseMobileHash('#/agents/%E0%A4%A')).toEqual({ screen: 'agents' });
    expect(parseMobileHash('#/agents/x/whatever')).toEqual({ screen: 'agent', id: 'x', pane: 'transcript' });
  });

  it('maps screens to tabs, and a tab to its root', () => {
    expect(tabOf({ screen: 'agent', id: 'x', pane: 'changes' })).toBe('agents');
    expect(tabOf({ screen: 'new' })).toBe('agents');
    expect(tabOf({ screen: 'fleet' })).toBe('more');
    expect(tabRoot('needs')).toEqual({ screen: 'needs' });
  });
});

describe('device permissions', () => {
  const base = { authenticated: true, dispatchEnabled: true, holdsMutation: true, scopes: null };

  it('unlocked only with a session, dispatch and the held token', () => {
    const p = resolveDevicePermissions(base);
    expect(p).toMatchObject({ read: true, act: 'unlocked', actReason: null, source: 'session' });
    expect(canShowActions(p)).toBe(true);
  });

  it('locked — actions still shown — when the token is not held', () => {
    const p = resolveDevicePermissions({ ...base, holdsMutation: false });
    expect(p.act).toBe('locked');
    expect(p.actReason).toMatch(/mutation token/);
    expect(canShowActions(p)).toBe(true);
  });

  it('unavailable — actions hidden — without dispatch, without a session, or with a read-only pairing', () => {
    const noDispatch = resolveDevicePermissions({ ...base, dispatchEnabled: false });
    expect(noDispatch.act).toBe('unavailable');
    expect(noDispatch.actReason).toMatch(/without dispatch/);
    expect(canShowActions(noDispatch)).toBe(false);
    expect(resolveDevicePermissions({ ...base, authenticated: false })).toMatchObject({ read: false, act: 'unavailable' });
    const readOnly = resolveDevicePermissions({ ...base, scopes: { read: true, act: false, label: "Mason's iPhone" } });
    expect(readOnly).toMatchObject({ act: 'unavailable', source: 'device', deviceLabel: "Mason's iPhone" });
  });

  it('device scopes can only remove authority, never add it', () => {
    const p = resolveDevicePermissions({ ...base, dispatchEnabled: false, scopes: { read: true, act: true } });
    expect(p.act).toBe('unavailable');
    const noRead = resolveDevicePermissions({ ...base, scopes: { read: false, act: true } });
    expect(noRead).toMatchObject({ read: false, act: 'unavailable' });
  });

  it('dispatch not yet known hides action controls even when the token is held', () => {
    for (const holdsMutation of [false, true]) {
      const permissions = resolveDevicePermissions({ ...base, dispatchEnabled: null, holdsMutation });
      expect(permissions.act).toBe('unavailable');
      expect(canShowActions(permissions)).toBe(false);
    }
  });
});

describe('step-up seam', () => {
  afterEach(() => registerStepUpProvider(null));

  it('passes with no provider (the mutation token is the step-up)', async () => {
    await expect(requestStepUp({ action: 'Land', irreversible: true })).resolves.toBe(true);
  });

  it('asks a registered provider for irreversible actions only; a throw refuses', async () => {
    const asked: string[] = [];
    registerStepUpProvider(async (req) => {
      asked.push(req.action);
      return req.action !== 'Veto';
    });
    await expect(requestStepUp({ action: 'Land', irreversible: true })).resolves.toBe(true);
    await expect(requestStepUp({ action: 'Veto', irreversible: true })).resolves.toBe(false);
    await expect(requestStepUp({ action: 'Send', irreversible: false })).resolves.toBe(true);
    expect(asked).toEqual(['Land', 'Veto']);
    registerStepUpProvider(async () => {
      throw new Error('no biometrics');
    });
    await expect(requestStepUp({ action: 'Land', irreversible: true })).resolves.toBe(false);
  });
});

describe('reachability', () => {
  it('offline beats everything; a stale poll is an unreachable Mac', () => {
    expect(reachabilityOf(false, { status: 'ready', data: null, error: null })).toBe('offline');
    expect(reachabilityOf(true, { status: 'ready', data: null, error: null })).toBe('live');
    expect(reachabilityOf(true, { status: 'stale', data: null, error: 'x' })).toBe('unreachable');
    expect(reachabilityOf(true, { status: 'loading', data: null, error: null })).toBe('connecting');
    expect(reachabilityOf(true, { status: 'idle', data: null, error: null })).toBe('connecting');
  });

  it('a 404 (route not in this build) is the Mac answering; a failure with no data is not', () => {
    expect(reachabilityOf(true, { status: 'unavailable', data: null, error: null })).toBe('live');
    expect(reachabilityOf(true, { status: 'unavailable', data: null, error: 'The server did not answer.' })).toBe('unreachable');
  });

  it('dates the last update in words', () => {
    const now = Date.parse('2026-09-27T12:00:00Z');
    expect(sinceText(null, now)).toBe('No update yet');
    expect(sinceText(now - 10_000, now)).toBe('Updated just now');
    expect(sinceText(now - 5 * 60_000, now)).toBe('Updated 5 min ago');
    expect(sinceText(now - 3 * 3_600_000, now)).toBe('Updated 3 h ago');
    expect(sinceText(now - 50 * 3_600_000, now)).toBe('Updated 2 d ago');
  });
});

function control(partial: { running?: boolean | null; paused?: boolean; kill?: boolean; spend?: number | null } = {}): VerseControlSnapshot {
  return {
    daemon: { running: partial.running ?? true },
    pause: { state: partial.paused ? 'paused' : 'running', sourceState: 'healthy', reason: partial.paused ? 'Paused from Verse.' : '', pausedAt: null, by: null, note: '' },
    killSwitch: { state: partial.kill ? 'active' : 'inactive', sourceState: 'healthy', reason: partial.kill ? 'Emergency stop engaged 10:02.' : '', note: 'Stops everything.' },
    spend: { todayUsd: partial.spend ?? 1.5, todayDate: '2026-09-27', dailyBudgetUsd: 20 },
  } as unknown as VerseControlSnapshot;
}

function live(state: FleetLiveSnapshotV1['state'], building: number | null = 0, reason: string | null = null): FleetLiveSnapshotV1 {
  return {
    state,
    stateReason: reason,
    summary: { building, queued: 2, parked: 0, waitingVerify: 0, mergedToday: 1, revertsToday: 0, merged7d: 3, postMergeGreenPct7d: null, cycleTimeP50Ms7d: null },
  } as unknown as FleetLiveSnapshotV1;
}

describe('fleetStateView', () => {
  it('Running: pause is the one button, and it needs no confirmation', () => {
    const v = fleetStateView({ control: control(), live: live('running', 3), badge: null });
    expect(v).toMatchObject({ headline: 'running', label: 'Running', building: 3, killEngaged: false });
    expect(v.detail).toBe('3 runs building · 2 queued');
    expect(v.action).toMatchObject({ kind: 'daemon', verb: 'pause', confirm: null });
    expect(canStop(v)).toBe(true);
  });

  it('Running but idle says so', () => {
    const v = fleetStateView({ control: control(), live: live('idle', 0), badge: null });
    expect(v.headline).toBe('running');
    expect(v.detail).toBe('Idle between tasks.');
  });

  it('Paused: resume, confirmed', () => {
    const v = fleetStateView({ control: control({ paused: true }), live: live('paused'), badge: null });
    expect(v.headline).toBe('paused');
    expect(v.action).toMatchObject({ verb: 'resume' });
    expect(v.action && v.action.kind === 'daemon' ? v.action.confirm?.confirmLabel : null).toBe('Resume');
  });

  it('Stopped with no daemon: start, confirmed', () => {
    const v = fleetStateView({ control: control({ running: false }), live: null, badge: null });
    expect(v.headline).toBe('stopped');
    expect(v.action).toMatchObject({ verb: 'start' });
    expect(canStop(v)).toBe(false);
  });

  it('Stopped by the kill switch: no button that could release it — only details', () => {
    const v = fleetStateView({ control: control({ kill: true }), live: live('running', 2), badge: null });
    expect(v).toMatchObject({ headline: 'stopped', killEngaged: true, detail: 'Emergency stop engaged 10:02.' });
    expect(v.action).toEqual({ kind: 'open-fleet', label: 'Details' });
    expect(canStop(v)).toBe(false);
    const byBadge = fleetStateView({ control: null, live: null, badge: { mode: 'autonomous', paused: false, stopped: true, label: 'Stopped' } });
    expect(byBadge.killEngaged).toBe(true);
  });

  it('Blocked when the fleet is dark or the switch is off: see why', () => {
    const dark = fleetStateView({ control: control(), live: live('dark', 0, 'No standing grant is in force.'), badge: null });
    expect(dark).toMatchObject({ headline: 'blocked', detail: 'No standing grant is in force.' });
    expect(dark.action).toEqual({ kind: 'open-fleet', label: 'See why' });
    const off = fleetStateView({ control: control(), live: null, badge: { mode: 'off', paused: false, stopped: false, label: 'Off' } });
    expect(off.headline).toBe('blocked');
  });

  it('Unknown until something reports — no button', () => {
    const v = fleetStateView({ control: null, live: null, badge: null });
    expect(v).toMatchObject({ headline: 'unknown', action: null, building: null });
  });
});
