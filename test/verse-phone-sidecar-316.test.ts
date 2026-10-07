import { describe, expect, it, vi } from 'vitest';
import { cmdVerse, parseVerseArgs, verseStartupTokenFields } from '../src/cli/verse.js';

describe('Verse desktop phone gateway startup handshake', () => {
  const remoteArgs = ['--port', '7777', '--no-open', '--json', '--remote-config', '/private/verse-remote.json'];
  const tokens = { readToken: 'read-secret', token: 'mutation-secret' };

  it('keeps remote CLI startup output free of Hub credentials by default', () => {
    expect(parseVerseArgs(remoteArgs)).toMatchObject({ remoteConfig: '/private/verse-remote.json', desktopTokenHandoff: false });
    expect(verseStartupTokenFields(true, false, tokens)).toEqual({});
    expect(JSON.stringify(verseStartupTokenFields(true, false, tokens))).not.toContain('secret');
  });

  it('allows the app-owned sidecar to receive its private startup tokens', () => {
    expect(parseVerseArgs([...remoteArgs, '--desktop-token-handoff'])).toMatchObject({
      remoteConfig: '/private/verse-remote.json', desktopTokenHandoff: true,
    });
    expect(verseStartupTokenFields(true, true, tokens)).toEqual({
      readToken: 'read-secret', readTokenHeader: 'X-Ashlr-Token',
      token: 'mutation-secret', tokenHeader: 'X-Ashlr-Token',
    });
  });

  it('rejects the private handoff flag without remote JSON startup', () => {
    expect(parseVerseArgs(['--desktop-token-handoff'])).toMatchObject({ code: 2 });
    expect(parseVerseArgs(['--remote-config', '/private/config.json', '--desktop-token-handoff'])).toMatchObject({ code: 2 });
    expect(parseVerseArgs(['--json', '--desktop-token-handoff'])).toMatchObject({ code: 2 });
  });
});

describe('Phantom console CLI help', () => {
  it('shows the product name without starting a server or changing the compatible invocation', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      expect(await cmdVerse(['--help'])).toBe(0);
      const output = log.mock.calls.map(args => args.join(' ')).join('\n');
      expect(output).toContain('Open the Phantom console:');
      expect(output).toContain('ashlr verse');
      expect(output).toContain('/verse/');
      expect(output).toContain('--remote-config FILE');
    } finally { log.mockRestore(); }
  });
});
