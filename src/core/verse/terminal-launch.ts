/**
 * core/verse/terminal-launch.ts — launch configurations (3.15):
 * `.ashlr/verse/launch.json` in a chat's root names terminal LAYOUTS — tabs,
 * splits, starting directories and the command each pane starts with (a dev
 * server + a test watcher + Claude Code, say).
 *
 *   { "version": 1,
 *     "configurations": [
 *       { "name": "Dev",
 *         "tabs": [
 *           { "split": "right", "panes": [ { "cwd": "web", "command": "npm run dev" },
 *                                          { "command": "npm test -- --watch" } ] },
 *           { "panes": [ { "agent": "claude-code" } ] } ] } ] }
 *
 * A REPO FILE IS NOT AN INSTRUCTION. Reading a launch.json runs nothing: the
 * configurations are listed, each with the exact commands it would type, and
 * a configuration's commands are typed only when the operator launches that
 * one by name. The launch route re-reads the file and takes the commands from
 * it — never from the request — so the page cannot smuggle a command in.
 *
 * Validation is strict and total: an unknown key, a multi-line command, a cwd
 * that climbs out of the root or an agent the catalog does not know makes the
 * whole file unusable (one error line, shown to the operator) rather than
 * half-applied. Paths are re-checked against the root's PHYSICAL path at launch.
 */
import { readFile, stat } from 'node:fs/promises';
import { isAbsolute, join, normalize, sep } from 'node:path';

import { appCatalogEntry } from './apps-catalog.js';
import { withFolderIo } from './folder-io.js';
import {
  VERSE_TERMINAL_LAUNCH_FILE,
  VERSE_TERMINAL_LAUNCH_MAX_CONFIGS,
  VERSE_TERMINAL_LAUNCH_MAX_TABS,
  type VerseTerminalLaunchConfig,
  type VerseTerminalLaunchListResponse,
  type VerseTerminalLaunchPane,
  type VerseTerminalLaunchTab,
} from './workbench-types.js';

export const LAUNCH_FILE_MAX_BYTES = 64 * 1024;
export const LAUNCH_NAME_MAX_CHARS = 60;
export const LAUNCH_COMMAND_MAX_CHARS = 1_000;
/** A tab holds two terminals at most (the panel's MAX_PANES_PER_GROUP). */
export const LAUNCH_MAX_PANES_PER_TAB = 2;

class LaunchFileError extends Error {}

function fail(message: string): never {
  throw new LaunchFileError(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function onlyKeys(value: Record<string, unknown>, allowed: readonly string[], where: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) fail(`${where}: unknown key "${key.slice(0, 40)}"`);
  }
}

// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/;

function paneOf(raw: unknown, where: string): VerseTerminalLaunchPane {
  if (!isRecord(raw)) fail(`${where} must be an object`);
  onlyKeys(raw, ['cwd', 'command', 'agent'], where);
  let cwd: string | null = null;
  if (raw['cwd'] !== undefined && raw['cwd'] !== null) {
    const value = raw['cwd'];
    if (typeof value !== 'string' || value.length === 0 || value.length > 512 || CONTROL_RE.test(value)) fail(`${where}.cwd must be a folder inside the project`);
    if (isAbsolute(value) || value.startsWith('~')) fail(`${where}.cwd must be relative to the project`);
    const norm = normalize(value);
    if (norm === '..' || norm.startsWith(`..${sep}`) || norm.split(sep).includes('..')) fail(`${where}.cwd must stay inside the project`);
    cwd = norm === '.' ? null : norm;
  }
  let command: string | null = null;
  if (raw['command'] !== undefined && raw['command'] !== null) {
    const value = raw['command'];
    if (typeof value !== 'string' || value.trim().length === 0) fail(`${where}.command must be a non-empty string`);
    if (value.length > LAUNCH_COMMAND_MAX_CHARS) fail(`${where}.command is longer than ${LAUNCH_COMMAND_MAX_CHARS} characters`);
    // One line: a newline would run a second command the list never showed as one.
    if (CONTROL_RE.test(value)) fail(`${where}.command must be one line without control characters`);
    command = value.trim();
  }
  let agent: string | null = null;
  if (raw['agent'] !== undefined && raw['agent'] !== null) {
    const value = raw['agent'];
    const entry = typeof value === 'string' ? appCatalogEntry(value) : null;
    if (!entry || entry.group !== 'terminal-agents' || !entry.launch) fail(`${where}.agent must be a terminal agent from Apps (claude-code, codex, devin, grok…)`);
    agent = entry.id;
  }
  if (command && agent) fail(`${where}: a pane runs a command or an agent, not both`);
  return { cwd, command, agent };
}

function tabOf(raw: unknown, where: string): VerseTerminalLaunchTab {
  if (!isRecord(raw)) fail(`${where} must be an object`);
  onlyKeys(raw, ['split', 'panes'], where);
  const split = raw['split'] ?? 'right';
  if (split !== 'right' && split !== 'down') fail(`${where}.split must be "right" or "down"`);
  const panes = raw['panes'];
  if (!Array.isArray(panes) || panes.length === 0 || panes.length > LAUNCH_MAX_PANES_PER_TAB) fail(`${where}.panes must list one or two panes`);
  return { split, panes: panes.map((p, i) => paneOf(p, `${where}.panes[${i}]`)) };
}

/** A launch.json's text → its configurations for `root`. Throws LaunchFileError with one operator-readable line. */
export function parseLaunchFile(text: string, root: string): VerseTerminalLaunchConfig[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    fail('launch.json is not valid JSON');
  }
  if (!isRecord(parsed)) fail('launch.json must be an object');
  onlyKeys(parsed, ['version', 'configurations'], 'launch.json');
  if (parsed['version'] !== 1) fail('launch.json needs "version": 1');
  const configs = parsed['configurations'];
  if (!Array.isArray(configs)) fail('launch.json needs a "configurations" list');
  if (configs.length > VERSE_TERMINAL_LAUNCH_MAX_CONFIGS) fail(`launch.json lists more than ${VERSE_TERMINAL_LAUNCH_MAX_CONFIGS} configurations`);
  const names = new Set<string>();
  return configs.map((raw, i) => {
    const where = `configurations[${i}]`;
    if (!isRecord(raw)) fail(`${where} must be an object`);
    onlyKeys(raw, ['name', 'tabs'], where);
    const name = raw['name'];
    if (typeof name !== 'string' || name.trim().length === 0 || name.length > LAUNCH_NAME_MAX_CHARS || CONTROL_RE.test(name)) {
      fail(`${where}.name must be a short name`);
    }
    if (names.has(name.trim())) fail(`two configurations are named "${name.trim()}"`);
    names.add(name.trim());
    const tabs = raw['tabs'];
    if (!Array.isArray(tabs) || tabs.length === 0 || tabs.length > VERSE_TERMINAL_LAUNCH_MAX_TABS) {
      fail(`${where}.tabs must list 1–${VERSE_TERMINAL_LAUNCH_MAX_TABS} tabs`);
    }
    return { name: name.trim(), root, tabs: tabs.map((t, j) => tabOf(t, `${where}.tabs[${j}]`)) };
  });
}

/**
 * Every launch configuration in `roots` (in root order). A root without the
 * file contributes nothing; a file that cannot be used contributes an error
 * line. Async and folder-guarded: roots are operator folders (folder-io.ts).
 */
export async function readLaunchConfigs(roots: readonly string[]): Promise<VerseTerminalLaunchListResponse> {
  const out: VerseTerminalLaunchListResponse = { configs: [], errors: [] };
  for (const root of roots) {
    const path = join(root, VERSE_TERMINAL_LAUNCH_FILE);
    let text: string;
    try {
      const info = await withFolderIo(() => stat(path));
      if (!info.isFile()) continue;
      if (info.size > LAUNCH_FILE_MAX_BYTES) {
        out.errors.push({ root, error: 'launch.json is larger than 64 KB' });
        continue;
      }
      text = await withFolderIo(() => readFile(path, 'utf8'));
    } catch (err) {
      const code = (err as NodeJS.ErrnoException | undefined)?.code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') out.errors.push({ root, error: 'launch.json could not be read' });
      continue;
    }
    try {
      out.configs.push(...parseLaunchFile(text, root));
    } catch (err) {
      if (err instanceof LaunchFileError) out.errors.push({ root, error: err.message });
      else throw err;
    }
  }
  return out;
}
