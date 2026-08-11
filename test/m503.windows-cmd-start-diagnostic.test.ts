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
const TERMINATION_LIMIT_MS = 2_000;
const MATRIX_LIMIT_MS = 35_000;
const CLOCK_SKEW_MS = 2_000;

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
  cleanupError?: string;
  finishedAt?: string;
  durationMs?: number;
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
}): Promise<void> {
  const { child, cmd, id, matrixDeadlineMs, powershell, report, startedAtMs } =
    options;
  const terminationDeadline = Math.min(
    Date.now() + TERMINATION_LIMIT_MS,
    matrixDeadlineMs,
  );
  const queryBudget = Math.max(
    250,
    Math.min(1_300, terminationDeadline - Date.now()),
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
  if (!childClosed(child) && report.retentionQueryErrors.length > 0) {
    throw new Error(
      "could not verify a still-open outer cmd process for exact-PID cleanup",
    );
  }
}

async function runVariant(
  definition: VariantDefinition,
  cmd: string,
  powershell: string,
  matrixDeadlineMs: number,
): Promise<VariantReport> {
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
  };
  const stdout = createCappedCapture();
  const stderr = createCappedCapture();
  let child: ChildProcess | undefined;
  let primaryFailure: unknown;
  let cleanupFailure: unknown;

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
      await cleanupProcesses({
        child,
        cmd,
        id,
        matrixDeadlineMs,
        powershell,
        report,
        startedAtMs,
      });
    } catch (error) {
      cleanupFailure = error;
    }

    report.cwdRemovalAttempted = true;
    try {
      rmSync(cwd, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 25,
      });
      report.cwdRemoved = !existsSync(cwd);
      if (!report.cwdRemoved && cleanupFailure === undefined) {
        cleanupFailure = new Error(
          "diagnostic cwd still exists after bounded removal",
        );
      }
    } catch (error) {
      report.cwdRemoved = false;
      if (cleanupFailure === undefined) cleanupFailure = error;
    }
    if (cleanupFailure !== undefined)
      report.cleanupError = message(cleanupFailure);
    report.finishedAt = new Date().toISOString();
    report.durationMs = Date.now() - startedAtMs;
  }

  if (primaryFailure !== undefined) {
    if (primaryFailure instanceof Error && cleanupFailure !== undefined) {
      Object.defineProperty(primaryFailure, "cleanupError", {
        configurable: true,
        enumerable: false,
        value: cleanupFailure,
      });
    }
    throw primaryFailure;
  }
  if (cleanupFailure !== undefined) throw cleanupFailure;
  return report;
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
      const reports: VariantReport[] = [];

      for (const definition of variants) {
        reports.push(
          await runVariant(definition, cmd, powershell, matrixDeadlineMs),
        );
      }

      const matrixDurationMs = Date.now() - matrixStartedAtMs;
      console.info(
        "[M503 cmd/start diagnostic]",
        JSON.stringify({ matrixDurationMs, reports }),
      );
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
          (report) => report.cwdRemovalAttempted && report.cwdRemoved,
        ),
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
    MATRIX_LIMIT_MS,
  );
});
