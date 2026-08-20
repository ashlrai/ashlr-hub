import { homedir } from 'node:os';
import { describe, expect, it } from 'vitest';

import { buildFleetLaneLocks } from '../src/core/fleet/lane-lock.js';
import type { Proposal } from '../src/core/types.js';
import {
  PublicJsonSanitizationError,
  sanitizePublicJson,
} from '../src/core/util/public-json.js';

describe('M477 public JSON graph readiness', () => {
  it('serializes repeated object aliases at every non-recursive location', () => {
    const shared = { readiness: 'ready', nested: { count: 2 } };

    expect(sanitizePublicJson({ primary: shared, secondary: shared })).toEqual({
      primary: { readiness: 'ready', nested: { count: 2 } },
      secondary: { readiness: 'ready', nested: { count: 2 } },
    });
  });

  it('replaces true recursive object edges with the circular sentinel', () => {
    const root: Record<string, unknown> = { name: 'root' };
    const child: Record<string, unknown> = { name: 'child', parent: root };
    root['child'] = child;
    root['self'] = root;

    expect(sanitizePublicJson(root)).toEqual({
      name: 'root',
      child: { name: 'child', parent: '[Circular]' },
      self: '[Circular]',
    });
  });

  it('distinguishes repeated array aliases from recursive array edges', () => {
    const shared = ['ready', { count: 2 }];
    const recursive: unknown[] = ['root'];
    recursive.push(recursive);

    expect(sanitizePublicJson([shared, shared, recursive])).toEqual([
      ['ready', { count: 2 }],
      ['ready', { count: 2 }],
      ['root', '[Circular]'],
    ]);
  });

  it('continues scrubbing home paths and secret-shaped strings in keys and values', () => {
    const home = homedir();
    const secret = 'sk-abcdefghijklmnop1234567890';

    expect(
      sanitizePublicJson({
        [`${home}/${secret}`]: `workspace=${home}/src credential=${secret}`,
      }),
    ).toEqual({
      '~/[REDACTED]': 'workspace=~/src credential=[REDACTED]',
    });
  });

  it('copies only own enumerable data properties without invoking getters', () => {
    let getterCalls = 0;
    const inherited = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(inherited, 'inheritedGetter', {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return 'private-inherited';
      },
    });
    const input = Object.create(inherited) as Record<PropertyKey, unknown>;
    input['visible'] = { status: 'ready' };
    Object.defineProperty(input, 'ownGetter', {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return 'private-own';
      },
    });
    Object.defineProperty(input, 'hidden', { enumerable: false, value: 'private-hidden' });
    input[Symbol('private-symbol')] = 'private-symbol-value';

    const sanitized = sanitizePublicJson(input) as Record<string, unknown>;

    expect(getterCalls).toBe(0);
    expect(sanitized).toEqual({ visible: { status: 'ready' } });
    expect(Reflect.ownKeys(sanitized)).toEqual(['visible']);

    (input['visible'] as Record<string, string>)['status'] = 'changed-after-sanitize';
    expect(sanitized).toEqual({ visible: { status: 'ready' } });
  });

  it('does not invoke array accessors and preserves JSON array positions as null', () => {
    let getterCalls = 0;
    const input = ['visible', 'replace-me'];
    Object.defineProperty(input, '1', {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return 'private-accessor';
      },
    });

    expect(sanitizePublicJson(input)).toEqual(['visible', null]);
    expect(getterCalls).toBe(0);
  });

  it('detaches arrays before inherited toJSON accessors can execute', () => {
    const input = ['safe'];
    let getterCalls = 0;
    let sanitized: unknown;
    let encoded = '';
    const prior = Object.getOwnPropertyDescriptor(Array.prototype, 'toJSON');
    Object.defineProperty(Array.prototype, 'toJSON', {
      configurable: true,
      get: () => {
        getterCalls += 1;
        return () => ['private-inherited-replacement'];
      },
    });
    try {
      sanitized = sanitizePublicJson(input);
      encoded = JSON.stringify(sanitized);
    } finally {
      if (prior === undefined) delete (Array.prototype as { toJSON?: unknown }).toJSON;
      else Object.defineProperty(Array.prototype, 'toJSON', prior);
    }

    expect(getterCalls).toBe(0);
    expect(Array.isArray(sanitized)).toBe(true);
    expect(Object.getPrototypeOf(sanitized)).toBeNull();
    expect(encoded).toBe('["safe"]');
  });

  it('rejects proxies without invoking value or reflection traps', () => {
    let trapCalls = 0;
    const proxy = new Proxy({ visible: { state: 'ready' } }, {
      get() {
        trapCalls += 1;
        return 'private';
      },
      ownKeys() {
        trapCalls += 1;
        return ['visible'];
      },
      getOwnPropertyDescriptor() {
        trapCalls += 1;
        return { configurable: true, enumerable: true, value: 'private' };
      },
    });

    expect(() => sanitizePublicJson(proxy)).toThrowError(
      expect.objectContaining({ reason: 'inspection-failed' }),
    );
    expect(trapCalls).toBe(0);
  });

  it('fails closed with detail-free errors when proxy inspection is hostile', () => {
    const canary = 'RAW_PROXY_EXCEPTION_CANARY';
    let trapCalls = 0;
    const proxy = new Proxy({}, {
      ownKeys() {
        trapCalls += 1;
        throw new Error(canary);
      },
    });

    try {
      sanitizePublicJson(proxy);
      throw new Error('expected sanitization failure');
    } catch (error) {
      expect(error).toBeInstanceOf(PublicJsonSanitizationError);
      expect((error as PublicJsonSanitizationError).reason).toBe('inspection-failed');
      expect(String(error)).not.toContain(canary);
      expect(trapCalls).toBe(0);
    }
  });

  it('fails before deep or broad graphs can exhaust the call stack or heap', () => {
    const deep: Record<string, unknown> = {};
    let cursor = deep;
    for (let index = 0; index < 10_000; index += 1) {
      const next: Record<string, unknown> = {};
      cursor['next'] = next;
      cursor = next;
    }

    expect(() => sanitizePublicJson(deep, { maxDepth: 16 })).toThrowError(
      expect.objectContaining({ reason: 'depth-limit' }),
    );
    expect(() => sanitizePublicJson(Array.from({ length: 32 }, (_, index) => index), {
      maxNodes: 16,
    })).toThrowError(expect.objectContaining({ reason: 'node-limit' }));
    expect(() => sanitizePublicJson(new Array(32), { maxArrayLength: 16 })).toThrowError(
      expect.objectContaining({ reason: 'array-limit' }),
    );
    expect(() => sanitizePublicJson(
      Object.fromEntries(Array.from({ length: 32 }, (_, index) => [`key-${index}`, index])),
      { maxContainerKeys: 16 },
    )).toThrowError(expect.objectContaining({ reason: 'container-limit' }));
  });

  it('bounds individual text and the exact final UTF-8 JSON representation', () => {
    expect(() => sanitizePublicJson({ text: 'x'.repeat(129) }, { maxStringBytes: 128 })).toThrowError(
      expect.objectContaining({ reason: 'string-limit' }),
    );

    const escaped = { text: '\u0000'.repeat(20) };
    const exactBytes = Buffer.byteLength(JSON.stringify(escaped), 'utf8');
    const within = sanitizePublicJson(escaped, { maxOutputBytes: exactBytes });
    expect(Buffer.byteLength(JSON.stringify(within), 'utf8')).toBe(exactBytes);
    expect(() => sanitizePublicJson(
      escaped,
      { maxOutputBytes: exactBytes - 1 },
    )).toThrowError(expect.objectContaining({ reason: 'output-limit' }));
  });

  it('does not charge omitted object keys against the exact output cap', () => {
    const sanitized = sanitizePublicJson({ a: undefined }, { maxOutputBytes: 2 });
    expect(JSON.stringify(sanitized)).toBe('{}');
  });

  it('fails closed when scrubbed keys collide instead of ambiguously overwriting data', () => {
    const first = 'sk-abcdefghijklmnop1234567890';
    const second = 'ghp_abcdefghijklmnopqrstuvwxyz123456';
    expect(() => sanitizePublicJson({ [first]: 1, [second]: 2 })).toThrowError(
      expect.objectContaining({ reason: 'key-collision' }),
    );
  });

  it('scrubs hostile lane metadata without adding raw work content', () => {
    const home = homedir();
    const secret = 'ghp_abcdefghijklmnopqrstuvwxyz123456';
    const sanitized = sanitizePublicJson({
      laneLocks: {
        sourceQuality: {
          sourceState: 'degraded',
          complete: false,
          reasons: ['goals-unreadable'],
        },
        samples: [{
          repo: 'ashlr-hub',
          lane: 'ashlr-hub#goal:goal-one',
          title: `Inspect ${secret} at ${home}/private`,
          reason: 'stale-in-progress',
          ageMs: 1000,
        }],
      },
    });
    const encoded = JSON.stringify(sanitized);

    expect(encoded).toContain('"repo":"ashlr-hub"');
    expect(encoded).toContain('[REDACTED]');
    expect(encoded).toContain('~/private');
    expect(encoded).not.toContain(secret);
    expect(encoded).not.toContain(home);
    expect(encoded).not.toMatch(/"(prompt|diff|stdout|stderr|output|env|files)"/);
  });

  it('keeps raw persisted lane IDs and ambiguous metadata out of sanitized public snapshots', () => {
    const secret = ['sk', 'live', 'abcdefghijklmnopqrstuvwxyz'].join('_');
    const proposal: Proposal = {
      id: `proposal-${secret}`,
      repo: `/private/workspace/${secret}`,
      origin: 'agent',
      kind: 'patch',
      title: `Inspect ${secret} under /Volumes/Client Data`,
      summary: 'public projection fixture',
      status: 'awaiting-host-merge',
      createdAt: '2026-07-03T00:00:00.000Z',
    };
    const laneLocks = buildFleetLaneLocks({ goals: [], proposals: [proposal], visibleQueueItems: [] });
    const sanitized = sanitizePublicJson({ laneLocks });
    const encoded = JSON.stringify(sanitized);

    expect(laneLocks.samples[0]).toMatchObject({
      lane: expect.stringMatching(/^unknown#proposal:p_[0-9a-f]{16}$/),
      proposalId: expect.stringMatching(/^p_[0-9a-f]{16}$/),
      repo: null,
    });
    expect(laneLocks.samples[0]).not.toHaveProperty('title');
    expect(encoded).not.toContain(secret);
    expect(encoded).not.toContain('Client Data');
    expect(encoded).not.toContain(`proposal-${secret}`);
  });
});
