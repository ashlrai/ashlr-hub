import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, symlinkSync, realpathSync, linkSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cmdMcp, mergeEcosystemServers, buildEcosystemMcpEntry } from '../src/cli/mcp.js';
import { lexiconServerSpec } from '../src/core/integrations/lexicon-mcp.js';

const roots: string[] = [];
function fixture(binary = 'lexicon-mcp') {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'phantom-lexicon-onboard-')));
  roots.push(root);
  const bin = join(root, 'bin');
  mkdirSync(bin);
  // Discovery must never execute this artifact, even on --write.
  writeFileSync(join(bin, binary), '#!/bin/sh\ntouch "' + join(root, 'executed') + '"\nexit 91\n', { mode: 0o755 });
  vi.stubEnv('PATH', bin);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const config = join(root, '.mcp.json');
  return { root, bin, config, args: ['ecosystem', '--only', 'lexicon', '--project', root, '--client', 'claude', '--config', config] };
}
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('project/client-bound Lexicon onboarding', () => {
  it('plans without writing, reading vocabulary, or starting the installed server', async () => {
    const f = fixture();
    expect(await cmdMcp(f.args)).toBe(0);
    expect(existsSync(f.config)).toBe(false);
    expect(existsSync(join(f.root, 'executed'))).toBe(false);
    expect(existsSync(join(f.root, '.phantom'))).toBe(false);
  });
  it.each(['lexicon-mcp', 'lexicon'])('registers exact %s launch with isolated vocabulary/trust paths', async binary => {
    const f = fixture(binary);
    writeFileSync(f.config, JSON.stringify({ preserved: 17, mcpServers: { custom: { command: '/other', args: [] } } }));
    expect(await cmdMcp([...f.args, '--write'])).toBe(0);
    const written = readFileSync(f.config, 'utf8');
    const inode = statSync(f.config).ino;
    expect(statSync(f.config).mode & 0o777).toBe(0o600);
    const config = JSON.parse(written);
    expect(config.preserved).toBe(17);
    expect(config.mcpServers.custom.command).toBe('/other');
    expect(config.mcpServers.lexicon).toEqual(lexiconServerSpec({ projectRoot: f.root, client: 'claude', command: join(f.bin, binary), launch: binary === 'lexicon' ? 'cli' : 'stdio' }));
    expect(await cmdMcp([...f.args, '--write'])).toBe(0);
    expect(readFileSync(f.config, 'utf8')).toBe(written);
    expect(statSync(f.config).ino).toBe(inode);
    expect(existsSync(join(f.root, 'executed'))).toBe(false);
    expect(existsSync(join(f.root, '.phantom'))).toBe(false);
  });
  it('rejects an ambient or missing scope before any config write', async () => {
    const f = fixture();
    expect(await cmdMcp(['ecosystem', '--only', 'lexicon', '--write'])).toBe(2);
    expect(existsSync(f.config)).toBe(false);
  });
  it('does not create a global config for an unbound discovered Lexicon', async () => {
    const f = fixture();
    vi.stubEnv('HOME', f.root);
    expect(await cmdMcp(['ecosystem', '--write'])).toBe(0);
    expect(existsSync(join(f.root, '.ashlr'))).toBe(false);
    expect(existsSync(join(f.root, 'executed'))).toBe(false);
  });
  it('rejects a client traversal and outside project config', async () => {
    const f = fixture();
    const traversal = f.args.map(a => a === 'claude' ? '../other' : a);
    expect(await cmdMcp([...traversal, '--write'])).toBe(2);
    expect(await cmdMcp([...f.args.slice(0, -1), join(tmpdir(), 'other-lexicon.json'), '--write'])).toBe(2);
    expect(existsSync(f.config)).toBe(false);
  });
  it('rejects symlinked vocabulary storage that escapes the project', async () => {
    const f = fixture();
    const outside = mkdtempSync(join(tmpdir(), 'phantom-lexicon-outside-'));
    roots.push(outside);
    symlinkSync(outside, join(f.root, '.phantom'), 'dir');
    expect(await cmdMcp([...f.args, '--write'])).toBe(2);
    expect(existsSync(f.config)).toBe(false);
  });
  it('preserves malformed config and mismatched existing bindings', async () => {
    const f = fixture();
    writeFileSync(f.config, '{broken');
    expect(await cmdMcp([...f.args, '--write'])).toBe(1);
    expect(readFileSync(f.config, 'utf8')).toBe('{broken');
    const previous = JSON.stringify({ mcpServers: { lexicon: { command: '/old', args: [], env: { LEXICON_CWD: '/other' } } } });
    writeFileSync(f.config, previous);
    expect(await cmdMcp([...f.args, '--write'])).toBe(1);
    expect(readFileSync(f.config, 'utf8')).toBe(previous);
  });
  it('refuses a hardlinked project config without altering the outside inode', async () => {
    const f = fixture();
    const outside = mkdtempSync(join(tmpdir(), 'phantom-config-outside-'));
    roots.push(outside);
    const other = join(outside, 'settings.json');
    writeFileSync(other, '{"preserved":true}');
    linkSync(other, f.config);
    expect(await cmdMcp([...f.args, '--write'])).toBe(1);
    expect(readFileSync(other, 'utf8')).toBe('{"preserved":true}');
    expect(readFileSync(f.config, 'utf8')).toBe('{"preserved":true}');
  });
  it('refuses a dangling config symlink and preserves the existing link', async () => {
    const f = fixture();
    const absent = join(f.root, 'not-created.json');
    symlinkSync(absent, f.config);
    expect(await cmdMcp([...f.args, '--write'])).toBe(2);
    expect(existsSync(absent)).toBe(false);
    expect(() => mergeEcosystemServers([], f.config)).toThrow('non-regular');
  });
  it('refuses command-only Lexicon registration and preserves explicit Locus client/home on upgrade', () => {
    const f = fixture();
    expect(() => mergeEcosystemServers([{ name: 'lexicon', command: '/lexicon', args: ['mcp'] }], f.config)).toThrow('explicit project/client');
    writeFileSync(f.config, JSON.stringify({ mcpServers: { locus: { command: 'locus-mcp', args: [], env: { LOCUS_HOME: '/bound/home' } } } }));
    mergeEcosystemServers([{ name: 'locus', command: 'locus-mcp', args: [], env: { LOCUS_HOME: '/ambient/home', LOCUS_CLIENT: 'project-client' } }], f.config);
    const locus = JSON.parse(readFileSync(f.config, 'utf8')).mcpServers.locus;
    expect(locus.env.LOCUS_HOME).toBe('/bound/home');
    expect(locus.env.LOCUS_CLIENT).toBe('project-client');
    expect(buildEcosystemMcpEntry({ name: 'locus', command: 'locus-mcp', args: [], env: { LOCUS_CLIENT: 'bound-client' } }).env?.LOCUS_CLIENT).toBe('bound-client');
  });
});
