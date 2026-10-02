/**
 * R3b (INT5 request): fleet/manager.ts exports `judgeCredentialEnv(cmd, cfg)`
 * unchanged, so the Leader's Claude transport (vision/leader-seat.ts
 * loadJudgeCredentialHook, looked up BY NAME) uses the judges' one rule
 * instead of a copy. Pins: the real module exports it, the Leader finds it,
 * and exporting widened nothing — the token still reaches only a restricted
 * command, and only from the registered source. HOME-isolated; nothing spawns.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { defaultConfig } from '../src/core/config.js';
import { judgeCredentialEnv, setJudgeCredentialSource, resolveFrontierJudgeClient } from '../src/core/fleet/manager.js';
import { restrictClaudeCommand } from '../src/core/run/engine-registry.js';
import { loadJudgeCredentialHook } from '../src/core/vision/leader-seat.js';
import type { EngineCommand } from '../src/core/types.js';

const CFG = defaultConfig();
const BASE: EngineCommand = { bin: '/opt/claude-a/claude', args: ['-p', '--output-format', 'json'] } as EngineCommand;

afterEach(() => {
  setJudgeCredentialSource(null);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('judgeCredentialEnv export (R3b)', () => {
  it('the real manager module exports it and the Leader resolves it (Claude becomes a Leader candidate)', async () => {
    expect(typeof judgeCredentialEnv).toBe('function');
    const hook = await loadJudgeCredentialHook(CFG);
    expect(hook).not.toBeNull();
    setJudgeCredentialSource(async () => ({ CLAUDE_CODE_OAUTH_TOKEN: 'fixture-token' }));
    const restricted = restrictClaudeCommand(BASE)!;
    const env = await hook!(restricted);
    expect(env).not.toBe('refused');
    expect((env as NodeJS.ProcessEnv)['CLAUDE_CODE_OAUTH_TOKEN']).toBe('fixture-token');
  });

  it('exporting widened nothing: an unrestricted command is refused, a bad overlay is refused, no source ⇒ default env', async () => {
    expect(await judgeCredentialEnv(BASE, CFG)).toBeUndefined(); // no source registered
    setJudgeCredentialSource(async () => ({ CLAUDE_CODE_OAUTH_TOKEN: 'fixture-token' }));
    expect(await judgeCredentialEnv(BASE, CFG)).toBe('refused'); // tools still open
    setJudgeCredentialSource(async () => ({ ANTHROPIC_API_KEY: 'sk-not-allowed' }));
    expect(await judgeCredentialEnv(restrictClaudeCommand(BASE)!, CFG)).toBe('refused');
    setJudgeCredentialSource(async () => { throw new Error('custody locked'); });
    expect(await judgeCredentialEnv(restrictClaudeCommand(BASE)!, CFG)).toBe('refused');
  });
});


describe('exact critic contact admission', () => {
  it('forwards the same fence after awaited Claude credential setup to the exact spawn seam', async () => {
    const engines = await import('../src/core/run/engines.js');
    vi.spyOn(engines, 'engineInstalled').mockReturnValue(true);
    vi.spyOn(engines, 'buildEngineCommand').mockReturnValue(BASE);
    const spawn = vi.spyOn(engines, 'spawnEngine').mockResolvedValue({ ok: false, output: '', error: 'cancelled', terminationReason: 'cancelled' });
    let current = true; const admission = () => current;
    setJudgeCredentialSource(async () => { await Promise.resolve(); current = false; return { CLAUDE_CODE_OAUTH_TOKEN: 'fixture-token' }; });
    const cfg = { ...CFG, foundry: { ...CFG.foundry, managerJudgeEngine: 'claude', managerJudgeModel: 'claude-sonnet-4-5', judgeAllowedBackends: ['claude'], confinement: { enabled: false } } };
    const client = resolveFrontierJudgeClient(cfg)!;
    expect(client).not.toBeNull();
    await client.complete('system', 'fixture diff', undefined, admission);
    expect(spawn).toHaveBeenCalledOnce();
    const options = spawn.mock.calls[0]![2]!;
    expect(options.selectedOutcomeAdmission).toBe(admission); expect(options.selectedOutcomeAdmission!()).toBe(false);
  });
  it('the direct local critic refuses at its actual fetch boundary', async () => {
    const fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock);
    const cfg = { ...CFG, foundry: { ...CFG.foundry, managerJudgeEngine: 'local', managerJudgeModel: 'fixture-local', judgeAllowedBackends: ['local'] } };
    const client = resolveFrontierJudgeClient(cfg)!; expect(client).not.toBeNull();
    await expect(client.complete('system', 'fixture diff', undefined, () => false)).rejects.toMatchObject({ name: 'SelectedOutcomeAdmissionRefusal' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
