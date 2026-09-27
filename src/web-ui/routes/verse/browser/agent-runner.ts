/**
 * routes/verse/browser/agent-runner.ts — how the Browser pane carries out
 * one agent command (core/verse/browser-mcp.ts queued it; browser-bridge.ts
 * relayed it). Pure apart from the executor it is handed.
 *
 * The pane re-applies the sidecar's gate BEFORE capturing anything: a tab
 * showing a page this chat may not observe (the operator's own external
 * browsing) is never screenshotted, read or reported — the refusal leaves
 * the machine, the page does not. The sidecar checks the answer's URL again.
 *
 * What an agent can make the pane do is exactly: say where it is, open a
 * gated URL, and capture (screenshot, text, console). No clicks, no typing,
 * no form submission, no script.
 */
import {
  agentUrlVerdict,
  type VerseBrowserAgentCommand,
  type VerseBrowserCommandResult,
  type VerseBrowserConsoleEntry,
  type VerseBrowserNetworkEntry,
} from '../../../../core/verse/browser-types.js';
import type { BrowserScreenshot } from './send-to-chat.js';

export interface BrowserExecutorCapabilities {
  screenshot: boolean;
  text: boolean;
  console: boolean;
}

/** What the pane exposes to the runner (BrowserPanel builds one per render). */
export interface BrowserExecutor {
  mode: 'native' | 'frame';
  capabilities: BrowserExecutorCapabilities;
  /** The active tab's page, or nulls when no page is open. */
  current(): { url: string | null; title: string | null; tabs: number };
  navigate(url: string): Promise<{ url: string; title: string | null; loading: boolean }>;
  screenshot(): Promise<BrowserScreenshot>;
  text(limit: number): Promise<{ url: string; title: string | null; text: string; truncated: boolean }>;
  console(): Promise<{ url: string; console: VerseBrowserConsoleEntry[]; network: VerseBrowserNetworkEntry[] }>;
}

const FRAME_LIMIT =
  'This Browser pane is running in the web UI (an embedded frame), which cannot see into the page. Screenshots, page text and console need the Ashlr desktop app. You can still open localhost pages with browser_navigate.';

/** Verse's own port, from its page address ("" → the scheme default). */
export function versePortOf(origin: string): number | null {
  try {
    const url = new URL(origin);
    const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
    return Number.isInteger(port) && port > 0 ? port : null;
  } catch {
    return null;
  }
}

function fail(id: string, error: string, url?: string | null): VerseBrowserCommandResult {
  return { id, ok: false, error, ...(url ? { url } : {}) };
}

function message(err: unknown): string {
  return err instanceof Error && err.message ? err.message : 'The browser could not do that.';
}

export async function executeAgentCommand(
  command: VerseBrowserAgentCommand,
  exec: BrowserExecutor,
  verseOrigin: string,
): Promise<VerseBrowserCommandResult> {
  const gate = { versePort: versePortOf(verseOrigin), allowedOrigins: command.allowedOrigins };
  const here = exec.current();
  const observable = here.url !== null && agentUrlVerdict(here.url, gate).ok;

  try {
    switch (command.op) {
      case 'status':
        return {
          id: command.id,
          ok: true,
          // A page the agent may not observe is not even named.
          ...(observable && here.url ? { url: here.url } : {}),
          data: {
            title: observable ? here.title : null,
            hidden: here.url !== null && !observable,
            native: exec.mode === 'native',
            capabilities: exec.capabilities,
            tabs: here.tabs,
          },
        };

      case 'navigate': {
        const verdict = agentUrlVerdict(command.url ?? '', gate);
        if (!verdict.ok) return fail(command.id, verdict.message);
        const landed = await exec.navigate(verdict.url);
        return { id: command.id, ok: true, url: landed.url, data: { title: landed.title, loading: landed.loading } };
      }

      case 'screenshot':
      case 'read-text':
      case 'console': {
        if (exec.mode === 'frame') return fail(command.id, FRAME_LIMIT);
        if (!here.url) return fail(command.id, 'No page is open in the Browser pane. Open one with browser_navigate first.');
        if (!observable) {
          return fail(command.id, 'The active tab shows a page this chat may not observe, so nothing was captured. Navigate to a localhost page, or ask the operator to allow that origin for this chat.');
        }
        if (command.op === 'screenshot') {
          if (!exec.capabilities.screenshot) return fail(command.id, 'This desktop shell cannot take screenshots on this platform (macOS only for now).');
          const shot = await exec.screenshot();
          return { id: command.id, ok: true, url: here.url, data: shot };
        }
        if (command.op === 'read-text') {
          const limit = Math.max(500, Math.min(50_000, command.limit ?? 20_000));
          const read = await exec.text(limit);
          if (!agentUrlVerdict(read.url, gate).ok) return fail(command.id, 'The page changed to one this chat may not observe while it was being read.');
          return { id: command.id, ok: true, url: read.url, data: { title: read.title, text: read.text, truncated: read.truncated } };
        }
        const logs = await exec.console();
        if (!agentUrlVerdict(logs.url, gate).ok) return fail(command.id, 'The page changed to one this chat may not observe while it was being read.');
        const limit = Math.max(1, Math.min(200, command.limit ?? 50));
        return { id: command.id, ok: true, url: logs.url, data: { console: logs.console.slice(-limit), network: logs.network.slice(-limit) } };
      }

      default:
        return fail(command.id, 'Unknown browser command.');
    }
  } catch (err) {
    return fail(command.id, message(err));
  }
}
