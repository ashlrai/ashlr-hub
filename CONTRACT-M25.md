# CONTRACT-M25 — Portfolio Intelligence (Knowledge Index, Ask/RAG, Graph + Impact)

Status: CONTRACT ONLY. This file defines exact signatures, file ownership, and
the privacy/read-only invariants every M25 agent MUST build against. No
implementation here. Build against the contract; each agent edits ONLY its own
file(s).

## Shared types (already added to `src/core/types.ts`)

```ts
export interface KnowledgeChunk {
  repo: string;
  file: string;
  startLine: number;
  endLine: number;
  text: string;
  vector?: number[];
  summary?: string;
}

export interface AskHit { chunk: KnowledgeChunk; score: number }

export interface AskResult {
  question: string;
  answer: string;
  sources: { repo: string; file: string; line: number }[];
  method: 'embedding' | 'keyword';
  local: boolean;
}

export interface ImpactResult {
  target: string;
  references: { repo: string; file: string; line: number }[];
  dependents: string[];
}

export interface KnowledgeGraph {
  nodes: { id: string; kind: string; label: string }[];
  edges: { from: string; to: string; kind: string }[];
  crossRepo: { kind: string; detail: string; repos: string[] }[];
}
```

Import these from `../types` (core) / `../core/types` (cli). Do NOT redefine them.

## File ownership (each agent edits ONLY its file[s])

| File | Owner agent | Exports |
| --- | --- | --- |
| `src/core/knowledge/index.ts` | INDEX | `buildKnowledge`, `knowledgeDir`, `loadChunks` |
| `src/core/knowledge/ask.ts` | ASK | `ask` |
| `src/core/knowledge/graph.ts` | GRAPH | `buildGraph`, `impact` |
| `src/cli/ask.ts` | CLI-ASK | `cmdAsk` |
| `src/cli/knowledge.ts` | CLI-KNOWLEDGE | `cmdKnowledge` |

## Module signatures (EXACT — do not deviate)

### `src/core/knowledge/index.ts`
```ts
export async function buildKnowledge(
  opts?: { repos?: string[]; allowCloud?: boolean }
): Promise<{ repos: number; chunks: number }>;

export function knowledgeDir(): string;

export function loadChunks(repo?: string): KnowledgeChunk[];
```
- `buildKnowledge`: default `repos = listEnrolled()` (from `../sandbox/policy`).
  Read-only walk of each enrolled repo. Chunk source files, embed via LOCAL
  Ollama embeddings (best-effort), scrub secrets BEFORE storing/embedding,
  incremental by file mtime (re-index only changed files). Returns counts of
  repos and chunks indexed. Persists JSONL under `knowledgeDir()`.
- `knowledgeDir`: returns the on-disk root for the index
  (`~/.ashlr/knowledge`). Pure path helper; creates nothing by contract.
- `loadChunks`: load persisted chunks, optionally scoped to one repo (absolute
  repo path). Returns `[]` when nothing indexed. Never scans repo source — reads
  only the persisted index.

### `src/core/knowledge/ask.ts`
```ts
export async function ask(
  question: string,
  opts: { repo?: string; allowCloud: boolean }
): Promise<AskResult>;
```
- Retrieve top relevant chunks via `loadChunks` (embedding cosine when vectors
  exist, else keyword/TF-IDF). Synthesize an answer on the LOCAL provider with
  citations. `opts.repo` scopes retrieval to one enrolled repo.
- `allowCloud` is REQUIRED on the opts object; callers default it to `false`.
  Code/chunks are sent to a cloud model ONLY when `allowCloud === true` AND a
  key exists. Set `result.local = true` whenever synthesis stayed local.
- `result.method` reflects the retrieval path actually used.

### `src/core/knowledge/graph.ts`
```ts
export function buildGraph(repos?: string[]): KnowledgeGraph;

export function impact(target: string, repos?: string[]): ImpactResult;
```
- `buildGraph`: default `repos = listEnrolled()`. Build nodes (repos/modules/key
  deps) and edges (imports/depends/shared-dep) from the persisted index +
  manifests. Populate `crossRepo` with same-dep / duplicated-pattern findings.
- `impact`: resolve references to and dependents of a file path or symbol,
  within and across the given (default enrolled) repos. Pure analysis.

### `src/cli/ask.ts`
```ts
export async function cmdAsk(args: string[]): Promise<number>;
```
- Backs `ashlr ask "<question>"`. Parse `--repo <path>` (scope) and
  `--allow-cloud` (default OFF). Call `ask(question, { repo, allowCloud })`.
  Print the answer and CITED sources (`repo/file:line`). Returns process exit
  code.

### `src/cli/knowledge.ts`
```ts
export async function cmdKnowledge(args: string[]): Promise<number>;
```
- Backs `ashlr knowledge <build|graph|impact>`:
  - `build [--repo <path>]` → `buildKnowledge({ repos? })`, print counts.
  - `graph` → `buildGraph()`, print/serve the map.
  - `impact <target>` → `impact(target)`, print references + dependents.
- Parse `--allow-cloud` (default OFF) and pass through where relevant. Returns
  process exit code.

## Privacy + read-only invariants (NON-NEGOTIABLE)

1. LOCAL-ONLY BY DEFAULT. Indexing, embeddings, and ask synthesis run on the
   LOCAL model (Ollama). NEVER send repo code/chunks to a CLOUD model unless
   `--allow-cloud` is explicitly passed AND a key exists. Any code-to-cloud on
   the default path is a contract violation.
2. READ-ONLY. `buildKnowledge`, `loadChunks`, `ask`, `buildGraph`, `impact`
   NEVER modify any enrolled repo. Writes are confined to `knowledgeDir()`
   (`~/.ashlr/knowledge`).
3. ENROLLMENT-SCOPED. Default repo set is `listEnrolled()` (DEFAULT EMPTY ⇒
   empty knowledge, NO disk scan of the whole portfolio). Honor `isEnrolled`.
4. BOUNDED. Apply file/byte/time caps; skip `node_modules`, `.git`, `dist`,
   build output, and binaries during the walk.
5. NO SECRETS IN INDEX/ANSWERS. Skip/scrub `.env`, key files, and secret-shaped
   tokens from chunks BEFORE storing/embedding and before citing.
6. PRESERVE EXISTING BEHAVIOR. Keep all existing exports + 2443 tests green.
   Reuse modules (`core/sandbox/policy.ts`, `core/genome/recall.ts`,
   `core/run/provider-client.ts`, `core/git.ts`, `cli/ui.ts`). No new runtime
   deps. No git commit of ashlr-hub.

## Reuse map

- `core/sandbox/policy.ts` — `listEnrolled()` (DEFAULT EMPTY), `isEnrolled()`.
- `core/genome/recall.ts` — local Ollama embeddings + `keywordScore` fallback;
  `getActiveClient`.
- `core/run/provider-client.ts` — local provider; LOCAL-FIRST refusal for cloud.
- `core/git.ts`, `core/index-engine.ts` — repo walking / indexing helpers.
- `cli/ui.ts` — CLI output formatting.
