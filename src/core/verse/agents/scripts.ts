/**
 * core/verse/agents/scripts.ts — running a workspace's setup / run / archive
 * scripts (from the repo's `.ashlr/verse/workspace.json`).
 *
 * TWO WAYS, one record (ScriptRunRecord):
 *   - `terminal` — a Terminal tab in the agent's own chat (desktop app: the
 *     built-in PTY). The operator watches setup scroll by, Ctrl-C's a dev
 *     server, types into it. Setup / archive end their shell when the script
 *     ends (`; exit`), so the tab's exit code IS the script's; a Run script
 *     leaves the shell open.
 *   - `process` — no built-in terminal (a plain browser session): a
 *     background `/bin/sh -c` child in the worktree whose output is kept (the
 *     last 256 KB) for the Checks tab's log view.
 *
 * ENV: the sidecar's own environment MINUS every ASHLR_* setting (the
 * mutation token lives there), plus the workspace's ASHLR_WORKSPACE_PATH /
 * _NAME, ASHLR_ROOT_PATH and ASHLR_PORT / _PORT_COUNT.
 *
 * The command is the repo's own text, built into argv here (never shell-joined
 * from a request): `env K=V … /bin/sh -c '<script>'`.
 *
 * NODE-ONLY.
 */
import { spawn, type ChildProcess } from 'node:child_process';

import { shellJoin } from '../preview.js';
import type { ScriptKind, WorkspaceEnv } from './types.js';

const LOG_MAX_BYTES = 256 * 1024;

export interface ScriptStartInput {
  runId: string;
  kind: ScriptKind;
  name: string;
  /** The agent's chat (a terminal tab belongs to it); null → always a background process. */
  sessionId: string | null;
  cwd: string;
  command: string;
  env: WorkspaceEnv;
}

export interface ScriptStatus {
  state: 'running' | 'ok' | 'failed';
  exitCode: number | null;
}

export interface ScriptLauncher {
  start(input: ScriptStartInput): Promise<{ via: 'terminal' | 'process'; tabId: string | null }>;
  /** Current state; null when this process never started (or has forgotten) the run. */
  status(runId: string): ScriptStatus | null;
  /** Captured output (process runs). */
  log(runId: string): { text: string; truncated: boolean } | null;
  stop(runId: string): void;
}

/** The environment a script child gets: no ASHLR_* secrets, plus the workspace's own. */
export function scriptEnv(env: WorkspaceEnv, base: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (typeof value !== 'string') continue;
    if (/^ashlr_/i.test(key)) continue;
    out[key] = value;
  }
  return { ...out, ...env };
}

/** What is typed into a terminal tab: `env K=V … /bin/sh -c '<script>'` (+ `; exit` for setup / archive). */
export function terminalCommand(input: Pick<ScriptStartInput, 'kind' | 'command' | 'env'>): string {
  const assignments = Object.entries(input.env).map(([k, v]) => `${k}=${v}`);
  const line = shellJoin(['env', ...assignments, '/bin/sh', '-c', input.command]);
  return input.kind === 'run' ? line : `${line}; exit`;
}

interface TerminalLike {
  available(): { available: boolean; reason: string | null };
  create(opts: { sessionId: string | null; root: string; cols: number; rows: number; startCommand?: string | null; cwd?: string | null }): Promise<{ id: string }>;
  get(id: string): { exited: { code: number | null } | null } | null;
  kill(id: string): void;
}

interface ProcRun {
  child: ChildProcess;
  chunks: Buffer[];
  bytes: number;
  truncated: boolean;
  status: ScriptStatus;
}

export interface ScriptLauncherDeps {
  /** The Terminal manager (lazily resolved; null = no built-in terminal in this server). */
  terminal?: () => Promise<TerminalLike | null>;
  spawnChild?: typeof spawn;
}

async function defaultTerminal(): Promise<TerminalLike | null> {
  try {
    const mod = await import('../terminal.js');
    return mod.getTerminalManager() as unknown as TerminalLike;
  } catch {
    return null;
  }
}

export function createScriptLauncher(deps: ScriptLauncherDeps = {}): ScriptLauncher {
  const terminalOf = deps.terminal ?? defaultTerminal;
  const spawnChild = deps.spawnChild ?? spawn;
  const tabs = new Map<string, { tabId: string; manager: TerminalLike; kind: ScriptKind }>();
  const procs = new Map<string, ProcRun>();

  function startProcess(input: ScriptStartInput): void {
    const child = spawnChild('/bin/sh', ['-c', input.command], {
      cwd: input.cwd,
      env: scriptEnv(input.env),
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
    const run: ProcRun = { child, chunks: [], bytes: 0, truncated: false, status: { state: 'running', exitCode: null } };
    const keep = (chunk: Buffer): void => {
      run.chunks.push(chunk);
      run.bytes += chunk.length;
      while (run.bytes > LOG_MAX_BYTES && run.chunks.length > 1) {
        run.bytes -= run.chunks.shift()!.length;
        run.truncated = true;
      }
    };
    child.stdout?.on('data', keep);
    child.stderr?.on('data', keep);
    child.on('error', () => {
      run.status = { state: 'failed', exitCode: null };
    });
    child.on('close', (code) => {
      run.status = { state: code === 0 ? 'ok' : 'failed', exitCode: code };
    });
    procs.set(input.runId, run);
  }

  return {
    async start(input) {
      const manager = input.sessionId ? await terminalOf() : null;
      if (manager && input.sessionId && manager.available().available) {
        try {
          const tab = await manager.create({
            sessionId: input.sessionId,
            root: input.cwd,
            cols: 120,
            rows: 32,
            startCommand: terminalCommand(input),
          });
          tabs.set(input.runId, { tabId: tab.id, manager, kind: input.kind });
          return { via: 'terminal', tabId: tab.id };
        } catch {
          /* fall through to a background process */
        }
      }
      startProcess(input);
      return { via: 'process', tabId: null };
    },
    status(runId) {
      const tab = tabs.get(runId);
      if (tab) {
        const live = tab.manager.get(tab.tabId);
        // The operator closed the tab: whatever it was doing stopped with it.
        if (!live) return { state: 'failed', exitCode: null };
        if (!live.exited) return { state: 'running', exitCode: null };
        return { state: live.exited.code === 0 ? 'ok' : 'failed', exitCode: live.exited.code };
      }
      const proc = procs.get(runId);
      return proc ? { ...proc.status } : null;
    },
    log(runId) {
      const proc = procs.get(runId);
      if (!proc) return null;
      return { text: Buffer.concat(proc.chunks).toString('utf8'), truncated: proc.truncated };
    },
    stop(runId) {
      const tab = tabs.get(runId);
      if (tab) {
        try { tab.manager.kill(tab.tabId); } catch { /* already gone */ }
        return;
      }
      const proc = procs.get(runId);
      if (proc && proc.status.state === 'running' && proc.child.pid) {
        try { process.kill(-proc.child.pid, 'SIGTERM'); } catch { /* exited */ }
      }
    },
  };
}

let launcher: ScriptLauncher | null = null;

export function getScriptLauncher(): ScriptLauncher {
  if (!launcher) launcher = createScriptLauncher();
  return launcher;
}

export function setScriptLauncherForTest(next: ScriptLauncher | null): void {
  launcher = next;
}
