/** Real SDK subprocess qualification against an inert local protocol fixture only. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { copyFileSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import { probeServer } from '../src/core/mcp-gateway.js';
import { runInLocusJobEnv } from '../src/core/integrations/locus-job-env.js';

vi.mock('../src/core/config.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/core/config.js')>(),
  loadConfig: () => ({ models: {}, roots: [] }),
}));
const roots: string[] = [];
function fixture() {
  // Neutral path avoids the existing conservative secret-token argv guard's
  // refusal of checkout folder names containing the literal substring `sk-`.
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'phm-mcp-fixture-')));
  roots.push(root);
  const file = join(root, 'server.mjs');
  copyFileSync(fileURLToPath(new URL('./fixtures/mock-mcp-server.mjs', import.meta.url)), file);
  return { root, spec: { name: 'synthetic-fixture', command: process.execPath, args: [file], source: 'test' } };
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('real synthetic MCP probe transport', () => {
  it('initializes, lists and closes a local protocol fixture with the real SDK', async () => {
    const { spec } = fixture();
    expect(await probeServer(spec, 1_000)).toEqual({ name: spec.name, ok: true, toolCount: 2, tools: ['ping', 'echo'] });
  });

  it('permits a one-off sealed job probe but refuses final configured identity replacement', async () => {
    const { root, spec } = fixture();
    await runInLocusJobEnv({ HOME: root, USERPROFILE: root, LOCUS_HOME: join(root, 'state'),
      LOCUS_BINDING: 'synthetic-binding', LOCUS_EXECUTOR_CAPABILITY: 'synthetic-executor' }, async () => {
      expect((await probeServer(spec, 1_000)).ok).toBe(true);
      const refused = await probeServer({ ...spec, env: { LOCUS_BINDING: 'another-binding' } }, 1_000);
      expect(refused.ok).toBe(false);
      expect(refused.error).toContain('identity override refused');
      expect(refused.tools).toEqual([]);
    });
  });
});
