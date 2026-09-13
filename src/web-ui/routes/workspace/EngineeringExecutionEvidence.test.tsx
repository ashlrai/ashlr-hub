import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { EngineeringExecutionEvidence } from './EngineeringExecutionEvidence.js';
import { phaseFixture } from './engineering-phase-fixture.test-support.js';

describe('recorded execution evidence', () => {
  it('separates parallel evaluator evidence from worker completion without polling or liveness claims', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    render(<EngineeringExecutionEvidence evidence={phaseFixture()} />);
    expect(screen.getByText(/not a live process check/)).toBeInTheDocument();
    expect(screen.getByText('Seed result recorded')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Generation 1'));
    expect(screen.getByText('Worker completion recorded')).toBeVisible();
    expect(screen.getByText('Evaluation intent recorded; settlement pending')).toBeVisible();
    expect(screen.getByText('Evaluator process group settled')).toBeVisible();
    expect(screen.getAllByText('Variant attribution awaits the trial record')).toHaveLength(2);
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
  it('does not infer evaluator execution from a completed worker', () => {
    const evidence = phaseFixture(); evidence.runs[0]!.evaluators = [];
    render(<EngineeringExecutionEvidence evidence={evidence} />);
    fireEvent.click(screen.getByText('Generation 1'));
    expect(screen.getByText(/Evaluation is not inferred from worker completion/)).toBeVisible();
  });
  it('handles missing legacy evidence separately from explicitly unavailable evidence', () => {
    const view = render(<EngineeringExecutionEvidence />);
    expect(screen.getByText(/did not provide phase evidence/)).toBeInTheDocument();
    view.rerender(<EngineeringExecutionEvidence evidence={{ ...phaseFixture(), sourceState: 'unavailable', reason: 'phase-evidence-changed', seed: null, runs: [] }} />);
    expect(screen.getByText(/changed during this read/)).toBeInTheDocument();
    expect(screen.queryByText('Generation 1')).not.toBeInTheDocument();
  });
});
