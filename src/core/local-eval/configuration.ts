/**
 * Capture the configuration a result is only meaningful against.
 *
 * "Four agents completed 4/4" is not a fact anyone can act on. "Four agents
 * completed 4/4 on qwen3.8:27b-q8_0 at 4 slots x 65,536 context, temp 1.0,
 * through the normalising proxy" is. The difference is whether the next person
 * to change a setting can tell if they improved anything.
 *
 * READ, DO NOT ASK. Every field here is observed from the running system —
 * llama-server's own `/props`, the process's real argv, Ollama's manifest —
 * rather than accepted from a caller or a config file. A hand-maintained record
 * of "what we were running" is the first thing to go stale, and a stale
 * configuration silently invalidates every comparison made against it. The
 * whole module is therefore best-effort and NEVER THROWS: an unknown field is
 * recorded as unknown, which is honest, while a crashed capture would cost a
 * whole benchmark run.
 */

import { execFile } from 'node:child_process';
import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { HarnessConfiguration } from './types.js';

const execFileAsync = promisify(execFile);

/** Sampling parameters worth recording. The rest of `/props` is noise here. */
const SAMPLING_KEYS: readonly string[] = [
  'temperature',
  'top_k',
  'top_p',
  'min_p',
  'typical_p',
  'repeat_penalty',
  'repeat_last_n',
  'presence_penalty',
  'frequency_penalty',
  'mirostat',
  'seed',
];

const UNKNOWN = 'unknown';

async function fetchJson(url: string, timeoutMs = 5_000): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** The argv of whatever is listening on `port`, via lsof then ps. */
async function argvOnPort(port: number): Promise<readonly string[]> {
  try {
    const { stdout } = await execFileAsync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t']);
    const pid = stdout.trim().split('\n')[0];
    if (!pid) return [];
    const { stdout: cmd } = await execFileAsync('ps', ['-o', 'command=', '-p', pid]);
    return cmd.trim().split(/\s+/).filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Reverse a content-addressed blob path back to the model reference a human
 * would recognise.
 *
 * llama-server reports the blob it loaded, which is a sha256 and tells nobody
 * anything. Ollama's manifest tree is the only mapping from that back to
 * `qwen3.8:27b-q8_0`, so it is walked rather than the name being assumed from
 * whatever someone last said in a status update.
 */
async function resolveModelRef(modelPath: string): Promise<string> {
  const digest = /sha256-([0-9a-f]{64})/.exec(modelPath)?.[1];
  if (!digest) return UNKNOWN;
  const root = join(process.env['OLLAMA_MODELS'] ?? join(homedir(), '.ollama', 'models'), 'manifests');

  const walk = async (dir: string, depth = 0): Promise<string | null> => {
    if (depth > 6) return null;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return null;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        const found = await walk(full, depth + 1);
        if (found) return found;
        continue;
      }
      try {
        if ((await stat(full)).size > 256_000) continue;
        if (!(await readFile(full, 'utf8')).includes(digest)) continue;
      } catch {
        continue;
      }
      // .../manifests/<registry>/<namespace>/<model>/<tag>  ->  model:tag
      const parts = full.slice(root.length + 1).split('/');
      if (parts.length >= 2) return `${parts[parts.length - 2]}:${parts[parts.length - 1]}`;
      return parts.join('/');
    }
    return null;
  };

  return (await walk(root)) ?? UNKNOWN;
}

export interface CaptureOptions {
  /** Base URL the agent will be pointed at, e.g. `http://127.0.0.1:8090`. */
  readonly baseUrl: string;
  /** Origin llama-server itself is on, used for `/props`. */
  readonly upstreamOrigin: string;
  readonly agentCli: string;
}

/**
 * Observe the live runtime. Best effort throughout; never throws.
 *
 * NOTE ON `contextPerSlot`. llama-server's `-c` is the TOTAL context, divided
 * across `--parallel` slots. The number that bounds any single agent is the
 * quotient, and `/props.n_ctx` already reports it per slot — so it is taken from
 * there rather than recomputed, and both are recorded because confusing the two
 * is how a 262,144 headline number gets attached to a 65,536 reality.
 */
export async function captureConfiguration(opts: CaptureOptions): Promise<HarnessConfiguration> {
  const props = await fetchJson(`${opts.upstreamOrigin}/props`);
  const defaults = (props?.['default_generation_settings'] ?? {}) as Record<string, unknown>;
  const params = (defaults['params'] ?? {}) as Record<string, unknown>;

  const modelPath = typeof props?.['model_path'] === 'string' ? props['model_path'] : UNKNOWN;
  const contextPerSlot = typeof defaults['n_ctx'] === 'number' ? defaults['n_ctx'] : 0;
  const slots = typeof props?.['total_slots'] === 'number' ? props['total_slots'] : 0;

  const sampling: Record<string, unknown> = {};
  for (const key of SAMPLING_KEYS) {
    if (key in params) sampling[key] = params[key];
  }

  const upstreamPort = Number(new URL(opts.upstreamOrigin).port || 80);
  const baseUrlPort = Number(new URL(opts.baseUrl).port || 80);
  const llamaArgv = await argvOnPort(upstreamPort);

  // `-c` is authoritative for the total; fall back to slots x per-slot.
  const cFlag = llamaArgv.indexOf('-c');
  const contextTotal = cFlag >= 0 && llamaArgv[cFlag + 1]
    ? Number(llamaArgv[cFlag + 1])
    : contextPerSlot * (slots || 1);

  const proxyOn = baseUrlPort !== upstreamPort;
  const proxyArgv = proxyOn ? await argvOnPort(baseUrlPort) : [];

  let agentCli = UNKNOWN;
  try {
    const { stdout } = await execFileAsync(opts.agentCli, ['--version']);
    agentCli = `${opts.agentCli} ${stdout.trim()}`;
  } catch {
    agentCli = opts.agentCli;
  }

  return {
    model: await resolveModelRef(modelPath),
    modelPath,
    quantization: typeof props?.['model_ftype'] === 'string' ? props['model_ftype'] : UNKNOWN,
    slots,
    contextPerSlot,
    contextTotal: Number.isFinite(contextTotal) ? contextTotal : 0,
    samplingParams: sampling,
    baseUrl: opts.baseUrl,
    proxy: proxyOn ? 'on' : 'off',
    proxyImplementation: proxyOn ? (proxyArgv.join(' ') || UNKNOWN) : 'none (direct to llama-server)',
    agentCli,
    llamaServerArgv: llamaArgv,
    capturedAt: new Date().toISOString(),
  };
}
