import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { JSDOM } from 'jsdom';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const site = resolve(root, 'site');
const html = readFileSync(resolve(site, 'ecosystem.html'), 'utf8');
const history = readFileSync(resolve(site, 'assets/star-history.js'), 'utf8');
const chartScript = readFileSync(resolve(site, 'assets/ecosystem.js'), 'utf8');

type Snapshot = {
  asOf: string;
  repos: Array<{ repo: string; stars: number; days: string[]; url: string }>;
};

function mount(withHistory = true) {
  const dom = new JSDOM(html, {
    url: 'https://verse.ashlr.ai/ecosystem',
    runScripts: 'outside-only',
  });
  Object.defineProperty(dom.window, 'matchMedia', {
    value: () => ({ matches: false }),
  });
  if (withHistory) dom.window.eval(history);
  dom.window.eval(chartScript);
  return dom;
}

describe('static ecosystem page', () => {
  it('keeps local assets, canonical route, and sitemap entry intact', () => {
    const dom = new JSDOM(html);
    const document = dom.window.document;
    expect(document.querySelector('link[rel="canonical"]')?.getAttribute('href'))
      .toBe('https://verse.ashlr.ai/ecosystem');
    for (const element of document.querySelectorAll('[src], link[href]')) {
      const value = element.getAttribute('src') ?? element.getAttribute('href') ?? '';
      if (!value.startsWith('assets/') && !value.startsWith('/assets/')) continue;
      expect(value).not.toContain('..');
      expect(existsSync(resolve(site, value.replace(/^\//, ''))), value).toBe(true);
    }
    const sitemap = new JSDOM(
      readFileSync(resolve(site, 'sitemap.xml'), 'utf8'),
      { contentType: 'text/xml' },
    ).window.document;
    expect(sitemap.querySelector('parsererror')).toBeNull();
    const entries = [...sitemap.querySelectorAll('url')];
    expect(entries.map((entry) => entry.querySelector('loc')?.textContent)).toEqual([
      'https://verse.ashlr.ai/',
      'https://verse.ashlr.ai/ecosystem',
    ]);
    for (const entry of entries) {
      expect(entry.querySelector('lastmod')?.textContent).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it('renders six dated series and updates the chart controls', () => {
    const dom = mount();
    const document = dom.window.document;
    const snapshot = (dom.window as unknown as { ASHLR_STAR_SNAPSHOT: Snapshot }).ASHLR_STAR_SNAPSHOT;
    expect(snapshot.repos).toHaveLength(6);
    expect(new Set(snapshot.repos.map((repo) => repo.repo)).size).toBe(6);
    for (const repo of snapshot.repos) {
      expect(repo.url).toBe('https://github.com/ashlrai/' + repo.repo);
      expect(repo.days).toHaveLength(repo.stars);
      expect(document.querySelector('[data-series="' + repo.repo + '"]')).not.toBeNull();
      expect(document.querySelector('[data-repo="' + repo.repo + '"]')).not.toBeNull();
    }
    expect(document.getElementById('total-stars')?.textContent)
      .toBe(String(snapshot.repos.reduce((sum, repo) => sum + repo.stars, 0)));
    const ninetyDays = document.querySelector('[data-range="90d"]') as HTMLButtonElement;
    ninetyDays.click();
    expect(ninetyDays.getAttribute('aria-pressed')).toBe('true');
    const phantom = document.querySelector('[data-series="phantom"]') as HTMLButtonElement;
    phantom.click();
    expect(phantom.getAttribute('aria-pressed')).toBe('true');
    expect(document.getElementById('series-title')?.textContent).toBe('Phantom');
    const slider = document.getElementById('history-cursor') as HTMLInputElement;
    slider.value = '0';
    slider.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    expect(document.getElementById('history-reading')?.textContent).toMatch(/star/);
    expect(document.getElementById('history-path')?.getAttribute('d')).toMatch(/^M /);
  });

  it('fails visibly when the snapshot is unavailable', () => {
    const dom = mount(false);
    expect(dom.window.document.getElementById('data-notice')?.textContent).toMatch(/unavailable/);
    expect((dom.window.document.getElementById('star-chart') as HTMLElement).hidden).toBe(true);
  });
});
