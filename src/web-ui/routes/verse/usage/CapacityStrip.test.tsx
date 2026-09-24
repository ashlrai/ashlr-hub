/**
 * CapacityStrip.test.tsx — the ONE shared capacity view (SPEC-310C §4), as
 * the operator reads it: a word for every state, a bar only for a real
 * reading, "limit reached" instead of 100%, a visible reserve, keyboard-
 * operable seat names, and the same markup at 375 (C0's viewport mock) and
 * in dark (token-probe contrast of the colours the strip uses).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { BudgetView } from '../../../../core/routing/policy.js';
import { contrastRatio } from '../../../design/contrast.js';
import { darkScope, lightScope, moduleColor, resolveToken } from '../../../design/token-probe.test-support.js';
import { scanStyleSource } from '../../../design/style-scan.test-support.js';
import { mockCompactViewport } from '../shell/viewport.test-support.js';
import {
  CLAUDE_MAX_SEAT,
  CLAUDE_TIGHT_SEAT,
  CODEX_CREDITS_SEAT,
  GROK_SEAT,
  LOCAL_SEAT_V2,
  UNREAD_SEAT,
} from '../seat-fixtures.test-support.js';
import { CapacityStrip } from './CapacityStrip.js';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const CLAUDE = { ...CLAUDE_TIGHT_SEAT, id: 'claude-a', accountId: 'claude-a' };

const BUDGET = {
  mode: 'balanced',
  seats: {},
  updatedAt: 'x',
  headroom: [{ seatId: 'claude-a', sessionUsedPercent: 15, weeklyUsedPercent: 85, bindingWindow: 'weekly', autonomyHeadroomPercent: 0, resetAt: null, eligibleForAutonomy: false, reasons: ['Past the ceiling.'] }],
  seatInfo: [{ seatId: 'claude-a', label: 'Claude Max', engine: 'claude', free: false }],
  effective: { 'claude-a': { seatId: 'claude-a', enabled: true, reservePercent: 40 } },
  readingMaxAgeMs: 1,
  sampledAt: 'x',
} as unknown as BudgetView;

afterEach(() => vi.restoreAllMocks());

describe('CapacityStrip', () => {
  it('states every seat with a WORD, and draws a bar only for a real reading', () => {
    render(<CapacityStrip seats={[CLAUDE, CLAUDE_MAX_SEAT, UNREAD_SEAT]} local="each" />);
    const list = screen.getByRole('list', { name: 'Seat capacity' });
    const rows = within(list).getAllByRole('listitem');
    expect(rows).toHaveLength(3);
    expect(within(rows[0]!).getByText('tight')).toBeInTheDocument();
    expect(within(rows[1]!).getByText('blocked')).toBeInTheDocument();
    expect(within(rows[2]!).getByText('no reading')).toBeInTheDocument();
    // The unread seat has no bar at all.
    expect(within(rows[2]!).queryAllByRole('img')).toHaveLength(0);
    // Real readings are printed as percentages…
    expect(within(rows[0]!).getByText('92%')).toBeInTheDocument();
    // …and the flagged limit is "limit reached", never 100%.
    expect(within(rows[1]!).getByText('limit reached')).toBeInTheDocument();
    expect(within(rows[1]!).queryByText('100%')).not.toBeInTheDocument();
  });

  it('prints reset prose verbatim and names each bar for assistive tech', () => {
    render(<CapacityStrip seats={[CLAUDE]} />);
    expect(screen.getAllByText('resets Sep 25 at 7pm (America/New_York)').length).toBeGreaterThan(0);
    expect(screen.getByRole('img', { name: 'Claude Max 5-hour window: 15% used, resets Sep 21 at 1:40am (America/New_York)' })).toBeInTheDocument();
  });

  it('shows "Reserved for you 40%" with the autonomy word, and marks the kept band on the binding bar', () => {
    const { container } = render(<CapacityStrip seats={[CLAUDE]} budget={BUDGET} />);
    expect(screen.getByText(/Reserved for you 40%/)).toBeInTheDocument();
    expect(screen.getByText('Held back')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: /weekly fable window: 92% used; 40% kept for you/ })).toBeInTheDocument();
    // Exactly one reserve band: the reserve binds the binding window only.
    expect(container.querySelectorAll('[class*="reserve"]')).toHaveLength(1);
  });

  it('shows credits as a separate fact, never folded into the window', () => {
    render(<CapacityStrip seats={[CODEX_CREDITS_SEAT]} />);
    expect(screen.getByText('2048.42 credits left')).toBeInTheDocument();
    expect(screen.getByText('limit reached')).toBeInTheDocument();
  });

  it('compact density: one line per seat, binding window only, no reset text', () => {
    render(<CapacityStrip seats={[CLAUDE, GROK_SEAT]} density="compact" />);
    expect(screen.getAllByRole('img')).toHaveLength(2);
    expect(screen.queryByText(/resets Sep/)).not.toBeInTheDocument();
    // No headline by default in compact.
    expect(screen.queryByText(/accounts usable/)).not.toBeInTheDocument();
  });

  it('the headline counts only what was read', () => {
    render(<CapacityStrip seats={[CLAUDE, UNREAD_SEAT, LOCAL_SEAT_V2]} />);
    expect(screen.getByText('1 of 2 accounts usable · 1 not read yet · local models ready')).toBeInTheDocument();
  });

  it('an empty roster says so rather than drawing seats at zero', () => {
    render(<CapacityStrip seats={[]} />);
    expect(screen.getByText(/an empty roster, not seats at zero/)).toBeInTheDocument();
  });

  it('seat names are toggles from the keyboard when a detail exists', async () => {
    const onSelect = vi.fn();
    const user = userEvent.setup();
    render(<CapacityStrip seats={[CLAUDE, GROK_SEAT]} onSelectSeat={onSelect} selectedSeatId="grok" />);
    await user.tab();
    expect(screen.getByRole('button', { name: /Claude Max/ })).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(onSelect).toHaveBeenCalledWith('claude-a');
    expect(screen.getByRole('button', { name: /Grok/ })).toHaveAttribute('aria-pressed', 'true');
  });

  it('renders the caller’s per-seat actions', () => {
    render(<CapacityStrip seats={[CLAUDE, LOCAL_SEAT_V2]} renderActions={(row) => (row.kind === 'local' ? null : <button type="button">Fix {row.label}</button>)} />);
    expect(screen.getByRole('button', { name: 'Fix Claude Max' })).toBeInTheDocument();
  });

  it('renders the same rows at 375', () => {
    const viewport = mockCompactViewport();
    try {
      render(<CapacityStrip seats={[CLAUDE, GROK_SEAT]} budget={BUDGET} />);
      expect(screen.getAllByRole('listitem')).toHaveLength(2);
      expect(screen.getByText(/Reserved for you 40%/)).toBeInTheDocument();
    } finally {
      viewport.restore();
    }
  });
});

describe('CapacityStrip — a malformed budget read', () => {
  // INT6: GET /api/verse/budget answering `{}` threw inside the strip's
  // useMemo and blanked every surface that mounts it (Apps, onboarding,
  // NewChatDialog). The seats must still render; only the reserve goes quiet.
  it.each([['{}', {}], ['seatInfo: null', { seatInfo: null, headroom: null, effective: null }]])(
    'budget = %s still renders every seat, with no reserve line',
    (_name, value) => {
      render(<CapacityStrip seats={[CLAUDE, CLAUDE_MAX_SEAT]} budget={value as unknown as BudgetView} health={{} as never} local="each" />);
      expect(within(screen.getByRole('list', { name: 'Seat capacity' })).getAllByRole('listitem')).toHaveLength(2);
      expect(screen.queryByText(/Reserved for you/)).not.toBeInTheDocument();
    },
  );
});

describe('CapacityStrip styles', () => {
  const CSS = 'routes/verse/usage/CapacityStrip.module.css';

  it('uses tokens only: no raw hex colour, no px font size', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/web-ui', CSS), 'utf8');
    expect(scanStyleSource(CSS, source)).toEqual([]);
    const tsx = readFileSync(resolve(process.cwd(), 'src/web-ui/routes/verse/usage/CapacityStrip.tsx'), 'utf8');
    expect(scanStyleSource('routes/verse/usage/CapacityStrip.tsx', tsx)).toEqual([]);
  });

  it('keeps every state word readable (≥ 4.5:1) on the surface in both themes', () => {
    for (const [theme, scope] of [['light', lightScope()], ['dark', darkScope()]] as const) {
      const surface = resolveToken(scope, '--bg-surface')!;
      for (const [selector, prop] of [
        ['.word', 'color'],
        [".word[data-tone='warning']", 'color'],
        [".word[data-tone='danger']", 'color'],
        ['.value', 'color'],
        [".value[data-level='tight']", 'color'],
        [".value[data-level='limit']", 'color'],
        ['.summary', 'color'],
      ] as const) {
        const fg = moduleColor(scope, CSS, selector, prop);
        expect(fg, `${theme} ${selector}`).not.toBeNull();
        const ratio = contrastRatio(fg!, surface, surface)!;
        expect(ratio, `${theme} ${selector} ${prop} = ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it('draws the used bar from the quantity ramp, never the accent', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/web-ui', CSS), 'utf8');
    const used = /\.used \{[^}]*\}/.exec(source)![0];
    expect(used).toContain('var(--data-seq-5)');
    expect(source).not.toMatch(/background:[^;]*--accent/);
  });
});
