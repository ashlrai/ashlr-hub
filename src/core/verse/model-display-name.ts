/**
 * core/verse/model-display-name.ts — ONE way to turn a local model tag
 * (`gpt-oss:20b`, `qwen3.8:27b-ctx64k`, `qwen3.8:27b-q8_0`, LM Studio's
 * `lmstudio-community/Qwen3-30B-A3B-GGUF`) into the name a person reads.
 *
 * It used to be a per-segment title-case in two places (seats.ts and
 * local-models.ts), which produced "Gpt-Oss 20b" and "Qwen3.8 27b-ctx64k",
 * while the Usage and Resources lists printed the raw tag. Rules:
 *
 *   - vendor casing is kept: gpt-oss stays lowercase; Qwen, Llama, DeepSeek,
 *     Mistral, Gemma, Phi … are spelled the way their makers spell them;
 *   - parameter counts are upper-case B/M ("20B", "1.5B", "30B-A3B");
 *   - a `ctxNNk` suffix is the window Ashlr baked into the tag: "(64k)";
 *   - quantization / precision suffixes (`q8_0`, `q4_K_M`, `fp16`, `mxfp4`,
 *     `qat`) are NOT part of the name: they come back as `detail`, for the
 *     surface to show subtly (or in a tooltip) beside the name;
 *   - `latest` means nothing to a reader and is dropped.
 *
 * Pure and dependency-free: the web UI imports it too.
 */

export interface ModelDisplayName {
  /** "Qwen3.8 27B (64k)" — what a person reads. */
  name: string;
  /** "q8_0" — quantization/precision, shown subtly; null when the tag has none. */
  detail: string | null;
}

/** Makers' own spelling of the family word, matched at the start of the tag's base. */
const VENDOR: ReadonlyArray<readonly [RegExp, string]> = [
  [/^gpt-oss/i, 'gpt-oss'],
  [/^qwen/i, 'Qwen'],
  [/^qwq/i, 'QwQ'],
  [/^llama/i, 'Llama'],
  [/^codellama/i, 'CodeLlama'],
  [/^deepseek/i, 'DeepSeek'],
  [/^mistral/i, 'Mistral'],
  [/^mixtral/i, 'Mixtral'],
  [/^magistral/i, 'Magistral'],
  [/^devstral/i, 'Devstral'],
  [/^codestral/i, 'Codestral'],
  [/^gemma/i, 'Gemma'],
  [/^phi/i, 'Phi'],
  [/^granite/i, 'Granite'],
  [/^glm/i, 'GLM'],
  [/^kimi/i, 'Kimi'],
  [/^olmo/i, 'OLMo'],
  [/^smollm/i, 'SmolLM'],
  [/^starcoder/i, 'StarCoder'],
];

/** 20b, 1.5b, 270m, 8x7b, a3b (MoE active parameters). */
const PARAMS = /^(?:\d+x)?\d+(?:\.\d+)?[bm]$|^a\d+(?:\.\d+)?b$/i;
/** The window suffix Ashlr (and the Ollama docs) bake into a tag. */
const CTX = /^ctx(\d+)k$/i;
/** Quantization and precision markers: detail, not name. */
const QUANT = /^(?:i?q\d[\w]*|f16|fp16|bf16|f32|fp32|fp8|int4|int8|mxfp4|nvfp4|awq|gptq|gguf|mlx|qat|\d+bit)$/i;

function capitalize(word: string): string {
  return word.length === 0 ? word : word[0]!.toUpperCase() + word.slice(1);
}

/** The family word with its maker's casing; the rest of the word (version digits) as written. */
function familyWord(segment: string): string {
  for (const [pattern, spelled] of VENDOR) {
    const m = pattern.exec(segment);
    if (m) return spelled + segment.slice(m[0].length);
  }
  return capitalize(segment);
}

function wordCase(segment: string): string {
  if (/^v\d/i.test(segment)) return segment.toUpperCase(); // v2 → V2
  if (segment.toLowerCase() === 'it') return 'IT'; // instruction-tuned (Gemma)
  return capitalize(segment);
}

/**
 * `gpt-oss:20b` → { name: "gpt-oss 20B", detail: null }
 * `qwen3.8:27b-ctx64k` → { name: "Qwen3.8 27B (64k)", detail: null }
 * `qwen3.8:27b-q8_0` → { name: "Qwen3.8 27B", detail: "q8_0" }
 */
export function modelDisplayName(tag: string): ModelDisplayName {
  const raw = tag.trim();
  if (raw.length === 0) return { name: tag, detail: null };
  // A registry / org path (`hf.co/org/model`, `lmstudio-community/Model`) is where it came from, not its name.
  // A llama-server model is often a file name: `.gguf` is the container, not the model.
  const lastPath = (raw.split('/').pop() ?? raw).replace(/\.gguf$/i, '');
  const colon = lastPath.indexOf(':');
  const base = colon === -1 ? lastPath : lastPath.slice(0, colon);
  const variant = colon === -1 ? '' : lastPath.slice(colon + 1);

  const nameParts: string[] = [];
  const params: string[] = [];
  const extras: string[] = [];
  const quant: string[] = [];
  let ctx: string | null = null;

  // gpt-oss is one word with a hyphen in it; everything else splits on '-'.
  const vendorGptOss = /^gpt-oss/i.exec(base);
  const baseSegments = vendorGptOss
    ? ['gpt-oss', ...base.slice(vendorGptOss[0].length).split(/[-_]/).filter(Boolean)]
    : base.split('-').filter(Boolean);

  for (let i = 0; i < baseSegments.length; i += 1) {
    const segment = baseSegments[i]!;
    if (i > 0 && PARAMS.test(segment)) params.push(segment.toUpperCase());
    else if (i > 0 && CTX.test(segment)) ctx = `${CTX.exec(segment)![1]}k`;
    else if (i > 0 && QUANT.test(segment)) quant.push(segment);
    else nameParts.push(i === 0 ? familyWord(segment) : wordCase(segment));
  }

  for (const segment of variant.split('-').filter(Boolean)) {
    if (segment.toLowerCase() === 'latest') continue;
    if (PARAMS.test(segment)) params.push(segment.toUpperCase());
    else if (CTX.test(segment)) ctx = `${CTX.exec(segment)![1]}k`;
    else if (QUANT.test(segment)) quant.push(segment);
    else extras.push(wordCase(segment));
  }

  const head = nameParts.join('-') || capitalize(base);
  const name = [head, params.join('-'), extras.join(' ')].filter((s) => s.length > 0).join(' ') + (ctx ? ` (${ctx})` : '');
  return { name, detail: quant.length > 0 ? quant.join(' ') : null };
}

/** The name alone, for a plain-text slot; `withDetail` appends the quantization after a middle dot. */
export function modelDisplayText(tag: string, withDetail = false): string {
  const { name, detail } = modelDisplayName(tag);
  return withDetail && detail ? `${name} · ${detail}` : name;
}
