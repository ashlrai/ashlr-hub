import { describe, expect, it } from 'vitest';
import { DEFAULT_WORKSPACE_CAP, MAX_WORKSPACE_CAP, parseAgentWorkspaceCap } from '../src/core/verse/agents/types.js';

describe('operator-configured agent workspace capacity', () => {
  it('accepts capacity above the former preset ceiling and explicit no-cap mode', () => {
    expect(parseAgentWorkspaceCap('201')).toBe(201);
    expect(parseAgentWorkspaceCap('10000')).toBe(10000);
    expect(parseAgentWorkspaceCap('none')).toBe(MAX_WORKSPACE_CAP);
    expect(parseAgentWorkspaceCap(' NONE ')).toBe(MAX_WORKSPACE_CAP);
    expect(parseAgentWorkspaceCap(String(Number.MAX_SAFE_INTEGER))).toBe(Number.MAX_SAFE_INTEGER);
  });

  it.each([undefined, '', ' ', '0', '-1', '1.5', 'NaN', 'Infinity', 'anything', '9007199254740992'])(
    'retains established capacity for malformed override %s', (value) => {
    expect(parseAgentWorkspaceCap(value)).toBe(DEFAULT_WORKSPACE_CAP);
  });
});
