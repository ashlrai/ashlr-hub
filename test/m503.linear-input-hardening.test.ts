/**
 * M503 — deterministic linear-time handling for uncontrolled endpoint and PEM
 * inputs. No live network, subprocess, or user-home access.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AshlrConfig, GenomeEntry } from '../src/core/types.js';
import {
  redactPrivateKeyBlocks,
  redactPrivateKeyBlocksWithMetrics,
  stripTrailingSlashes,
  stripTrailingSlashesWithMetrics,
} from '../src/core/util/linear-input.js';

const originalHome = process.env.HOME;
const originalOllamaBaseUrl = process.env.OLLAMA_BASE_URL;

afterEach(() => {
  vi.doUnmock('node:child_process');
  vi.resetModules();
  vi.unstubAllGlobals();
  process.env.HOME = originalHome;
  if (originalOllamaBaseUrl === undefined) delete process.env.OLLAMA_BASE_URL;
  else process.env.OLLAMA_BASE_URL = originalOllamaBaseUrl;
  delete process.env.M503_FAKE_KEY;
});

describe('trailing-slash normalization', () => {
  it('preserves ordinary endpoint outputs byte-for-byte', () => {
    expect(stripTrailingSlashes('http://localhost:11434')).toBe('http://localhost:11434');
    expect(stripTrailingSlashes('http://localhost:11434/')).toBe('http://localhost:11434');
    expect(stripTrailingSlashes('http://localhost:11434////')).toBe('http://localhost:11434');
    expect(stripTrailingSlashes('/')).toBe('');
    expect(stripTrailingSlashes('')).toBe('');
  });

  it('examines each adversarial trailing slash at most once', () => {
    const slashCount = 200_000;
    const allSlashes = stripTrailingSlashesWithMetrics('/'.repeat(slashCount));
    expect(allSlashes.value).toBe('');
    expect(allSlashes.examinedOffsets).toBe(slashCount);

    const prefix = 'http://localhost:11434';
    const endpoint = stripTrailingSlashesWithMetrics(prefix + '/'.repeat(slashCount));
    expect(endpoint.value).toBe(prefix);
    expect(endpoint.examinedOffsets).toBe(slashCount + 1);
  });
});

describe('private-key PEM redaction', () => {
  it('preserves complete and truncated legacy redaction semantics', () => {
    const cases: Array<[string, string]> = [
      ['ordinary text', 'ordinary text'],
      [
        'before\n-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\nafter',
        'before\n[REDACTED]\nafter',
      ],
      [
        '-----BEGIN RSA PRIVATE KEY-----\r\nabc\r\n-----END EC PRIVATE KEY-----',
        '[REDACTED]',
      ],
      [
        '-----BEGINPRIVATE KEY-----\nbody\n-----ENDPRIVATE KEY-----',
        '[REDACTED]',
      ],
      [
        'before -----BEGIN OPENSSH PRIVATE KEY----- truncated\r\nbody remains',
        'before [REDACTED]\nbody remains',
      ],
      [
        '-----BEGIN CERTIFICATE-----\npublic\n-----END CERTIFICATE-----',
        '-----BEGIN CERTIFICATE-----\npublic\n-----END CERTIFICATE-----',
      ],
      [
        '-----BEGIN private PRIVATE KEY-----\nnot a valid marker',
        '-----BEGIN private PRIVATE KEY-----\nnot a valid marker',
      ],
      [
        '-----BEGIN PRIVATE KEY----- one -----BEGIN RSA PRIVATE KEY-----\nbody',
        '[REDACTED]\nbody',
      ],
    ];

    for (const [input, expected] of cases) {
      expect(redactPrivateKeyBlocks(input)).toBe(expected);
    }
  });

  it('keeps examined offsets linearly bounded for missing END markers', () => {
    const markerLine = '-----BEGIN RSA PRIVATE KEY----- payload\n';
    const input = markerLine.repeat(8_000);
    const result = redactPrivateKeyBlocksWithMetrics(input);

    expect(result.value).toBe('[REDACTED]\n'.repeat(8_000));
    expect(result.examinedOffsets).toBeLessThanOrEqual(input.length * 6 + 64);
  });

  it('keeps examined offsets linearly bounded for invalid marker candidates', () => {
    const input = ('-----BEGIN' + 'A'.repeat(96) + '!').repeat(4_000);
    const result = redactPrivateKeyBlocksWithMetrics(input);

    expect(result.value).toBe(input);
    expect(result.examinedOffsets).toBeLessThanOrEqual(input.length * 3 + 64);
  });
});

describe('uncontrolled endpoint integrations', () => {
  it('normalizes provider probe URLs with a bounded slash scan', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ models: [{ name: 'qwen' }] }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const { probeEndpoint } = await import('../src/core/providers.js');
    const prefix = 'http://localhost:11434';
    const result = await probeEndpoint('ollama', prefix + '/'.repeat(100_000));

    expect(result.url).toBe(`${prefix}/api/tags`);
    expect(fetchMock).toHaveBeenCalledWith(`${prefix}/api/tags`, expect.any(Object));
  });

  it('normalizes api-model readiness probe URLs with the same helper', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ data: [] }),
    });
    vi.stubGlobal('fetch', fetchMock);
    process.env.M503_FAKE_KEY = 'synthetic-value';

    const { probeApiModelEngine } = await import('../src/core/providers.js');
    const prefix = 'https://provider.invalid';
    const result = await probeApiModelEngine('m503', {
      envKey: 'M503_FAKE_KEY',
      defaultBaseUrl: prefix + '/'.repeat(100_000),
    });

    expect(result.reachable).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(`${prefix}/v1/models`, expect.any(Object));
  });

  it('normalizes both genome Ollama request paths', async () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-m503-recall-'));
    process.env.HOME = tmpHome;
    try {
      const entry: GenomeEntry = {
        id: 'm503-entry',
        project: null,
        source: 'hub',
        title: 'TypeScript',
        text: 'TypeScript input hardening',
        tags: [],
        ts: '2026-08-10T00:00:00.000Z',
      };
      const storeDir = path.join(tmpHome, '.ashlr', 'genome');
      fs.mkdirSync(storeDir, { recursive: true });
      fs.writeFileSync(path.join(storeDir, 'hub.jsonl'), `${JSON.stringify(entry)}\n`);

      const seenUrls: string[] = [];
      vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string) => {
        seenUrls.push(String(url));
        if (String(url).endsWith('/api/tags')) {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: async () => ({ models: [{ name: 'nomic-embed-text' }] }),
          });
        }
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ embedding: [1, 0] }),
        });
      }));

      const prefix = 'http://localhost:11434';
      const cfg = {
        version: 1,
        roots: [],
        editor: 'cursor',
        staleDays: 30,
        categories: {},
        tidyRules: [],
        keepers: [],
        models: {
          lmstudio: '',
          ollama: prefix + '/'.repeat(100_000),
          providerChain: ['ollama'],
        },
        telemetry: {},
        tools: {},
      } satisfies AshlrConfig;

      const { recall } = await import('../src/core/genome/recall.js');
      await recall('typescript', cfg, { embeddings: true });

      expect(seenUrls.length).toBeGreaterThanOrEqual(2);
      expect(seenUrls.every((url) =>
        url === `${prefix}/api/tags` || url === `${prefix}/api/embeddings`
      )).toBe(true);
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  it('normalizes the engine api-model probe URL before child launch', async () => {
    const calls: string[][] = [];
    vi.doMock('node:child_process', async () => {
      const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
      return {
        ...actual,
        spawnSync: (_cmd: string, args?: string[]) => {
          calls.push(args ?? []);
          return { status: 0, stdout: '', stderr: '', pid: 1, output: [] };
        },
      };
    });
    const prefix = 'http://localhost:11434/v1';
    process.env.OLLAMA_BASE_URL = prefix + '/'.repeat(100_000);

    const { engineInstalled } = await import('../src/core/run/engines.js');
    expect(engineInstalled('local-coder')).toBe(true);

    const inlineProbe = calls.flat().find((arg) => arg.includes("const h=require('http')"));
    expect(inlineProbe).toContain(`${prefix}/models`);
    expect(inlineProbe).not.toContain(`${prefix}//models`);
  });

  it('removes the five CodeQL-alerted backtracking expressions', () => {
    const sourcePaths = [
      'src/core/genome/recall.ts',
      'src/core/providers.ts',
      'src/core/run/engines.ts',
      'src/core/util/scrub.ts',
      'src/core/genome/capture.ts',
    ];
    const vulnerableSlashSource = String.raw`replace(/\/+$/, '')`;
    const vulnerablePemSource = String.raw`[\s\S]*?-----END`;

    for (const sourcePath of sourcePaths) {
      const source = fs.readFileSync(path.join(process.cwd(), sourcePath), 'utf8');
      expect(source).not.toContain(vulnerableSlashSource);
      expect(source).not.toContain(vulnerablePemSource);
    }
  });
});
