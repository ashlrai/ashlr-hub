/**
 * The delivery contract appended to every cloud task prompt (unit C1), and
 * the parser for what the session reports back in its PR body.
 *
 * WHY a contract at all: Verse cannot read a cloud session back (attach is
 * not enabled for the account), so GitHub is the only channel. A session that
 * delivers anywhere but `ashlr-cloud/<taskId>` is invisible to the tracker,
 * and one that merges bypasses custody — so both are spelled out, every time.
 */
import { CLOUD_PR_TITLE_PREFIX, CLOUD_REPORT_FENCE, type CloudTaskReport, type CloudTaskV1 } from './types.js';

/** A report block is a few hundred bytes; past this it is not a report, it is a dump. */
export const CLOUD_REPORT_MAX_BLOCK_CHARS = 32 * 1024;
/** Markdown needs only a few ticks; cap dynamic close-pattern construction. */
const MAX_REPORT_FENCE_CHARS = 128;
/** PR bodies can be edited by anyone with write access; only this much of the tail is scanned. */
const MAX_BODY_CHARS = 512 * 1024;
const MAX_SUMMARY_CHARS = 2_000;
const MAX_LIST_ITEMS = 50;
const MAX_LIST_ITEM_CHARS = 500;

const STATUSES: readonly CloudTaskReport['status'][] = ['done', 'partial', 'blocked', 'no-change'];

/**
 * The full prompt handed to `claude --cloud`: the task text, then the
 * contract — create and work on branch `task.branch` from `task.baseBranch`;
 * never push to any other branch; never merge; run the repo's relevant tests;
 * commit; push; open a DRAFT PR against `task.baseBranch` titled
 * `${CLOUD_PR_TITLE_PREFIX} <title>`; the PR body ends with a fenced
 * `${CLOUD_REPORT_FENCE}` JSON block matching CloudTaskReport. If nothing
 * needs changing, still push an empty commit on the branch and open the PR
 * with status "no-change" so Verse sees completion.
 */
export function buildCloudPrompt(task: CloudTaskV1): string {
  const example = JSON.stringify({
    status: 'done',
    summary: 'One or two plain sentences on what changed and why.',
    testsRun: ['npx vitest run test/example.test.ts (12 passed)'],
    risks: ['Anything a reviewer should look at closely.'],
    filesChanged: 3,
  }, null, 2);
  return [
    task.prompt.trim(),
    '',
    '---',
    `DELIVERY CONTRACT (Ashlr Verse cloud task ${task.id}) — follow it exactly; Verse only sees what arrives on GitHub.`,
    '',
    `1. Create branch \`${task.branch}\` from \`${task.baseBranch}\` and do all work on it.`,
    `2. Never push to any other branch. Never push to \`${task.baseBranch}\`, master or main. Never merge anything, and never enable auto-merge.`,
    '3. Run the repository\'s relevant checks and tests for what you changed, and fix what you broke.',
    `4. Commit your work, then push \`${task.branch}\` to origin.`,
    `5. Open a DRAFT pull request from \`${task.branch}\` against \`${task.baseBranch}\` titled \`${CLOUD_PR_TITLE_PREFIX} ${task.title}\`.`,
    `6. The pull request body must END with a fenced code block whose language tag is \`${CLOUD_REPORT_FENCE}\`, containing one JSON object:`,
    '   - "status": "done" | "partial" | "blocked" | "no-change"',
    '   - "summary": a short plain-language summary',
    '   - "testsRun": the exact commands you ran, each with its result',
    '   - "risks": anything a reviewer should know (an empty list if none)',
    '   - "filesChanged": the number of files changed (optional)',
    '   For example:',
    '',
    `\`\`\`${CLOUD_REPORT_FENCE}`,
    example,
    '```',
    '',
    `7. If nothing needs changing, still push an empty commit on \`${task.branch}\` (git commit --allow-empty) and open the draft pull request with status "no-change", so Verse sees the task finish.`,
    '8. If you are blocked, push what you have and open the draft pull request with status "blocked" and the reason in the summary.',
  ].join('\n');
}

const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text);

function stringList(value: unknown): string[] | null {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) return null;
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string') return null;
    const text = entry.trim();
    if (text !== '' && out.length < MAX_LIST_ITEMS) out.push(clip(text, MAX_LIST_ITEM_CHARS));
  }
  return out;
}

/** Validates one block's JSON as a CloudTaskReport; lists and text are bounded, not rejected, when long. */
function reportFromBlock(text: string): CloudTaskReport | null {
  if (text.length > CLOUD_REPORT_MAX_BLOCK_CHARS) return null;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const status = record['status'];
  if (typeof status !== 'string' || !STATUSES.includes(status as CloudTaskReport['status'])) return null;
  const summary = typeof record['summary'] === 'string' ? record['summary'].trim() : '';
  if (summary === '') return null;
  const testsRun = stringList(record['testsRun']);
  const risks = stringList(record['risks']);
  if (!testsRun || !risks) return null;
  const report: CloudTaskReport = {
    status: status as CloudTaskReport['status'],
    summary: clip(summary, MAX_SUMMARY_CHARS),
    testsRun,
    risks,
  };
  const files = record['filesChanged'];
  // An invalid count is dropped rather than failing a report that is otherwise fine.
  if (typeof files === 'number' && Number.isInteger(files) && files >= 0 && files <= 1_000_000) report.filesChanged = files;
  return report;
}

/** Find tagged openings separately so an unclosed last attempt cannot expose an older report. */
const REPORT_OPEN_RE = new RegExp(
  String.raw`^[ \t]*(\`{3,})[ \t]*` + CLOUD_REPORT_FENCE + String.raw`(?=[ \t\n]|$)([^\n]*)(?:\n|$)`,
  'gm',
);

/** The newest tagged block is authoritative, including when malformed or unclosed. */
export function parseCloudReport(prBody: string | null | undefined): CloudTaskReport | null {
  if (typeof prBody !== 'string' || prBody === '') return null;
  // The contract puts the block at the END, so a giant body keeps its tail.
  const body = (prBody.length > MAX_BODY_CHARS ? prBody.slice(-MAX_BODY_CHARS) : prBody).replace(/\r\n?/g, '\n');
  let latest: RegExpExecArray | null = null;
  let latestEnd = 0;
  REPORT_OPEN_RE.lastIndex = 0;
  for (let match = REPORT_OPEN_RE.exec(body); match; match = REPORT_OPEN_RE.exec(body)) {
    latest = match;
    latestEnd = REPORT_OPEN_RE.lastIndex;
  }
  if (!latest) return null;
  if (latest[2]!.trim() !== '') return null;

  const ticks = latest[1]!;
  if (ticks.length > MAX_REPORT_FENCE_CHARS) return null;
  const close = new RegExp(String.raw`^[ \t]*` + ticks + String.raw`[ \t]*(?=\n|$)`, 'gm');
  close.lastIndex = latestEnd;
  const ending = close.exec(body);
  if (!ending) return null;
  const block = body.slice(latestEnd, ending.index);
  return reportFromBlock(block);
}
