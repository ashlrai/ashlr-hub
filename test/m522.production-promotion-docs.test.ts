import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const releaseDocs = readFileSync(join(repoRoot, 'docs/RELEASING.md'), 'utf8');

describe('M522 — production-promotion operator boundary', () => {
  it('states the current manual, local release process ahead of the historical lane', () => {
    // The 3.3.2 record above is historical. The current-process note must lead
    // the document, point at the local procedure, and keep the frozen workflows
    // from reading as a publication path for later versions.
    const currentNote = releaseDocs.split('\n\n')[1] ?? '';
    expect(currentNote).toContain('**Current release process');
    expect(currentNote).toContain('current manual release lane');
    expect(currentNote).toContain('[Releasing locally](RELEASING-LOCALLY.md)');
    expect(currentNote).toContain('Hosted');
    expect(currentNote).toContain('pull-request checks run');
    expect(currentNote).toContain('interactive web 2FA');
    expect(releaseDocs.split('> **Verified distribution state')[0]).toMatch(/not a publishing path\s+(?:>\s+)?for later versions/u);
    expect(releaseDocs).toMatch(/strictly above\s+(?:>\s+)?`3\.3\.2`/u);
  });
});
