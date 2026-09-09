import { afterEach, expect, it } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { ProviderEcosystem } from '../app/provider-ecosystem';
afterEach(cleanup);

it('renders four providers with distinct integration capabilities rather than connection status', () => {
  render(<ProviderEcosystem />);
  const providers = within(
    screen.getByRole('list', { name: 'Provider integration capabilities' }),
  ).getAllByRole('listitem');
  expect(providers).toHaveLength(4);
  const grok = providers.find((item) =>
    item.textContent?.includes('Grok Build'),
  )!;
  expect(grok.textContent).toContain('Task execution is not yet available');
  expect(grok.textContent).not.toContain('Native worker adapter');
  expect(
    screen.getByText(/Browser sign-in alone does not enroll a worker/),
  ).toBeDefined();
});
it('serves unchanged brand files locally and labels model families as examples', () => {
  const { container } = render(<ProviderEcosystem />);
  const images = [...container.querySelectorAll('img')];
  expect(images).toHaveLength(4);
  expect(
    images.every((image) => image.getAttribute('src')?.startsWith('/brands/')),
  ).toBe(true);
  for (const name of ['Llama', 'Qwen', 'Gemma', 'DeepSeek'])
    expect(screen.getByRole('link', { name }).getAttribute('href')).toMatch(
      /^https:\/\/ollama.com\/library\//,
    );
  expect(
    screen.getByText(/not universal compatibility certifications/),
  ).toBeDefined();
});
