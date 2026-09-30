import { describe, expect, it } from 'vitest';
import {
  addReportedTool, cachedReportedTool, emptyResourceEvidence, MAX_RESOURCE_CACHE,
  MAX_RESOURCE_CALLS, MAX_RESOURCE_GROUPS, MAX_RESOURCE_SOURCES, reportedTool,
  setResourceContext, type ResourceEvidenceCacheEntry,
} from './turn-resource-evidence.js';

const done = { pending: false, failed: false };

describe('reported tools and context evidence', () => {
  it.each([
    ['mcp__plugin_ashlr_ashlr__ashlr__edit', 'Ashlr MCP: Edit'],
    ['mcp__ashlr__ashlr__read', 'Ashlr MCP: Read'],
    ['mcp:ashlr-efficiency.ashlr__read', 'Ashlr efficiency MCP: Read'],
    ['mcp__ashlr-verse__exec_command', 'Verse MCP: Command'],
    ['mcp:other.read', 'Other MCP: Read'],
  ])('recognizes a reported envelope without asserting server loading: %s', (name, label) => {
    expect(reportedTool(name, done)).toEqual({ label, mcp: true, state: 'completed' });
  });

  it('does not turn a bare name into MCP transport evidence', () => {
    expect(reportedTool('ashlr__read', done)).toEqual({ label: 'Read', mcp: false, state: 'completed' });
    expect(reportedTool('mcp:ashlr', done).mcp).toBe(false);
    expect(reportedTool('mcp__ashlr__', done).mcp).toBe(false);
  });

  it('distinguishes pending, failure and unknown result metadata', () => {
    const evidence = emptyResourceEvidence();
    addReportedTool(evidence, reportedTool('Read', { pending: true, failed: false }));
    addReportedTool(evidence, reportedTool('Read', { pending: false, failed: true }));
    addReportedTool(evidence, reportedTool('Read', {}));
    expect(evidence).toMatchObject({ calls: 3, pending: 1, failed: 1, unknown: 1,
      groups: [{ label: 'Read', calls: 3, pending: 1, failed: 1, unknown: 1 }] });
  });

  it('never inspects payloads or renders arbitrary server/tool identifiers', () => {
    const secret = 'sk-secret-value';
    const privatePath = '/Users/private/.config/token';
    const facts = { ...done, get input() { throw new Error('must not read'); }, get output() { throw new Error('must not read'); } };
    const serialized = JSON.stringify([
      reportedTool(`mcp__${secret}__${privatePath}`, facts),
      reportedTool(privatePath, facts),
      reportedTool('constructor', facts),
      reportedTool('mcp:ashlr.' + 'a'.repeat(1_000_000), facts),
    ]);
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain(privatePath);
    expect(serialized.length).toBeLessThan(500);
    expect(serialized).toContain('Other MCP: Other tool');
    expect(serialized).toContain('Unrecognized tool');
  });

  it('treats getter/proxy metadata as unknown without invoking it', () => {
    const accessor = { get pending() { throw new Error('not data'); }, get failed() { throw new Error('not data'); } };
    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();
    expect(reportedTool('Read', accessor).state).toBe('unknown');
    expect(reportedTool('Read', proxy).state).toBe('unknown');
    expect(reportedTool({ toString() { throw new Error('not a name'); } }, done).label).toBe('Unrecognized tool');
    const cache = new Map<string, ResourceEvidenceCacheEntry>();
    cachedReportedTool('call', 'Read', { pending: { secret: 'do-not-retain' }, failed: 'do-not-retain' }, cache);
    expect(JSON.stringify([...cache.values()])).not.toContain('do-not-retain');
  });

  it('caps calls, groups, sources and cache with explicit partial coverage', () => {
    const evidence = emptyResourceEvidence();
    for (let i = 0; i < MAX_RESOURCE_CALLS + 10; i++) {
      addReportedTool(evidence, reportedTool(['Read', 'Edit', 'Write', 'Bash', 'Grep', 'WebFetch', 'Task', 'Other'][i % 8], done));
    }
    setResourceContext(evidence, MAX_RESOURCE_SOURCES + 1, 1);
    expect(evidence).toMatchObject({ calls: MAX_RESOURCE_CALLS, sources: MAX_RESOURCE_SOURCES, playbooks: 1, partial: true });
    expect(evidence.groups.length).toBeLessThanOrEqual(MAX_RESOURCE_GROUPS);
    const cache = new Map<string, ResourceEvidenceCacheEntry>();
    for (let i = 0; i < MAX_RESOURCE_CACHE + 10; i++) cachedReportedTool(String(i), 'Read', done, cache);
    expect(cache.size).toBe(MAX_RESOURCE_CACHE);
    expect(cache.has('0')).toBe(false);
  });

  it('caps distinct groups independently of call count', () => {
    const evidence = emptyResourceEvidence();
    for (const server of ['ashlr', 'ashlr-efficiency', 'ashlr-verse']) {
      for (const tool of ['read', 'edit', 'write', 'bash', 'grep', 'task']) {
        addReportedTool(evidence, reportedTool(`mcp:${server}.${tool}`, done));
      }
    }
    expect(evidence.calls).toBe(18);
    expect(evidence.groups).toHaveLength(MAX_RESOURCE_GROUPS);
    expect(evidence.partial).toBe(true);
  });

  it('reuses metadata across streamed text and invalidates it once the result lands', () => {
    const cache = new Map<string, ResourceEvidenceCacheEntry>();
    const first = cachedReportedTool('turn:call', 'Read', { pending: true, failed: false }, cache);
    expect(cachedReportedTool('turn:call', 'Read', { pending: true, failed: false }, cache)).toBe(first);
    const settled = cachedReportedTool('turn:call', 'Read', done, cache);
    expect(settled).not.toBe(first);
    expect(settled.state).toBe('completed');
    expect(cachedReportedTool('turn:call', 'Read', { ...done }, cache)).toBe(settled);
    expect(cachedReportedTool('other-turn:call', 'Edit', done, cache).label).toBe('Edit');
  });
});
