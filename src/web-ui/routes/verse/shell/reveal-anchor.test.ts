/**
 * reveal-anchor — "go to that card" (unit C1; C7 cross-unit request 3).
 *
 * Pinned: C7's `c7-anchor-*` ids and the generic `data-verse-anchor` both
 * resolve; the search is scoped to the named surface (a same-keyed card on a
 * hidden keep-alive surface never wins); a late-mounting surface is waited
 * for; a missing anchor gives up quietly; only focusable targets take focus.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { anchorId } from '../command/nav.js';
import { VERSE_ANCHOR_EVENT } from '../verse-ui-store.js';
import { subscribeAnchorRequests } from './anchor-requests.js';
import { findAnchorElement, revealAnchor } from './reveal-anchor.js';

function surface(id: string, hidden = false): HTMLElement {
  const el = document.createElement('div');
  el.setAttribute('data-surface', id);
  if (hidden) el.hidden = true;
  document.body.appendChild(el);
  return el;
}

type Card = HTMLElement & { scrollIntoView: ReturnType<typeof vi.fn<(arg?: boolean | ScrollIntoViewOptions) => void>> };

function card(attrs: Record<string, string>, focusable = false): Card {
  const el = document.createElement(focusable ? 'button' : 'div');
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  const scroll = vi.fn<(arg?: boolean | ScrollIntoViewOptions) => void>();
  el.scrollIntoView = scroll;
  return Object.assign(el, { scrollIntoView: scroll });
}

afterEach(() => {
  document.body.innerHTML = '';
  vi.useRealTimers();
});

describe('reveal-anchor', () => {
  it('finds C7’s id form and the generic data attribute, on the named surface only', () => {
    const mind = surface('mind');
    const fleet = surface('fleet', true);
    const other = card({ id: anchorId('memo:m-7') });
    fleet.appendChild(other);
    expect(findAnchorElement('mind', 'memo:m-7')).toBeNull();
    const memo = card({ id: anchorId('memo:m-7') });
    mind.appendChild(memo);
    expect(findAnchorElement('mind', 'memo:m-7')).toBe(memo);
    const seat = card({ 'data-verse-anchor': 'seat:claude-a' });
    surface('apps').appendChild(seat);
    expect(findAnchorElement('apps', 'seat:claude-a')).toBe(seat);
  });

  it('scrolls a present anchor into view at once, and focuses it only when it can take focus', async () => {
    const mind = surface('mind');
    const plain = card({ id: anchorId('a') });
    const button = card({ id: anchorId('b') }, true);
    mind.append(plain, button);
    await expect(revealAnchor({ section: 'mind', anchor: 'a' })).resolves.toBe(true);
    expect(plain.scrollIntoView).toHaveBeenCalledWith({ block: 'center', behavior: 'smooth' });
    expect(document.activeElement).not.toBe(plain);
    await revealAnchor({ section: 'mind', anchor: 'b' });
    expect(document.activeElement).toBe(button);
  });

  it('waits for a surface that mounts (and un-hides) after the request', async () => {
    const pending = revealAnchor({ section: 'growth', anchor: 'exp:9' }, 1_000);
    const growth = surface('growth', true);
    const target = card({ id: anchorId('exp:9') });
    growth.appendChild(target);
    await Promise.resolve();
    expect(target.scrollIntoView).not.toHaveBeenCalled(); // still hidden
    growth.hidden = false;
    await expect(pending).resolves.toBe(true);
    expect(target.scrollIntoView).toHaveBeenCalledTimes(1);
  });

  it('gives up quietly when the anchor never appears', async () => {
    vi.useFakeTimers();
    surface('command');
    const pending = revealAnchor({ section: 'command', anchor: 'nope' }, 500);
    vi.advanceTimersByTime(600);
    await expect(pending).resolves.toBe(false);
  });

  it('the shell listener ignores malformed requests', async () => {
    const off = subscribeAnchorRequests(VERSE_ANCHOR_EVENT);
    try {
      const mind = surface('mind');
      const target = card({ id: anchorId('ok') });
      mind.appendChild(target);
      window.dispatchEvent(new CustomEvent(VERSE_ANCHOR_EVENT, { detail: { section: 'mind' } }));
      window.dispatchEvent(new CustomEvent(VERSE_ANCHOR_EVENT, { detail: 'mind:ok' }));
      window.dispatchEvent(new CustomEvent(VERSE_ANCHOR_EVENT, { detail: { section: 'mind', anchor: 'x'.repeat(201) } }));
      expect(target.scrollIntoView).not.toHaveBeenCalled();
      window.dispatchEvent(new CustomEvent(VERSE_ANCHOR_EVENT, { detail: { section: 'mind', anchor: 'ok' } }));
      expect(target.scrollIntoView).toHaveBeenCalledTimes(1);
    } finally {
      off();
    }
  });

  it('a request that arrives before the reveal module has loaded is still revealed', async () => {
    // anchor-requests preloads reveal-anchor; a fresh module instance has
    // not finished that import when the first event is dispatched below.
    vi.resetModules();
    const fresh = await import('./anchor-requests.js');
    const off = fresh.subscribeAnchorRequests(VERSE_ANCHOR_EVENT);
    try {
      const mind = surface('mind');
      const target = card({ id: anchorId('early') });
      mind.appendChild(target);
      window.dispatchEvent(new CustomEvent(VERSE_ANCHOR_EVENT, { detail: { section: 'mind', anchor: 'early' } }));
      await vi.waitFor(() => expect(target.scrollIntoView).toHaveBeenCalledTimes(1));
    } finally {
      off();
    }
  });
});
