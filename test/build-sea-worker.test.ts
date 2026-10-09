import { mkdtempSync, mkdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  createSeaCompileArgs,
  createSeaWorkerShim,
  createSeaEngineeringWorkerShim,
  createSeaEngineeringReadWorkerShim,
  createSeaFleetHistoryWorkerShim,
  createSeaOutcomesWorkerShim,
  createSeaShim, DESKTOP_METADATA_PREFLIGHT_FLAG, collectVerifySafetySources, collectClaudeToolWorkerSource, VERIFY_SAFETY_SOURCE_KEYS,
} from '../scripts/build-sea.mjs';
import { embeddedSafetySourceReader, VERIFY_SAFETY_SOURCE_KEYS as runtimeKeys } from '../src/cli/verify-safety-sources.js';
import { embeddedClaudeToolWorkerDigest } from '../src/core/sandbox/claude-broker-tool-invocation.js';

describe('closed signed desktop metadata preflight', () => {
  function run(operands: string[], qualify: (signal: AbortSignal) => Promise<unknown>) {
    const writes: string[] = [];
    let done!: (code: number) => void;
    const exited = new Promise<number>(resolve => { done = resolve; });
    let timeout!: () => void;
    const clearTimeout = vi.fn();
    const pair = JSON.stringify({ schemaVersion: 1, revision: 'a'.repeat(40), tree: 'b'.repeat(40), version: '3.29.6' });
    const context = { process: { argv: ['ashlr', 'compiled', ...operands], env: {}, execPath: '/Applications/Phantom.app/Contents/MacOS/ashlr',
      stdout: { write: (value: string) => writes.push(value) }, exit: (code: number) => done(code) },
    Symbol, dirname, AbortController, qualify, booted: false, clearTimeout,
    setTimeout: (callback: () => void, delay: number) => { expect(delay).toBe(10_000); timeout = callback; return 1; } };
    const source = createSeaShim({ pkgVersion: '3.29.6', buildIdentityJson: '{}', desktopPairIdentityJson: pair });
    runInNewContext(source.replace("import { dirname } from 'node:path';", '')
      .replace("await import('../scripts/scorecard-history-worker.mjs');", "throw Error('unexpected worker');")
      .replace("import('../dist/core/run/desktop-metadata-launch-trust.js')", 'Promise.resolve({ qualifyDesktopMetadataLaunch: qualify })')
      .replace("await import('../dist/cli/index.js');", 'booted = true;'), context);
    return { writes, exited, context, clearTimeout, timeout: () => timeout(), pair };
  }
  it('calls only the actual metadata qualifier after embedded identity, exits with fixed scalar output and never boots CLI', async () => {
    let signal!: AbortSignal;
    const qualify = vi.fn(async (value: AbortSignal) => { signal = value; return { kind: 'signed-desktop' }; });
    const f = run([DESKTOP_METADATA_PREFLIGHT_FLAG], qualify);
    expect(await f.exited).toBe(0);
    expect(qualify).toHaveBeenCalledTimes(1); expect(signal.aborted).toBe(true);
    expect(f.writes).toEqual(['{"schemaVersion":1,"scope":"desktop-metadata-preflight","state":"pass"}\n']);
    expect(f.context.booted).toBe(false); expect(f.clearTimeout).toHaveBeenCalledWith(1);
    expect(runInNewContext("globalThis[Symbol.for('phantom.desktop-pair-build.v1')]", f.context)).toBe(f.pair);
  });
  it('refuses extra operands wherever the flag occurs before qualifier or ordinary CLI contact', async () => {
    for (const operands of [[DESKTOP_METADATA_PREFLIGHT_FLAG, 'extra'], ['--help', DESKTOP_METADATA_PREFLIGHT_FLAG]]) {
      const qualify = vi.fn(async () => { throw Error('must not contact'); }), f = run(operands, qualify);
      expect(await f.exited).toBe(126); expect(qualify).not.toHaveBeenCalled(); expect(f.context.booted).toBe(false);
      expect(f.writes).toEqual(['{"schemaVersion":1,"scope":"desktop-metadata-preflight","state":"held"}\n']);
    }
  });
  it('keeps unavailable or rejected metadata held without exporting diagnostic records or falling through', async () => {
    for (const qualify of [async () => null, async () => undefined, async () => { throw Error('private synthetic diagnostic'); }]) {
      const f = run([DESKTOP_METADATA_PREFLIGHT_FLAG], qualify);
      expect(await f.exited).toBe(126); expect(f.writes).toEqual(['{"schemaVersion":1,"scope":"desktop-metadata-preflight","state":"held"}\n']);
      expect(f.context.booted).toBe(false);
    }
  });
  it('aborts the bounded metadata-only inspection and handles a late proof rejection without CLI boot', async () => {
    let started!: () => void, reject!: (error: Error) => void, signal!: AbortSignal;
    const seen = new Promise<void>(resolve => { started = resolve; });
    const f = run([DESKTOP_METADATA_PREFLIGHT_FLAG], async value => {
      signal = value; started(); return await new Promise((_, refuse) => { reject = refuse; });
    });
    await seen; f.timeout(); expect(await f.exited).toBe(126); expect(signal.aborted).toBe(true);
    reject(Error('late synthetic proof refusal')); await Promise.resolve();
    expect(f.context.booted).toBe(false); expect(f.writes).toHaveLength(1); expect(f.clearTimeout).toHaveBeenCalledWith(1);
  });
});

describe('signed desktop source tuple', () => {
  it('embeds the independent tree identity before boot without changing existing BuildIdentity', () => {
    const identity = JSON.stringify({ schemaVersion: 1, packageVersion: '3.29.5', revision: 'a'.repeat(40), dirty: false, provenance: 'git' });
    const pair = JSON.stringify({ schemaVersion: 1, revision: 'a'.repeat(40), tree: 'b'.repeat(40), version: '3.29.5' });
    const context = { process: { argv: ['node', 'ashlr'], env: {}, execPath: '/owned/ashlr' }, Symbol, booted: false, dirname };
    const source = createSeaShim({ pkgVersion: '3.29.5', buildIdentityJson: identity, desktopPairIdentityJson: pair });
    runInNewContext(source.replace("import { dirname } from 'node:path';", '')
      .replace("await import('../scripts/scorecard-history-worker.mjs');", "throw new Error('unexpected helper');")
      .replace("await import('../dist/cli/index.js');", "if (globalThis[Symbol.for('phantom.desktop-pair-build.v1')] !== " + JSON.stringify(pair) + ") throw Error('late identity'); booted = true;"), context);
    expect(context.booted).toBe(true);
    expect(runInNewContext("globalThis[Symbol.for('ashlr.build-identity.v1')]", context)).toBe(identity);
    expect(createSeaShim({ pkgVersion: '3.29.5', buildIdentityJson: identity })).not.toContain("Symbol.for('phantom.desktop-pair-build.v1')");
  });
});

describe('fixed Claude tool worker native source closure', () => {
  it('embeds only the exact compiled worker bytes with the CLI artifact identity before boot', () => {
    const root = mkdtempSync(join(tmpdir(), 'ashlr-sea-tool-'));
    const identity = JSON.stringify({ schemaVersion: 1, packageVersion: '3.24.1', revision: 'f'.repeat(40), dirty: false, provenance: 'git' });
    const text = 'export const literal = "<script>π\\u2028";\n';
    try {
      mkdirSync(join(root, 'sandbox'));
      const path = join(root, 'sandbox', 'claude-broker-tool-worker.js');
      writeFileSync(path, text);
      writeFileSync(join(root, 'sandbox', 'unrelated.js'), 'not a tool worker');
      const raw = collectClaudeToolWorkerSource({ coreRoot: root, buildIdentityJson: identity });
      const sha256 = createHash('sha256').update(text).digest('hex');
      expect(JSON.parse(raw)).toEqual({ schemaVersion: 1, buildIdentityJson: identity, text, sha256 });
      const shim = createSeaShim({ pkgVersion: '3.24.1', buildIdentityJson: identity, claudeToolWorkerSourceJson: raw });
      expect(shim).not.toContain('<script>');
      const context = { process: { argv: ['node', 'ashlr'], env: {}, execPath: '/owned/ashlr' }, Symbol, booted: false, dirname };
      runInNewContext(shim.replace("import { dirname } from 'node:path';", '')
        .replace("await import('../scripts/scorecard-history-worker.mjs');", "throw new Error('unexpected helper');")
        .replace("await import('../dist/cli/index.js');", 'booted = true;'), context);
      expect(context.booted).toBe(true);
      const embedded = runInNewContext("globalThis[Symbol.for('ashlr.claude-tool-worker-source.v1')]", context);
      const embeddedIdentity = runInNewContext("globalThis[Symbol.for('ashlr.build-identity.v1')]", context);
      expect(embedded).toBe(raw);
      expect(embeddedClaudeToolWorkerDigest(embedded, embeddedIdentity)).toBe(sha256);
      expect(() => embeddedClaudeToolWorkerDigest(embedded, identity.replace('f'.repeat(40), 'e'.repeat(40)))).toThrow();
      writeFileSync(path, '');
      expect(() => collectClaudeToolWorkerSource({ coreRoot: root, buildIdentityJson: identity })).toThrow();
      writeFileSync(path, 'x'.repeat(128 * 1024 + 1));
      expect(() => collectClaudeToolWorkerSource({ coreRoot: root, buildIdentityJson: identity })).toThrow();
      unlinkSync(path);
      expect(() => collectClaudeToolWorkerSource({ coreRoot: root, buildIdentityJson: identity })).toThrow();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe('native safety source packaging', () => {
  it('roundtrips exactly the five build texts and binds them before the CLI boots', () => {
    const root = mkdtempSync(join(tmpdir(), 'ashlr-sea-safety-'));
    const identity = JSON.stringify({ schemaVersion: 1, revision: 'a'.repeat(40) });
    const texts = new Map<string, string>();
    try {
      expect(VERIFY_SAFETY_SOURCE_KEYS).toEqual(runtimeKeys);
      for (const key of VERIFY_SAFETY_SOURCE_KEYS) {
        const text = `// ${key}\nexport const literal = '<script>"\\\\\u2028\u2029';\n`;
        texts.set(key, text);
        const file = join(root, key + '.js');
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, text);
      }
      // A nearby unrelated source can never be included in the closed inventory.
      writeFileSync(join(root, 'unrelated.js'), 'unrelated');
      const raw = collectVerifySafetySources({ coreRoot: root, buildIdentityJson: identity });
      const shim = createSeaShim({ pkgVersion: '3.22.0', buildIdentityJson: identity, verifySafetySourcesJson: raw });
      expect(shim).not.toContain('<script>');
      const context = { process: { argv: ['node', 'ashlr'], env: {}, execPath: '/owned/ashlr' }, Symbol,
        booted: false, dirname };
      const runnable = shim.replace("import { dirname } from 'node:path';", '')
        .replace("await import('../scripts/scorecard-history-worker.mjs');", "throw new Error('unexpected helper');")
        .replace("await import('../dist/cli/index.js');", 'booted = true;');
      runInNewContext(runnable, context);
      const embedded = runInNewContext("globalThis[Symbol.for('ashlr.verify-safety-sources.v1')]", context);
      const embeddedIdentity = runInNewContext("globalThis[Symbol.for('ashlr.build-identity.v1')]", context);
      expect(context.booted).toBe(true);
      expect(embedded).toBe(raw);
      expect(embeddedIdentity).toBe(identity);
      const read = embeddedSafetySourceReader(embedded, embeddedIdentity);
      for (const [key, text] of texts) expect(read(key)).toBe(text);
      expect(() => read('unrelated')).toThrow();
      unlinkSync(join(root, 'daemon', 'loop.js'));
      expect(() => collectVerifySafetySources({ coreRoot: root, buildIdentityJson: identity })).toThrow();
      writeFileSync(join(root, 'daemon', 'loop.js'), '');
      expect(() => collectVerifySafetySources({ coreRoot: root, buildIdentityJson: identity })).toThrow('Empty native safety source');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe('Bun sidecar read-worker packaging', () => {
  it('packages only the fixed outcome metadata worker with the trusted identity', () => {
    const identity = JSON.stringify({ schemaVersion: 1, revision: 'e'.repeat(40) });
    const shim = createSeaOutcomesWorkerShim({ buildIdentityJson: identity });
    const context = { Symbol, loaded: false };
    runInNewContext(shim.replace("await import('../dist/core/verse/outcomes-worker.js');", 'loaded = true;'), context);
    expect(context.loaded).toBe(true);
    expect(runInNewContext("globalThis[Symbol.for('ashlr.build-identity.v1')]", context)).toBe(identity);
    expect(shim).not.toContain('process.env');
    expect(shim).not.toContain('workerData');
    expect(createSeaCompileArgs({ entry: '/owned/_entry.js', workerEntry: '/owned/read-projection-worker.js',
      outcomesWorkerEntry: '/owned/outcomes-worker.js', outBin: '/owned/ashlr' })).toEqual([
      'build', '--compile', '/owned/_entry.js', '/owned/read-projection-worker.js', '/owned/outcomes-worker.js', '--outfile', '/owned/ashlr',
    ]);
  });
  it('packages the independent journal reader with its trusted identity', () => {
    const identity = JSON.stringify({ schemaVersion: 1, revision: 'c'.repeat(40) });
    const shim = createSeaEngineeringReadWorkerShim({ buildIdentityJson: identity });
    expect(shim).toContain(JSON.stringify(identity));
    expect(shim).toContain("await import('../dist/core/resources/engineering-successor-read-worker.js');");
    expect(shim.indexOf('Reflect.set(')).toBeLessThan(shim.indexOf('await import('));
    expect(createSeaCompileArgs({ entry: '/owned/_entry.js', workerEntry: '/owned/read-projection-worker.js',
      engineeringWorkerEntry: '/owned/engineering-background-worker.js', engineeringReadWorkerEntry: '/owned/engineering-successor-read-worker.js',
      outBin: '/owned/ashlr' })).toEqual(['build', '--compile', '/owned/_entry.js', '/owned/read-projection-worker.js',
      '/owned/engineering-background-worker.js', '/owned/engineering-successor-read-worker.js', '--outfile', '/owned/ashlr']);
  });
  it('packages the V3.10 fleet-history worker as a sibling entrypoint with the trusted identity', () => {
    const identity = JSON.stringify({ schemaVersion: 1, revision: 'd'.repeat(40) });
    const shim = createSeaFleetHistoryWorkerShim({ buildIdentityJson: identity });
    expect(shim).toContain(JSON.stringify(identity));
    // fleet-history.ts resolves `./fleet-history-worker.js` next to the main entry.
    expect(shim).toContain("await import('../dist/core/verse/fleet-history-worker.js');");
    expect(shim.indexOf('Reflect.set(')).toBeLessThan(shim.indexOf('await import('));
    expect(shim).not.toContain('process.env');
    expect(createSeaCompileArgs({ entry: '/owned/_entry.js', workerEntry: '/owned/read-projection-worker.js',
      engineeringWorkerEntry: '/owned/engineering-background-worker.js', engineeringReadWorkerEntry: '/owned/engineering-successor-read-worker.js',
      fleetHistoryWorkerEntry: '/owned/fleet-history-worker.js', outBin: '/owned/ashlr' })).toEqual(['build', '--compile',
      '/owned/_entry.js', '/owned/read-projection-worker.js', '/owned/engineering-background-worker.js',
      '/owned/engineering-successor-read-worker.js', '/owned/fleet-history-worker.js', '--outfile', '/owned/ashlr']);
  });
  it('explicitly compiles the sibling worker entry alongside the CLI shim', () => {
    expect(createSeaCompileArgs({
      entry: '/owned/dist-bin/_entry.js',
      workerEntry: '/owned/dist-bin/read-projection-worker.js',
      outBin: '/owned/dist-bin/ashlr',
    })).toEqual([
      'build', '--compile', '/owned/dist-bin/_entry.js',
      '/owned/dist-bin/read-projection-worker.js', '--outfile', '/owned/dist-bin/ashlr',
    ]);
  });

  it('embeds the trusted identity before importing the fixed read worker', () => {
    const identity = JSON.stringify({ schemaVersion: 1, packageVersion: '3.4.0', revision: 'a'.repeat(40), dirty: false, provenance: 'git' });
    const shim = createSeaWorkerShim({ buildIdentityJson: identity });
    expect(shim).toContain("Symbol.for('ashlr.build-identity.v1')");
    expect(shim).toContain(JSON.stringify(identity));
    expect(shim).toContain("await import('../dist/core/web/read-projection-worker.js');");
    expect(shim.indexOf('Reflect.set(')).toBeLessThan(shim.indexOf('await import('));
    expect(shim).not.toContain('process.env');
  });
  it('embeds the fixed engineering worker as a sibling with the same trusted build identity', () => {
    const identity = JSON.stringify({ schemaVersion: 1, revision: 'b'.repeat(40) });
    const shim = createSeaEngineeringWorkerShim({ buildIdentityJson: identity });
    expect(shim).toContain(JSON.stringify(identity));
    expect(shim).toContain("await import('../dist/core/resources/engineering-background-worker.js');");
    expect(shim.indexOf('Reflect.set(')).toBeLessThan(shim.indexOf('await import('));
    expect(shim).not.toContain('process.env');
    expect(createSeaCompileArgs({ entry: '/owned/_entry.js', workerEntry: '/owned/read-projection-worker.js',
      engineeringWorkerEntry: '/owned/engineering-background-worker.js', outBin: '/owned/ashlr' })).toEqual([
      'build', '--compile', '/owned/_entry.js', '/owned/read-projection-worker.js', '/owned/engineering-background-worker.js',
      '--outfile', '/owned/ashlr',
    ]);
  });
});
