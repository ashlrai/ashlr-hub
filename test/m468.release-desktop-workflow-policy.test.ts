/**
 * M468 - desktop release workflow supply-chain policy.
 *
 * Pure filesystem assertions: no network, credentials, release, or workflow
 * execution. These checks keep every downloaded action immutable and keep the
 * release job's GitHub token at the minimum authority its upload step needs.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const workflow = readFileSync(
  join(REPO_ROOT, '.github/workflows/release-desktop.yml'),
  'utf8',
);

const actionRefs = [...workflow.matchAll(/^\s*-?\s*uses:\s*([^\s#]+)(?:\s+#.*)?$/gm)].map(
  (match) => match[1]!,
);

describe('M468 desktop release workflow supply-chain policy', () => {
  it('pins every third-party action to a full immutable commit', () => {
    expect(actionRefs).toHaveLength(6);
    for (const ref of actionRefs) {
      expect(ref, `mutable action ref: ${ref}`).toMatch(
        /^[a-z0-9_.-]+\/[a-z0-9_.-]+@[0-9a-f]{40}$/i,
      );
    }

    expect(actionRefs).toEqual([
      'actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683',
      'oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6',
      'actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020',
      'dtolnay/rust-toolchain@4cda84d5c5c54efe2404f9d843567869ab1699d4',
      'actions/cache@0400d5f644dc74513175e3cd8d07132dd4860809',
      'tauri-apps/tauri-action@84b9d35b5fc46c1e45415bdb6144030364f7ebc5',
    ]);
  });

  it('pins every downloaded tool and avoids floating package acquisition', () => {
    expect(workflow).toMatch(/^ {2}RUST_VERSION: "\d+\.\d+\.\d+"$/m);
    expect(workflow).toMatch(/^ {2}NODE_VERSION: "\d+\.\d+\.\d+"$/m);
    expect(workflow).toMatch(/^ {2}BUN_VERSION: "\d+\.\d+\.\d+"$/m);
    expect(workflow).toMatch(/^ {2}TAURI_CLI_VERSION: "\d+\.\d+\.\d+"$/m);
    expect(workflow).toContain('run: npm ci');
    expect(workflow).toContain(
      'npm install --global @tauri-apps/cli@${{ env.TAURI_CLI_VERSION }}',
    );
    expect(workflow).toContain('tauriScript: tauri');
    expect(workflow).not.toMatch(/bun-version:\s*latest/);
    expect(workflow).not.toMatch(/RUST_VERSION:\s*["']?stable/);
    expect(workflow).not.toMatch(/bunx\s+@tauri-apps\/cli@/);
    expect(workflow).not.toMatch(/@tauri-apps\/cli@[~^*]/);
    expect(workflow).not.toContain('bun install');
  });

  it('limits token authority and does not persist checkout credentials', () => {
    expect(workflow).toMatch(/^permissions: \{\}$/m);
    expect(workflow).toMatch(
      /^ {4}permissions:\n {6}contents: write\s+# create the draft release and upload assets$/m,
    );
    expect(workflow).not.toMatch(/^\s+(?:id-token|actions|checks|deployments|packages):\s*write/m);
    expect(workflow).toContain('persist-credentials: false');
  });

  it('preserves the bounded draft-release behavior on all three platforms', () => {
    expect(workflow).toContain('- "desktop-v*"');
    expect(workflow).toContain('workflow_dispatch:');
    expect(workflow).toContain('- os: macos-latest');
    expect(workflow).toContain('- os: windows-latest');
    expect(workflow).toContain('- os: ubuntu-latest');
    expect(workflow).toContain('projectPath: desktop');
    expect(workflow).toContain('releaseDraft: true');
    expect(workflow).toContain('GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}');
  });
});
