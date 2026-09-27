/**
 * Starting points for the Automations form and `ashlr automations add
 * --template`. Every template is created DISABLED and scoped to the standing
 * grant's repos (`*`); the operator narrows it and turns it on. Each names the
 * matching built-in playbook (src/core/playbooks/builtins.ts).
 */
import { AUTOMATION_ALL_GRANT_REPOS, type AutomationTemplate } from './types.js';

export const AUTOMATION_TEMPLATES: readonly AutomationTemplate[] = Object.freeze([
  {
    id: 'fix-labeled-issues',
    name: 'Fix issues labeled ashlr',
    blurb: 'Every open issue labelled `ashlr` becomes one fleet task (one per issue, ever).',
    input: {
      name: 'Fix issues labeled ashlr',
      enabled: false,
      trigger: { kind: 'github-issues', labels: ['ashlr'], query: null, includePrs: false, pollMinutes: 15 },
      lane: 'fleet',
      playbookId: 'fix-issue',
      repos: [AUTOMATION_ALL_GRANT_REPOS],
      instructions: 'Fix the GitHub issue below. Keep the change small and focused, add or update a test that proves the fix, and reference the issue number in the PR description.',
      maxConcurrent: 2,
      maxPerDay: 6,
      queueDepth: 20,
      spendCapUsd: 0,
      dedupeKey: null,
      triage: null,
    },
  },
  {
    id: 'nightly-flaky-tests',
    name: 'Nightly flaky test hunt',
    blurb: 'At 02:00 every night, one Claude cloud session per repo hunts a flaky test and stabilises it.',
    input: {
      name: 'Nightly flaky test hunt',
      enabled: false,
      trigger: { kind: 'schedule', rrule: 'FREQ=DAILY;BYHOUR=2;BYMINUTE=0' },
      lane: 'cloud',
      playbookId: 'fix-failing-test',
      repos: [AUTOMATION_ALL_GRANT_REPOS],
      instructions: 'Find ONE flaky test in this repository (look at recent CI failures that passed on retry, timing-dependent assertions, shared global state, real clocks or network). Make it deterministic without weakening what it checks. If you find none, open no PR and say so in the report.',
      maxConcurrent: 1,
      maxPerDay: 3,
      queueDepth: 5,
      spendCapUsd: 60,
      dedupeKey: null,
      triage: null,
    },
  },
  {
    id: 'weekly-dependency-bumps',
    name: 'Weekly dependency bumps',
    blurb: 'Monday 06:00: the fleet bumps patch/minor dependencies, one task per repo.',
    input: {
      name: 'Weekly dependency bumps',
      enabled: false,
      trigger: { kind: 'schedule', rrule: 'FREQ=WEEKLY;BYDAY=MO;BYHOUR=6;BYMINUTE=0' },
      lane: 'fleet',
      playbookId: 'dependency-bump',
      repos: [AUTOMATION_ALL_GRANT_REPOS],
      instructions: 'Update patch and minor versions of this repository\'s dependencies (never a major version). Regenerate the lockfile with the repo\'s own package manager, run the test suite, and leave out any bump that breaks it.',
      maxConcurrent: 2,
      maxPerDay: 10,
      queueDepth: 20,
      spendCapUsd: 0,
      dedupeKey: null,
      triage: null,
    },
  },
  {
    id: 'fix-red-main',
    name: 'Fix red main',
    blurb: 'When a check fails on the default branch, a Claude cloud session fixes it (once per failing commit).',
    input: {
      name: 'Fix red main',
      enabled: false,
      trigger: { kind: 'ci-red', branch: null, pollMinutes: 10 },
      lane: 'cloud',
      playbookId: 'fix-failing-test',
      repos: [AUTOMATION_ALL_GRANT_REPOS],
      instructions: 'The default branch is red. Find the cause of the failing checks listed below and fix it with the smallest correct change. Do not skip, disable or loosen a test to make it pass.',
      maxConcurrent: 1,
      maxPerDay: 4,
      queueDepth: 4,
      spendCapUsd: 60,
      dedupeKey: null,
      triage: null,
    },
  },
] satisfies AutomationTemplate[]);

export function automationTemplate(id: string): AutomationTemplate | null {
  return AUTOMATION_TEMPLATES.find((t) => t.id === id) ?? null;
}
