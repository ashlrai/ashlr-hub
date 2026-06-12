/**
 * M33 — `ashlr update` channel awareness (src/cli/update.ts detectChannel).
 *
 * Pure unit tests over the exported detector — the npm-channel install path is
 * gated behind --yes and exercised only at the parse level here (no network).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { pathToFileURL } from 'node:url';
import { sep } from 'node:path';

import { detectChannel } from '../src/cli/update.js';

beforeEach(() => {
  expect.hasAssertions();
});

describe('detectChannel', () => {
  it('reports git for a repo checkout path', () => {
    const url = pathToFileURL(['', 'Users', 'dev', 'ashlr-hub', 'dist', 'cli', 'update.js'].join(sep)).href;
    expect(detectChannel(url)).toBe('git');
  });

  it('reports npm for a node_modules install (global or local)', () => {
    const globalUrl = pathToFileURL(
      ['', 'usr', 'local', 'lib', 'node_modules', '@ashlr', 'hub', 'dist', 'cli', 'update.js'].join(sep),
    ).href;
    expect(detectChannel(globalUrl)).toBe('npm');

    const localUrl = pathToFileURL(
      ['', 'Users', 'dev', 'proj', 'node_modules', '@ashlr', 'hub', 'dist', 'cli', 'update.js'].join(sep),
    ).href;
    expect(detectChannel(localUrl)).toBe('npm');
  });

  it('defaults to this module location (a git checkout in the test env)', () => {
    expect(detectChannel()).toBe('git');
  });
});
