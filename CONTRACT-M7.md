# CONTRACT-M7 — Shared Memory / Genome

Cross-project, local-first shared memory the whole ecosystem reads from and writes
to. Aggregates per-project `.ashlrcode/genome/` dirs across indexed repos plus a hub
store at `~/.ashlr/genome/hub.jsonl`. Recall ranks local-first (keyword/TF-IDF), with
optional best-effort embedding rerank via local Ollama. Never cloud. Fully offline-capable.

All shapes below are defined in `src/core/types.ts` (THE CONTRACT) and MUST NOT be
redefined downstream:

- `GenomeEntry { id: string; project: string | null; source: 'project' | 'hub'; title: string; text: string; tags: string[]; ts: string }`
- `RecallHit { entry: GenomeEntry; score: number; method: 'keyword' | 'embedding' }`
- `GenomeHealth { totalEntries: number; projects: number; hubEntries: number; sizeBytes: number; lastLearnedAt: string | null; embeddingsAvailable: boolean }`
- `LearnInput { text: string; title?: string; project?: string; tags?: string[] }`
- `AshlrConfig.genome?: { maxRecall: number; injectOnRun: boolean }` — optional top-level field; defaults `maxRecall: 5`, `injectOnRun: true`.

## EXACT SIGNATURES

### `src/core/genome/store.ts`

```ts
import type { AshlrConfig, GenomeEntry, GenomeHealth, LearnInput } from '../types.js';

/**
 * Aggregate the full genome: every indexed repo's `<repo>/.ashlrcode/genome/`
 * (manifest.json + section .md/.json files; parse defensively — formats vary)
 * PLUS the hub store at `~/.ashlr/genome/hub.jsonl`. Bounded reads (cap
 * entries/bytes). Never throws on malformed input; skip unreadable sources.
 */
export function loadGenome(cfg: AshlrConfig): GenomeEntry[];

/**
 * APPEND a single entry to `~/.ashlr/genome/hub.jsonl` (one JSON object per
 * line). NEVER overwrites/deletes existing entries. Creates the store dir/file
 * if missing. If `input.project` resolves to an indexed repo, MAY additionally
 * drop a NEW note file under that repo's `.ashlrcode/genome/` — never modifying
 * existing genome files. Returns the entry that was written (source: 'hub').
 */
export function appendHubEntry(input: LearnInput): GenomeEntry;

/** Absolute path to the hub store: `~/.ashlr/genome/hub.jsonl`. */
export function hubStorePath(): string;

/**
 * Status/health of the aggregated genome: entry counts, project coverage,
 * hub store size, staleness (lastLearnedAt), and whether a local
 * embedding-capable model is available. Never throws.
 */
export function genomeHealth(cfg: AshlrConfig): GenomeHealth;
```

### `src/core/genome/recall.ts`

```ts
import type { AshlrConfig, RecallHit, GenomeEntry } from '../types.js';

/**
 * Search the aggregated genome and return the top relevant hits with source +
 * score, sorted descending by score. Default ranking: local keyword/TF-IDF
 * overlap (method 'keyword'). When `opts.embeddings` is true AND a local
 * embedding-capable model is present (Ollama /api/embeddings, e.g. bge-m3),
 * OPTIONALLY rerank with embeddings (method 'embedding') — best-effort, falls
 * back to keyword on any failure, NEVER calls a cloud API. `opts.limit`
 * defaults to `cfg.genome?.maxRecall ?? 5`. Works fully offline.
 */
export async function recall(
  query: string,
  cfg: AshlrConfig,
  opts?: { limit?: number; embeddings?: boolean },
): Promise<RecallHit[]>;

/**
 * Keyword/TF-IDF overlap score for a single entry against a query. Pure,
 * synchronous, deterministic. Higher is more relevant; 0 means no overlap.
 */
export function keywordScore(query: string, entry: GenomeEntry): number;
```

### `src/cli/genome.ts`

```ts
/**
 * `ashlr recall "<query>"` — search the aggregated genome, print top hits with
 * source + score. Returns process exit code (0 success).
 */
export async function cmdRecall(args: string[]): Promise<number>;

/**
 * `ashlr learn "<text>" [--project <name>] [--tags a,b]` — APPEND a GenomeEntry
 * to the hub store (and optionally a NEW note into a resolved project's
 * `.ashlrcode/genome/`). Never overwrites. Returns process exit code.
 */
export async function cmdLearn(args: string[]): Promise<number>;

/**
 * `ashlr genome` — print genome status/health (entry count, projects covered,
 * staleness, store size, embeddings availability). Returns process exit code.
 */
export async function cmdGenome(args: string[]): Promise<number>;
```

## GUARDRAILS (binding on implementers)

- **Local-first**: embeddings ONLY via local Ollama; NEVER call a cloud API.
  Recall/learn MUST work fully offline (keyword path).
- **Append-only**: `appendHubEntry` APPENDS, never overwrites/deletes existing
  genome. Writes ONLY under `~/.ashlr/genome/` (and optionally a NEW note file
  under a project's `.ashlrcode/genome/` — never modify existing genome files).
- **Bounded**: cap entries/bytes read; recall injection into `ashlr run` is
  bounded (small k via `cfg.genome.maxRecall`, char cap) and behind `--no-memory`.
- **Privacy**: genome is the user's own notes/summaries — read/store locally;
  never exfiltrate; print no secrets.

## INTEGRATION POINTS (for owning agents — not new files here)

- `ashlr status`: surface a one-line genome summary (via `genomeHealth`).
- `ashlr doctor`: add a genome check (store reachable, counts, staleness).
- `ashlr run` orchestrator: inject top-k `recall(goal, cfg)` hits into the
  sub-agent system prompt, bounded, behind a `--no-memory` flag (gated on
  `cfg.genome?.injectOnRun ?? true`).

## RULES

Zero new runtime deps. Each agent writes ONLY its file(s). No git commit.
Build against this contract; do not redefine contract types.
