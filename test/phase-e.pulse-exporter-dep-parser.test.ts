/**
 * test/phase-e.pulse-exporter-dep-parser.test.ts — Phase E (Pulse Map fleet bridge).
 *
 * Focused unit tests for the two LOCAL Phase E modules under
 * src/core/integrations/:
 *
 *   1. pulse-exporter.ts — assert buildFleetPayload() / buildDepPayload()
 *      produce a correctly-shaped OTLP span carrying source 'ashlr-fleet'
 *      (via ashlr.source) and the ashlr.fleet.* attribute set the Pulse
 *      ingest understands.
 *
 *   2. dep-parser.ts — assert parseRepoDeps() emits a canonical
 *      `depends_on` edge list from a sample package.json manifest, and
 *      (PRIVACY FLOOR) that NO file contents / lockfile bytes / source leak
 *      into the returned edges.
 *
 * Pure / hermetic: span builders are pure (no network), and the dep parser
 * reads a temp package.json in os.tmpdir(). NO real network calls.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  buildFleetPayload,
  buildDepPayload,
  type FleetSpanInput,
  type PulseExporterConfig,
  type OtlpPayload,
} from '../src/core/integrations/pulse-exporter.js';

import {
  parseRepoDeps,
  type DepEdge,
} from '../src/core/integrations/dep-parser.js';

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** Pull the single scopeSpans block out of an OTLP payload (defensive). */
function onlySpans(payload: OtlpPayload) {
  const rs = payload.resourceSpans[0];
  expect(rs, 'resourceSpans[0] should exist').toBeTruthy();
  const ss = rs.scopeSpans[0];
  expect(ss, 'scopeSpans[0] should exist').toBeTruthy();
  return { resource: rs.resource, scope: ss.scope, spans: ss.spans };
}

/** Index a span's attributes by key → stringValue (ignores intValue here). */
function strAttrs(attrs: Array<{ key: string; value: unknown }>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const a of attrs) {
    const v = a.value as { stringValue?: string };
    if (typeof v.stringValue === 'string') out[a.key] = v.stringValue;
  }
  return out;
}

const CFG: PulseExporterConfig = {
  pulse: { enabled: true, endpoint: 'http://localhost:3000' },
  user: { id: 'mason', name: 'Mason' },
};

// ===========================================================================
// 1. pulse-exporter.ts — OTLP span shape
// ===========================================================================

describe('pulse-exporter: buildFleetPayload — OTLP span shape', () => {
  it('emits source ashlr-fleet + the ashlr.fleet.* attribute set on a fleet event', () => {
    const events: FleetSpanInput[] = [
      {
        event: 'proposal',
        refId: 'prop-123',
        outcome: 'applied',
        repo: 'AshlrAI/ashlr-hub',
        engine: 'claude',
        startTs: '2026-06-25T00:00:00.000Z',
      },
    ];

    const payload = buildFleetPayload(events, CFG);
    const { scope, resource, spans } = onlySpans(payload);

    // Scope identifies the fleet emitter as the OTLP source.
    expect(scope.name).toBe('ashlr-fleet');
    expect(typeof scope.version).toBe('string');

    // Resource service.name is the fleet source too.
    const resAttrs = strAttrs(resource.attributes);
    expect(resAttrs['service.name']).toBe('ashlr-fleet');

    // Exactly one span for one event.
    expect(spans).toHaveLength(1);
    const span = spans[0];

    // Wire-shape invariants: hex ids, span kind CLIENT(3), nano timestamps.
    expect(span.name).toBe('fleet.proposal');
    expect(span.kind).toBe(3);
    expect(span.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(span.spanId).toMatch(/^[0-9a-f]{16}$/);
    expect(span.startTimeUnixNano).toMatch(/^\d+$/);
    expect(span.endTimeUnixNano).toMatch(/^\d+$/);
    // 2026-06-25T00:00:00Z → ms * 1e6.
    expect(span.startTimeUnixNano).toBe(String(Date.parse('2026-06-25T00:00:00.000Z') * 1_000_000));

    // The ashlr.fleet.* attribute set the Pulse ingest understands.
    const attrs = strAttrs(span.attributes);
    expect(attrs['ashlr.source']).toBe('ashlr-fleet');
    expect(attrs['ashlr.fleet.event']).toBe('proposal');
    expect(attrs['ashlr.fleet.outcome']).toBe('applied');
    expect(attrs['ashlr.fleet.ref_id']).toBe('prop-123');
    expect(attrs['ashlr.fleet.repo']).toBe('AshlrAI/ashlr-hub');
    // owner is carried from cfg.user for team attribution.
    expect(attrs['ashlr.fleet.owner']).toBe('mason');
    // claude.repo.name lets the cloud resolve a repo node directly.
    expect(attrs['claude.repo.name']).toBe('AshlrAI/ashlr-hub');
    // engine flows to gen_ai.system.
    expect(attrs['gen_ai.system']).toBe('claude');
  });

  it('derives a DETERMINISTIC spanId for the same (refId, event)', () => {
    const ev: FleetSpanInput = { event: 'tick', refId: 'same-ref', outcome: 'ok' };
    const a = onlySpans(buildFleetPayload([ev], CFG)).spans[0];
    const b = onlySpans(buildFleetPayload([ev], CFG)).spans[0];
    expect(a.spanId).toBe(b.spanId);
    expect(a.traceId).toBe(b.traceId);

    // A different event kind yields a different span id.
    const c = onlySpans(
      buildFleetPayload([{ ...ev, event: 'merge' }], CFG),
    ).spans[0];
    expect(c.spanId).not.toBe(a.spanId);
  });

  it('buildDepPayload encodes a dep edge as a fleet.deps span (metadata only)', () => {
    const edge: DepEdge = {
      src: 'repo:AshlrAI/ashlr-hub',
      dst: 'package:npm:react',
      kind: 'depends_on',
      ecosystem: 'npm',
      name: 'react',
      depKind: 'prod',
      range: '^18.2.0',
    };

    const payload = buildDepPayload('AshlrAI/ashlr-hub', [edge], CFG);
    const { spans } = onlySpans(payload);
    expect(spans).toHaveLength(1);
    const span = spans[0];
    expect(span.name).toBe('fleet.deps');

    const attrs = strAttrs(span.attributes);
    expect(attrs['ashlr.source']).toBe('ashlr-fleet');
    expect(attrs['ashlr.fleet.event']).toBe('deps');
    expect(attrs['ashlr.dep.src']).toBe('repo:AshlrAI/ashlr-hub');
    expect(attrs['ashlr.dep.dst']).toBe('package:npm:react');
    expect(attrs['ashlr.dep.kind']).toBe('depends_on');
    expect(attrs['ashlr.dep.ecosystem']).toBe('npm');
    expect(attrs['ashlr.dep.name']).toBe('react');
    expect(attrs['ashlr.dep.dep_kind']).toBe('prod');
    expect(attrs['ashlr.dep.range']).toBe('^18.2.0');
  });
});

// ===========================================================================
// 2. dep-parser.ts — depends_on edge list + privacy floor
// ===========================================================================

describe('dep-parser: parseRepoDeps — depends_on edge list (no content leak)', () => {
  let dir = '';

  // A sample manifest that ALSO carries free-text fields (scripts, author,
  // description) we must NEVER leak into the edge list.
  const SECRET_SCRIPT = 'echo SUPER-SECRET-BUILD-STEP';
  const SECRET_DESC = 'this description must not leak into any edge';

  const SAMPLE_PKG = {
    name: 'sample-app',
    version: '1.0.0',
    description: SECRET_DESC,
    author: 'someone@example.com',
    scripts: { build: SECRET_SCRIPT, test: 'vitest run' },
    dependencies: { react: '^18.2.0', '@scope/pkg': '~2.0.0' },
    devDependencies: { vitest: '^2.0.0' },
    peerDependencies: { 'react-dom': '^18.0.0' },
    optionalDependencies: { fsevents: '*' },
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'phase-e-dep-'));
    writeFileSync(join(dir, 'package.json'), JSON.stringify(SAMPLE_PKG, null, 2), 'utf8');
  });

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('emits a canonical depends_on edge for every declared dependency kind', () => {
    const result = parseRepoDeps(dir, 'AshlrAI/ashlr-hub');

    expect(result.repoRef).toBe('AshlrAI/ashlr-hub');
    expect(result.manifests).toContain('package.json');

    // Every edge is canonical: source repo node, depends_on, npm package node.
    for (const e of result.edges) {
      expect(e.kind).toBe('depends_on');
      expect(e.src).toBe('repo:AshlrAI/ashlr-hub');
      expect(e.ecosystem).toBe('npm');
      expect(e.dst).toBe(`package:npm:${e.name}`);
    }

    // Index by name → edge for assertions.
    const byName = new Map(result.edges.map((e) => [e.name, e]));

    expect(byName.get('react')?.depKind).toBe('prod');
    expect(byName.get('react')?.range).toBe('^18.2.0');
    expect(byName.get('@scope/pkg')?.dst).toBe('package:npm:@scope/pkg');
    expect(byName.get('vitest')?.depKind).toBe('dev');
    expect(byName.get('react-dom')?.depKind).toBe('peer');
    expect(byName.get('fsevents')?.depKind).toBe('optional');

    // All four declared kinds are represented.
    const kinds = new Set(result.edges.map((e) => e.depKind));
    expect(kinds).toEqual(new Set(['prod', 'dev', 'peer', 'optional']));
  });

  it('NEVER leaks manifest free-text (scripts/description/author) into edges', () => {
    const result = parseRepoDeps(dir, 'AshlrAI/ashlr-hub');

    // Serialize the ENTIRE returned shape and assert no secret substring appears.
    const blob = JSON.stringify(result);
    expect(blob).not.toContain(SECRET_SCRIPT);
    expect(blob).not.toContain(SECRET_DESC);
    expect(blob).not.toContain('someone@example.com');

    // Defensive per-edge field check: only the allowed metadata keys exist.
    const allowed = new Set(['src', 'dst', 'kind', 'ecosystem', 'name', 'depKind', 'range']);
    for (const e of result.edges) {
      for (const k of Object.keys(e)) {
        expect(allowed.has(k), `unexpected edge field "${k}" could leak content`).toBe(true);
      }
    }
  });

  it('degrades to an empty edge list (no throw) when package.json is absent', () => {
    const empty = mkdtempSync(join(tmpdir(), 'phase-e-empty-'));
    try {
      const result = parseRepoDeps(empty, 'AshlrAI/empty');
      expect(result.edges).toEqual([]);
      expect(result.manifests).not.toContain('package.json');
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});
