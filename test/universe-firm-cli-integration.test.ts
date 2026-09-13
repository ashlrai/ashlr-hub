import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { loadOrCreateKey } from '../src/core/foundry/provenance.js';

const exec = promisify(execFile);
let root: string;
beforeEach(() => {
  // Existing global test/setup/home.ts owns and isolates this HOME. The child
  // inherits that same fixture home; no host key or host KILL is touched.
  root = realpathSync(mkdtempSync(join(homedir(), 'firm-cli-')));
  loadOrCreateKey();
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); });
async function cli(command: string, ...args: string[]) {
  const result = await exec(process.execPath, ['--import', 'tsx', 'src/cli/index.ts', 'universe', 'firm', command,
    '--root', root, '--json', ...args], { timeout: 60_000, maxBuffer: 1024 * 1024 });
  return JSON.parse(result.stdout);
}

describe('firm graph real CLI process with existing fixture provenance', () => {
  it('runs the full path, rejects the lying artifact and authenticates conflicts across processes', async () => {
    const first = await cli('demo');
    expect(first.status).toBe('accepted-fixture');
    expect(first.counts).toEqual({ completedNodes: 4, rejectedNodes: 1, traces: 11, conflictLinks: 1 });
    expect(first.graph.edges).toHaveLength(5);
    expect(first.checks).toEqual({ positiveVerified: true, intentionalLiarRejected: true, plantedConflictPreserved: true });
    const query = await cli('query', '--entity', 'node:verify-liar', '--limit', '2');
    expect(query.integrityVerified).toBe(true); expect(query.keyScope).toBe('existing-host-key');
    expect(query.query.traces).toHaveLength(2);
    expect(query.query.traces.flatMap((trace: { conflicts: unknown[] }) => trace.conflicts)).toHaveLength(1);
    expect((await cli('status')).graph.traces).toEqual(first.graph.traces);
    expect((await cli('demo')).graph.traces).toEqual(first.graph.traces);
  });

  it('honors a restrictive root KILL before publishing any graph history', async () => {
    writeFileSync(join(root, 'KILL'), 'stop fixture\n', { mode: 0o600 });
    try { await cli('demo'); throw new Error('Expected withheld demo'); }
    catch (error) {
      const result = JSON.parse((error as { stdout: string }).stdout);
      expect(result.status).toBe('stopped'); expect(result.counts.traces).toBe(0);
    }
    expect(readdirSync(root)).toEqual(['KILL']);
  });
});
