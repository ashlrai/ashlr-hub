/**
 * Tests for the Verse V2 caps/scope primitives (src/core/verse/control-api.ts)
 * and the single subscriptionMaxPercent clamp (src/core/config.ts).
 *
 * These are the callable pieces behind GET/POST /api/verse/caps and
 * POST /api/verse/scope, exercised WITHOUT an HTTP server so the validation
 * matrix stays fast and exhaustive; `verse-control-api.test.ts` covers the
 * same code through the real routes.
 *
 * SAFETY: every filesystem-touching case relocates HOME to a fresh tmp dir
 * first, so saveConfig()/loadConfigReadOnly() resolve to an isolated
 * ~/.ashlr and the real one is never read or written. config.ts resolves its
 * paths from homedir() at CALL time (not module load), which is what makes
 * this isolation sound.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { AshlrConfig } from '../src/core/types.js';
import {
  SUBSCRIPTION_MAX_PERCENT_DEFAULT,
  loadConfigReadOnly,
  resolveSubscriptionMaxPercent,
  saveConfig,
} from '../src/core/config.js';
import { VERSE_CAPS_BOUNDS } from '../src/core/verse/control-types.js';
import {
  VERSE_CAPS_DEFAULTS,
  applyVerseCapsUpdate,
  checkVerseScopePath,
  parseVerseCapsUpdate,
  readVerseCaps,
} from '../src/core/verse/control-api.js';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

let tmpHome: string;
let prevHome: string | undefined;
let prevUserProfile: string | undefined;

function baseConfig(overrides: Partial<AshlrConfig> = {}): AshlrConfig {
  return {
    version: 1,
    roots: [],
    editor: 'cursor',
    staleDays: 30,
    categories: {},
    tidyRules: [],
    keepers: [],
    models: { providerChain: [] },
    telemetry: {},
    tools: {},
    ...overrides,
  } as unknown as AshlrConfig;
}

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-verse-caps-home-'));
  prevHome = process.env.HOME;
  prevUserProfile = process.env.USERPROFILE;
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  if (prevUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = prevUserProfile;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// readVerseCaps
// ---------------------------------------------------------------------------

describe('readVerseCaps', () => {
  it('reports the daemon defaults and names every key that fell back to one', () => {
    const caps = readVerseCaps(baseConfig());

    expect(caps.dailyBudgetUsd).toBe(VERSE_CAPS_DEFAULTS.dailyBudgetUsd);
    expect(caps.perTickItems).toBe(VERSE_CAPS_DEFAULTS.perTickItems);
    expect(caps.parallel).toBe(VERSE_CAPS_DEFAULTS.parallel);
    expect(caps.intervalMs).toBe(VERSE_CAPS_DEFAULTS.intervalMs);
    expect(caps.mode).toBe('batch');
    expect(caps.maxConcurrent).toBeNull();
    expect(caps.concurrency).toEqual({ local: null, cloud: null, total: null });
    expect(caps.subscriptionMaxPercent).toBe(SUBSCRIPTION_MAX_PERCENT_DEFAULT);
    expect(caps.foundryLimits).toEqual([]);

    // HONEST STATE: nothing was configured, so every key is flagged default.
    expect(caps.defaulted).toEqual([
      'concurrency',
      'dailyBudgetUsd',
      'foundryLimits',
      'intervalMs',
      'maxConcurrent',
      'mode',
      'parallel',
      'perTickItems',
      'subscriptionMaxPercent',
    ]);
  });

  it('surfaces configured values and flattens foundry limits, sorted by engine', () => {
    const caps = readVerseCaps(baseConfig({
      daemon: {
        dailyBudgetUsd: 12.5,
        perTickItems: 7,
        parallel: 4,
        intervalMs: 600_000,
        mode: 'continuous',
        maxConcurrent: 10,
        concurrency: { local: 2, cloud: 6, total: 8 },
      },
      foundry: {
        subscriptionMaxPercent: 75,
        limits: { codex: { window: '1d', max: 400 }, claude: { window: '5h', max: 50 } },
      },
    } as Partial<AshlrConfig>));

    expect(caps.dailyBudgetUsd).toBe(12.5);
    expect(caps.mode).toBe('continuous');
    expect(caps.maxConcurrent).toBe(10);
    expect(caps.concurrency).toEqual({ local: 2, cloud: 6, total: 8 });
    expect(caps.subscriptionMaxPercent).toBe(75);
    expect(caps.foundryLimits).toEqual([
      { engine: 'claude', window: '5h', max: 50 },
      { engine: 'codex', window: '1d', max: 400 },
    ]);
    expect(caps.defaulted).toEqual([]);
  });

  it('drops malformed foundry limit entries rather than inventing a window or max', () => {
    const caps = readVerseCaps(baseConfig({
      foundry: {
        limits: {
          claude: { window: '5h', max: 50 },
          // Deliberately malformed on-disk data: a numeric window and a
          // string max are exactly what a hand-edited config can produce.
          codex: { window: 7 as unknown as string, max: 10 },
          grok: { window: '1d', max: 'lots' as unknown as number },
        },
      },
    } as Partial<AshlrConfig>));

    expect(caps.foundryLimits).toEqual([{ engine: 'claude', window: '5h', max: 50 }]);
  });

  /**
   * The cockpit states, in three places, that a daily budget of 0 means the
   * loop is STOPPED. That is only true if the daemon reads 0 as 0.
   *
   * It used to read it as absent: `resolveCfg` gated on `o.dailyBudgetUsd > 0`
   * and fell through to DEFAULTS ($1.00/day), so a saved budget of 0 came back
   * as a dollar a day of authorised autonomous work behind a screen that said
   * the loop was stopped. The existing sync test above only compares DEFAULTS
   * against VERSE_CAPS_DEFAULTS; it never looked at the guard.
   *
   * Asserted against the SOURCE for the same reason the test above is:
   * importing daemon/loop.ts here would drag the whole dispatch chain into the
   * unit lane.
   */
  it('lets the daemon read a configured dailyBudgetUsd of 0 as a real 0', () => {
    const loopSource = fs.readFileSync(
      path.join(process.cwd(), 'src', 'core', 'daemon', 'loop.ts'),
      'utf8',
    );
    const guard = /dailyBudgetUsd:\s*\n?\s*typeof o\.dailyBudgetUsd === 'number'([\s\S]{0,200}?)\?\s*o\.dailyBudgetUsd/.exec(
      loopSource,
    );
    expect(guard, 'resolveCfg dailyBudgetUsd guard not found in daemon/loop.ts').not.toBeNull();
    const condition = guard?.[1] ?? '';
    // A stored 0 must survive into DaemonConfig...
    expect(condition).toContain('o.dailyBudgetUsd >= 0');
    // ...and the `> 0` spelling that discarded it must be gone.
    expect(condition).not.toMatch(/o\.dailyBudgetUsd\s*>\s*0/);
    // Garbage still falls back.
    expect(condition).toContain('Number.isFinite(o.dailyBudgetUsd)');

    // And the bound the route accepts still admits 0, so the two agree.
    expect(VERSE_CAPS_BOUNDS.dailyBudgetUsd.min).toBe(0);
    expect(parseVerseCapsUpdate({ dailyBudgetUsd: 0 }).ok).toBe(true);
  });

  /**
   * `foundryLimits[].engine` becomes an object KEY. `__proto__` does not
   * behave like one: the assignment hits Object.prototype's setter, the write
   * vanishes, and the route used to answer 200 `{applied:["foundryLimits"]}`
   * for a change that never happened and never would.
   */
  it('refuses a foundryLimits engine that is a prototype key', () => {
    for (const engine of ['__proto__', 'constructor', 'prototype']) {
      const parsed = parseVerseCapsUpdate({ foundryLimits: [{ engine, window: '1d', max: 10 }] });
      expect(parsed.ok, `${engine} must not be accepted as an engine id`).toBe(false);
    }
    expect(parseVerseCapsUpdate({ foundryLimits: [{ engine: 'codex', window: '1d', max: 10 }] }).ok).toBe(true);
  });

  it('merges foundry limits into a map that has no prototype to pollute', () => {
    const parsed = parseVerseCapsUpdate({ foundryLimits: [{ engine: 'codex', window: '1h', max: 60 }] });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const { cfg } = applyVerseCapsUpdate(baseConfig(), parsed.update);
    const limits = cfg.foundry?.limits as unknown as Record<string, unknown>;
    expect(Object.getPrototypeOf(limits)).toBeNull();
    expect(limits['codex']).toEqual({ window: '1h', max: 60 });
  });

  it('keeps VERSE_CAPS_DEFAULTS in sync with the daemon loop it mirrors', () => {
    // These values are duplicated (importing loop.ts into the web server would
    // drag the whole dispatch chain in). Prove the copy has not drifted.
    const loopSource = fs.readFileSync(
      path.join(process.cwd(), 'src', 'core', 'daemon', 'loop.ts'),
      'utf8',
    );
    const block = /const DEFAULTS: DaemonConfig = \{([\s\S]*?)\};/.exec(loopSource);
    expect(block, 'DEFAULTS literal not found in daemon/loop.ts').not.toBeNull();
    const body = block?.[1] ?? '';

    /** Parse a numeric literal from the source, including `5 * 60_000`. */
    const numberFor = (key: string): number | null => {
      const m = new RegExp(`${key}:\\s*([^,\\n]+)`).exec(body);
      if (!m?.[1]) return null;
      const factors = m[1].trim().split('*').map((part) => Number(part.trim().replace(/_/g, '')));
      if (factors.some((n) => !Number.isFinite(n))) return null;
      return factors.reduce((a, b) => a * b, 1);
    };

    expect(numberFor('dailyBudgetUsd')).toBe(VERSE_CAPS_DEFAULTS.dailyBudgetUsd);
    expect(numberFor('perTickItems')).toBe(VERSE_CAPS_DEFAULTS.perTickItems);
    expect(numberFor('parallel')).toBe(VERSE_CAPS_DEFAULTS.parallel);
    expect(numberFor('intervalMs')).toBe(VERSE_CAPS_DEFAULTS.intervalMs);
  });
});

// ---------------------------------------------------------------------------
// parseVerseCapsUpdate — validation matrix
// ---------------------------------------------------------------------------

describe('parseVerseCapsUpdate', () => {
  it('rejects unknown top-level keys instead of silently dropping them', () => {
    const parsed = parseVerseCapsUpdate({ dailyBudgetUsd: 5, dailyBudgetUSD: 5 });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toContain('unknown key: dailyBudgetUSD');
  });

  it('rejects an empty body', () => {
    expect(parseVerseCapsUpdate({}).ok).toBe(false);
  });

  it.each([
    ['dailyBudgetUsd', -1],
    ['dailyBudgetUsd', 1001],
    ['perTickItems', 0],
    ['perTickItems', 51],
    ['perTickItems', 2.5],
    ['parallel', 0],
    ['parallel', 17],
    ['intervalMs', 29_999],
    ['intervalMs', 86_400_001],
    ['maxConcurrent', 0],
    ['maxConcurrent', 33],
    ['subscriptionMaxPercent', 0],
    ['subscriptionMaxPercent', 101],
  ])('rejects %s = %s (out of contract bounds)', (key, value) => {
    const parsed = parseVerseCapsUpdate({ [key]: value });
    expect(parsed.ok, `${key}=${value} should be rejected`).toBe(false);
  });

  it.each([
    ['dailyBudgetUsd', 0],
    ['dailyBudgetUsd', 1000],
    ['perTickItems', 1],
    ['perTickItems', 50],
    ['parallel', 1],
    ['parallel', 16],
    ['intervalMs', 30_000],
    ['intervalMs', 86_400_000],
    ['maxConcurrent', 1],
    ['maxConcurrent', 32],
    ['subscriptionMaxPercent', 1],
    ['subscriptionMaxPercent', 100],
  ])('accepts %s = %s (at the contract boundary)', (key, value) => {
    const parsed = parseVerseCapsUpdate({ [key]: value });
    expect(parsed.ok, `${key}=${value} should be accepted`).toBe(true);
  });

  it.each([NaN, Infinity, '5', null, true])('rejects a non-finite budget: %s', (value) => {
    expect(parseVerseCapsUpdate({ dailyBudgetUsd: value }).ok).toBe(false);
  });

  it('rejects an unknown mode and accepts the two real ones', () => {
    expect(parseVerseCapsUpdate({ mode: 'turbo' }).ok).toBe(false);
    expect(parseVerseCapsUpdate({ mode: 'batch' }).ok).toBe(true);
    expect(parseVerseCapsUpdate({ mode: 'continuous' }).ok).toBe(true);
  });

  // The floor is 1, not the contract's 0, and the deviation is deliberate:
  // resolveCfg only adopts a tier when it is > 0 and TieredPool floors every
  // cap at Math.max(1, …) on top of that, so a stored 0 came back as the
  // built-in 2/6/8 while the cockpit displayed 0. See the comment on
  // VERSE_CAPS_BOUNDS.concurrency.
  it('validates concurrency tiers 1–32 and rejects unknown tiers', () => {
    expect(parseVerseCapsUpdate({ concurrency: { local: 1, cloud: 32 } }).ok).toBe(true);
    expect(parseVerseCapsUpdate({ concurrency: { local: 0 } }).ok).toBe(false);
    expect(parseVerseCapsUpdate({ concurrency: { local: -1 } }).ok).toBe(false);
    expect(parseVerseCapsUpdate({ concurrency: { total: 33 } }).ok).toBe(false);
    expect(parseVerseCapsUpdate({ concurrency: { gpu: 2 } }).ok).toBe(false);
    expect(parseVerseCapsUpdate({ concurrency: {} }).ok).toBe(false);
    expect(parseVerseCapsUpdate({ concurrency: [] }).ok).toBe(false);
  });

  it('validates foundry limits: max >= 0, no unknown keys, no duplicate engines', () => {
    expect(parseVerseCapsUpdate({
      foundryLimits: [{ engine: 'claude', window: '5h', max: 0 }],
    }).ok).toBe(true);

    expect(parseVerseCapsUpdate({
      foundryLimits: [{ engine: 'claude', window: '5h', max: -1 }],
    }).ok).toBe(false);

    expect(parseVerseCapsUpdate({
      foundryLimits: [{ engine: 'claude', window: '5h', max: 1, burst: 2 }],
    }).ok).toBe(false);

    expect(parseVerseCapsUpdate({
      foundryLimits: [
        { engine: 'claude', window: '5h', max: 1 },
        { engine: 'claude', window: '1d', max: 2 },
      ],
    }).ok).toBe(false);

    expect(parseVerseCapsUpdate({ foundryLimits: { claude: 1 } }).ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// applyVerseCapsUpdate + round-trip through a tmp HOME
// ---------------------------------------------------------------------------

describe('applyVerseCapsUpdate', () => {
  it('reports only the keys that actually changed', () => {
    const cfg = baseConfig({ daemon: { dailyBudgetUsd: 5, perTickItems: 3, parallel: 2, intervalMs: 300_000 } });
    const { applied } = applyVerseCapsUpdate(cfg, { dailyBudgetUsd: 5, parallel: 8 });
    expect(applied).toEqual(['parallel']);
  });

  it('counts a write that merely pins a previously-defaulted key as applied', () => {
    const cfg = baseConfig();
    const { applied } = applyVerseCapsUpdate(cfg, {
      dailyBudgetUsd: VERSE_CAPS_DEFAULTS.dailyBudgetUsd,
    });
    expect(applied).toEqual(['dailyBudgetUsd']);
    expect(readVerseCaps(applyVerseCapsUpdate(cfg, {
      dailyBudgetUsd: VERSE_CAPS_DEFAULTS.dailyBudgetUsd,
    }).cfg).defaulted).not.toContain('dailyBudgetUsd');
  });

  it('merges foundry limits per engine, leaving engines it did not name alone', () => {
    const cfg = baseConfig({
      foundry: { limits: { claude: { window: '5h', max: 50 }, codex: { window: '1d', max: 400 } } },
    } as Partial<AshlrConfig>);
    const { cfg: next } = applyVerseCapsUpdate(cfg, {
      foundryLimits: [{ engine: 'codex', window: '1d', max: 120 }],
    });
    expect(readVerseCaps(next).foundryLimits).toEqual([
      { engine: 'claude', window: '5h', max: 50 },
      { engine: 'codex', window: '1d', max: 120 },
    ]);
  });

  it('does not mutate the config it was handed', () => {
    const cfg = baseConfig({ daemon: { dailyBudgetUsd: 5, perTickItems: 3, parallel: 2, intervalMs: 300_000 } });
    applyVerseCapsUpdate(cfg, { dailyBudgetUsd: 99, subscriptionMaxPercent: 42 });
    expect(cfg.daemon?.dailyBudgetUsd).toBe(5);
    expect(cfg.foundry?.subscriptionMaxPercent).toBeUndefined();
  });

  it('round-trips through saveConfig/loadConfigReadOnly in an isolated HOME', () => {
    // Prove we are isolated before writing anything.
    expect(os.homedir()).toBe(tmpHome);

    const seeded = baseConfig({ daemon: { dailyBudgetUsd: 1, perTickItems: 3, parallel: 2, intervalMs: 300_000 } });
    saveConfig(seeded);

    const parsed = parseVerseCapsUpdate({
      dailyBudgetUsd: 25,
      perTickItems: 9,
      mode: 'continuous',
      concurrency: { local: 1, cloud: 5, total: 6 },
      subscriptionMaxPercent: 80,
      foundryLimits: [{ engine: 'claude', window: '5h', max: 40 }],
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const { cfg: next, applied } = applyVerseCapsUpdate(loadConfigReadOnly(), parsed.update);
    saveConfig(next);

    expect(applied.sort()).toEqual([
      'concurrency',
      'dailyBudgetUsd',
      'foundryLimits',
      'mode',
      'perTickItems',
      'subscriptionMaxPercent',
    ]);

    const reread = readVerseCaps(loadConfigReadOnly());
    expect(reread.dailyBudgetUsd).toBe(25);
    expect(reread.perTickItems).toBe(9);
    expect(reread.mode).toBe('continuous');
    expect(reread.concurrency).toEqual({ local: 1, cloud: 5, total: 6 });
    expect(reread.subscriptionMaxPercent).toBe(80);
    expect(reread.foundryLimits).toEqual([{ engine: 'claude', window: '5h', max: 40 }]);
    // Untouched keys keep their configured values.
    expect(reread.parallel).toBe(2);
    expect(reread.intervalMs).toBe(300_000);

    // The write landed inside the tmp HOME, never the real one.
    expect(fs.existsSync(path.join(tmpHome, '.ashlr', 'config.json'))).toBe(true);
  });

  it('accepts a zero budget and keeps it readable as zero (a stopped daemon)', () => {
    const { cfg: next } = applyVerseCapsUpdate(baseConfig(), { dailyBudgetUsd: 0 });
    const caps = readVerseCaps(next);
    // 0 is a legal, meaningful cap — it must not be mistaken for "unset".
    expect(caps.dailyBudgetUsd).toBe(0);
    expect(caps.defaulted).not.toContain('dailyBudgetUsd');
  });
});

// ---------------------------------------------------------------------------
// resolveSubscriptionMaxPercent — the ONE clamp
// ---------------------------------------------------------------------------

describe('resolveSubscriptionMaxPercent', () => {
  it('defaults to 90 when unset', () => {
    expect(resolveSubscriptionMaxPercent(baseConfig())).toBe(90);
    expect(resolveSubscriptionMaxPercent(undefined)).toBe(90);
    expect(resolveSubscriptionMaxPercent(null)).toBe(90);
  });

  it('clamps to [1, 100] at both ends', () => {
    expect(resolveSubscriptionMaxPercent(0)).toBe(1);
    expect(resolveSubscriptionMaxPercent(-40)).toBe(1);
    expect(resolveSubscriptionMaxPercent(250)).toBe(100);
    expect(resolveSubscriptionMaxPercent(55)).toBe(55);
  });

  it('falls back rather than propagating a non-finite value', () => {
    // A NaN threshold would make every comparison false and silently disable
    // the subscription throttle — fail safe to the default instead.
    expect(resolveSubscriptionMaxPercent(NaN)).toBe(90);
    expect(resolveSubscriptionMaxPercent(Infinity)).toBe(90);
  });

  it('honours an explicit fallback (the fabric gateway ctx override path)', () => {
    expect(resolveSubscriptionMaxPercent(undefined, 60)).toBe(60);
    expect(resolveSubscriptionMaxPercent(NaN, 60)).toBe(60);
    expect(resolveSubscriptionMaxPercent(20, 60)).toBe(20);
  });

  it('reads the typed foundry home', () => {
    expect(resolveSubscriptionMaxPercent(baseConfig({
      foundry: { subscriptionMaxPercent: 33 },
    } as Partial<AshlrConfig>))).toBe(33);
  });
});

// ---------------------------------------------------------------------------
// checkVerseScopePath
// ---------------------------------------------------------------------------

describe('checkVerseScopePath', () => {
  it('rejects relative paths', () => {
    const result = checkVerseScopePath('relative/repo', { requireDirectory: true });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('absolute');
  });

  it('rejects an empty path and a NUL byte', () => {
    expect(checkVerseScopePath('', { requireDirectory: true }).ok).toBe(false);
    expect(checkVerseScopePath('/tmp/a\0b', { requireDirectory: true }).ok).toBe(false);
  });

  it('rejects a path that is not an existing directory when enrolling', () => {
    const missing = path.join(tmpHome, 'not-there');
    expect(checkVerseScopePath(missing, { requireDirectory: true }).ok).toBe(false);

    const file = path.join(tmpHome, 'a-file');
    fs.writeFileSync(file, 'x');
    expect(checkVerseScopePath(file, { requireDirectory: true }).ok).toBe(false);
  });

  it('allows unenrolling a directory that has since been deleted', () => {
    // Otherwise a repo removed from disk would be stuck in the registry.
    const gone = path.join(tmpHome, 'deleted-repo');
    const result = checkVerseScopePath(gone, { requireDirectory: false });
    expect(result.ok).toBe(true);
    // Nothing to resolve physically — the lexical spelling is kept.
    if (result.ok) expect(result.path).toBe(path.resolve(gone));
  });

  it('rejects anything lexically under ~/.codex/artifacts', () => {
    const artifacts = path.join(tmpHome, '.codex', 'artifacts');
    const inside = path.join(artifacts, 'scratch-checkout');
    fs.mkdirSync(inside, { recursive: true });

    const result = checkVerseScopePath(inside, { requireDirectory: true });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('.codex/artifacts');

    // The root itself is rejected too.
    expect(checkVerseScopePath(artifacts, { requireDirectory: true }).ok).toBe(false);
  });

  it('rejects a symlink whose target escapes into ~/.codex/artifacts', () => {
    const artifacts = path.join(tmpHome, '.codex', 'artifacts');
    const real = path.join(artifacts, 'real-checkout');
    fs.mkdirSync(real, { recursive: true });
    const innocent = path.join(tmpHome, 'looks-fine');
    fs.symlinkSync(real, innocent, 'dir');

    // The spelling passes the lexical check; the physical resolve must not.
    const result = checkVerseScopePath(innocent, { requireDirectory: true });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('.codex/artifacts');
  });

  it('rejects a traversal that climbs back into the artifacts root', () => {
    const artifacts = path.join(tmpHome, '.codex', 'artifacts');
    fs.mkdirSync(path.join(artifacts, 'deep'), { recursive: true });
    const traversal = path.join(tmpHome, 'repos', '..', '.codex', 'artifacts', 'deep');
    expect(checkVerseScopePath(traversal, { requireDirectory: true }).ok).toBe(false);
  });

  it('accepts an ordinary absolute directory and returns it resolved', () => {
    const repo = path.join(tmpHome, 'repos', 'thing');
    fs.mkdirSync(repo, { recursive: true });
    const result = checkVerseScopePath(path.join(tmpHome, 'repos', '.', 'thing'), {
      requireDirectory: true,
    });
    expect(result.ok).toBe(true);
    // The PHYSICAL path comes back — the same spelling enroll() persists.
    if (result.ok) expect(result.path).toBe(fs.realpathSync.native(repo));
  });

  /**
   * The artifacts root was the ONLY forbidden root. `expandHomePrefix('~')`
   * returns homedir(), which is absolute and a directory, so
   * `POST /api/verse/scope {"action":"enroll","path":"~"}` enrolled the whole
   * home directory — and `~/.ashlr` and `/` passed the same way. `~/.ashlr`
   * holds config.json (which can carry provider tokens in plaintext), the
   * enrollment registry itself, the KILL sentinel, and the private 0600
   * `verse/*.launch.json` launcher records; `isEnrolled()` is the gate on the
   * mcp-native write tools, so enrolling it hands those tools the files that
   * bound them.
   */
  it('refuses the home directory, ~/.ashlr, and the filesystem root', () => {
    const ashlr = path.join(tmpHome, '.ashlr');
    fs.mkdirSync(path.join(ashlr, 'verse'), { recursive: true });

    for (const spelling of [tmpHome, '~', '~/']) {
      const result = checkVerseScopePath(spelling, { requireDirectory: true });
      expect(result.ok, `${spelling} must not be enrollable`).toBe(false);
      if (!result.ok) expect(result.error).toContain('home directory');
    }

    for (const spelling of [ashlr, '~/.ashlr', path.join(ashlr, 'verse')]) {
      const result = checkVerseScopePath(spelling, { requireDirectory: true });
      expect(result.ok, `${spelling} must not be enrollable`).toBe(false);
      if (!result.ok) expect(result.error).toContain('.ashlr');
    }

    expect(checkVerseScopePath('/', { requireDirectory: true }).ok).toBe(false);
  });

  it('refuses a directory that CONTAINS a forbidden root', () => {
    // Enrolling an ancestor pulls the forbidden root in with it. `/` is the
    // extreme case; the parent of the home directory is the realistic one.
    const parentOfHome = path.dirname(tmpHome);
    const result = checkVerseScopePath(parentOfHome, { requireDirectory: true });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('contains');

    // ~/.codex contains ~/.codex/artifacts.
    const codex = path.join(tmpHome, '.codex');
    fs.mkdirSync(path.join(codex, 'artifacts'), { recursive: true });
    expect(checkVerseScopePath(codex, { requireDirectory: true }).ok).toBe(false);
  });

  it('refuses a symlink whose target resolves to ~/.ashlr', () => {
    const ashlr = path.join(tmpHome, '.ashlr');
    fs.mkdirSync(ashlr, { recursive: true });
    const innocent = path.join(tmpHome, 'looks-like-a-repo');
    fs.symlinkSync(ashlr, innocent, 'dir');

    const result = checkVerseScopePath(innocent, { requireDirectory: true });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('.ashlr');
  });

  it('still allows an ordinary repo inside the home directory', () => {
    // The home directory is exact-and-ancestor only: nearly every repo lives
    // under it, so "under home" must stay perfectly fine.
    const repo = path.join(tmpHome, 'code', 'project');
    fs.mkdirSync(repo, { recursive: true });
    expect(checkVerseScopePath(repo, { requireDirectory: true }).ok).toBe(true);
  });

  it("expands the '~' spelling the API hands back to clients", () => {
    // sanitizePublicJson rewrites $HOME as `~` on the way out, so a path the
    // UI read from us comes back in that form and must still validate.
    const repo = path.join(tmpHome, 'tilde-repo');
    fs.mkdirSync(repo, { recursive: true });
    const result = checkVerseScopePath('~/tilde-repo', { requireDirectory: true });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.path).toBe(fs.realpathSync.native(repo));
  });
});
