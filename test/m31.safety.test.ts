/**
 * M31 — HARD SAFETY INVARIANTS for the native MCP tool surface.
 *
 * The H-style adversarial lens for CONTRACT-M31:
 *   1. No approval path: no native tool can approve/reject/apply anything.
 *   2. Kill switch gates all writes; reads still answer.
 *   3. allowCloud is unreachable from the native surface.
 *   4. ashlr_learn is append-only and hub-only (never a repo working tree).
 *   5. No secrets in tool output or audit lines.
 *   6. Every call (ok / refused / error) is audited.
 *
 * Hermetic: tmp HOME per test (h1-fixture); no real ~/.ashlr, no network.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync, readdirSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { makeFixture, type H1Fixture } from './helpers/h1-fixture.js';
import { nativeToolDefs, callNativeTool } from '../src/core/mcp-native.js';
import { hubStorePath } from '../src/core/genome/store.js';
import { listProposals } from '../src/core/inbox/store.js';

let fx: H1Fixture;

beforeEach(() => {
  expect.hasAssertions();
  fx = makeFixture();
});

afterEach(() => {
  fx.cleanup();
});

function resultText(r: { content: { type: 'text'; text: string }[] }): string {
  return r.content.map((c) => c.text).join('\n');
}

/** Read every audit line written under the tmp HOME. */
function readAuditLines(): string[] {
  const dir = join(fx.ashlrDir, 'audit');
  if (!existsSync(dir)) return [];
  const lines: string[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.jsonl')) continue;
    lines.push(...readFileSync(join(dir, f), 'utf8').split('\n').filter((l) => l.trim()));
  }
  return lines;
}

function hubLineCount(): number {
  const p = hubStorePath();
  if (!existsSync(p)) return 0;
  return readFileSync(p, 'utf8').split('\n').filter((l) => l.trim()).length;
}

// ---------------------------------------------------------------------------
// 1. No approval path
// ---------------------------------------------------------------------------

describe('invariant 1 — no approval path', () => {
  it('no native tool name matches approve/reject/apply', () => {
    for (const t of nativeToolDefs()) {
      expect(t.name).not.toMatch(/approve|reject|apply/i);
    }
  });

  it('ashlr_inbox_propose creates a PENDING proposal and nothing else', async () => {
    const r = await callNativeTool('ashlr_inbox_propose', {
      kind: 'note',
      title: 'test proposal',
      summary: 'created by m31 safety test',
    });
    expect(r.isError).toBeUndefined();
    const proposals = listProposals();
    expect(proposals).toHaveLength(1);
    expect(proposals[0]!.status).toBe('pending');
    expect(proposals[0]!.origin).toBe('agent');
  });

  it('the deploy kind is rejected at the schema gate', async () => {
    const r = await callNativeTool('ashlr_inbox_propose', {
      kind: 'deploy',
      title: 'x',
      summary: 'y',
    });
    expect(r.isError).toBe(true);
    expect(listProposals()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 2. Kill switch
// ---------------------------------------------------------------------------

describe('invariant 2 — kill switch gates writes, not reads', () => {
  it('refuses ashlr_learn and ashlr_inbox_propose when KILL is on', async () => {
    fx.setKill(true);

    const learn = await callNativeTool('ashlr_learn', { text: 'should not persist' });
    expect(learn.isError).toBe(true);
    expect(resultText(learn)).toContain('kill switch');
    expect(hubLineCount()).toBe(0);

    const propose = await callNativeTool('ashlr_inbox_propose', {
      kind: 'note',
      title: 'x',
      summary: 'y',
    });
    expect(propose.isError).toBe(true);
    expect(listProposals()).toHaveLength(0);
  });

  it('read tools still answer with KILL on', async () => {
    fx.setKill(true);
    const r = await callNativeTool('ashlr_recall', { query: 'anything' });
    expect(r.isError).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 3. allowCloud unreachable
// ---------------------------------------------------------------------------

describe('invariant 3 — allowCloud unreachable from the native surface', () => {
  it('no tool schema accepts a cloud flag', () => {
    for (const t of nativeToolDefs()) {
      const props = (t.inputSchema as { properties?: Record<string, unknown> }).properties ?? {};
      for (const key of Object.keys(props)) {
        expect(key.toLowerCase()).not.toContain('cloud');
      }
    }
  });

  it('mcp-native.ts hardcodes allowCloud: false in the ask handler', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(resolve(here, '..', 'src/core/mcp-native.ts'), 'utf8');
    expect(src).toContain('allowCloud: false');
    expect(src).not.toContain('allowCloud: true');
  });
});

// ---------------------------------------------------------------------------
// 4. Append-only, hub-only learning
// ---------------------------------------------------------------------------

describe('invariant 4 — ashlr_learn is append-only + hub-only', () => {
  it('grows hub.jsonl by exactly one line per call, never rewrites prior lines', async () => {
    const r1 = await callNativeTool('ashlr_learn', { text: 'first learning' });
    expect(r1.isError).toBeUndefined();
    expect(hubLineCount()).toBe(1);
    const firstLine = readFileSync(hubStorePath(), 'utf8').split('\n')[0];

    const r2 = await callNativeTool('ashlr_learn', { text: 'second learning' });
    expect(r2.isError).toBeUndefined();
    expect(hubLineCount()).toBe(2);
    // Prior line byte-identical (append-only).
    expect(readFileSync(hubStorePath(), 'utf8').split('\n')[0]).toBe(firstLine);
  });

  it('forces hubOnly — a project-scoped learn writes nothing outside ~/.ashlr', async () => {
    const repo = fx.makeRepo();
    const r = await callNativeTool('ashlr_learn', {
      text: 'project-scoped learning',
      project: repo.dir,
    });
    expect(r.isError).toBeUndefined();
    // No genome note dropped into the repo working tree.
    expect(existsSync(join(repo.dir, '.ashlrcode'))).toBe(false);
    expect(hubLineCount()).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 5. No secrets out (scrub parity: output + audit)
// ---------------------------------------------------------------------------

describe('invariant 5 — secrets never leave through the native surface', () => {
  it('secret-shaped tokens in stored content come back [REDACTED] in tool output', async () => {
    const dir = join(fx.ashlrDir, 'genome');
    mkdirSync(dir, { recursive: true });
    const entry = {
      id: 'secret-test',
      project: null,
      source: 'hub',
      title: 'leaked secret fixture',
      text: 'api key is sk-abcdefghijklmnopqrstuvwx1234567890ABCDEF and more',
      tags: [],
      ts: new Date().toISOString(),
    };
    writeFileSync(join(dir, 'hub.jsonl'), JSON.stringify(entry) + '\n');

    const r = await callNativeTool('ashlr_recall', { query: 'leaked secret fixture' });
    const text = resultText(r);
    expect(text).not.toContain('sk-abcdefghijklmnopqrstuvwx1234567890ABCDEF');
    expect(text).toContain('[REDACTED]');
  });

  it('audit lines for native calls carry arg KEYS only, never values', async () => {
    await callNativeTool('ashlr_recall', {
      query: 'token ghp_AAAABBBBCCCCDDDDEEEEFFFF11112222',
    });
    const lines = readAuditLines().filter((l) => l.includes('mcp:native-call'));
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line).not.toContain('ghp_AAAABBBBCCCCDDDDEEEEFFFF11112222');
      expect(line).toContain('keys=');
    }
  });
});

// ---------------------------------------------------------------------------
// 6. Audit completeness
// ---------------------------------------------------------------------------

describe('invariant 6 — every call audited (ok / refused / error)', () => {
  it('audits ok, refused, and error outcomes as mcp:native-call', async () => {
    await callNativeTool('ashlr_recall', { query: 'x' });            // ok
    fx.setKill(true);
    await callNativeTool('ashlr_learn', { text: 'refused write' });  // refused
    fx.setKill(false);
    await callNativeTool('ashlr_recall', {});                        // error (missing arg)

    const entries = readAuditLines()
      .map((l) => JSON.parse(l) as { action: string; result: string })
      .filter((e) => e.action === 'mcp:native-call');

    const results = entries.map((e) => e.result);
    expect(results).toContain('ok');
    expect(results).toContain('refused');
    expect(results).toContain('error');
    expect(entries.length).toBeGreaterThanOrEqual(3);
  });
});
