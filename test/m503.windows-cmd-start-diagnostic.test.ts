/**
 * M503 diagnostic — real Windows cmd.exe/START argv behavior.
 *
 * This is evidence gathering, not interactive desktop acceptance and not a
 * production launcher contract. It runs once on windows-latest, exercises five
 * fixed argv shapes sequentially, and prints one bounded JSON report. Every
 * command gets a unique UUID and structural cwd. Cleanup may terminate only the
 * exact System32 cmd.exe that this test spawned or a UUID-bearing descendant
 * whose creation time and parent chain are verified.
 */

import { describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const onWindows = process.platform === "win32";
const suite = describe.runIf(onWindows);
const OUTPUT_LIMIT_BYTES = 4 * 1024;
const EXECUTION_LIMIT_MS = 4_000;
// The first hosted evidence run showed every PowerShell/CIM observer exceeding
// 1.3 seconds. Two seconds is the smallest practical next observation bound;
// 750ms remains for exact-PID termination inside the 2.75-second cleanup bound.
const RETENTION_QUERY_LIMIT_MS = 2_000;
const TERMINATION_LIMIT_MS = 2_750;
// Five variants × (4s observe + 2.75s terminate + 0.75s cwd cleanup) = 37.5s.
// The 40-second matrix ceiling leaves 2.5s for fixed setup/reporting overhead.
const MATRIX_LIMIT_MS = 40_000;
const CLOCK_SKEW_MS = 2_000;
const CWD_REMOVAL_LIMIT_MS = 750;
const CWD_REMOVAL_RETRY_DELAY_MS = 50;
const JSON_RECORD_LIMIT_BYTES = 16 * 1024;

interface ProcessSample {
  pid: number;
  parentPid: number;
  executablePath: string;
  commandLine: string;
  creationMs: number;
}

interface PublicProcessSample {
  pid: number;
  parentPid: number;
  executablePath: string;
  creationMs: number;
  relation: "outer" | "descendant" | "unverified";
}

interface VariantDefinition {
  name: string;
  sentinelName: string;
  args: (id: string, cmd: string) => string[];
  windowsVerbatimArguments?: boolean;
}

interface VariantReport {
  name: string;
  id: string;
  cwd: string;
  args: string[];
  windowsVerbatimArguments: boolean;
  startedAt: string;
  spawnedAt?: string;
  pid?: number;
  exitAt?: string;
  exitCode?: number | null;
  exitSignal?: NodeJS.Signals | null;
  closeAt?: string;
  closeCode?: number | null;
  closeSignal?: NodeJS.Signals | null;
  spawnError?: string;
  sentinelAt?: string;
  sentinelObserved: boolean;
  timedOut: boolean;
  stdout: string;
  stdoutTruncated: boolean;
  stderr: string;
  stderrTruncated: boolean;
  retainedBeforeCleanup: PublicProcessSample[];
  terminatedPids: number[];
  retainedAfterCleanup: PublicProcessSample[];
  retentionQueryErrors: string[];
  cwdRemovalAttempted: boolean;
  cwdRemoved: boolean;
  cwdCleanupState:
    "not_attempted" | "removed" | "ebusy_after_exact_process_clear" | "failed";
  cwdCleanupAttempts: number;
  cwdCleanupError?: string;
  cleanupError?: string;
  finishedAt?: string;
  durationMs?: number;
}

interface CwdCleanupResult {
  attempts: number;
  error?: unknown;
  removed: boolean;
  state: VariantReport["cwdCleanupState"];
}

interface MatrixSummary<TReport> {
  failure?: string;
  matrixDurationMs: number;
  reports: TReport[];
}

interface MatrixVariantOutcome {
  primaryFailure?: unknown;
}

const variants: VariantDefinition[] = [
  {
    name: "direct child",
    sentinelName: "direct.txt",
    args: (id) => ["/d", "/c", `echo ${id}>direct.txt`],
  },
  {
    name: "outer /s",
    sentinelName: "outer.txt",
    args: (id) => ["/d", "/v:off", "/s", "/c", `echo ${id}>outer.txt`],
  },
  {
    name: "current",
    sentinelName: "current.txt",
    args: (id, cmd) => {
      const command = `start "" /b "${cmd}" /d /c "echo ${id}>current.txt"`;
      return ["/d", "/v:off", "/s", "/c", command];
    },
  },
  {
    name: "current without /s",
    sentinelName: "current-without-s.txt",
    args: (id, cmd) => {
      const command = `start "" /b "${cmd}" /d /c "echo ${id}>current-without-s.txt"`;
      return ["/d", "/v:off", "/c", command];
    },
  },
  {
    name: "Node-canonical explicit outer quotes",
    sentinelName: "node-canonical.txt",
    args: (id, cmd) => {
      const command = `start "" /b "${cmd}" /d /c "echo ${id}>node-canonical.txt"`;
      return ["/d", "/v:off", "/s", "/c", `"${command}"`];
    },
    windowsVerbatimArguments: true,
  },
];

function message(error: unknown): string {
  return error instanceof Error
    ? `${error.name}: ${error.message}`
    : String(error);
}

function boundedJson(
  value: unknown,
  fallback: Record<string, unknown>,
): string {
  const encoded = JSON.stringify(value);
  const encodedBytes = Buffer.byteLength(encoded);
  if (encodedBytes <= JSON_RECORD_LIMIT_BYTES) return encoded;
  return JSON.stringify({
    ...fallback,
    originalBytes: encodedBytes,
    truncated: true,
  });
}

function emitDiagnosticRecord(
  label: string,
  value: unknown,
  fallback: Record<string, unknown>,
  logger: (label: string, json: string) => void = console.info,
): void {
  logger(label, boundedJson(value, fallback));
}

function preservePrimaryFailure(
  primaryFailure: unknown,
  cleanupFailure: unknown,
): unknown {
  if (primaryFailure !== undefined) {
    if (primaryFailure instanceof Error && cleanupFailure !== undefined) {
      Object.defineProperty(primaryFailure, "cleanupError", {
        configurable: true,
        enumerable: false,
        value: cleanupFailure,
      });
    }
    return primaryFailure;
  }
  return cleanupFailure;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createCappedCapture(): {
  append: (chunk: Buffer | string) => void;
  value: () => string;
  truncated: () => boolean;
} {
  const chunks: Buffer[] = [];
  let capturedBytes = 0;
  let wasTruncated = false;
  return {
    append(chunk) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const remaining = OUTPUT_LIMIT_BYTES - capturedBytes;
      if (remaining > 0) {
        const kept = buffer.subarray(0, remaining);
        chunks.push(kept);
        capturedBytes += kept.byteLength;
      }
      if (buffer.byteLength > remaining) wasTruncated = true;
    },
    value: () => Buffer.concat(chunks).toString("utf8"),
    truncated: () => wasTruncated,
  };
}

function childClosed(child: ChildProcess | undefined): boolean {
  return !child || child.exitCode !== null || child.signalCode !== null;
}

function pidExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

async function collectProcessSamples(
  powershell: string,
  id: string,
  timeoutMs: number,
): Promise<ProcessSample[]> {
  // EncodedCommand keeps the UUID out of the PowerShell process command line,
  // so the observer cannot match itself while querying UUID-bearing cmd rows.
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)",
    `$needle = '${id}'`,
    "$rows = @(Get-CimInstance Win32_Process | Where-Object {",
    "  $_.CommandLine -and $_.CommandLine.Contains($needle)",
    "} | ForEach-Object {",
    "  [pscustomobject]@{",
    "    pid = [int]$_.ProcessId",
    "    parentPid = [int]$_.ParentProcessId",
    "    executablePath = [string]$_.ExecutablePath",
    "    commandLine = [string]$_.CommandLine",
    "    creationMs = ([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds()",
    "  }",
    "})",
    "if ($rows.Count -eq 0) { Write-Output '[]' } else { $rows | ConvertTo-Json -Compress }",
  ].join("\n");
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  const stdout = createCappedCapture();
  const stderr = createCappedCapture();
  const observer = spawn(
    powershell,
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-EncodedCommand",
      encoded,
    ],
    {
      shell: false,
      windowsHide: true,
      detached: false,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  observer.stdout?.on("data", stdout.append);
  observer.stderr?.on("data", stderr.append);
  let observerError: Error | undefined;
  observer.once("error", (error) => {
    observerError = error;
  });
  let closeCode: number | null | undefined;
  const closed = new Promise<void>((resolve) => {
    observer.once("close", (code) => {
      closeCode = code;
      resolve();
    });
  });
  const completed = await Promise.race([
    closed.then(() => true),
    delay(timeoutMs).then(() => false),
  ]);
  if (!completed) {
    // This is the exact PowerShell observer handle created above, never a name-
    // based or tree-wide kill. It cannot terminate an unrelated cmd process.
    observer.kill();
    await Promise.race([closed, delay(250)]);
    throw new Error(`process-retention query exceeded ${timeoutMs}ms`);
  }
  if (observerError) throw observerError;
  if (closeCode !== 0) {
    throw new Error(
      `process-retention query exited ${String(closeCode)}: ${stderr.value().slice(0, 512)}`,
    );
  }
  if (stdout.truncated() || stderr.truncated()) {
    throw new Error("process-retention query exceeded its 4KiB output cap");
  }
  const raw = stdout.value().trim();
  if (!raw) return [];
  const parsed = JSON.parse(raw) as ProcessSample | ProcessSample[];
  return (Array.isArray(parsed) ? parsed : [parsed]).filter(
    (row) => Number.isInteger(row.pid) && Number.isInteger(row.parentPid),
  );
}

function classifyProcess(
  row: ProcessSample,
  allRows: ProcessSample[],
  outerPid: number | undefined,
  cmd: string,
  id: string,
  startedAtMs: number,
): PublicProcessSample {
  const canonical = row.executablePath.toLowerCase() === cmd.toLowerCase();
  const uuidBound = row.commandLine.includes(id);
  const timeBound =
    row.creationMs >= startedAtMs - CLOCK_SKEW_MS &&
    row.creationMs <= Date.now() + CLOCK_SKEW_MS;
  let relation: PublicProcessSample["relation"] = "unverified";
  if (canonical && uuidBound && timeBound && outerPid !== undefined) {
    if (row.pid === outerPid) {
      relation = "outer";
    } else {
      const seen = new Set<number>();
      let cursor: ProcessSample | undefined = row;
      while (cursor && !seen.has(cursor.pid)) {
        seen.add(cursor.pid);
        if (cursor.parentPid === outerPid) {
          relation = "descendant";
          break;
        }
        cursor = allRows.find(
          (candidate) => candidate.pid === cursor?.parentPid,
        );
      }
    }
  }
  return {
    pid: row.pid,
    parentPid: row.parentPid,
    executablePath: row.executablePath,
    creationMs: row.creationMs,
    relation,
  };
}

function classifyProcesses(
  rows: ProcessSample[],
  outerPid: number | undefined,
  cmd: string,
  id: string,
  startedAtMs: number,
): PublicProcessSample[] {
  return rows.map((row) =>
    classifyProcess(row, rows, outerPid, cmd, id, startedAtMs),
  );
}

async function cleanupProcesses(options: {
  child: ChildProcess | undefined;
  cmd: string;
  id: string;
  matrixDeadlineMs: number;
  powershell: string;
  report: VariantReport;
  startedAtMs: number;
}): Promise<boolean> {
  const { child, cmd, id, matrixDeadlineMs, powershell, report, startedAtMs } =
    options;
  const terminationDeadline = Math.min(
    Date.now() + TERMINATION_LIMIT_MS,
    matrixDeadlineMs,
  );
  const terminationRemainingMs = terminationDeadline - Date.now();
  if (terminationRemainingMs <= 0) {
    throw new Error("matrix deadline expired before exact retention query");
  }
  const queryBudget = Math.min(
    RETENTION_QUERY_LIMIT_MS,
    terminationRemainingMs,
  );
  let rows: ProcessSample[] = [];
  try {
    rows = await collectProcessSamples(powershell, id, queryBudget);
  } catch (error) {
    report.retentionQueryErrors.push(message(error));
  }
  report.retainedBeforeCleanup = classifyProcesses(
    rows,
    report.pid,
    cmd,
    id,
    startedAtMs,
  );

  const unverified = report.retainedBeforeCleanup.filter(
    (sample) => sample.relation === "unverified",
  );
  const verified = report.retainedBeforeCleanup.filter(
    (sample) => sample.relation !== "unverified",
  );
  // Descendants are terminated before their known outer process. Every PID
  // came from an exact canonical-path, UUID, time, and ancestry match above.
  verified.sort(
    (left, right) =>
      Number(right.relation === "descendant") -
      Number(left.relation === "descendant"),
  );
  for (const sample of verified) {
    try {
      process.kill(sample.pid);
      report.terminatedPids.push(sample.pid);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  }

  if (verified.length > 0) {
    while (Date.now() < terminationDeadline) {
      if (verified.every((sample) => !pidExists(sample.pid))) break;
      await delay(Math.min(25, Math.max(1, terminationDeadline - Date.now())));
    }
  }
  report.retainedAfterCleanup = [
    ...unverified,
    ...verified.filter((sample) => pidExists(sample.pid)),
  ];
  if (!childClosed(child) && report.retainedBeforeCleanup.length === 0) {
    throw new Error(
      "still-open outer cmd was absent from the exact UUID retention query",
    );
  }
  if (unverified.length > 0) {
    throw new Error(
      `refused to terminate ${unverified.length} unverified UUID process(es)`,
    );
  }
  if (report.retainedAfterCleanup.length > 0) {
    throw new Error(
      `${report.retainedAfterCleanup.length} UUID process(es) remained after bounded cleanup`,
    );
  }
  if (report.retentionQueryErrors.length > 0) {
    throw new Error("could not establish exact UUID process-retention state");
  }
  return true;
}

async function removeVariantCwd(options: {
  cwd: string;
  exactProcessClear: boolean;
  matrixDeadlineMs: number;
  delayFn?: (ms: number) => Promise<void>;
  existsFn?: (path: string) => boolean;
  nowFn?: () => number;
  removeFn?: (path: string) => void;
}): Promise<CwdCleanupResult> {
  const {
    cwd,
    exactProcessClear,
    matrixDeadlineMs,
    delayFn = delay,
    existsFn = existsSync,
    nowFn = Date.now,
    removeFn = (path) =>
      rmSync(path, {
        recursive: true,
        force: true,
        maxRetries: 0,
      }),
  } = options;
  const removalDeadline = Math.min(
    nowFn() + CWD_REMOVAL_LIMIT_MS,
    matrixDeadlineMs,
  );
  let attempts = 0;
  let lastError: unknown;

  do {
    attempts += 1;
    try {
      removeFn(cwd);
      if (!existsFn(cwd)) {
        return { attempts, removed: true, state: "removed" };
      }
      lastError = new Error("diagnostic cwd still exists after removal");
    } catch (error) {
      lastError = error;
      if ((error as NodeJS.ErrnoException).code !== "EBUSY") break;
    }
    const remainingMs = removalDeadline - nowFn();
    if (remainingMs <= 0) break;
    await delayFn(Math.min(CWD_REMOVAL_RETRY_DELAY_MS, remainingMs));
  } while (nowFn() < removalDeadline);

  const retainedEbusy =
    (lastError as NodeJS.ErrnoException | undefined)?.code === "EBUSY";
  return {
    attempts,
    error: lastError,
    removed: false,
    state:
      retainedEbusy && exactProcessClear
        ? "ebusy_after_exact_process_clear"
        : "failed",
  };
}

async function executeDiagnosticMatrix<TDefinition, TReport>(options: {
  deadlineMs?: number;
  definitions: readonly TDefinition[];
  emit: (kind: "variant" | "summary", value: unknown) => void;
  nowFn?: () => number;
  run: (
    definition: TDefinition,
    publish: (report: TReport) => void,
  ) => Promise<MatrixVariantOutcome>;
  validate: (reports: TReport[], matrixDurationMs: number) => void;
}): Promise<void> {
  const {
    deadlineMs,
    definitions,
    emit,
    nowFn = Date.now,
    run,
    validate,
  } = options;
  const matrixStartedAtMs = nowFn();
  const reports: TReport[] = [];
  let firstPrimaryFailure: unknown;
  let matrixFailure: unknown;

  try {
    for (const [index, definition] of definitions.entries()) {
      if (deadlineMs !== undefined && nowFn() >= deadlineMs) {
        throw new Error(
          `diagnostic matrix deadline exhausted before variant ${index + 1}`,
        );
      }
      const outcome = await run(definition, (report) => {
        reports.push(report);
        emit("variant", report);
      });
      if (
        firstPrimaryFailure === undefined &&
        outcome.primaryFailure !== undefined
      ) {
        firstPrimaryFailure = outcome.primaryFailure;
      }
    }
    let validationFailure: unknown;
    try {
      validate(reports, nowFn() - matrixStartedAtMs);
    } catch (error) {
      validationFailure = error;
    }
    const completedFailure = preservePrimaryFailure(
      firstPrimaryFailure,
      validationFailure,
    );
    if (completedFailure !== undefined) throw completedFailure;
  } catch (error) {
    matrixFailure = error;
    throw error;
  } finally {
    const summary: MatrixSummary<TReport> = {
      matrixDurationMs: nowFn() - matrixStartedAtMs,
      reports,
    };
    if (matrixFailure !== undefined) summary.failure = message(matrixFailure);
    emit("summary", summary);
  }
}

async function runVariant(
  definition: VariantDefinition,
  cmd: string,
  powershell: string,
  matrixDeadlineMs: number,
  publishObservation: (report: VariantReport) => void,
): Promise<MatrixVariantOutcome> {
  const id = randomUUID();
  const cwd = realpathSync.native(
    mkdtempSync(join(tmpdir(), `ashlr-m503-${id}-`)),
  );
  const sentinelPath = join(cwd, definition.sentinelName);
  const args = definition.args(id, cmd);
  const startedAtMs = Date.now();
  const report: VariantReport = {
    name: definition.name,
    id,
    cwd,
    args,
    windowsVerbatimArguments: definition.windowsVerbatimArguments === true,
    startedAt: new Date(startedAtMs).toISOString(),
    sentinelObserved: false,
    timedOut: false,
    stdout: "",
    stdoutTruncated: false,
    stderr: "",
    stderrTruncated: false,
    retainedBeforeCleanup: [],
    terminatedPids: [],
    retainedAfterCleanup: [],
    retentionQueryErrors: [],
    cwdRemovalAttempted: false,
    cwdRemoved: false,
    cwdCleanupState: "not_attempted",
    cwdCleanupAttempts: 0,
  };
  const stdout = createCappedCapture();
  const stderr = createCappedCapture();
  let child: ChildProcess | undefined;
  let primaryFailure: unknown;
  let retentionFailure: unknown;
  let cwdCleanupFailure: unknown;
  let exactProcessClear = false;

  try {
    try {
      child = spawn(cmd, args, {
        cwd,
        shell: false,
        windowsHide: true,
        detached: false,
        stdio: ["ignore", "pipe", "pipe"],
        windowsVerbatimArguments: definition.windowsVerbatimArguments === true,
      });
      report.pid = child.pid;
      child.stdout?.on("data", stdout.append);
      child.stderr?.on("data", stderr.append);
      child.once("spawn", () => {
        report.spawnedAt = new Date().toISOString();
      });
      child.once("error", (error) => {
        report.spawnError = message(error);
      });
      child.once("exit", (code, signal) => {
        report.exitAt = new Date().toISOString();
        report.exitCode = code;
        report.exitSignal = signal;
      });
      child.once("close", (code, signal) => {
        report.closeAt = new Date().toISOString();
        report.closeCode = code;
        report.closeSignal = signal;
      });
    } catch (error) {
      report.spawnError = message(error);
    }

    const executionDeadline = Math.min(
      startedAtMs + EXECUTION_LIMIT_MS,
      matrixDeadlineMs,
    );
    let closeObservedAt: number | undefined;
    while (Date.now() < executionDeadline) {
      if (!report.sentinelObserved && existsSync(sentinelPath)) {
        try {
          report.sentinelObserved =
            readFileSync(sentinelPath, "utf8").trim() === id;
          if (report.sentinelObserved)
            report.sentinelAt = new Date().toISOString();
        } catch {
          // The writer may still be closing the file; retry inside the fixed bound.
        }
      }
      if (report.closeAt && closeObservedAt === undefined)
        closeObservedAt = Date.now();
      if (report.spawnError || (report.sentinelObserved && report.closeAt))
        break;
      if (closeObservedAt !== undefined && Date.now() - closeObservedAt >= 100)
        break;
      await delay(Math.min(25, Math.max(1, executionDeadline - Date.now())));
    }
    report.timedOut = !childClosed(child) && Date.now() >= executionDeadline;
  } catch (error) {
    primaryFailure = error;
  } finally {
    report.stdout = stdout.value();
    report.stdoutTruncated = stdout.truncated();
    report.stderr = stderr.value();
    report.stderrTruncated = stderr.truncated();

    try {
      exactProcessClear = await cleanupProcesses({
        child,
        cmd,
        id,
        matrixDeadlineMs,
        powershell,
        report,
        startedAtMs,
      });
    } catch (error) {
      retentionFailure = error;
    }

    if (retentionFailure !== undefined)
      report.cleanupError = message(retentionFailure);
    // Publish the UUID/name mapping and all process evidence before touching
    // the cwd. A Windows directory-release race cannot erase argv evidence.
    publishObservation(report);

    report.cwdRemovalAttempted = true;
    const cwdCleanup = await removeVariantCwd({
      cwd,
      exactProcessClear,
      matrixDeadlineMs,
    });
    report.cwdCleanupAttempts = cwdCleanup.attempts;
    report.cwdCleanupState = cwdCleanup.state;
    report.cwdRemoved = cwdCleanup.removed;
    if (cwdCleanup.error !== undefined)
      report.cwdCleanupError = message(cwdCleanup.error);
    if (cwdCleanup.state === "failed") cwdCleanupFailure = cwdCleanup.error;
    const reportedCleanupFailure = retentionFailure ?? cwdCleanupFailure;
    if (reportedCleanupFailure !== undefined)
      report.cleanupError = message(reportedCleanupFailure);
    report.finishedAt = new Date().toISOString();
    report.durationMs = Date.now() - startedAtMs;
    emitDiagnosticRecord(
      "[M503 cmd/start cleanup]",
      {
        cleanupError: report.cleanupError,
        cwdCleanupAttempts: report.cwdCleanupAttempts,
        cwdCleanupError: report.cwdCleanupError,
        cwdCleanupState: report.cwdCleanupState,
        cwdRemoved: report.cwdRemoved,
        id: report.id,
        name: report.name,
        retainedAfterCleanup: report.retainedAfterCleanup,
      },
      { id: report.id, name: report.name, record: "cleanup" },
    );
  }

  if (retentionFailure !== undefined) {
    // Unknown or retained UUID process state is a hard stop. The first primary
    // variant error remains authoritative, with the retention failure attached.
    throw preservePrimaryFailure(primaryFailure, retentionFailure);
  }
  return {
    primaryFailure: preservePrimaryFailure(primaryFailure, cwdCleanupFailure),
  };
}

suite("bounded Windows cmd.exe/START diagnostic matrix", () => {
  it(
    "records exactly five sequential argv variants without opening an interactive window",
    async () => {
      const matrixStartedAtMs = Date.now();
      const matrixDeadlineMs = matrixStartedAtMs + MATRIX_LIMIT_MS - 250;
      const systemRoot = realpathSync.native(process.env["SystemRoot"] ?? "");
      const cmd = realpathSync.native(join(systemRoot, "System32", "cmd.exe"));
      const powershell = realpathSync.native(
        join(
          systemRoot,
          "System32",
          "WindowsPowerShell",
          "v1.0",
          "powershell.exe",
        ),
      );
      await executeDiagnosticMatrix<VariantDefinition, VariantReport>({
        deadlineMs: matrixDeadlineMs,
        definitions: variants,
        emit(kind, value) {
          const report = value as Partial<VariantReport>;
          const summary = value as Partial<MatrixSummary<VariantReport>>;
          emitDiagnosticRecord(
            kind === "variant"
              ? "[M503 cmd/start variant]"
              : "[M503 cmd/start diagnostic]",
            value,
            kind === "variant"
              ? {
                  closeObserved: report.closeAt !== undefined,
                  exitObserved: report.exitAt !== undefined,
                  id: report.id,
                  name: report.name,
                  record: "variant",
                  retainedAfterCleanup: report.retainedAfterCleanup?.length,
                  sentinelObserved: report.sentinelObserved,
                }
              : {
                  failure: summary.failure,
                  matrixDurationMs: summary.matrixDurationMs,
                  record: "summary",
                  reports: summary.reports?.map((entry) => ({
                    cwdCleanupState: entry.cwdCleanupState,
                    id: entry.id,
                    name: entry.name,
                    retainedAfterCleanup: entry.retainedAfterCleanup.length,
                    sentinelObserved: entry.sentinelObserved,
                  })),
                },
          );
        },
        async run(definition, publish) {
          return runVariant(
            definition,
            cmd,
            powershell,
            matrixDeadlineMs,
            publish,
          );
        },
        validate(reports, matrixDurationMs) {
          expect(reports.map((report) => report.name)).toEqual([
            "direct child",
            "outer /s",
            "current",
            "current without /s",
            "Node-canonical explicit outer quotes",
          ]);
          expect(new Set(reports.map((report) => report.id)).size).toBe(5);
          expect(new Set(reports.map((report) => report.cwd)).size).toBe(5);
          expect(
            reports.every(
              (report) =>
                report.cwdRemovalAttempted &&
                (report.cwdRemoved ||
                  report.cwdCleanupState === "ebusy_after_exact_process_clear"),
            ),
          ).toBe(true);
          expect(
            reports.every((report) => report.retainedAfterCleanup.length === 0),
          ).toBe(true);
          expect(
            reports.every(
              (report) =>
                Buffer.byteLength(report.stdout) <= OUTPUT_LIMIT_BYTES &&
                Buffer.byteLength(report.stderr) <= OUTPUT_LIMIT_BYTES,
            ),
          ).toBe(true);
          expect(matrixDurationMs).toBeLessThanOrEqual(MATRIX_LIMIT_MS);
        },
      });
    },
    MATRIX_LIMIT_MS,
  );
});

describe("M503 diagnostic harness regressions", () => {
  it("continues after a safely cleared variant failure and rethrows it after the full matrix", async () => {
    const firstFailure = new Error("first variant failed");
    const emitted: Array<{ kind: string; value: unknown }> = [];
    let validated = false;

    await expect(
      executeDiagnosticMatrix<string, { id: string; name: string }>({
        definitions: ["first", "second"],
        emit: (kind, value) => emitted.push({ kind, value }),
        async run(definition, publish) {
          publish({ id: `uuid-${definition}`, name: definition });
          return definition === "first" ? { primaryFailure: firstFailure } : {};
        },
        validate: () => {
          validated = true;
        },
      }),
    ).rejects.toBe(firstFailure);

    expect(emitted.map(({ kind }) => kind)).toEqual([
      "variant",
      "variant",
      "summary",
    ]);
    expect(emitted[0]?.value).toEqual({ id: "uuid-first", name: "first" });
    expect(emitted[1]?.value).toEqual({ id: "uuid-second", name: "second" });
    expect(emitted[2]?.value).toMatchObject({
      failure: "Error: first variant failed",
      reports: [
        { id: "uuid-first", name: "first" },
        { id: "uuid-second", name: "second" },
      ],
    });
    expect(validated).toBe(true);
  });

  it("stops immediately when exact process retention cannot be established", async () => {
    const retentionUnknown = new Error("retention unknown");
    const emitted: Array<{ kind: string; value: unknown }> = [];
    const attempted: string[] = [];

    await expect(
      executeDiagnosticMatrix<string, { id: string; name: string }>({
        definitions: ["first", "unsafe", "unreached"],
        emit: (kind, value) => emitted.push({ kind, value }),
        async run(definition, publish) {
          attempted.push(definition);
          publish({ id: `uuid-${definition}`, name: definition });
          if (definition === "unsafe") throw retentionUnknown;
          return {};
        },
        validate: () => {
          throw new Error("validation must not run after unsafe retention");
        },
      }),
    ).rejects.toBe(retentionUnknown);

    expect(attempted).toEqual(["first", "unsafe"]);
    expect(emitted.map(({ kind }) => kind)).toEqual([
      "variant",
      "variant",
      "summary",
    ]);
    expect(emitted.at(-1)?.value).toMatchObject({
      failure: "Error: retention unknown",
      reports: [
        { id: "uuid-first", name: "first" },
        { id: "uuid-unsafe", name: "unsafe" },
      ],
    });
  });

  it("keeps the first safely cleared primary failure after later failures", async () => {
    const firstFailure = new Error("first failure");
    const secondFailure = new Error("second failure");
    const attempted: string[] = [];

    await expect(
      executeDiagnosticMatrix<string, { id: string; name: string }>({
        definitions: ["first", "second", "third"],
        emit: () => undefined,
        async run(definition, publish) {
          attempted.push(definition);
          publish({ id: `uuid-${definition}`, name: definition });
          if (definition === "first") return { primaryFailure: firstFailure };
          if (definition === "second") return { primaryFailure: secondFailure };
          return {};
        },
        validate: () => undefined,
      }),
    ).rejects.toBe(firstFailure);

    expect(attempted).toEqual(["first", "second", "third"]);
  });

  it("stops before starting a variant after the total matrix deadline", async () => {
    const emitted: Array<{ kind: string; value: unknown }> = [];
    const attempted: string[] = [];
    let now = 0;

    await expect(
      executeDiagnosticMatrix<string, { id: string; name: string }>({
        deadlineMs: 10,
        definitions: ["first", "past-deadline"],
        emit: (kind, value) => emitted.push({ kind, value }),
        nowFn: () => now,
        async run(definition, publish) {
          attempted.push(definition);
          publish({ id: `uuid-${definition}`, name: definition });
          now = 10;
          return {};
        },
        validate: () => {
          throw new Error("validation must not run after deadline exhaustion");
        },
      }),
    ).rejects.toThrow("diagnostic matrix deadline exhausted before variant 2");

    expect(attempted).toEqual(["first"]);
    expect(emitted.map(({ kind }) => kind)).toEqual(["variant", "summary"]);
    expect(emitted.at(-1)?.value).toMatchObject({
      matrixDurationMs: 10,
      reports: [{ id: "uuid-first", name: "first" }],
    });
  });

  it("classifies bounded EBUSY as nonfatal only after exact process-clear evidence", async () => {
    const ebusy = Object.assign(new Error("resource busy"), { code: "EBUSY" });
    let now = 0;
    const removeFn = (): never => {
      throw ebusy;
    };
    const delayFn = async (ms: number): Promise<void> => {
      now += ms;
    };
    const common = {
      cwd: "diagnostic-cwd",
      delayFn,
      existsFn: () => true,
      matrixDeadlineMs: 1_000,
      nowFn: () => now,
      removeFn,
    };

    const exact = await removeVariantCwd({
      ...common,
      exactProcessClear: true,
    });
    now = 0;
    const unproven = await removeVariantCwd({
      ...common,
      exactProcessClear: false,
    });

    expect(exact).toMatchObject({
      removed: false,
      state: "ebusy_after_exact_process_clear",
    });
    expect(unproven).toMatchObject({ removed: false, state: "failed" });
    expect(exact.attempts).toBeGreaterThan(1);
    expect(unproven.attempts).toBe(exact.attempts);
  });

  it("preserves the primary variant failure while retaining cleanup evidence", () => {
    const primary = new Error("variant observation failed");
    const cleanup = new Error("cleanup failed");

    expect(preservePrimaryFailure(primary, cleanup)).toBe(primary);
    expect((primary as Error & { cleanupError?: unknown }).cleanupError).toBe(
      cleanup,
    );
    expect(preservePrimaryFailure(undefined, cleanup)).toBe(cleanup);
  });
});
