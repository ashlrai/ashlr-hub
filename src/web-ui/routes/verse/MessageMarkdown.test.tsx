import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { loadMarkdownRenderer, MessageMarkdown, splitStreamingBlocks } from './MessageMarkdown.js';
import { renderMarkdown } from './MessageMarkdownRenderer.js';
import { subscribeOpenTerminal, type OpenTerminalRequest } from './shell/open-terminal-request.js';

// The renderer is its own chunk (3.10 first paint); these tests are about
// what it renders, so it is in before they mount.
beforeAll(() => loadMarkdownRenderer());

afterEach(() => {
  vi.unstubAllGlobals();
  vi.doUnmock('./MessageMarkdownRenderer.js');
  vi.resetModules();
});

describe('MessageMarkdown', () => {
  it('renders Markdown and strips scripts, handlers and unsafe URLs', () => {
    const html = renderMarkdown('# Title\n\nSome **bold** text <script>alert(1)</script> and <img src=x onerror="alert(2)"> [link](javascript:alert(3)) [ok](https://example.com)');
    expect(html).toContain('<h1>Title</h1>');
    expect(html).toContain('<strong>bold</strong>');
    expect(html).not.toContain('<script');
    expect(html).not.toContain('onerror');
    expect(html).not.toContain('javascript:');
    expect(html).toContain('href="https://example.com"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
  });

  it('keeps a verse://terminal link in the app and strips every other verse: href (3.15)', () => {
    const html = renderMarkdown('[the build](verse://terminal/t-ab12/b-3) [tab](verse://terminal/t-ab12) [bad](verse://settings) [shout](VERSE://terminal/t-ab12) [x](verse://terminal/t-ab12/b-1/../x)');
    const box = document.createElement('div');
    box.innerHTML = html;
    const [build, tab, bad, shout, x] = [...box.querySelectorAll('a')];
    expect(build!.getAttribute('href')).toBe('verse://terminal/t-ab12/b-3');
    expect(build!.hasAttribute('data-verse-terminal')).toBe(true);
    expect(build!.hasAttribute('target')).toBe(false);
    expect(tab!.getAttribute('href')).toBe('verse://terminal/t-ab12');
    for (const a of [bad, shout, x]) {
      expect(a!.hasAttribute('href'), a!.textContent ?? '').toBe(false);
    }
  });

  it('a click on a verse://terminal link opens the tab through the shell, never navigating', () => {
    const requests: OpenTerminalRequest[] = [];
    const off = subscribeOpenTerminal((r) => requests.push(r));
    try {
      render(<MessageMarkdown text={'See [the failing test](verse://terminal/t-ab12/b-3).'} />);
      const link = screen.getByRole('link', { name: 'the failing test' });
      const event = new MouseEvent('click', { bubbles: true, cancelable: true });
      link.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
      expect(requests).toEqual([{ tabId: 't-ab12', blockId: 'b-3', sessionId: null }]);
    } finally {
      off();
    }
  });

  it('adds a copy button to fenced code blocks that copies the code text', async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    render(<MessageMarkdown text={'Run this:\n\n```sh\nnpm test\n```'} />);
    const button = await screen.findByRole('button', { name: 'Copy code' });
    expect(button).toHaveTextContent('Copy');
    fireEvent.click(button);
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('npm test\n'));
    await waitFor(() => expect(button).toHaveTextContent('Copied'));
  });

  it('renders Markdown synchronously once the renderer chunk is in', () => {
    render(<MessageMarkdown text={'# Plan\n\nDo **it**'} />);
    expect(screen.getByRole('heading', { name: 'Plan' })).toBeInTheDocument();
    expect(document.querySelector('[data-markdown-pending]')).toBeNull();
  });

  it('still exports the pure streaming helpers for existing importers', () => {
    expect(splitStreamingBlocks('a\n\nb')).toEqual({ done: ['a'], tail: 'b', tailInFence: false });
  });
});

describe('MessageMarkdown — renderer loaded lazily (3.10 first paint)', () => {
  it('shows the whole message as plain text until the renderer lands, then Markdown', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    vi.resetModules();
    vi.doMock('./MessageMarkdownRenderer.js', async () => {
      const actual = await vi.importActual<typeof import('./MessageMarkdownRenderer.js')>('./MessageMarkdownRenderer.js');
      await gate;
      return actual;
    });
    const fresh = await import('./MessageMarkdown.js');
    const text = '# Plan\n\nRun <img src=x onerror="alert(1)"> **now**';
    render(<fresh.MessageMarkdown text={text} />);

    // Plain text, as React text: the tag is visible characters, never an element.
    const pendingBox = document.querySelector('[data-markdown-pending]')!;
    expect(pendingBox).toHaveTextContent('# Plan Run <img src=x onerror="alert(1)"> **now**');
    expect(pendingBox.querySelector('img')).toBeNull();
    expect(screen.queryByRole('heading')).toBeNull();

    await act(async () => { release(); await fresh.loadMarkdownRenderer(); });
    expect(await screen.findByRole('heading', { name: 'Plan' })).toBeInTheDocument();
    expect(document.querySelector('[data-markdown-pending]')).toBeNull();
    // The renderer's usual sanitizing applies from here (the handler is gone).
    expect(document.querySelector('[onerror]')).toBeNull();
  });

  it('a failed chunk load leaves the text readable and is retried by the next caller', async () => {
    let fail = true;
    vi.resetModules();
    vi.doMock('./MessageMarkdownRenderer.js', async () => {
      if (fail) throw new Error('chunk 404');
      return vi.importActual('./MessageMarkdownRenderer.js');
    });
    const fresh = await import('./MessageMarkdown.js');
    await expect(fresh.loadMarkdownRenderer()).rejects.toThrow();
    render(<fresh.MessageMarkdown text="**still here**" />);
    expect(document.querySelector('[data-markdown-pending]')).toHaveTextContent('**still here**');

    fail = false;
    vi.resetModules();
    await expect(fresh.loadMarkdownRenderer()).resolves.toHaveProperty('RenderedMarkdown');
  });
});

