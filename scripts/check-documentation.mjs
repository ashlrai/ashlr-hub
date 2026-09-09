#!/usr/bin/env node

// Check the operator entrypoints in a checkout or an unpacked npm artifact.
// Source-only links use explicit GitHub URLs; no network requests are made.
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { marked } from 'marked';

export const OPERATOR_DOCUMENTATION = Object.freeze([
  'README.md', 'docs/README.md', 'docs/QUICKSTART.md', 'docs/DEMO.md', 'docs/ARCHITECTURE.md',
  'docs/ASHLR-UNIVERSE.md', 'docs/RESOURCE-POOLS.md', 'docs/NORTH-STAR.md', 'docs/MISSION-OS.md',
]);
const SOURCE_PREFIX = 'https://github.com/ashlrai/ashlr-hub/blob/master/';
const MAX_DOCUMENT_BYTES = 2 * 1024 * 1024;

function inside(root, target) {
  const rel = relative(root, target);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function decodeEntities(text) {
  return text
    .replace(/&#(x[0-9a-f]+|\d+);/giu, (_match, code) => {
      const value = code.toLowerCase().startsWith('x')
        ? Number.parseInt(code.slice(1), 16) : Number(code);
      return value > 0 && value <= 0x10ffff ? String.fromCodePoint(value) : '';
    })
    .replace(/&(amp|lt|gt|quot|apos);/gu, (_match, name) =>
      ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" })[name]);
}

function plainHeading(text) {
  return decodeEntities(marked.parseInline(text).replace(/<[^>]*>/gu, ''));
}

// This is deliberately a small attribute grammar, not a browser DOM parser.
// Ambiguous forms fail the check instead of silently supplying false anchors.
function inspectHtml(text, links, anchors) {
  const html = text;
  const tag = /<!--[\s\S]*?(?:-->|$)|<(\/?)([a-z][a-z\d:-]*)(?:"[^"]*"|'[^']*'|[^'">])*>/giu;
  let end = 0;
  for (const match of html.matchAll(tag)) {
    if (html.slice(end, match.index).includes('<')) throw new Error('unsupported raw HTML; use Markdown navigation');
    end = match.index + match[0].length;
    if (match[0].startsWith('<!--')) continue;
    const body = match[0].slice(match[1].length + match[2].length + 1, -1);
    if (match[1]) {
      if (body.trim()) throw new Error('unsupported closing HTML tag');
      continue;
    }
    const attributes = new Map();
    const attribute = /\s+([a-z_:][a-z\d:_.-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'`=<>]+)))?/giy;
    let offset = 0;
    while (body.slice(offset).trim() && body.slice(offset).trim() !== '/') {
      attribute.lastIndex = offset;
      const value = attribute.exec(body);
      if (!value) throw new Error('unsupported raw HTML attributes; use Markdown navigation');
      offset = attribute.lastIndex;
      const name = value[1].toLowerCase();
      if (attributes.has(name)) throw new Error(`duplicate raw HTML attribute ${name}`);
      const raw = value[2] ?? value[3] ?? value[4] ?? '';
      const decoded = decodeEntities(raw);
      if (['href', 'src', 'id', 'name'].includes(name) && /&(?:#\w+|[a-z]+);/iu.test(decoded)) {
        throw new Error('unsupported HTML character reference; use literal or numeric navigation attributes');
      }
      attributes.set(name, decoded);
    }
    if (attributes.has('id')) anchors.add(attributes.get('id'));
    if (match[2].toLowerCase() === 'a' && attributes.has('name')) anchors.add(attributes.get('name'));
    // Includes a/img and other file-bearing tags; nothing is fetched or rendered.
    for (const name of ['href', 'src']) if (attributes.has(name)) links.push(attributes.get(name));
  }
  if (html.slice(end).includes('<')) throw new Error('unsupported raw HTML; use Markdown navigation');
}

export function inspectMarkdown(markdown) {
  const links = [];
  const anchors = new Set();
  const headingIds = new Set();
  const errors = [];
  marked.walkTokens(marked.lexer(markdown), (token) => {
    if (token.type === 'heading') {
      const base = plainHeading(token.text).toLowerCase()
        .replace(/[^\p{L}\p{M}\p{N}_ -]/gu, '').replace(/ /gu, '-');
      let id = base;
      let duplicate = 0;
      while (headingIds.has(id)) id = `${base}-${++duplicate}`;
      headingIds.add(id);
      anchors.add(id);
    }
    if (token.type === 'link' || token.type === 'image') links.push(token.href);
    if (token.type === 'html') {
      try { inspectHtml(token.text, links, anchors); } catch (error) { errors.push(error.message); }
    }
  });
  return { links, anchors, errors };
}

export function checkDocumentation({ root, mode = 'source', entrypoints = OPERATOR_DOCUMENTATION }) {
  if (!['source', 'package'].includes(mode)) throw new Error('mode must be source or package');
  const canonicalRoot = realpathSync(root);
  const documents = new Map();
  const errors = [];
  let localLinks = 0;
  let sourceLinks = 0;
  let externalLinks = 0;
  const resolveFile = (path) => {
    if (!inside(canonicalRoot, path)) throw new Error('target escapes the documentation root');
    let target = realpathSync(path);
    if (!inside(canonicalRoot, target)) throw new Error('target resolves outside the documentation root');
    if (statSync(target).isDirectory()) target = realpathSync(resolve(target, 'README.md'));
    if (!inside(canonicalRoot, target)) throw new Error('target resolves outside the documentation root');
    const stat = statSync(target);
    if (!stat.isFile()) throw new Error('target is not a regular file');
    return { target, size: stat.size };
  };
  const readMarkdown = (path) => {
    const { target, size } = resolveFile(path);
    if (size > MAX_DOCUMENT_BYTES) throw new Error('document exceeds the 2 MiB check limit');
    if (!documents.has(target)) documents.set(target, inspectMarkdown(readFileSync(target, 'utf8')));
    return documents.get(target);
  };
  for (const file of entrypoints) {
    let document;
    const origin = resolve(canonicalRoot, file);
    try {
      document = readMarkdown(origin);
      for (const reason of document.errors) errors.push({ file, href: null, reason });
    } catch (error) {
      errors.push({ file, href: null, reason: error.message });
      continue;
    }
    for (const href of document.links) {
      let local = href;
      let base = dirname(origin);
      if (href.startsWith(SOURCE_PREFIX)) {
        sourceLinks++;
        if (mode === 'package') continue;
        local = href.slice(SOURCE_PREFIX.length);
        base = canonicalRoot;
      } else if (/^[a-z][a-z\d+.-]*:/iu.test(href) || href.startsWith('//')) {
        externalLinks++;
        continue;
      } else {
        localLinks++;
      }
      try {
        const hash = local.indexOf('#');
        const pathPart = (hash < 0 ? local : local.slice(0, hash)).split('?')[0];
        const fragment = hash < 0 ? '' : decodeURIComponent(local.slice(hash + 1));
        const decoded = decodeURIComponent(pathPart);
        if (isAbsolute(decoded) || decoded.includes('\\') || decoded.includes('\0')) {
          throw new Error('local link must use a repository-relative path');
        }
        const target = resolveFile(decoded ? resolve(base, decoded) : origin).target;
        if (fragment && /\.md$/iu.test(target)) {
          const targetDocument = readMarkdown(target);
          if (targetDocument.errors.length) throw new Error('target contains unsupported raw HTML navigation');
          if (!targetDocument.anchors.has(fragment)) throw new Error(`heading or explicit anchor #${fragment} does not exist`);
        }
      } catch (error) {
        errors.push({ file, href, reason: error.message });
      }
    }
  }
  return { ok: errors.length === 0, mode, entrypoints: [...entrypoints], localLinks,
    sourceLinks, externalLinks, externalRequests: 0, errors };
}

function main(args) {
  const options = { root: process.cwd(), mode: 'source' };
  const seen = new Set();
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i];
    if (!['--root', '--mode'].includes(key) || seen.has(key) || !args[i + 1]) {
      throw new Error('usage: check-documentation.mjs [--root DIRECTORY] [--mode source|package]');
    }
    seen.add(key);
    options[key.slice(2)] = args[i + 1];
  }
  const result = checkDocumentation(options);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.ok) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(process.argv.slice(2)); } catch (error) {
    process.stderr.write(`documentation check: ${error.message}\n`);
    process.exitCode = 1;
  }
}
