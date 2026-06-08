import { describe, it, expect } from 'vitest';
import { redactArgs } from '../src/cli/mcp.js';

describe('redactArgs — secrets passed as CLI args are never displayed', () => {
  it('redacts the value after a sensitive flag', () => {
    expect(redactArgs(['--access-token', 'sbp_5bf63c2cabc123def456'])).toEqual(['--access-token', '<redacted>']);
    expect(redactArgs(['--api-key', 'whatever-value'])).toEqual(['--api-key', '<redacted>']);
    expect(redactArgs(['--password', 'hunter2'])).toEqual(['--password', '<redacted>']);
  });

  it('redacts --flag=VALUE forms for sensitive flags', () => {
    expect(redactArgs(['--api-key=sk_test_51SoWRZabcdef'])).toEqual(['--api-key=<redacted>']);
    expect(redactArgs(['--access-token=sbp_abc'])).toEqual(['--access-token=<redacted>']);
  });

  it('redacts bare tokens that look like known secrets', () => {
    expect(redactArgs(['sk_live_abcdef123456'])).toEqual(['<redacted>']);
    expect(redactArgs(['ghp_aBcDeFgHiJkLmNoPqRsT'])).toEqual(['<redacted>']);
  });

  it('leaves non-sensitive args untouched', () => {
    expect(redactArgs(['-y', '@supabase/mcp-server-supabase@latest', '--read-only'])).toEqual([
      '-y', '@supabase/mcp-server-supabase@latest', '--read-only',
    ]);
    expect(redactArgs(['mcp'])).toEqual(['mcp']);
    expect(redactArgs([])).toEqual([]);
  });

  it('handles a realistic supabase+stripe arg vector with zero raw secret leakage', () => {
    const out = redactArgs(['--access-token', 'sbp_5bf63c2c9911', '--api-key=sk_test_51SoWRZxyz']);
    const joined = out.join(' ');
    expect(joined).not.toMatch(/sbp_5bf63c2c9911|sk_test_51SoWRZxyz/);
    expect(joined).toContain('<redacted>');
  });
});
