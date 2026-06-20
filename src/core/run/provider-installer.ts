/**
 * provider-installer.ts — local model-runtime registry + confirm-gated installer.
 *
 * Backs the Local Provider Picker (M-LP). ashlr bundles NO model runtime; it
 * speaks the two open local-inference protocols (OpenAI /v1/models + Ollama
 * /api/tags). This module knows how to (a) DETECT the popular runtimes and
 * (b) OFFER a one-command install via the user's OS package manager.
 *
 * GUARDRAILS (non-negotiable, mirrors model-manager.ts):
 *  - `detect` / `scanExistingProviders` are PURE READ — probe + PATH lookup
 *    only, never spawn an install or start a daemon.
 *  - `installProvider` is EXPLICIT + CONFIRM-GATED — it runs nothing unless
 *    the caller passes { confirm: true } (i.e. the user said yes / --yes).
 *    With confirm:false it returns the exact command as a *plan*, never runs.
 *  - Installs shell out via execFile with an ARGV (no shell, no `curl | sh`),
 *    so there is no shell-injection or remote-script-pipe surface. Platforms
 *    without a safe package-manager command fall back to docsUrl.
 *  - Never throws — all failures surface as { ok:false, detail } like pullModel.
 *  - No new runtime dependencies.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { probeEndpoint } from '../providers.js';
import { whichBin } from './model-manager.js';

const execFileAsync = promisify(execFile);

/** Max time for an install command (package-manager download). 10 minutes. */
const INSTALL_TIMEOUT_MS = 600_000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Stable ids for the runtimes the picker knows how to set up. */
export type ProviderInstallerId = 'ollama' | 'lmstudio' | 'llamacpp';

/**
 * Where a runtime stands right now:
 *  - 'running'   — the endpoint responded (ready to use)
 *  - 'installed' — the binary is on PATH but the endpoint is down (start it)
 *  - 'absent'    — not detected at all (offer install)
 */
export type ProviderState = 'running' | 'installed' | 'absent';

/** Result of detecting a single runtime. Never throws. */
export interface ProviderDetection {
  id: ProviderInstallerId;
  state: ProviderState;
  /** Model ids reported by the endpoint when running (empty otherwise). */
  models: string[];
  /** The endpoint URL that was probed for liveness. */
  url: string;
}

/** Outcome of an install attempt or plan. Mirrors pullModel's {ok, detail}. */
export interface InstallResult {
  ok: boolean;
  detail: string;
  /** The exact command (argv joined) that ran, or would run. Absent when none. */
  command?: string;
}

/** One installable local runtime: pure data + a detect() probe. */
export interface ProviderInstaller {
  id: ProviderInstallerId;
  /** Human label for the picker. */
  label: string;
  /** Probe the endpoint + PATH and report current state. Never throws. */
  detect(): Promise<ProviderDetection>;
  /**
   * Per-platform install command as an execFile argv (NO shell). A platform
   * absent from this map has no automated installer — fall back to docsUrl.
   */
  installCmd: Partial<Record<NodeJS.Platform, string[]>>;
  /** Where to send the user when there's no automated install for their OS. */
  docsUrl: string;
  /** Suggested starter models to pull after install (empty when GUI/file-managed). */
  recommendedModels: string[];
}

// ---------------------------------------------------------------------------
// Internal per-runtime probe config
// ---------------------------------------------------------------------------

/** Binary name (for installed-but-stopped detection) + probe id/url. */
interface ProbeConfig {
  /** PATH binary that indicates the runtime is installed. */
  bin: string;
  /** id passed to probeEndpoint (controls which protocol path is appended). */
  probeId: string;
  /** Base/probe URL for liveness. */
  url: string;
}

const PROBE: Record<ProviderInstallerId, ProbeConfig> = {
  // probeEndpoint appends /api/tags for 'ollama'.
  ollama: { bin: 'ollama', probeId: 'ollama', url: 'http://localhost:11434' },
  // probeEndpoint appends /v1/models for 'lmstudio'. `lms` is the LM Studio CLI.
  lmstudio: { bin: 'lms', probeId: 'lmstudio', url: 'http://localhost:1234' },
  // Unknown id → probeEndpoint uses the URL as-is, so give it the full
  // OpenAI-compatible path. `llama-server` is the llama.cpp HTTP server binary.
  llamacpp: { bin: 'llama-server', probeId: 'llamacpp', url: 'http://localhost:8080/v1/models' },
};

/**
 * Detect one runtime: probe the endpoint first (running?), then fall back to a
 * PATH lookup (installed-but-stopped?). Never throws.
 */
async function detectProvider(id: ProviderInstallerId): Promise<ProviderDetection> {
  const cfg = PROBE[id];
  const endpoint = await probeEndpoint(cfg.probeId, cfg.url);
  if (endpoint.up) {
    return { id, state: 'running', models: endpoint.models, url: endpoint.url };
  }
  const installed = whichBin(cfg.bin);
  return { id, state: installed ? 'installed' : 'absent', models: [], url: endpoint.url };
}

// ---------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------

/**
 * Known local runtimes, in recommended-presentation order (easiest first).
 *
 * Install commands are argv-only (execFile, no shell). We deliberately omit a
 * platform rather than ship a `curl | sh` pipe; those users get docsUrl.
 */
export const PROVIDER_INSTALLERS: ProviderInstaller[] = [
  {
    id: 'ollama',
    label: 'Ollama',
    detect: () => detectProvider('ollama'),
    installCmd: {
      win32: ['winget', 'install', '--id', 'Ollama.Ollama', '-e'],
      darwin: ['brew', 'install', 'ollama'],
      // linux: official path is `curl -fsSL https://ollama.com/install.sh | sh`
      // — a piped remote script, which we won't run via execFile. See docsUrl.
    },
    docsUrl: 'https://ollama.com/download',
    recommendedModels: ['qwen2.5-coder:7b', 'llama3.2:3b'],
  },
  {
    id: 'lmstudio',
    label: 'LM Studio',
    detect: () => detectProvider('lmstudio'),
    installCmd: {
      win32: ['winget', 'install', '--id', 'ElementLabs.LMStudio', '-e'],
      // darwin/linux: distributed as a GUI app / AppImage with no reliable
      // package-manager id — send users to the download page.
    },
    docsUrl: 'https://lmstudio.ai/download',
    // LM Studio manages model downloads through its own GUI.
    recommendedModels: [],
  },
  {
    id: 'llamacpp',
    label: 'llama.cpp',
    detect: () => detectProvider('llamacpp'),
    installCmd: {
      darwin: ['brew', 'install', 'llama.cpp'],
      linux: ['brew', 'install', 'llama.cpp'],
      // win32: no official winget package — see docsUrl (build / release zip).
    },
    docsUrl: 'https://github.com/ggml-org/llama.cpp',
    // llama.cpp consumes local GGUF files, not a pull-by-name registry.
    recommendedModels: [],
  },
];

/** Look up a single installer by id, or undefined when unknown. */
export function getInstaller(id: string): ProviderInstaller | undefined {
  return PROVIDER_INSTALLERS.find((p) => p.id === id);
}

// ---------------------------------------------------------------------------
// scanExistingProviders
// ---------------------------------------------------------------------------

/**
 * Probe every known runtime in parallel and return those that are LIVE
 * (state === 'running'). Pure read — never spawns or starts anything. Powers
 * the picker's "Scan existing → detect & wire it" path. Never throws.
 */
export async function scanExistingProviders(): Promise<ProviderDetection[]> {
  const detections = await Promise.all(PROVIDER_INSTALLERS.map((p) => p.detect()));
  return detections.filter((d) => d.state === 'running');
}

// ---------------------------------------------------------------------------
// installProvider — confirm-gated runner
// ---------------------------------------------------------------------------

/**
 * Install a runtime via the OS package manager — CONFIRM-GATED.
 *
 * Resolves the per-platform argv from the registry, then:
 *  - unknown id            → { ok:false } (nothing to do)
 *  - no command for the OS  → { ok:false, ... } pointing at docsUrl
 *  - confirm:false (plan)   → { ok:false, command } — the exact command that
 *                             WOULD run; nothing is spawned. Caller prints it
 *                             and asks the user.
 *  - confirm:true (run)     → execFile the argv (no shell); { ok, detail, command }
 *
 * `opts.platform` overrides process.platform (for tests / cross-platform plans).
 * Never throws.
 */
export async function installProvider(
  id: string,
  opts: { confirm: boolean; platform?: NodeJS.Platform },
): Promise<InstallResult> {
  const installer = getInstaller(id);
  if (!installer) {
    return { ok: false, detail: `Unknown provider: "${id}". Known: ${PROVIDER_INSTALLERS.map((p) => p.id).join(', ')}.` };
  }

  const platform = opts.platform ?? process.platform;
  const argv = installer.installCmd[platform];
  if (!argv || argv.length === 0) {
    return {
      ok: false,
      detail:
        `No automated installer for ${installer.label} on ${platform}. ` +
        `Install it manually: ${installer.docsUrl}`,
    };
  }

  const command = argv.join(' ');

  // Plan mode: show the command, run nothing.
  if (!opts.confirm) {
    return {
      ok: false,
      detail: `Would run: ${command}  (confirm to proceed)`,
      command,
    };
  }

  // Run mode: execFile the argv directly — NO shell, args passed verbatim.
  try {
    const [bin, ...rest] = argv;
    const { stdout, stderr } = await execFileAsync(bin!, rest, {
      timeout: INSTALL_TIMEOUT_MS,
      maxBuffer: 10 * 1024 * 1024,
    });
    const out = [stdout, stderr].filter(Boolean).join('\n').trim();
    return {
      ok: true,
      detail: out.length > 0 ? out : `${installer.label} install command completed.`,
      command,
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, detail: `${command} failed: ${msg}`, command };
  }
}
