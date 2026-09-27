/**
 * wiki/generate.ts — build (or incrementally refresh) one repo's wiki.
 *
 *   steering → scan (git ls-tree) → facts → plan → for each STALE page:
 *     reference (deterministic, cited) + prose (model, citations verified)
 *   → scrub → store under ~/.ashlr/knowledge/wiki/<key>/
 *
 * INVARIANTS
 *  - READ-ONLY on the repo; writes only to the private wiki store.
 *  - ENROLLMENT-SCOPED: refuses repos that are not enrolled.
 *  - INCREMENTAL: a page whose inputHash is unchanged is not regenerated.
 *  - BOUNDED: at most `pageBudget` model calls and `tokenBudget` estimated
 *    tokens per run; pages past the budget keep their previous version (or get
 *    a facts-only first version) and are listed as pending for the next run.
 *  - PRIVATE: code goes only to the engines model.ts allows for this repo;
 *    every stored page is secret-scrubbed; every citation is verified.
 *  - SINGLE-FLIGHT per repo (in-process map + a lock file across processes).
 *  - Never on a request path: callers are the CLI, the Verse background job
 *    runner (jobs.ts) and the auto-refresh timer.
 */

import { mkdir, open, rm, stat } from 'node:fs/promises';
import path from 'node:path';

import type { AshlrConfig } from '../../types.js';
import { isEnrolledAsync } from '../../sandbox/policy.js';
import { scrubSecrets } from '../../util/scrub.js';
import { verifyCitations, type CitationResolver } from './citations.js';
import { extractFacts, type RepoFacts } from './facts.js';
import { snapshotGenome } from './genome.js';
import { defaultWikiEngineResolver, repoLocalOnlyReason, runEngineChain, wikiConfig, type WikiEngine, type WikiEngineResolver } from './model.js';
import { inputHash, planPages, specHash, treeHash, type HashContext } from './plan.js';
import { assemblePage, buildPagePrompt, estimateTokens, PAGE_OUTPUT_TOKENS, parseModelMarkdown, renderReference } from './render.js';
import { readRepoText, scanRepo } from './scan.js';
import { scrubWikiText } from './scrub.js';
import { readWikiSteering } from './steering.js';
import { readManifest, readPage, removePage, wikiKey, wikiRoot, writeFileIndex, writeGenomeSnapshot, writeManifest, writePage } from './store.js';
import { WIKI_GENERATOR_VERSION, type WikiManifest, type WikiPageMeta, type WikiPageSpec, type WikiRunSummary } from './types.js';

const LOCK_STALE_MS = 45 * 60_000;

export interface WikiBuildProgress {
  repo: string;
  page: string;
  index: number;
  total: number;
  action: 'fresh' | 'generated' | 'facts-only' | 'deferred' | 'failed';
}

export interface BuildWikiOptions {
  repo: string;
  cfg?: AshlrConfig;
  /** Engine resolver; default: the seat-routed resolver (model.ts). */
  resolver?: WikiEngineResolver;
  pageBudget?: number;
  tokenBudget?: number;
  /** Regenerate every page, fresh or not. */
  force?: boolean;
  /** Facts-only run: no model is consulted at all. */
  noModel?: boolean;
  onProgress?: (ev: WikiBuildProgress) => void;
  now?: () => Date;
}

export type BuildWikiResult =
  | { ok: true; manifest: WikiManifest; summary: WikiRunSummary }
  | { ok: false; reason: string };

const inFlight = new Map<string, Promise<BuildWikiResult>>();

/** True while a build for this repo runs in this process. */
export function wikiBuildInFlight(repo: string): boolean {
  return inFlight.has(wikiKey(repo));
}

async function acquireLock(key: string): Promise<(() => Promise<void>) | null> {
  const file = path.join(wikiRoot(), key, 'build.lock');
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fh = await open(file, 'wx', 0o600);
      await fh.writeFile(JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
      await fh.close();
      return async () => {
        await rm(file, { force: true });
      };
    } catch {
      try {
        const st = await stat(file);
        if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {
          await rm(file, { force: true });
          continue;
        }
      } catch {
        continue;
      }
      return null;
    }
  }
  return null;
}

/** Build/refresh one repo's wiki. Single-flight; never throws. */
export function buildWiki(opts: BuildWikiOptions): Promise<BuildWikiResult> {
  const key = wikiKey(opts.repo);
  const running = inFlight.get(key);
  if (running) return running;
  const p = (async (): Promise<BuildWikiResult> => {
    try {
      return await buildWikiUnlocked(opts, key);
    } catch (err) {
      return { ok: false, reason: `Wiki build failed: ${scrubSecrets(err instanceof Error ? err.message : String(err)).slice(0, 300)}` };
    } finally {
      inFlight.delete(key);
    }
  })();
  inFlight.set(key, p);
  return p;
}

function metaFor(spec: WikiPageSpec, sHash: string, iHash: string, head: string | null, at: string, model: string, citations: number, dropped: number): WikiPageMeta {
  return {
    id: spec.id,
    title: spec.title,
    kind: spec.kind,
    purpose: spec.purpose,
    ...(spec.parent ? { parent: spec.parent } : {}),
    specHash: sHash,
    inputHash: iHash,
    inputs: spec.inputs,
    pseudo: spec.pseudo,
    commit: head,
    generatedAt: at,
    model,
    citations,
    droppedCitations: dropped,
  };
}

function resolverFor(facts: RepoFacts, repo: string): CitationResolver {
  const files = Object.keys(facts.lineIndex);
  const extra = new Map<string, number | null>();
  return {
    files,
    lines: async (rel) => {
      const known = facts.lineIndex[rel];
      if (known !== undefined) return known;
      if (extra.has(rel)) return extra.get(rel)!;
      // Listed but not read within the facts budget: read it now to verify.
      const text = await readRepoText(repo, rel);
      const n = text === null ? null : text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
      extra.set(rel, n);
      if (n !== null) facts.lineIndex[rel] = n;
      return n;
    },
  };
}

async function buildWikiUnlocked(opts: BuildWikiOptions, key: string): Promise<BuildWikiResult> {
  const repo = path.resolve(opts.repo);
  if (!(await isEnrolledAsync(repo))) return { ok: false, reason: `${path.basename(repo)} is not enrolled — enroll it with \`ashlr enroll add <path>\` first.` };
  const release = await acquireLock(key);
  if (!release) return { ok: false, reason: 'Another wiki build for this repo is running.' };
  try {
    return await runBuild(opts, repo, key);
  } finally {
    await release();
  }
}

async function runBuild(opts: BuildWikiOptions, repo: string, key: string): Promise<BuildWikiResult> {
  const now = opts.now ?? (() => new Date());
  const startedAt = now().toISOString();
  const wc = wikiConfig(opts.cfg);
  const pageBudget = opts.pageBudget ?? wc.pageBudget;
  const tokenBudget = opts.tokenBudget ?? wc.tokenBudget;

  const steering = await readWikiSteering(repo);
  const scan = await scanRepo(repo, steering.ignorePaths);
  if (scan.files.length === 0) return { ok: false, reason: `${scan.name} has no readable files.` };
  const facts = await extractFacts(scan);
  const specs = planPages(facts, steering);
  const previous = await readManifest(key);
  const prevById = new Map((previous?.pages ?? []).map((p) => [p.id, p]));
  const ctx: HashContext = {
    blobs: new Map(scan.files.map((f) => [f.rel, f.blob])),
    tree: treeHash(scan.files.map((f) => f.rel)),
    steering: steering.hash,
  };

  // Engines: resolved once per run (the seat plan is not free to compute).
  let engines: WikiEngine[] = [];
  let modelNote: string | null = null;
  if (opts.noModel) {
    modelNote = 'Model generation was turned off for this run.';
  } else {
    const localOnlyWhy = repoLocalOnlyReason(opts.cfg, repo, steering.localOnly);
    const resolver = opts.resolver ?? (opts.cfg ? defaultWikiEngineResolver(opts.cfg) : null);
    if (!resolver) {
      modelNote = 'No configuration was loaded, so no model was consulted.';
    } else {
      try {
        const choice = await resolver({ promptChars: 18_000, localOnly: localOnlyWhy !== null, purpose: 'page' });
        engines = localOnlyWhy !== null ? choice.engines.filter((e) => e.local) : choice.engines;
        modelNote = engines.length === 0 ? choice.note ?? 'No model is available.' : localOnlyWhy;
      } catch {
        modelNote = 'Seat routing failed; pages were built from facts only.';
      }
    }
  }

  const citeResolver = resolverFor(facts, repo);
  // Paths and module names are listings, not secrets: the page scrub keeps them intact.
  const knownPaths = new Set<string>([...scan.files.map((f) => f.rel), ...facts.modules.map((m) => m.key)]);
  const pages: WikiPageMeta[] = [];
  const pending: string[] = [];
  let generated = 0;
  let skippedFresh = 0;
  let deferred = 0;
  let failed = 0;
  let modelCalls = 0;
  let tokensUsed = 0;
  let budgetStop: WikiRunSummary['budgetStop'] = null;
  let lastEngine = engines[0]?.label ?? 'facts-only';

  for (let i = 0; i < specs.length; i++) {
    const spec = specs[i]!;
    const sHash = specHash(spec, steering.notes);
    const iHash = inputHash({ specHash: sHash, inputs: spec.inputs, pseudo: spec.pseudo }, ctx);
    const prev = prevById.get(spec.id);
    const prevExists = prev !== undefined && (await readPage(key, spec.id)) !== null;
    const fresh = prevExists && prev.inputHash === iHash && prev.specHash === sHash;
    // A facts-only page is "fresh" but upgradeable once a model is available.
    const upgradeable = fresh && prev.model === 'facts-only' && engines.length > 0;
    const report = (action: WikiBuildProgress['action']): void => {
      try {
        opts.onProgress?.({ repo, page: spec.id, index: i + 1, total: specs.length, action });
      } catch {
        // progress is best-effort
      }
    };
    if (fresh && !opts.force && !upgradeable) {
      pages.push({ ...prev, title: spec.title, purpose: spec.purpose, ...(spec.parent ? { parent: spec.parent } : {}) });
      skippedFresh++;
      report('fresh');
      continue;
    }

    // Scrubbed BEFORE it feeds the prompt: the reference quotes repo text (README
    // summary, script commands, store snippets) that a model must not see raw.
    const reference = scrubWikiText(renderReference(spec, facts, specs), knownPaths);
    let prose: string | null = null;
    let model = 'facts-only';
    let note: string | null = modelNote && engines.length === 0 ? `Built from repository facts only — ${modelNote}` : null;
    let dropped = 0;

    if (engines.length > 0) {
      const prompt = buildPagePrompt(spec, facts, reference, steering.notes);
      const cost = estimateTokens(prompt.chars) + PAGE_OUTPUT_TOKENS;
      const overPages = modelCalls >= pageBudget;
      const overTokens = tokensUsed + cost > tokenBudget;
      if (overPages || overTokens) {
        budgetStop = budgetStop ?? (overPages ? 'pages' : 'tokens');
        if (prevExists) {
          // Keep the previous version, stale, for the next run.
          pages.push(prev);
          pending.push(spec.id);
          deferred++;
          report('deferred');
          continue;
        }
        note = 'Built from repository facts only — this run hit its budget; the next run adds prose.';
        pending.push(spec.id);
        deferred++;
      } else {
        modelCalls++;
        tokensUsed += cost;
        const result = await runEngineChain(engines, prompt.system, prompt.user);
        if (result) {
          const body = parseModelMarkdown(result.text);
          if (body) {
            const verified = await verifyCitations(scrubSecrets(body), citeResolver);
            prose = verified.markdown;
            dropped = verified.dropped;
            model = result.engine.label;
            lastEngine = result.engine.label;
          }
        }
        if (prose === null) {
          failed++;
          note = 'Built from repository facts only — the model did not return a usable page this run.';
          pending.push(spec.id);
        }
      }
    }

    const assembled = assemblePage(spec, prose, reference, note);
    const final = await verifyCitations(assembled, citeResolver);
    await writePage(key, spec.id, scrubWikiText(final.markdown, knownPaths));
    pages.push(metaFor(spec, sHash, iHash, scan.head, now().toISOString(), model, final.citations.length, dropped + final.dropped));
    if (prose !== null) {
      generated++;
      report('generated');
    } else {
      report(note?.includes('budget') ? 'deferred' : 'facts-only');
    }
  }

  // Drop pages that are no longer planned.
  const planned = new Set(specs.map((s) => s.id));
  for (const old of previous?.pages ?? []) if (!planned.has(old.id)) await removePage(key, old.id);

  const genome = await snapshotGenome(repo);
  await writeGenomeSnapshot(key, genome.notes);
  await writeFileIndex(key, { ...facts.lineIndex, ...genome.lines });

  const summary: WikiRunSummary = {
    startedAt,
    finishedAt: now().toISOString(),
    generated,
    skippedFresh,
    deferred,
    failed,
    estimatedTokens: tokensUsed,
    engine: engines.length > 0 ? lastEngine : 'facts-only',
    budgetStop,
    ...(modelNote ? { modelNote } : {}),
  };
  const manifest: WikiManifest = {
    version: 1,
    generator: WIKI_GENERATOR_VERSION,
    repo,
    repoName: scan.name,
    key,
    commit: scan.head,
    generatedAt: now().toISOString(),
    steeringHash: steering.hash,
    pages,
    pending: [...new Set(pending)],
    lastRun: summary,
  };
  await writeManifest(manifest);
  return { ok: true, manifest, summary };
}
