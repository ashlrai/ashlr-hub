import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { McpSnapshot } from '../mcp/mcp-contract.js';
import { McpGroup } from './McpGroup.js';

describe('MCP identity setup guidance', () => {
  it('explains missing Phantom and authority custody without restoring any identity', () => {
    const run = vi.fn();
    const snapshot: McpSnapshot = {
      sampledAt: null, seats: [], machine: { servers: [], configured: false, note: '' }, notes: [],
      scope: { available: true, pinned: true, aliasRef: 'client', tenantRef: 'tenant', principalRef: null,
        reason: 'mcp-scope-expired', setupIssues: ['phantom_unavailable', 'authority_anchor_unavailable', 'SECRET-CANARY'] },
    };
    render(<McpGroup snapshot={snapshot} cliHealth={null} unavailable={null} loading={false} run={run} onAdded={() => {}} />);
    expect(screen.getByText(/The Locus pin has expired/)).toHaveTextContent('a human must select and restore the intended pin');
    expect(screen.getByText(/Phantom is not available to Locus/)).toHaveTextContent('PATH');
    expect(screen.getByText(/The Locus authority anchor is unavailable/)).toHaveTextContent('locus doctor');
    expect(screen.queryByText('SECRET-CANARY')).not.toBeInTheDocument();
    expect(run).not.toHaveBeenCalled();
  });
});
