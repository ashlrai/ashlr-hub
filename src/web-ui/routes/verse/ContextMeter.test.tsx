import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  canCompactNow,
  COMPACT_FOCUS_MAX,
  compactCommand,
  compactCostCopy,
  CompactPanel,
  ContextAdvice,
  ContextMeter,
  ContextModeControl,
  describeContext,
  expansiveCostCopy,
  expansiveCostRatio,
  MODE_MENU_GUTTER,
  modeMenuPlacement,
  sessionHandoffAdvice,
  standardSwitchCompacts,
} from './ContextMeter.js';
import { CLAUDE_1M_SEAT, CLAUDE_SEAT, CODEX_EXPANSIVE_SEAT, GROK_SEAT, LOCAL_SEAT, session } from './fixtures.test-support.js';
import { CODEX_EXPANSIVE_METERING_NOTE, contextWindowFor, modelOptionFor, sessionContextBudget, windowSourceText } from './verse-model.js';
import { resetVerseUi } from './verse-ui-store.js';

const OPUS_1M = CLAUDE_1M_SEAT.models[0]!;
const GPT6 = CODEX_EXPANSIVE_SEAT.models[0]!;

describe('ContextMeter — a full-window track with the compaction point marked', () => {
  it('labels "142k / 1M · compacts ≈367k", with the tick at the compaction point', () => {
    render(<ContextMeter contextTokens={142_000} contextWindow={1_000_000} autoCompactAt={367_000} mode="standard" engine="claude" source="cli-catalog" />);
    const meter = screen.getByRole('meter', { name: 'Context window' });
    expect(meter).toHaveTextContent('142k / 1M');
    expect(meter).toHaveTextContent('· compacts ≈367k');
    expect(meter).toHaveTextContent('14%');
    expect(meter).toHaveAttribute('aria-valuenow', '14');
    expect(meter).toHaveAttribute('data-tone', 'ok');
    const tick = within(meter).getByTestId('compaction-tick');
    expect(tick.style.left).toBe('36.7%');
  });

  it('takes its tone from the COMPACTION point, not the window (warn 80%, danger 95%)', () => {
    const { rerender } = render(<ContextMeter contextTokens={250_000} contextWindow={1_000_000} autoCompactAt={367_000} />);
    // 25% of the window — but 68% of the way to compaction: still ok.
    expect(screen.getByRole('meter')).toHaveAttribute('data-tone', 'ok');
    rerender(<ContextMeter contextTokens={300_000} contextWindow={1_000_000} autoCompactAt={367_000} />);
    // Only 30% of the window, yet 82% of the way to compaction: warn BEFORE the CLI compacts.
    expect(screen.getByRole('meter')).toHaveAttribute('data-tone', 'warn');
    rerender(<ContextMeter contextTokens={350_000} contextWindow={1_000_000} autoCompactAt={367_000} />);
    expect(screen.getByRole('meter')).toHaveAttribute('data-tone', 'danger');
  });

  it('never clamps: a reading past the window is an `over` state, said in words', () => {
    render(<ContextMeter contextTokens={1_050_000} contextWindow={1_000_000} autoCompactAt={967_000} />);
    const meter = screen.getByRole('meter');
    expect(meter).toHaveAttribute('data-tone', 'over');
    expect(meter).toHaveTextContent('105%');
    // aria-valuenow stays inside its declared range; the text carries the overflow.
    expect(meter).toHaveAttribute('aria-valuenow', '100');
    expect(meter.getAttribute('aria-valuetext')).toContain('past the window');
    expect(meter.getAttribute('title')).toContain('Past the window');
  });

  it('marks an upper-bound reading with ≤ and says why in the tooltip', () => {
    render(<ContextMeter contextTokens={180_000} contextWindow={258_400} autoCompactAt={244_800} exact={false} engine="codex" />);
    const meter = screen.getByRole('meter');
    expect(meter).toHaveTextContent('≤180k / 258k');
    expect(meter).toHaveAttribute('data-exact', 'false');
    expect(meter.getAttribute('title')).toContain('Upper bound');
    expect(meter.getAttribute('title')).toContain('When it compacts, Codex replaces the earlier conversation');
  });

  it('never reads an upper bound past the compaction point as "over" (codex fallback total)', () => {
    // 697k is a codex turn TOTAL (every call summed) against a 258k window.
    render(<ContextMeter contextTokens={697_060} contextWindow={258_400} autoCompactAt={244_800} exact={false} engine="codex" />);
    const meter = screen.getByRole('meter');
    expect(meter).toHaveAttribute('data-tone', 'unknown');
    expect(meter).toHaveTextContent('≤697k / 258k');
    expect(meter).toHaveTextContent('≤270%');
    expect(meter.getAttribute('aria-valuetext')).not.toContain('past the window');
    const title = meter.getAttribute('title') ?? '';
    expect(title).not.toContain('Past the window');
    expect(title).toContain('the upper bound is past that point, which does not mean the real prompt is');
    // Below the point an upper bound leaves AT LEAST that much room.
    expect(describeContext({ contextTokens: 100_000, contextWindow: 258_400, autoCompactAt: 244_800, exact: false }).title)
      .toContain('at least ≈144,800 left');
  });

  it('falls back to the window when the compaction point is unknown, and says so', () => {
    const { rerender } = render(<ContextMeter contextTokens={123_000} contextWindow={200_000} />);
    const meter = screen.getByRole('meter');
    expect(meter).toHaveAttribute('aria-valuenow', '62');
    expect(meter).toHaveAttribute('data-tone', 'ok');
    expect(meter).toHaveTextContent('123k / 200k');
    expect(meter).not.toHaveTextContent('compacts');
    expect(within(meter).queryByTestId('compaction-tick')).toBeNull();
    expect(meter.getAttribute('title')).toContain('compaction point is unknown');
    rerender(<ContextMeter contextTokens={170_000} contextWindow={200_000} />);
    expect(screen.getByRole('meter')).toHaveAttribute('data-tone', 'warn');
    rerender(<ContextMeter contextTokens={190_000} contextWindow={200_000} />);
    expect(screen.getByRole('meter')).toHaveAttribute('data-tone', 'danger');
  });

  it('shows n/a when the window is unknown, never a guessed percentage', () => {
    render(<ContextMeter contextTokens={5000} contextWindow={null} />);
    const meter = screen.getByRole('meter');
    expect(meter).toHaveAttribute('data-tone', 'unknown');
    expect(meter).not.toHaveAttribute('aria-valuenow');
    expect(meter).toHaveTextContent('5k / n/a');
    expect(meter).toHaveTextContent('n/a');
  });

  it('names the window source, the mode and the compaction count in the tooltip', () => {
    const d = describeContext({ contextTokens: 100_000, contextWindow: 1_000_000, autoCompactAt: 967_000, mode: 'expansive', engine: 'claude', source: 'runtime', compactionCount: 3 });
    expect(d.title).toContain('Context: 100,000 of 1,000,000 tokens (10%).');
    expect(d.title).toContain('Auto-compacts at ≈967,000 tokens (Expansive mode) — ≈867,000 left.');
    expect(d.title).toContain('When it compacts, Claude Code replaces');
    expect(d.title).toContain('Compacted 3 times so far.');
    expect(d.title).toContain('Window: reported by the CLI on the last turn.');
    const old = describeContext({ contextTokens: 1, contextWindow: 200_000 });
    expect(old.title).toContain('source not recorded');
    // On a local seat nothing is "reported by the CLI": Verse measures it and tells the CLI.
    const local = describeContext({ contextTokens: 1, contextWindow: 65_536, autoCompactAt: 32_536, engine: 'local', source: 'runtime' });
    expect(local.title).toContain('Window: measured from the local model server; Verse passes this window to Claude Code for this chat.');
    expect(local.title).not.toContain('reported by the CLI');
    expect(windowSourceText('provider-catalog', 'claude')).toBe("from this seat's own model catalog");
  });

  it('draws no tick when the compaction point is the window itself', () => {
    expect(describeContext({ contextTokens: 0, contextWindow: 65_536, autoCompactAt: 65_536 }).tickPercent).toBeNull();
    expect(describeContext({ contextTokens: 0, contextWindow: 500_000, autoCompactAt: 400_000 }).tickPercent).toBe(80);
  });
});

describe('sessionContextBudget — runtime → catalog (mode) → stored → seat', () => {
  it('uses the current catalog budget for the model and mode when the CLI has not reported one', () => {
    const s = session({ seatId: 'claude-a', model: 'claude-opus-5', usage: { ...session().usage, contextWindow: 200_000 } });
    const standard = sessionContextBudget([CLAUDE_1M_SEAT], s);
    expect(standard).toMatchObject({ contextWindow: 1_000_000, autoCompactAt: 367_000, source: 'cli-catalog', mode: 'standard' });
    const expansive = sessionContextBudget([CLAUDE_1M_SEAT], { ...s, contextMode: 'expansive' });
    expect(expansive).toMatchObject({ contextWindow: 1_000_000, autoCompactAt: 967_000, mode: 'expansive' });
  });

  it('lets a runtime window win, and reconciles its compaction point when none is stored', () => {
    // Claude Code clamped this 1M model to 200k (long-context credit ran out).
    const s = session({
      seatId: 'claude-a',
      model: 'claude-opus-5',
      usage: { ...session().usage, contextWindow: 200_000, contextWindowSource: 'runtime' },
    });
    const b = sessionContextBudget([CLAUDE_1M_SEAT], s);
    expect(b.contextWindow).toBe(200_000);
    expect(b.source).toBe('runtime');
    // min(200k runtime, --autocompact 400k) − 20k − 13k.
    expect(b.autoCompactAt).toBe(167_000);
    const stored = sessionContextBudget([CLAUDE_1M_SEAT], { ...s, usage: { ...s.usage, autoCompactAt: 150_000 } });
    expect(stored.autoCompactAt).toBe(150_000);
  });

  it('finds an aliased model id (claude-opus-5.5 → claude-opus-5-5) without rewriting it', () => {
    const s = session({ seatId: 'claude-a', model: 'claude-opus-5.5' });
    expect(modelOptionFor([CLAUDE_1M_SEAT], s)?.id).toBe('claude-opus-5-5');
    expect(s.model).toBe('claude-opus-5.5');
  });

  it('falls back to the stored record, then to the seat default marked `fallback`', () => {
    const unknownModel = session({ seatId: 'claude-a', model: 'claude-future-9', usage: { ...session().usage, contextWindow: 300_000, autoCompactAt: 250_000 } });
    expect(sessionContextBudget([CLAUDE_1M_SEAT], unknownModel)).toMatchObject({ contextWindow: 300_000, autoCompactAt: 250_000, source: null });
    const bare = session({ seatId: 'claude-a', model: 'claude-future-9', usage: { ...session().usage, contextWindow: null } });
    expect(sessionContextBudget([CLAUDE_1M_SEAT], bare)).toMatchObject({ contextWindow: 1_000_000, autoCompactAt: null, source: 'fallback' });
    expect(contextWindowFor([], bare)).toBeNull();
  });

  it('draws a LOCAL chat against the window stored on it — the one the CLI was told — not the seat\'s current one', () => {
    // Created on the Ollama lane at 262,144 (provider-catalog); the seat has since
    // been rediscovered on llama-server at 65,536. The CLI still gets
    // CLAUDE_CODE_MAX_CONTEXT_TOKENS = the stored window, so the meter must too.
    const s = session({
      engine: 'local', seatId: LOCAL_SEAT.id, model: LOCAL_SEAT.models[0]!.id,
      usage: { ...session().usage, contextTokens: 120_000, contextWindow: 262_144, contextWindowSource: 'provider-catalog', autoCompactAt: 229_144 },
    });
    expect(sessionContextBudget([LOCAL_SEAT], s)).toMatchObject({ contextWindow: 262_144, autoCompactAt: 229_144, source: 'provider-catalog' });
    // No stored point: derived from the stored window by the Claude formula (window − 20k − 13k).
    const bare = { ...s, usage: { ...s.usage, autoCompactAt: undefined } };
    expect(sessionContextBudget([LOCAL_SEAT], bare)).toMatchObject({ contextWindow: 262_144, autoCompactAt: 229_144 });
    // No stored window at all (a pre-3.9 record): the seat's option.
    const none = { ...s, usage: { ...s.usage, contextWindow: null, contextWindowSource: undefined, autoCompactAt: undefined } };
    expect(sessionContextBudget([LOCAL_SEAT], none).contextWindow).toBe(65_536);
    // So 120k of a 262k window is NOT "past the window" on either surface.
    expect(sessionHandoffAdvice(s, sessionContextBudget([LOCAL_SEAT], s), Date.now(), null).level).toBe('none');
  });

  it('carries the exact flag and never clamps occupancy', () => {
    const s = session({ engine: 'codex', seatId: 'codex-b', model: 'gpt-6-astra', usage: { ...session().usage, contextTokens: 400_000, contextTokensExact: false } });
    const b = sessionContextBudget([CODEX_EXPANSIVE_SEAT], s);
    expect(b.contextTokens).toBe(400_000);
    expect(b.exact).toBe(false);
    expect(b.contextWindow).toBe(258_400);
    expect(b.autoCompactAt).toBe(244_800);
  });
});

describe('ContextModeControl', () => {
  it('states both budgets and the cost, and switches only on a click', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<ContextModeControl mode="standard" option={OPUS_1M} onChange={onChange} />);
    const chip = screen.getByRole('button', { name: 'Context mode: Standard' });
    expect(onChange).not.toHaveBeenCalled();
    await user.click(chip);
    const menu = screen.getByRole('menu', { name: 'Context mode' });
    const standard = within(menu).getByRole('menuitemradio', { name: /Standard/ });
    const expansive = within(menu).getByRole('menuitemradio', { name: /Expansive/ });
    expect(standard).toHaveAttribute('aria-checked', 'true');
    expect(standard).toHaveTextContent('compacts ≈367k of 1M');
    expect(expansive).toHaveTextContent('compacts ≈967k of 1M');
    expect(menu).toHaveTextContent('up to ≈2.6× near the expansive limit');
    expect(menu).toHaveTextContent('Applies from the next turn');
    // Re-choosing the current mode is a no-op.
    await user.click(standard);
    expect(onChange).not.toHaveBeenCalled();
    await user.click(expansive);
    expect(onChange).toHaveBeenCalledWith('expansive');
  });

  it('keeps expansive listed but disabled when the model has no expansive budget, so a session can always switch back', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<ContextModeControl mode="expansive" option={CODEX_EXPANSIVE_SEAT.models[1]!} onChange={onChange} />);
    await user.click(screen.getByRole('button', { name: 'Context mode: Expansive' }));
    expect(screen.getByRole('menuitemradio', { name: /Expansive/ })).toBeDisabled();
    await user.click(screen.getByRole('menuitemradio', { name: /Standard/ }));
    expect(onChange).toHaveBeenCalledWith('standard');
  });

  it('opens itself to show an error, and closes on Escape', async () => {
    const user = userEvent.setup();
    const { rerender } = render(<ContextModeControl mode="standard" option={GPT6} onChange={vi.fn()} />);
    rerender(<ContextModeControl mode="standard" option={GPT6} onChange={vi.fn()} error="Unlock actions with the mutation token first." />);
    expect(screen.getByRole('alert')).toHaveTextContent('Unlock actions with the mutation token first.');
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('shows busy and disabled states', () => {
    const { rerender } = render(<ContextModeControl mode="standard" option={GPT6} busy onChange={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Context mode: Standard' })).toHaveTextContent('Switching…');
    rerender(<ContextModeControl mode="standard" option={GPT6} disabled disabledReason="Sending is disabled" onChange={vi.fn()} />);
    const chip = screen.getByRole('button', { name: 'Context mode: Standard' });
    expect(chip).toBeDisabled();
    expect(chip).toHaveAttribute('title', 'Sending is disabled');
  });

  it('closes an open menu when it becomes disabled — a turn started under it', async () => {
    const user = userEvent.setup();
    const { rerender } = render(<ContextModeControl mode="standard" option={OPUS_1M} onChange={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: 'Context mode: Standard' }));
    expect(screen.getByRole('menu')).toBeInTheDocument();
    rerender(<ContextModeControl mode="standard" option={OPUS_1M} disabled disabledReason="Available when the current turn finishes" onChange={vi.fn()} />);
    expect(screen.queryByRole('menu')).toBeNull();
    expect(screen.getByRole('button', { name: 'Context mode: Standard' })).toHaveAttribute('title', 'Available when the current turn finishes');
  });

  it('offers "Compact now…" only when given the action, and closes the menu to open it', async () => {
    const user = userEvent.setup();
    const onCompact = vi.fn();
    const { unmount } = render(<ContextModeControl mode="standard" option={OPUS_1M} onChange={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: 'Context mode: Standard' }));
    expect(screen.queryByRole('menuitem', { name: /Compact now/ })).toBeNull();
    unmount();

    const onChange = vi.fn();
    render(<ContextModeControl mode="standard" option={OPUS_1M} onChange={onChange} onCompact={onCompact} />);
    await user.click(screen.getByRole('button', { name: 'Context mode: Standard' }));
    // Arrow keys reach it after the two radios.
    await user.keyboard('{ArrowDown}{ArrowDown}');
    expect(screen.getByRole('menuitem', { name: /Compact now/ })).toHaveFocus();
    await user.click(screen.getByRole('menuitem', { name: /Compact now/ }));
    expect(onCompact).toHaveBeenCalledTimes(1);
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.queryByRole('menu')).toBeNull();
    // Focus went back to the chip rather than dying with the unmounted item.
    expect(screen.getByRole('button', { name: 'Context mode: Standard' })).toHaveFocus();
  });

  it('warns that switching DOWN past Standard\'s compaction point compacts on the next turn — at a cost', async () => {
    const user = userEvent.setup();
    render(<ContextModeControl mode="expansive" option={OPUS_1M} engine="claude" onChange={vi.fn()}
      budget={{ contextTokens: 600_000, exact: true, contextWindow: 1_000_000, autoCompactAt: 967_000 }} />);
    await user.click(screen.getByRole('button', { name: 'Context mode: Expansive' }));
    const menu = screen.getByRole('menu', { name: 'Context mode' });
    expect(within(menu).getByRole('menuitemradio', { name: /Standard/ })).toHaveTextContent('compacts on the next turn');
    const warn = within(menu).getByTestId('standard-compacts');
    expect(warn).toHaveTextContent('This chat holds ≈600k — past Standard\'s ≈367k compaction point, so switching to Standard makes Claude Code compact on the next turn: one summarization call that spends usage on this seat.');
    expect(warn).toHaveTextContent('prompt cache starts over');
    // …and the "cache is kept" promise is NOT made in that case.
    expect(menu).not.toHaveTextContent('prompt cache are kept');
  });

  it('keeps the free-switch copy below the point, hedges an upper bound, and names codex\'s two settings', async () => {
    expect(standardSwitchCompacts(OPUS_1M, 'expansive', { contextTokens: 300_000, exact: true })).toBeNull();
    expect(standardSwitchCompacts(OPUS_1M, 'standard', { contextTokens: 900_000, exact: true })).toBeNull();
    expect(standardSwitchCompacts(OPUS_1M, 'expansive', { contextTokens: 400_000, exact: false })).toEqual({ point: 367_000, tokens: 400_000, definite: false });

    const user = userEvent.setup();
    const { unmount } = render(<ContextModeControl mode="expansive" option={OPUS_1M} engine="claude" onChange={vi.fn()}
      budget={{ contextTokens: 300_000, exact: true, contextWindow: 1_000_000, autoCompactAt: 967_000 }} />);
    await user.click(screen.getByRole('button', { name: 'Context mode: Expansive' }));
    expect(screen.getByRole('menu')).toHaveTextContent("Applies from the next turn. Only the CLI's compaction flag changes — the conversation and its prompt cache are kept.");
    expect(screen.queryByTestId('standard-compacts')).toBeNull();
    unmount();

    const second = render(<ContextModeControl mode="expansive" option={GPT6} engine="codex" onChange={vi.fn()}
      budget={{ contextTokens: 400_000, exact: false, contextWindow: 828_400, autoCompactAt: 784_800 }} />);
    await user.click(screen.getByRole('button', { name: 'Context mode: Expansive' }));
    expect(screen.getByRole('menuitemradio', { name: /Standard/ })).toHaveTextContent('may compact on the next turn');
    expect(screen.getByTestId('standard-compacts')).toHaveTextContent('This chat holds up to ≈400k. If the real prompt is past Standard\'s ≈245k compaction point');
    second.unmount();

    render(<ContextModeControl mode="standard" option={GPT6} engine="codex" onChange={vi.fn()}
      budget={{ contextTokens: 100_000, exact: true, contextWindow: 258_400, autoCompactAt: 244_800 }} />);
    await user.click(screen.getByRole('button', { name: 'Context mode: Standard' }));
    expect(screen.getByRole('menu')).toHaveTextContent("The CLI's window and compaction settings change");
  });

  it('is a "Context" menu with only "Compact now…" for a model with one budget', async () => {
    const user = userEvent.setup();
    const onCompact = vi.fn();
    const { unmount } = render(<ContextModeControl mode="standard" option={LOCAL_SEAT.models[0]!} modesAvailable={false} engine="local"
      budget={{ contextTokens: 20_000, exact: true, contextWindow: 65_536, autoCompactAt: 32_536 }} onChange={vi.fn()} onCompact={onCompact} />);
    const chip = screen.getByRole('button', { name: 'Context actions' });
    expect(chip).toHaveTextContent('Context');
    expect(chip).not.toHaveAttribute('data-mode');
    await user.click(chip);
    const menu = screen.getByRole('menu', { name: 'Context' });
    expect(within(menu).queryByRole('menuitemradio')).toBeNull();
    expect(menu).toHaveTextContent('Claude Code (driving the local model) compacts this chat on its own at ≈33k of 66k.');
    const item = within(menu).getByRole('menuitem', { name: /Compact now/ });
    expect(item).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(onCompact).toHaveBeenCalledTimes(1);
    unmount();

    // No turns yet: listed, disabled, and saying why — focus parks on the menu, not <body>.
    render(<ContextModeControl mode="standard" option={CLAUDE_SEAT.models[0]!} modesAvailable={false} engine="claude"
      compactUnavailableReason="nothing to compact yet — this chat has no turns" onChange={vi.fn()} onCompact={onCompact} />);
    await user.click(screen.getByRole('button', { name: 'Context actions' }));
    const disabled = screen.getByRole('menuitem', { name: /Compact now/ });
    expect(disabled).toBeDisabled();
    expect(disabled).toHaveTextContent('nothing to compact yet');
    expect(screen.getByRole('menu', { name: 'Context' })).toHaveFocus();
  });
});

describe('mode menu placement', () => {
  const VIEW = { width: 375, height: 812 };

  it('right-aligns to the chip when there is room, as on a desktop', () => {
    expect(modeMenuPlacement({ left: 1100, right: 1170, bottom: 40 }, { width: 1400, height: 900 }))
      .toMatchObject({ position: 'fixed', top: 48, right: 230, left: 'auto', maxWidth: 380 });
  });

  it('spans the gutters at phone width instead of starting off-screen', () => {
    // The chip's right edge at 375px is ~256 (reviewer measurement): anchored right it began at x = −95.
    const p = modeMenuPlacement({ left: 186, right: 256, bottom: 40 }, VIEW)!;
    expect(p).toMatchObject({ position: 'fixed', left: MODE_MENU_GUTTER, right: MODE_MENU_GUTTER, width: 'auto', minWidth: 0 });
    expect(p.maxHeight).toBe(812 - 48 - MODE_MENU_GUTTER);
  });

  it('flips to left-aligned when only the right side has room, and stands down without layout', () => {
    expect(modeMenuPlacement({ left: 60, right: 130, bottom: 40 }, { width: 800, height: 600 }))
      .toMatchObject({ left: 60, right: 'auto', maxWidth: 380 });
    expect(modeMenuPlacement({ left: 0, right: 0, bottom: 0 }, VIEW)).toBeNull();
  });

  it('applies the measured placement to the open menu', async () => {
    const user = userEvent.setup();
    const width = window.innerWidth;
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 375 });
    try {
      render(<ContextModeControl mode="standard" option={OPUS_1M} onChange={vi.fn()} />);
      const chip = screen.getByRole('button', { name: 'Context mode: Standard' });
      chip.getBoundingClientRect = () => ({ left: 186, right: 256, top: 10, bottom: 40, width: 70, height: 30, x: 186, y: 10, toJSON: () => ({}) });
      await user.click(chip);
      const menu = screen.getByRole('menu');
      expect(menu).toHaveAttribute('data-placement', 'fixed');
      expect(menu.style.position).toBe('fixed');
      expect(menu.style.left).toBe(`${MODE_MENU_GUTTER}px`);
      expect(menu.style.right).toBe(`${MODE_MENU_GUTTER}px`);
    } finally {
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
    }
  });
});

describe('expansiveCostCopy', () => {
  it('prices codex with the same reported-metering sentence as the new-chat dialog', () => {
    const codex = expansiveCostCopy(GPT6, 'codex');
    expect(codex).toContain('up to ≈3.2× by size alone near the expansive limit');
    expect(codex.endsWith(CODEX_EXPANSIVE_METERING_NOTE)).toBe(true);
    expect(CODEX_EXPANSIVE_METERING_NOTE).toMatch(/reportedly .* 272k .* about 2×/);
    const claude = expansiveCostCopy(OPUS_1M, 'claude');
    expect(claude).toContain('up to ≈2.6× near the expansive limit');
    expect(claude).not.toContain(CODEX_EXPANSIVE_METERING_NOTE);
  });
});

describe('expansiveCostRatio', () => {
  it('is the ratio of the two compaction points, and null without a real expansive mode', () => {
    expect(expansiveCostRatio(OPUS_1M)).toBe(2.6); // 967k / 367k
    expect(expansiveCostRatio(GPT6)).toBe(3.2); // 784.8k / 244.8k
    expect(expansiveCostRatio(CODEX_EXPANSIVE_SEAT.models[1])).toBeNull();
    expect(expansiveCostRatio(GROK_SEAT.models[0])).toBeNull();
    expect(expansiveCostRatio(null)).toBeNull();
  });
});

describe('ContextAdvice', () => {
  beforeEach(() => resetVerseUi());

  const NOW = Date.parse('2026-09-23T12:00:00.000Z');
  function near(over: Parameters<typeof session>[0] = {}) {
    return session({
      id: 'vs_near',
      seatId: 'claude-a',
      model: 'claude-opus-5',
      updatedAt: '2026-09-23T11:59:00.000Z',
      usage: { ...session().usage, contextTokens: 300_000 },
      ...over,
    });
  }

  function renderAdvice(s = near(), extra: Partial<Parameters<typeof ContextAdvice>[0]> = {}) {
    const onHandoff = vi.fn();
    const onSwitchExpansive = vi.fn();
    const budget = sessionContextBudget([CLAUDE_1M_SEAT], s);
    const view = render(<ContextAdvice session={s} budget={budget} modesAvailable dispatchEnabled now={NOW}
      onHandoff={onHandoff} onSwitchExpansive={onSwitchExpansive} {...extra} />);
    return { view, onHandoff, onSwitchExpansive, budget };
  }

  it('says nothing for a comfortable session', () => {
    const { view } = renderAdvice(near({ usage: { ...session().usage, contextTokens: 40_000 } }));
    expect(view.container).toBeEmptyDOMElement();
  });

  it('suggests a fresh chat near the compaction point, lists why, and opens the handoff on click', async () => {
    const user = userEvent.setup();
    const { onHandoff } = renderAdvice();
    const note = screen.getByRole('region', { name: 'Context advice' });
    expect(note).toHaveAttribute('data-level', 'suggest');
    expect(note).toHaveTextContent('Consider continuing in a fresh chat');
    expect(note).toHaveTextContent('About 67k tokens left before the CLI auto-compacts.');
    expect(note).toHaveTextContent('free. Nothing is sent until you press Send');
    await user.click(within(note).getByRole('button', { name: 'Continue in a fresh chat…' }));
    expect(onHandoff).toHaveBeenCalledTimes(1);
  });

  it('urges past the window, and cannot hand off mid-turn', () => {
    renderAdvice(near({ status: 'running', usage: { ...session().usage, contextTokens: 1_100_000 } }));
    const note = screen.getByRole('region', { name: 'Context advice' });
    expect(note).toHaveAttribute('data-level', 'urge');
    expect(note).toHaveTextContent('Time to continue in a fresh chat');
    expect(within(note).getByRole('button', { name: 'Continue in a fresh chat…' })).toBeDisabled();
  });

  it('flags an idle session whose prompt cache has expired — timed from the last TURN, not updatedAt', () => {
    // updatedAt is fresh (a rename or a mode switch a minute ago); the provider
    // last saw a request at 10:30, so the cache is cold all the same.
    const { view } = renderAdvice(near({ usage: { ...session().usage, contextTokens: 150_000 } }), { lastTurnAt: '2026-09-23T10:30:00.000Z' });
    const note = screen.getByRole('region', { name: 'Context advice' });
    expect(note).toHaveTextContent('Idle over an hour');
    expect(note).toHaveTextContent('re-reads the whole context at full cost');
    view.unmount();
    // A recent turn: warm. No turn at all: nothing to expire.
    const recent = renderAdvice(near({ updatedAt: '2026-09-23T10:30:00.000Z', usage: { ...session().usage, contextTokens: 150_000 } }), { lastTurnAt: '2026-09-23T11:50:00.000Z' });
    expect(screen.queryByRole('region', { name: 'Context advice' })).toBeNull();
    recent.view.unmount();
    renderAdvice(near({ updatedAt: '2026-09-23T10:30:00.000Z', usage: { ...session().usage, contextTokens: 150_000 } }));
    expect(screen.queryByRole('region', { name: 'Context advice' })).toBeNull();
  });

  it('never urges a handoff on an upper-bound reading past the window', () => {
    const codex = session({ id: 'vs_cx', engine: 'codex', seatId: CODEX_EXPANSIVE_SEAT.id, model: 'gpt-6-astra', contextMode: 'standard',
      usage: { ...session().usage, contextTokens: 697_060, contextTokensExact: false } });
    const budget = sessionContextBudget([CODEX_EXPANSIVE_SEAT], codex);
    expect(sessionHandoffAdvice(codex, budget, NOW, '2026-09-23T08:00:00.000Z')).toEqual({ level: 'none', reasons: [] });
    render(<ContextAdvice session={codex} budget={budget} modesAvailable dispatchEnabled now={NOW} lastTurnAt="2026-09-23T08:00:00.000Z"
      onHandoff={vi.fn()} onSwitchExpansive={vi.fn()} />);
    expect(screen.queryByRole('region', { name: 'Context advice' })).toBeNull();
  });

  it('"Not now" hides a note until its evidence escalates', async () => {
    const user = userEvent.setup();
    const { view } = renderAdvice();
    await user.click(screen.getByRole('button', { name: 'Not now' }));
    expect(screen.queryByRole('region', { name: 'Context advice' })).toBeNull();
    // Same evidence on a later render: still dismissed.
    const again = near();
    view.rerender(<ContextAdvice session={again} budget={sessionContextBudget([CLAUDE_1M_SEAT], again)} modesAvailable dispatchEnabled now={NOW}
      onHandoff={vi.fn()} onSwitchExpansive={vi.fn()} />);
    expect(screen.queryByRole('region', { name: 'Context advice' })).toBeNull();
    // Escalated to urge: it comes back.
    const over = near({ usage: { ...session().usage, contextTokens: 1_200_000 } });
    view.rerender(<ContextAdvice session={over} budget={sessionContextBudget([CLAUDE_1M_SEAT], over)} modesAvailable dispatchEnabled now={NOW}
      onHandoff={vi.fn()} onSwitchExpansive={vi.fn()} />);
    expect(screen.getByRole('region', { name: 'Context advice' })).toHaveAttribute('data-level', 'urge');
  });

  it('suggests expansive after repeated compaction — with the cost — and never switches by itself', async () => {
    const user = userEvent.setup();
    const { onSwitchExpansive } = renderAdvice(near({ compactionCount: 2, usage: { ...session().usage, contextTokens: 20_000 } }));
    const chip = screen.getByRole('region', { name: 'Expansive mode suggestion' });
    expect(chip).toHaveTextContent('This session has compacted 2 times');
    expect(chip).toHaveTextContent('up to ≈2.6×');
    expect(chip).not.toHaveTextContent('reportedly');
    expect(onSwitchExpansive).not.toHaveBeenCalled();
    await user.click(within(chip).getByRole('button', { name: 'Switch to expansive' }));
    expect(onSwitchExpansive).toHaveBeenCalledTimes(1);
  });

  it('cannot switch to expansive mid-turn — the engine answers 409 to a mode change while a turn runs', () => {
    renderAdvice(near({ status: 'running', compactionCount: 2, usage: { ...session().usage, contextTokens: 20_000 } }));
    const chip = screen.getByRole('region', { name: 'Expansive mode suggestion' });
    const button = within(chip).getByRole('button', { name: 'Switch to expansive' });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('title', 'Available when the current turn finishes');
  });

  it('offers "Compact now…" beside the handoff only when given the action, and not mid-turn', async () => {
    const user = userEvent.setup();
    const { view } = renderAdvice();
    expect(screen.queryByRole('button', { name: 'Compact now…' })).toBeNull();
    view.unmount();

    const onCompact = vi.fn();
    const second = renderAdvice(near(), { onCompact });
    await user.click(within(screen.getByRole('region', { name: 'Context advice' })).getByRole('button', { name: 'Compact now…' }));
    expect(onCompact).toHaveBeenCalledTimes(1);
    second.view.unmount();

    renderAdvice(near({ status: 'running' }), { onCompact });
    expect(screen.getByRole('button', { name: 'Compact now…' })).toBeDisabled();
  });

  it('offers no expansive chip where the mode control does not exist', () => {
    renderAdvice(near({ compactionCount: 2, usage: { ...session().usage, contextTokens: 20_000 } }), { modesAvailable: false });
    expect(screen.queryByRole('region', { name: 'Expansive mode suggestion' })).toBeNull();
    // The handoff note (two compactions) still stands on its own.
    expect(screen.getByRole('region', { name: 'Context advice' })).toHaveTextContent('Compacted 2 times');
  });

  it('computes the handoff verdict from the same budget the meter draws', () => {
    const s = near();
    const budget = sessionContextBudget([CLAUDE_1M_SEAT], s);
    expect(sessionHandoffAdvice(s, budget, NOW).level).toBe('suggest');
    // Against the stored 200k window a 300k reading would be `over`; the catalog budget says otherwise.
    expect(sessionHandoffAdvice(s, budget, NOW).reasons.join(' ')).not.toContain('past the');
  });
});

describe('fixtures carry honest v3.9 budgets', () => {
  it('matches the context-math formulas for each engine', () => {
    expect(CLAUDE_SEAT.models[0]!.autoCompactAt).toBe(167_000);
    expect(OPUS_1M.autoCompactAt).toBe(367_000);
    expect(OPUS_1M.expansive?.autoCompactAt).toBe(967_000);
    expect(GPT6.contextWindow).toBe(258_400);
    expect(GPT6.expansive).toEqual({ contextWindow: 828_400, autoCompactAt: 784_800, providerWindow: 872_000 });
    expect(LOCAL_SEAT.models[0]!.contextWindow).toBe(65_536);
  });
});

describe('Compact now', () => {
  it('is offered only where the CLI compacts on request: Claude Code, including the local lane', () => {
    expect(canCompactNow('claude')).toBe(true);
    expect(canCompactNow('local')).toBe(true);
    // codex exec has no compact verb; grok's headless /compact is unverified.
    expect(canCompactNow('codex')).toBe(false);
    expect(canCompactNow('grok')).toBe(false);
    expect(canCompactNow(null)).toBe(false);
  });

  it('builds the slash command, folding the focus to one line', () => {
    expect(compactCommand('')).toBe('/compact');
    expect(compactCommand('   ')).toBe('/compact');
    expect(compactCommand('  keep the login fix\n\nand its TODOs ')).toBe('/compact keep the login fix and its TODOs');
    expect(compactCommand('x'.repeat(COMPACT_FOCUS_MAX + 50))).toBe(`/compact ${'x'.repeat(COMPACT_FOCUS_MAX)}`);
  });

  it('states the cost honestly per engine', () => {
    expect(compactCostCopy('claude', '≈300k')).toBe('Spends usage on this seat: one summarization call that reads the whole current context (≈300k tokens) and writes the summary.');
    expect(compactCostCopy('local', '≈40k')).toMatch(/^Free — it runs on the local model — but .* can take minutes/);
  });

  const BUDGET = { contextTokens: 300_000, autoCompactAt: 367_000, exact: true };

  it('sends /compact with the focus through onSend and closes once accepted', async () => {
    const user = userEvent.setup();
    const onSend = vi.fn(async () => true);
    const onClose = vi.fn();
    render(<CompactPanel engine="claude" budget={BUDGET} running={false} dispatchEnabled empty={false} onSend={onSend} onClose={onClose} />);
    const panel = screen.getByRole('region', { name: 'Compact this chat' });
    expect(panel).toHaveTextContent('Claude Code replaces the conversation so far with a summary');
    expect(panel).toHaveTextContent('at ≈367k');
    expect(panel).toHaveTextContent('Spends usage on this seat');
    expect(panel).toHaveTextContent('(≈300k tokens)');
    await user.type(screen.getByLabelText('Keep in focus (optional)'), 'the auth refactor');
    expect(panel).toHaveTextContent('Sent as the message /compact the auth refactor');
    await user.click(screen.getByRole('button', { name: 'Compact now' }));
    expect(onSend).toHaveBeenCalledWith('/compact the auth refactor');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('stays open when the send is not accepted (token dialog dismissed, refusal)', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<CompactPanel engine="local" budget={BUDGET} running={false} dispatchEnabled empty={false} onSend={vi.fn(async () => false)} onClose={onClose} />);
    await user.click(screen.getByRole('button', { name: 'Compact now' }));
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Compact now' })).toBeEnabled();
  });

  it('says a local compaction is free but slow, and marks an upper-bound size with ≤', () => {
    render(<CompactPanel engine="local" budget={{ ...BUDGET, contextTokens: 40_000, exact: false }} running={false} dispatchEnabled empty={false}
      onSend={vi.fn(async () => true)} onClose={vi.fn()} />);
    const panel = screen.getByRole('region', { name: 'Compact this chat' });
    expect(panel).toHaveTextContent('Claude Code (driving the local model) replaces');
    expect(panel).toHaveTextContent('Free — it runs on the local model');
    expect(panel).toHaveTextContent('≤40k tokens');
    expect(panel).not.toHaveTextContent('Spends usage');
  });

  it('is disabled mid-turn, on a read-only server and on a chat with no turns — and sends nothing', async () => {
    const user = userEvent.setup();
    const onSend = vi.fn(async () => true);
    const { rerender } = render(<CompactPanel engine="claude" budget={BUDGET} running dispatchEnabled empty={false} onSend={onSend} onClose={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Compact now' })).toBeDisabled();
    expect(screen.getByRole('status')).toHaveTextContent('Available when the current turn finishes.');
    rerender(<CompactPanel engine="claude" budget={BUDGET} running={false} dispatchEnabled={false} empty={false} onSend={onSend} onClose={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Compact now' })).toBeDisabled();
    expect(screen.getByRole('status')).toHaveTextContent('started without dispatch');
    rerender(<CompactPanel engine="claude" budget={BUDGET} running={false} dispatchEnabled empty onSend={onSend} onClose={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Compact now' })).toBeDisabled();
    expect(screen.getByRole('status')).toHaveTextContent('Nothing to compact yet');
    // Enter in the focus field submits the form — and must be refused too.
    await user.type(screen.getByLabelText('Keep in focus (optional)'), 'x{Enter}');
    expect(onSend).not.toHaveBeenCalled();
  });
});
