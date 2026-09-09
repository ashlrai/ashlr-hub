import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath, URL as NodeURL } from 'node:url';
import { resolve } from 'node:path';

const root = fileURLToPath(new NodeURL('../', import.meta.url));
const read = (name) => JSON.parse(readFileSync(resolve(root, name), 'utf8'));

// All formats derive from the same authored task map. No runtime data, tokens,
// environment variables, current-time stamps or provider state enter this output.
export function renderDiscovery(site, guide) {
  const origin = new URL(site.origin);
  if (
    origin.protocol !== 'https:' ||
    origin.origin !== site.origin ||
    typeof site.indexable !== 'boolean'
  )
    throw new Error('Expected explicit HTTPS origin and indexing policy');
  const tasks = guide.tasks
    .map(
      (task) =>
        `## ${task.title}\n\n${task.description}\n\nEffect: ${task.effect}.\n\n[${task.label}](${task.href})`,
    )
    .join('\n\n');
  const markdown = `# ${guide.product} field guide\n\n${guide.scope}\n\n${guide.prerequisites}\n\n## Compatibility\n\nPackage: \`${guide.compatibility.package}\`. CLI: \`${guide.compatibility.cli}\`. SDK: \`${guide.compatibility.sdk}\`.\n\n## Discover your selected binary\n\n\`\`\`sh\n${guide.discoveryCommand}\n\`\`\`\n\n${guide.discoveryNote}\n\n${tasks}\n\n## Interpret evidence\n\n${guide.interpretation.map((line) => `- ${line}`).join('\n')}\n\nRecorded fixture source: \`${guide.evidence.sourceCommit}\`. ${guide.evidence.measurementScope}\n\n[Recorded evidence](${site.origin}${guide.evidence.path})\n`;
  const llms = `# ${site.name}\n\n> Open-source, local-first AI engineering. This is a documentation index, not an execution API or authorization.\n\n## Start here\n\n- [Field guide](${site.origin}/docs/): Human-readable task map.\n- [Plain-text guide](${site.origin}/agent-guide.md): The same task map in Markdown.\n- [Structured task index](${site.origin}/agent-map.json): Versioned documentation data.\n\n## Canonical guides\n\n${guide.tasks.map((task) => `- [${task.title}](${task.href}): ${task.description}`).join('\n')}\n\n## Optional\n\n- [Recorded demo evidence](${site.origin}${guide.evidence.path}): ${guide.evidence.measurementScope}\n`;
  // Crawl permission allows a crawler to see noindex. Hosted access controls—not
  // robots or this flag—keep owner-private material private.
  const robots = `User-agent: *\nAllow: /\n${site.indexable ? `\nSitemap: ${site.origin}/sitemap.xml\n` : ''}`;
  const locations = site.indexable
    ? ['/', '/docs/']
        .map((path) => `  <url><loc>${site.origin}${path}</loc></url>`)
        .join('\n')
    : '';
  const sitemap = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${locations}\n</urlset>\n`;
  return {
    'agent-guide.md': markdown,
    'agent-map.json': JSON.stringify(guide, null, 2) + '\n',
    'llms.txt': llms,
    'robots.txt': robots,
    'sitemap.xml': sitemap,
  };
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const outputs = renderDiscovery(
    read('app/site-config.json'),
    read('app/data/documentation.json'),
  );
  for (const [name, content] of Object.entries(outputs)) {
    const target = resolve(root, 'public', name);
    if (process.argv.includes('--check')) {
      if (readFileSync(target, 'utf8') !== content)
        throw new Error(`Stale generated discovery file: ${name}`);
    } else writeFileSync(target, content);
  }
  console.log(
    `Discovery resources ${process.argv.includes('--check') ? 'verified' : 'generated'}: ${Object.keys(outputs).length}`,
  );
}
