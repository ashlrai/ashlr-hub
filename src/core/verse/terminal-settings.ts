/**
 * core/verse/terminal-settings.ts — the terminal's own server-side settings
 * (3.15): whether finished commands are recorded to disk (terminal-history.ts)
 * and whether plain-language requests may reach a model (terminal-assist.ts).
 *
 *   ~/.ashlr/verse/terminal-settings.json   (0600, written atomically)
 *
 * Kept apart from preferences.ts on purpose: these two switches are read on
 * the terminal's own paths (every finished command, every assist request) and
 * nothing else in Verse needs them. Async fs only (lint:verse-sync-io). A
 * missing or unreadable file is the defaults; a hand-edited one is read
 * leniently, field by field.
 */
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { VerseTerminalAssistMode, VerseTerminalSettings } from './workbench-types.js';

export const TERMINAL_SETTINGS_FILE = 'terminal-settings.json';
export const TERMINAL_SETTINGS_DEFAULTS: Readonly<VerseTerminalSettings> = Object.freeze({ history: true, assist: 'auto' });
const ASSIST_MODES: readonly VerseTerminalAssistMode[] = ['auto', 'local', 'off'];

/** ~/.ashlr/verse, resolved at call time so a relocated HOME (tests) is honoured. */
export function terminalVerseDir(): string {
  return join(homedir(), '.ashlr', 'verse');
}

/** Lenient: every field that is present and valid wins over the default. */
export function parseTerminalSettings(value: unknown): VerseTerminalSettings {
  const out: VerseTerminalSettings = { ...TERMINAL_SETTINGS_DEFAULTS };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return out;
  const raw = value as Record<string, unknown>;
  if (typeof raw['history'] === 'boolean') out.history = raw['history'];
  if (typeof raw['assist'] === 'string' && ASSIST_MODES.includes(raw['assist'] as VerseTerminalAssistMode)) {
    out.assist = raw['assist'] as VerseTerminalAssistMode;
  }
  return out;
}

/** A settings update from a request body: only the known keys, each validated; null = invalid. */
export function parseTerminalSettingsUpdate(value: unknown): Partial<VerseTerminalSettings> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const out: Partial<VerseTerminalSettings> = {};
  for (const key of Object.keys(raw)) {
    if (key === 'history') {
      if (typeof raw[key] !== 'boolean') return null;
      out.history = raw[key] as boolean;
    } else if (key === 'assist') {
      if (!ASSIST_MODES.includes(raw[key] as VerseTerminalAssistMode)) return null;
      out.assist = raw[key] as VerseTerminalAssistMode;
    } else {
      return null;
    }
  }
  return Object.keys(out).length > 0 ? out : null;
}

/** Last value read or written, per directory: a finished command must not read the file every time. */
const cache = new Map<string, VerseTerminalSettings>();

export async function loadTerminalSettings(dir: string = terminalVerseDir()): Promise<VerseTerminalSettings> {
  const hit = cache.get(dir);
  if (hit) return { ...hit };
  let parsed: VerseTerminalSettings;
  try {
    parsed = parseTerminalSettings(JSON.parse(await readFile(join(dir, TERMINAL_SETTINGS_FILE), 'utf8')));
  } catch {
    parsed = { ...TERMINAL_SETTINGS_DEFAULTS };
  }
  cache.set(dir, parsed);
  return { ...parsed };
}

export async function updateTerminalSettings(
  patch: Partial<VerseTerminalSettings>,
  dir: string = terminalVerseDir(),
): Promise<VerseTerminalSettings> {
  const next = parseTerminalSettings({ ...(await loadTerminalSettings(dir)), ...patch });
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, TERMINAL_SETTINGS_FILE);
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  await rename(tmp, file);
  // rename keeps the tmp file's mode; this covers a file an older build left wider.
  await chmod(file, 0o600).catch(() => {});
  cache.set(dir, next);
  return { ...next };
}

/** Test hook: forget what was read. */
export function resetTerminalSettingsCacheForTest(): void {
  cache.clear();
}
