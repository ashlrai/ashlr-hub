/**
 * test/perf/server-bench.mts — Verse server hot-path benchmark (3.10, unit A3).
 *
 *   npx tsx test/perf/server-bench.mts [section...]
 *
 * Sections: control, usage, claude, seats, runtime, github, static, block
 * (default: all). Runs the REAL request-path functions from src against the
 * current HOME, READ-ONLY: nothing here writes under ~/.ashlr, spawns an
 * engine CLI, or prompts a paid seat. `gh` is only invoked for `github` when
 * ASHLR_BENCH_GH=1 (it is a network call).
 *
 * Each line prints the samples in ms. "cold" = first call in this process;
 * "warm" = repeat calls with caches populated. `block` measures the longest
 * event-loop stall (1 ms interval timer lag) while the warm handlers run —
 * the §1 budget is 20 ms.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { brotliCompressSync, constants as zc, gzipSync } from 'node:zlib';

const SRC = new URL('../../src/', import.meta.url);
const mod = async <T>(rel: string): Promise<T> => (await import(new URL(rel, SRC).href)) as T;
const now = (): number => performance.now();
const fmt = (ms: number): string => ms.toFixed(1).padStart(8);

async function time(label: string, fn: () => unknown, runs = 3): Promise<number[]> {
  const out: number[] = [];
  for (let i = 0; i < runs; i++) {
    const t0 = now();
    await fn();
    out.push(now() - t0);
  }
  console.log(`${label.padEnd(52)}${out.map(fmt).join(' ')}  ms`);
  return out;
}

/** Max event-loop lag while `fn` runs, sampled by a 1 ms timer. */
async function maxLag(fn: () => Promise<unknown>): Promise<{ total: number; lag: number }> {
  let lag = 0;
  let last = now();
  const iv = setInterval(() => {
    const t = now();
    lag = Math.max(lag, t - last - 1);
    last = t;
  }, 1);
  const t0 = now();
  await fn();
  const total = now() - t0;
  await new Promise((r) => setTimeout(r, 5));
  clearInterval(iv);
  return { total, lag };
}

function fakeRes(): ServerResponse {
  return {
    headersSent: false,
    writableEnded: false,
    setHeader() {},
    writeHead() { return this; },
    write() { return true; },
    end() {},
  } as unknown as ServerResponse;
}

const wanted = new Set(process.argv.slice(2));
const on = (name: string): boolean => wanted.size === 0 || wanted.has(name);

const { loadConfigReadOnly } = await mod<typeof import('../../src/core/config.js')>('core/config.ts');
const cfg = loadConfigReadOnly();
const controlApi = await mod<typeof import('../../src/core/verse/control-api.js')>('core/verse/control-api.ts');
// The real server hands the control plane its read-projection worker; so do
// we (ASHLR_BENCH_NO_WORKER=1 measures the in-process fallback instead).
const { createReadProjectionWorker } = await mod<typeof import('../../src/core/web/read-projections.js')>('core/web/read-projections.ts');
const reader = process.env['ASHLR_BENCH_NO_WORKER'] === '1' ? undefined : createReadProjectionWorker(cfg);

async function get(path: string): Promise<void> {
  const req = { url: path, method: 'GET', headers: {} } as unknown as IncomingMessage;
  await controlApi.handleVerseControlApi(
    { cfg, token: 'x'.repeat(64), allowDispatch: false, ...(reader ? { readProjections: reader } : {}) },
    req, fakeRes(), path.split('?')[0]!, 'GET',
  );
}

if (on('control')) {
  console.log(`\n# GET /api/verse/control (fleet status via ${reader ? 'read-projection worker' : 'in-process cache'})`);
  await time('control cold, then warm', () => get('/api/verse/control'), 1);
  await time('control warm', () => get('/api/verse/control'), 5);
  await time('cachedPendingCount (warm fingerprint)', () => controlApi.cachedPendingCount(), 5);
}

if (on('usage')) {
  const rollup = await mod<typeof import('../../src/core/observability/rollup.js')>('core/observability/rollup.ts');
  console.log('\n# GET /api/verse/usage-series and the rollup');
  await time('buildRollup 7d (first: commit cache cold)', () => rollup.buildRollup('7d', cfg), 1);
  await time('buildRollup 7d (commit cache warm)', () => rollup.buildRollup('7d', cfg), 3);
  rollup.invalidateRollupCache();
  const warm = await maxLag(() => rollup.buildRollupAsync('30d', cfg));
  console.log(`${'buildRollupAsync 30d cold (async git warm)'.padEnd(52)}${fmt(warm.total)}  ms (max loop lag ${warm.lag.toFixed(1)} ms)`);
  await time('usage-series 7d handler, first (SWR cold)', () => get('/api/verse/usage-series?window=7d'), 1);
  await time('usage-series 7d handler, warm', () => get('/api/verse/usage-series?window=7d'), 5);
  await time('usage-series 30d handler, warm', () => get('/api/verse/usage-series?window=30d'), 3);
}

if (on('claude')) {
  const cu = await mod<typeof import('../../src/core/fabric/claude-usage.js')>('core/fabric/claude-usage.ts');
  console.log('\n# readClaudeUsage (bootstrap / seats telemetry)');
  cu.invalidateClaudeUsageCache();
  await time('readClaudeUsage cold (full scan)', () => cu.readClaudeUsage(), 1);
  await time('readClaudeUsage 30 s-cache miss (incremental)', () => { cu.expireClaudeUsageResultCache(); return cu.readClaudeUsage(); }, 5);
  cu.invalidateClaudeUsageCache();
  const primed = await maxLag(() => cu.primeClaudeUsage());
  console.log(`${'primeClaudeUsage (async cold scan)'.padEnd(52)}${fmt(primed.total)}  ms (max loop lag ${primed.lag.toFixed(1)} ms)`);
}

if (on('seats')) {
  const seats = await mod<typeof import('../../src/core/verse/seats.js')>('core/verse/seats.ts');
  console.log('\n# Seat telemetry (every /seats and /bootstrap)');
  const discovered = await seats.discoverSeats(cfg, {});
  await time('refreshSeatTelemetry', () => seats.refreshSeatTelemetry(cfg, discovered), 5);
}

if (on('runtime')) {
  console.log('\n# GET /api/verse/runtime + /api/verse/fleet (shared probe)');
  await time('runtime then fleet (one poll)', async () => { await get('/api/verse/runtime'); await get('/api/verse/fleet'); }, 3);
}

if (on('github')) {
  const gh = await mod<typeof import('../../src/core/verse/github-repo.js')>('core/verse/github-repo.ts');
  const { discoverProjects } = await mod<typeof import('../../src/core/verse/projects.js')>('core/verse/projects.ts');
  const roots = (discoverProjects() as Array<{ path: string }>).map((p) => p.path).slice(0, 12);
  console.log(`\n# GET /api/verse/github (${roots.length} roots)`);
  await time('identity, cold', () => gh.readVerseGithubSnapshot(roots, { includeLists: false }), 1);
  await time('identity, warm (fingerprint cache)', () => gh.readVerseGithubSnapshot(roots, { includeLists: false }), 3);
  if (process.env['ASHLR_BENCH_GH'] === '1' && roots[0]) {
    const cold = await maxLag(() => gh.readVerseGithubRepoAsync(roots[0]!));
    console.log(`${'lists async, cold (gh network)'.padEnd(52)}${fmt(cold.total)}  ms (max loop lag ${cold.lag.toFixed(1)} ms)`);
    await time('lists, warm (cache)', () => gh.readVerseGithubRepoAsync(roots[0]!), 3);
  }
}

if (on('static')) {
  const dir = new URL('../../dist/core/web/public/next/assets/', import.meta.url).pathname;
  console.log('\n# Static assets (dist/core/web/public/next/assets)');
  try {
    const files = readdirSync(dir).filter((f) => /\.(js|css|ttf)$/.test(f));
    let raw = 0;
    let br = 0;
    let gz = 0;
    for (const f of files) {
      const body = readFileSync(join(dir, f));
      raw += body.byteLength;
      br += brotliCompressSync(body, { params: { [zc.BROTLI_PARAM_QUALITY]: 10, [zc.BROTLI_PARAM_MODE]: zc.BROTLI_MODE_TEXT } }).byteLength;
      gz += gzipSync(body, { level: 9 }).byteLength;
    }
    const kb = (n: number): string => `${(n / 1024).toFixed(0)} KB`;
    console.log(`${files.length} js/css/ttf files: identity ${kb(raw)}, brotli ${kb(br)}, gzip ${kb(gz)}`);
    const entry = files.filter((f) => f.startsWith('index-') && f.endsWith('.js')).map((f) => statSync(join(dir, f)).size);
    if (entry.length) console.log(`entry bundle(s): ${entry.map(kb).join(', ')}`);
  } catch {
    console.log('(no dist build present — run `npm run build:web` to measure)');
  }
}

if (on('block')) {
  console.log('\n# Event-loop stall per warm handler, 1 s apart for 8 s (budget: 20 ms)');
  const paths = ['/api/verse/control', '/api/verse/usage-series?window=7d', '/api/verse/runtime', '/api/verse/fleet'];
  for (const p of paths) await get(p);
  for (const p of paths) {
    const samples: string[] = [];
    for (let i = 0; i < 8; i++) {
      await new Promise((r) => setTimeout(r, 1_000));
      const r = await maxLag(() => get(p));
      samples.push(`${r.total.toFixed(1)}/${r.lag.toFixed(1)}`);
    }
    console.log(`${p.padEnd(40)}${samples.join(' ')}  (total/max-lag ms)`);
  }
}

await reader?.close();
process.exit(0);
