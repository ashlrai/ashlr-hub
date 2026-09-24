/**
 * `AshlrConfig.reasoning.codexDesktop` (V3.10) — the explicit opt-in for
 * ingesting Mason's INTERACTIVE Codex Desktop rollouts into the reasoning
 * store. Pins that the typed field survives loadConfig's defaults merge and is
 * what reasoning/ingest-codex.ts actually reads, and that it stays OFF unless
 * set to exactly `true`.
 *
 * HOME-isolated: CONFIG_PATH resolves from the per-worker tmp HOME that
 * test/setup/home.ts installs, and the home-isolation guard refuses any write
 * under the real ~/.ashlr.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';

import { CONFIG_DIR, CONFIG_PATH, loadConfigReadOnly } from '../src/core/config.js';
import { codexInteractiveOptIn } from '../src/core/reasoning/ingest-codex.js';
import type { AshlrConfig } from '../src/core/types.js';

function writeConfig(extra: Record<string, unknown>): void {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify({ version: 1, ...extra }), { mode: 0o600 });
}

describe('AshlrConfig.reasoning.codexDesktop', () => {
  const savedEnv = process.env['ASHLR_REASONING_CODEX_DESKTOP'];
  afterEach(() => {
    rmSync(CONFIG_PATH, { force: true });
    if (savedEnv === undefined) delete process.env['ASHLR_REASONING_CODEX_DESKTOP'];
    else process.env['ASHLR_REASONING_CODEX_DESKTOP'] = savedEnv;
  });

  it('is typed on AshlrConfig (compile-time) and read by the ingest opt-in', () => {
    delete process.env['ASHLR_REASONING_CODEX_DESKTOP'];
    const on: Pick<AshlrConfig, 'reasoning'> = { reasoning: { codexDesktop: true } };
    const off: Pick<AshlrConfig, 'reasoning'> = { reasoning: {} };
    expect(codexInteractiveOptIn(on)).toBe(true);
    expect(codexInteractiveOptIn(off)).toBe(false);
    expect(codexInteractiveOptIn({})).toBe(false);
  });

  it('survives the persisted-config defaults merge', () => {
    delete process.env['ASHLR_REASONING_CODEX_DESKTOP'];
    writeConfig({ reasoning: { codexDesktop: true } });
    const cfg = loadConfigReadOnly();
    expect(cfg.reasoning?.codexDesktop).toBe(true);
    expect(codexInteractiveOptIn(cfg)).toBe(true);
  });

  it('defaults OFF: absent, false, or a truthy non-boolean never opts in', () => {
    delete process.env['ASHLR_REASONING_CODEX_DESKTOP'];
    expect(codexInteractiveOptIn(loadConfigReadOnly())).toBe(false);
    writeConfig({ reasoning: { codexDesktop: false } });
    expect(codexInteractiveOptIn(loadConfigReadOnly())).toBe(false);
    writeConfig({ reasoning: { codexDesktop: 'yes' } });
    expect(codexInteractiveOptIn(loadConfigReadOnly())).toBe(false);
  });
});
