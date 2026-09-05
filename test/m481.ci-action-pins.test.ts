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
  'dtolnay/rust-toolchain@4cda84d5c5c54efe2404f9d843567869ab1699d4',
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
      'native-macos-broker-foundation': [
        'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1',
        'dtolnay/rust-toolchain@4cda84d5c5c54efe2404f9d843567869ab1699d4',
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
    expect(workflowText.match(/actions\/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7\.0\.1/g)).toHaveLength(3);
    expect(workflowText.match(/actions\/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7\.0\.0/g)).toHaveLength(2);
  });

  it('runs the dormant native broker library gate on a hosted Mac with pinned Rust', () => {
    const native = jobs['native-macos-broker-foundation'];
    expect(native?.['runs-on']).toBe('macos-latest');
    const serialized = JSON.stringify(native);
    expect(serialized).toContain('toolchain":"1.97.1"');
    expect(serialized).toContain('desktop/src-tauri/binaries/ashlr-${HOST_TRIPLE}');
    expect(serialized).toContain('set -o noclobber');
    expect(workflowText).toContain("trap 'rm -f -- \"$SIDECAR\"' ERR INT TERM");
    expect(serialized).toContain('ASHLR_TEST_SIDECAR_CREATED=1');
    expect(workflowText).toContain('if [[ "${ASHLR_TEST_SIDECAR_CREATED:-}" == "1" ]]');
    expect(serialized).toContain('rustfmt --edition 2021 --check desktop/src-tauri/src/lib.rs desktop/src-tauri/src/native_launchd_broker.rs');
    expect(serialized).toContain('cargo check --manifest-path desktop/src-tauri/Cargo.toml --lib --locked');
    expect(serialized).toContain('cargo clippy --manifest-path desktop/src-tauri/Cargo.toml --lib --locked -- -D warnings');
    expect(serialized).toContain('cargo test --manifest-path desktop/src-tauri/Cargo.toml --lib --locked native_launchd_broker -- --nocapture');
  });
});
