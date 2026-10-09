import { afterEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { COMPANION_RELEASES, inventoryCompanions as productionInventory, type CompanionInventoryOptions } from '../src/core/companion-inventory.js';

const roots: string[] = [];
// Real subprocess fixtures stand in for native companions; production CLI has no bypass flag.
const inventoryCompanions = (options?: CompanionInventoryOptions) => productionInventory(options, () => true);
function fixture(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'phm-companion-test-')));
  roots.push(root);
  return root;
}
function executable(directory: string, name: string, version: string, options: { help?: string; code?: string } = {}): string {
  mkdirSync(directory, { recursive: true });
  const path = join(directory, name);
  const log = join(directory, `${name}.probes.jsonl`);
  const body = `#!${process.execPath}\n` +
    `const fs = require('node:fs');\n` +
    `fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({args:process.argv.slice(2),env:process.env,cwd:process.cwd()})+'\\n');\n` +
    (options.code ?? `if(process.argv[2]==='--version') console.log(${JSON.stringify(version)});\nelse if(process.argv[2]==='--help') console.log(${JSON.stringify(options.help ?? `Usage: ${name} [OPTIONS] <COMMAND>\nCommands: help`)});\nelse process.exit(9);\n`);
  writeFileSync(path, body);
  chmodSync(path, 0o700);
  return path;
}
function probes(directory: string, name: string): Array<{ args: string[]; env: Record<string, string>; cwd: string }> {
  return readFileSync(join(directory, `${name}.probes.jsonl`), 'utf8').trim().split('\n').map(line => JSON.parse(line));
}
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('companion executable inventory', () => {
  it('reports missing companions without claiming bundling or runtime readiness', async () => {
    const report = await inventoryCompanions({ searchPaths: [] });
    expect(report).toMatchObject({ schemaVersion: 1, bundled: false, probe: 'version-help-only' });
    expect(report.companions).toHaveLength(3);
    for (const tool of report.companions) expect(tool).toMatchObject({ installed: false, path: null,
      status: 'missing', version: null, compatibility: 'unknown', runtimeCapability: 'not-inspected' });
  });

  it.skipIf(process.platform === 'win32')('identifies all exact pins with only two bounded harmless probes and no inherited credentials', async () => {
    const directory = join(fixture(), 'bin with spaces');
    for (const release of COMPANION_RELEASES) executable(directory, release.binary,
      release.id === 'lexicon' ? release.version : `${release.binary} ${release.version}`);
    vi.stubEnv('OPENAI_API_KEY', 'synthetic-inherited-secret');
    vi.stubEnv('LOCUS_BINDING', 'synthetic-binding');
    vi.stubEnv('LEXICON_PATH', '/synthetic/unreadable/private-lexicon.yaml');
    const report = await inventoryCompanions({ searchPaths: [directory] });
    for (const tool of report.companions) {
      expect(tool).toMatchObject({ installed: true, bundled: false, status: 'known-interface',
        compatibility: 'known-cli-surface', runtimeCapability: 'not-inspected' });
      const calls = probes(directory, tool.binary);
      expect(calls.map(call => call.args)).toEqual([['--version'], ['--help']]);
      for (const call of calls) {
        expect(call.env.OPENAI_API_KEY).toBeUndefined();
        expect(call.env.LOCUS_BINDING).toBeUndefined();
        expect(call.env.LEXICON_PATH).toBeUndefined();
        expect(call.env.HOME).toBe(call.cwd);
        expect(call.cwd).not.toContain(directory);
        expect(existsSync(call.cwd)).toBe(false);
      }
    }
    expect(JSON.stringify(report)).not.toContain('synthetic-inherited-secret');
  });

  it.skipIf(process.platform === 'win32')('refuses ambiguous candidates before running either and permits explicit selection', async () => {
    const first = fixture(); const second = fixture();
    const selected = executable(first, 'phantom', 'phantom 0.7.9');
    executable(second, 'phantom', 'phantom 0.7.9');
    const ambiguous = (await inventoryCompanions({ searchPaths: [first, second] })).companions[0]!;
    expect(ambiguous).toMatchObject({ status: 'ambiguous', installed: false, path: null });
    expect(ambiguous.candidates).toHaveLength(2);
    expect(existsSync(join(first, 'phantom.probes.jsonl'))).toBe(false);
    expect(existsSync(join(second, 'phantom.probes.jsonl'))).toBe(false);
    const chosen = (await inventoryCompanions({ searchPaths: [first, second], binaries: { secrets: selected } })).companions[0]!;
    expect(chosen).toMatchObject({ status: 'known-interface', path: selected });
    expect(existsSync(join(second, 'phantom.probes.jsonl'))).toBe(false);
  });

  it.skipIf(process.platform === 'win32')('deduplicates physical symlink targets and ignores relative PATH/current project entries', async () => {
    const directory = fixture(); const alias = fixture();
    const path = executable(directory, 'locus', 'locus 0.5.0');
    symlinkSync(path, join(alias, 'locus'));
    vi.stubEnv('PATH', ['', '.', directory, alias].join(':'));
    const tool = (await inventoryCompanions()).companions[1]!;
    expect(tool).toMatchObject({ status: 'known-interface', path });
    expect(tool.candidates).toEqual([path]);
    expect(probes(directory, 'locus')).toHaveLength(2);
  });

  it.skipIf(process.platform === 'win32')('never falls back when an explicit selected path is absent', async () => {
    const directory = fixture();
    executable(directory, 'phantom', 'phantom 0.7.9');
    const tool = (await inventoryCompanions({ searchPaths: [directory], binaries: { secrets: join(directory, 'missing') } })).companions[0]!;
    expect(tool.status).toBe('missing');
    expect(existsSync(join(directory, 'phantom.probes.jsonl'))).toBe(false);
  });

  it.skipIf(process.platform === 'win32')('never executes a recognized automatic installation wrapper, including explicit paths', async () => {
    const directory = fixture();
    const binary = executable(directory, 'locus', '', { code: "// legacy wrapper: downloadReleaseBinary; cargo install --git\nconsole.log('locus 0.5.0');" });
    for (const options of [{ searchPaths: [directory] }, { searchPaths: [], binaries: { locus: binary } }]) {
      const tool = (await inventoryCompanions(options)).companions[1]!;
      expect(tool).toMatchObject({ installed: false, status: 'unsupported-launcher' });
    }
    expect(existsSync(join(directory, 'locus.probes.jsonl'))).toBe(false);
  });

  it.skipIf(process.platform === 'win32')('production refuses all Secrets/Locus scripts even when explicitly selected, while allowing the Lexicon Node CLI', async () => {
    const directory = fixture();
    const secrets = executable(directory, 'phantom', 'phantom 0.7.9');
    const locus = executable(directory, 'locus', 'locus 0.5.0');
    executable(directory, 'lexicon', '0.5.4');
    for (const options of [{ searchPaths: [directory] }, { searchPaths: [directory], binaries: { secrets, locus } }]) {
      const report = await productionInventory(options);
      expect(report.companions.slice(0, 2).map(tool => tool.status)).toEqual(['unsupported-launcher', 'unsupported-launcher']);
      expect(report.companions[2]!.status).toBe('known-interface');
    }
    expect(existsSync(join(directory, 'phantom.probes.jsonl'))).toBe(false);
    expect(existsSync(join(directory, 'locus.probes.jsonl'))).toBe(false);
  });

  it.skipIf(process.platform === 'win32')('rejects the workbench executable under the Secrets name without forwarding output', async () => {
    const directory = fixture();
    executable(directory, 'phantom', 'phm 3.26.1', { help: 'Usage: phm [OPTIONS]\nsynthetic-private-marker' });
    const report = await inventoryCompanions({ searchPaths: [directory] });
    expect(report.companions[0]).toMatchObject({ status: 'wrong-product', installed: false, version: null });
    expect(JSON.stringify(report)).not.toContain('synthetic-private-marker');
  });

  it.skipIf(process.platform === 'win32')('refuses unknown newer versions and help identity mismatches', async () => {
    const directory = fixture();
    executable(directory, 'locus', 'locus 0.6.0');
    executable(directory, 'lexicon', '0.5.4', { help: 'Usage: different-tool [options]' });
    const report = await inventoryCompanions({ searchPaths: [directory] });
    expect(report.companions[1]).toMatchObject({ installed: true, version: '0.6.0',
      status: 'unsupported-version', compatibility: 'unknown' });
    expect(report.companions[2]).toMatchObject({ installed: false, status: 'wrong-product' });
  });

  it.skipIf(process.platform === 'win32')('discard successful-looking nonzero output and never starts MCP or a service', async () => {
    const directory = fixture();
    executable(directory, 'phantom', '', { code: "console.log('phantom 0.7.9 synthetic-secret'); process.exit(2);" });
    const report = await inventoryCompanions({ searchPaths: [directory] });
    expect(report.companions[0]).toMatchObject({ installed: false, status: 'probe-failed', version: null });
    expect(probes(directory, 'phantom').map(call => call.args)).toEqual([['--version']]);
    expect(JSON.stringify(report)).not.toContain('synthetic-secret');
  });

  it.skipIf(process.platform === 'win32')('bounds output and terminates stalled version probes', async () => {
    const directory = fixture();
    executable(directory, 'locus', '', { code: "console.log('x'.repeat(100000));" });
    executable(directory, 'phantom', '', { code: 'setInterval(() => {}, 10000);' });
    const report = await inventoryCompanions({ searchPaths: [directory] });
    expect(report.companions.slice(0, 2).map(tool => tool.status)).toEqual(['probe-failed', 'probe-failed']);
    expect(JSON.stringify(report).length).toBeLessThan(5000);
  });

  it.skipIf(process.platform === 'win32')('isolates concurrent project probes in distinct disposable roots without a cache', async () => {
    const projectA = fixture(); const projectB = fixture();
    executable(projectA, 'lexicon', '0.5.4');
    executable(projectB, 'lexicon', '0.9.0');
    const [a, b] = await Promise.all([inventoryCompanions({ searchPaths: [projectA] }),
      inventoryCompanions({ searchPaths: [projectB] })]);
    expect(a.companions[2]!.status).toBe('known-interface');
    expect(b.companions[2]!.status).toBe('unsupported-version');
    expect(probes(projectA, 'lexicon')[0]!.cwd).not.toBe(probes(projectB, 'lexicon')[0]!.cwd);
    expect(existsSync(probes(projectA, 'lexicon')[0]!.cwd)).toBe(false);
    expect(existsSync(probes(projectB, 'lexicon')[0]!.cwd)).toBe(false);
  });

  it('rejects relative explicit paths and oversized discovery lists before probes', async () => {
    await expect(inventoryCompanions({ searchPaths: ['.'] })).rejects.toThrow('absolute');
    await expect(inventoryCompanions({ binaries: { secrets: 'phantom' } })).rejects.toThrow('absolute');
    await expect(inventoryCompanions({ searchPaths: Array(257).fill(tmpdir()) })).rejects.toThrow('256');
  });
});

describe.skipIf(!process.env.PHM_COMPANION_SECRETS_TEST_BIN)('opt-in preserved Secrets release version/help', () => {
  it('matches the pinned CLI identity while preserving the executable bytes', async () => {
    const binary = process.env.PHM_COMPANION_SECRETS_TEST_BIN!;
    const hash = () => createHash('sha256').update(readFileSync(binary)).digest('hex');
    const before = hash();
    const report = await productionInventory({ searchPaths: [], binaries: { secrets: binary } });
    expect(report.companions[0]).toMatchObject({ installed: true, version: '0.7.9',
      status: 'known-interface', compatibility: 'known-cli-surface', runtimeCapability: 'not-inspected' });
    expect(hash()).toBe(before);
  });
});
