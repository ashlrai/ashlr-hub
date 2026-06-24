/**
 * M87 — anti-clog: scanSelfImprove only flags BARE skipped tests (no rationale),
 * so the autonomous fleet stops being handed intentionally-skipped tests it will
 * just decline. (The companion change — runSwarm not filing a 0-diff proposal —
 * is covered by the swarm-propose suite, which must stay green.)
 *
 * Hermetic: a tmp repo named '@ashlr/hub' (scanSelfImprove only runs on the hub)
 * with a real test file; uses the real `rg` the scanner uses.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { scanSelfImprove } from '../src/core/portfolio/scanners.js';

let repo: string;

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-m87-'));
  fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ name: '@ashlr/hub' }), 'utf8');
  fs.mkdirSync(path.join(repo, 'test'), { recursive: true });
});

afterEach(() => {
  try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('M87 — scanSelfImprove intentional-skip detection', () => {
  it('flags a BARE skip (no rationale) but NOT a string-reason or annotated skip', async () => {
    fs.writeFileSync(
      path.join(repo, 'test', 'sample.test.ts'),
      [
        "import { describe, it } from 'vitest';",
        "describe('s', () => {",
        '  it.skip(() => { expect(1).toBe(1); });',                  // BARE → flagged
        "  it.skip('intentional: darwin-only path', () => {});",     // string reason → skip
        '  // skip: flaky on CI, tracked in #42',
        '  it.skip(() => {});',                                      // prev-line annotation → skip
        '});',
      ].join('\n'),
      'utf8',
    );

    const items = await scanSelfImprove(repo);
    const titles = items.map((i) => i.title); // "Restore skipped test in <file>:<line>"

    // Exactly the bare skip on line 3 is flagged; the reasoned + annotated ones are not.
    expect(items.length).toBe(1);
    expect(titles[0]).toMatch(/:3$/);
    expect(items[0]!.source).toBe('self');
    // No item references the string-reason (line 4) or annotated (line 6) skips.
    expect(titles.some((t) => t.endsWith(':4'))).toBe(false);
    expect(titles.some((t) => t.endsWith(':6'))).toBe(false);
  });

  it('returns [] for a non-@ashlr/hub repo (only the hub self-improves)', async () => {
    fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ name: 'some-other-repo' }), 'utf8');
    fs.writeFileSync(path.join(repo, 'test', 'x.test.ts'), 'it.skip(() => {});', 'utf8');
    expect(await scanSelfImprove(repo)).toEqual([]);
  });

  it('never throws on a missing/empty repo', async () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-m87-empty-'));
    try {
      await expect(scanSelfImprove(empty)).resolves.toBeDefined();
    } finally {
      fs.rmSync(empty, { recursive: true, force: true });
    }
  });
});
