/**
 * Fakes for the 3.15 automations tests: a scripted `gh api -i`, a fixed
 * clock, a standing policy, and lane entry points that record their calls.
 * Nothing here touches the network, GitHub, a real lane or a real ~/.ashlr.
 */
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import type { AutomationEngineDeps, AutomationLaneDeps, AutomationLaneRef, LaneStatus } from '../../src/core/automations/index.js';

// Lane types derived from the automations seam, so this helper imports no
// authority / fleet source (and stays out of the Tier-1 test set).
type Lanes = Required<AutomationLaneDeps>;
type EffectivePolicy = NonNullable<Awaited<ReturnType<Lanes['policy']>>>;
type CloudInternalLaunch = Parameters<Lanes['launchCloud']>[0];
type CloudLaunchResponse = Awaited<ReturnType<Lanes['launchCloud']>>;
type DevinInternalLaunch = Parameters<Lanes['launchDevin']>[0];
type DevinLaunchResponse = Awaited<ReturnType<Lanes['launchDevin']>>;
type FleetTaskInput = Parameters<Lanes['enqueueFleet']>[0];
type EnqueueTaskResult = Awaited<ReturnType<Lanes['enqueueFleet']>>;

export interface GhCall {
  args: string[];
}

export type GhHandler = (args: string[]) => { status: number; body?: unknown; etag?: string | null } | { fail: string };

/** `gh api -i` style output for a status + JSON body. */
export function ghInclude(status: number, body: unknown, etag: string | null = null): string {
  const reason = status === 200 ? 'OK' : status === 304 ? 'Not Modified' : 'Error';
  const headers = [`HTTP/2.0 ${status} ${reason}`, 'Content-Type: application/json; charset=utf-8'];
  if (etag) headers.push(`Etag: ${etag}`);
  return `${headers.join('\r\n')}\r\n\r\n${body === undefined ? '' : JSON.stringify(body)}`;
}

export function fakeGh(handler: GhHandler): { gh: NonNullable<AutomationEngineDeps['gh']>; calls: GhCall[] } {
  const calls: GhCall[] = [];
  const gh = async (args: string[]) => {
    calls.push({ args: [...args] });
    const r = handler(args);
    if ('fail' in r) return { ok: false, stdout: '', stderr: r.fail };
    return { ok: r.status < 400, stdout: ghInclude(r.status, r.body, r.etag ?? null), stderr: '' };
  };
  return { gh, calls };
}

/** The `-f key=value` params of a recorded gh call. */
export function ghParams(args: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '-f') {
      const [k, ...v] = args[i + 1]!.split('=');
      out[k!] = v.join('=');
    }
  }
  return out;
}

export function policyFor(repos: string[]): EffectivePolicy {
  return { repos: repos.map((nameWithOwner) => ({ nameWithOwner })) } as unknown as EffectivePolicy;
}

export interface FakeLanes {
  deps: Required<Pick<AutomationEngineDeps, 'launchCloud' | 'launchDevin' | 'enqueueFleet' | 'estimateUsd' | 'laneStatus' | 'policy' | 'killActive'>>;
  cloudCalls: CloudInternalLaunch[];
  devinCalls: DevinInternalLaunch[];
  fleetCalls: FleetTaskInput[];
  statuses: Map<string, LaneStatus>;
  set: {
    kill(on: boolean): void;
    policy(p: EffectivePolicy | null): void;
    cloud(fn: (req: CloudInternalLaunch) => CloudLaunchResponse): void;
    devin(fn: (req: DevinInternalLaunch) => DevinLaunchResponse): void;
    fleet(fn: (input: FleetTaskInput) => EnqueueTaskResult): void;
  };
}

let seq = 0;

export function cloudOk(req: CloudInternalLaunch): CloudLaunchResponse {
  seq += 1;
  const id = `ct_20260927T1200_${String(seq).padStart(6, '0').slice(-6)}`;
  return {
    ok: true,
    task: { id, repo: req.repo, title: req.title ?? '', sessionUrl: `https://claude.ai/code/session_${seq}`, estimatedCostUsd: 3 } as never,
    error: null,
    failure: null,
  };
}

export function devinOk(req: DevinInternalLaunch): DevinLaunchResponse {
  seq += 1;
  return {
    ok: true,
    task: { id: `dv_20260927T1200_${String(seq).padStart(6, '0').slice(-6)}`, repo: req.repo, sessionUrl: `https://app.devin.ai/sessions/${seq}` } as never,
    error: null,
    failure: null,
  };
}

export function fleetOk(input: FleetTaskInput): EnqueueTaskResult {
  return { ok: true, task: { id: randomUUID(), repo: input.repo, title: input.title, dedupeKey: input.dedupeKey ?? null } as never, deduped: false };
}

export function fakeLanes(initialPolicy: EffectivePolicy | null = policyFor(['acme/app', 'acme/web'])): FakeLanes {
  let kill = false;
  let policy = initialPolicy;
  let cloud = cloudOk;
  let devin = devinOk;
  let fleet = fleetOk;
  const lanes: FakeLanes = {
    cloudCalls: [],
    devinCalls: [],
    fleetCalls: [],
    statuses: new Map(),
    deps: {
      launchCloud: async (req) => { lanes.cloudCalls.push(req); return cloud(req); },
      launchDevin: async (req) => { lanes.devinCalls.push(req); return devin(req); },
      enqueueFleet: (input) => { lanes.fleetCalls.push(input); return fleet(input); },
      estimateUsd: (lane) => (lane === 'cloud' ? 3 : lane === 'devin' ? 22.5 : 0),
      laneStatus: (ref: AutomationLaneRef) => lanes.statuses.get(ref.id) ?? 'active',
      policy: () => policy,
      killActive: () => kill,
    },
    set: {
      kill: (on) => { kill = on; },
      policy: (p) => { policy = p; },
      cloud: (fn) => { cloud = fn; },
      devin: (fn) => { devin = fn; },
      fleet: (fn) => { fleet = fn; },
    },
  };
  return lanes;
}

/** A settable clock (local-time sensitive tests pass explicit local Dates). */
export function fakeClock(start: Date): { now: () => Date; set(d: Date): void; advance(ms: number): void } {
  let t = start.getTime();
  return {
    now: () => new Date(t),
    set: (d) => { t = d.getTime(); },
    advance: (ms) => { t += ms; },
  };
}

/** Point ASHLR_HOME at a fresh private temp dir; returns a restore function. */
export function isolateAshlrHome(): () => void {
  const previous = process.env['ASHLR_HOME'];
  process.env['ASHLR_HOME'] = join(realpathSync(mkdtempSync(join(tmpdir(), 'ashlr-automations-'))), '.ashlr');
  return () => {
    if (previous === undefined) delete process.env['ASHLR_HOME'];
    else process.env['ASHLR_HOME'] = previous;
  };
}
