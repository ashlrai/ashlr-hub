/**
 * The contract appended to a Verse CHAT's first message when it starts a Devin
 * session (3.15, the Devin chat seat).
 *
 * A chat is a conversation, not a task: Devin may just answer a question, so
 * unlike the task contract (delivery-contract.ts) it is never told to open a
 * pull request "even if nothing changed". But IF it changes code, the same
 * GitHub rules hold — the tracker, Needs-you and the standing gates only see a
 * PR on `ashlr-devin/<taskId>` — so the branch, the no-merge rule and the
 * report fence are spelled out exactly as for a task.
 */
import { DEVIN_PR_TITLE_PREFIX, DEVIN_REPORT_FENCE, type DevinTaskV1 } from './types.js';

export interface DevinChatPromptOptions {
  /** The chat's permission mode is Plan: Devin is asked to plan and change nothing. */
  planOnly?: boolean;
  /** 3.15: the rendered playbook block (playbooks/resolve.ts) when the first message used a `!macro`. */
  playbook?: string;
}

export function buildDevinChatPrompt(
  task: Pick<DevinTaskV1, 'id' | 'prompt' | 'repo' | 'branch' | 'baseBranch' | 'title'>,
  opts: DevinChatPromptOptions = {},
): string {
  const lines = [
    task.prompt.trim(),
    '',
    '---',
    `(Ashlr Verse chat — Devin session ${task.id}. The operator is chatting with you from Verse; reply in plain markdown.)`,
    '',
  ];
  const playbook = opts.playbook?.trim() ?? '';
  if (playbook) lines.push(playbook, '');
  if (opts.planOnly) {
    lines.push(
      'PLAN ONLY: this chat is in Plan mode. Investigate and answer, propose a plan, but do not change files, push, or open pull requests until the operator says so.',
      '',
    );
  }
  lines.push(
    `If — and only if — you change code in ${task.repo}:`,
    `1. Work on branch \`${task.branch}\`, created from \`${task.baseBranch}\`. Never use another branch name and never push to \`${task.baseBranch}\`, master or main.`,
    `2. Open ONE pull request from \`${task.branch}\` against \`${task.baseBranch}\` titled \`${DEVIN_PR_TITLE_PREFIX} ${task.title}\` (a draft is fine), in the same repository — never a fork.`,
    `3. End the pull request body with a fenced \`${DEVIN_REPORT_FENCE}\` block holding one JSON object: {"status": "done" | "partial" | "blocked" | "no-change", "summary": "…", "testsRun": ["…"], "risks": ["…"]}.`,
    '4. Never merge anything, never approve a pull request, and never enable auto-merge.',
    'Never put secrets, API keys or tokens in commits, pull requests or messages.',
  );
  return lines.join('\n');
}
