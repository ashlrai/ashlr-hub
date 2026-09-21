/**
 * Resolve a GGUF blob out of Ollama's content-addressed model store.
 *
 * llama-server is launched against the blob Ollama already downloaded, so a
 * 27 GB model exists once on disk rather than twice. The digest is DERIVED
 * from the manifest every time — never hardcoded — because it changes whenever
 * the tag is repulled or retagged, and a stale constant would silently serve
 * the wrong weights.
 *
 * Layout (Ollama >= 0.1, unchanged since):
 *   <root>/manifests/<registry>/<namespace>/<name>/<tag>   — an OCI manifest
 *   <root>/blobs/sha256-<hex>                              — the layers
 *
 * The model layer is the one with mediaType
 * `application/vnd.ollama.image.model`; the same manifest also lists the
 * projector, licence and params layers, which are NOT the weights.
 *
 * Never throws: every failure is a typed `ok: false` with a reason a human can
 * act on.
 */

import { readFileSync, readdirSync, statSync, type Dirent } from 'node:fs';
import { join } from 'node:path';
import { ollamaModelsRoot } from './paths.js';

/** Media type of the weights layer inside an Ollama manifest. */
const MODEL_MEDIA_TYPE = 'application/vnd.ollama.image.model';

/** A digest we are willing to turn into a filesystem path. */
const SHA256_DIGEST = /^sha256:([a-f0-9]{64})$/;

/** A model reference component we are willing to turn into a path segment. */
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Manifests larger than this are not Ollama manifests; refuse to parse them. */
const MAX_MANIFEST_BYTES = 256 * 1024;

/** A parsed `[registry/][namespace/]name[:tag]` reference. */
export interface OllamaModelRef {
  registry: string;
  namespace: string;
  name: string;
  tag: string;
  /** Canonical `name:tag` (or `namespace/name:tag` when non-default). */
  canonical: string;
}

/** A successfully resolved weights blob. */
export interface ResolvedOllamaBlob {
  ok: true;
  ref: OllamaModelRef;
  /** Absolute path of the manifest the digest was read from. */
  manifestPath: string;
  /** `sha256:<hex>` exactly as the manifest spelled it. */
  digest: string;
  /** Absolute path of the GGUF blob. */
  blobPath: string;
  /** Size in bytes, from the manifest (cross-checked against the file). */
  sizeBytes: number;
}

/** Why a blob could not be resolved. */
export interface UnresolvedOllamaBlob {
  ok: false;
  reason: string;
}

export type OllamaBlobResolution = ResolvedOllamaBlob | UnresolvedOllamaBlob;

/**
 * Parse `qwen3.8:27b-ctx64k`, `library/qwen3.8:27b-ctx64k` or a fully
 * qualified `registry.ollama.ai/library/qwen3.8:27b-ctx64k`.
 *
 * Returns null rather than throwing on anything that would escape the store
 * directory — a `..` segment or a slash inside a name is a path-traversal
 * attempt, not a model.
 */
export function parseOllamaModelRef(raw: string): OllamaModelRef | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const [pathPart, tagPart, ...extraTags] = trimmed.split(':');
  if (extraTags.length > 0) return null;
  if (!pathPart) return null;
  const tag = (tagPart ?? 'latest').trim() || 'latest';

  const segments = pathPart.split('/').filter((segment) => segment.length > 0);
  if (segments.length !== pathPart.split('/').length) return null;

  let registry = 'registry.ollama.ai';
  let namespace = 'library';
  let name: string;

  if (segments.length === 1) {
    name = segments[0] as string;
  } else if (segments.length === 2) {
    namespace = segments[0] as string;
    name = segments[1] as string;
  } else if (segments.length === 3) {
    registry = segments[0] as string;
    namespace = segments[1] as string;
    name = segments[2] as string;
  } else {
    return null;
  }

  for (const segment of [registry, namespace, name, tag]) {
    if (!SAFE_SEGMENT.test(segment)) return null;
  }

  const canonical = namespace === 'library' ? `${name}:${tag}` : `${namespace}/${name}:${tag}`;
  return { registry, namespace, name, tag, canonical };
}

/** Absolute path of the manifest file for a parsed reference. */
export function ollamaManifestPath(ref: OllamaModelRef, root = ollamaModelsRoot()): string {
  return join(root, 'manifests', ref.registry, ref.namespace, ref.name, ref.tag);
}

/** Shape of the one manifest field we care about. */
interface ManifestLayer {
  mediaType?: unknown;
  digest?: unknown;
  size?: unknown;
}

/**
 * Pick the weights layer out of a parsed manifest body.
 *
 * Exported for tests: the selection rule (media type, not "the biggest layer")
 * is the part that must not drift, and it is pure.
 */
export function selectModelLayer(body: unknown): { digest: string; size: number } | null {
  if (typeof body !== 'object' || body === null) return null;
  const layers = (body as Record<string, unknown>)['layers'];
  if (!Array.isArray(layers)) return null;

  for (const raw of layers) {
    if (typeof raw !== 'object' || raw === null) continue;
    const layer = raw as ManifestLayer;
    if (layer.mediaType !== MODEL_MEDIA_TYPE) continue;
    if (typeof layer.digest !== 'string') continue;
    const size = typeof layer.size === 'number' && Number.isFinite(layer.size) ? layer.size : 0;
    return { digest: layer.digest, size };
  }
  return null;
}

/** `sha256:<hex>` -> `sha256-<hex>`, the on-disk blob basename. Null when malformed. */
export function blobBasenameForDigest(digest: string): string | null {
  const match = SHA256_DIGEST.exec(digest);
  if (!match) return null;
  return `sha256-${match[1] as string}`;
}

/**
 * The REVERSE lookup: which Ollama reference does this blob belong to?
 *
 * llama-server reports its `model_path`, and for a GGUF served out of Ollama's
 * content-addressed store that is `.../blobs/sha256-<digest>` — a name that
 * identifies this machine's storage layout and tells a reader nothing. Every
 * surface downstream (the cockpit, `local-runtime status`, run records) then
 * has to either show the digest or show "unknown".
 *
 * Scanning the manifests for that digest recovers the real reference, so a
 * runtime the operator started BY HAND in a terminal — which has no
 * `modelRef` in its ownership record, because nobody told us one — can still
 * be named. Bounded and read-only: the manifest tree is a handful of small
 * files, and nothing here writes, downloads or executes.
 *
 * Returns null rather than guessing when the digest matches nothing.
 */
export function resolveOllamaRefForBlobPath(
  blobPath: string,
  root = ollamaModelsRoot(),
): string | null {
  const basename = blobPath.split('/').pop() ?? blobPath;
  if (!/^sha256-[0-9a-f]{8,}$/i.test(basename)) return null;
  const wanted = `sha256:${basename.slice('sha256-'.length).toLowerCase()}`;

  const manifestsRoot = join(root, 'manifests');
  const walk = (dir: string, depth: number): string | null => {
    if (depth > 6) return null;
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true, encoding: 'utf8' }) as Dirent[];
    } catch {
      return null;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        const found = walk(full, depth + 1);
        if (found !== null) return found;
        continue;
      }
      if (!entry.isFile()) continue;
      try {
        const stat = statSync(full);
        // A manifest is small JSON; anything large is not one and reading it
        // would be the kind of unbounded work a status probe must not do.
        if (stat.size > 256 * 1024) continue;
        const layer = selectModelLayer(JSON.parse(readFileSync(full, 'utf8')));
        if (layer === null) continue;
        if (layer.digest.toLowerCase() !== wanted) continue;
      } catch {
        continue;
      }
      // `manifests/<registry>/<namespace>/<name>/<tag>` -> the canonical ref.
      const parts = full.slice(manifestsRoot.length + 1).split('/');
      if (parts.length < 4) continue;
      const tag = parts[parts.length - 1] as string;
      const name = parts[parts.length - 2] as string;
      const namespace = parts[parts.length - 3] as string;
      return namespace === 'library' ? `${name}:${tag}` : `${namespace}/${name}:${tag}`;
    }
    return null;
  };
  return walk(manifestsRoot, 0);
}

/**
 * Resolve the GGUF blob for an Ollama model reference.
 *
 * Reads the manifest, selects the weights layer by media type, converts the
 * digest to a blob path and confirms the file is actually there. A manifest
 * that names a blob which is missing is reported as missing rather than
 * handed to llama-server, which would fail far less legibly.
 */
export function resolveOllamaModelBlob(
  modelRef: string,
  root = ollamaModelsRoot(),
): OllamaBlobResolution {
  const ref = parseOllamaModelRef(modelRef);
  if (!ref) {
    return { ok: false, reason: `"${modelRef}" is not a usable Ollama model reference` };
  }

  const manifestPath = ollamaManifestPath(ref, root);

  let raw: string;
  try {
    const stat = statSync(manifestPath);
    if (!stat.isFile()) {
      return { ok: false, reason: `manifest is not a regular file: ${manifestPath}` };
    }
    if (stat.size > MAX_MANIFEST_BYTES) {
      return { ok: false, reason: `manifest is implausibly large (${stat.size} bytes): ${manifestPath}` };
    }
    raw = readFileSync(manifestPath, 'utf8');
  } catch {
    return {
      ok: false,
      reason:
        `no Ollama manifest at ${manifestPath} — ` +
        `pull it first with \`ollama pull ${ref.canonical}\``,
    };
  }

  let body: unknown;
  try {
    body = JSON.parse(raw) as unknown;
  } catch {
    return { ok: false, reason: `Ollama manifest is not valid JSON: ${manifestPath}` };
  }

  const layer = selectModelLayer(body);
  if (!layer) {
    return {
      ok: false,
      reason: `manifest ${manifestPath} has no ${MODEL_MEDIA_TYPE} layer`,
    };
  }

  const basename = blobBasenameForDigest(layer.digest);
  if (!basename) {
    return { ok: false, reason: `manifest ${manifestPath} names a non-sha256 digest` };
  }

  const blobPath = join(root, 'blobs', basename);
  let actualSize = 0;
  try {
    const stat = statSync(blobPath);
    if (!stat.isFile()) {
      return { ok: false, reason: `blob is not a regular file: ${blobPath}` };
    }
    actualSize = stat.size;
  } catch {
    return {
      ok: false,
      reason:
        `manifest names ${layer.digest} but the blob is missing: ${blobPath} — ` +
        `re-pull with \`ollama pull ${ref.canonical}\``,
    };
  }

  return {
    ok: true,
    ref,
    manifestPath,
    digest: layer.digest,
    blobPath,
    sizeBytes: layer.size > 0 ? layer.size : actualSize,
  };
}
