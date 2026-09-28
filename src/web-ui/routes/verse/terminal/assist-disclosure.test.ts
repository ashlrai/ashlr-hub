import { describe, expect, it } from 'vitest';

import { assistDisclosure, assistLoadingLabel } from './assist-disclosure.js';

describe('terminal assist disclosure', () => {
  it('names the cloud destination and the terminal context before auto requests', () => {
    const text = assistDisclosure('auto');
    expect(text).toContain('Grok');
    expect(text).toContain('current folder');
    expect(text).toContain('recent command/output');
    expect(assistLoadingLabel('auto')).toContain('Grok');
  });

  it('describes the local-only default without implying cloud transfer', () => {
    expect(assistDisclosure('local')).toContain('only to the configured local model');
    expect(assistDisclosure('local')).not.toContain('Grok');
  });
});
