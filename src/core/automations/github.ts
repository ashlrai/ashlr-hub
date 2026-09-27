/**
 * GitHub polling for automation triggers — READ-ONLY `gh api` GETs, bounded:
 * one page per repo per poll, an ETag (If-None-Match) per endpoint, and a
 * `since` cursor for issues so each poll reads only what changed. Nothing in
 * this file writes to GitHub.
 *
 * The runner is injected (tests pass a fake; production uses the cloud lane's
 * argv-only, time-limited `gh` runner). Issue and check-run text is UNTRUSTED:
 * it is scrubbed, stripped of control characters and capped here, and it
 * reaches a lane only as DATA inside the task prompt.
 */
import { scrubSecrets } from '../util/scrub.js';
import { cleanText } from './validate.js';
import { AUTOMATION_LIMITS, type CiRedTrigger, type GithubIssuesTrigger } from './types.js';

export type AutomationGh = (args: string[]) => Promise<{ ok: boolean; stdout: string; stderr: string }>;

/** A trigger event before dedupe/queueing. */
export interface TriggerEvent {
  repo: string;
  /** Values for the dedupe template ({number} {sha} {occurrence} {key}). */
  vars: { number?: string; sha?: string; occurrence?: string; key?: string };
  title: string;
  text: string;
  url: string | null;
  ref: string;
}

export interface GhHttpResult {
  status: number;
  etag: string | null;
  body: unknown;
}

const GITHUB_HTML_URL = /^https:\/\/github\.com\/[^\s]{1,400}$/;
const FAILING_CONCLUSIONS = new Set(['failure', 'timed_out', 'startup_failure']);
/**
 * Who may hand work in through a query-only trigger. A label is applied by
 * someone with triage rights, so a labelled issue is endorsed whoever wrote
 * it; a bare search query is not — anyone can open an issue — so without a
 * label only the repo's own people count.
 */
const TRUSTED_AUTHORS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);

export function safeGithubUrl(value: unknown): string | null {
  return typeof value === 'string' && GITHUB_HTML_URL.test(value) ? value : null;
}

/** Untrusted text → scrubbed, control-free, capped. */
export function untrustedText(value: unknown, max: number = AUTOMATION_LIMITS.eventTextMaxChars): string {
  return typeof value === 'string' ? cleanText(scrubSecrets(value), max, false) : '';
}

export function untrustedTitle(value: unknown): string {
  return typeof value === 'string' ? cleanText(scrubSecrets(value), AUTOMATION_LIMITS.eventTitleMaxChars, true) : '';
}

/**
 * Split `gh api -i` output: status line + headers, blank line, body. Returns
 * null when the output has no HTTP status line.
 */
export function parseGhInclude(stdout: string): GhHttpResult | null {
  const normalised = stdout.replace(/\r\n/g, '\n');
  const status = /^HTTP\/[\d.]+\s+(\d{3})/.exec(normalised);
  if (!status) return null;
  const split = normalised.indexOf('\n\n');
  const head = split === -1 ? normalised : normalised.slice(0, split);
  const rawBody = split === -1 ? '' : normalised.slice(split + 2).trim();
  const etag = /^etag:\s*(.+)$/im.exec(head)?.[1]?.trim() ?? null;
  let body: unknown = null;
  if (rawBody !== '') {
    try { body = JSON.parse(rawBody); } catch { body = null; }
  }
  return { status: Number(status[1]), etag, body };
}

/** GET via `gh api -i`, with If-None-Match when an ETag is known. */
export async function ghGet(gh: AutomationGh, path: string, params: Record<string, string>, etag: string | null): Promise<GhHttpResult | { error: string }> {
  const args = ['api', '-i', '-X', 'GET', path];
  for (const [key, value] of Object.entries(params)) args.push('-f', `${key}=${value}`);
  if (etag) args.push('-H', `If-None-Match: ${etag}`);
  let res: { ok: boolean; stdout: string; stderr: string };
  try {
    res = await gh(args);
  } catch {
    return { error: 'gh could not be run (is the GitHub CLI installed and signed in?).' };
  }
  const parsed = parseGhInclude(res.stdout);
  if (parsed && (parsed.status === 304 || (parsed.status >= 200 && parsed.status < 300))) return parsed;
  if (/\b304\b/.test(res.stderr) && etag) return { status: 304, etag, body: null };
  const status = parsed?.status ?? (/HTTP (\d{3})/.exec(res.stderr)?.[1] ? Number(/HTTP (\d{3})/.exec(res.stderr)![1]) : null);
  if (status === 404) return { error: `GitHub answered 404 for ${path.split('/').slice(0, 3).join('/')} (repo missing or not visible to gh).` };
  if (status === 403 || status === 429) return { error: 'GitHub rate-limited or refused the poll; it will retry on the next interval.' };
  return { error: `GitHub poll failed${status ? ` (HTTP ${status})` : ''}; it will retry on the next interval.` };
}

// ---------------------------------------------------------------------------
// Issues / PRs with labels (or a search query)
// ---------------------------------------------------------------------------

export interface IssuePollResult {
  events: TriggerEvent[];
  /** New `since` cursor for this repo (newest updated_at seen), or unchanged. */
  since: string | null;
  etag: string | null;
  error: string | null;
}

interface RawIssue {
  number?: unknown;
  title?: unknown;
  body?: unknown;
  html_url?: unknown;
  updated_at?: unknown;
  state?: unknown;
  pull_request?: unknown;
  labels?: unknown;
  author_association?: unknown;
}

function quoteLabel(label: string): string {
  return /[\s:]/.test(label) ? `"${label.replace(/"/g, '')}"` : label;
}

/** The search query for query-mode triggers (repo is always pinned to ONE enrolled repo). */
export function buildIssueSearchQuery(trigger: GithubIssuesTrigger, repo: string, since: string | null): string {
  const parts = [`repo:${repo}`, 'is:open'];
  if (!trigger.includePrs) parts.push('is:issue');
  for (const label of trigger.labels) parts.push(`label:${quoteLabel(label)}`);
  if (trigger.query) parts.push(trigger.query);
  // GitHub search wants `YYYY-MM-DDTHH:MM:SSZ` (no milliseconds).
  if (since) parts.push(`updated:>=${new Date(since).toISOString().slice(0, 19)}Z`);
  return parts.join(' ');
}

export async function pollIssues(
  gh: AutomationGh,
  trigger: GithubIssuesTrigger,
  repo: string,
  cursor: { since: string | null; etag: string | null },
): Promise<IssuePollResult> {
  const searchMode = trigger.query !== null;
  const result = searchMode
    ? await ghGet(gh, 'search/issues', {
      q: buildIssueSearchQuery(trigger, repo, cursor.since),
      sort: 'updated',
      order: 'asc',
      per_page: String(AUTOMATION_LIMITS.issuesPerPoll),
    }, cursor.etag)
    : await ghGet(gh, `repos/${repo}/issues`, {
      state: 'open',
      labels: trigger.labels.join(','),
      sort: 'updated',
      direction: 'asc',
      per_page: String(AUTOMATION_LIMITS.issuesPerPoll),
      ...(cursor.since ? { since: cursor.since } : {}),
    }, cursor.etag);
  if ('error' in result) return { events: [], since: cursor.since, etag: cursor.etag, error: result.error };
  if (result.status === 304) return { events: [], since: cursor.since, etag: cursor.etag, error: null };
  const list: unknown = searchMode ? (result.body as { items?: unknown } | null)?.items : result.body;
  if (!Array.isArray(list)) return { events: [], since: cursor.since, etag: cursor.etag, error: 'GitHub answered with an unexpected shape.' };

  let since = cursor.since;
  const events: TriggerEvent[] = [];
  for (const raw of list.slice(0, AUTOMATION_LIMITS.issuesPerPoll) as RawIssue[]) {
    if (!raw || typeof raw !== 'object') continue;
    const updated = typeof raw.updated_at === 'string' && !Number.isNaN(Date.parse(raw.updated_at)) ? raw.updated_at : null;
    if (updated && (since === null || updated > since)) since = updated;
    if (typeof raw.number !== 'number' || !Number.isInteger(raw.number) || raw.number <= 0) continue;
    if (raw.state !== undefined && raw.state !== 'open') continue;
    const isPr = raw.pull_request !== undefined && raw.pull_request !== null;
    if (isPr && !trigger.includePrs) continue;
    if (trigger.labels.length === 0 && !(typeof raw.author_association === 'string' && TRUSTED_AUTHORS.has(raw.author_association))) continue;
    const title = untrustedTitle(raw.title);
    events.push({
      repo,
      vars: { number: String(raw.number) },
      title: `${isPr ? 'PR' : 'Issue'} #${raw.number}: ${title || '(untitled)'}`.slice(0, AUTOMATION_LIMITS.eventTitleMaxChars),
      text: untrustedText(raw.body),
      url: safeGithubUrl(raw.html_url),
      ref: `#${raw.number}`,
    });
  }
  return { events, since, etag: result.etag ?? cursor.etag, error: null };
}

// ---------------------------------------------------------------------------
// Red default branch (check runs on its head commit)
// ---------------------------------------------------------------------------

export interface CiPollResult {
  events: TriggerEvent[];
  branch: string | null;
  etag: string | null;
  error: string | null;
}

interface RawCheckRun {
  name?: unknown;
  status?: unknown;
  conclusion?: unknown;
  head_sha?: unknown;
  html_url?: unknown;
}

export async function resolveDefaultBranch(gh: AutomationGh, repo: string): Promise<string | { error: string }> {
  const res = await ghGet(gh, `repos/${repo}`, {}, null);
  if ('error' in res) return res;
  const name = (res.body as { default_branch?: unknown } | null)?.default_branch;
  if (typeof name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(name)) return { error: `GitHub did not say what ${repo}'s default branch is.` };
  return name;
}

export async function pollRedBranch(
  gh: AutomationGh,
  trigger: CiRedTrigger,
  repo: string,
  cursor: { branch: string | null; etag: string | null },
): Promise<CiPollResult> {
  let branch = trigger.branch ?? cursor.branch;
  if (!branch) {
    const resolved = await resolveDefaultBranch(gh, repo);
    if (typeof resolved !== 'string') return { events: [], branch: null, etag: cursor.etag, error: resolved.error };
    branch = resolved;
  }
  const res = await ghGet(gh, `repos/${repo}/commits/${encodeURIComponent(branch)}/check-runs`, { per_page: '100', filter: 'latest' }, cursor.etag);
  if ('error' in res) return { events: [], branch, etag: cursor.etag, error: res.error };
  if (res.status === 304) return { events: [], branch, etag: cursor.etag, error: null };
  const runs = (res.body as { check_runs?: unknown } | null)?.check_runs;
  if (!Array.isArray(runs)) return { events: [], branch, etag: cursor.etag, error: 'GitHub answered with an unexpected shape.' };

  const failing: Array<{ name: string; url: string | null; sha: string }> = [];
  for (const raw of runs as RawCheckRun[]) {
    if (!raw || typeof raw !== 'object') continue;
    if (raw.status !== 'completed' || typeof raw.conclusion !== 'string' || !FAILING_CONCLUSIONS.has(raw.conclusion)) continue;
    if (typeof raw.head_sha !== 'string' || !/^[0-9a-f]{40}$/.test(raw.head_sha)) continue;
    failing.push({ name: untrustedTitle(raw.name) || 'a check', url: safeGithubUrl(raw.html_url), sha: raw.head_sha });
  }
  if (failing.length === 0) return { events: [], branch, etag: res.etag ?? cursor.etag, error: null };
  const sha = failing[0]!.sha;
  const names = [...new Set(failing.filter((f) => f.sha === sha).map((f) => f.name))];
  const shown = names.slice(0, 3).join(', ') + (names.length > 3 ? ` +${names.length - 3} more` : '');
  const lines = failing
    .filter((f) => f.sha === sha)
    .slice(0, 20)
    .map((f) => `- ${f.name}${f.url ? ` — ${f.url}` : ''}`);
  return {
    events: [{
      repo,
      vars: { sha },
      title: `Fix red ${branch}: ${shown} failing at ${sha.slice(0, 7)}`.slice(0, AUTOMATION_LIMITS.eventTitleMaxChars),
      text: `The head of ${branch} (${sha}) has failing checks:\n${lines.join('\n')}`,
      url: failing.find((f) => f.sha === sha && f.url)?.url ?? null,
      ref: sha.slice(0, 12),
    }],
    branch,
    etag: res.etag ?? cursor.etag,
    error: null,
  };
}
