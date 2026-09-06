import { describe, expect, it } from 'vitest';
import { createSeaCompileArgs, createSeaWorkerShim } from '../scripts/build-sea.mjs';

describe('Bun sidecar read-worker packaging', () => {
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
});
