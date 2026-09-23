/**
 * Tests for src/core/verse/mcp-scope.ts — scope is asked of Locus, not
 * invented in the hub.
 *
 * What is proven here:
 *
 *   1. Every scope field is a straight projection of what Locus published.
 *      Nothing is derived, defaulted or filled in from hub-local knowledge —
 *      an absent pin produces nulls and a reason, never a stand-in tenant.
 *   2. The three failure modes are DISTINGUISHABLE: locus absent, present but
 *      unpinned, and pinned but not sealed/expired. Collapsing those into one
 *      "no scope" is what makes an operator write to the wrong tenant.
 *   3. Admission is the repo's existing pre-mutate ladder, not a new rule
 *      this surface made up, and an undecidable gate FAILS CLOSED.
 *
 * Hermetic: the Locus probe and the pre-mutate decision are both injected, so
 * nothing shells out to `locus`.
 */
import { describe, it, expect } from 'vitest';

import type { LocusAgentReport, LocusProbeResult } from '../src/core/integrations/locus.js';
import {
  projectVerseMcpScope,
  readVerseMcpScope,
  readVerseMcpScopeGate,
} from '../src/core/verse/mcp-scope.js';

function report(pin: LocusAgentReport['pin']): LocusAgentReport {
  return {
    version: '1.0.0',
    ready: true,
    status: 'ready',
    status_oneline: 'personal:acme',
    home: '/private/locus',
    pin,
    mcp_registered: { claude: true, cursor: false, codex: true },
    doctor: null,
    commands: {},
    required_servers: ['locus', 'phantom'],
    mcp_command: 'locus-mcp',
  };
}

function probe(pin: LocusAgentReport['pin']): LocusProbeResult {
  return { available: true, report: report(pin), exitCode: 0, gateOk: true };
}

describe('projectVerseMcpScope', () => {
  it('reports locus-unavailable when the binary could not be run', () => {
    const scope = projectVerseMcpScope({ available: false, report: null, exitCode: 127, gateOk: false });
    expect(scope.available).toBe(false);
    expect(scope.reason).toBe('mcp-scope-locus-unavailable');
    expect(scope.tenantRef).toBeNull();
  });

  it('distinguishes "locus answered, nothing pinned" from "locus absent"', () => {
    const scope = projectVerseMcpScope(probe(null));
    expect(scope.available).toBe(true);
    expect(scope.pinned).toBe(false);
    expect(scope.reason).toBe('mcp-scope-unpinned');
    // No stand-in tenant is ever invented to fill the hole.
    expect(scope.tenantRef).toBeNull();
    expect(scope.principalRef).toBeNull();
  });

  it('carries Locus\'s opaque references through unchanged', () => {
    const scope = projectVerseMcpScope(probe({
      pinned: true,
      alias: 'acme-prod',
      tenant: 'tenant_01HX',
      binding_id: 'bind_9f2',
      principal: 'principal_44a',
      seal_ok: true,
      expired: false,
      frozen: false,
      expires_at: '2026-12-31T00:00:00.000Z',
    }));

    expect(scope.reason).toBe('mcp-scope-pinned');
    expect(scope.aliasRef).toBe('acme-prod');
    expect(scope.tenantRef).toBe('tenant_01HX');
    expect(scope.bindingRef).toBe('bind_9f2');
    expect(scope.principalRef).toBe('principal_44a');
    expect(scope.expiresAt).toBe('2026-12-31T00:00:00.000Z');
    expect(scope.statusOneline).toBe('personal:acme');
  });

  it('names a broken seal before it names an expiry', () => {
    const scope = projectVerseMcpScope(probe({
      pinned: true, tenant: 't', seal_ok: false, expired: true,
    }));
    expect(scope.reason).toBe('mcp-scope-seal-unverified');
  });

  it('names an expiry when the seal itself verified', () => {
    const scope = projectVerseMcpScope(probe({
      pinned: true, tenant: 't', seal_ok: true, expired: true,
    }));
    expect(scope.reason).toBe('mcp-scope-expired');
  });

  it('keeps a flag Locus did not publish as null rather than false', () => {
    const scope = projectVerseMcpScope(probe({ pinned: true, tenant: 't' }));
    expect(scope.sealOk).toBeNull();
    expect(scope.frozen).toBeNull();
    expect(scope.reason).toBe('mcp-scope-pinned');
  });

  it('survives a throwing probe', () => {
    const scope = readVerseMcpScope(() => { throw new Error('locus exploded'); });
    expect(scope.reason).toBe('mcp-scope-locus-unavailable');
  });
});

describe('readVerseMcpScopeGate', () => {
  it('mirrors the repo-wide pre-mutate decision rather than inventing one', () => {
    const gate = readVerseMcpScopeGate({
      read: () => probe({ pinned: true, tenant: 't', seal_ok: true, expired: false }),
      decide: () => ({ allow: false, mode: 'enforce', blockers: ['locus: unpinned'] }),
    });
    expect(gate.allow).toBe(false);
    expect(gate.mode).toBe('enforce');
    expect(gate.blockers).toEqual(['locus: unpinned']);
    expect(gate.scope.tenantRef).toBe('t');
  });

  it('allows in `off` mode, which is this repo\'s documented default', () => {
    const gate = readVerseMcpScopeGate({
      read: () => probe(null),
      decide: () => ({ allow: true, mode: 'off', blockers: [] }),
    });
    expect(gate.allow).toBe(true);
    expect(gate.mode).toBe('off');
  });

  it('fails CLOSED when the gate itself cannot be evaluated', () => {
    const gate = readVerseMcpScopeGate({
      read: () => probe(null),
      decide: () => { throw new Error('gate exploded'); },
    });
    expect(gate.allow).toBe(false);
    expect(gate.mode).toBe('enforce');
    expect(gate.blockers.join(' ')).toContain('could not be evaluated');
  });
});
