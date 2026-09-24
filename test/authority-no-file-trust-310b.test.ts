/**
 * V3.10 Track B unit B-U1 — "No trust from files or env" (SPEC-310B §1, §7).
 *
 * Static: trust roots are compiled constants (never read from disk or env),
 * the burned ed25519 "mason-workstation" key can never be a root, the M461
 * daemon and conductor roots stay empty, and nothing in src/, scripts/ or bin/
 * references the burned private-key file. Behavioural: roots dropped into
 * ~/.ashlr/{activation,authority} or the environment add no authority.
 */
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/core/authority/surface.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/core/authority/surface.js')>()),
  currentHostBinding: () => 'a'.repeat(64),
}));

import { canonicalJson } from '../src/core/authority/canonical-json.js';
import { evaluateStandingAuthority, invalidateStandingPolicyCache } from '../src/core/authority/effective-config.js';
import { resetLedgerCachesForTest } from '../src/core/authority/ledger.js';
import { installStandingGrant, installedGrantPath, standingTrustRootKeys } from '../src/core/authority/standing-grant.js';
import { BURNED_KEY_IDS, STANDING_GRANT_TRUST_ROOTS } from '../src/core/authority/trust-roots.js';
import { DAEMON_ACTIVATION_TRUST_ROOTS, GOAL_CONDUCTOR_ACTIVATION_TRUST_ROOTS } from '../src/core/daemon/activation-permit.js';
import { makeGrant, signGrant, TEST_ROOT, withTempHome } from './helpers/authority-310b.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8');

function filesUnder(rel: string, pattern: RegExp): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (name === 'node_modules' || name.startsWith('.')) continue;
      const path = join(dir, name);
      const stat = statSync(path);
      if (stat.isDirectory()) walk(path);
      else if (pattern.test(name)) out.push(path);
    }
  };
  walk(join(ROOT, rel));
  return out;
}

describe('static: trust is compiled in, never loaded', () => {
  it('trust-roots.ts is a leaf of constants: no fs, env, os or network', () => {
    const src = read('src/core/authority/trust-roots.ts');
    const imports = src.split('\n').filter((line) => /^\s*import\s/.test(line));
    expect(imports.every((line) => /^\s*import\s+type\s/.test(line))).toBe(true);
    expect(src).not.toMatch(/\b(?:readFileSync|readFile|process\.env|homedir|require\(|import\(|fetch\()/);
    expect(src).toMatch(/export const STANDING_GRANT_TRUST_ROOTS: readonly Readonly<StandingGrantTrustRoot>\[\] = Object\.freeze\(\[/);
  });

  it('every compiled standing root is a P-256 ES256 key and none is burned; the M461 roots stay empty', () => {
    expect(Object.isFrozen(STANDING_GRANT_TRUST_ROOTS)).toBe(true);
    expect(standingTrustRootKeys(STANDING_GRANT_TRUST_ROOTS).ok).toBe(true);
    for (const root of STANDING_GRANT_TRUST_ROOTS) expect(BURNED_KEY_IDS).not.toContain(root.keyId);
    expect(BURNED_KEY_IDS).toContain('mason-workstation');
    expect(DAEMON_ACTIVATION_TRUST_ROOTS).toEqual([]);
    expect(GOAL_CONDUCTOR_ACTIVATION_TRUST_ROOTS).toEqual([]);
  });

  it('the grant verifier and the policy never consult the environment or a trust file', () => {
    for (const rel of [
      'src/core/authority/standing-grant.ts',
      'src/core/authority/effective-config.ts',
      'src/core/authority/capability.ts',
      'src/core/authority/ledger.ts',
      'src/core/authority/clamp.ts',
      'src/core/authority/rollout.ts',
      'src/core/authority/surface.ts',
      'src/core/authority/canonical-json.ts',
    ]) {
      const src = read(rel);
      expect(src, rel).not.toMatch(/process\.env/);
      expect(src, rel).not.toMatch(/trust-roots\.json/);
      expect(src, rel).not.toMatch(/['"]activation['"]/);
    }
  });

  it('nothing shipped references the burned private-key file', () => {
    const needle = ['operator', 'private', 'key'].join('-');
    const offenders = [
      ...filesUnder('src', /\.(?:ts|tsx|js|mjs|cjs|rs)$/),
      ...filesUnder('scripts', /\.(?:ts|js|mjs|cjs|sh)$/),
      ...filesUnder('bin', /.*/),
    ].filter((path) => readFileSync(path, 'utf8').includes(needle));
    expect(offenders).toEqual([]);
  });
});

describe('behavioural: dropped files and env vars add no authority', () => {
  let restore: () => void;
  let home: string;
  const savedEnv = { ...process.env };

  beforeEach(() => {
    ({ home, restore } = withTempHome('bu1-nofile-'));
    resetLedgerCachesForTest();
    invalidateStandingPolicyCache();
  });

  afterEach(() => {
    for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
    resetLedgerCachesForTest();
    invalidateStandingPolicyCache();
    restore();
  });

  it('a grant signed by a key that is only in files / env never verifies', () => {
    const rootJson = JSON.stringify([TEST_ROOT]);
    for (const dir of ['activation', 'authority', join('control', 'activation')]) {
      mkdirSync(join(home, '.ashlr', dir), { recursive: true, mode: 0o700 });
      writeFileSync(join(home, '.ashlr', dir, 'trust-roots.json'), rootJson, { mode: 0o600 });
    }
    process.env['ASHLR_STANDING_GRANT_TRUST_ROOTS'] = rootJson;
    process.env['ASHLR_TRUST_ROOTS'] = rootJson;
    process.env['STANDING_GRANT_TRUST_ROOTS'] = rootJson;

    const envelope = signGrant(makeGrant());
    const installed = installStandingGrant(envelope, { surface: 'running' });
    expect(installed.ok).toBe(false);
    if (!installed.ok && STANDING_GRANT_TRUST_ROOTS.length === 0) expect(installed.code).toBe('no-trust-roots');

    // Even planted directly as the installed grant, it is not authority.
    writeFileSync(installedGrantPath(), `${canonicalJson(envelope)}\n`, { mode: 0o600 });
    const ev = evaluateStandingAuthority({ mode: 'fresh', surface: 'running' });
    expect(ev.policy).toBeNull();
    expect(ev.grantState).toBe('invalid');
  });
});
