/**
 * M311 — backlog CLI source filters stay in sync with WorkSource.
 *
 * Regression guard for stale --source validation/help: the CLI used to reject
 * newer backlog sources even though scanners and persisted backlog items
 * already emitted them.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  BACKLOG_SOURCE_FILTER_HELP,
  BACKLOG_SOURCE_FILTERS,
  cmdBacklog,
} from '../src/cli/backlog.js';
import { HELP_ENTRIES } from '../src/cli/help.js';
import type { Backlog, WorkItem } from '../src/core/types.js';

const origHome = process.env['HOME'];
let tmpHome: string;

function workSourcesFromTypeContract(): string[] {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'core', 'types.ts'),
    'utf8',
  );
  const match = source.match(/export type WorkSource = ([^;]+);/);
  if (!match) throw new Error('WorkSource union not found in src/core/types.ts');
  return Array.from(match[1]!.matchAll(/'([^']+)'/g), (m) => m[1]!).sort();
}

function makeItem(source: string): WorkItem {
  return {
    id: `/tmp/repo:${source}:fixture`,
    repo: '/tmp/repo',
    source: source as WorkItem['source'],
    title: `${source} fixture`,
    detail: `Fixture item for source ${source}.`,
    value: 3,
    effort: 1,
    score: 3,
    tags: [source],
    ts: '2026-07-02T00:00:00.000Z',
  };
}

function seedBacklog(): void {
  const dir = path.join(tmpHome, '.ashlr');
  fs.mkdirSync(dir, { recursive: true });
  const backlog: Backlog = {
    generatedAt: '2026-07-02T00:00:00.000Z',
    repos: ['/tmp/repo'],
    items: BACKLOG_SOURCE_FILTERS.map(makeItem),
  };
  fs.writeFileSync(
    path.join(dir, 'backlog.json'),
    JSON.stringify(backlog, null, 2) + '\n',
    'utf8',
  );
}

async function captureCli(args: string[]): Promise<{ code: number; out: string; err: string }> {
  let out = '';
  let err = '';
  const logSpy = vi.spyOn(console, 'log').mockImplementation((chunk = '') => {
    out += String(chunk) + '\n';
  });
  const errSpy = vi.spyOn(console, 'error').mockImplementation((chunk = '') => {
    err += String(chunk) + '\n';
  });
  try {
    const code = await cmdBacklog(args);
    return { code, out, err };
  } finally {
    logSpy.mockRestore();
    errSpy.mockRestore();
  }
}

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-m311-backlog-home-'));
  process.env['HOME'] = tmpHome;
  seedBacklog();
});

afterEach(() => {
  process.env['HOME'] = origHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('backlog CLI --source filters', () => {
  it('tracks every WorkSource literal in the shared type contract', () => {
    expect([...BACKLOG_SOURCE_FILTERS].sort()).toEqual(workSourcesFromTypeContract());
  });

  it('accepts every current source and filters JSON output to that source', async () => {
    for (const source of BACKLOG_SOURCE_FILTERS) {
      const { code, out, err } = await captureCli(['--source', source, '--json']);
      expect(code, source).toBe(0);
      expect(err, source).toBe('');

      const parsed = JSON.parse(out) as Backlog;
      expect(parsed.items, source).toHaveLength(1);
      expect(parsed.items[0]!.source, source).toBe(source);
    }
  });

  it('lists every current source in validation errors and help', async () => {
    const { code, err } = await captureCli(['--source', 'unknown']);
    expect(code).toBe(2);
    expect(err).toContain(`--source requires one of: ${BACKLOG_SOURCE_FILTER_HELP}`);

    const helpEntry = HELP_ENTRIES.find((entry) => entry.cmd === 'backlog --source <src>');
    expect(helpEntry?.desc).toContain(BACKLOG_SOURCE_FILTER_HELP);
  });
});
