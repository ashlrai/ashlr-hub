import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { AgentOsCockpit, MAX_VISIBLE_VALUE_BETS } from './AgentOsCockpit.js';
import type { ActiveValueBetSummary, AgentOsCockpitSnapshot } from './types.js';

function bet(index: number): ActiveValueBetSummary {
  return {
    key: `bet-${index}`,
    title: `Value bet ${index}`,
    valueCase: 'Compounds product advantage and reusable IP.',
    allocationLabel: `${20 + index}k tokens · 30m`,
    decision: index === 2 ? 'observing' : 'continue',
    assurance: index === 1 ? 'targeted' : 'fast-path',
    outcome: { state: 'pending', label: 'Window open' },
    evidence: { state: 'complete', label: 'Preverified' },
  };
}

const SNAPSHOT: AgentOsCockpitSnapshot = {
  sourceState: 'healthy',
  livingEndState: {
    northStar: 'Turn model capacity into durable product advantage and customer value.',
    currentBottleneck: 'Outcome evidence arrives later than engineering completion.',
    revisionLabel: 'Vision v12',
    evidenceState: 'complete',
  },
  capabilitySpectrum: [
    {
      lane: 'claude',
      label: 'Claude',
      state: 'ready',
      headroom: 'ample',
      resetUrgency: 'soon',
      resetLabel: 'Resets in 47m',
      allocationLabel: '2 value bets ready',
    },
    {
      lane: 'codex',
      label: 'Codex',
      state: 'tight',
      headroom: 'tight',
      resetUrgency: 'later',
      resetLabel: 'Resets in 4h',
      allocationLabel: '1 value bet ready',
    },
    {
      lane: 'local',
      label: 'Local models',
      state: 'ready',
      headroom: 'usable',
      resetUrgency: 'none',
      resetLabel: 'No reset window',
      allocationLabel: 'Background evaluation',
    },
  ],
  activeValueBets: [bet(1), bet(2), bet(3), bet(4)],
  nextAction: {
    kind: 'exception',
    title: 'Repair the outcome evidence gap',
    reason: 'One high-value bet is waiting on a complete observation window.',
    evidenceState: 'incomplete',
  },
};

describe('AgentOsCockpit', () => {
  it('puts the bottleneck and exception-first next action ahead of capacity and work', () => {
    render(<AgentOsCockpit snapshot={SNAPSHOT} />);

    const nextAction = screen.getByLabelText('Exception-first next action');
    const spectrum = screen.getByRole('heading', { name: 'Capability spectrum' });
    expect(nextAction).toHaveTextContent('Repair the outcome evidence gap');
    expect(screen.getByText('Outcome evidence arrives later than engineering completion.')).toBeInTheDocument();
    expect(nextAction.compareDocumentPosition(spectrum) & 4).toBeTruthy();
  });

  it('shows values-free capability reset urgency and at most three active value bets', () => {
    render(<AgentOsCockpit snapshot={SNAPSHOT} />);

    expect(screen.getByText('Resets in 47m')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Claude headroom: ample' })).toBeInTheDocument();
    expect(screen.getByText('Value bet 1')).toBeInTheDocument();
    expect(screen.getByText('Value bet 3')).toBeInTheDocument();
    expect(screen.queryByText('Value bet 4')).not.toBeInTheDocument();
    expect(screen.getByText('1 lower-ranked bet is held outside this view.')).toBeInTheDocument();
    expect(MAX_VISIBLE_VALUE_BETS).toBe(3);
  });

  it('keeps outcome and evidence distinct and exposes no live effect control', () => {
    render(<AgentOsCockpit snapshot={SNAPSHOT} />);

    const bets = screen.getByRole('heading', { name: 'Active value bets' }).parentElement?.parentElement;
    if (!bets) throw new Error('expected value bets section');
    expect(within(bets).getAllByText('Window open')).toHaveLength(3);
    expect(within(bets).getAllByText('Preverified')).toHaveLength(3);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    expect(screen.getByText(/Observation only/)).toHaveTextContent(
      'This view cannot dispatch, merge, release, deploy, or change policy.',
    );
  });

  it('renders honest empty and unknown states without inventing capacity or work', () => {
    render(<AgentOsCockpit snapshot={{
      ...SNAPSHOT,
      sourceState: 'unknown',
      capabilitySpectrum: [],
      activeValueBets: [],
      nextAction: null,
    }} />);

    expect(screen.getByText('Capability evidence is not available.')).toBeInTheDocument();
    expect(screen.getByText('No active value bet is verified.')).toBeInTheDocument();
    expect(screen.getByText('No verified next action available')).toBeInTheDocument();
    expect(screen.getByText('No exception or clearance evidence was provided.')).toBeInTheDocument();
    expect(screen.getByText('unknown')).toBeInTheDocument();
  });
});
