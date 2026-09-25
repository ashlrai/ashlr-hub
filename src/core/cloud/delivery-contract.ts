/**
 * The delivery contract appended to every cloud task prompt (unit C1), and
 * the parser for what the session reports back in its PR body.
 */
import type { CloudTaskReport, CloudTaskV1 } from './types.js';
import { notImplemented } from './_stub.js';

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
export function buildCloudPrompt(_task: CloudTaskV1): string { return notImplemented('buildCloudPrompt'); }
/** Last well-formed `ashlr-cloud-report` block in the body, validated; else null. */
export function parseCloudReport(_prBody: string | null | undefined): CloudTaskReport | null { return notImplemented('parseCloudReport'); }
