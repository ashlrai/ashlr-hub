import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MessageMarkdown, renderMarkdown } from './MessageMarkdown.js';

afterEach(() => {
  vi.unstubAllGlobals();
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
});
