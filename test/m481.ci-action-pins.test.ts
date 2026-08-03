/**
 * M481 - CI workflow action trust chain.
 *
 * Pure workflow assertions: every action used by every CI job must be one of
 * the reviewed immutable action commits below.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const workflowText = readFileSync(resolve(repoRoot, '.github/workflows/ci.yml'), 'utf8');
const workflow = parse(workflowText) as Record<string, unknown>;
const jobs = workflow.jobs as Record<string, Record<string, unknown>>;

const approvedActions = new Set([
  'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1',
  'actions/setup-node@820762786026740c76f36085b0efc47a31fe5020',
]);

function actionRefs(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.flatMap(actionRefs);
  }
  if (!value || typeof value !== 'object') {
    return [];
  }

  return Object.entries(value).flatMap(([key, entry]) => {
    if (key === 'uses' && typeof entry === 'string') {
      return [entry];
    }
    return actionRefs(entry);
  });
}

describe('M481 CI workflow action trust chain', () => {
  it('pins every action in every CI job to an approved immutable commit', () => {
    const refsByJob = Object.fromEntries(
      Object.entries(jobs).map(([jobId, job]) => [jobId, actionRefs(job)]),
    );
    const refs = Object.values(refsByJob).flat();

    expect(refsByJob).toEqual({
      ci: [
        'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1',
        'actions/setup-node@820762786026740c76f36085b0efc47a31fe5020',
      ],
      'windows-service-authority': [
        'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1',
        'actions/setup-node@820762786026740c76f36085b0efc47a31fe5020',
      ],
    });

    for (const ref of refs) {
      expect(ref, `mutable action ref: ${ref}`).toMatch(
        /^[a-z0-9_.-]+\/[a-z0-9_.-]+@[0-9a-f]{40}$/i,
      );
      expect(approvedActions.has(ref), `unapproved action ref: ${ref}`).toBe(true);
    }
  });

  it('keeps reviewed action versions visible beside every pin', () => {
    expect(workflowText.match(/actions\/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7\.0\.1/g)).toHaveLength(2);
    expect(workflowText.match(/actions\/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7\.0\.0/g)).toHaveLength(2);
  });
});
