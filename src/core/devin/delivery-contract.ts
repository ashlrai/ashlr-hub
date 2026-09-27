/**
 * The delivery contract appended to every Devin task prompt (3.15), and the
 * structured-output schema asked of the session.
 *
 * WHY a contract: the standing gates only trust what arrives on GitHub, on a
 * branch they can pin. A Devin PR on any branch but `ashlr-devin/<taskId>` is
 * invisible to the tracker and refused by the intake, and one that merges
 * bypasses the gates — so both are spelled out, every time. The report is the
 * same shape as the cloud lane's (cloud/types.ts CloudTaskReport) and is a
 * CLAIM: the intake marks it UNVERIFIED and G4 checks it against the diff.
 */
import { parseCloudReport, cloudReportFromValue } from '../cloud/delivery-contract.js';
import type { CloudTaskReport } from '../cloud/types.js';
import { DEVIN_PR_TITLE_PREFIX, DEVIN_REPORT_FENCE, type DevinTaskV1 } from './types.js';

/**
 * SessionCreateRequest.structured_output_schema — "JSON Schema (Draft 7) for
 * validating structured output. Max 64KB. Must be self-contained (no external
 * $ref)." https://docs.devin.ai/api-reference/v3/sessions/post-organizations-sessions
 */
export const DEVIN_REPORT_SCHEMA: Readonly<Record<string, unknown>> = Object.freeze({
  $schema: 'http://json-schema.org/draft-07/schema#',
  type: 'object',
  additionalProperties: false,
  required: ['status', 'summary', 'testsRun', 'risks'],
  properties: {
    status: { type: 'string', enum: ['done', 'partial', 'blocked', 'no-change'] },
    summary: { type: 'string', maxLength: 2000 },
    testsRun: { type: 'array', maxItems: 50, items: { type: 'string', maxLength: 500 } },
    risks: { type: 'array', maxItems: 50, items: { type: 'string', maxLength: 500 } },
    filesChanged: { type: 'integer', minimum: 0 },
  },
});

/**
 * `playbook` (3.15) is the rendered playbook block (playbooks/resolve.ts),
 * inlined between the task text and the contract. Empty ⇒ unchanged. It is
 * inlined rather than synced as a Devin-side playbook: one source of truth,
 * versioned here, and no Devin playbook to keep in step.
 */
export function buildDevinPrompt(task: Pick<DevinTaskV1, 'id' | 'prompt' | 'repo' | 'branch' | 'baseBranch' | 'title'>, playbook = ''): string {
  const example = JSON.stringify({
    status: 'done',
    summary: 'One or two plain sentences on what changed and why.',
    testsRun: ['npx vitest run test/example.test.ts (12 passed)'],
    risks: ['Anything a reviewer should look at closely.'],
    filesChanged: 3,
  }, null, 2);
  return [
    task.prompt.trim(),
    ...(playbook.trim() ? ['', playbook.trim()] : []),
    '',
    '---',
    `DELIVERY CONTRACT (Ashlr Verse Devin task ${task.id}) — follow it exactly; Verse only sees what arrives on GitHub.`,
    '',
    `Repository: ${task.repo}. Base branch: \`${task.baseBranch}\`.`,
    `1. Create branch \`${task.branch}\` from \`${task.baseBranch}\` and do all work on it. Never use any other branch name.`,
    `2. Never push to any other branch. Never push to \`${task.baseBranch}\`, master or main. Never merge anything, never approve a pull request, and never enable auto-merge.`,
    '3. Run the repository\'s relevant checks and tests for what you changed, and fix what you broke.',
    `4. Commit your work, then push \`${task.branch}\` to origin (the same repository — never a fork).`,
    `5. Open ONE pull request from \`${task.branch}\` against \`${task.baseBranch}\` titled \`${DEVIN_PR_TITLE_PREFIX} ${task.title}\`. A draft is fine.`,
    `6. The pull request body must END with a fenced code block whose language tag is \`${DEVIN_REPORT_FENCE}\`, containing one JSON object:`,
    '   - "status": "done" | "partial" | "blocked" | "no-change"',
    '   - "summary": a short plain-language summary',
    '   - "testsRun": the exact commands you ran, each with its result',
    '   - "risks": anything a reviewer should know (an empty list if none)',
    '   - "filesChanged": the number of files changed (optional)',
    '   For example:',
    '',
    `\`\`\`${DEVIN_REPORT_FENCE}`,
    example,
    '```',
    '',
    '7. Also provide the same JSON object as your structured output.',
    `8. If nothing needs changing, still push an empty commit on \`${task.branch}\` and open the pull request with status "no-change", so Verse sees the task finish.`,
    '9. If you are blocked, push what you have and open the pull request with status "blocked" and the reason in the summary.',
    '10. Never put secrets, API keys or tokens in commits, the pull request, or your messages.',
  ].join('\n');
}

/** The report in a Devin PR body (the newest `ashlr-devin-report` block), or null. */
export function parseDevinReport(prBody: string | null | undefined): CloudTaskReport | null {
  return parseCloudReport(prBody, DEVIN_REPORT_FENCE);
}

/** The session's structured output as a report, or null. Same bounds as the PR-body report. */
export function devinReportFromStructuredOutput(value: unknown): CloudTaskReport | null {
  return cloudReportFromValue(value);
}
