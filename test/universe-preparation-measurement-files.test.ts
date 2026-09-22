/** Actual descriptor reads through the public route; no subprocess or runtime launch. */
import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdUniverse } from '../src/cli/universe.js';

const privateText = 'PRIVATE_REPORT_CONTENT_NOT_FOR_OUTPUT';
function complete() {
  const methods = [
    ['manager-open', 'bundle', 'manager-check', 'manager-replay', 'manager-check', 'manager-replay', 'manager-close'],
    ['successor-check', 'successor-metadata', 'successor-bundle', 'successor-metadata'],
  ];
  const workflows = methods.map((list, index) => ({ name: index ? 'successor' : 'manager',
    processes: index ? 40 : 60, blobProcesses: index ? 4 : 6,
    requests: list.map((method, row) => ({ id: row + 1, method,
      processes: method === 'manager-close' ? 0 : 10, blobProcesses: method === 'manager-close' ? 0 : 1 })) }));
  return { schemaVersion: 1, kind: 'preparation-verification-measurement', workload: 'preparation-workflows-v1', checksPassed: true,
    metrics: { correctness_checks: 19, verification_processes: 20, workflow_processes: 100, workflow_blob_processes: 10,
      fixture_owned_process_groups: 4, ...Object.fromEntries(['files_1_check', 'files_1_metadata', 'files_4_check', 'files_4_metadata']
        .flatMap(key => [[`${key}_processes`, 5], [`${key}_blob_processes`, 1]])) }, workflows, diagnostics: [] };
}
function partial() {
  return { ...complete(), checksPassed: false, metrics: { correctness_checks: 16 }, workflows: complete().workflows.slice(0, 1),
    diagnostics: [{ code: 'WORKFLOW_CANDIDATE_BEHAVIOR_FAILED', message: privateText }] };
}
function snapshot(path: string): unknown {
  const stat = lstatSync(path, { bigint: true });
  return { ino: String(stat.ino), mode: String(stat.mode), mtime: String(stat.mtimeNs), ctime: String(stat.ctimeNs),
    content: stat.isSymbolicLink() ? { symlink: readlinkSync(path) }
      : stat.isDirectory() ? Object.fromEntries(readdirSync(path).sort().map(name => [name, snapshot(join(path, name))]))
        : createHash('sha256').update(readFileSync(path)).digest('hex') };
}
let root: string, input: string;
let output: ReturnType<typeof vi.spyOn>, errors: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'preparation-report-files-')));
  input = join(root, 'PRIVATE_FILE_SENTINEL.json');
  output = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => { vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }); });
const printed = () => [...output.mock.calls, ...errors.mock.calls].flat().join('\n');
async function inspect(json: boolean) {
  const before = snapshot(root);
  const result = await cmdUniverse(['preparation-measurement', '--input', input, ...(json ? ['--json'] : [])]);
  expect(snapshot(root)).toEqual(before);
  expect(printed()).not.toContain(privateText);
  expect(printed()).not.toContain(root);
  expect(printed()).not.toContain('PRIVATE_FILE_SENTINEL');
  return result;
}

describe('Universe preparation measurement real-file route', () => {
  it.each([true, false])('reads a complete report without writes (JSON=%s)', async json => {
    const bytes = Buffer.from(JSON.stringify(complete()) + '\n'); writeFileSync(input, bytes, { mode: 0o600 });
    expect(await inspect(json)).toBe(0);
    expect(readFileSync(input).equals(bytes)).toBe(true);
    expect(errors).not.toHaveBeenCalled(); expect(output).toHaveBeenCalledTimes(1);
    if (json) {
      const report = JSON.parse(output.mock.calls[0]![0] as string);
      expect(report).toMatchObject({ scope: 'diagnostic-only', reportedChecksSatisfied: true, correctnessChecks: 19,
        leafProcesses: 20, workflowProcesses: 100, workflowBlobProcesses: 10, fixtureOwnedProcessGroups: 4 });
      expect(report).not.toHaveProperty('score'); expect(report).not.toHaveProperty('passed');
    } else {
      expect(printed()).toContain('diagnostic only; not a score or acceptance evidence');
      expect(printed()).toContain('Workflow broker processes: 100');
      expect(printed()).toContain('Workflow blob processes (subset, not added): 10');
    }
  });

  it.each([true, false])('keeps missing partial-report totals unknown and messages private (JSON=%s)', async json => {
    writeFileSync(input, JSON.stringify(partial()), { mode: 0o600 });
    expect(await inspect(json)).toBe(1); expect(errors).not.toHaveBeenCalled();
    if (json) {
      expect(JSON.parse(output.mock.calls[0]![0] as string)).toMatchObject({ reportedChecksSatisfied: false,
        leafProcesses: null, workflowProcesses: null, workflowBlobProcesses: null, fixtureOwnedProcessGroups: null,
        recordedWorkflowSubtotal: { processes: 60, blobProcesses: 6 }, diagnosticCodes: ['WORKFLOW_CANDIDATE_BEHAVIOR_FAILED'] });
    } else {
      expect(printed()).toContain('Workflow broker processes: unknown');
      expect(printed()).toContain('Recorded workflow subtotal: 60 processes; 6 blob subset');
    }
  });

  it.each(['symlink', 'directory', 'oversized', 'malformed-utf8', 'malformed-json', 'missing'] as const)(
    'refuses actual %s input with a static error and no filesystem mutation', async kind => {
      if (kind === 'symlink') {
        const target = join(root, 'target.json'); writeFileSync(target, JSON.stringify(complete()), { mode: 0o600 });
        symlinkSync(target, input);
      } else if (kind === 'directory') mkdirSync(input, { mode: 0o700 });
      else if (kind === 'oversized') writeFileSync(input, privateText.repeat(1024), { mode: 0o600 });
      else if (kind === 'malformed-utf8') writeFileSync(input, Buffer.concat([Buffer.from(JSON.stringify(complete())), Buffer.from([0xff])]), { mode: 0o600 });
      else if (kind === 'malformed-json') writeFileSync(input, privateText + '{', { mode: 0o600 });
      expect(await inspect(true)).toBe(1);
      expect(errors).not.toHaveBeenCalled(); expect(output).toHaveBeenCalledTimes(1);
      expect(JSON.parse(output.mock.calls[0]![0] as string)).toEqual({ scope: 'diagnostic-only', error: 'REPORT_UNAVAILABLE' });
    });
});
