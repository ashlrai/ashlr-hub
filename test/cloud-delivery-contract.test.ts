/**
 * 3.11 cloud lane — the delivery contract appended to every task prompt and
 * the PR-body report parser (src/core/cloud/delivery-contract.ts). Pure: no
 * disk, no process.
 */
import { describe, expect, it } from 'vitest';

import { buildCloudPrompt, CLOUD_REPORT_MAX_BLOCK_CHARS, parseCloudReport } from '../src/core/cloud/delivery-contract.js';
import type { CloudTaskV1 } from '../src/core/cloud/types.js';

const TASK: CloudTaskV1 = {
  v: 1, id: 'ct_20260924T2331_k3f9q2', repo: 'ashlrai/ashlr-hub', baseBranch: 'v3110-cloud', branch: 'ashlr-cloud/ct_20260924T2331_k3f9q2',
  title: 'Fix the flaky tracker test', prompt: '  Fix the flaky tracker test in test/x.test.ts.\n', origin: 'operator', requestedBy: 'mason',
  seat: 'claude-a', sessionId: null, sessionUrl: null, state: 'queued', stateReason: null, failure: null,
  createdAt: '2026-09-24T23:31:00.000Z', launchedAt: null, updatedAt: '2026-09-24T23:31:00.000Z', pr: null, report: null,
  estimatedCostUsd: 3, backlogItemId: null, needsYouId: null,
};

const fence = (json: string, ticks = '```'): string => `${ticks}ashlr-cloud-report\n${json}\n${ticks}`;
const GOOD = JSON.stringify({ status: 'done', summary: 'Fixed it.', testsRun: ['npx vitest run test/x.test.ts (4 passed)'], risks: [], filesChanged: 2 });

describe('buildCloudPrompt', () => {
  const prompt = buildCloudPrompt(TASK);

  it('starts with the task text and carries every contract term', () => {
    expect(prompt.startsWith('Fix the flaky tracker test in test/x.test.ts.\n')).toBe(true);
    expect(prompt).toContain('Create branch `ashlr-cloud/ct_20260924T2331_k3f9q2` from `v3110-cloud`');
    expect(prompt).toContain('Never push to any other branch');
    expect(prompt).toContain('Never merge anything');
    expect(prompt).toContain('DRAFT pull request');
    expect(prompt).toContain('against `v3110-cloud` titled `[ashlr-cloud] Fix the flaky tracker test`');
    expect(prompt).toContain('```ashlr-cloud-report');
    expect(prompt).toContain('git commit --allow-empty');
    expect(prompt).toContain('"no-change"');
    expect(prompt).toMatch(/relevant checks and tests/);
  });

  it('its own example block is a report the parser accepts', () => {
    expect(parseCloudReport(prompt)).toMatchObject({ status: 'done', filesChanged: 3 });
  });
});

describe('parseCloudReport', () => {
  it('parses a well-formed block at the end of a PR body', () => {
    const body = `## Summary\nDid the thing.\n\n${fence(GOOD)}\n`;
    expect(parseCloudReport(body)).toEqual({
      status: 'done', summary: 'Fixed it.', testsRun: ['npx vitest run test/x.test.ts (4 passed)'], risks: [], filesChanged: 2,
    });
  });

  it('handles CRLF bodies and longer fences containing ``` in strings', () => {
    const json = JSON.stringify({ status: 'partial', summary: 'Used ``` in a string.', testsRun: [], risks: ['r'] });
    expect(parseCloudReport(`intro\r\n${fence(json, '````').replace(/\n/g, '\r\n')}\r\n`)).toMatchObject({ status: 'partial', summary: 'Used ``` in a string.' });
  });

  it('returns null for nothing, a missing block, or another language tag', () => {
    expect(parseCloudReport(null)).toBeNull();
    expect(parseCloudReport(undefined)).toBeNull();
    expect(parseCloudReport('')).toBeNull();
    expect(parseCloudReport('no block here')).toBeNull();
    expect(parseCloudReport(`\`\`\`json\n${GOOD}\n\`\`\``)).toBeNull();
  });

  it('rejects malformed blocks', () => {
    for (const bad of [
      '{not json',
      '[]',
      JSON.stringify({ status: 'finished', summary: 'x', testsRun: [], risks: [] }),
      JSON.stringify({ status: 'done', summary: '   ', testsRun: [], risks: [] }),
      JSON.stringify({ status: 'done', summary: 'x', testsRun: 'all of them', risks: [] }),
      JSON.stringify({ status: 'done', summary: 'x', testsRun: [1, 2], risks: [] }),
    ]) {
      expect(parseCloudReport(fence(bad)), bad).toBeNull();
    }
  });

  it('is lenient where it can be: missing lists default to empty, a bad file count is dropped', () => {
    expect(parseCloudReport(fence(JSON.stringify({ status: 'no-change', summary: 'Nothing to do.', filesChanged: -1 }))))
      .toEqual({ status: 'no-change', summary: 'Nothing to do.', testsRun: [], risks: [] });
  });

  it('uses the last tagged block, with a later valid revision replacing an invalid one', () => {
    const first = JSON.stringify({ status: 'partial', summary: 'First pass.', testsRun: [], risks: [] });
    expect(parseCloudReport([fence(first), 'later edit:', fence(GOOD)].join('\n\n'))?.summary).toBe('Fixed it.');
    expect(parseCloudReport([fence('{"status":'), fence(GOOD)].join('\n\n'))?.summary).toBe('Fixed it.');
    expect(parseCloudReport('```ashlr-cloud-report\n' + fence(GOOD))?.summary).toBe('Fixed it.');
    expect(parseCloudReport([fence(GOOD), fence(first)].join('\n'))?.summary).toBe('First pass.');
  });

  it('invalidates an older report when the newest tagged attempt is malformed or unclosed', () => {
    for (const latest of [
      fence('{"status":'),
      '```ashlr-cloud-report\n{"status":"blocked"',
      '```ashlr-cloud-report',
      '```ashlr-cloud-report not-a-valid-fence\n' + GOOD + '\n```',
      '````ashlr-cloud-report\n{"status":"blocked"}\n```',
    ]) {
      expect(parseCloudReport(`${fence(GOOD)}\n\n${latest}`), latest).toBeNull();
    }
  });

  it('refuses an oversized block and bounds long fields', () => {
    const huge = JSON.stringify({ status: 'done', summary: 'x'.repeat(CLOUD_REPORT_MAX_BLOCK_CHARS), testsRun: [], risks: [] });
    expect(parseCloudReport(fence(huge))).toBeNull();
    expect(parseCloudReport(`${fence(GOOD)}\n${fence(huge)}`)).toBeNull();

    const long = JSON.stringify({
      status: 'done', summary: 's'.repeat(5_000), testsRun: Array.from({ length: 80 }, (_, i) => `t${i}`), risks: ['r'.repeat(900)],
    });
    const report = parseCloudReport(fence(long))!;
    expect(report.summary.length).toBeLessThanOrEqual(2_000);
    expect(report.summary.endsWith('…')).toBe(true);
    expect(report.testsRun).toHaveLength(50);
    expect(report.risks[0]!.length).toBeLessThanOrEqual(500);
  });

  it('refuses an excessive fence length without compiling a huge close pattern', () => {
    const excessive = `${'`'.repeat(40_000)}ashlr-cloud-report\n${GOOD}\n${'`'.repeat(40_000)}`;
    expect(parseCloudReport(excessive)).toBeNull();
    expect(parseCloudReport(`${fence(GOOD)}\n${excessive}`)).toBeNull();
    expect(parseCloudReport(`${excessive}\n${fence(GOOD)}`)?.summary).toBe('Fixed it.');
  });

  it('scans only the tail of a giant body, where the contract puts the block', () => {
    const body = `${'x'.repeat(2 * 1024 * 1024)}\n${fence(GOOD)}`;
    expect(parseCloudReport(body)?.status).toBe('done');
  });
});
