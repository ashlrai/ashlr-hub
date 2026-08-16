import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Epistemic, isKnown } from './Epistemic.js';

describe('Epistemic', () => {
  it('renders children and the control when the source is healthy and complete', () => {
    render(
      <Epistemic quality={{ sourceState: 'healthy', complete: true }} renderControl={() => <button>Act</button>}>
        42
      </Epistemic>,
    );
    expect(screen.getByText('42')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Act' })).toBeInTheDocument();
  });

  it('shows "unknown" and withholds the control when the source is degraded', () => {
    render(
      <Epistemic
        quality={{ sourceState: 'degraded', complete: false, reason: 'daemon state file missing' }}
        renderControl={() => <button>Restart daemon</button>}
      >
        running
      </Epistemic>,
    );
    expect(screen.queryByText('running')).not.toBeInTheDocument();
    expect(screen.getByText('unknown')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Restart daemon' })).not.toBeInTheDocument();
  });

  it('shows "unknown" when the source reports incomplete even though healthy', () => {
    render(<Epistemic quality={{ sourceState: 'healthy', complete: false }}>value</Epistemic>);
    expect(screen.getByText('unknown')).toBeInTheDocument();
  });

  it('treats absent quality metadata as trustworthy (pre-sourceQuality producers)', () => {
    render(<Epistemic quality={undefined}>legacy value</Epistemic>);
    expect(screen.getByText('legacy value')).toBeInTheDocument();
  });

  it('isKnown() matches the component branch directly', () => {
    expect(isKnown(undefined)).toBe(true);
    expect(isKnown({ sourceState: 'healthy', complete: true })).toBe(true);
    expect(isKnown({ sourceState: 'missing', complete: false })).toBe(false);
    expect(isKnown({ sourceState: 'unknown', complete: false })).toBe(false);
  });
});
