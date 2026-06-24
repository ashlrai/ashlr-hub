/**
 * M31 — native MCP tool registry (src/core/mcp-native.ts).
 *
 * Hermetic: every test runs under an isolated tmp HOME (h1-fixture); no real
 * ~/.ashlr is ever touched, no network, no downstream MCP servers.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { makeFixture, type H1Fixture } from './helpers/h1-fixture.js';
import {
  nativeToolDefs,
  listNativeTools,
  isNativeTool,
  callNativeTool,
  renderToolText,
} from '../src/core/mcp-native.js';

let fx: H1Fixture;

beforeEach(() => {
  expect.hasAssertions();
  fx = makeFixture();
});

afterEach(() => {
  fx.cleanup();
});

/** Seed one genome hub entry under the tmp HOME. */
function seedHubEntry(title: string, text: string): void {
  const dir = join(fx.ashlrDir, 'genome');
  mkdirSync(dir, { recursive: true });
  const entry = {
    id: `test-${title}`,
    project: null,
    source: 'hub',
    title,
    text,
    tags: ['test'],
    ts: new Date().toISOString(),
  };
  writeFileSync(join(dir, 'hub.jsonl'), JSON.stringify(entry) + '\n', { flag: 'a' });
}

function resultText(r: { content: { type: 'text'; text: string }[] }): string {
  return r.content.map((c) => c.text).join('\n');
}

// ---------------------------------------------------------------------------
// Registry shape
// ---------------------------------------------------------------------------

describe('native tool registry', () => {
  it('exposes exactly the 13 contracted tools', () => {
    const names = nativeToolDefs().map((t) => t.name).sort();
    expect(names).toEqual(
      [
        'ashlr_ask',
        'ashlr_backlog',
        'ashlr_browser_task',
        'ashlr_desktop_open',
        'ashlr_health',
        'ashlr_impact',
        'ashlr_inbox_list',
        'ashlr_inbox_propose',
        'ashlr_learn',
        'ashlr_orient',
        'ashlr_pulse',
        'ashlr_recall',
        'ashlr_status',
      ].sort(),
    );
  });

  it('every tool has a valid object inputSchema and a safety class', () => {
    for (const t of nativeToolDefs()) {
      expect(t.description.length).toBeGreaterThan(20);
      expect((t.inputSchema as { type?: string }).type).toBe('object');
      expect(['read', 'append', 'proposal']).toContain(t.safety);
    }
  });

  it('listNativeTools returns the tools/list projection (no safety/handler)', () => {
    const listed = listNativeTools();
    expect(listed).toHaveLength(nativeToolDefs().length);
    for (const t of listed) {
      expect(Object.keys(t).sort()).toEqual(['description', 'inputSchema', 'name']);
    }
  });

  it('isNativeTool distinguishes native names from downstream-namespaced ones', () => {
    expect(isNativeTool('ashlr_recall')).toBe(true);
    expect(isNativeTool('someserver__sometool')).toBe(false);
    expect(isNativeTool('ashlr__recall')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// callNativeTool — pipeline behavior
// ---------------------------------------------------------------------------

describe('callNativeTool', () => {
  it('never throws on an unknown tool — returns isError content', async () => {
    const r = await callNativeTool('ashlr_nope', {});
    expect(r.isError).toBe(true);
    expect(resultText(r)).toContain('Unknown native tool');
  });

  it('rejects missing required args with isError (no throw)', async () => {
    const r = await callNativeTool('ashlr_recall', {});
    expect(r.isError).toBe(true);
    expect(resultText(r)).toContain('missing required argument "query"');
  });

  it('rejects wrong-typed args', async () => {
    const r = await callNativeTool('ashlr_recall', { query: 'x', limit: 'five' });
    expect(r.isError).toBe(true);
    expect(resultText(r)).toContain('"limit" must be a number');
  });

  it('rejects enum violations', async () => {
    const r = await callNativeTool('ashlr_pulse', { window: '90d' });
    expect(r.isError).toBe(true);
    expect(resultText(r)).toContain('must be one of');
  });

  it('ashlr_recall round-trips against a seeded hub store', async () => {
    seedHubEntry('NodeNext ESM convention', 'ashlr-hub uses NodeNext ESM with .js import specifiers');
    const r = await callNativeTool('ashlr_recall', { query: 'NodeNext ESM convention' });
    expect(r.isError).toBeUndefined();
    const hits = JSON.parse(resultText(r)) as { title: string }[];
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.title).toBe('NodeNext ESM convention');
  });

  it('ashlr_backlog with no persisted backlog returns a helpful note, not an error', async () => {
    const r = await callNativeTool('ashlr_backlog', {});
    expect(r.isError).toBeUndefined();
    expect(resultText(r)).toContain('ashlr backlog refresh');
  });

  it('ashlr_orient returns a valid OrientResult on empty stores', async () => {
    const r = await callNativeTool('ashlr_orient', {});
    expect(r.isError).toBeUndefined();
    const o = JSON.parse(resultText(r)) as Record<string, unknown>;
    expect(o['generatedAt']).toBeTruthy();
    expect(Array.isArray(o['genomeHits'])).toBe(true);
    expect(Array.isArray(o['backlogItems'])).toBe(true);
    expect(typeof o['pendingProposals']).toBe('number');
  });

  it('caps oversized output with a visible truncation marker', () => {
    // Spaced prose so the scrubber's long-token patterns don't fire first.
    const text = renderToolText({ blob: 'lorem ipsum dolor sit amet '.repeat(5_000) });
    expect(text.length).toBeLessThanOrEqual(33 * 1024);
    expect(text).toContain('[ashlr: output truncated]');
  });
});

// ---------------------------------------------------------------------------
// SDK confinement (CONTRACT-M31 invariant 8)
// ---------------------------------------------------------------------------

describe('SDK confinement', () => {
  it('mcp-native.ts and orient.ts never import @modelcontextprotocol/sdk', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const root = resolve(here, '..');
    for (const rel of ['src/core/mcp-native.ts', 'src/core/orient.ts']) {
      const p = join(root, rel);
      expect(existsSync(p)).toBe(true);
      // Import statements only — prose mentions in comments are fine.
      expect(readFileSync(p, 'utf8')).not.toMatch(/from\s+['"]@modelcontextprotocol\/sdk/);
    }
  });
});
