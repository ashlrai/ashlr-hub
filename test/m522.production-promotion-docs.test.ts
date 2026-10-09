import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const releaseDocs = readFileSync(join(repoRoot, 'docs/RELEASING.md'), 'utf8');
const historicalDocs = readFileSync(join(repoRoot, 'docs/RELEASING-HISTORICAL.md'), 'utf8');

describe('M522 — production-promotion operator boundary', () => {
  it('states commissioned canonical publishing ahead of the separate historical lane', () => {
    // Current instructions lead; neither a candidate bump nor the historical
    // 3.3.2 workflows establish a current publication or runtime activation.
    const currentNote = (releaseDocs.split('\n\n')[1] ?? '').replace(/^>\s?/gm, '').replace(/\s+/g, ' ');
    expect(currentNote).toContain('**Current release process');
    expect(currentNote).toContain('(RELEASING-LOCALLY.md#canonical-npm-trusted-publishing)');
    expect(currentNote).toMatch(/original qualified CI archive using short-lived identity/u);
    expect(currentNote).toMatch(/verifies public bytes and npm provenance[^.]*isolated consumer[^.]*then promotes `latest`/u);
    expect(currentNote).toMatch(/Routine qualified npm releases do not require repeated Touch ID or browser approvals/u);
    expect(currentNote).toMatch(/Initial or changed publisher bindings still require npm owner authentication/u);
    expect(currentNote).toMatch(/exact-source hosted CI, independent Audit and trusted attestation remain prerequisites/u);
    expect(currentNote).toMatch(/Native desktop finalization, signed asset publication, installation and resident activation are separate steps/u);
    expect(currentNote).toMatch(/`release.yml` and `promote.yml`[^.]*historical 3\.3\.2 lane; they are not the current publisher/u);
    expect(currentNote).toMatch(/Publication does not activate provider credentials, spending permissions or resident autonomy/u);
    const currentRelease = releaseDocs.split('> **Verified distribution state')[0]!;
    expect(currentRelease.replace(/\s+/g, ' ')).toMatch(/candidate version bump does not become a publication claim/u);
    expect(releaseDocs).toContain('(RELEASING-HISTORICAL.md)');
    expect(releaseDocs).not.toContain('Keep Actions disabled');
    expect(historicalDocs).toContain('**Verified distribution state — 2026-09-05 UTC:** `@ashlr/hub@3.3.2`');
  });

  it('preserves the original archive bytes without treating its directives as current', () => {
    const marker = '> **Verified distribution state — 2026-09-05 UTC:**';
    expect(historicalDocs.split(marker)).toHaveLength(2);
    const body = historicalDocs.slice(historicalDocs.indexOf(marker));
    expect(createHash('sha256').update(body).digest('hex'))
      .toBe('6df3f0d204c501eba917d0052c4a7f070ad2bb755e912d111d4a9f54e16547dc');
    expect(historicalDocs).toContain('not current release instructions');
    expect(historicalDocs).toContain('Keep Actions disabled');
    expect(releaseDocs).not.toContain('all successor verification runs locally');
    expect(releaseDocs).not.toContain('npm trust github @ashlr/hub');
    expect(releaseDocs).toContain('## Qualified CI build handoff');
    expect(releaseDocs).toContain('Local feedback and\n`prepublishOnly` do not replace those gates.');
    const locally = readFileSync(join(repoRoot, 'docs/RELEASING-LOCALLY.md'), 'utf8');
    const feedback = locally.split('## Local qualification fallback\n')[1]!.split('## ')[0]!;
    expect(feedback).toContain('Local packaging does not authorize canonical publication');
    expect(feedback).toContain('(#canonical-npm-trusted-publishing)');
    expect(feedback).not.toMatch(/^npm publish /mu);
  });

  it('binds the documented provenance and consumer-before-latest sequence to the canonical publisher', () => {
    const locally = readFileSync(join(repoRoot, 'docs/RELEASING-LOCALLY.md'), 'utf8');
    expect(locally).toContain('(../.github/workflows/publish-canonical-npm.yml)');
    const workflow = parseYaml(readFileSync(join(repoRoot, '.github/workflows/publish-canonical-npm.yml'), 'utf8')) as {
      jobs: Record<string, { environment?: string; needs?: string[]; permissions?: Record<string, string>; steps: { run?: string }[] }>;
    };
    const { publish, consumer, promote } = workflow.jobs;
    const publishRun = publish!.steps.map(step => step.run ?? '').join('\n');
    expect(publish!.environment).toBe('phantom-npm');
    expect(publish!.permissions?.['id-token']).toBe('write');
    expect(publishRun).toContain('npm publish "$RUNNER_TEMP/phantom-npm-admitted/$FILENAME" --ignore-scripts --provenance');
    expect(consumer!.needs).toContain('publish');
    expect(consumer!.permissions?.['id-token']).toBeUndefined();
    expect(promote!.needs).toContain('consumer');
    expect(promote!.steps.map(step => step.run ?? '').join('\n')).toContain('npm dist-tag add "@ashlr/phantom@$VERSION" latest');
  });
});
