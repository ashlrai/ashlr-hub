import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  locateVisualTargets,
  parseLocateAnythingBoxes,
  resolveVisualGroundingConfig,
  type VisualGroundingResult,
} from '../src/core/visual/grounding.js';
import type { AshlrConfig } from '../src/core/types.js';

const tmpRoots: string[] = [];

afterEach(() => {
  for (const dir of tmpRoots.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});

function tmpImage(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ashlr-visual-'));
  tmpRoots.push(dir);
  const imagePath = join(dir, 'shot.png');
  writeFileSync(imagePath, Buffer.from('89504e470d0a1a0a', 'hex'));
  return imagePath;
}

function cfg(foundry: NonNullable<AshlrConfig['foundry']>): Pick<AshlrConfig, 'foundry'> {
  return { foundry };
}

describe('visual grounding parser', () => {
  it('parses LocateAnything-style XML boxes and normalizes to [0,1000]', () => {
    const boxes = parseLocateAnythingBoxes('<box><x1>10</x1><y1>20</y1><x2>300</x2><y2>420</y2></box>');
    expect(boxes).toEqual([
      expect.objectContaining({ x1: 10, y1: 20, x2: 300, y2: 420, scale: 'normalized-1000' }),
    ]);
  });

  it('parses JSON boxes with labels/confidence', () => {
    const boxes = parseLocateAnythingBoxes(JSON.stringify({
      boxes: [{ label: 'settings button', x1: 0.1, y1: 0.2, x2: 0.3, y2: 0.4, confidence: 0.91 }],
    }));
    expect(boxes).toEqual([
      expect.objectContaining({
        label: 'settings button',
        confidence: 0.91,
        x1: 100,
        y1: 200,
        x2: 300,
        y2: 400,
      }),
    ]);
  });

  it('deduplicates bracket and tag echoes', () => {
    const boxes = parseLocateAnythingBoxes('[10, 20, 30, 40]\n<box>10,20,30,40</box>');
    expect(boxes).toHaveLength(1);
  });
});

describe('visual grounding config gates', () => {
  it('defaults to disabled and never calls a provider', async () => {
    const fetch = vi.fn();
    const result = await locateVisualTargets({ imagePath: tmpImage(), query: 'Find deploy button' }, {}, { fetch });
    expect(result).toEqual(expect.objectContaining({
      ok: true,
      skipped: true,
      provider: 'disabled',
    }));
    expect(fetch).not.toHaveBeenCalled();
  });

  it('blocks LocateAnything until the non-commercial license risk is acknowledged', async () => {
    const resolved = resolveVisualGroundingConfig(cfg({
      visualGrounding: {
        enabled: true,
        provider: 'locateanything-http',
        endpoint: 'http://127.0.0.1:8000',
      },
    }));
    expect(resolved.blockedReason).toMatch(/non-commercial/i);

    const result = await locateVisualTargets(
      { imagePath: tmpImage(), query: 'Find the retry button' },
      cfg({
        visualGrounding: {
          enabled: true,
          provider: 'locateanything-http',
          endpoint: 'http://127.0.0.1:8000',
        },
      }),
    );
    expect(result).toEqual(expect.objectContaining({ ok: false, skipped: true, blocked: true }));
  });

  it('blocks remote endpoints unless explicitly allowed', () => {
    const resolved = resolveVisualGroundingConfig(cfg({
      visualGrounding: {
        enabled: true,
        provider: 'generic-openai-vision',
        endpoint: 'https://example.com/v1',
      },
    }));
    expect(resolved.blockedReason).toMatch(/not loopback/i);
  });

  it('calls a configured loopback OpenAI-compatible worker and scrubs image payloads', async () => {
    const fetch = vi.fn(async (_url: string, init: { body: string }) => {
      expect(_url).toBe('http://127.0.0.1:8000/v1/chat/completions');
      expect(init.body).toContain('data:image/png;base64,');
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          choices: [
            {
              message: {
                content: '{"boxes":[{"label":"deploy","x1":100,"y1":200,"x2":300,"y2":350,"confidence":0.8}]}',
              },
            },
          ],
        }),
      };
    });

    const result: VisualGroundingResult = await locateVisualTargets(
      { imagePath: tmpImage(), query: 'Find deploy button', purpose: 'browser-verify' },
      cfg({
        visualGrounding: {
          enabled: true,
          provider: 'generic-openai-vision',
          endpoint: 'http://127.0.0.1:8000',
        },
      }),
      { fetch },
    );

    expect(result.ok).toBe(true);
    expect(result.boxes).toEqual([
      expect.objectContaining({ label: 'deploy', x1: 100, y1: 200, x2: 300, y2: 350 }),
    ]);
    expect(result.image?.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(result.rawText).not.toContain('base64,');
  });
});
