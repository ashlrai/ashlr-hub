import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { UniversePortfolioControllerView } from '../../core/web/universe-console-types.js';
import { UniverseControllerTopology } from './UniverseControllerTopology.js';

const report = (): UniversePortfolioControllerView => ({
  schemaVersion: 1, controllerId: 'fleet', sourceState: 'healthy', status: 'incomplete',
  observedAt: '2026-09-09T10:00:00.000Z', createdAt: null, deadlineAt: null, reasons: [],
  outcomes: [
    { campaignId: 'foundation', state: 'completed', attempted: true, reasonCode: 'completed' },
    { campaignId: 'engine', state: 'in-flight', attempted: true, reasonCode: 'dispatch-unresolved' },
    { campaignId: 'interface', state: 'held', attempted: true, reasonCode: 'dispatch-not-started' },
    { campaignId: 'acceptance', state: 'pending', attempted: false, reasonCode: 'dependency-held' },
  ],
  topology: [
    { campaignId: 'foundation', dependsOn: [], prerequisites: [] },
    { campaignId: 'engine', dependsOn: ['foundation'], prerequisites: ['foundation'] },
    { campaignId: 'interface', dependsOn: ['foundation'], prerequisites: ['foundation'] },
    { campaignId: 'acceptance', dependsOn: ['engine', 'interface'], prerequisites: ['engine', 'interface', 'foundation'] },
  ],
});
const detail = () => within(screen.getByRole('region', { name: 'Selected campaign detail' }));
const select = (id: string) => screen.getByRole('button', { name: new RegExp(`^Inspect campaign ${id}:`) });

describe('controller mission topology', () => {
  it('uses recorded counts and dependency layers without claiming live workers or changing priority', () => {
    render(<UniverseControllerTopology data={report()} />);
    const counts = within(screen.getByLabelText('Recorded campaign counts'));
    expect(counts.getAllByText('1')).toHaveLength(4);
    expect(screen.getByText('Dependency layer 3')).toBeInTheDocument();
    expect(select('foundation')).toHaveAttribute('aria-pressed', 'true');
    expect(detail().getByText(/not a production deployment claim/)).toBeInTheDocument();
    expect(screen.getByText(/does not change declared priority/)).toBeInTheDocument();
  });

  it('supports native keyboard selection and explains unresolved intent honestly', async () => {
    render(<UniverseControllerTopology data={report()} />);
    const user = userEvent.setup();
    select('engine').focus();
    await user.keyboard('{Enter}');
    expect(select('engine')).toHaveAttribute('aria-pressed', 'true');
    expect(detail().getByRole('heading', { name: 'engine' })).toBeInTheDocument();
    expect(detail().getByText(/not proof of a live worker/)).toBeInTheDocument();
    select('interface').focus();
    await user.keyboard(' ');
    expect(select('interface')).toHaveAttribute('aria-pressed', 'true');
    expect(detail().getByText('dispatch-not-started')).toBeInTheDocument();
    expect(detail().getByText(/does not retry or release/)).toBeInTheDocument();
    expect(detail().getByText(/not proof of worker execution/)).toBeInTheDocument();
  });

  it('separates direct dependencies from inherited delivery gates, with complete accessible relationships', async () => {
    render(<UniverseControllerTopology data={report()} />);
    await userEvent.setup().click(select('acceptance'));
    expect(select('acceptance')).toHaveAccessibleDescription('Direct dependencies: engine, interface. Additional inherited delivery prerequisites: foundation.');
    expect(detail().getAllByRole('list')).toHaveLength(2);
    const lists = detail().getAllByRole('list');
    expect(within(lists[0]).getByRole('button', { name: 'engine' })).toBeInTheDocument();
    expect(within(lists[0]).queryByRole('button', { name: 'foundation' })).not.toBeInTheDocument();
    expect(within(lists[1]).getByRole('button', { name: 'foundation' })).toBeInTheDocument();
    expect(detail().getByText(/Pending does not mean ready/)).toBeInTheDocument();
    expect(detail().getByText(/state badge alone does not verify/)).toBeInTheDocument();
    await userEvent.setup().click(within(lists[1]).getByRole('button', { name: 'foundation' }));
    expect(select('foundation')).toHaveAttribute('aria-pressed', 'true');
  });

  it('preserves same-controller selection on refresh or removal and resets only for controller identity', async () => {
    const data = report();
    const { rerender } = render(<UniverseControllerTopology data={data} />);
    await userEvent.setup().click(select('interface'));
    rerender(<UniverseControllerTopology data={{ ...data, outcomes: data.outcomes.map((node) => node.campaignId === 'interface' ? { ...node, reasonCode: 'new-reason' } : node) }} />);
    expect(select('interface')).toHaveAttribute('aria-pressed', 'true');
    expect(detail().getByText('new-reason')).toBeInTheDocument();
    rerender(<UniverseControllerTopology data={{ ...data, controllerId: 'other' }} />);
    expect(select('foundation')).toHaveAttribute('aria-pressed', 'true');
    await userEvent.setup().click(select('interface'));
    rerender(<UniverseControllerTopology data={{ ...data, controllerId: 'other', outcomes: data.outcomes.filter((node) => node.campaignId !== 'interface') }} />);
    expect(select('foundation')).toHaveAttribute('aria-pressed', 'false');
    expect(detail().getByText(/Selected campaign interface is no longer present/)).toBeInTheDocument();
    expect(detail().queryByRole('heading', { name: 'foundation' })).not.toBeInTheDocument();
    rerender(<UniverseControllerTopology data={{ ...data, controllerId: 'other' }} />);
    expect(select('interface')).toHaveAttribute('aria-pressed', 'true');
  });

  it('does not invent independence when a legacy observation lacks topology', () => {
    const { topology: _topology, ...legacy } = report();
    render(<UniverseControllerTopology data={legacy} />);
    expect(screen.getByText(/Dependency information is unavailable in this observation/)).toBeInTheDocument();
    expect(screen.getByText('Recorded campaigns')).toBeInTheDocument();
    expect(screen.queryByText('Dependency layer 1')).not.toBeInTheDocument();
    expect(select('foundation')).toHaveAccessibleDescription('Dependency information unavailable.');
    expect(detail().getByText('Dependency information unavailable.')).toBeInTheDocument();
    expect(detail().queryByText('None declared for this campaign.')).not.toBeInTheDocument();
  });

  it('renders empty and unavailable evidence without executable controls or requests', () => {
    const request = vi.spyOn(globalThis, 'fetch');
    render(<UniverseControllerTopology data={{ ...report(), outcomes: [], topology: [], sourceState: 'degraded' }} />);
    expect(screen.getByText(/No campaign outcomes are available/)).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Campaign dependency diagram' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(request).not.toHaveBeenCalled();
    request.mockRestore();
  });

  it('bounds nodes and edges while retaining complete selected dependency text', async () => {
    const outcomes = Array.from({ length: 65 }, (_, index) => ({ campaignId: `task-${index}`, state: 'pending' as const, attempted: false, reasonCode: 'pending' }));
    const topology = outcomes.map((node, index) => ({ campaignId: node.campaignId, dependsOn: outcomes.slice(0, index).map((item) => item.campaignId), prerequisites: outcomes.slice(0, index).map((item) => item.campaignId) }));
    const { container } = render(<UniverseControllerTopology data={{ ...report(), outcomes, topology }} />);
    expect(screen.getAllByRole('button', { name: /^Inspect campaign/ })).toHaveLength(64);
    expect(container.querySelectorAll('svg path')).toHaveLength(256);
    expect(screen.getByText(/Showing the first 64 of 65 campaigns/)).toBeInTheDocument();
    expect(screen.getByText(/Showing 256 of 2016 visible dependency lines/)).toBeInTheDocument();
    await userEvent.setup().click(select('task-63'));
    expect(detail().getAllByRole('listitem')).toHaveLength(63);
    expect(select('task-63')).toHaveAccessibleDescription(expect.stringContaining('task-62'));
  });

  it('retains cross-bound references without pretending missing outcomes or placement are resolved', async () => {
    const data = report();
    data.topology![0] = { campaignId: 'foundation', dependsOn: ['external'], prerequisites: ['external'] };
    render(<UniverseControllerTopology data={data} />);
    expect(screen.getByText('Layer unavailable')).toBeInTheDocument();
    expect(detail().getByText('external')).toBeInTheDocument();
    expect(detail().getByText('Outcome unavailable')).toBeInTheDocument();
    expect(select('foundation')).toHaveAccessibleDescription(expect.stringContaining('external'));
  });
});
