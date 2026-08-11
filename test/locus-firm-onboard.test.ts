/**
 * locus-firm-onboard.test.ts — M4 always-on firm soft-offer during
 * production onboard / first-repo enroll.
 *
 * WHAT IS TESTED:
 *  - Non-interactive (--yes / non-TTY) SKIPS firm by default (CI-safe).
 *  - --locus-firm or ASHLR_LOCUS_FIRM=1 enables firm without a prompt.
 *  - TTY confirm can set firm; declining leaves firm off.
 *  - Absent locus CLI → no firm write.
 *  - Already firm → no re-prompt / no overwrite noise.
 *  - Default config remains firm-off (monorepo never flipped).
 *
 * SAFETY:
 *  - Isolated HOME via makeFixture; NEVER touches real ~/.ashlr.
 *  - locusAvailable / confirm injected via _firmOfferInternals (no PATH/TTY).
 *  - Every it() ends with expect.hasAssertions().
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { makeFixture, type H1Fixture } from './helpers/h1-fixture.js';

const { readinessSpy, tickSpy } = vi.hoisted(() => ({
  readinessSpy: vi.fn(),
  tickSpy: vi.fn(async (_cfg: unknown, opts: { dryRun: boolean }) => ({
    ts: new Date().toISOString(),
    itemsConsidered: opts.dryRun ? 0 : 0,
    proposalsCreated: 0,
    spentUsd: 0,
    reason: 'dry-run',
  })),
}));

vi.mock('../src/core/readiness.js', () => ({ buildReadiness: readinessSpy }));
vi.mock('../src/core/daemon/loop.js', () => ({ tick: tickSpy }));

import {
  maybeOfferLocusFirm,
  envRequestsLocusFirm,
  argsRequestLocusFirm,
  _firmOfferInternals,
} from '../src/cli/locus-firm-offer.js';
import { cmdOnboard, _internals } from '../src/cli/onboard.js';
import { loadConfig, saveConfig, defaultConfig } from '../src/core/config.js';
import { extractLocusConfigFirm } from '../src/core/integrations/locus.js';

function readyReport() {
  return {
    ready: true,
    blockers: [],
    warnings: [],
    info: [{ id: 'enrollment', severity: 'info' as const, detail: '0 repo(s) enrolled' }],
    generatedAt: new Date().toISOString(),
  };
}

function configFirm(): boolean {
  const cfg = loadConfig();
  return extractLocusConfigFirm(cfg);
}

function configJsonFirm(home: string): boolean | undefined {
  const p = join(home, '.ashlr', 'config.json');
  if (!existsSync(p)) return undefined;
  const raw = JSON.parse(readFileSync(p, 'utf8')) as { locus?: { firm?: boolean } };
  return raw.locus?.firm;
}

let fx: H1Fixture | undefined;
let confirmSpy: ReturnType<typeof vi.fn>;
let logSpy: ReturnType<typeof vi.spyOn>;
const origIsTTY = process.stdin.isTTY;
const origAshlrLocusFirm = process.env.ASHLR_LOCUS_FIRM;

function setTty(on: boolean): void {
  Object.defineProperty(process.stdin, 'isTTY', { value: on, configurable: true });
}

beforeEach(() => {
  fx = makeFixture();
  // Bootstrap config under isolated HOME so firm writes land in the fixture.
  saveConfig(defaultConfig());
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  confirmSpy = vi.fn(async () => false);
  _firmOfferInternals.confirm = confirmSpy;
  _firmOfferInternals.locusAvailable = () => true;
  _firmOfferInternals.loadConfig = loadConfig;
  _firmOfferInternals.saveConfig = saveConfig;
  _firmOfferInternals.log = (...args: unknown[]) => {
    console.log(...args);
  };
  _internals.confirm = confirmSpy;
  readinessSpy.mockResolvedValue(readyReport());
  tickSpy.mockClear();
  delete process.env.ASHLR_LOCUS_FIRM;
  setTty(false);
});

afterEach(() => {
  fx?.cleanup();
  fx = undefined;
  setTty(origIsTTY);
  if (origAshlrLocusFirm === undefined) delete process.env.ASHLR_LOCUS_FIRM;
  else process.env.ASHLR_LOCUS_FIRM = origAshlrLocusFirm;
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe('locus firm offer helpers', () => {
  it('envRequestsLocusFirm: only 1/true/yes are truthy', () => {
    expect.hasAssertions();
    expect(envRequestsLocusFirm({})).toBe(false);
    expect(envRequestsLocusFirm({ ASHLR_LOCUS_FIRM: '' })).toBe(false);
    expect(envRequestsLocusFirm({ ASHLR_LOCUS_FIRM: '0' })).toBe(false);
    expect(envRequestsLocusFirm({ ASHLR_LOCUS_FIRM: 'false' })).toBe(false);
    expect(envRequestsLocusFirm({ ASHLR_LOCUS_FIRM: '1' })).toBe(true);
    expect(envRequestsLocusFirm({ ASHLR_LOCUS_FIRM: 'true' })).toBe(true);
    expect(envRequestsLocusFirm({ ASHLR_LOCUS_FIRM: 'YES' })).toBe(true);
  });

  it('argsRequestLocusFirm detects --locus-firm', () => {
    expect.hasAssertions();
    expect(argsRequestLocusFirm([])).toBe(false);
    expect(argsRequestLocusFirm(['--yes', '/tmp/repo'])).toBe(false);
    expect(argsRequestLocusFirm(['--locus-firm'])).toBe(true);
    expect(argsRequestLocusFirm(['add', '/tmp/r', '--locus-firm', '--yes'])).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// maybeOfferLocusFirm — unit decisions
// ---------------------------------------------------------------------------

describe('maybeOfferLocusFirm', () => {
  it('skips when locus CLI is absent (never writes firm)', async () => {
    expect.hasAssertions();
    _firmOfferInternals.locusAvailable = () => false;

    const r = await maybeOfferLocusFirm({ yes: true, isInteractive: false });

    expect(r.decision).toBe('locus-absent');
    expect(configFirm()).toBe(false);
    expect(confirmSpy).not.toHaveBeenCalled();
  });

  it('non-interactive without flag/env SKIPS firm (CI/tests default off)', async () => {
    expect.hasAssertions();

    const r = await maybeOfferLocusFirm({
      yes: true,
      locusFirmFlag: false,
      isInteractive: false,
      env: {},
    });

    expect(r.decision).toBe('skip');
    expect(r.detail).toMatch(/non-interactive/i);
    expect(configFirm()).toBe(false);
    expect(confirmSpy).not.toHaveBeenCalled();
    // On-disk monorepo-safe default.
    expect(configJsonFirm(fx!.home)).not.toBe(true);
  });

  it('non-interactive with --locus-firm sets firm without prompting', async () => {
    expect.hasAssertions();

    const r = await maybeOfferLocusFirm({
      yes: true,
      locusFirmFlag: true,
      isInteractive: false,
      env: {},
      context: 'onboard',
    });

    expect(r.decision).toBe('set');
    expect(configFirm()).toBe(true);
    expect(configJsonFirm(fx!.home)).toBe(true);
    expect(confirmSpy).not.toHaveBeenCalled();
  });

  it('non-interactive with ASHLR_LOCUS_FIRM=1 sets firm without prompting', async () => {
    expect.hasAssertions();

    const r = await maybeOfferLocusFirm({
      yes: true,
      locusFirmFlag: false,
      isInteractive: false,
      env: { ASHLR_LOCUS_FIRM: '1' },
      context: 'enroll-first',
    });

    expect(r.decision).toBe('set');
    expect(configFirm()).toBe(true);
    expect(confirmSpy).not.toHaveBeenCalled();
  });

  it('TTY confirm yes sets firm; uses confirm seam', async () => {
    expect.hasAssertions();
    confirmSpy.mockResolvedValue(true);

    const r = await maybeOfferLocusFirm({
      yes: false,
      isInteractive: true,
      env: {},
      context: 'onboard',
    });

    expect(r.decision).toBe('set');
    expect(configFirm()).toBe(true);
    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(String(confirmSpy.mock.calls[0]?.[0] ?? '')).toMatch(/firm/i);
  });

  it('TTY confirm decline leaves firm off', async () => {
    expect.hasAssertions();
    confirmSpy.mockResolvedValue(false);

    const r = await maybeOfferLocusFirm({
      yes: false,
      isInteractive: true,
      env: {},
    });

    expect(r.decision).toBe('declined');
    expect(configFirm()).toBe(false);
    expect(confirmSpy).toHaveBeenCalledTimes(1);
  });

  it('already firm → already (no confirm, no rewrite required)', async () => {
    expect.hasAssertions();
    const cfg = loadConfig();
    saveConfig({ ...cfg, locus: { ...(cfg.locus ?? {}), firm: true } });
    confirmSpy.mockResolvedValue(true);

    const r = await maybeOfferLocusFirm({
      yes: false,
      isInteractive: true,
      locusFirmFlag: true,
    });

    expect(r.decision).toBe('already');
    expect(configFirm()).toBe(true);
    expect(confirmSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// cmdOnboard integration — non-interactive skip + explicit enable
// ---------------------------------------------------------------------------

describe('cmdOnboard firm soft-offer', () => {
  it('--yes without firm flag leaves firm off and never prompts', async () => {
    expect.hasAssertions();
    const repo = fx!.makeRepo();

    const code = await cmdOnboard(['--yes', repo.dir]);

    expect(code).toBe(0);
    expect(configFirm()).toBe(false);
    expect(confirmSpy).not.toHaveBeenCalled();
  });

  it('--yes --locus-firm sets firm without enroll / without confirm', async () => {
    expect.hasAssertions();
    const repo = fx!.makeRepo();

    const code = await cmdOnboard(['--yes', '--locus-firm', repo.dir]);

    expect(code).toBe(0);
    expect(configFirm()).toBe(true);
    expect(confirmSpy).not.toHaveBeenCalled();
    // --yes still does not enroll (H7 guidance-only path).
    expect(configJsonFirm(fx!.home)).toBe(true);
  });

  it('--yes with ASHLR_LOCUS_FIRM=1 sets firm', async () => {
    expect.hasAssertions();
    process.env.ASHLR_LOCUS_FIRM = '1';
    const repo = fx!.makeRepo();

    const code = await cmdOnboard(['--yes', repo.dir]);

    expect(code).toBe(0);
    expect(configFirm()).toBe(true);
    expect(confirmSpy).not.toHaveBeenCalled();
  });

  it('interactive enroll + firm confirm: both gates honored', async () => {
    expect.hasAssertions();
    setTty(true);
    // First confirm = enroll, second = firm.
    confirmSpy
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true);
    const repo = fx!.makeRepo();

    const code = await cmdOnboard([repo.dir]);

    expect(code).toBe(0);
    expect(configFirm()).toBe(true);
    expect(confirmSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('interactive enroll yes + firm decline: enrolled but firm off', async () => {
    expect.hasAssertions();
    setTty(true);
    confirmSpy
      .mockResolvedValueOnce(true) // enroll
      .mockResolvedValueOnce(false); // firm
    const repo = fx!.makeRepo();

    const code = await cmdOnboard([repo.dir]);

    expect(code).toBe(0);
    expect(configFirm()).toBe(false);
  });

  it('locus absent: interactive enroll does not firm-prompt', async () => {
    expect.hasAssertions();
    setTty(true);
    _firmOfferInternals.locusAvailable = () => false;
    confirmSpy.mockResolvedValue(true);
    const repo = fx!.makeRepo();

    const code = await cmdOnboard([repo.dir]);

    expect(code).toBe(0);
    expect(configFirm()).toBe(false);
    // Only enroll confirm — no firm prompt when locus missing.
    expect(confirmSpy).toHaveBeenCalledTimes(1);
  });
});
