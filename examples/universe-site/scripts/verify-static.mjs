import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const root = fileURLToPath(new URL('../', import.meta.url));
const site = JSON.parse(
  readFileSync(resolve(root, 'app/site-config.json'), 'utf8'),
);
for (const [file, path] of [
  ['index.html', '/'],
  ['docs/index.html', '/docs/'],
]) {
  const document = new JSDOM(
    readFileSync(resolve(root, 'dist/client', file), 'utf8'),
  ).window.document;
  assert.equal(
    document.querySelector('link[rel=canonical]')?.href,
    site.origin + path,
    `Canonical for ${path}`,
  );
  assert.equal(
    document.querySelector('meta[name=robots]')?.content,
    `${site.indexable ? 'index' : 'noindex'}, follow`,
    `Robots for ${path}`,
  );
  assert.equal(
    document.querySelectorAll('h1').length,
    1,
    `One page heading for ${path}`,
  );
  assert.ok(document.title.includes('Ashlrverse'));
  assert.ok(document.querySelector('meta[name=description]')?.content);
  assert.equal(
    document.querySelector('meta[property="og:url"]')?.content,
    site.origin + path,
  );
  for (const image of document.querySelectorAll('img[src^="/"]')) {
    assert.ok(
      existsSync(
        resolve(root, 'dist/client', image.getAttribute('src').slice(1)),
      ),
      'Local image exists',
    );
  }
  for (const link of document.querySelectorAll('a[href^="/"]')) {
    const destination = link.getAttribute('href').split('#')[0];
    const filePath = destination.endsWith('/')
      ? destination + 'index.html'
      : destination;
    assert.ok(
      existsSync(resolve(root, 'dist/client', filePath.slice(1))),
      `Static link exists: ${destination}`,
    );
  }
  if (path === '/') {
    const schema = JSON.parse(
      document.querySelector('script[type="application/ld+json"]').textContent,
    );
    assert.equal(schema['@type'], 'SoftwareSourceCode');
    assert.equal(schema.codeRepository, site.repository);
  }
}
for (const file of [
  'agent-guide.md',
  'agent-map.json',
  'llms.txt',
  'robots.txt',
  'sitemap.xml',
]) {
  assert.equal(
    readFileSync(resolve(root, 'dist/client', file), 'utf8'),
    readFileSync(resolve(root, 'public', file), 'utf8'),
    `Published discovery file: ${file}`,
  );
}
console.log(
  'Verified two static pages: metadata, canonical URLs, project schema, local links, images and discovery resources.',
);
