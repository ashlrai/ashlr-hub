/**
 * R3b (INT5 request): fleet/manager.ts exports `judgeCredentialEnv(cmd, cfg)`
 * unchanged, so the Leader's Claude transport (vision/leader-seat.ts
 * loadJudgeCredentialHook, looked up BY NAME) uses the judges' one rule
 * instead of a copy. Pins: the real module exports it, the Leader finds it,
 * and exporting widened nothing — the token still reaches only a restricted
 * command, and only from the registered source. HOME-isolated; nothing spawns.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { defaultConfig } from '../src/core/config.js';
import { judgeCredentialEnv, setJudgeCredentialSource } from '../src/core/fleet/manager.js';
import { restrictClaudeCommand } from '../src/core/run/engine-registry.js';
import { loadJudgeCredentialHook } from '../src/core/vision/leader-seat.js';
import type { EngineCommand } from '../src/core/types.js';

const CFG = defaultConfig();
const BASE: EngineCommand = { bin: '/opt/claude-a/claude', args: ['-p', '--output-format', 'json'] } as EngineCommand;

afterEach(() => {
  setJudgeCredentialSource(null);
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
