/**
 * cli-jev-315 — `ashlr jev status|test`. Deps are injected; the one test that
 * uses the real wiring runs unkeyed (deterministic path, zero requests).
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderJevStatus, runJevCli, type JevCliDeps } from '../src/cli/jev.js';
import type { Decision, JevStatus } from '../src/core/decide/types.js';
import { TYPESAFE_API_KEY_ENV } from '../src/core/classify/typesafe-client.js';

const STATUS: JevStatus = {
  enabled: true, keyed: true, day: '2026-09-27', decisionsToday: 4, callsToday: 3, dailyCallBudget: 1500,
  inputTokensToday: 1200, outputTokensToday: 90, estCostUsdToday: 0.0008, fallbackRateToday: 0.25,
  avgConfidenceToday: 0.91, avgLatencyMsToday: 410, disabledKinds: [],
  byKind: [{ kind: 'operator-intent', decisions: 4, jev: 3, fallback: 1, cached: 1, calls: 3, avgConfidence: 0.91, fallbackRate: 0.25, estCostUsd: 0.0008, avgLatencyMs: 410, topFallbackReasons: [{ reason: 'below-threshold', count: 1 }] }],
};

function deps(over: Partial<JevCliDeps> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const d: JevCliDeps = {
    loadConfig: () => ({}) as never,
    status: vi.fn(() => STATUS),
    test: vi.fn(async (): Promise<Decision<unknown>> => ({
      kind: 'operator-intent', value: 'status-request', path: 'jev', confidence: 0.93, threshold: 0.8, cached: false,
      jevLabel: 'status-request', jevConfidence: 0.93, model: 'jev-1.13.0', durationMs: 412,
    })),
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    ...over,
  };
  return { d, out, err };
}

describe('ashlr jev', () => {
  it('status renders the per-kind table', async () => {
    const { d, out } = deps();
    expect(await runJevCli(['status'], d)).toBe(0);
    const text = out.join('\n');
    expect(text).toContain('Jev: ON');
    expect(text).toContain('4 decisions · 3/1500 paid calls · 25% fell back · avg confidence 0.91');
    expect(text).toMatch(/operator-intent\s+4\s+3\s+25%\s+0\.91/);
    expect(text).toContain('below-threshold×1');
  });

  it('status --json is the raw status', async () => {
    const { d, out } = deps();
    expect(await runJevCli(['status', '--json'], d)).toBe(0);
    expect(JSON.parse(out.join('\n'))).toEqual(STATUS);
  });

  it('test runs one decision and shows which path won', async () => {
    const { d, out } = deps();
    expect(await runJevCli(['test', 'how', 'is', 'it', 'going?', '--kind', 'intent'], d)).toBe(0);
    expect(d.test).toHaveBeenCalledWith('intent', 'how is it going?', {});
    expect(out.join('\n')).toContain('path: jev (cleared the gate)');
    expect(out.join('\n')).toContain('confidence: 0.93 (threshold 0.80)');
  });

  it('usage errors exit 2', async () => {
    const { d, err } = deps();
    expect(await runJevCli(['test'], d)).toBe(2);
    expect(await runJevCli(['test', 'x', '--kind', 'nope'], d)).toBe(2);
    expect(await runJevCli(['frobnicate'], d)).toBe(2);
    expect(err.join('\n')).toContain('Usage: ashlr jev');
  });

  it('renders the not-set-up state honestly', () => {
    expect(renderJevStatus({ ...STATUS, keyed: false })[0]).toContain('NOT SET UP');
    expect(renderJevStatus({ ...STATUS, enabled: false, disabledBy: 'ASHLR_JEV_DISABLE is set' })[0]).toContain('OFF (ASHLR_JEV_DISABLE is set)');
  });
});

describe('ashlr jev — real wiring, unkeyed', () => {
  const saved = { ...process.env };
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'jev-cli-'));
    process.env['ASHLR_HOME'] = home;
    delete process.env[TYPESAFE_API_KEY_ENV];
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('no network in tests'); }));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    rmSync(home, { recursive: true, force: true });
    for (const k of ['ASHLR_HOME', TYPESAFE_API_KEY_ENV]) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('test falls back deterministically with zero requests', async () => {
    const out: string[] = [];
    const code = await runJevCli(['test', 'bump react to 19', '--kind', 'task-class'], { out: (l) => out.push(l), err: () => undefined });
    expect(code).toBe(0);
    expect(out.join('\n')).toContain('decision: task-class → deps');
    expect(out.join('\n')).toContain('fallback — no-key');
    expect(fetch).not.toHaveBeenCalled();
  });
});
