/**
 * Claude CLI rate_limit_event sensing.
 *
 * These tests keep HOME redirected so the sanitized JSONL store never touches a
 * real ~/.ashlr directory.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AshlrConfig, EngineId } from '../src/core/types.js';

let tmpHome: string;
let origHome: string | undefined;
let origUserProfile: string | undefined;

interface FakeChildControl {
  child: ReturnType<typeof makeFakeChild>;
  resolve(code: number | null, signal: NodeJS.Signals | null, stdoutData?: string, stderrData?: string): void;
}

function makeFakeChild() {
  const stdout = new EventEmitter() as NodeJS.EventEmitter;
  const stderr = new EventEmitter() as NodeJS.EventEmitter;
  const child = new EventEmitter() as NodeJS.EventEmitter & {
    stdout: typeof stdout;
    stderr: typeof stderr;
    killed: boolean;
    kill: () => void;
    pid: number;
  };
  child.stdout = stdout;
  child.stderr = stderr;
  child.killed = false;
  child.kill = () => { child.killed = true; };
  child.pid = 313;
  return child;
}

function makeFakeSpawnControl(): FakeChildControl {
  const child = makeFakeChild();
  return {
    child,
    resolve(code, signal, stdoutData = '', stderrData = '') {
      if (stdoutData) child.stdout.emit('data', Buffer.from(stdoutData));
      if (stderrData) child.stderr.emit('data', Buffer.from(stderrData));
      child.emit('close', code, signal);
    },
  };
}

function baseCfg(): AshlrConfig {
  return {
    version: 1,
    roots: ['/tmp'],
    editor: 'cursor',
    staleDays: 30,
    categories: {},
    tidyRules: [],
    keepers: [],
    models: { lmstudio: '', ollama: '', providerChain: [] },
    telemetry: {},
    tools: {},
  } as AshlrConfig;
}

function cfgWithClaudeResource(protectPct = 85): AshlrConfig {
  return {
    ...baseCfg(),
    foundry: {
      allowedBackends: ['claude'] as EngineId[],
      claudeResource: { protectPct },
    },
  } as AshlrConfig;
}

function eventLine(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: 'rate_limit_event',
    status: 'allowed_warning',
    resetsAt: Math.floor(Date.now() / 1000) + 3600,
    rateLimitType: 'seven_day',
    utilization: 1,
    ...overrides,
  });
}

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'ashlr-m313-'));
  origHome = process.env['HOME'];
  origUserProfile = process.env['USERPROFILE'];
  process.env['HOME'] = tmpHome;
  process.env['USERPROFILE'] = tmpHome;
  vi.resetModules();
});

afterEach(() => {
  vi.doUnmock('node:child_process');
  if (origHome === undefined) delete process.env['HOME'];
  else process.env['HOME'] = origHome;
  if (origUserProfile === undefined) delete process.env['USERPROFILE'];
  else process.env['USERPROFILE'] = origUserProfile;
  rmSync(tmpHome, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.resetModules();
});

describe('Claude rate_limit_event persistence', () => {
  it('parses and sanitizes Claude CLI rate-limit metadata only', async () => {
    const { parseClaudeRateLimitEventLine } = await import('../src/core/fabric/claude-rate-limit-event.js');

    const parsed = parseClaudeRateLimitEventLine(eventLine({
      status: 'allowed warning! with spaces',
      capturedAt: 'Thu, 01 Jan 1970 00:00:00 GMT (secret prompt)',
      resetsAt: 1783080000000,
      rateLimitType: 'seven_day',
      utilization: 1,
    }), Date.parse('2026-07-02T00:00:00.000Z'));

    expect(parsed).toMatchObject({
      type: 'rate_limit_event',
      status: 'allowedwarningwithspaces',
      rateLimitType: 'seven_day',
      resetsAt: 1783080000,
      utilization: 1,
      capturedAt: '1970-01-01T00:00:00.000Z',
    });
    expect(parsed?.capturedAt).not.toContain('secret');
    expect(parseClaudeRateLimitEventLine('not json')).toBeNull();
    expect(parseClaudeRateLimitEventLine(JSON.stringify({ type: 'assistant', text: 'hello' }))).toBeNull();
  });

  it('records and reads the newest unexpired event while ignoring expired events', async () => {
    const {
      claudeRateLimitEventsPath,
      recordClaudeRateLimitEventLine,
      readLatestClaudeRateLimitEvent,
    } = await import('../src/core/fabric/claude-rate-limit-event.js');
    const nowMs = Date.parse('2026-07-02T00:00:00.000Z');

    recordClaudeRateLimitEventLine(eventLine({ resetsAt: Math.floor(nowMs / 1000) - 1, utilization: 1 }));
    recordClaudeRateLimitEventLine(eventLine({
      resetsAt: Math.floor(nowMs / 1000) + 600,
      utilization: 0.91,
      prompt: 'do not persist this prompt',
      diff: 'do not persist this diff',
    }));

    const event = readLatestClaudeRateLimitEvent({ nowMs });
    expect(event).toMatchObject({
      rateLimitType: 'seven_day',
      utilization: 0.91,
      resetsAt: Math.floor(nowMs / 1000) + 600,
    });
    const persisted = readFileSync(claudeRateLimitEventsPath(), 'utf8');
    expect(persisted).not.toContain('do not persist');
  });
});

describe('Claude rate_limit_event resource sensing', () => {
  it('maps a fresh weekly CLI event at utilization 1 to exhausted Claude state', async () => {
    const { recordClaudeRateLimitEventLine } = await import('../src/core/fabric/claude-rate-limit-event.js');
    recordClaudeRateLimitEventLine(eventLine({
      resetsAt: Math.floor(Date.now() / 1000) + 3600,
      rateLimitType: 'seven_day',
      utilization: 1,
    }));

    const { getBackendResourceState } = await import('../src/core/fabric/resource-monitor.js');
    const state = await getBackendResourceState('claude', cfgWithClaudeResource());

    expect(state.availability).toBe('exhausted');
    expect(state.usedPct).toBe(100);
    expect(state.capWindow).toBe('7d');
    expect(state.backoffUntilMs).toBeGreaterThan(Date.now());
    expect(state.reason).toContain('CLI rate_limit_event');
  });

  it('maps a fresh five-hour warning above protectPct to throttled Claude state', async () => {
    const { recordClaudeRateLimitEventLine } = await import('../src/core/fabric/claude-rate-limit-event.js');
    recordClaudeRateLimitEventLine(eventLine({
      resetsAt: Math.floor(Date.now() / 1000) + 1800,
      rateLimitType: 'five_hour',
      utilization: 0.9,
    }));

    const { getBackendResourceState } = await import('../src/core/fabric/resource-monitor.js');
    const state = await getBackendResourceState('claude', cfgWithClaudeResource(85));

    expect(state.availability).toBe('throttled');
    expect(state.usedPct).toBe(90);
    expect(state.capWindow).toBe('5h');
    expect(state.reason).toContain('five_hour CLI rate_limit_event');
  });

  it('keeps unexpired weekly exhaustion authoritative over newer five-hour warnings', async () => {
    const { recordClaudeRateLimitEventLine } = await import('../src/core/fabric/claude-rate-limit-event.js');
    const weeklyReset = Math.floor(Date.now() / 1000) + 7200;
    recordClaudeRateLimitEventLine(eventLine({
      resetsAt: weeklyReset,
      rateLimitType: 'seven_day',
      utilization: 1,
    }));
    recordClaudeRateLimitEventLine(eventLine({
      resetsAt: Math.floor(Date.now() / 1000) + 1800,
      rateLimitType: 'five_hour',
      utilization: 0.9,
    }));

    const { getBackendResourceState } = await import('../src/core/fabric/resource-monitor.js');
    const state = await getBackendResourceState('claude', cfgWithClaudeResource(85));

    expect(state.availability).toBe('exhausted');
    expect(state.usedPct).toBe(100);
    expect(state.capWindow).toBe('7d');
    expect(state.resetsAt).toBe(weeklyReset);
  });

  it('does not let low-pressure weekly metadata mask five-hour exhaustion', async () => {
    const { recordClaudeRateLimitEventLine } = await import('../src/core/fabric/claude-rate-limit-event.js');
    const fiveHourReset = Math.floor(Date.now() / 1000) + 1800;
    recordClaudeRateLimitEventLine(eventLine({
      resetsAt: Math.floor(Date.now() / 1000) + 7200,
      rateLimitType: 'seven_day',
      utilization: 0.2,
    }));
    recordClaudeRateLimitEventLine(eventLine({
      resetsAt: fiveHourReset,
      rateLimitType: 'five_hour',
      utilization: 1,
    }));

    const { getBackendResourceState } = await import('../src/core/fabric/resource-monitor.js');
    const state = await getBackendResourceState('claude', cfgWithClaudeResource(85));

    expect(state.availability).toBe('exhausted');
    expect(state.usedPct).toBe(100);
    expect(state.capWindow).toBe('5h');
    expect(state.resetsAt).toBe(fiveHourReset);
  });

  it('invalidates cached snapshots when a fresh CLI event is recorded', async () => {
    const { getResourceSnapshot } = await import('../src/core/fabric/resource-monitor.js');
    const first = await getResourceSnapshot(cfgWithClaudeResource(85));
    expect(first.backends.find((b) => b.backend === 'claude')?.availability).not.toBe('exhausted');

    const { recordClaudeRateLimitEventLine } = await import('../src/core/fabric/claude-rate-limit-event.js');
    const resetsAt = Math.floor(Date.now() / 1000) + 1800;
    recordClaudeRateLimitEventLine(eventLine({
      resetsAt,
      rateLimitType: 'five_hour',
      utilization: 1,
    }));

    const second = await getResourceSnapshot(cfgWithClaudeResource(85));
    const claude = second.backends.find((b) => b.backend === 'claude');
    expect(claude?.availability).toBe('exhausted');
    expect(claude?.capWindow).toBe('5h');
    expect(claude?.resetsAt).toBe(resetsAt);
  });
});

describe('Claude rate_limit_event engine capture', () => {
  it('records rate_limit_event JSONL from claude stderr without changing stdout output', async () => {
    let control: FakeChildControl | null = null;
    vi.doMock('node:child_process', () => ({
      execFileSync: vi.fn(() => Buffer.from('/usr/local/bin/claude')),
      spawnSync: vi.fn(() => ({ status: 0, stdout: Buffer.from('ok'), stderr: Buffer.from('') })),
      spawn: vi.fn(() => {
        control = makeFakeSpawnControl();
        return control.child;
      }),
    }));

    const {
      readLatestClaudeRateLimitEvent,
      claudeRateLimitEventsPath,
    } = await import('../src/core/fabric/claude-rate-limit-event.js');
    const { spawnEngine } = await import('../src/core/run/engines.js');

    const resetsAt = Math.floor(Date.now() / 1000) + 3600;
    const run = spawnEngine(
      { bin: 'claude', args: ['-p', 'test goal'], cwd: tmpHome },
      cfgWithClaudeResource(),
    );

    expect(control).not.toBeNull();
    control!.resolve(
      0,
      null,
      'normal stdout\n',
      eventLine({ resetsAt, prompt: 'secret prompt from stderr' }) + '\n',
    );

    const result = await run;
    expect(result.ok).toBe(true);
    expect(result.output).toBe('normal stdout');
    expect(readLatestClaudeRateLimitEvent({ rateLimitType: 'seven_day' })?.resetsAt).toBe(resetsAt);
    expect(readFileSync(claudeRateLimitEventsPath(), 'utf8')).not.toContain('secret prompt');
  });
});
