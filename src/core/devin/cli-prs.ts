/**
 * Pull requests a Devin CLI chat opened (3.15 follow-up).
 *
 * A Devin (cloud) chat's PR reaches Needs-you through its DevinTask record
 * (the tracker finds it on the task's branch). A Devin (CLI) turn has no task
 * — the local agent runs `gh pr create` itself — so the only trace is the PR
 * URL in what the turn printed. The ACP bridge (acp-bridge.ts) spots GitHub
 * PR URLs in the agent's messages and tool output, shows each as the chat's
 * PR card (the `remote-pr` line), and records it here; devin-api.ts turns the
 * records into the SAME Needs-you item a cloud chat's PR is (`owner-lane-pr`,
 * naming the chat), with Dismiss as its only action — Verse never verified,
 * previewed or tracked a CLI PR, so it offers no Land / Close.
 *
 *   cli-prs/<verse chat id>.json   { v: 1, sessionId, prs: [{ url, repo, number, seenAt }] }
 *                                  written only by that chat's turn process
 *                                  (one turn per chat at a time — no racing writer)
 *   cli-prs-dismissed.json         { v: 1, keys: ["<chat id> <url>", …] }
 *                                  written only by the server (the Dismiss route)
 *
 * Both are private files (0600 in a 0700 dir, atomic writes, capped reads).
 * An item stops showing after DEVIN_CLI_PR_WINDOW_MS: nothing follows a CLI
 * PR to its merge, so it must not sit in Needs-you forever.
 */
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

import { readPrivateFileCapped, writePrivateFileAtomic } from '../verse/preferences.js';
import { devinHome, ensureDevinDirectory } from './store.js';

export const DEVIN_CLI_PRS_DIR = 'cli-prs';
export const DEVIN_CLI_PRS_DISMISSED_FILE = 'cli-prs-dismissed.json';
/** How long a CLI chat's PR stays in Needs-you (nothing tracks it to its merge). */
export const DEVIN_CLI_PR_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

const MAX_PRS_PER_CHAT = 20;
const MAX_DISMISSED = 500;
const MAX_FILE_BYTES = 64 * 1024;
const CHAT_ID = /^[A-Za-z0-9-]{1,80}$/;
const PR_URL = /https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/(\d{1,9})(?!\d)/g;
const PR_URL_EXACT = /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/\d{1,9}$/;

export interface DevinCliPr {
  url: string;
  /** owner/name */
  repo: string;
  number: number;
  seenAt: string;
}

export interface DevinCliChatPrs {
  sessionId: string;
  prs: DevinCliPr[];
}

/** GitHub PR URLs in `text`, in order, without repeats (PURE). */
export function findGithubPrUrls(text: string): Array<Pick<DevinCliPr, 'url' | 'repo' | 'number'>> {
  const out: Array<Pick<DevinCliPr, 'url' | 'repo' | 'number'>> = [];
  const seen = new Set<string>();
  for (const m of (text ?? '').matchAll(PR_URL)) {
    const number = Number(m[3]);
    if (!Number.isSafeInteger(number) || number < 1) continue;
    const repo = `${m[1]}/${m[2]}`;
    const url = `https://github.com/${repo}/pull/${number}`;
    if (seen.has(url.toLowerCase())) continue;
    seen.add(url.toLowerCase());
    out.push({ url, repo, number });
  }
  return out;
}

function chatFile(sessionId: string): string {
  return join(devinHome(), DEVIN_CLI_PRS_DIR, `${sessionId}.json`);
}

function readJson(path: string): unknown {
  const file = readPrivateFileCapped(path, MAX_FILE_BYTES);
  if (!file || file.truncated) return undefined;
  try {
    return JSON.parse(file.text) as unknown;
  } catch {
    return undefined;
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

function isPr(value: unknown): value is DevinCliPr {
  return isRecord(value)
    && typeof value['url'] === 'string' && PR_URL_EXACT.test(value['url'])
    && typeof value['repo'] === 'string' && value['url'].startsWith(`https://github.com/${value['repo']}/pull/`)
    && Number.isSafeInteger(value['number']) && value['url'].endsWith(`/pull/${value['number'] as number}`)
    && typeof value['seenAt'] === 'string' && Number.isFinite(Date.parse(value['seenAt']));
}

export function readDevinCliChatPrs(sessionId: string): DevinCliChatPrs | null {
  if (!CHAT_ID.test(sessionId)) return null;
  const value = readJson(chatFile(sessionId));
  if (!isRecord(value) || value['v'] !== 1 || value['sessionId'] !== sessionId || !Array.isArray(value['prs'])) return null;
  return { sessionId, prs: value['prs'].filter(isPr).slice(0, MAX_PRS_PER_CHAT) };
}

/**
 * Record the PRs a CLI turn printed (new ones only). Returns the ones that
 * were new. Never throws: a PR card that cannot be recorded is still a card.
 */
export function recordDevinCliPrs(sessionId: string, found: ReadonlyArray<Pick<DevinCliPr, 'url' | 'repo' | 'number'>>, now: Date = new Date()): DevinCliPr[] {
  if (!CHAT_ID.test(sessionId) || found.length === 0) return [];
  try {
    const current = readDevinCliChatPrs(sessionId)?.prs ?? [];
    const known = new Set(current.map((p) => p.url.toLowerCase()));
    const added = found
      .filter((p) => PR_URL_EXACT.test(p.url) && !known.has(p.url.toLowerCase()))
      .map((p) => ({ url: p.url, repo: p.repo, number: p.number, seenAt: now.toISOString() }));
    if (added.length === 0) return [];
    ensureDevinDirectory(DEVIN_CLI_PRS_DIR);
    const prs = [...added, ...current].slice(0, MAX_PRS_PER_CHAT);
    writePrivateFileAtomic(chatFile(sessionId), `${JSON.stringify({ v: 1, sessionId, prs }, null, 2)}\n`);
    return added;
  } catch {
    return [];
  }
}

/** Every CLI chat's PRs (bounded by the chats on disk). Reader-total. */
export function listDevinCliPrs(): DevinCliChatPrs[] {
  let names: string[];
  try {
    names = readdirSync(join(devinHome(), DEVIN_CLI_PRS_DIR));
  } catch {
    return [];
  }
  const out: DevinCliChatPrs[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const chat = readDevinCliChatPrs(name.slice(0, -'.json'.length));
    if (chat && chat.prs.length > 0) out.push(chat);
  }
  return out;
}

export const devinCliPrKey = (sessionId: string, url: string): string => `${sessionId} ${url.toLowerCase()}`;

export function readDismissedDevinCliPrs(): Set<string> {
  const value = readJson(join(devinHome(), DEVIN_CLI_PRS_DISMISSED_FILE));
  if (!isRecord(value) || value['v'] !== 1 || !Array.isArray(value['keys'])) return new Set();
  return new Set(value['keys'].filter((k): k is string => typeof k === 'string' && k.length <= 2200));
}

/** Dismiss one CLI chat PR (local record only; the PR on GitHub is not touched). */
export function dismissDevinCliPr(sessionId: string, number: number): { ok: true } | { ok: false; status: 404; error: string } {
  const chat = readDevinCliChatPrs(sessionId);
  const pr = chat?.prs.find((p) => p.number === number);
  if (!chat || !pr) return { ok: false, status: 404, error: 'No pull request from that Devin CLI chat.' };
  const keys = [...readDismissedDevinCliPrs()];
  const key = devinCliPrKey(sessionId, pr.url);
  if (!keys.includes(key)) keys.push(key);
  writePrivateFileAtomic(join(ensureDevinDirectory(), DEVIN_CLI_PRS_DISMISSED_FILE), `${JSON.stringify({ v: 1, keys: keys.slice(-MAX_DISMISSED) }, null, 2)}\n`);
  return { ok: true };
}
