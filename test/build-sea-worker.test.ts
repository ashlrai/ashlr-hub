import { mkdtempSync, mkdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import {
  createSeaCompileArgs,
  createSeaWorkerShim,
  createSeaEngineeringWorkerShim,
  createSeaEngineeringReadWorkerShim,
  createSeaFleetHistoryWorkerShim,
  createSeaOutcomesWorkerShim,
  createSeaShim, collectVerifySafetySources, VERIFY_SAFETY_SOURCE_KEYS,
} from '../scripts/build-sea.mjs';
import { embeddedSafetySourceReader, VERIFY_SAFETY_SOURCE_KEYS as runtimeKeys } from '../src/cli/verify-safety-sources.js';

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
