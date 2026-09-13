import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, type Stats } from 'node:fs';
import { isAbsolute, parse as parsePath, resolve } from 'node:path';
import { TextDecoder } from 'node:util';
import { parsePreparationMeasurementReport, summarizePreparationMeasurementReport,
  type PreparationMeasurementSummary } from '../core/universe/preparation-measurement-report.js';

const LIMIT = 24 * 1024;
const USAGE = `usage: ashlr universe preparation-measurement --input <absolute report.json> [--json]

Read one regular UTF-8 installed preparation measurement report, at most 24 KiB.
Diagnostic only: reported checks and counts are not a score or acceptance evidence.
Workload v1 has 19 checks; v2 has 23 including two during-call qualification pairs.
Qualification counters are separate from the existing 15 measured regions.
No store discovery, execution, registration or provider access occurs.
Exit codes: 0 reported checks satisfied, 1 failed/unavailable report, 2 invalid arguments.
`;
class UsageError extends Error {}
interface Options { input?: string; json: boolean; help: boolean }
const controls = (value: string) => [...value].some(character => {
  const code = character.charCodeAt(0); return code < 32 || code >= 127 && code <= 159;
});

function options(args: string[]): Options {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) return { help: true, json: false };
  let input: string | undefined, json = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (typeof arg !== 'string' || controls(arg)) throw new UsageError();
    if (arg === '--json' && !json) json = true;
    else if (arg === '--input' && input === undefined) {
      const value = args[++index];
      if (typeof value !== 'string' || !value || controls(value) || Buffer.byteLength(value) > 4096 ||
          !isAbsolute(value) || resolve(value) !== value || parsePath(value).root === value) throw new UsageError();
      input = value;
    } else throw new UsageError();
  }
  if (input === undefined) throw new UsageError();
  return { input, json, help: false };
}

function sameFile(before: Stats, after: Stats): boolean {
  return after.isFile() && !after.isSymbolicLink() && before.dev === after.dev && before.ino === after.ino &&
    before.size === after.size && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs;
}

/** Descriptor reads are bounded independently of the initial size observation. */
export function readPreparationEvidenceFile(file: string, limit = LIMIT): string {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 2 * 1024 * 1024) throw new Error('Invalid evidence limit');
  let fd: number | undefined;
  try {
    const before = lstatSync(file);
    if (!before.isFile() || before.isSymbolicLink() || !Number.isSafeInteger(before.size) || before.size < 1 || before.size > limit) throw new Error();
    fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    if (!sameFile(before, fstatSync(fd))) throw new Error();
    const bytes = Buffer.alloc(limit + 1); let length = 0;
    while (length < bytes.length) {
      const count = readSync(fd, bytes, length, bytes.length - length, length);
      if (!Number.isSafeInteger(count) || count < 0 || count > bytes.length - length) throw new Error();
      if (count === 0) break;
      length += count;
    }
    if (length > limit || length !== before.size || !sameFile(before, fstatSync(fd)) || !sameFile(before, lstatSync(file))) throw new Error();
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length));
  } finally { if (fd !== undefined) closeSync(fd); }
}

function human(summary: PreparationMeasurementSummary): string {
  const count = (value: number | null) => value === null ? 'unknown' : String(value);
  return [
    'Preparation measurement · diagnostic only; not a score or acceptance evidence.',
    `Workload: ${summary.workload}`,
    `Reported checks: ${summary.reportedChecksSatisfied ? 'satisfied' : 'not satisfied'} (${summary.correctnessChecks})`,
    `During-call qualification: ${summary.qualificationStatus}`,
    `Leaf broker processes: ${count(summary.leafProcesses)}`,
    `Workflow broker processes: ${count(summary.workflowProcesses)}`,
    `Workflow blob processes (subset, not added): ${count(summary.workflowBlobProcesses)}`,
    `Recorded workflow subtotal: ${summary.recordedWorkflowSubtotal === null ? 'unknown' :
      `${summary.recordedWorkflowSubtotal.processes} processes; ${summary.recordedWorkflowSubtotal.blobProcesses} blob subset`}`,
    `Fixture-owned process groups (separate): ${count(summary.fixtureOwnedProcessGroups)}`,
    `Qualification broker processes (excluded from comparison total): ${count(summary.qualificationProcesses)}`,
    `Qualification blob processes (subset, not added): ${count(summary.qualificationBlobProcesses)}`,
    ...summary.qualifications.map(row => `Qualification ${row.name}: ${row.injections} observed mutation; ${row.processes} processes; ${row.blobProcesses} blob subset`),
    ...summary.workflows.flatMap(row => [
      `${row.name}: ${row.processes} processes; ${row.blobProcesses} blob subset`,
      ...row.requests.map(request => `  ${request.id}. ${request.method}: ${request.processes} processes; ${request.blobProcesses} blob subset`),
    ]),
    `Diagnostic codes: ${summary.diagnosticCodes.join(', ') || 'none'}`,
  ].join('\n');
}

export async function cmdUniversePreparationMeasurement(args: string[]): Promise<number> {
  let selected: Options;
  try { selected = options(args); }
  catch {
    if (args.includes('--json')) console.log(JSON.stringify({ scope: 'diagnostic-only', error: 'INVALID_ARGUMENTS' }));
    else console.error('universe preparation-measurement: invalid arguments; use --help');
    return 2;
  }
  if (selected.help) { console.log(USAGE); return 0; }
  try {
    const summary = summarizePreparationMeasurementReport(parsePreparationMeasurementReport(readPreparationEvidenceFile(selected.input!)));
    console.log(selected.json ? JSON.stringify({ schemaVersion: 1, kind: 'preparation-measurement-summary', scope: 'diagnostic-only', ...summary }) : human(summary));
    return summary.reportedChecksSatisfied ? 0 : 1;
  } catch {
    if (selected.json) console.log(JSON.stringify({ scope: 'diagnostic-only', error: 'REPORT_UNAVAILABLE' }));
    else console.error('universe preparation-measurement: report unavailable or malformed');
    return 1;
  }
}
