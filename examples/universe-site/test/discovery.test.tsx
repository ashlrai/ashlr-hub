import { afterEach, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { renderDiscovery } from '../scripts/generate-discovery.mjs';
import site from '../app/site-config.json';
import guide from '../app/data/documentation.json';
import Docs from '../app/docs/page';
import { pageMetadata, projectSchema } from '../app/seo';

afterEach(cleanup);
it('renders every canonical task as a navigable guide with matching download links', () => {
  render(<Docs />);
  for (const task of guide.tasks) {
    expect(screen.getByRole('heading', { name: task.title })).toBeDefined();
    expect(
      screen.getByRole('link', { name: task.label }).getAttribute('href'),
    ).toBe(task.href);
  }
  expect(
    screen.getByRole('link', { name: 'Plain-text guide' }).getAttribute('href'),
  ).toBe('/agent-guide.md');
  expect(
    screen
      .getByRole('link', { name: 'Structured task index' })
      .getAttribute('href'),
  ).toBe('/agent-map.json');
  expect(
    screen.getByRole('link', { name: 'Field guide', current: 'page' }),
  ).toBeDefined();
});
it('keeps generated formats byte-identical to the authored task map', () => {
  const files = renderDiscovery(site, guide);
  for (const [name, content] of Object.entries(files))
    expect(readFileSync(resolve('public', name), 'utf8')).toBe(content);
  expect(JSON.parse(files['agent-map.json'])).toEqual(guide);
  for (const task of guide.tasks)
    expect(files['agent-guide.md']).toContain(task.href);
});
it('keeps the owner-private page out of its sitemap without blocking the noindex directive', () => {
  const files = renderDiscovery({ ...site, indexable: false }, guide);
  expect(files['robots.txt']).toContain('Allow: /');
  expect(files['robots.txt']).not.toContain('Sitemap:');
  expect(files['sitemap.xml']).not.toContain('<loc>');
  expect(pageMetadata('/docs/').robots).toEqual({
    index: site.indexable,
    follow: true,
  });
});
it('produces only verified-origin canonical pages when indexing is explicitly enabled', () => {
  const files = renderDiscovery(
    { ...site, origin: 'https://example.com', indexable: true },
    guide,
  );
  expect(files['sitemap.xml'].match(/<loc>/g)).toHaveLength(2);
  expect(files['sitemap.xml']).toContain(
    '<loc>https://example.com/docs/</loc>',
  );
  expect(files['sitemap.xml']).not.toContain('lastmod');
  expect(files['robots.txt']).toContain(
    'Sitemap: https://example.com/sitemap.xml',
  );
});
it('rejects ambiguous origins and indexing policies', () => {
  for (const origin of [
    'http://example.com',
    'https://example.com/path',
    'https://name:secret@example.com',
    'https://example.com/',
  ]) {
    expect(() => renderDiscovery({ ...site, origin }, guide)).toThrow();
  }
  expect(() =>
    renderDiscovery({ ...site, indexable: 'true' }, guide),
  ).toThrow();
});
it('gives each route its own canonical and factual project metadata without invented ratings', () => {
  expect(pageMetadata('/docs/').alternates?.canonical).toBe(
    site.origin + '/docs/',
  );
  expect(pageMetadata('/').openGraph).toMatchObject({
    url: site.origin + '/',
    siteName: 'Ashlrverse',
  });
  expect(projectSchema['@type']).toBe('SoftwareSourceCode');
  expect(projectSchema.codeRepository).toBe(site.repository);
  expect(projectSchema).not.toHaveProperty('aggregateRating');
});
