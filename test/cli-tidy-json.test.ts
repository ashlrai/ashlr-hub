/**
 * CLI contract test: `ashlr tidy --json`
 *
 * The Raycast "Tidy Desktop" command spawns `ashlr tidy --json` and JSON.parses
 * stdout. This test asserts that stdout is ONLY a parseable TidyPlan
 * ({ moves, skipped }) with zero color/log noise — the contract the Raycast
 * layer depends on.
 *
 * The test runs the COMPILED CLI (dist/cli/index.js), so it requires a prior
 * `npm run build`. It points HOME at a temp dir so it never touches the real
 * ~/.ashlr or the real Desktop.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { spawnSync, execSync } from 'node:child_process';
import {
  mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const cliEntry = join(repoRoot, 'dist', 'cli', 'index.js');

describe('CLI: ashlr tidy --json', () => {
  let home: string;
  let desktop: string;

  beforeAll(() => {
    // Build once if the compiled entry is missing.
    if (!existsSync(cliEntry)) {
      execSync('npm run build', { cwd: repoRoot, stdio: 'pipe' });
    }
  });

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'ashlr-cli-home-'));
    desktop = join(home, 'Desktop');
    mkdirSync(desktop, { recursive: true });

    // A loose PDF that should be planned for a move.
    writeFileSync(join(desktop, 'invoice.pdf'), 'dummy');
    mkdirSync(join(desktop, 'Business'), { recursive: true });

    // Write a config so tidy has a deterministic root + rule (no real Desktop).
    const cfg = {
      version: 1,
      roots: [desktop],
      editor: 'cursor',
      staleDays: 30,
      categories: {},
      tidyRules: [
        { match: '.pdf', matchType: 'ext', dest: join(desktop, 'Business') },
      ],
      keepers: [],
      models: { lmstudio: '', ollama: '', providerChain: [] },
      telemetry: {},
      tools: {},
    };
    mkdirSync(join(home, '.ashlr'), { recursive: true });
    writeFileSync(join(home, '.ashlr', 'config.json'), JSON.stringify(cfg, null, 2));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it('emits ONLY a parseable TidyPlan on stdout', () => {
    const result = spawnSync('node', [cliEntry, 'tidy', '--json'], {
      encoding: 'utf8',
      // USERPROFILE relocates homedir() in the spawned child on win32 (where
      // os.homedir() ignores $HOME); the global node:os shim only applies
      // inside vitest, not the real CLI subprocess.
      env: { ...process.env, HOME: home, USERPROFILE: home, NO_COLOR: '1', FORCE_COLOR: '0' },
    });

    expect(result.status).toBe(0);

    const raw = (result.stdout ?? '').trim();
    // stdout must be valid JSON with no leading log chatter.
    let parsed: unknown;
    expect(() => { parsed = JSON.parse(raw); }).not.toThrow();

    const plan = parsed as { moves: unknown; skipped: unknown };
    expect(Array.isArray(plan.moves)).toBe(true);
    expect(Array.isArray(plan.skipped)).toBe(true);

    // Our loose invoice.pdf should be in the planned moves.
    const moves = plan.moves as { from: string; to: string }[];
    expect(moves.some((m) => m.from.endsWith('invoice.pdf'))).toBe(true);
  });

  it('does not contain ANSI escape codes in stdout', () => {
    const result = spawnSync('node', [cliEntry, 'tidy', '--json'], {
      encoding: 'utf8',
      env: { ...process.env, HOME: home, USERPROFILE: home, NO_COLOR: '1', FORCE_COLOR: '0' },
    });
    const raw = result.stdout ?? '';
    // No ESC (\x1b) control characters.
    // eslint-disable-next-line no-control-regex
    expect(/\x1b\[/.test(raw)).toBe(false);
  });
});
